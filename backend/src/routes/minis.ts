import { Router, Response } from 'express';
import { rows, firstRow, firstValue, change, insert, inTransaction, Db } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { rateLimit } from '../middleware/rateLimit';
import { route, idFrom, ownerOrAdmin } from '../utils/route';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { matchesSearch } from '../utils/search';
import { activeLoanStatusSql, miniStatusFrom } from '../utils/miniStatus';
import { requiredText, optionalText, tagList, optionalEnum, optionalId, optionalFlag, positiveId, LIMITS, Check } from '../utils/inputs';
import { parseBackBy } from '../utils/quest';
import { daysOut } from '../utils/loanRules';
import {
  photoUpload, handleUploadError, verifyImageContents, discardUploadsIfRejected,
  uploadPath, deleteUpload, MAX_PHOTO_BYTES,
} from '../middleware/uploads';
import { promoteNextHold, removalNotice, sendRemovalNotice } from '../services/holds';
import { bookingBlockingQuest } from '../services/bookings';
import { bookingBlocksMessage, readableDay } from '../utils/bookingRules';
import { notify } from '../db/notifications';
import { messages } from '../utils/notificationMessages';

const router = Router();
// Mirrored by frontend/src/limits.ts (photosPerMini, photoBytes) and pinned to
// it by limitsMirror.test.ts. The byte ceiling is shared with every other
// photo the app takes, so it lives with the upload pipeline itself.
export const MAX_IMAGES = 3;
export { MAX_PHOTO_BYTES };

// Every route in this file is scoped to the caller's active collection.
// requireCollectionMembership re-verifies that membership against the
// database on every request (never just trusts the JWT claim) and attaches
// the verified id as req.collectionId — every query below filters on it.
router.use(requireAuth, requireCollectionMembership);

// Photos: saved to disk as the request arrives, checked against their real
// bytes, and deleted again if the request ends up rejected. All of that is
// middleware/uploads.ts — shared with a loan's condition photos.
const uploadImages = photoUpload('images', MAX_IMAGES);
const TOO_MANY_IMAGES = `You can have at most ${MAX_IMAGES} photos per mini`;
const uploadErrors = handleUploadError(TOO_MANY_IMAGES);

// ---------------------------------------------------------------------------
// Row types — these tell TypeScript the shape of each DB row we SELECT
// ---------------------------------------------------------------------------

// The full shape of a row from the minis + users + tags + images join query
export interface MiniRow {
  id: number;
  name: string;
  description: string | null;
  price: string; // mysql2 returns DECIMAL columns as strings to avoid float rounding issues
  active_loan_status: string | null;
  on_quest_since: Date | null;
  on_quest_until: string | null; // formatted YYYY-MM-DD by the query
  condition_flag: string | null;
  condition_since: Date | null;
  owner_name: string;
  owner_username: string;
  owner_id: number;
  created_at: string;
  set_id: number | null;   // this mini's set (a boxed army), if it's in one
  set_name: string | null;
  // GROUP_CONCAT returns a comma-separated string, or null if there are none
  tags: string | null;
  images: string | null;
}

interface TagRow {
  id: number;
  name: string;
}

interface TagNameRow {
  name: string;
}

interface OwnerNameRow {
  id: number;
  name: string;
}

interface OwnerRow {
  owner_id: number;
  active_loan_status?: string | null;
  on_quest_since?: Date | null;
}

interface ImagePathRow {
  image_path: string;
}

// The join query used by both GET / and GET /:id, kept in one place so the
// shape returned to the frontend never drifts between the two. Images are
// fetched via a correlated subquery (not a LEFT JOIN) so they don't multiply
// rows against the tags LEFT JOIN — two one-to-many joins in the same query
// would otherwise duplicate tag names once per image.
// Exported so routes/sets.ts can list a set's member minis with exactly the
// same shape (status, images, tags, and all) instead of a second, drifting
// copy of this query.
export const MINI_SELECT = `
  SELECT m.id, m.name, m.description, m.price,
         ${activeLoanStatusSql('m')} AS active_loan_status,
         m.on_quest_since, DATE_FORMAT(m.on_quest_until, '%Y-%m-%d') AS on_quest_until,
         m.condition_flag, m.condition_since,
         u.display_name AS owner_name, u.username AS owner_username, u.id AS owner_id,
         m.created_at, m.set_id, st.name AS set_name,
         GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags,
         (SELECT GROUP_CONCAT(mi.image_path ORDER BY mi.position SEPARATOR ',')
          FROM mini_images mi WHERE mi.mini_id = m.id) AS images
  FROM minis m
  JOIN users u ON m.owner_id = u.id
  LEFT JOIN sets st ON st.id = m.set_id
  LEFT JOIN mini_tags mt ON m.id = mt.mini_id
  LEFT JOIN tags t ON mt.tag_id = t.id
`;

