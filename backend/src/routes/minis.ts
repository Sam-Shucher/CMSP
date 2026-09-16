import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';

const router = Router();

// Ensure the uploads directory exists when the server starts.
// Uploaded images live here and are served as static files by index.ts.
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---------------------------------------------------------------------------
// File upload configuration (multer)
// ---------------------------------------------------------------------------

// diskStorage tells multer to save files to disk (vs keeping them in memory).
const storage = multer.diskStorage({
  destination: uploadsDir,
  // Generate a unique filename so two users can upload "front.jpg" without colliding
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap — large enough for camera photos
  fileFilter: (_req, file, cb) => {
    // Only accept images — reject PDFs, executables, etc.
    if (/^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpg, png, gif, webp)'));
    }
  },
});

// ---------------------------------------------------------------------------
// Row types — these tell TypeScript the shape of each DB row we SELECT
// ---------------------------------------------------------------------------

// The full shape of a row from the minis + users + tags join query
interface MiniRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  image_path: string | null;
  price: string; // mysql2 returns DECIMAL columns as strings to avoid float rounding issues
  available: boolean;
  owner_name: string;
  owner_username: string;
  owner_id: number;
  created_at: string;
  // GROUP_CONCAT returns a comma-separated string like "dragon,painted,large"
  // or null if the mini has no tags at all
  tags: string | null;
}

interface TagRow extends RowDataPacket {
  id: number;
  name: string;
}

interface TagNameRow extends RowDataPacket {
  name: string;
}

interface OwnerRow extends RowDataPacket {
  owner_id: number;
  image_path: string | null;
}

// The join query used by both GET / and GET /:id, kept in one place so the
// shape returned to the frontend never drifts between the two.
const MINI_SELECT = `
  SELECT m.id, m.name, m.description, m.image_path, m.price, m.available,
         u.display_name AS owner_name, u.username AS owner_username, u.id AS owner_id,
         m.created_at,
         GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags
  FROM minis m
  JOIN users u ON m.owner_id = u.id
  LEFT JOIN mini_tags mt ON m.id = mt.mini_id
  LEFT JOIN tags t ON mt.tag_id = t.id
`;

// Converts a raw joined row into the shape the frontend expects
// (price as a number, tags as a string array instead of a CSV blob).
function serializeMini(row: MiniRow) {
  return {
    ...row,
    price: Number(row.price),
    tags: row.tags ? row.tags.split(',') : [],
  };
}

