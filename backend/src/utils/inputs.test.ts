import { describe, it, expect } from 'vitest';
import { requiredText, optionalText, emailAddress, tagList, positiveId, idList, optionalEnum, optionalId, optionalFlag, requiredBoolean } from './inputs';

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

  it.each([
    ['a zero-width space', '​'],
    ['zero-width joiners and a byte-order mark', '‍﻿ ‌'],
    ['a right-to-left mark', '‏'],
  ])('treats text that is only invisible characters (%s) as blank', (_why, value) => {
    expect(requiredText(value, 'Name', 20)).toEqual({ ok: false, error: 'Name is required' });
  });

  it('still accepts emoji built with invisible joiners', () => {
    expect(requiredText('👩‍👩‍👧', 'Name', 20)).toEqual({ ok: true, value: '👩‍👩‍👧' });
  });
});

describe('optionalText', () => {
  it('treats missing, null, and blank as "no value"', () => {
    expect(optionalText(undefined, 'Phone', 20)).toEqual({ ok: true, value: null });
    expect(optionalText(null, 'Phone', 20)).toEqual({ ok: true, value: null });
    expect(optionalText('  ', 'Phone', 20)).toEqual({ ok: true, value: null });
    expect(optionalText('​', 'Phone', 20)).toEqual({ ok: true, value: null });
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

describe('idList', () => {
  it('is optional — missing or absent means none', () => {
    expect(idList(undefined, 'miniIds', 50)).toEqual({ ok: true, value: [] });
    expect(idList(null, 'miniIds', 50)).toEqual({ ok: true, value: [] });
  });

  it('accepts a list of positive whole numbers', () => {
    expect(idList([1, 2, 3], 'miniIds', 50)).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('drops duplicates', () => {
    expect(idList([1, 2, 1, 2, 3], 'miniIds', 50)).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('rejects anything that is not an array', () => {
    expect(idList(1, 'miniIds', 50)).toMatchObject({ ok: false, error: expect.stringMatching(/miniIds/) });
    expect(idList('1,2,3', 'miniIds', 50)).toMatchObject({ ok: false });
    expect(idList({ 0: 1 }, 'miniIds', 50)).toMatchObject({ ok: false });
  });

  it.each([
    ['a string entry', ['1']],
    ['zero', [0]],
    ['a negative number', [-1]],
    ['a fraction', [1.5]],
    ['null mixed in', [1, null]],
    ['an object', [{ id: 1 }]],
  ])('rejects a list containing %s', (_why, value) => {
    expect(idList(value, 'miniIds', 50)).toMatchObject({ ok: false });
  });

  it('caps how many can be given at once', () => {
    const many = Array.from({ length: 51 }, (_unused, i) => i + 1);
    expect(idList(many, 'miniIds', 50)).toMatchObject({ ok: false, error: expect.stringMatching(/50/) });
    expect(idList(many.slice(0, 50), 'miniIds', 50)).toMatchObject({ ok: true });
  });
});

describe('optionalEnum', () => {
  const SORT = ['newest', 'name', 'price'] as const;

  it('treats missing, null, and empty string as "not specified"', () => {
    expect(optionalEnum(undefined, 'Sort', SORT)).toEqual({ ok: true, value: null });
    expect(optionalEnum(null, 'Sort', SORT)).toEqual({ ok: true, value: null });
    expect(optionalEnum('', 'Sort', SORT)).toEqual({ ok: true, value: null });
  });

  it('accepts a value from the allowed list', () => {
    expect(optionalEnum('name', 'Sort', SORT)).toEqual({ ok: true, value: 'name' });
  });

  it.each([
    ['a value not in the list', 'bogus'],
    ['an array (e.g. ?sort=a&sort=b)', ['newest', 'name']],
    ['an object (e.g. ?sort[$ne]=x)', { $ne: 'x' }],
    ['a number', 1],
  ])('rejects %s', (_why, value) => {
    expect(optionalEnum(value, 'Sort', SORT)).toMatchObject({ ok: false, error: expect.stringMatching(/sort/i) });
  });
});

describe('optionalId', () => {
  it('treats missing, null, and empty string as "not specified"', () => {
    expect(optionalId(undefined, 'Owner')).toEqual({ ok: true, value: null });
    expect(optionalId(null, 'Owner')).toEqual({ ok: true, value: null });
    expect(optionalId('', 'Owner')).toEqual({ ok: true, value: null });
  });

  it('accepts a positive whole number given as a string', () => {
    expect(optionalId('6', 'Owner')).toEqual({ ok: true, value: 6 });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['a fraction', '1.5'],
    ['non-numeric text', 'abc'],
    ['a number instead of a string', 6],
    ['an array (e.g. ?owner=1&owner=2)', ['1', '2']],
    ['an object (e.g. ?owner[$ne]=1)', { $ne: '1' }],
  ])('rejects %s', (_why, value) => {
    expect(optionalId(value, 'Owner')).toMatchObject({ ok: false, error: expect.stringMatching(/owner/i) });
  });
});

describe('optionalFlag', () => {
  it('treats missing, null, and empty string as false', () => {
    expect(optionalFlag(undefined, 'Available')).toEqual({ ok: true, value: false });
    expect(optionalFlag(null, 'Available')).toEqual({ ok: true, value: false });
    expect(optionalFlag('', 'Available')).toEqual({ ok: true, value: false });
  });

  it('accepts exactly "1" as true', () => {
    expect(optionalFlag('1', 'Available')).toEqual({ ok: true, value: true });
  });

  it.each(['true', 'false', '0', 'yes', ['1', '1'], { $ne: '1' }, 1])('rejects %s', (value) => {
    expect(optionalFlag(value, 'Available')).toMatchObject({ ok: false, error: expect.stringMatching(/available/i) });
  });
});

describe('requiredBoolean', () => {
  it('accepts a real JSON true or false', () => {
    expect(requiredBoolean(true, 'showPrices')).toEqual({ ok: true, value: true });
    expect(requiredBoolean(false, 'showPrices')).toEqual({ ok: true, value: false });
  });

  it.each([undefined, null, 'true', 'false', '1', 1, 0, [true], { value: true }])('rejects %s', (value) => {
    expect(requiredBoolean(value, 'showPrices')).toMatchObject({ ok: false, error: expect.stringMatching(/showPrices/) });
  });
});