// Converts a raw joined row into the shape the frontend expects
// (price as a number, tags/images as string arrays instead of CSV blobs,
// availability derived from the mini's loans). Price is null in a group that
// has prices turned off (req.showPrices) — not sent at all, not just hidden.
export function serializeMini(row: MiniRow, showPrices: boolean) {
  const { active_loan_status, on_quest_since, on_quest_until, condition_flag, condition_since, ...rest } = row;
  const status = miniStatusFrom(active_loan_status, on_quest_since ?? null, condition_flag ?? null);
  return {
    ...rest,
    price: showPrices ? Number(row.price) : null,
    tags: row.tags ? row.tags.split(',') : [],
    images: row.images ? row.images.split(',') : [],
    status,
    available: status === 'available',
    on_quest_since: on_quest_since ? new Date(on_quest_since).toISOString() : null,
    on_quest_until: on_quest_since ? on_quest_until ?? null : null,
    condition: condition_flag ?? null,
    conditionSince: condition_since ? new Date(condition_since).toISOString() : null,
  };
}

// The most a mini's price column (DECIMAL(6,2)) can hold.
export const MAX_PRICE = 9999.99;
const PRICE_PATTERN = /^(\d+(\.\d{1,2})?|\.\d{1,2})$/;

interface MiniFields {
  name: string;
  description: string | null;
  tags: string[];
  price: number | null; // null: prices are off in this group, so leave it alone
}

// Validates the text fields shared by POST / and PATCH /:id. In a group with
// prices turned off, a price is neither checked nor saved — a form opened
// before the switch shouldn't be refused over a figure nobody can see.
function parseMiniFields(body: Record<string, unknown>, showPrices: boolean): Check<MiniFields> {
  const name = requiredText(body.name, 'Name', LIMITS.miniName);
  if (!name.ok) return name;
  const description = optionalText(body.description, 'Description', LIMITS.description);
  if (!description.ok) return description;
  const tags = tagList(body.tags);
  if (!tags.ok) return tags;

  if (!showPrices) {
    return { ok: true, value: { name: name.value, description: description.value, tags: tags.value, price: null } };
  }

  // price arrives as a string from multipart form-data — default to 0 when omitted.
  // Plain dollars-and-cents only: "0x10" or "1e3" are numbers to JavaScript but
  // not prices anyone typed, and "12.999" would be silently rounded.
  const rawPrice = typeof body.price === 'string' ? body.price.trim() : '';
  if (body.price !== undefined && typeof body.price !== 'string') {
    return { ok: false, error: 'Price must be a number like 12.50' };
  }
  if (rawPrice && !PRICE_PATTERN.test(rawPrice)) {
    return { ok: false, error: 'Price must be a number like 12.50' };
  }
  const price = rawPrice ? Number(rawPrice) : 0;
  if (price > MAX_PRICE) {
    return { ok: false, error: `Price must be ${MAX_PRICE} or less` };
  }

  return { ok: true, value: { name: name.value, description: description.value, tags: tags.value, price } };
}

// Replaces all of a mini's tags with the given (already validated) list —
// shared by POST / and PATCH /:id so the upsert logic only lives in one place.
// Three statements whatever the number of tags: clear, add any new tag names,
// then link them all at once. Run on the caller's transaction (see POST /).
async function setTags(miniId: number, tagNames: string[], db: Db): Promise<void> {
  await change('DELETE FROM mini_tags WHERE mini_id = ?', [miniId], db);
  if (tagNames.length === 0) return;

  // INSERT IGNORE skips names that already exist (no duplicate-key error).
  await change(
    `INSERT IGNORE INTO tags (name) VALUES ${tagNames.map(() => '(?)').join(', ')}`,
    tagNames,
    db
  );

  const placeholders = tagNames.map(() => '?').join(', ');
  const tags = await rows<TagRow>(`SELECT id FROM tags WHERE name IN (${placeholders})`, tagNames, db);
  if (tags.length === 0) return;

  await change(
    `INSERT IGNORE INTO mini_tags (mini_id, tag_id) VALUES ${tags.map(() => '(?, ?)').join(', ')}`,
    tags.flatMap(tag => [miniId, tag.id]),
    db
  );
}

