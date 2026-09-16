import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';

const router = Router();
const MAX_IMAGES = 3;

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

// Converts a multer/fileFilter error into a clean 400 JSON response instead
// of Express's default HTML error page. Placed right after upload.array(...)
// in each route's middleware list — Express routes to it only when that
// middleware calls next(err).
function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `You can have at most ${MAX_IMAGES} photos per mini` });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// Row types — these tell TypeScript the shape of each DB row we SELECT
// ---------------------------------------------------------------------------

// The full shape of a row from the minis + users + tags + images join query
interface MiniRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  price: string; // mysql2 returns DECIMAL columns as strings to avoid float rounding issues
  available: boolean;
  owner_name: string;
  owner_username: string;
  owner_id: number;
  created_at: string;
  // GROUP_CONCAT returns a comma-separated string, or null if there are none
  tags: string | null;
  images: string | null;
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
}

interface ImagePathRow extends RowDataPacket {
  image_path: string;
}

// The join query used by both GET / and GET /:id, kept in one place so the
// shape returned to the frontend never drifts between the two. Images are
// fetched via a correlated subquery (not a LEFT JOIN) so they don't multiply
// rows against the tags LEFT JOIN — two one-to-many joins in the same query
// would otherwise duplicate tag names once per image.
const MINI_SELECT = `
  SELECT m.id, m.name, m.description, m.price, m.available,
         u.display_name AS owner_name, u.username AS owner_username, u.id AS owner_id,
         m.created_at,
         GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags,
         (SELECT GROUP_CONCAT(mi.image_path ORDER BY mi.position SEPARATOR ',')
          FROM mini_images mi WHERE mi.mini_id = m.id) AS images
  FROM minis m
  JOIN users u ON m.owner_id = u.id
  LEFT JOIN mini_tags mt ON m.id = mt.mini_id
  LEFT JOIN tags t ON mt.tag_id = t.id
`;

// Converts a raw joined row into the shape the frontend expects
// (price as a number, tags/images as string arrays instead of CSV blobs).
function serializeMini(row: MiniRow) {
  return {
    ...row,
    price: Number(row.price),
    tags: row.tags ? row.tags.split(',') : [],
    images: row.images ? row.images.split(',') : [],
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

// Replaces all of a mini's photos with keptPaths (existing images the caller
// chose to keep, in order) followed by newFiles (freshly uploaded ones).
// Shared by POST / and PATCH /:id, same pattern as setTags above.
async function setImages(miniId: number, keptPaths: string[], newFiles: Express.Multer.File[]): Promise<void> {
  await pool.execute<ResultSetHeader>('DELETE FROM mini_images WHERE mini_id = ?', [miniId]);

  const allPaths = [...keptPaths, ...newFiles.map(f => `/uploads/${f.filename}`)];
  for (let i = 0; i < allPaths.length; i++) {
    await pool.execute<ResultSetHeader>(
      'INSERT INTO mini_images (mini_id, image_path, position) VALUES (?, ?, ?)',
      [miniId, allPaths[i], i]
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
// Creates a new mini. Expects multipart/form-data.
// Fields: name (required), description, tags (comma-separated), images (0-3 files).
router.post('/', requireAuth, upload.array('images', MAX_IMAGES), handleUploadError, async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, description, tags, price } = req.body as Record<string, string>;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

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
    // Insert the mini itself — req.user! is safe here because requireAuth ran first
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, description, owner_id, price) VALUES (?, ?, ?, ?)',
      [name.trim(), description?.trim() || null, req.user!.userId, priceValue]
    );
    const miniId: number = result.insertId;

    await setTags(miniId, tags);
    await setImages(miniId, [], files);

    res.status(201).json({ message: 'Mini added', miniId });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/minis/:id
// Edits an existing mini. Only the owner or an admin may do this.
// Expects multipart/form-data. `existingImages` is a JSON array of image
// paths (from the mini's current photos) to keep; any new files in the
// `images` field are appended after them, capped at MAX_IMAGES total.
router.patch('/:id', requireAuth, upload.array('images', MAX_IMAGES), handleUploadError, async (req: AuthRequest, res: Response): Promise<void> => {
  const miniId = req.params.id;
  const { name, description, tags, price, existingImages } = req.body as Record<string, string>;
  const newFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

  try {
    const [ownerRows] = await pool.execute<OwnerRow[]>(
      'SELECT owner_id FROM minis WHERE id = ?',
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

    let keptPaths: string[] = [];
    if (existingImages) {
      try {
        keptPaths = JSON.parse(existingImages);
      } catch {
        keptPaths = [];
      }
    }

    if (keptPaths.length + newFiles.length > MAX_IMAGES) {
      res.status(400).json({ error: `You can have at most ${MAX_IMAGES} photos per mini` });
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

    // Figure out which of the mini's current photos are being dropped, so we
    // can clean up their files from disk once the DB is updated.
    const [currentImageRows] = await pool.execute<ImagePathRow[]>(
      'SELECT image_path FROM mini_images WHERE mini_id = ? ORDER BY position',
      [miniId]
    );
    const droppedPaths = currentImageRows
      .map(r => r.image_path)
      .filter(p => !keptPaths.includes(p));

    await pool.execute<ResultSetHeader>(
      'UPDATE minis SET name = ?, description = ?, price = ? WHERE id = ?',
      [name.trim(), description?.trim() || null, priceValue, miniId]
    );

    await setTags(Number(miniId), tags);
    await setImages(Number(miniId), keptPaths, newFiles);

    for (const droppedPath of droppedPaths) {
      const oldFile = path.join(uploadsDir, path.basename(droppedPath));
      fs.unlink(oldFile, () => {}); // best-effort cleanup; ignore errors
    }

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
