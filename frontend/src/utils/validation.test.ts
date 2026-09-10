import { describe, it, expect } from 'vitest';
import { validateUsername, validatePassword } from './validation';

describe('validateUsername', () => {
  it('rejects usernames shorter than 4 characters', () => {
    expect(validateUsername('abc').valid).toBe(false);
  });

  it('rejects usernames longer than 32 characters', () => {
    expect(validateUsername('a'.repeat(33)).valid).toBe(false);
  });

  it('accepts a username at the minimum length (4)', () => {
    expect(validateUsername('abcd').valid).toBe(true);
  });

  it('accepts a username at the maximum length (32)', () => {
    expect(validateUsername('a'.repeat(32)).valid).toBe(true);
  });

  it('accepts letters, numbers, and underscores', () => {
    expect(validateUsername('dungeon_master_42').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validateUsername('').valid).toBe(false);
  });

  it.each([
    ['spaces', 'drop table'],
    ['a hyphen (SQL comment marker)', 'admin--'],
    ['a semicolon', 'a;b'],
    ['a single quote', "o'brien"],
    ['a double quote', 'a"b'],
    ['an equals sign', 'a=b'],
    ['a percent sign', 'a%b'],
    ['an asterisk', 'a*b'],
    ['a backslash', 'a\\b'],
    ['an angle bracket', 'a<b'],
  ])('rejects usernames containing %s ("%s")', (_label, value) => {
    expect(validateUsername(value).valid).toBe(false);
  });

  it('rejects a classic SQL injection payload', () => {
    expect(validateUsername("'; DROP TABLE users; --").valid).toBe(false);
  });

  it('returns a human-readable error message when invalid', () => {
    const result = validateUsername('ab');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('validatePassword', () => {
  it('rejects passwords shorter than 8 characters', () => {
    expect(validatePassword('abc123').valid).toBe(false);
  });

  it('rejects passwords longer than 32 characters', () => {
    expect(validatePassword('a'.repeat(33)).valid).toBe(false);
  });

  it('accepts a password at the minimum length (8)', () => {
    expect(validatePassword('abcd1234').valid).toBe(true);
  });

  it('accepts a password at the maximum length (32)', () => {
    expect(validatePassword('a'.repeat(32)).valid).toBe(true);
  });

  it('accepts a purely alphanumeric password', () => {
    expect(validatePassword('Password123').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validatePassword('').valid).toBe(false);
  });

  it.each([
    ['a space', 'abcd 1234'],
    ['an exclamation point', 'abcd1234!'],
    ['a hyphen (SQL comment marker)', 'abcd1234--'],
    ['a single quote', "abcd1234'"],
    ['a semicolon', 'abcd1234;'],
  ])('rejects passwords containing %s ("%s")', (_label, value) => {
    expect(validatePassword(value).valid).toBe(false);
  });

  it('rejects a classic SQL injection payload', () => {
    expect(validatePassword("' OR '1'='1").valid).toBe(false);
  });

  it('returns a human-readable error message when invalid', () => {
    const result = validatePassword('short');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
