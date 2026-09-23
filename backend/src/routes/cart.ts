import { Router } from 'express';
import { rows, firstRow, change, insert } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership } from '../middleware/requireCollectionMembership';
import { route, idFrom } from '../utils/route';
import { activeLoanStatusSql, miniStatusFrom } from '../utils/miniStatus';
import * as events from '../services/loanEvents';
import { positiveId } from '../utils/inputs';

const router = Router();

// The cart belongs to the person and is scoped to their active collection.
router.use(requireAuth, requireCollectionMembership);

interface CartRow {
  mini_id: number;
  name: string;
  image: string | null;
  owner_id: number;
  owner_name: string;
  owner_username: string;
  active_loan_status: string | null;
  on_quest_since: Date | null;
  condition_flag: string | null;
}

const CART_SELECT = `
  SELECT ci.mini_id, m.name,
         (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS image,
         u.id AS owner_id, u.display_name AS owner_name, u.username AS owner_username,
         ${activeLoanStatusSql('m')} AS active_loan_status, m.on_quest_since, m.condition_flag
  FROM cart_items ci
  JOIN minis m ON m.id = ci.mini_id
  JOIN users u ON u.id = m.owner_id
  WHERE ci.user_id = ? AND m.collection_id = ?
  ORDER BY ci.added_at, ci.id
`;

function serializeCartItem(row: CartRow) {
  return {
    miniId: row.mini_id,
    name: row.name,
    image: row.image,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerUsername: row.owner_username,
    status: miniStatusFrom(row.active_loan_status, row.on_quest_since, row.condition_flag),
  };
}

// GET /api/cart
// Everything in your cart for the active collection, including items that
// have become unavailable since you added them (so you can see why and remove them).
router.get('/', route(async (req, res) => {
  const items = await rows<CartRow>(CART_SELECT, [req.user!.userId, req.collectionId!]);
  res.json(items.map(serializeCartItem));
}));

// POST /api/cart  { miniId }
// Puts a mini in your basket. Reserves nothing — only checkout does.
router.post('/', route(async (req, res) => {
  // A real number only: Number() would read true as 1 and [5] as 5.
  const miniIdCheck = positiveId((req.body as { miniId?: unknown } | undefined)?.miniId);
  if (!miniIdCheck.ok) {
    res.status(400).json({ error: 'miniId is required' });
    return;
  }
  const miniId = miniIdCheck.value;

  const mini = await firstRow<{ owner_id: number; active_loan_status: string | null; on_quest_since: Date | null; condition_flag: string | null }>(
    `SELECT m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status, m.on_quest_since, m.condition_flag
     FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
    [miniId, req.collectionId!]
  );

  if (!mini) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }
  if (mini.owner_id === req.user!.userId) {
    res.status(400).json({ error: "That's your own mini" });
    return;
  }
  if (mini.active_loan_status ?? mini.on_quest_since ?? mini.condition_flag) {
    res.status(409).json({ error: "That mini isn't available right now" });
    return;
  }

  await change('INSERT IGNORE INTO cart_items (user_id, mini_id) VALUES (?, ?)', [req.user!.userId, miniId]);
  res.status(201).json({ message: 'Added to cart', miniId });
}));

// DELETE /api/cart/:miniId
router.delete('/:miniId', route(async (req, res) => {
  const miniId = idFrom(req.params.miniId);
  if (miniId !== null) {
    await change('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [req.user!.userId, miniId]);
  }
  res.json({ message: 'Removed from cart' });
}));

// POST /api/cart/checkout
// "Walking up to the librarian's desk": turns each cart item into its own
// rental request (a negotiating loan), which is the first hold on that mini.
// Items someone else checked out in the meantime are skipped and left in the
// cart, and the rest still go through.
router.post('/checkout', route(async (req, res) => {
  const userId = req.user!.userId;
  const collectionId = req.collectionId!;

  const items = await rows<CartRow>(CART_SELECT, [userId, collectionId]);
  if (items.length === 0) {
    res.status(400).json({ error: 'Your cart is empty' });
    return;
  }

  const created: { loanId: number; miniId: number }[] = [];
  const unavailable: { miniId: number; name: string }[] = [];

  for (const item of items) {
    // One atomic statement: the "is it still free?" check and the insert
    // can't be split by someone else checking out the same mini in between.
    const request = await insert(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status)
       SELECT m.id, m.collection_id, ?, m.owner_id, 'negotiating'
       FROM minis m
       WHERE m.id = ? AND m.collection_id = ? AND m.owner_id <> ?
         AND m.on_quest_since IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring')
         )`,
      [userId, item.mini_id, collectionId, userId]
    );

    if (request.inserted) {
      created.push({ loanId: request.id, miniId: item.mini_id });
      await change('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [userId, item.mini_id]);
      await events.requestCreated(request.id);
    } else {
      unavailable.push({ miniId: item.mini_id, name: item.name });
    }
  }

  if (created.length === 0) {
    res.status(409).json({ error: "None of the minis in your cart are available right now", unavailable });
    return;
  }

  res.status(201).json({ created, unavailable });
}));

export default router;