// Replaces all of a mini's photos with keptPaths (existing images the caller
// chose to keep, in order) followed by newFiles (freshly uploaded ones).
// Shared by POST / and PATCH /:id, same pattern as setTags above.
async function setImages(miniId: number, keptPaths: string[], newFiles: Express.Multer.File[], db: Db): Promise<void> {
  await change('DELETE FROM mini_images WHERE mini_id = ?', [miniId], db);

  const allPaths = [...keptPaths, ...newFiles.map(uploadPath)];
  if (allPaths.length === 0) return;

  await change(
    `INSERT INTO mini_images (mini_id, image_path, position) VALUES ${allPaths.map(() => '(?, ?, ?)').join(', ')}`,
    allPaths.flatMap((imagePath, position) => [miniId, imagePath, position]),
    db
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/minis?q=search&tag=dragon&owner=5&available=1&sort=name&after=42
// Returns minis in the caller's active collection, optionally filtered by
// name/description search, a tag, an owner, and available-only, sorted by
// newest (default)/name/price — one page (BROWSE_PAGE_SIZE) at a time: the
// next page is the same query with after=<the last mini's id>. A page shorter
// than that is the last. Minis in every other collection are invisible here,
// full stop — the collection_id filter below is mandatory, not optional like
// the rest.
// Browsing reads the whole collection and fuzzy-matches it in this process, on
// the Pi's one core — the most expensive thing a member can ask for. The search
// box waits for a pause in the typing (SEARCH_DEBOUNCE_MS in the frontend), so
// real use is a handful of requests a minute; this is far above that and well
// below what a stuck client can do to everyone else.
export const BROWSE_MAX_PER_MINUTE = 240;

const browseLimit = rateLimit({
  windowMs: 60 * 1000,
  max: BROWSE_MAX_PER_MINUTE,
  // Per member, so one bad tab can't throttle the rest of the group.
  key: req => `browse:${(req as CollectionRequest).user?.userId ?? req.ip}`,
  // Nobody is "attempting" anything here — they're just browsing.
  message: () => 'Loading the collection too quickly — give it a moment and try again.',
});

// How many minis one browse request returns. Mirrored by frontend/src/limits.ts
// (browsePage), which shows "Load more" after a full page. Five rows of the
// widest grid.
export const BROWSE_PAGE_SIZE = 60;

// Fixed SQL fragments, keyed by the validated `sort` enum — never build these
// from the request value itself. Every order ends on the id, so minis that tie
// (added in the same second, same name, same price) keep the same order from
// one page to the next. `after` carries on past a mini the previous page ended
// on, by looking up where that mini sorts — inside this group only, so another
// group's id matches nothing. Params: that mini's id, then the collection.
const SORTS = {
  newest: {
    orderBy: 'm.created_at DESC, m.id DESC',
    after: '(m.created_at, m.id) < (SELECT c.created_at, c.id FROM minis c WHERE c.id = ? AND c.collection_id = ?)',
  },
  name: {
    orderBy: 'm.name ASC, m.id ASC',
    after: '(m.name, m.id) > (SELECT c.name, c.id FROM minis c WHERE c.id = ? AND c.collection_id = ?)',
  },
  price: {
    orderBy: 'm.price ASC, m.id ASC',
    after: '(m.price, m.id) > (SELECT c.price, c.id FROM minis c WHERE c.id = ? AND c.collection_id = ?)',
  },
} as const;
const SORT_VALUES = Object.keys(SORTS) as (keyof typeof SORTS)[];

router.get('/', browseLimit, route(async (req, res) => {
  // Query strings can arrive as arrays (?q=a&q=b) or objects (?tag[x]=y), and
  // typo-tolerant search costs CPU in proportion to its length — so only
  // short, plain text is accepted.
  const q = optionalText(req.query.q, 'Search', LIMITS.search);
  const tagFilter = optionalText(req.query.tag, 'Tag', 100);
  const sortCheck = optionalEnum(req.query.sort, 'Sort', SORT_VALUES);
  const ownerCheck = optionalId(req.query.owner, 'Owner');
  const availableCheck = optionalFlag(req.query.available, 'Available');
  const afterCheck = optionalId(req.query.after, 'After');
  for (const check of [q, tagFilter, sortCheck, ownerCheck, availableCheck, afterCheck]) {
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
  }
  const search = (q as { value: string | null }).value;
  // Saved tags are lowercase and compared exactly, so the filter is too.
  const tag = (tagFilter as { value: string | null }).value?.toLowerCase() ?? null;
  const requestedSort = (sortCheck as { value: keyof typeof SORTS | null }).value ?? 'newest';
  // With prices off, sorting by them would still give away which is dearest;
  // a tab opened before the switch just gets the default order.
  const sort = requestedSort === 'price' && !req.showPrices ? 'newest' : requestedSort;
  const owner = (ownerCheck as { value: number | null }).value;
  const availableOnly = (availableCheck as { value: boolean }).value;
  const after = (afterCheck as { value: number | null }).value;

  // The collection filter is always present; tag (a controlled pill, not
  // free text) stays an exact match in SQL. Free-text search (q) is
  // applied afterwards in JS — see matchesSearch below — so a misspelled
  // search term still finds a close match, which plain SQL LIKE can't do.
  const params: (string | number)[] = [req.collectionId!];
  const where: string[] = ['m.collection_id = ?', 'm.archived_at IS NULL', 'm.condition_flag IS NULL'];

  if (tag) {
    // Subquery: find minis that have a tag matching the filter
    where.push('m.id IN (SELECT mt2.mini_id FROM mini_tags mt2 JOIN tags t2 ON mt2.tag_id = t2.id WHERE t2.name = ?)');
    params.push(tag);
  }
  if (owner) {
    where.push('m.owner_id = ?');
    params.push(owner);
  }
  if (after) {
    where.push(SORTS[sort].after);
    params.push(after, req.collectionId!);
  }

  // "Available" has no stored column — it's the same derivation as
  // miniStatusFrom's available branch (utils/miniStatus.ts), applied here as
  // a HAVING clause since active_loan_status is a per-row derived value in
  // the SELECT list, not a real column WHERE can filter on.
  const having = availableOnly ? 'HAVING active_loan_status IS NULL AND m.on_quest_since IS NULL' : '';

  // A page at most. Search is the exception: its typo-tolerant matching runs
  // below, not in SQL, so the database can't know where a page of matches
  // ends — it reads on from the cursor and the page is cut from the matches.
  const limit = search ? '' : `LIMIT ${BROWSE_PAGE_SIZE}`;

  // GROUP_CONCAT aggregates all of a mini's tag names into one comma-separated
  // string per row, so we don't get duplicate mini rows (one per tag)
  const found = await rows<MiniRow>(
    `${MINI_SELECT} WHERE ${where.join(' AND ')} GROUP BY m.id ${having} ORDER BY ${SORTS[sort].orderBy} ${limit}`.trimEnd(),
    params
  );

  let minis = found.map(row => serializeMini(row, req.showPrices!));
  if (search) {
    minis = minis.filter(m => matchesSearch([m.name, m.description, m.tags], search)).slice(0, BROWSE_PAGE_SIZE);
  }

  res.json(minis);
}));

// GET /api/minis/tags
// Returns the sorted list of tags actually used by minis in the caller's
// active collection — not every tag in the database, so a tag name from
// another collection's minis can't leak through the filter pills.
// Registered before /:id so "tags" isn't swallowed as an :id value.
router.get('/tags', route(async (req, res) => {
  const used = await rows<TagNameRow>(
    `SELECT DISTINCT t.name FROM tags t
     JOIN mini_tags mt ON mt.tag_id = t.id
     JOIN minis m ON m.id = mt.mini_id
     WHERE m.collection_id = ? AND m.archived_at IS NULL AND m.condition_flag IS NULL
     ORDER BY t.name`,
    [req.collectionId!]
  );
  res.json(used.map(tag => tag.name));
}));

// GET /api/minis/owners
// Returns the distinct owners of minis in the caller's active collection —
// not every user in the database — for the browse page's owner filter.
// Registered before /:id, same reason as /tags above.
router.get('/owners', route(async (req, res) => {
  const owners = await rows<OwnerNameRow>(
    `SELECT DISTINCT u.id, u.display_name AS name
     FROM minis m JOIN users u ON m.owner_id = u.id
     WHERE m.collection_id = ? AND m.archived_at IS NULL AND m.condition_flag IS NULL
     ORDER BY u.display_name`,
    [req.collectionId!]
  );
  res.json(owners);
}));

// GET /api/minis/collection-members
// Every member of the caller's active collection (not just those who own a
// mini) — for the "transfer ownership" recipient picker. Registered before
// /:id, same reason as /tags and /owners above.
router.get('/collection-members', route(async (req, res) => {
  const members = await rows<OwnerNameRow>(
    `SELECT u.id, u.display_name AS name
     FROM users u JOIN collection_memberships cm ON cm.user_id = u.id
     WHERE cm.collection_id = ?
     ORDER BY u.display_name`,
    [req.collectionId!]
  );
  res.json(members);
}));

// GET /api/minis/:id
// Returns a single mini by id — used to prefill the edit form. A mini from
// a different collection returns 404, identical to a nonexistent id, so an
// id guess can't be used to even confirm another collection's mini exists.
router.get('/:id', route(async (req, res) => {
  const miniId = idFrom(req.params.id);
  const mini = miniId === null ? null : await firstRow<MiniRow>(
    `${MINI_SELECT} WHERE m.id = ? AND m.collection_id = ? AND m.archived_at IS NULL GROUP BY m.id`,
    [miniId, req.collectionId!]
  );

  if (!mini) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  res.json(serializeMini(mini, req.showPrices!));
}));

interface HistoryRow {
  id: number;
  borrower_id: number | null;       // null once their account has been deleted,
  borrower_username: string | null; // and so is this —
  borrower_name: string;            // but not this: it was saved as it went
  handed_off_at: Date;
  returned_at: Date | null;
  status: string;
}

// GET /api/minis/:id/history
// "Who's had this, how often" — every loan that actually happened (reached a
// handoff), newest first. Owner or admin only: this app otherwise keeps a
// mini's current borrower anonymous to everyone but the two people in the
// loan, so a full name-and-date history is scoped the same way editing is.
router.get('/:id/history', route(async (req, res) => {
  const miniId = idFrom(req.params.id);
  const owned = miniId === null ? null : await firstRow<OwnerRow>(
    'SELECT owner_id FROM minis WHERE id = ? AND collection_id = ? AND archived_at IS NULL',
    [miniId, req.collectionId!]
  );

  if (!owned) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  if (!ownerOrAdmin(req, owned.owner_id)) {
    res.status(403).json({ error: 'Only the owner can see this mini\'s lending history' });
    return;
  }

  // handed_off_at IS NOT NULL rules out a request that was cancelled or never
  // got past negotiating — nothing happened yet, so it isn't history.
  const history = await rows<HistoryRow>(
    `SELECT l.id, l.borrower_id, u.username AS borrower_username,
            COALESCE(u.display_name, l.removed_borrower_name) AS borrower_name,
            l.handed_off_at, l.returned_at, l.status
     FROM loans l
     LEFT JOIN users u ON u.id = l.borrower_id
     WHERE l.mini_id = ? AND l.collection_id = ? AND l.handed_off_at IS NOT NULL
     ORDER BY l.handed_off_at DESC`,
    [miniId, req.collectionId!]
  );

  const now = new Date();
  res.json(history.map(entry => ({
    loanId: entry.id,
    borrowerId: entry.borrower_id,
    borrowerUsername: entry.borrower_username,
    borrowerName: entry.borrower_name,
    handedOffAt: entry.handed_off_at.toISOString(),
    returnedAt: entry.returned_at ? entry.returned_at.toISOString() : null,
    ongoing: entry.status === 'adventuring',
    // 'returned' | 'lost' | 'critically_wounded' (a cancelled loan never
    // reaches handed_off_at, so it can't appear here) — visible only to the
    // owner/admin this route is already gated to.
    outcome: entry.status,
    daysOut: daysOut(entry.handed_off_at, entry.returned_at, now),
  })));
}));

// POST /api/minis
// Creates a new mini in the caller's active collection. Expects multipart/form-data.
// Fields: name (required), description, tags (comma-separated), images (0-3 files).
router.post('/', discardUploadsIfRejected, uploadImages, uploadErrors, verifyImageContents, route(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  const fields = parseMiniFields((req.body ?? {}) as Record<string, unknown>, req.showPrices!);
  if (!fields.ok) {
    res.status(400).json({ error: fields.error });
    return;
  }
  const { name, description, tags, price } = fields.value;

  // The mini, its tags and its photos land together or not at all: a failure
  // part-way would otherwise leave a mini whose photos were never recorded,
  // while the error reply deletes their files (discardUploadsIfRejected).
  // req.user! is safe here because requireAuth ran first.
  const miniId = await inTransaction(async conn => {
    const created = await insert(
      'INSERT INTO minis (name, description, owner_id, collection_id, price) VALUES (?, ?, ?, ?, ?)',
      [name, description, req.user!.userId, req.collectionId!, price ?? 0],
      conn
    );
    await setTags(created.id, tags, conn);
    await setImages(created.id, [], files, conn);
    return created.id;
  });

  res.status(201).json({ message: 'Mini added', miniId });
}));

// PATCH /api/minis/:id
// Edits an existing mini. Only the owner or an admin may do this, and only
// within the caller's active collection — a mini from another collection
// looks exactly like a nonexistent one (404), same as GET /:id above.
// Expects multipart/form-data. `existingImages` is a JSON array of image
// paths (from the mini's current photos) to keep; any new files in the
// `images` field are appended after them, capped at MAX_IMAGES total.
router.patch('/:id', discardUploadsIfRejected, uploadImages, uploadErrors, verifyImageContents, route(async (req, res) => {
  const miniId = idFrom(req.params.id);
  const existingImages = (req.body as Record<string, unknown> | undefined)?.existingImages;
  const newFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

  const owned = miniId === null ? null : await firstRow<OwnerRow>(
    'SELECT owner_id FROM minis WHERE id = ? AND collection_id = ? AND archived_at IS NULL',
    [miniId, req.collectionId!]
  );

  if (!owned || miniId === null) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  if (!ownerOrAdmin(req, owned.owner_id)) {
    res.status(403).json({ error: 'You can only edit your own minis' });
    return;
  }

  const currentImages = await rows<ImagePathRow>(
    'SELECT image_path FROM mini_images WHERE mini_id = ? ORDER BY position',
    [miniId]
  );
  const currentPaths = currentImages.map(image => image.image_path);

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
    res.status(400).json({ error: TOO_MANY_IMAGES });
    return;
  }

  // No price field at all means the form never showed one — it was opened
  // while prices were off, and an admin may have turned them back on since.
  // That's "leave it alone", not "set it to 0": the edit page sends an empty
  // price when someone really does clear the box.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = parseMiniFields(body, req.showPrices! && body.price !== undefined);
  if (!fields.ok) {
    res.status(400).json({ error: fields.error });
    return;
  }
  const { name, description, tags, price } = fields.value;

  // Which of the mini's current photos are being dropped, so we can clean
  // up their files from disk once the DB is updated.
  const droppedPaths = currentPaths.filter(p => !keptPaths.includes(p));

  // All or nothing, as in POST / — and a dropped photo's file is only deleted
  // below, once the change that drops it has been committed.
  await inTransaction(async conn => {
    // With prices off the stored price is left exactly as it was, so turning
    // them back on brings it back.
    if (price === null) {
      await change('UPDATE minis SET name = ?, description = ? WHERE id = ?', [name, description, miniId], conn);
    } else {
      await change(
        'UPDATE minis SET name = ?, description = ?, price = ? WHERE id = ?',
        [name, description, price, miniId],
        conn
      );
    }
    await setTags(miniId, tags, conn);
    await setImages(miniId, keptPaths, newFiles, conn);
  });

  for (const droppedPath of droppedPaths) {
    deleteUpload(droppedPath); // best-effort cleanup; ignore errors
  }

  await sendMini(res, miniId, req.showPrices!);
}));

