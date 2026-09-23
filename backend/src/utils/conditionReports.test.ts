import { describe, it, expect } from 'vitest';
import {
  CONDITION_PHASES, checkPhase, parsePhase, openPhases, MAX_CONDITION_PHOTOS,
} from './conditionReports';
import { LoanStatus } from './loanRules';

// A condition report is a record of what a mini looked like at one end of a
// loan. The rules here are about WHEN one can still be filed — the whole point
// of the feature is that the note was made at the time, so a claim about the
// handoff can't be invented after the mini is already back and disputed.

function loan(status: LoanStatus, handedOff = true) {
  return { status, handedOffAt: handedOff ? new Date('2026-10-01T18:00:00.000Z') : null };
}

describe('parsePhase', () => {
  it.each(CONDITION_PHASES)('accepts %s', (phase: string) => {
    const parsed = parsePhase(phase);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toBe(phase);
  });

  // Query strings and JSON can carry any type at all, not just a wrong string.
  it.each([undefined, null, '', 'sideways', 5, ['handoff'], { phase: 'handoff' }])(
    'refuses %p',
    (value: unknown) => {
      const parsed = parsePhase(value);

      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.error).toMatch(/handoff/);
    }
  );
});

describe('checkPhase — nothing to report before the mini changes hands', () => {
  it.each(CONDITION_PHASES)('refuses a %s report on a loan still being negotiated', (phase) => {
    const result = checkPhase(loan('negotiating', false), phase);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
    expect(!result.ok && result.error).toMatch(/changed hands/i);
  });

  it.each(CONDITION_PHASES)('refuses a %s report on a cancelled request', (phase) => {
    const result = checkPhase(loan('cancelled', false), phase);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
  });
});

describe('checkPhase — while the mini is out adventuring', () => {
  it('accepts a handoff report: this is the moment it is about', () => {
    expect(checkPhase(loan('adventuring'), 'handoff').ok).toBe(true);
  });

  // The borrower photographing it before they hand it back is the whole point
  // of letting a return report be filed before the owner marks it returned.
  it('accepts a return report too', () => {
    expect(checkPhase(loan('adventuring'), 'return').ok).toBe(true);
  });
});

describe('checkPhase — once the loan is over', () => {
  const ENDED: LoanStatus[] = ['returned', 'lost', 'critically_wounded'];

  // The owner only gets it back in hand at that moment, so this has to stay open.
  it.each(ENDED)('still accepts a return report on a %s loan', (status) => {
    expect(checkPhase(loan(status), 'return').ok).toBe(true);
  });

  // The argument this feature exists to prevent is exactly a fresh claim about
  // the handoff, made after the mini is back and something is wrong with it.
  it.each(ENDED)('refuses a new handoff report on a %s loan', (status) => {
    const result = checkPhase(loan(status), 'handoff');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
    expect(!result.ok && result.error).toMatch(/while the mini is out/i);
  });
});

describe('openPhases — what the page should offer', () => {
  it('offers nothing before the handoff', () => {
    expect(openPhases(loan('negotiating', false))).toEqual([]);
  });

  it('offers both ends while it is out', () => {
    expect(openPhases(loan('adventuring'))).toEqual(['handoff', 'return']);
  });

  it('offers only the return once it is over', () => {
    expect(openPhases(loan('returned'))).toEqual(['return']);
  });
});

describe('the photo ceiling', () => {
  // Same as a mini's, for the same reason — it is the same upload pipeline.
  it('is three', () => {
    expect(MAX_CONDITION_PHOTOS).toBe(3);
  });
});
