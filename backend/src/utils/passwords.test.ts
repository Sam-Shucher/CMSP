import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword, needsRehash, passwordCost, temporaryPassword } from './passwords';

// Hashing at the real cost takes hundreds of milliseconds by design, so these
// tests pin the cost down to the cheapest bcrypt allows.
const FAST = { PASSWORD_COST: '4' };

describe('hashing a password', () => {
  it('never stores the password itself, and salts every hash differently', async () => {
    const first = await hashPassword('correct horse battery staple', FAST);
    const second = await hashPassword('correct horse battery staple', FAST);

    expect(first).not.toContain('correct horse');
    expect(first).not.toBe(second); // same password, different salt
    expect(first).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt, with its cost and salt inside
  });

  it('accepts the password back, and rejects anything else', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);

    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('keeps every character, including spaces and emoji', async () => {
    const password = '🐉 a spaced   pass-phrase! ';
    const hash = await hashPassword(password, FAST);

    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword(password.trim(), hash)).resolves.toBe(false);
  });

  it('says no to a hash that isn\'t one, instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});

describe('how hard the hash is to crack', () => {
  it('defaults to cost 12 — about 4,000 rounds per guess', () => {
    expect(passwordCost({})).toBe(12);
  });

  it('can be tuned per machine, so faster hardware can dial it up', () => {
    expect(passwordCost({ PASSWORD_COST: '13' })).toBe(13);
  });

  it.each(['3', '16', 'twelve', ''])('ignores a nonsense setting (%s) and uses the default', (value) => {
    expect(passwordCost({ PASSWORD_COST: value })).toBe(12);
  });

  it('hashes at the configured cost', async () => {
    const hash = await hashPassword('correct horse battery staple', { PASSWORD_COST: '5' });
    expect(hash).toMatch(/^\$2[aby]\$05\$/);
  });
});

describe('upgrading old hashes', () => {
  it('spots a hash made at a weaker cost than we now use', async () => {
    const old = await bcrypt.hash('correct horse battery staple', 10);

    expect(needsRehash(old, { PASSWORD_COST: '13' })).toBe(true);
  });

  it('leaves a hash at the current cost alone', async () => {
    const current = await hashPassword('correct horse battery staple', { PASSWORD_COST: '5' });

    expect(needsRehash(current, { PASSWORD_COST: '5' })).toBe(false);
  });

  it('never asks to re-hash something it can\'t read', () => {
    expect(needsRehash('not-a-hash', FAST)).toBe(false);
    expect(needsRehash('', FAST)).toBe(false);
  });
});

describe('the temporary password an admin hands out', () => {
  it('is long, random, and different every time', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => temporaryPassword()));

    expect(passwords.size).toBe(50);
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(14);
    }
  });

  it('avoids characters that are misread when typed from a text message', () => {
    const joined = Array.from({ length: 200 }, () => temporaryPassword()).join('');

    expect(joined).not.toMatch(/[O0Il1]/);
    expect(joined).toMatch(/^[a-zA-Z0-9-]+$/); // nothing that needs escaping or a symbol key
  });
});
