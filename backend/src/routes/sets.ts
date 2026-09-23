import { Router } from 'express';
import { rows, firstRow, change, insert } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { route, idFrom } from '../utils/route';
import { requireCollectionMembership } from '../middleware/requireCollectionMembership';
import { requiredText, idList, LIMITS } from '../utils/inputs';
import { activeLoanStatusSql } from '../utils/miniStatus';
import { MINI_SELECT, serializeMini, MiniRow } from './minis';

const router = Router();

// Every route here is scoped to the caller's active collection, same as minis.
router.use(requireAuth, requireCollectionMembership);

interface SetRow {
  id: number;
  name: string;
  owner_id: number;
  owner_name: string;
  owner_username: string;
}

async function membersOf(setId: number): Promise<ReturnType<typeof serializeMini>[]> {
  const memberRows = await rows<MiniRow>(
    `${MINI_SELECT} WHERE m.set_id = ? AND m.archived_at IS NULL AND m.condition_flag IS NULL GROUP BY m.id ORDER BY m.name`,
    [setId]
  );
  return memberRows.map(serializeMini);
}

function serializeSet(row: SetRow, members: ReturnType<typeof serializeMini>[]) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerUsername: row.owner_username,
    members,
  };
}

async function findSet(collectionId: number, setId: number | null): Promise<SetRow | null> {
  if (setId === null) return null;
  return firstRow<SetRow>(
    `SELECT st.id, st.name, st.owner_id, u.display_name AS owner_name, u.username AS owner_username
     FROM sets st JOIN users u ON u.id = st.owner_id
     WHERE st.id = ? AND st.collection_id = ?`,
    [setId, collectionId]
  );
}

// GET /api/sets
// Every set in the collection — a boxed army or Kill Team someone has grouped
// their own minis into — with its current member minis and their statuses.
router.get('/', route(async (req, res) => {
  const setRows = await rows<SetRow>(
    `SELECT st.id, st.name, st.owner_id, u.display_name AS owner_name, u.username AS owner_username
     FROM sets st JOIN users u ON u.id = st.owner_id
     WHERE st.collection_id = ?
     ORDER BY st.created_at DESC`,
    [req.collectionId!]
  );

  const sets = [];
  for (const setRow of setRows) {
    sets.push(serializeSet(setRow, await membersOf(setRow.id)));
  }
  res.json(sets);
}));

// GET /api/sets/:id
router.get('/:id', route(async (req, res) => {
  const set = await findSet(req.collectionId!, idFrom(req.params.id));
  if (!set) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }
  res.json(serializeSet(set, await membersOf(set.id)));
}));

// POST /api/sets  { name, miniIds? }
// Every given mini must already be the caller's own, in this collection, and
// not already grouped into another set — checked BEFORE the set is created,
// so a bad request never leaves behind an empty orphaned set.
router.post('/', route(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; miniIds?: unknown };
  const name = requiredText(body.name, 'Name', LIMITS.setName);
  if (!name.ok) {
    res.status(400).json({ error: name.error });
    return;
  }
  const miniIds = idList(body.miniIds, 'miniIds', LIMITS.setMembers);
  if (!miniIds.ok) {
    res.status(400).json({ error: miniIds.error });
    return;
  }

  if (miniIds.value.length > 0) {
    const placeholders = miniIds.value.map(() => '?').join(', ');
    const owned = await rows<{ id: number }>(
      `SELECT id FROM minis WHERE id IN (${placeholders}) AND owner_id = ? AND collection_id = ? AND set_id IS NULL`,
      [...miniIds.value, req.user!.userId, req.collectionId!]
    );
    if (owned.length !== miniIds.value.length) {
      res.status(400).json({ error: 'Every mini must be your own, in this collection, and not already in another set' });
      return;
    }
  }

  const created = await insert(
    'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)',
    [name.value, req.user!.userId, req.collectionId!]
  );

  if (miniIds.value.length > 0) {
    const placeholders = miniIds.value.map(() => '?').join(', ');
    await change(
      `UPDATE minis SET set_id = ? WHERE id IN (${placeholders}) AND owner_id = ? AND collection_id = ? AND set_id IS NULL`,
      [created.id, ...miniIds.value, req.user!.userId, req.collectionId!]
    );
  }

  const set = await findSet(req.collectionId!, created.id);
  res.status(201).json(serializeSet(set!, await membersOf(created.id)));
}));

