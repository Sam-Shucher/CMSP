import { Router, Response } from 'express';
import { rows, firstRow, firstValue, change, insert, inTransaction } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { route, idFrom } from '../utils/route';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import {
  LoanSnapshot, LoanTerms, LoanApprovals, LoanStatus, RuleFailure,
  roleOf, parseTermsPatch, applyTermsEdit, termsChanged, approveTerms, stageOf, termsToCopy, dueAtFrom,
  parseExtension, HOLD_BLOCKS_EXTENSION, MAX_DURATION_DAYS,
} from '../utils/loanRules';
import { MAX_CONDITION_PHOTOS, checkPhase, parsePhase, openPhases } from '../utils/conditionReports';
import { messagesOpen, parseMessage, checkCanPost } from '../utils/loanMessages';
import * as events from '../services/loanEvents';
import { promoteNextHold, announceMiniRemoved } from '../services/holds';
import { bookingBlocking } from '../services/bookings';
import { bookingBlocksMessage } from '../utils/bookingRules';
import { optionalEnum, optionalText, LIMITS } from '../utils/inputs';
import {
  photoUpload, handleUploadError, verifyImageContents, discardUploadsIfRejected, uploadPath,
} from '../middleware/uploads';

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
  holds_waiting: number;     // people in line for this mini — they block an extension
  condition_reports: number; // how many condition notes have been filed on this loan
  messages: number;             // the length of this loan's message thread
  unread_from_owner: number;    // owner's messages the borrower hasn't seen yet
  unread_from_borrower: number; // and the other way round
}

