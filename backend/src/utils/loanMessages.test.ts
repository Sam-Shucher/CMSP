import { describe, it, expect } from 'vitest';
import { messagesOpen, parseMessage, checkCanPost, MAX_MESSAGES_PER_LOAN } from './loanMessages';
import { LIMITS } from './inputs';

// A loan's message thread: "running 20 minutes late" next to the structured
// terms, so what was agreed stays in the app instead of in a text thread.

describe('messagesOpen', () => {
  it.each(['negotiating', 'adventuring'] as const)('is open while the loan is %s', (status) => {
    expect(messagesOpen(status)).toBe(true);
  });

  // Once it's over the thread is a record of what was said — kept, not added to.
  it.each(['returned', 'cancelled', 'lost', 'critically_wounded'] as const)('is closed once the loan is %s', (status) => {
    expect(messagesOpen(status)).toBe(false);
  });
});

describe('parseMessage', () => {
  it('trims what was typed', () => {
    expect(parseMessage('  running 20 minutes late \n')).toEqual({ ok: true, value: 'running 20 minutes late' });
  });

  it('keeps line breaks inside the message', () => {
    expect(parseMessage('Front door.\nRing twice.')).toEqual({ ok: true, value: 'Front door.\nRing twice.' });
  });

  it.each([undefined, null, '', '   ', '​'])('refuses an empty message (%j)', (value) => {
    const result = parseMessage(value);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/message/i);
  });

  it.each([42, ['hi'], { text: 'hi' }])('refuses something that isn\'t text (%j)', (value) => {
    expect(parseMessage(value).ok).toBe(false);
  });

  it('refuses one longer than the column holds', () => {
    const result = parseMessage('x'.repeat(LIMITS.loanMessage + 1));
    expect(result).toEqual({ ok: false, error: `Message must be ${LIMITS.loanMessage} characters or fewer` });
    expect(parseMessage('x'.repeat(LIMITS.loanMessage)).ok).toBe(true);
  });
});

describe('checkCanPost', () => {
  it('allows a message on an open loan with room left', () => {
    expect(checkCanPost('negotiating', 0)).toEqual({ ok: true });
    expect(checkCanPost('adventuring', MAX_MESSAGES_PER_LOAN - 1)).toEqual({ ok: true });
  });

  it('refuses a message once the loan is over', () => {
    const result = checkCanPost('returned', 3);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(!result.ok && result.error).toMatch(/over/i);
  });

  it('refuses once the thread is full', () => {
    const result = checkCanPost('adventuring', MAX_MESSAGES_PER_LOAN);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(!result.ok && result.error).toMatch(new RegExp(String(MAX_MESSAGES_PER_LOAN)));
  });
});
