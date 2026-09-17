import { describe, it, expect } from 'vitest';
import { validateUsername, validatePassword, validateEmail } from './validation';

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
    expect(validatePassword('').valid).toBe(false);
  });

  it('accepts a password at the minimum length (8)', () => {
    expect(validatePassword('abcd1234').valid).toBe(true);
  });

  // Any character is allowed — passwords are only ever hashed, never put in
  // SQL or shown on a page, so there's nothing to "escape". Symbols and
  // spaces make passwords stronger and let password managers do their job.
  it.each([
    ['spaces (a passphrase)', 'correct horse battery staple'],
    ['symbols', 'P@ssw0rd!#$%^&*()'],
    ['quotes and SQL-looking text', "' OR '1'='1 --"],
    ['non-English letters', 'contraseña-segura'],
    ['emoji', 'dragon🐉hoard🐉'],
    ['a password-manager style string', 'x9$Lq!m2#Vz@8pT&w4^Rk'],
  ])('accepts passwords with %s', (_label, value) => {
    expect(validatePassword(value)).toEqual({ valid: true });
  });

  it('accepts up to 72 bytes', () => {
    expect(validatePassword('a'.repeat(72)).valid).toBe(true);
  });

  // bcrypt, which hashes the password, silently ignores everything after the
  // first 72 bytes. Longer passwords are refused rather than quietly shortened.
  it('rejects anything longer than 72 bytes', () => {
    expect(validatePassword('a'.repeat(73))).toEqual({ valid: false, error: expect.stringMatching(/too long/i) });
  });

  it('measures the limit in bytes, so multi-byte characters count for more', () => {
    expect(validatePassword('🐉'.repeat(18)).valid).toBe(true);   // 72 bytes
    expect(validatePassword('🐉'.repeat(19)).valid).toBe(false);  // 76 bytes
  });

  it('counts the 8-character minimum in characters, not bytes', () => {
    expect(validatePassword('🐉🐉🐉🐉').valid).toBe(false); // 16 bytes, but only 4 characters
  });

  it('returns a human-readable error message when invalid', () => {
    const result = validatePassword('short');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/at least 8/i);
  });
});

describe('validateEmail', () => {
  it('asks for an email when blank', () => {
    expect(validateEmail('')).toEqual({ valid: false, error: 'Enter your email address.' });
    expect(validateEmail('   ')).toEqual({ valid: false, error: 'Enter your email address.' });
  });

  it.each(['abc', 'abc@', '@example.com', 'abc@example', 'a b@example.com', 'two@@example.com'])(
    'gives a friendly example for "%s"',
    (value) => {
      expect(validateEmail(value)).toEqual({ valid: false, error: 'Enter an email like name@example.com.' });
    }
  );

  it('accepts ordinary addresses, ignoring surrounding spaces', () => {
    expect(validateEmail('me@example.com')).toEqual({ valid: true });
    expect(validateEmail('  First.Last+minis@mail.co.uk ')).toEqual({ valid: true });
  });

  it('matches what the server accepts', () => {
    expect(validateEmail(`${'a'.repeat(250)}@example.com`).valid).toBe(false); // over 255 characters
    expect(validateEmail("x';--@example.com").valid).toBe(false);             // quotes and semicolons refused server-side
  });
});
