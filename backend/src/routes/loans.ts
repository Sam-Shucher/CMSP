import { Router, Response } from 'express';
import { rows, firstRow, firstValue, change } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { route, idFrom } from '../utils/route';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import {
  LoanSnapshot, LoanTerms, LoanApprovals, LoanStatus, RuleFailure,
  roleOf, parseTermsPatch, applyTermsEdit, termsChanged, approveTerms, stageOf, termsToCopy, dueAtFrom,
  parseExtension, HOLD_BLOCKS_EXTENSION, MAX_DURATION_DAYS,
} from '../utils/loanRules';
import * as events from '../services/loanEvents';
import { promoteNextHold } from '../services/holds';

const router = Router();

// Loans are only ever visible to their borrower and owner, and only inside
// the collection they were made in — anyone else gets 404, same as if the
// loan didn't exist. The actual rules live in utils/loanRules.ts.
router.use(requireAuth, requireCollectionMembership);

interface LoanRow {
  id: number;
  mini_id: number;
  borrower_id: number;
  owner_id: number;
  status: LoanStatus;
  handoff_when: Date | null;
  handoff_where: string | null;
  handoff_how: string | null;
  duration_days: number | null;
  borrower_approved: number;
  owner_approved: number;
  handed_off_at: Date | null;
  received_at: Date | null;
  due_at: Date | null;
  returned_at: Date | null;
  created_at: Date;
  mini_name: string;
  mini_image: string | null;
  borrower_username: string;
  borrower_name: string;
  owner_username: string;
  owner_name: string;
  holds_waiting: number; // people in line for this mini — they block an extension
}

// Params: collectionId, userId, userId — callers append further conditions.
const LOAN_SELECT = `
  SELECT l.*, m.name AS mini_name,
         (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS mini_image,
         b.username AS borrower_username, b.display_name AS borrower_name,
         o.username AS owner_username, o.display_name AS owner_name,
         (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS holds_waiting
  FROM loans l
  JOIN minis m ON m.id = l.mini_id
  JOIN users b ON b.id = l.borrower_id
  JOIN users o ON o.id = l.owner_id
  WHERE l.collection_id = ? AND (l.borrower_id = ? OR l.owner_id = ?)
`;