// Params: collectionId, userId, userId — callers append further conditions.
// Unread messages are counted per author rather than "not by me", so the
// caller's id needn't be another parameter; serializeLoan picks the reader's side.
const LOAN_SELECT = `
  SELECT l.*, m.name AS mini_name,
         (SELECT mi.image_path FROM mini_images mi WHERE mi.mini_id = m.id ORDER BY mi.position LIMIT 1) AS mini_image,
         b.username AS borrower_username, b.display_name AS borrower_name,
         o.username AS owner_username, o.display_name AS owner_name,
         (SELECT COUNT(*) FROM holds h WHERE h.mini_id = m.id) AS holds_waiting,
         (SELECT COUNT(*) FROM loan_condition_reports r WHERE r.loan_id = l.id) AS condition_reports,
         (SELECT COUNT(*) FROM loan_messages lm WHERE lm.loan_id = l.id) AS messages,
         (SELECT COUNT(*) FROM loan_messages lm WHERE lm.loan_id = l.id AND lm.author_id = l.owner_id AND lm.read_at IS NULL) AS unread_from_owner,
         (SELECT COUNT(*) FROM loan_messages lm WHERE lm.loan_id = l.id AND lm.author_id = l.borrower_id AND lm.read_at IS NULL) AS unread_from_borrower
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
    // Just the count and which ends are still open, so the card can offer the
    // right thing without a second request; the notes and photos themselves
    // come from GET /api/loans/:id/condition when someone opens them.
    conditionReports: Number(row.condition_reports),
    openConditionPhases: openPhases({ status: row.status, handedOffAt: row.handed_off_at, returnedAt: row.returned_at }),
    // The same for the message thread: enough for the card to say "2 new"
    // without fetching it; GET /api/loans/:id/messages has the messages.
    messageCount: Number(row.messages),
    unreadMessages: Number(role === 'borrower' ? row.unread_from_owner : row.unread_from_borrower),
    messagesOpen: messagesOpen(row.status),
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

  // Someone may have claimed days this loan would run through. A hold decides
  // who is next; a booking constrains the calendar — the mini has to be home
  // before the first booked day, so a loan that couldn't be is refused here
  // rather than discovered on the morning of their game night.
  const handedOffAt = nowToTheSecond();
  const booked = await bookingBlocking(row.mini_id, dueAtFrom(handedOffAt, snapshot.durationDays!), row.borrower_id);
  if (booked) {
    return fail(res, { ok: false, status: 409, error: bookingBlocksMessage(booked.holderName, booked.startsOn) });
  }

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
  // Same rule as the handoff: keeping it longer can't run into days someone
  // else has booked.
  const booked = await bookingBlocking(row.mini_id, dueAt, row.borrower_id);
  if (booked) {
    return fail(res, { ok: false, status: 409, error: bookingBlocksMessage(booked.holderName, booked.startsOn) });
  }

  const extended = await change(
    `UPDATE loans SET duration_days = ?, due_at = ?, overdue_notified_at = NULL
     WHERE id = ? AND status = 'adventuring'`,
    [parsed.totalDays, dueAt, row.id]
  );
  if (extended === 0) return fail(res, { ok: false, status: 409, error: 'This loan changed — refresh and try again' });

  await events.extended(row.id, req.user!.userId, parsed.totalDays - row.duration_days!);
  await sendLoan(req, res, row.id);
}));

const RETURN_OUTCOMES = ['returned', 'lost', 'critically_wounded'] as const;

// POST /api/loans/:id/return  { outcome?: 'returned' | 'lost' | 'critically_wounded' }
// Owner confirms the loan is over — normally with the mini back in hand, but
// real lending also ends with it never coming back, or coming back broken.
router.post('/:id/return', withLoan(async (req, res, row) => {
  if (row.owner_id !== req.user!.userId) {
    return fail(res, { ok: false, status: 403, error: 'Only the owner can mark a mini returned' });
  }
  if (row.status !== 'adventuring') {
    return fail(res, { ok: false, status: 409, error: "This mini isn't out adventuring" });
  }

  const outcomeCheck = optionalEnum((req.body as { outcome?: unknown } | undefined)?.outcome, 'Outcome', RETURN_OUTCOMES);
  if (!outcomeCheck.ok) return fail(res, { ok: false, status: 400, error: outcomeCheck.error });
  const outcome = outcomeCheck.value ?? 'returned';

  const returned = await change(
    `UPDATE loans SET status = ?, returned_at = ? WHERE id = ? AND status = 'adventuring'`,
    [outcome, nowToTheSecond(), row.id]
  );
  if (returned === 0) return fail(res, { ok: false, status: 409, error: "This mini isn't out adventuring" });

  if (outcome === 'returned') {
    await events.returned(row.id);
    // It's back — the first person in line (if any) is checked out now.
    await promoteNextHold(row.mini_id);
  } else {
    // Lost or critically wounded: it isn't coming back into service on its
    // own, so there's nobody to hand it to — flag the mini instead, and tell
    // the hold line and notify list it's gone rather than leave them waiting
    // on something that will never turn up. The row itself survives (unlike
    // deleting the mini): the owner decides what happens next.
    await change('UPDATE minis SET condition_flag = ?, condition_since = ? WHERE id = ?', [outcome, nowToTheSecond(), row.mini_id]);
    await announceMiniRemoved(row.mini_id);
    await change('DELETE FROM holds WHERE mini_id = ?', [row.mini_id]);
    await change('DELETE FROM hold_watchers WHERE mini_id = ?', [row.mini_id]);
    await change('DELETE FROM cart_items WHERE mini_id = ?', [row.mini_id]);
    // Claimed days go the same way: announceMiniRemoved has just told those
    // people it isn't coming, so leaving the booking would have it come due
    // on a mini that can't be lent.
    await change('DELETE FROM bookings WHERE mini_id = ?', [row.mini_id]);
    await (outcome === 'lost' ? events.lost(row.id) : events.criticallyWounded(row.id));
  }
  await sendLoan(req, res, row.id);
}));

// ---------------------------------------------------------------------------
// Condition reports — what the mini looked like at each end of the loan, so
// "the spear was already bent" is a fact instead of an argument. Each side
// files their own, at each end, and nobody can edit or replace one afterwards:
// a record that can be rewritten later is not a record. See
// utils/conditionReports.ts for when each end is still open.
// ---------------------------------------------------------------------------

interface ConditionReportRow {
  id: number;
  phase: 'handoff' | 'return';
  author_id: number;
  author_name: string;
  note: string | null;
  created_at: Date;
  photos: string | null; // GROUP_CONCAT of image paths, in position order
}

const CONDITION_SELECT = `
  SELECT r.id, r.phase, r.author_id, r.note, r.created_at, u.display_name AS author_name,
         (SELECT GROUP_CONCAT(p.image_path ORDER BY p.position SEPARATOR ',')
          FROM loan_condition_photos p WHERE p.report_id = r.id) AS photos
  FROM loan_condition_reports r
  JOIN users u ON u.id = r.author_id
  WHERE r.loan_id = ?
  ORDER BY r.created_at, r.id
