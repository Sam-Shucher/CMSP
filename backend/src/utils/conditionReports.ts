import { Check } from './inputs';
import { LoanStatus, RuleFailure } from './loanRules';

// What a mini looked like at each end of a loan — a note and up to three
// photos, filed by either side, so "the spear was already bent" is a fact
// instead of an argument.
//
// Everything here is about WHEN a report can still be filed. A report is never
// edited or replaced once made (routes/loans.ts refuses a second one from the
// same person for the same end), because a record that can be rewritten later
// is not a record.

export const CONDITION_PHASES = ['handoff', 'return'] as const;
export type ConditionPhase = (typeof CONDITION_PHASES)[number];

// The same ceiling a mini's photos get — it is the same upload pipeline, and
// three angles is already more than anyone fills in at a doorstep.
export const MAX_CONDITION_PHOTOS = 3;

export interface ConditionLoanSnapshot {
  status: LoanStatus;
  handedOffAt: Date | null;
}

export function parsePhase(value: unknown): Check<ConditionPhase> {
  if (typeof value !== 'string' || !CONDITION_PHASES.includes(value as ConditionPhase)) {
    return { ok: false, error: `Phase must be one of: ${CONDITION_PHASES.join(', ')}` };
  }
  return { ok: true, value: value as ConditionPhase };
}

export function checkPhase(loan: ConditionLoanSnapshot, phase: ConditionPhase): { ok: true } | RuleFailure {
  if (loan.handedOffAt === null) {
    return {
      ok: false,
      status: 409,
      error: 'There\'s nothing to record until the mini has changed hands',
    };
  }

  // A return report stays open after the loan ends: the owner only has the
  // mini back in hand at that moment. A handoff report does not — a fresh
  // claim about how it looked at the handoff, made once it's back and
  // something is wrong with it, is the argument this whole feature replaces.
  if (phase === 'handoff' && loan.status !== 'adventuring') {
    return {
      ok: false,
      status: 409,
      error: 'How it looked at the handoff can only be recorded while the mini is out',
    };
  }

  return { ok: true };
}

// The ends still open to this loan, for the page to offer.
export function openPhases(loan: ConditionLoanSnapshot): ConditionPhase[] {
  return CONDITION_PHASES.filter(phase => checkPhase(loan, phase).ok);
}
