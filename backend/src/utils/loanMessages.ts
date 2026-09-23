import { Check, LIMITS, requiredText } from './inputs';
import { LoanStatus, RuleFailure } from './loanRules';

// A loan's message thread. The terms are structured fields on purpose — they
// are what both keys get turned on — but real handoffs also need "running 20
// minutes late" and "front door, ring twice". Without somewhere to say it,
// people drop to texting and the app loses the record of what was agreed.
//
// Only the loan's two people can read or write it (routes/loans.ts's withLoan
// 404s anyone else). Messages are never edited or deleted, for the same reason
// condition reports aren't: the point is a record of what was said.

// A generous ceiling for one loan — dozens of messages is a long negotiation.
// It exists so a stuck client or a bored member can't grow one thread without
// bound; it isn't a limit anyone should meet in normal use.
export const MAX_MESSAGES_PER_LOAN = 500;

// Open while there's something left to arrange; once the loan is over, the
// thread stays readable as a record but takes nothing new.
export function messagesOpen(status: LoanStatus): boolean {
  return status === 'negotiating' || status === 'adventuring';
}

export function parseMessage(value: unknown): Check<string> {
  return requiredText(value, 'Message', LIMITS.loanMessage);
}

export function checkCanPost(status: LoanStatus, messagesSoFar: number): { ok: true } | RuleFailure {
  if (!messagesOpen(status)) {
    return { ok: false, status: 409, error: 'This loan is over — its messages are kept, but it takes no new ones' };
  }
  if (messagesSoFar >= MAX_MESSAGES_PER_LOAN) {
    return { ok: false, status: 409, error: `This loan already has ${MAX_MESSAGES_PER_LOAN} messages, which is as many as one can hold` };
  }
  return { ok: true };
}