// POST /api/minis/:id/clear-condition
// Puts a mini back into service after being marked lost or critically
// wounded (routes/loans.ts) — owner or admin, same as edit/delete/transfer
// (unlike take-out/bring-back, this isn't about who physically has it right
// now, it's a correction). "Lost" has nothing to restore automatically, but
// nothing stops an owner clearing one they later found, same action either way.
router.post('/:id/clear-condition', route(async (req, res) => {
  const miniId = idFrom(req.params.id);
  const mini = miniId === null ? null : await firstRow<{ owner_id: number; condition_flag: string | null }>(
    'SELECT owner_id, condition_flag FROM minis WHERE id = ? AND collection_id = ?',
    [miniId, req.collectionId!]
  );

  if (!mini || miniId === null) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  if (!ownerOrAdmin(req, mini.owner_id)) {
    res.status(403).json({ error: 'You can only clear the condition on your own minis' });
    return;
  }
  if (!mini.condition_flag) {
    res.status(409).json({ error: 'This mini has no condition to clear' });
    return;
  }

  await change('UPDATE minis SET condition_flag = NULL, condition_since = NULL WHERE id = ?', [miniId]);
  await sendMini(res, miniId, req.showPrices!);
}));

interface TransferLookupRow {
  owner_id: number;
  owner_name: string;
  name: string;
  active_loan_status: string | null;
  on_quest_since: Date | null;
}

