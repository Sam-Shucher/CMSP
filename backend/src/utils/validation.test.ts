import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateUsername, validatePassword } from './validation';

describe('validateUsername', () => {
  it('accepts 4–32 letters, numbers, and underscores', () => {
    expect(validateUsername('abcd')).toEqual({ valid: true });
    expect(validateUsername('a'.repeat(32))).toEqual({ valid: true });
    expect(validateUsername('Dire_Wolf_42')).toEqual({ valid: true });
  });

  it('rejects the wrong length', () => {
    expect(validateUsername('abc')).toMatchObject({ valid: false, error: expect.stringMatching(/between 4 and 32/) });
    expect(validateUsername('a'.repeat(33))).toMatchObject({ valid: false });
    expect(validateUsername('')).toMatchObject({ valid: false });
  });

  it('rejects anything outside the whitelist', () => {
    expect(validateUsername("bob'; DROP TABLE users; --")).toMatchObject({ valid: false });
    expect(validateUsername('bob smith')).toMatchObject({ valid: false, error: expect.stringMatching(/letters, numbers, and underscores/) });
    expect(validateUsername('bob-smith')).toMatchObject({ valid: false });
  });
});

describe('validatePassword', () => {
  it('accepts any characters from 8 characters up to 72 bytes', () => {
    expect(validatePassword('abcd1234')).toEqual({ valid: true });
    expect(validatePassword('correct horse battery staple')).toEqual({ valid: true });
    expect(validatePassword("P@ss w0rd!' OR 1=1")).toEqual({ valid: true });
    expect(validatePassword('a'.repeat(72))).toEqual({ valid: true });
  });

  it('rejects fewer than 8 characters', () => {
    expect(validatePassword('abc1234')).toMatchObject({ valid: false, error: expect.stringMatching(/at least 8/) });
    expect(validatePassword('🐉🐉🐉🐉')).toMatchObject({ valid: false });
  });

  it('rejects more than 72 bytes, which bcrypt would silently ignore', () => {
    expect(validatePassword('a'.repeat(73))).toMatchObject({ valid: false, error: expect.stringMatching(/too long/i) });
    expect(validatePassword('🐉'.repeat(19))).toMatchObject({ valid: false });
  });
});

// The register page has its own copy of these rules. If one side changes and
// the other doesn't, users would see a form that accepts what the server
// rejects (or vice versa) — so pin the actual rule constants together.
describe('kept in sync with the frontend copy', () => {
  it('uses the same limits and patterns as frontend/src/utils/validation.ts', () => {
    const extract = (source: string) =>
      source.match(/const (USERNAME|PASSWORD)_[A-Z_]+ = .+;/g)?.sort();

    const backend = fs.readFileSync(path.join(__dirname, 'validation.ts'), 'utf8');
    const frontend = fs.readFileSync(path.join(__dirname, '../../../frontend/src/utils/validation.ts'), 'utf8');

    expect(extract(backend)).toHaveLength(5);
    expect(extract(backend)).toEqual(extract(frontend));
  });

  it('checks passwords the same way on both sides', () => {
    const body = (source: string) => source.slice(source.indexOf('export function validatePassword'));

    const backend = fs.readFileSync(path.join(__dirname, 'validation.ts'), 'utf8');
    const frontend = fs.readFileSync(path.join(__dirname, '../../../frontend/src/utils/validation.ts'), 'utf8');

    expect(body(backend)).toEqual(body(frontend));
  });
});