function toSnapshot(row: LoanRow): LoanSnapshot {
  return {
    status: row.status,
    borrowerId: row.borrower_id,
    ownerId: row.owner_id,
    handoffWhen: row.handoff_when,
    handoffWhere: row.handoff_where,
    handoffHow: row.handoff_how,
    durationDays: row.duration_days,
    borrowerApproved: Boolean(row.borrower_approved),
    ownerApproved: Boolean(row.owner_approved),
    dueAt: row.due_at,
  };
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function serializeLoan(row: LoanRow, userId: number) {
  const snapshot = toSnapshot(row);
  const role = roleOf(snapshot, userId);
  return {
    id: row.id,
    miniId: row.mini_id,
    miniName: row.mini_name,
    miniImage: row.mini_image,
    role,
    counterpart: role === 'borrower'
      ? { id: row.owner_id, username: row.owner_username, displayName: row.owner_name }
      : { id: row.borrower_id, username: row.borrower_username, displayName: row.borrower_name },
    status: row.status,
    stage: stageOf(snapshot, new Date()),
    handoffWhen: iso(row.handoff_when),
    handoffWhere: row.handoff_where,
    handoffHow: row.handoff_how,
    durationDays: row.duration_days,
    borrowerApproved: snapshot.borrowerApproved,
    ownerApproved: snapshot.ownerApproved,
    handedOffAt: iso(row.handed_off_at),
    receivedAt: iso(row.received_at),
    dueAt: iso(row.due_at),
    returnedAt: iso(row.returned_at),
    createdAt: iso(row.created_at),
    holdsWaiting: Number(row.holds_waiting),
    // How much of the three months is left to spend on keeping it longer. The
    // server checks this again; this is so the page can say it before you try.
    extendableDays: row.status === 'adventuring' && row.duration_days !== null
      ? Math.max(0, MAX_DURATION_DAYS - row.duration_days)
      : 0,
  };
}

async function findLoan(req: CollectionRequest, loanId: number | null): Promise<LoanRow | null> {
  if (loanId === null) return null;
  const userId = req.user!.userId;
  return firstRow<LoanRow>(`${LOAN_SELECT} AND l.id = ?`, [req.collectionId!, userId, userId, loanId]);
}

async function sendLoan(req: CollectionRequest, res: Response, loanId: number): Promise<void> {
  const row = await findLoan(req, loanId);
  res.json(serializeLoan(row!, req.user!.userId));
}

function fail(res: Response, failure: RuleFailure): void {
  res.status(failure.status).json({ error: failure.error });
}

// DATETIME has no sub-second precision, so round before storing to keep what
// we compute (like due = handoff + N days) exactly what reads back.
function nowToTheSecond(): Date {
  const now = new Date();
  now.setMilliseconds(0);
  return now;
}

async function saveTerms(loanId: number, next: LoanTerms & LoanApprovals): Promise<number> {
  return change(
    `UPDATE loans
     SET handoff_when = ?, handoff_where = ?, handoff_how = ?, duration_days = ?,
         borrower_approved = ?, owner_approved = ?
     WHERE id = ? AND status = 'negotiating'`,
    [
      next.handoffWhen, next.handoffWhere, next.handoffHow, next.durationDays,
      next.borrowerApproved ? 1 : 0, next.ownerApproved ? 1 : 0, loanId,
    ]
  );
}

const NOT_NEGOTIATING: RuleFailure = { ok: false, status: 409, error: 'This loan is no longer being negotiated' };

// Wraps each handler: loads the loan (404 if it isn't yours or isn't in this
// collection); route() turns anything unexpected into a logged 500.
function withLoan(handler: (req: CollectionRequest, res: Response, row: LoanRow) => Promise<void>) {
  return route(async (req, res) => {
    const row = await findLoan(req, idFrom(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Loan not found' });
      return;
    }
    await handler(req, res, row);
  });
}

// GET /api/loans
// Every loan you're part of in this collection, as borrower or owner.
router.get('/', route(async (req, res) => {
  const userId = req.user!.userId;
  const loans = await rows<LoanRow>(
    `${LOAN_SELECT} ORDER BY l.created_at DESC, l.id DESC`,
    [req.collectionId!, userId, userId]
  );
  res.json(loans.map(loan => serializeLoan(loan, userId)));
}));

// PATCH /api/loans/:id/terms  { when?, where?, how?, durationDays? }
// Propose new terms. Clears the other side's approval (two-key rule).
router.patch('/:id/terms', withLoan(async (req, res, row) => {
  const snapshot = toSnapshot(row);
  const role = roleOf(snapshot, req.user!.userId)!;
  if (snapshot.status !== 'negotiating') return fail(res, NOT_NEGOTIATING);

  const parsed = parseTermsPatch((req.body ?? {}) as Record<string, unknown>, role);
  if (!parsed.ok) return fail(res, parsed);

  const next = applyTermsEdit(snapshot, role, parsed.patch);
  if (await saveTerms(row.id, next) === 0) return fail(res, NOT_NEGOTIATING);
  if (termsChanged(snapshot, next)) await events.termsProposed(row.id, req.user!.userId);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/approve
// Turn your key on the current terms.
router.post('/:id/approve', withLoan(async (req, res, row) => {
  const snapshot = toSnapshot(row);
  const result = approveTerms(snapshot, roleOf(snapshot, req.user!.userId)!);
  if (!result.ok) return fail(res, result);

  const approved = await change(
    `UPDATE loans SET borrower_approved = ?, owner_approved = ? WHERE id = ? AND status = 'negotiating'`,
    [result.borrowerApproved ? 1 : 0, result.ownerApproved ? 1 : 0, row.id]
  );
  if (approved === 0) return fail(res, NOT_NEGOTIATING);
  await events.termsApproved(row.id, req.user!.userId);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/apply-terms-to-all
// Copies this loan's terms onto every other open request between the same
// borrower and owner. Each one still goes through the two-key rule.
router.post('/:id/apply-terms-to-all', withLoan(async (req, res, row) => {
  const snapshot = toSnapshot(row);
  const role = roleOf(snapshot, req.user!.userId)!;
  if (snapshot.status !== 'negotiating') return fail(res, NOT_NEGOTIATING);

  const copy = termsToCopy(snapshot, role);
  if (Object.keys(copy).length === 0) {
    return fail(res, { ok: false, status: 400, error: 'Set some terms on this request first' });
  }

  const userId = req.user!.userId;
  const others = await rows<LoanRow>(
    `${LOAN_SELECT} AND l.borrower_id = ? AND l.owner_id = ? AND l.status = 'negotiating' AND l.id <> ?`,
    [req.collectionId!, userId, userId, row.borrower_id, row.owner_id, row.id]
  );

  let updated = 0;
  for (const other of others) {
    updated += await saveTerms(other.id, applyTermsEdit(toSnapshot(other), role, copy));
  }
  await events.termsAppliedToAll(row.id, userId, updated);
  res.json({ updated });
}));

// POST /api/loans/:id/handoff
// Owner confirms the mini changed hands — it starts Adventuring and the clock starts.
router.post('/:id/handoff', withLoan(async (req, res, row) => {
  const snapshot = toSnapshot(row);
  if (roleOf(snapshot, req.user!.userId) !== 'owner') {
    return fail(res, { ok: false, status: 403, error: 'Only the owner can confirm the handoff' });
  }
  if (stageOf(snapshot, new Date()) !== 'agreed') {
    return fail(res, { ok: false, status: 409, error: 'Both of you need to approve the terms before the handoff' });
  }

  const handedOffAt = nowToTheSecond();
  const handedOff = await change(
    `UPDATE loans SET status = 'adventuring', handed_off_at = ?, due_at = ?
     WHERE id = ? AND status = 'negotiating' AND borrower_approved = 1 AND owner_approved = 1`,
    [handedOffAt, dueAtFrom(handedOffAt, snapshot.durationDays!), row.id]
  );
  if (handedOff === 0) return fail(res, NOT_NEGOTIATING);
  await events.handedOff(row.id);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/received
// Borrower confirms they have the mini. The owner's handoff already started
// the loan; this is the borrower's side of the record, and doesn't move the clock.
router.post('/:id/received', withLoan(async (req, res, row) => {
  if (row.borrower_id !== req.user!.userId) {
    return fail(res, { ok: false, status: 403, error: 'Only the borrower can confirm they got it' });
  }
  const cannotConfirm: RuleFailure = { ok: false, status: 409, error: row.received_at
    ? 'You already confirmed you got it'
    : 'You can confirm you got it once the owner has confirmed the handoff' };
  if (row.status !== 'adventuring' || row.received_at) return fail(res, cannotConfirm);

  const confirmed = await change(
    `UPDATE loans SET received_at = ? WHERE id = ? AND status = 'adventuring' AND received_at IS NULL`,
    [nowToTheSecond(), row.id]
  );
  if (confirmed === 0) return fail(res, { ok: false, status: 409, error: 'This loan changed — refresh and try again' });
  await events.received(row.id);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/extend  { extraDays }
// Keep it longer without cancelling and asking again. Either side can — the
// borrower because they need it, the owner because they're happy for them to
// have it — and the other person is told.
//
// Refused while anyone is in the hold line: a library won't renew a book
// someone has reserved, and here the next person in line gets the mini the
// moment it's marked back.
router.post('/:id/extend', withLoan(async (req, res, row) => {
  if (row.status !== 'adventuring') {
    return fail(res, { ok: false, status: 409, error: "This mini isn't out adventuring" });
  }

  const waiting = Number(await firstValue<number>(
    'SELECT COUNT(*) AS waiting FROM holds WHERE mini_id = ?',
    [row.mini_id]
  ));

  const parsed = parseExtension((req.body ?? {}) as { extraDays?: unknown }, row.duration_days);
  if (!parsed.ok) return fail(res, parsed);

  // Checked after the number itself, so "that's more days than you have left"
  // is what you hear when both are true — it's the answer you can act on.
  if (waiting > 0) return fail(res, { ok: false, status: 409, error: HOLD_BLOCKS_EXTENSION });

  const dueAt = dueAtFrom(row.handed_off_at!, parsed.totalDays);
  const extended = await change(
    `UPDATE loans SET duration_days = ?, due_at = ?, overdue_notified_at = NULL
     WHERE id = ? AND status = 'adventuring'`,
    [parsed.totalDays, dueAt, row.id]
  );
  if (extended === 0) return fail(res, { ok: false, status: 409, error: 'This loan changed — refresh and try again' });

  await events.extended(row.id, req.user!.userId, parsed.totalDays - row.duration_days!);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/return
// Owner confirms they have the mini back.
router.post('/:id/return', withLoan(async (req, res, row) => {
  if (row.owner_id !== req.user!.userId) {
    return fail(res, { ok: false, status: 403, error: 'Only the owner can mark a mini returned' });
  }
  if (row.status !== 'adventuring') {
    return fail(res, { ok: false, status: 409, error: "This mini isn't out adventuring" });
  }

  const returned = await change(
    `UPDATE loans SET status = 'returned', returned_at = ? WHERE id = ? AND status = 'adventuring'`,
    [nowToTheSecond(), row.id]
  );
  if (returned === 0) return fail(res, { ok: false, status: 409, error: "This mini isn't out adventuring" });
  await events.returned(row.id);
  // It's back — the first person in line (if any) is checked out now.
  await promoteNextHold(row.mini_id);
  await sendLoan(req, res, row.id);
}));

// POST /api/loans/:id/cancel
// Either side can back out before the handoff.
router.post('/:id/cancel', withLoan(async (req, res, row) => {
  const cannotCancel: RuleFailure = { ok: false, status: 409, error: 'Only a request that hasn\'t been handed off can be cancelled' };
  if (row.status !== 'negotiating') return fail(res, cannotCancel);

  const cancelled = await change(
    `UPDATE loans SET status = 'cancelled', cancelled_by = ? WHERE id = ? AND status = 'negotiating'`,
    [req.user!.userId, row.id]
  );
  if (cancelled === 0) return fail(res, cannotCancel);
  await events.requestCancelled(row.id, req.user!.userId);
  // The mini never left its owner, so it's free again — next in line gets it.
  await promoteNextHold(row.mini_id);
  await sendLoan(req, res, row.id);
}));

export default router;
