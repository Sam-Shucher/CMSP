import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { matchesSearch } from '../utils/search';
import { activeLoanStatusSql, miniStatusFrom } from '../utils/miniStatus';
import { requiredText, optionalText, tagList, LIMITS, Check } from '../utils/inputs';
import { uploadsDir as configuredUploadsDir } from '../config';

const router = Router();
const MAX_IMAGES = 3;

// Every route in this file is scoped to the caller's active collection.
// requireCollectionMembership re-verifies that membership against the
// database on every request (never just trusts the JWT claim) and attaches
// the verified id as req.collectionId — every query below filters on it.
router.use(requireAuth, requireCollectionMembership);

// Ensure the uploads directory exists when the server starts.
// Uploaded images live here and are served as static files by index.ts.
const uploadsDir = configuredUploadsDir();
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Must run BEFORE multer. Photos are written to disk as the request arrives,
// before we know whether the request will be accepted — so if the response
// ends up being an error (not your mini, bad input, too many photos, a server
// error), delete whatever this request saved instead of leaving it behind.
function discardUploadsIfRejected(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of files) {
      fs.rmSync(file.path, { force: true });
    }
  });
  next();
}

// ---------------------------------------------------------------------------
// File upload configuration (multer)
// ---------------------------------------------------------------------------

