import { describe, it, expect } from 'vitest';
import {
  LoanSnapshot,
  roleOf,
  termsComplete,
  parseTermsPatch,
  applyTermsEdit,
  termsChanged,
  approveTerms,
  stageOf,
  termsToCopy,
  dueAtFrom,
  parseExtension,
  daysOut,
} from './loanRules';

const WHEN = new Date('2026-10-01T18:00:00.000Z');

function loan(overrides: Partial<LoanSnapshot> = {}): LoanSnapshot {
  return {
    status: 'negotiating',
    borrowerId: 1,
    ownerId: 2,
    handoffWhen: null,
    handoffWhere: null,
    handoffHow: null,
    durationDays: null,
    borrowerApproved: false,
    ownerApproved: false,
    dueAt: null,
    ...overrides,
  };
}

const COMPLETE = { handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person', durationDays: 14 };

describe('roleOf', () => {
  it('identifies the borrower and the owner', () => {
    expect(roleOf(loan(), 1)).toBe('borrower');
    expect(roleOf(loan(), 2)).toBe('owner');
  });

  it('returns null for anyone else', () => {
    expect(roleOf(loan(), 3)).toBeNull();
  });
});

describe('termsComplete', () => {
  it('is true only when when, where, how, and duration are all set', () => {
    expect(termsComplete(loan(COMPLETE))).toBe(true);
    expect(termsComplete(loan({ ...COMPLETE, durationDays: null }))).toBe(false);
    expect(termsComplete(loan({ ...COMPLETE, handoffWhere: null }))).toBe(false);
  });
});

describe('parseTermsPatch', () => {
  it('accepts when/where/how from the borrower', () => {
    const result = parseTermsPatch({ when: WHEN.toISOString(), where: ' Game store ', how: 'In person' }, 'borrower');
    expect(result).toEqual({
      ok: true,
      patch: { handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person' },
    });
  });

  it('lets the owner set a duration', () => {
    expect(parseTermsPatch({ durationDays: 7 }, 'owner')).toEqual({ ok: true, patch: { durationDays: 7 } });
  });

  it('forbids the borrower from setting the duration', () => {
    expect(parseTermsPatch({ durationDays: 7 }, 'borrower')).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects an unparseable date', () => {
    expect(parseTermsPatch({ when: 'next tuesday-ish' }, 'owner')).toMatchObject({ ok: false, status: 400 });
  });

  // datetime-local happily takes a year typed as "26" (year 0026) or "20266".
  // Year 26 used to be stored as 1926; year 20266 crashed the request.
  it.each([
    ['a two-digit year', '0026-10-01T18:30:00.000Z'],
    ['an extra digit in the year', '+020266-10-01T18:30:00.000Z'],
    ['the distant past', '1899-12-31T18:30:00.000Z'],
  ])('rejects %s, asking to check the year', (_why, when) => {
    expect(parseTermsPatch({ when }, 'owner')).toEqual({ ok: false, status: 400, error: 'That date doesn\'t look right — check the year' });
  });

  it('accepts ordinary dates, including one that already passed', () => {
    expect(parseTermsPatch({ when: '2025-12-31T23:00:00.000Z' }, 'owner')).toMatchObject({ ok: true });
    expect(parseTermsPatch({ when: '2099-01-01T00:00:00.000Z' }, 'owner')).toMatchObject({ ok: true });
  });

  it('rejects a date that is not a string at all', () => {
    expect(parseTermsPatch({ when: 1760000000000 }, 'owner')).toMatchObject({ ok: false, status: 400 });
    expect(parseTermsPatch({ when: null }, 'owner')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects where/how that are not strings', () => {
    expect(parseTermsPatch({ where: 42 }, 'owner')).toMatchObject({ ok: false, status: 400 });
    expect(parseTermsPatch({ how: ['in', 'person'] }, 'owner')).toMatchObject({ ok: false, status: 400 });
  });

  it('accepts where/how at exactly 255 characters', () => {
    expect(parseTermsPatch({ where: 'x'.repeat(255) }, 'owner')).toMatchObject({ ok: true });
  });

  // A loan is a lend between friends, not an indefinite handover.
  it('caps a loan at three months, and wants a whole number of days', () => {
    expect(parseTermsPatch({ durationDays: 90 }, 'owner')).toMatchObject({ ok: true });
    expect(parseTermsPatch({ durationDays: 91 }, 'owner')).toEqual({
      ok: false, status: 400, error: 'Loans can run from 1 to 90 days (about 3 months)',
    });
    expect(parseTermsPatch({ durationDays: 0 }, 'owner')).toMatchObject({ ok: false, status: 400 });
    expect(parseTermsPatch({ durationDays: 2.5 }, 'owner')).toMatchObject({ ok: false, status: 400 });
    expect(parseTermsPatch({ durationDays: '7' }, 'owner')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects blank or overly long where/how text', () => {
    expect(parseTermsPatch({ where: '   ' }, 'owner')).toMatchObject({ ok: false, status: 400 });
    expect(parseTermsPatch({ how: 'x'.repeat(256) }, 'owner')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects an empty update', () => {
    expect(parseTermsPatch({}, 'owner')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('applyTermsEdit — the two-key rule', () => {
  it('clears the other side\'s approval when terms change', () => {
    const current = loan({ ...COMPLETE, borrowerApproved: true, ownerApproved: true });
    const result = applyTermsEdit(current, 'owner', { durationDays: 21 });

    expect(result.durationDays).toBe(21);
    expect(result.borrowerApproved).toBe(false);
  });

  it('counts proposing complete terms as the editor turning their own key', () => {
    const current = loan({ handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person' });
    const result = applyTermsEdit(current, 'owner', { durationDays: 14 });

    expect(result.ownerApproved).toBe(true);
    expect(result.borrowerApproved).toBe(false);
  });

  it('does not approve on the editor\'s behalf while terms are still incomplete', () => {
    const result = applyTermsEdit(loan(), 'borrower', { handoffWhere: 'Game store' });
    expect(result.borrowerApproved).toBe(false);
  });

  it('keeps the fields the patch doesn\'t mention', () => {
    const current = loan(COMPLETE);
    const result = applyTermsEdit(current, 'borrower', { handoffHow: 'Mailed' });

    expect(result).toMatchObject({ handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'Mailed', durationDays: 14 });
  });

  it('leaves approvals alone when the "edit" doesn\'t actually change anything', () => {
    const current = loan({ ...COMPLETE, borrowerApproved: true, ownerApproved: true });
    const result = applyTermsEdit(current, 'owner', { durationDays: 14, handoffWhen: new Date(WHEN.getTime()) });

    expect(result.borrowerApproved).toBe(true);
    expect(result.ownerApproved).toBe(true);
  });
});

describe('termsChanged', () => {
  it('is true only when a term actually differs', () => {
    const current = loan(COMPLETE);
    expect(termsChanged(current, { ...COMPLETE })).toBe(false);
    expect(termsChanged(current, { ...COMPLETE, handoffWhen: new Date(WHEN.getTime()) })).toBe(false);
    expect(termsChanged(current, { ...COMPLETE, handoffWhere: 'Elsewhere' })).toBe(true);
    expect(termsChanged(current, { ...COMPLETE, durationDays: 21 })).toBe(true);
    expect(termsChanged(loan(), { ...loan(), handoffHow: 'Mailed' })).toBe(true);
  });
});

describe('approveTerms', () => {
  it('turns the caller\'s key on complete terms', () => {
    const result = approveTerms(loan({ ...COMPLETE, ownerApproved: true }), 'borrower');
    expect(result).toEqual({ ok: true, borrowerApproved: true, ownerApproved: true });
  });

  it('only turns the caller\'s own key — never the other side\'s', () => {
    expect(approveTerms(loan(COMPLETE), 'owner')).toEqual({ ok: true, borrowerApproved: false, ownerApproved: true });
    expect(approveTerms(loan(COMPLETE), 'borrower')).toEqual({ ok: true, borrowerApproved: true, ownerApproved: false });
  });

  it('refuses to approve incomplete terms', () => {
    expect(approveTerms(loan({ ...COMPLETE, durationDays: null }), 'borrower')).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses once the loan is no longer being negotiated', () => {
    expect(approveTerms(loan({ ...COMPLETE, status: 'adventuring' }), 'borrower')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('stageOf', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');

  it('is "negotiating" until both keys are turned on complete terms', () => {
    expect(stageOf(loan({ ...COMPLETE, ownerApproved: true }), now)).toBe('negotiating');
  });

  it('is "agreed" once both keys are turned', () => {
    expect(stageOf(loan({ ...COMPLETE, ownerApproved: true, borrowerApproved: true }), now)).toBe('agreed');
  });

  it('is still "negotiating" if both keys are somehow turned on incomplete terms', () => {
    expect(stageOf(loan({ handoffWhere: 'Game store', ownerApproved: true, borrowerApproved: true }), now)).toBe('negotiating');
  });

  it('is "adventuring" before the due date and "overdue" after it', () => {
    expect(stageOf(loan({ status: 'adventuring', dueAt: new Date('2026-10-11T00:00:00.000Z') }), now)).toBe('adventuring');
    expect(stageOf(loan({ status: 'adventuring', dueAt: new Date('2026-10-09T00:00:00.000Z') }), now)).toBe('overdue');
  });

  it('passes returned and cancelled straight through', () => {
    expect(stageOf(loan({ status: 'returned' }), now)).toBe('returned');
    expect(stageOf(loan({ status: 'cancelled' }), now)).toBe('cancelled');
  });
});

describe('termsToCopy — "apply terms to all requests with this person"', () => {
  it('copies when/where/how for the borrower, but never duration', () => {
    expect(termsToCopy(loan(COMPLETE), 'borrower')).toEqual({
      handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person',
    });
  });

  it('copies duration too for the owner', () => {
    expect(termsToCopy(loan(COMPLETE), 'owner')).toEqual(COMPLETE);
  });

  it('skips fields that aren\'t set, rather than blanking them on the other requests', () => {
    expect(termsToCopy(loan({ handoffWhere: 'Game store' }), 'owner')).toEqual({ handoffWhere: 'Game store' });
  });
});

describe('dueAtFrom', () => {
  it('adds the duration in days to the handoff time', () => {
    expect(dueAtFrom(new Date('2026-10-01T18:00:00.000Z'), 14)).toEqual(new Date('2026-10-15T18:00:00.000Z'));
  });
});

// Used by a mini's lending history: how long a loan actually ran, whether
// it's finished or still going.
describe('daysOut', () => {
  it('counts the days between handoff and return', () => {
    expect(daysOut(new Date('2026-10-01T18:00:00.000Z'), new Date('2026-10-15T18:00:00.000Z'))).toBe(14);
  });

  it('rounds to the nearest whole day rather than always down', () => {
    // 14.6 days — closer to 15 than to 14.
    expect(daysOut(new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-15T14:24:00.000Z'))).toBe(15);
    // 14.4 days — closer to 14.
    expect(daysOut(new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-15T09:36:00.000Z'))).toBe(14);
  });

  it('counts up to now for one that is still out, given a clock', () => {
    const now = new Date('2026-10-08T18:00:00.000Z');
    expect(daysOut(new Date('2026-10-01T18:00:00.000Z'), null, now)).toBe(7);
  });

  it('is never negative, even for a clock skewed a moment before the handoff', () => {
    const handedOffAt = new Date('2026-10-01T18:00:00.000Z');
    expect(daysOut(handedOffAt, null, new Date(handedOffAt.getTime() - 5000))).toBe(0);
  });
});

// Keeping a mini longer without cancelling and asking again. The three months a
// loan gets is a ceiling on the whole loan, counted from the handoff — so an
// extension can only use up what's left of it.
describe('parseExtension', () => {
  it('adds the days to what was already agreed', () => {
    expect(parseExtension({ extraDays: 7 }, 14)).toEqual({ ok: true, totalDays: 21 });
    expect(parseExtension({ extraDays: 1 }, 1)).toEqual({ ok: true, totalDays: 2 });
  });

  it('allows an extension that lands exactly on the three-month limit', () => {
    expect(parseExtension({ extraDays: 30 }, 60)).toEqual({ ok: true, totalDays: 90 });
  });

  it('refuses one that would take the loan past three months, and says what is left', () => {
    const result = parseExtension({ extraDays: 31 }, 60);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/30 more days/);
  });

  it('says so plainly when there is nothing left to give', () => {
    const result = parseExtension({ extraDays: 1 }, 90);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/already been out for the three months/i);
  });

  it.each([
    ['nothing', undefined],
    ['zero days', 0],
    ['a negative number', -5],
    ['part of a day', 1.5],
    ['text', '7'],
    ['an object pretending to be a number', { valueOf: (): number => 7 }],
    ['more days than a loan can ever run', 91],
  ])('refuses %s', (_why, extraDays) => {
    expect(parseExtension({ extraDays }, 14)).toMatchObject({ ok: false, status: 400 });
  });

  // An adventuring loan always has one, but a tampered or half-migrated row
  // shouldn't silently become a loan with no end.
  it('refuses when no duration was ever agreed', () => {
    expect(parseExtension({ extraDays: 7 }, null)).toMatchObject({ ok: false, status: 409 });
  });
});
