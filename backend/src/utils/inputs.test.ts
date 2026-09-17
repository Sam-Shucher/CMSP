import { describe, it, expect } from 'vitest';
import { requiredText, optionalText, emailAddress, tagList, positiveId } from './inputs';

describe('requiredText', () => {
  it('trims and accepts text within the limit', () => {
    expect(requiredText('  Dire Wolf ', 'Name', 20)).toEqual({ ok: true, value: 'Dire Wolf' });
    expect(requiredText('x'.repeat(20), 'Name', 20)).toMatchObject({ ok: true });
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['a number', 42],
    ['an array (e.g. ?name=a&name=b)', ['a', 'b']],
    ['an object', { $gt: '' }],
  ])('rejects a value that is %s', (_why, value) => {
    expect(requiredText(value, 'Name', 20)).toEqual({ ok: false, error: expect.stringMatching(/name/i) });
  });

  it('rejects text over the limit, naming the limit', () => {
    expect(requiredText('x'.repeat(21), 'Name', 20)).toEqual({ ok: false, error: 'Name must be 20 characters or fewer' });
  });
});

describe('optionalText', () => {
  it('treats missing, null, and blank as "no value"', () => {
    expect(optionalText(undefined, 'Phone', 20)).toEqual({ ok: true, value: null });
    expect(optionalText(null, 'Phone', 20)).toEqual({ ok: true, value: null });
    expect(optionalText('  ', 'Phone', 20)).toEqual({ ok: true, value: null });
  });

  it('trims a present value', () => {
    expect(optionalText(' 555-1234 ', 'Phone', 20)).toEqual({ ok: true, value: '555-1234' });
  });

  it('rejects non-text and over-long values', () => {
    expect(optionalText(5551234, 'Phone', 20)).toMatchObject({ ok: false });
    expect(optionalText('5'.repeat(21), 'Phone', 20)).toMatchObject({ ok: false });
  });
});

describe('emailAddress', () => {
  it('normalizes to trimmed lowercase', () => {
    expect(emailAddress('  Friend@Example.COM ')).toEqual({ ok: true, value: 'friend@example.com' });
  });

  it.each([
    'not-an-email',
    'two@@example.com',
    'spaces in@example.com',
    '@example.com',
    'friend@',
    `${'a'.repeat(250)}@example.com`,
    "x'; DROP TABLE users; --@example.com",
  ])('rejects %s', (value) => {
    expect(emailAddress(value)).toMatchObject({ ok: false });
  });

  it('rejects non-strings', () => {
    expect(emailAddress({ $ne: null })).toMatchObject({ ok: false });
    expect(emailAddress(['a@b.co'])).toMatchObject({ ok: false });
  });
});

describe('tagList', () => {
  it('splits, trims, lowercases, drops blanks and duplicates', () => {
    expect(tagList(' Boss, painted ,, boss ')).toEqual({ ok: true, value: ['boss', 'painted'] });
  });

  it('treats a missing value as no tags', () => {
    expect(tagList(undefined)).toEqual({ ok: true, value: [] });
  });

  it('rejects too many tags or a tag that is too long', () => {
    expect(tagList(Array.from({ length: 21 }, (_, i) => `t${i}`).join(','))).toMatchObject({ ok: false });
    expect(tagList('x'.repeat(51))).toMatchObject({ ok: false });
  });

  it('rejects non-text', () => {
    expect(tagList(['a', 'b'])).toMatchObject({ ok: false });
  });
});

describe('positiveId', () => {
  it('accepts positive whole numbers', () => {
    expect(positiveId(6)).toEqual({ ok: true, value: 6 });
  });

  it.each([0, -1, 1.5, '6', '6; DROP TABLE collections', null, undefined, [6]])('rejects %s', (value) => {
    expect(positiveId(value)).toMatchObject({ ok: false });
  });
});