// POST /api/minis/:id/transfer  { newOwnerId }
// Gives the mini to another member of the collection — "someone sells or
// gives it to another member" — without losing its tags, photos, price, or
// lending history the way delete-and-recreate would. Only the owner or an
// admin may do this, and only within the caller's active collection.
router.post('/:id/transfer', route(async (req, res) => {
  const miniId = idFrom(req.params.id);

  const mini = miniId === null ? null : await firstRow<TransferLookupRow>(
    `SELECT m.owner_id, u.display_name AS owner_name, m.name,
            ${activeLoanStatusSql('m')} AS active_loan_status, m.on_quest_since
     FROM minis m JOIN users u ON u.id = m.owner_id
     WHERE m.id = ? AND m.collection_id = ? AND m.archived_at IS NULL`,
    [miniId, req.collectionId!]
  );

  if (!mini || miniId === null) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  if (!ownerOrAdmin(req, mini.owner_id)) {
    res.status(403).json({ error: 'You can only transfer your own minis' });
    return;
  }

  const newOwnerCheck = positiveId((req.body as { newOwnerId?: unknown } | undefined)?.newOwnerId);
  if (!newOwnerCheck.ok) {
    res.status(400).json({ error: newOwnerCheck.error });
    return;
  }
  const newOwnerId = newOwnerCheck.value;

  if (newOwnerId === mini.owner_id) {
    res.status(400).json({ error: 'This mini is already theirs' });
    return;
  }

  const isMember = await firstValue<number>(
    'SELECT 1 FROM collection_memberships WHERE user_id = ? AND collection_id = ?',
    [newOwnerId, req.collectionId!]
  );
  if (!isMember) {
    res.status(404).json({ error: 'That person isn\'t a member of this collection' });
    return;
  }

  if (mini.active_loan_status) {
    res.status(409).json({ error: 'This mini has an active request or loan — finish or cancel it first' });
    return;
  }
  if (mini.on_quest_since) {
    res.status(409).json({ error: 'Bring this mini back from its quest before transferring it' });
    return;
  }

  // Re-checked here, atomically: someone could request it or the owner could
  // take it on a quest in the instant between the lookup above and this write.
  // set_id is cleared because a set is one owner's own minis (sets.ts refuses
  // adding a mini whose owner_id doesn't match the set's) — leaving it would
  // point at a set that isn't the new owner's.
  const transferred = await change(
    `UPDATE minis m SET m.owner_id = ?, m.set_id = NULL
     WHERE m.id = ? AND m.collection_id = ? AND m.owner_id = ? AND m.on_quest_since IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring')
       )`,
    [newOwnerId, miniId, req.collectionId!, mini.owner_id]
  );
  if (transferred === 0) {
    res.status(409).json({ error: 'This mini just became unavailable — try again' });
    return;
  }

  // The new owner can't hold or cart their own mini — clear any stale entry
  // from before they owned it (e.g. they'd asked to be notified of a hold
  // spot opening up, and it did, but they never acted on it).
  await change('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [newOwnerId, miniId]);
  await change('DELETE FROM hold_watchers WHERE mini_id = ? AND user_id = ?', [miniId, newOwnerId]);
  await change('DELETE FROM holds WHERE mini_id = ? AND user_id = ?', [miniId, newOwnerId]);
  // Days they'd booked on it are theirs now anyway — left in place, the hourly
  // sweep would turn the booking into a request to borrow their own mini.
  await change('DELETE FROM bookings WHERE mini_id = ? AND user_id = ?', [miniId, newOwnerId]);

  await notify([newOwnerId], {
    collectionId: req.collectionId!, type: 'ownership_transferred',
    message: messages.ownershipTransferred(mini.owner_name, mini.name), miniId,
  });

  await sendMini(res, miniId, req.showPrices!);
}));

// ---------------------------------------------------------------------------
// "On a Quest" — the owner takes their own mini out, no negotiation needed.
// Owner only (not admins: it's about who physically has it), in the caller's
// active collection, and only while nobody has it requested or borrowed.
// ---------------------------------------------------------------------------

async function findOwnMini(req: CollectionRequest, res: Response): Promise<OwnerRow | null> {
  const miniId = idFrom(req.params.id);
  const mini = miniId === null ? null : await firstRow<OwnerRow>(
    `SELECT m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status, m.on_quest_since
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [miniId, req.collectionId!]
  );
  if (!mini) {
    res.status(404).json({ error: 'Mini not found' });
    return null;
  }
  if (mini.owner_id !== req.user!.userId) {
    res.status(403).json({ error: 'Only the owner can take a mini on a quest' });
    return null;
  }
  return mini;
}

// The mini as the browser expects it, freshly read back after a change.
async function sendMini(res: Response, miniId: number, showPrices: boolean): Promise<void> {
  const mini = await firstRow<MiniRow>(`${MINI_SELECT} WHERE m.id = ? AND m.archived_at IS NULL GROUP BY m.id`, [miniId]);
  res.json(mini === null ? null : serializeMini(mini, showPrices));
}

// POST /api/minis/:id/take-out  { backBy?: 'YYYY-MM-DD' }
router.post('/:id/take-out', route(async (req, res) => {
  const backBy = parseBackBy((req.body as { backBy?: unknown } | undefined)?.backBy);
  if (!backBy.ok) {
    res.status(400).json({ error: backBy.error });
    return;
  }

  const mini = await findOwnMini(req, res);
  if (!mini) return;
  const miniId = idFrom(req.params.id)!; // findOwnMini already refused anything else

  if (mini.active_loan_status === 'negotiating') {
    res.status(409).json({ error: 'Someone has requested this mini — cancel or finish that request first' });
    return;
  }
  if (mini.active_loan_status === 'adventuring') {
    res.status(409).json({ error: 'This mini is out adventuring with a borrower right now' });
    return;
  }
  if (mini.on_quest_since) {
    res.status(409).json({ error: 'This mini is already on a quest' });
    return;
  }

  // A quest counts as a loan to yourself: it has to be back before anyone's
  // booked days, the same as a handoff (routes/loans.ts) — and with no back-by
  // date at all, it would run straight through them.
  const booked = await bookingBlockingQuest(miniId, backBy.value);
  if (booked) {
    res.status(409).json({
      error: backBy.value === null
        ? `${booked.holderName} has this booked from ${readableDay(booked.startsOn)} — set a back-by date before then`
        : bookingBlocksMessage(booked.holderName, booked.startsOn),
    });
    return;
  }

  // The same checks again, inside the update: someone could check it out
  // in the instant between the lookup above and this write.
  const takenOut = await change(
    `UPDATE minis m SET on_quest_since = NOW(), on_quest_until = ?
     WHERE m.id = ? AND m.collection_id = ? AND m.owner_id = ?
       AND m.on_quest_since IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring')
       )`,
    [backBy.value, miniId, req.collectionId!, req.user!.userId]
  );
  if (takenOut === 0) {
    res.status(409).json({ error: 'This mini just became unavailable — try again' });
    return;
  }
  await sendMini(res, miniId, req.showPrices!);
}));

// POST /api/minis/:id/bring-back
router.post('/:id/bring-back', route(async (req, res) => {
  const mini = await findOwnMini(req, res);
  if (!mini) return;
  const miniId = idFrom(req.params.id)!; // findOwnMini already refused anything else

  if (!mini.on_quest_since) {
    res.status(409).json({ error: 'This mini isn\'t on a quest' });
    return;
  }

  const broughtBack = await change(
    `UPDATE minis SET on_quest_since = NULL, on_quest_until = NULL
     WHERE id = ? AND collection_id = ? AND owner_id = ? AND on_quest_since IS NOT NULL`,
    [miniId, req.collectionId!, req.user!.userId]
  );
  if (broughtBack === 0) {
    res.status(409).json({ error: 'This mini isn\'t on a quest' });
    return;
  }
  // Back and free — the first person in line (if any) is checked out now.
  await promoteNextHold(miniId);
  await sendMini(res, miniId, req.showPrices!);
}));

// DELETE /api/minis/:id
// Deletes a mini. Only the owner or an admin may do this, and only within
// the caller's active collection. Tags and photo rows are removed
// automatically via ON DELETE CASCADE; the photo files themselves still
// need cleaning up from disk here.
router.delete('/:id', route(async (req, res) => {
  const miniId = idFrom(req.params.id);

  const mini = miniId === null ? null : await firstRow<OwnerRow>(
    `SELECT m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status
     FROM minis m WHERE m.id = ? AND m.collection_id = ? AND m.archived_at IS NULL`,
    [miniId, req.collectionId!]
  );

  if (!mini || miniId === null) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }

  if (!ownerOrAdmin(req, mini.owner_id)) {
    res.status(403).json({ error: 'You can only delete your own minis' });
    return;
  }

  // Deleting would cascade away someone's in-progress request or loan.
  if (mini.active_loan_status) {
    res.status(409).json({ error: 'This mini has an active request or loan — finish or cancel it first' });
    return;
  }

  const images = await rows<ImagePathRow>('SELECT image_path FROM mini_images WHERE mini_id = ?', [miniId]);

  // Checked again with the mini locked: someone could check it out in the
  // instant since the lookup above, and deleting would cascade their fresh
  // request away. Checkout, holds and bookings all need this same row, so
  // nothing new can land on the mini until the delete is done.
  const outcome = await inTransaction(async conn => {
    const locked = await firstRow<{ active: number }>(
      `SELECT (SELECT COUNT(*) FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring')) AS active
       FROM minis m WHERE m.id = ? FOR UPDATE`,
      [miniId],
      conn
    );
    if (!locked || Number(locked.active) > 0) return { deleted: false as const };

    // Who was in line or on the notify list, read before their entries vanish with it.
    const notice = await removalNotice(miniId, conn);
    await change('DELETE FROM minis WHERE id = ?', [miniId], conn);
    return { deleted: true as const, notice };
  });
  if (!outcome.deleted) {
    res.status(409).json({ error: 'Someone just requested this mini — finish or cancel that request first' });
    return;
  }
  await sendRemovalNotice(outcome.notice);

  for (const { image_path } of images) {
    deleteUpload(image_path); // best-effort cleanup
  }

  res.json({ message: 'Mini deleted' });
}));

export default router;