// The only file types accepted, and the extension each is saved with. SVG is
// deliberately absent — it's an "image" that can carry scripts.
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// diskStorage tells multer to save files to disk (vs keeping them in memory).
const storage = multer.diskStorage({
  destination: uploadsDir,
  // A unique, server-generated name. The extension comes from the checked
  // image type — NEVER the uploader's filename, or "evil.html" labelled as a
  // PNG would be saved as .html and served back as a live web page.
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${IMAGE_EXTENSIONS[file.mimetype.toLowerCase()]}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB cap — large enough for camera photos
    files: MAX_IMAGES,
    fields: 20,
    fieldSize: 100 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    // Only accept images — reject PDFs, executables, SVGs, etc.
    if (IMAGE_EXTENSIONS[file.mimetype.toLowerCase()]) {
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
    const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
    res.status(400).json({
      error: tooMany ? `You can have at most ${MAX_IMAGES} photos per mini`
        : err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 10 MB or smaller'
        : 'Invalid upload',
    });
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
  active_loan_status: string | null;
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
  active_loan_status?: string | null;
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
  SELECT m.id, m.name, m.description, m.price,
         ${activeLoanStatusSql('m')} AS active_loan_status,
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
// (price as a number, tags/images as string arrays instead of CSV blobs,
// availability derived from the mini's loans).
function serializeMini(row: MiniRow) {
  const { active_loan_status, ...rest } = row;
  const status = miniStatusFrom(active_loan_status);
  return {
    ...rest,
    price: Number(row.price),
    tags: row.tags ? row.tags.split(',') : [],
    images: row.images ? row.images.split(',') : [],
    status,
    available: status === 'available',
  };
}

// The most a mini's price column (DECIMAL(6,2)) can hold.
const MAX_PRICE = 9999.99;

interface MiniFields {
  name: string;
  description: string | null;
  tags: string[];
  price: number;
}

// Validates the text fields shared by POST / and PATCH /:id.
function parseMiniFields(body: Record<string, unknown>): Check<MiniFields> {
  const name = requiredText(body.name, 'Name', LIMITS.miniName);
  if (!name.ok) return name;
  const description = optionalText(body.description, 'Description', LIMITS.description);
  if (!description.ok) return description;
  const tags = tagList(body.tags);
  if (!tags.ok) return tags;

  // price arrives as a string from multipart form-data — default to 0 when omitted,
  // and reject anything that isn't a non-negative number the column can hold
  const rawPrice = typeof body.price === 'string' ? body.price.trim() : '';
  const price = rawPrice ? Number(rawPrice) : 0;
  if (body.price !== undefined && typeof body.price !== 'string') {
    return { ok: false, error: 'Price must be a non-negative number' };
  }
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, error: 'Price must be a non-negative number' };
  }
  if (price > MAX_PRICE) {
    return { ok: false, error: `Price must be ${MAX_PRICE} or less` };
  }

  return { ok: true, value: { name: name.value, description: description.value, tags: tags.value, price } };
}

// Replaces all of a mini's tags with the given (already validated) list —
// shared by POST / and PATCH /:id so the upsert logic only lives in one place.
async function setTags(miniId: number, tagNames: string[]): Promise<void> {
  await pool.execute<ResultSetHeader>('DELETE FROM mini_tags WHERE mini_id = ?', [miniId]);

  for (const tagName of tagNames) {
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
// Returns minis in the caller's active collection, optionally filtered by
// name/description search or a tag. Minis in every other collection are
// invisible here, full stop — the collection_id filter below is mandatory,
// not optional like q/tag.
router.get('/', async (req: CollectionRequest, res: Response): Promise<void> => {
  // Query strings can arrive as arrays (?q=a&q=b) or objects (?tag[x]=y), and
  // typo-tolerant search costs CPU in proportion to its length — so only
  // short, plain text is accepted.
  const q = optionalText(req.query.q, 'Search', LIMITS.search);
  const tagFilter = optionalText(req.query.tag, 'Tag', 100);
  for (const check of [q, tagFilter]) {
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
  }
  const search = (q as { value: string | null }).value;
  const tag = (tagFilter as { value: string | null }).value;

  try {
    // The collection filter is always present; tag (a controlled pill, not
    // free text) stays an exact match in SQL. Free-text search (q) is
    // applied afterwards in JS — see matchesSearch below — so a misspelled
    // search term still finds a close match, which plain SQL LIKE can't do.
    const params: (string | number)[] = [req.collectionId!];
    const where: string[] = ['m.collection_id = ?'];

    if (tag) {
      // Subquery: find minis that have a tag matching the filter
      where.push('m.id IN (SELECT mt2.mini_id FROM mini_tags mt2 JOIN tags t2 ON mt2.tag_id = t2.id WHERE t2.name = ?)');
      params.push(tag);
    }

    // GROUP_CONCAT aggregates all of a mini's tag names into one comma-separated
    // string per row, so we don't get duplicate mini rows (one per tag)
    const [rows] = await pool.execute<MiniRow[]>(
      `${MINI_SELECT} WHERE ${where.join(' AND ')} GROUP BY m.id ORDER BY m.created_at DESC`,
      params
    );

    let minis = rows.map(serializeMini);
    if (search) {
      minis = minis.filter(m => matchesSearch([m.name, m.description, m.tags], search));
    }

    res.json(minis);
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/minis/tags
// Returns the sorted list of tags actually used by minis in the caller's
// active collection — not every tag in the database, so a tag name from
// another collection's minis can't leak through the filter pills.
// Registered before /:id so "tags" isn't swallowed as an :id value.
router.get('/tags', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<TagNameRow[]>(
      `SELECT DISTINCT t.name FROM tags t
       JOIN mini_tags mt ON mt.tag_id = t.id
       JOIN minis m ON m.id = mt.mini_id
       WHERE m.collection_id = ?
       ORDER BY t.name`,
      [req.collectionId!]
    );
    res.json(rows.map(r => r.name));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/minis/:id
// Returns a single mini by id — used to prefill the edit form. A mini from
// a different collection returns 404, identical to a nonexistent id, so an
// id guess can't be used to even confirm another collection's mini exists.
router.get('/:id', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<MiniRow[]>(
      `${MINI_SELECT} WHERE m.id = ? AND m.collection_id = ? GROUP BY m.id`,
      [req.params.id, req.collectionId!]
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
// Creates a new mini in the caller's active collection. Expects multipart/form-data.
// Fields: name (required), description, tags (comma-separated), images (0-3 files).
router.post('/', discardUploadsIfRejected, upload.array('images', MAX_IMAGES), handleUploadError, async (req: CollectionRequest, res: Response): Promise<void> => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  const fields = parseMiniFields((req.body ?? {}) as Record<string, unknown>);
  if (!fields.ok) {
    res.status(400).json({ error: fields.error });
    return;
  }
  const { name, description, tags, price } = fields.value;

  try {
    // Insert the mini itself — req.user! is safe here because requireAuth ran first
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO minis (name, description, owner_id, collection_id, price) VALUES (?, ?, ?, ?, ?)',
      [name, description, req.user!.userId, req.collectionId!, price]
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
// Edits an existing mini. Only the owner or an admin may do this, and only
// within the caller's active collection — a mini from another collection
// looks exactly like a nonexistent one (404), same as GET /:id above.
// Expects multipart/form-data. `existingImages` is a JSON array of image
// paths (from the mini's current photos) to keep; any new files in the
// `images` field are appended after them, capped at MAX_IMAGES total.
router.patch('/:id', discardUploadsIfRejected, upload.array('images', MAX_IMAGES), handleUploadError, async (req: CollectionRequest, res: Response): Promise<void> => {
  const miniId = req.params.id;
  const existingImages = (req.body as Record<string, unknown> | undefined)?.existingImages;
  const newFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

  try {
    const [ownerRows] = await pool.execute<OwnerRow[]>(
      'SELECT owner_id FROM minis WHERE id = ? AND collection_id = ?',
      [miniId, req.collectionId!]
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

    const [currentImageRows] = await pool.execute<ImagePathRow[]>(
      'SELECT image_path FROM mini_images WHERE mini_id = ? ORDER BY position',
      [miniId]
    );
    const currentPaths = currentImageRows.map(r => r.image_path);

    // existingImages comes from the browser, so it can name anything. Only
    // photos this mini ALREADY has can be kept — otherwise someone could
    // attach another member's photo (or an outside tracking URL) to their own
    // mini, and deleting their mini would then delete that member's file.
    let requested: unknown = [];
    if (typeof existingImages === 'string' && existingImages) {
      try {
        requested = JSON.parse(existingImages);
      } catch {
        requested = [];
      }
    }
    const keptPaths = Array.isArray(requested)
      ? [...new Set(requested.filter((p): p is string => typeof p === 'string' && currentPaths.includes(p)))]
      : [];

    if (keptPaths.length + newFiles.length > MAX_IMAGES) {
      res.status(400).json({ error: `You can have at most ${MAX_IMAGES} photos per mini` });
      return;
    }

    const fields = parseMiniFields((req.body ?? {}) as Record<string, unknown>);
    if (!fields.ok) {
      res.status(400).json({ error: fields.error });
      return;
    }
    const { name, description, tags, price } = fields.value;

    // Which of the mini's current photos are being dropped, so we can clean
    // up their files from disk once the DB is updated.
    const droppedPaths = currentPaths.filter(p => !keptPaths.includes(p));

    await pool.execute<ResultSetHeader>(
      'UPDATE minis SET name = ?, description = ?, price = ? WHERE id = ?',
      [name, description, price, miniId]
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

// DELETE /api/minis/:id
// Deletes a mini. Only the owner or an admin may do this, and only within
// the caller's active collection. Tags and photo rows are removed
// automatically via ON DELETE CASCADE; the photo files themselves still
// need cleaning up from disk here.
router.delete('/:id', async (req: CollectionRequest, res: Response): Promise<void> => {
  const miniId = req.params.id;

  try {
    const [ownerRows] = await pool.execute<OwnerRow[]>(
      `SELECT m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status
       FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
      [miniId, req.collectionId!]
    );

    if (ownerRows.length === 0) {
      res.status(404).json({ error: 'Mini not found' });
      return;
    }

    const isOwner = ownerRows[0].owner_id === req.user!.userId;
    const isAdmin = req.user!.role === 'admin';
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'You can only delete your own minis' });
      return;
    }

    // Deleting would cascade away someone's in-progress request or loan.
    if (ownerRows[0].active_loan_status) {
      res.status(409).json({ error: 'This mini has an active request or loan — finish or cancel it first' });
      return;
    }

    const [imageRows] = await pool.execute<ImagePathRow[]>(
      'SELECT image_path FROM mini_images WHERE mini_id = ?',
      [miniId]
    );

    await pool.execute<ResultSetHeader>('DELETE FROM minis WHERE id = ?', [miniId]);

    for (const { image_path } of imageRows) {
      fs.unlink(path.join(uploadsDir, path.basename(image_path)), () => {}); // best-effort cleanup
    }

    res.json({ message: 'Mini deleted' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