// Replaces all of a mini's tags with the given comma-separated list —
// shared by POST / and PATCH /:id so the upsert logic only lives in one place.
async function setTags(miniId: number, tagsInput: string | undefined): Promise<void> {
  await pool.execute<ResultSetHeader>('DELETE FROM mini_tags WHERE mini_id = ?', [miniId]);

  if (!tagsInput) return;

  const tagList: string[] = tagsInput
    .split(',')
    .map((t: string) => t.trim().toLowerCase())
    .filter(Boolean); // remove empty strings from trailing commas

  for (const tagName of tagList) {
    // INSERT IGNORE skips silently if the tag name already exists (avoids duplicate key error)
    await pool.execute<ResultSetHeader>('INSERT IGNORE INTO tags (name) VALUES (?)', [tagName]);

    // Fetch the id of the tag we just created or that already existed
    const [tagRows] = await pool.execute<TagRow[]>('SELECT id FROM tags WHERE name = ?', [tagName]);
    const tagId: number = tagRows[0].id;

    // Link the tag to this mini in the junction table
    await pool.execute<ResultSetHeader>(
      'INSERT IGNORE INTO mini_tags (mini_id, tag_id) VALUES (?, ?)',
      [miniId, tagId]
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/minis?q=search&tag=dragon
// Returns all minis, optionally filtered by name/description search or a tag.
// All routes here require the user to be logged in (requireAuth middleware).
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  // Pull optional query params — both default to undefined if not provided
  const { q, tag } = req.query as Record<string, string | undefined>;

  try {
    // Build the WHERE clause dynamically based on which filters were provided.
    // We collect conditions in an array and join them with AND at the end.
    const params: (string | number)[] = [];
    const where: string[] = [];

    if (q) {
      where.push('(m.name LIKE ? OR m.description LIKE ?)');
      // The % wildcards let SQL match the search term anywhere in the string
      params.push(`%${q}%`, `%${q}%`);
    }

    if (tag) {
      // Subquery: find minis that have a tag matching the filter
      where.push('m.id IN (SELECT mt2.mini_id FROM mini_tags mt2 JOIN tags t2 ON mt2.tag_id = t2.id WHERE t2.name = ?)');
      params.push(tag);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // GROUP_CONCAT aggregates all of a mini's tag names into one comma-separated
    // string per row, so we don't get duplicate mini rows (one per tag)
    const [rows] = await pool.execute<MiniRow[]>(
      `${MINI_SELECT} ${whereClause} GROUP BY m.id ORDER BY m.created_at DESC`,
      params
    );

    res.json(rows.map(serializeMini));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/minis/tags
// Returns a sorted list of every tag that exists in the database.
// Used by the dashboard to populate the filter buttons.
// Registered before /:id so "tags" isn't swallowed as an :id value.
router.get('/tags', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<TagNameRow[]>('SELECT name FROM tags ORDER BY name');
    res.json(rows.map(r => r.name));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/minis/:id
// Returns a single mini by id — used to prefill the edit form.
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<MiniRow[]>(
      `${MINI_SELECT} WHERE m.id = ? GROUP BY m.id`,
      [req.params.id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Mini not found' });
      return;
    }

    res.json(serializeMini(rows[0]));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/minis
// Creates a new mini. Expects multipart/form-data (because of the image upload).
// Fields: name (required), description, tags (comma-separated), image (file).
router.post('/', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, description, tags, price } = req.body as Record<string, string>;

  if (!name?.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  // price arrives as a string from multipart form-data — default to 0 when omitted,
  // and reject anything that isn't a non-negative number (NaN, negative, garbage text)
  const priceValue: number = price?.trim() ? Number(price) : 0;
  if (Number.isNaN(priceValue) || priceValue < 0) {
    res.status(400).json({ error: 'Price must be a non-negative number' });
    return;
  }

  try {
    // req.file is populated by multer if an image was included in the upload
    const imagePath: string | null = req.file ? `/uploads/${req.file.filename}` : null;

    // Insert the mini itself — req.user! is safe here because requireAuth ran first
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, description, owner_id, image_path, price) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description?.trim() || null, req.user!.userId, imagePath, priceValue]
    );
    const miniId: number = result.insertId;

    await setTags(miniId, tags);

    res.status(201).json({ message: 'Mini added', miniId });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/minis/:id
// Edits an existing mini. Only the owner or an admin may do this.
// Expects multipart/form-data (an optional replacement image may be included).
router.patch('/:id', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response): Promise<void> => {
  const miniId = req.params.id;
  const { name, description, tags, price } = req.body as Record<string, string>;

  try {
    const [ownerRows] = await pool.execute<OwnerRow[]>(
      'SELECT owner_id, image_path FROM minis WHERE id = ?',
      [miniId]
    );

    if (ownerRows.length === 0) {
      res.status(404).json({ error: 'Mini not found' });
      return;
    }

    const isOwner = ownerRows[0].owner_id === req.user!.userId;
    const isAdmin = req.user!.role === 'admin';
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'You can only edit your own minis' });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const priceValue: number = price?.trim() ? Number(price) : 0;
    if (Number.isNaN(priceValue) || priceValue < 0) {
      res.status(400).json({ error: 'Price must be a non-negative number' });
      return;
    }

    // A new image replaces the old one; otherwise the existing image_path is kept.
    const imagePath: string | null = req.file
      ? `/uploads/${req.file.filename}`
      : ownerRows[0].image_path;

    // Delete the old image file from disk once it's no longer referenced
    if (req.file && ownerRows[0].image_path) {
      const oldFile = path.join(uploadsDir, path.basename(ownerRows[0].image_path));
      fs.unlink(oldFile, () => {}); // best-effort cleanup; ignore errors
    }

    await pool.execute<ResultSetHeader>(
      'UPDATE minis SET name = ?, description = ?, price = ?, image_path = ? WHERE id = ?',
      [name.trim(), description?.trim() || null, priceValue, imagePath, miniId]
    );

    await setTags(Number(miniId), tags);

    const [rows] = await pool.execute<MiniRow[]>(
      `${MINI_SELECT} WHERE m.id = ? GROUP BY m.id`,
      [miniId]
    );

    res.json(serializeMini(rows[0]));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
