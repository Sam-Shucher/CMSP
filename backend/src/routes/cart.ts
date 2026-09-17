import { Router, Response } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { activeLoanStatusSql, miniStatusFrom } from '../utils/miniStatus';

const router = Router();

// The cart belongs to the person and is scoped to their active collection.
router.use(requireAuth, requireCollectionMembership);

interface CartRow extends RowDataPacket {
  mini_id: number;
  name: string;
  image: string | null;
  owner_id: number;
  owner_name: string;
  owner_username: string;
  active_loan_status: string | null;
}

interface MiniLookupRow extends RowDataPacket {
  owner_id: number;
  active_loan_status: string | null;
}

const CART_SELECT = `
  SELECT ci.mini_id, m.name,
         (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS image,
         u.id AS owner_id, u.display_name AS owner_name, u.username AS owner_username,
         ${activeLoanStatusSql('m')} AS active_loan_status
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
    status: miniStatusFrom(row.active_loan_status),
  };
}

// GET /api/cart
// Everything in your cart for the active collection, including items that
// have become unavailable since you added them (so you can see why and remove them).
router.get('/', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.execute<CartRow[]>(CART_SELECT, [req.user!.userId, req.collectionId!]);
    res.json(rows.map(serializeCartItem));
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/cart  { miniId }
// Puts a mini in your basket. Reserves nothing — only checkout does.
router.post('/', async (req: CollectionRequest, res: Response): Promise<void> => {
  const miniId = Number((req.body as { miniId?: unknown })?.miniId);
  if (!Number.isInteger(miniId) || miniId <= 0) {
    res.status(400).json({ error: 'miniId is required' });
    return;
  }

  try {
    const [rows] = await pool.execute<MiniLookupRow[]>(
      `SELECT m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status
       FROM minis m WHERE m.id = ? AND m.collection_id = ?`,
      [miniId, req.collectionId!]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Mini not found' });
      return;
    }
    if (rows[0].owner_id === req.user!.userId) {
      res.status(400).json({ error: "That's your own mini" });
      return;
    }
    if (rows[0].active_loan_status) {
      res.status(409).json({ error: "That mini isn't available right now" });
      return;
    }

    await pool.execute<ResultSetHeader>(
      'INSERT IGNORE INTO cart_items (user_id, mini_id) VALUES (?, ?)',
      [req.user!.userId, miniId]
    );
    res.status(201).json({ message: 'Added to cart', miniId });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/cart/:miniId
router.delete('/:miniId', async (req: CollectionRequest, res: Response): Promise<void> => {
  try {
    await pool.execute<ResultSetHeader>(
      'DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?',
      [req.user!.userId, req.params.miniId]
    );
    res.json({ message: 'Removed from cart' });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/cart/checkout
// "Walking up to the librarian's desk": turns each cart item into its own
// rental request (a negotiating loan), which is the first hold on that mini.
// Items someone else checked out in the meantime are skipped and left in the
// cart, and the rest still go through.
router.post('/checkout', async (req: CollectionRequest, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const collectionId = req.collectionId!;

  try {
    const [items] = await pool.execute<CartRow[]>(CART_SELECT, [userId, collectionId]);
    if (items.length === 0) {
      res.status(400).json({ error: 'Your cart is empty' });
      return;
    }

    const created: { loanId: number; miniId: number }[] = [];
    const unavailable: { miniId: number; name: string }[] = [];

    for (const item of items) {
      // One atomic statement: the "is it still free?" check and the insert
      // can't be split by someone else checking out the same mini in between.
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status)
         SELECT m.id, m.collection_id, ?, m.owner_id, 'negotiating'
         FROM minis m
         WHERE m.id = ? AND m.collection_id = ? AND m.owner_id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM loans l WHERE l.mini_id = m.id AND l.status IN ('negotiating', 'adventuring')
           )`,
        [userId, item.mini_id, collectionId, userId]
      );

      if (result.affectedRows === 1) {
        created.push({ loanId: result.insertId, miniId: item.mini_id });
        await pool.execute('DELETE FROM cart_items WHERE user_id = ? AND mini_id = ?', [userId, item.mini_id]);
      } else {
        unavailable.push({ miniId: item.mini_id, name: item.name });
      }
    }

    if (created.length === 0) {
      res.status(409).json({ error: "None of the minis in your cart are available right now", unavailable });
      return;
    }

    res.status(201).json({ created, unavailable });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
