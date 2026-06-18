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
      `SELECT m.id, m.name, m.description, m.image_path, m.available,
              u.display_name AS owner_name, u.username AS owner_username, u.id AS owner_id,
              m.created_at,
              GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags
       FROM minis m
       JOIN users u ON m.owner_id = u.id
       LEFT JOIN mini_tags mt ON m.id = mt.mini_id
       LEFT JOIN tags t ON mt.tag_id = t.id
       ${whereClause}
       GROUP BY m.id
       ORDER BY m.created_at DESC`,
      params
    );

    // Convert the comma-separated tags string back into a proper string array
    // before sending to the frontend
    const minis = rows.map(m => ({
      ...m,
      tags: m.tags ? m.tags.split(',') : [],
    }));

    res.json(minis);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/minis
// Creates a new mini. Expects multipart/form-data (because of the image upload).
// Fields: name (required), description, tags (comma-separated), image (file).
router.post('/', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, description, tags } = req.body as Record<string, string>;

  if (!name?.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  try {
    // req.file is populated by multer if an image was included in the upload
    const imagePath: string | null = req.file ? `/uploads/${req.file.filename}` : null;

    // Insert the mini itself — req.user! is safe here because requireAuth ran first
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, description, owner_id, image_path) VALUES (?, ?, ?, ?)',
      [name.trim(), description?.trim() || null, req.user!.userId, imagePath]
    );
    const miniId: number = result.insertId;

    // If tags were provided, upsert each one and link it to the new mini
    if (tags) {
      const tagList: string[] = tags
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

    res.status(201).json({ message: 'Mini added', miniId });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/minis/tags
// Returns a sorted list of every tag that exists in the database.
// Used by the dashboard to populate the filter buttons.
router.get('/tags', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<TagNameRow[]>('SELECT name FROM tags ORDER BY name');
    res.json(rows.map(r => r.name));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