// PATCH /api/sets/:id  { name?, addMiniIds?, removeMiniIds? }
// Owner or admin. Membership is always checked against the SET'S owner, not
// the caller — an admin renaming or regrouping someone else's set doesn't
// thereby get to pull in minis of their own.
router.patch('/:id', route(async (req, res) => {
  const set = await findSet(req.collectionId!, idFrom(req.params.id));
  if (!set) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }
  const isOwner = set.owner_id === req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: 'Only the owner can change this set' });
    return;
  }

  const body = (req.body ?? {}) as { name?: unknown; addMiniIds?: unknown; removeMiniIds?: unknown };

  if (body.name !== undefined) {
    const name = requiredText(body.name, 'Name', LIMITS.setName);
    if (!name.ok) {
      res.status(400).json({ error: name.error });
      return;
    }
    await change('UPDATE sets SET name = ? WHERE id = ?', [name.value, set.id]);
  }

  const addMiniIds = idList(body.addMiniIds, 'addMiniIds', LIMITS.setMembers);
  if (!addMiniIds.ok) {
    res.status(400).json({ error: addMiniIds.error });
    return;
  }
  if (addMiniIds.value.length > 0) {
    const placeholders = addMiniIds.value.map(() => '?').join(', ');
    const owned = await rows<{ id: number }>(
      `SELECT id FROM minis WHERE id IN (${placeholders}) AND owner_id = ? AND collection_id = ? AND set_id IS NULL`,
      [...addMiniIds.value, set.owner_id, req.collectionId!]
    );
    if (owned.length !== addMiniIds.value.length) {
      res.status(400).json({ error: 'Every mini to add must be the set owner\'s, in this collection, and not already in another set' });
      return;
    }
    await change(
      `UPDATE minis SET set_id = ? WHERE id IN (${placeholders}) AND owner_id = ? AND collection_id = ? AND set_id IS NULL`,
      [set.id, ...addMiniIds.value, set.owner_id, req.collectionId!]
    );
  }

  const removeMiniIds = idList(body.removeMiniIds, 'removeMiniIds', LIMITS.setMembers);
  if (!removeMiniIds.ok) {
    res.status(400).json({ error: removeMiniIds.error });
    return;
  }
  if (removeMiniIds.value.length > 0) {
    const placeholders = removeMiniIds.value.map(() => '?').join(', ');
    const removed = await change(
      `UPDATE minis SET set_id = NULL WHERE id IN (${placeholders}) AND set_id = ?`,
      [...removeMiniIds.value, set.id]
    );
    if (removed !== removeMiniIds.value.length) {
      res.status(400).json({ error: 'Every mini to remove must currently be in this set' });
      return;
    }
  }

  const updated = await findSet(req.collectionId!, set.id);
  res.json(serializeSet(updated!, await membersOf(set.id)));
}));

// DELETE /api/sets/:id
// Owner or admin. Member minis are ungrouped, not deleted — ON DELETE SET
// NULL on minis.set_id.
router.delete('/:id', route(async (req, res) => {
  const set = await findSet(req.collectionId!, idFrom(req.params.id));
  if (!set) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }
  const isOwner = set.owner_id === req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: 'Only the owner can delete this set' });
    return;
  }

  await change('DELETE FROM sets WHERE id = ?', [set.id]);
  res.json({ message: 'Set deleted' });
}));

interface MemberAvailabilityRow {
  id: number;
  name: string;
  owner_id: number;
  active_loan_status: string | null;
  on_quest_since: Date | null;
}

type SkipReason = 'own' | 'unavailable' | 'already_in_cart';

// POST /api/sets/:id/cart
// "Borrow this set": adds every available, not-your-own, not-already-carted
// member to your cart in one action — the cart already handles a checkout
// with several minis at once, so a set's own loan is just several ordinary
// loans requested together.
router.post('/:id/cart', route(async (req, res) => {
  const set = await findSet(req.collectionId!, idFrom(req.params.id));
  if (!set) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }

  const members = await rows<MemberAvailabilityRow>(
    `SELECT m.id, m.name, m.owner_id, ${activeLoanStatusSql('m')} AS active_loan_status, m.on_quest_since
     FROM minis m WHERE m.set_id = ? AND m.collection_id = ? AND m.archived_at IS NULL AND m.condition_flag IS NULL`,
    [set.id, req.collectionId!]
  );

  if (members.length === 0) {
    res.status(409).json({ error: 'This set doesn\'t have any minis in it yet', added: [], skipped: [] });
    return;
  }

  const userId = req.user!.userId;
  const alreadyInCart = new Set(
    (await rows<{ mini_id: number }>('SELECT mini_id FROM cart_items WHERE user_id = ?', [userId])).map(r => r.mini_id)
  );

  const added: { miniId: number; name: string }[] = [];
  const skipped: { miniId: number; name: string; reason: SkipReason }[] = [];
  for (const member of members) {
    if (member.owner_id === userId) {
      skipped.push({ miniId: member.id, name: member.name, reason: 'own' });
    } else if (alreadyInCart.has(member.id)) {
      skipped.push({ miniId: member.id, name: member.name, reason: 'already_in_cart' });
    } else if (member.active_loan_status || member.on_quest_since) {
      skipped.push({ miniId: member.id, name: member.name, reason: 'unavailable' });
    } else {
      added.push({ miniId: member.id, name: member.name });
    }
  }

  if (added.length === 0) {
    const error = skipped.every(s => s.reason === 'own')
      ? 'That\'s your own set'
      : 'None of the minis in this set can be added to your cart right now';
    res.status(409).json({ error, added, skipped });
    return;
  }

  await change(
    `INSERT IGNORE INTO cart_items (user_id, mini_id) VALUES ${added.map(() => '(?, ?)').join(', ')}`,
    added.flatMap(item => [userId, item.miniId])
  );

  res.status(201).json({ added, skipped });
}));

export default router;
