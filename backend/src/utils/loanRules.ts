// The business rules for negotiating a loan, kept free of Express and SQL so
// every rule can be unit tested directly. Routes in routes/loans.ts load a
// loan, ask these functions what should happen, then persist the result.

export type LoanStatus = 'negotiating' | 'adventuring' | 'returned' | 'cancelled';
export type LoanStage = 'negotiating' | 'agreed' | 'adventuring' | 'overdue' | 'returned' | 'cancelled';
export type LoanRole = 'borrower' | 'owner';

export interface LoanTerms {
  handoffWhen: Date | null;
  handoffWhere: string | null;
  handoffHow: string | null;
  durationDays: number | null;
}

export interface LoanApprovals {
  borrowerApproved: boolean;
  ownerApproved: boolean;
}

export interface LoanSnapshot extends LoanTerms, LoanApprovals {
  status: LoanStatus;
  borrowerId: number;
  ownerId: number;
  dueAt: Date | null;
}

export type RuleFailure = { ok: false; status: 400 | 403 | 409; error: string };

// A loan is a lend between friends, not an indefinite handover: three months
// at a time. Longer than that, agree a fresh loan when this one comes back.
export const MAX_DURATION_DAYS = 90;
export const DURATION_LIMIT_MESSAGE = `Loans can run from 1 to ${MAX_DURATION_DAYS} days (about 3 months)`;
const MAX_TEXT_LENGTH = 255;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const DAY_MS = 24 * 60 * 60 * 1000;

export function roleOf(loan: { borrowerId: number; ownerId: number }, userId: number): LoanRole | null {
  if (loan.borrowerId === userId) return 'borrower';
  if (loan.ownerId === userId) return 'owner';
  return null;
}

export function termsComplete(terms: LoanTerms): boolean {
  return terms.handoffWhen !== null
    && terms.handoffWhere !== null
    && terms.handoffHow !== null
    && terms.durationDays !== null;
}

function parseText(value: unknown, label: string): { ok: true; value: string } | RuleFailure {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, status: 400, error: `${label} can't be blank` };
  }
  if (value.trim().length > MAX_TEXT_LENGTH) {
    return { ok: false, status: 400, error: `${label} must be ${MAX_TEXT_LENGTH} characters or fewer` };
  }
  return { ok: true, value: value.trim() };
}

// Validates a request body proposing new terms. Only the owner may touch the
// duration — the borrower attempting to is a 403, not a silent ignore, so a
// tampered request can't quietly change it.
export function parseTermsPatch(
  input: { when?: unknown; where?: unknown; how?: unknown; durationDays?: unknown },
  role: LoanRole
): { ok: true; patch: Partial<LoanTerms> } | RuleFailure {
  const patch: Partial<LoanTerms> = {};

  if (input.durationDays !== undefined) {
    if (role !== 'owner') {
      return { ok: false, status: 403, error: 'Only the owner can set the loan duration' };
    }
    const days = input.durationDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DURATION_DAYS) {
      return { ok: false, status: 400, error: DURATION_LIMIT_MESSAGE };
    }
    patch.durationDays = days;
  }

  if (input.when !== undefined) {
    const when = typeof input.when === 'string' ? new Date(input.when) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return { ok: false, status: 400, error: 'When must be a valid date and time' };
    }
    // The date picker accepts a year typed as "26" or "20266" — neither is a real plan.
    const year = when.getUTCFullYear();
    if (year < MIN_YEAR || year > MAX_YEAR) {
      return { ok: false, status: 400, error: 'That date doesn\'t look right — check the year' };
    }
    patch.handoffWhen = when;
  }

  if (input.where !== undefined) {
    const parsed = parseText(input.where, 'Where');
    if (!parsed.ok) return parsed;
    patch.handoffWhere = parsed.value;
  }

  if (input.how !== undefined) {
    const parsed = parseText(input.how, 'How');
    if (!parsed.ok) return parsed;
    patch.handoffHow = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: 'Nothing to update' };
  }

  return { ok: true, patch };
}

function sameValue(a: Date | string | number | null, b: Date | string | number | null): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

export function termsChanged(current: LoanTerms, next: LoanTerms): boolean {
  return !sameValue(next.handoffWhen, current.handoffWhen)
    || !sameValue(next.handoffWhere, current.handoffWhere)
    || !sameValue(next.handoffHow, current.handoffHow)
    || !sameValue(next.durationDays, current.durationDays);
}