`;

function serializeReport(row: ConditionReportRow) {
  return {
    id: row.id,
    phase: row.phase,
    authorId: row.author_id,
    authorName: row.author_name,
    note: row.note,
    photos: row.photos ? row.photos.split(',') : [],
    createdAt: iso(row.created_at),
  };
}

async function sendReports(res: Response, loanId: number, status: 200 | 201): Promise<void> {
  const reports = await rows<ConditionReportRow>(CONDITION_SELECT, [loanId]);
  res.status(status).json(reports.map(serializeReport));
}

const TOO_MANY_PHOTOS = `A condition report can have at most ${MAX_CONDITION_PHOTOS} photos`;

// GET /api/loans/:id/condition
// Every report on this loan — both sides', both ends'. Only the borrower and
// owner can reach it, because withLoan 404s anyone else.
router.get('/:id/condition', withLoan(async (_req, res, row) => {
  await sendReports(res, row.id, 200);
}));

// POST /api/loans/:id/condition   multipart: phase, note?, photos (0-3)
// File your own record of one end of this loan.
router.post(
  '/:id/condition',
  discardUploadsIfRejected,
  photoUpload('photos', MAX_CONDITION_PHOTOS),
  handleUploadError(TOO_MANY_PHOTOS),
  verifyImageContents,
  withLoan(async (req, res, row) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const body = (req.body ?? {}) as Record<string, unknown>;

    const phase = parsePhase(body.phase);
    if (!phase.ok) return fail(res, { ok: false, status: 400, error: phase.error });

    const allowed = checkPhase({ status: row.status, handedOffAt: row.handed_off_at, returnedAt: row.returned_at }, phase.value);
    if (!allowed.ok) return fail(res, allowed);

    const note = optionalText(body.note, 'Note', LIMITS.conditionNote);
    if (!note.ok) return fail(res, { ok: false, status: 400, error: note.error });
    if (note.value === null && files.length === 0) {
      return fail(res, { ok: false, status: 400, error: 'Add a note or a photo — an empty report records nothing' });
    }

    // INSERT IGNORE against UNIQUE (loan_id, phase, author_id): a second
    // report from the same person for the same end inserts nothing, which is
    // how a double-submit (or a deliberate rewrite) is refused atomically.
    const report = await insert(
      'INSERT IGNORE INTO loan_condition_reports (loan_id, phase, author_id, note) VALUES (?, ?, ?, ?)',
      [row.id, phase.value, req.user!.userId, note.value]
    );
    if (!report.inserted) {
      return fail(res, { ok: false, status: 409, error: `You already recorded how it looked at the ${phase.value}` });
    }

    if (files.length > 0) {
      const paths = files.map(uploadPath);
      await change(
        `INSERT INTO loan_condition_photos (report_id, image_path, position) VALUES ${paths.map(() => '(?, ?, ?)').join(', ')}`,
        paths.flatMap((imagePath, position) => [report.id, imagePath, position])
      );
    }

    await events.conditionRecorded(row.id, req.user!.userId, phase.value);
    await sendReports(res, row.id, 201);
  })
);

// ---------------------------------------------------------------------------
// Messages — "running 20 minutes late", next to the terms rather than in a
// text thread the app never sees. Only the loan's two people can reach any of
// this (withLoan 404s everyone else). Open while the loan is active; once it
// ends the thread is kept as a record and takes nothing new. See
// utils/loanMessages.ts.
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  author_id: number;
  author_name: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

async function sendMessages(req: CollectionRequest, res: Response, loanId: number, status: 200 | 201): Promise<void> {
  const thread = await rows<MessageRow>(
    `SELECT m.id, m.author_id, u.display_name AS author_name, m.body, m.created_at, m.read_at
     FROM loan_messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.loan_id = ?
     ORDER BY m.id`,
    [loanId]
  );
  const userId = req.user!.userId;
  res.status(status).json(thread.map(message => ({
    id: message.id,
    authorId: message.author_id,
    authorName: message.author_name,
    mine: message.author_id === userId,
    body: message.body,
    // Whether the other person has seen it — the only reader a message has.
    read: message.read_at !== null,
    createdAt: iso(message.created_at),
  })));
}

// GET /api/loans/:id/messages
// The whole thread, oldest first. Reading it marks nothing — the page says
// when you've actually seen it (POST .../messages/read), so a background
// refresh can't clear someone's "new" before they've looked.
router.get('/:id/messages', withLoan(async (req, res, row) => {
  await sendMessages(req, res, row.id, 200);
}));

const JUST_ENDED: RuleFailure = { ok: false, status: 409, error: 'This loan just ended — refresh to see where it stands' };

// POST /api/loans/:id/messages  { body }
router.post('/:id/messages', withLoan(async (req, res, row) => {
  const body = parseMessage((req.body as { body?: unknown } | undefined)?.body);
  if (!body.ok) return fail(res, { ok: false, status: 400, error: body.error });

  const allowed = checkCanPost(row.status, Number(row.messages));
  if (!allowed.ok) return fail(res, allowed);

  // Checked again with the loan row locked, so two messages sent at the same
  // instant are counted one after the other (the thread can't overshoot its
  // ceiling), and a request cancelled — or a mini marked returned — in the
  // instant before this lands takes no message.
  const refused = await inTransaction<RuleFailure | null>(async conn => {
    const locked = await firstRow<{ status: LoanStatus; messages: number }>(
      `SELECT l.status, (SELECT COUNT(*) FROM loan_messages m WHERE m.loan_id = l.id) AS messages
       FROM loans l WHERE l.id = ? FOR UPDATE`,
      [row.id],
      conn
    );
    if (!locked || !messagesOpen(locked.status)) return JUST_ENDED;
    const stillAllowed = checkCanPost(locked.status, Number(locked.messages));
    if (!stillAllowed.ok) return stillAllowed;
    await insert(
      'INSERT INTO loan_messages (loan_id, author_id, body) VALUES (?, ?, ?)',
      [row.id, req.user!.userId, body.value],
      conn
    );
    return null;
  });
  if (refused) return fail(res, refused);

  await events.messagePosted(row.id, req.user!.userId, body.value);
  await sendMessages(req, res, row.id, 201);
}));

// POST /api/loans/:id/messages/read
// You've seen the other side's messages: they learn so ("Seen"), your count
// goes to zero, and the bell entry about this thread is marked read with it.
router.post('/:id/messages/read', withLoan(async (req, res, row) => {
  const userId = req.user!.userId;
  const read = await change(
    `UPDATE loan_messages SET read_at = NOW()
     WHERE loan_id = ? AND author_id <> ? AND read_at IS NULL`,
    [row.id, userId]
  );
  await change(
    `UPDATE notifications SET read_at = NOW()
     WHERE user_id = ? AND loan_id = ? AND type = 'loan_message' AND read_at IS NULL`,
    [userId, row.id]
  );
  res.json({ read });
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
