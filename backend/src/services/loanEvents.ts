import { rows, firstRow, change } from '../db/query';
import { notify } from '../db/notifications';
import { messages } from '../utils/notificationMessages';

// Notifications for loan activity. Routes call these after a change succeeds.
// They never throw: a failed notification must never undo or fail the action
// that triggered it.

interface LoanInfo {
  id: number;
  mini_id: number;
  collection_id: number;
  borrower_id: number;
  owner_id: number;
  borrower_approved: number;
  owner_approved: number;
  due_at: Date | null;
  mini_name: string;
  borrower_name: string;
  owner_name: string;
}

function loadLoan(loanId: number): Promise<LoanInfo | null> {
  return firstRow<LoanInfo>(
    `SELECT l.id, l.mini_id, l.collection_id, l.borrower_id, l.owner_id, l.borrower_approved, l.owner_approved, l.due_at,
            m.name AS mini_name, b.display_name AS borrower_name, o.display_name AS owner_name
     FROM loans l
     JOIN minis m ON m.id = l.mini_id
     JOIN users b ON b.id = l.borrower_id
     JOIN users o ON o.id = l.owner_id
     WHERE l.id = ?`,
    [loanId]
  );
}

async function safely(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err: unknown) {
    console.error(`Notification (${label}) failed:`, err);
  }
}

// The other person on the loan, and the actor's name.
function sides(loan: LoanInfo, actorId: number): { otherId: number; actorName: string } {
  return actorId === loan.owner_id
    ? { otherId: loan.borrower_id, actorName: loan.owner_name }
    : { otherId: loan.owner_id, actorName: loan.borrower_name };
}

function base(loan: LoanInfo) {
  return { collectionId: loan.collection_id, miniId: loan.mini_id, loanId: loan.id };
}

export function requestCreated(loanId: number): Promise<void> {
  return safely('request created', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    await notify([loan.owner_id], { ...base(loan), type: 'request_created', message: messages.requestCreated(loan.borrower_name, loan.mini_name) });
  });
}

export function termsProposed(loanId: number, actorId: number): Promise<void> {
  return safely('terms proposed', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, actorId);
    await notify([otherId], { ...base(loan), type: 'terms_proposed', message: messages.termsProposed(actorName, loan.mini_name) });
  });
}

export function termsApproved(loanId: number, actorId: number): Promise<void> {
  return safely('terms approved', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, actorId);
    const agreed = Boolean(loan.borrower_approved) && Boolean(loan.owner_approved);
    await notify([otherId], { ...base(loan), type: 'terms_approved', message: messages.termsApproved(actorName, loan.mini_name, agreed) });
  });
}

export function termsAppliedToAll(loanId: number, actorId: number, updated: number): Promise<void> {
  return safely('terms applied to all', async () => {
    if (updated === 0) return;
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, actorId);
    await notify([otherId], { ...base(loan), type: 'terms_proposed', message: messages.termsAppliedToAll(actorName, updated) });
  });
}

export function requestCancelled(loanId: number, actorId: number): Promise<void> {
  return safely('request cancelled', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, actorId);
    await notify([otherId], { ...base(loan), type: 'request_cancelled', message: messages.requestCancelled(actorName, loan.mini_name) });
  });
}

// The person was removed from the group; tell whoever was on the other side.
export function requestCancelledByRemoval(loanId: number, removedUserId: number): Promise<void> {
  return safely('request cancelled by removal', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, removedUserId);
    await notify([otherId], { ...base(loan), type: 'request_cancelled', message: messages.requestCancelledByRemoval(actorName, loan.mini_name) });
  });
}

export function handedOff(loanId: number): Promise<void> {
  return safely('handed off', async () => {
    const loan = await loadLoan(loanId);
    if (!loan?.due_at) return;
    await notify([loan.borrower_id], {
      ...base(loan), type: 'handed_off', message: messages.handedOff(loan.owner_name, loan.mini_name, new Date(loan.due_at)),
    });
  });
}

// Kept longer. Whoever asked for it knows already; the other person is told,
// because the date they agreed to has moved.
export function extended(loanId: number, actorId: number, days: number): Promise<void> {
  return safely('extended', async () => {
    const loan = await loadLoan(loanId);
    if (!loan?.due_at) return;
    const { otherId, actorName } = sides(loan, actorId);
    await notify([otherId], {
      ...base(loan), type: 'extended',
      message: messages.extended(actorName, loan.mini_name, days, new Date(loan.due_at)),
    });
  });
}

export function received(loanId: number): Promise<void> {
  return safely('received', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    await notify([loan.owner_id], { ...base(loan), type: 'received', message: messages.received(loan.borrower_name, loan.mini_name) });
  });
}

export function returned(loanId: number): Promise<void> {
  return safely('returned', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    await notify([loan.borrower_id], { ...base(loan), type: 'returned', message: messages.returned(loan.owner_name, loan.mini_name) });
  });
}

export function lost(loanId: number): Promise<void> {
  return safely('lost', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    await notify([loan.borrower_id], { ...base(loan), type: 'lost', message: messages.lost(loan.owner_name, loan.mini_name) });
  });
}

// Someone wrote down what the mini looked like at one end of the loan. The
// other side is told, because a record only settles an argument if both
// people know it was made.
export function conditionRecorded(loanId: number, actorId: number, phase: 'handoff' | 'return'): Promise<void> {
  return safely('condition recorded', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    const { otherId, actorName } = sides(loan, actorId);
    await notify([otherId], {
      ...base(loan), type: 'condition_recorded', message: messages.conditionRecorded(actorName, loan.mini_name, phase),
    });
  });
}

export function criticallyWounded(loanId: number): Promise<void> {
  return safely('critically wounded', async () => {
    const loan = await loadLoan(loanId);
    if (!loan) return;
    await notify([loan.borrower_id], { ...base(loan), type: 'critically_wounded', message: messages.criticallyWounded(loan.owner_name, loan.mini_name) });
  });
}

// Housekeeping: announce each newly overdue loan to both sides, exactly once.
export async function notifyOverdueLoans(): Promise<number> {
  const overdueLoans = await rows<{ id: number }>(
    "SELECT id FROM loans WHERE status = 'adventuring' AND due_at < NOW() AND overdue_notified_at IS NULL"
  );
  let announced = 0;
  for (const row of overdueLoans) {
    // Claim it first, so two overlapping runs can't both announce it.
    const claimed = await change(
      'UPDATE loans SET overdue_notified_at = NOW() WHERE id = ? AND overdue_notified_at IS NULL',
      [row.id]
    );
    if (claimed === 0) continue;
    const loan = await loadLoan(row.id);
    if (!loan) continue;
    await notify([loan.borrower_id, loan.owner_id], { ...base(loan), type: 'overdue', message: messages.overdue(loan.mini_name) });
    announced += 1;
  }
  return announced;
}