// The two-key rule. Proposing changed terms counts as the editor turning
// their own key (if the terms are complete) and always un-turns the other
// side's — so the loan can only be "agreed" when both approvals sit on the
// exact same, current terms.
export function applyTermsEdit(
  current: LoanSnapshot,
  role: LoanRole,
  patch: Partial<LoanTerms>
): LoanTerms & LoanApprovals {
  const merged: LoanTerms = {
    handoffWhen: patch.handoffWhen !== undefined ? patch.handoffWhen : current.handoffWhen,
    handoffWhere: patch.handoffWhere !== undefined ? patch.handoffWhere : current.handoffWhere,
    handoffHow: patch.handoffHow !== undefined ? patch.handoffHow : current.handoffHow,
    durationDays: patch.durationDays !== undefined ? patch.durationDays : current.durationDays,
  };

  if (!termsChanged(current, merged)) {
    return { ...merged, borrowerApproved: current.borrowerApproved, ownerApproved: current.ownerApproved };
  }

  const editorApproves = termsComplete(merged);
  return {
    ...merged,
    borrowerApproved: role === 'borrower' ? editorApproves : false,
    ownerApproved: role === 'owner' ? editorApproves : false,
  };
}

export function approveTerms(current: LoanSnapshot, role: LoanRole): ({ ok: true } & LoanApprovals) | RuleFailure {
  if (current.status !== 'negotiating') {
    return { ok: false, status: 409, error: 'This loan is no longer being negotiated' };
  }
  if (!termsComplete(current)) {
    return { ok: false, status: 400, error: 'Fill in when, where, how, and the duration before approving' };
  }
  return {
    ok: true,
    borrowerApproved: role === 'borrower' ? true : current.borrowerApproved,
    ownerApproved: role === 'owner' ? true : current.ownerApproved,
  };
}

export function stageOf(loan: LoanSnapshot, now: Date): LoanStage {
  if (loan.status === 'negotiating') {
    return termsComplete(loan) && loan.borrowerApproved && loan.ownerApproved ? 'agreed' : 'negotiating';
  }
  if (loan.status === 'adventuring') {
    return loan.dueAt !== null && now.getTime() > loan.dueAt.getTime() ? 'overdue' : 'adventuring';
  }
  return loan.status;
}

// The terms carried over by "apply these terms to all requests with this
// person". Unset fields are skipped so they don't blank out terms already
// worked out on the other requests, and the borrower can never carry a
// duration across (same rule as editing one loan directly).
export function termsToCopy(source: LoanTerms, role: LoanRole): Partial<LoanTerms> {
  const copy: Partial<LoanTerms> = {};
  if (source.handoffWhen !== null) copy.handoffWhen = source.handoffWhen;
  if (source.handoffWhere !== null) copy.handoffWhere = source.handoffWhere;
  if (source.handoffHow !== null) copy.handoffHow = source.handoffHow;
  if (role === 'owner' && source.durationDays !== null) copy.durationDays = source.durationDays;
  return copy;
}

export function dueAtFrom(handedOffAt: Date, durationDays: number): Date {
  return new Date(handedOffAt.getTime() + durationDays * DAY_MS);
}

// How long a loan has actually run: handoff to return, or handoff to now for
// one that's still out. Used by a mini's lending history ("how often, for how
// long"), not by the three-month cap — that's durationDays, what was agreed,
// not what happened.
export function daysOut(handedOffAt: Date, returnedAt: Date | null, now: Date = new Date()): number {
  const end = returnedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - handedOffAt.getTime()) / DAY_MS));
}

// Someone is in line for it, so it can't be kept longer — a library won't renew
// a book that's reserved either. Bringing it back hands it straight to them.
export const HOLD_BLOCKS_EXTENSION =
  'Someone is waiting in line for this mini, so it can\'t be kept longer — bring it back and they\'re next';

// Keeping a mini longer without cancelling and asking again. The three months a
// loan gets is a ceiling on the whole loan, counted from the handoff, so an
// extension can only spend what's left of it.
export function parseExtension(
  input: { extraDays?: unknown },
  currentDurationDays: number | null
): { ok: true; totalDays: number } | RuleFailure {
  if (currentDurationDays === null) {
    return { ok: false, status: 409, error: 'This loan has no agreed duration to extend' };
  }

  const extra = input.extraDays;
  if (typeof extra !== 'number' || !Number.isInteger(extra) || extra < 1 || extra > MAX_DURATION_DAYS) {
    return { ok: false, status: 400, error: `Say how many more days, from 1 to ${MAX_DURATION_DAYS}` };
  }

  const left = MAX_DURATION_DAYS - currentDurationDays;
  if (left <= 0) {
    return {
      ok: false,
      status: 400,
      error: `It's already been out for the three months a loan can run — bring it back, and agree a fresh loan if you both want`,
    };
  }
  if (extra > left) {
    return {
      ok: false,
      status: 400,
      error: `A loan can run three months in total, so you can keep it ${left} more day${left === 1 ? '' : 's'}`,
    };
  }

  return { ok: true, totalDays: currentDurationDays + extra };
}
