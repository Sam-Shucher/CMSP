import { describe, it, expect } from 'vitest';
import path from 'path';
import webpush from 'web-push';
import { jwtSecret, listenHosts, uploadsDir, pushConfig, TEST_JWT_SECRET } from './config';

describe('uploadsDir', () => {
  it('is backend/uploads by default', () => {
    expect(uploadsDir({})).toBe(path.resolve(__dirname, '../uploads'));
  });

  it('can be pointed elsewhere with UPLOADS_DIR (tests use a temp folder)', () => {
    expect(uploadsDir({ UPLOADS_DIR: '/tmp/somewhere' })).toBe(path.resolve('/tmp/somewhere'));
  });
});

const STRONG = 'a3f1c9e07b2d4c58a6e9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1';

describe('jwtSecret', () => {
  it('returns a strong configured secret', () => {
    expect(jwtSecret({ JWT_SECRET: STRONG, NODE_ENV: 'production' })).toBe(STRONG);
  });

  // A missing or placeholder secret means anyone who has read this repo (or
  // the .env.example) could sign their own admin login cookie.
  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too short to resist guessing', 'hunter2hunter2'],
    ['the old code fallback', 'change-me-in-production'],
    ['the .env.example placeholder', 'change_this_to_a_long_random_string'],
  ])('refuses to run with a secret that is %s', (_why, secret) => {
    expect(() => jwtSecret({ JWT_SECRET: secret, NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => jwtSecret({ JWT_SECRET: secret, NODE_ENV: 'development' })).toThrow(/JWT_SECRET/);
    expect(() => jwtSecret({ JWT_SECRET: secret })).toThrow(/JWT_SECRET/);
  });

  it('never falls back to a hardcoded secret outside of tests', () => {
    expect(() => jwtSecret({})).toThrow();
  });

  it('uses a test-only secret when running tests without one configured', () => {
    expect(jwtSecret({ NODE_ENV: 'test' })).toBe(TEST_JWT_SECRET);
  });

  it('still prefers a configured secret in tests', () => {
    expect(jwtSecret({ NODE_ENV: 'test', JWT_SECRET: 'integration-test-secret' })).toBe('integration-test-secret');
  });
});

describe('listenHosts', () => {
  // In production the only legitimate client is the Cloudflare tunnel on the
  // same machine — listening on every interface would let anyone on the home
  // network reach the app over plain HTTP, skipping Cloudflare entirely.
  // Both loopbacks, since "localhost" may resolve to either for the tunnel.
  it('only listens on this machine (IPv4 and IPv6 loopback) in production', () => {
    expect(listenHosts({ NODE_ENV: 'production' })).toEqual(['127.0.0.1', '::1']);
  });

  it('can be overridden explicitly with HOST', () => {
    expect(listenHosts({ NODE_ENV: 'production', HOST: '0.0.0.0' })).toEqual(['0.0.0.0']);
  });

  it('listens normally in development', () => {
    expect(listenHosts({ NODE_ENV: 'development' })).toBeUndefined();
  });
});

describe('pushConfig', () => {
  const keys = webpush.generateVAPIDKeys();
  const KEYS = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

  it('is on with both keys and the site\'s https address as the contact', () => {
    expect(pushConfig({ ...KEYS, FRONTEND_URL: 'https://minis.example.com' })).toEqual({
      enabled: true, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'https://minis.example.com',
    });
  });

  it('prefers VAPID_SUBJECT when one is given', () => {
    const config = pushConfig({ ...KEYS, FRONTEND_URL: 'https://minis.example.com', VAPID_SUBJECT: 'mailto:admin@example.com' });
    expect(config).toMatchObject({ enabled: true, subject: 'mailto:admin@example.com' });
  });

  // Push is optional: a Pi whose .env predates it must keep serving the site.
  it('is off, with a reason, when the keys were never generated', () => {
    const config = pushConfig({ FRONTEND_URL: 'https://minis.example.com' });
    expect(config.enabled).toBe(false);
    expect(config).toMatchObject({ reason: expect.stringMatching(/VAPID_PUBLIC_KEY/) });
  });

  it.each([
    ['only one key', { VAPID_PUBLIC_KEY: keys.publicKey }],
    ['a public key that is not a P-256 point', { ...KEYS, VAPID_PUBLIC_KEY: 'bm90LWEta2V5' }],
    ['a private key of the wrong length', { ...KEYS, VAPID_PRIVATE_KEY: 'c2hvcnQ' }],
  ])('is off with %s', (_why, env) => {
    expect(pushConfig({ ...env, FRONTEND_URL: 'https://minis.example.com' }).enabled).toBe(false);
  });

  // Apple refuses pushes whose contact is localhost or plain http, so this
  // says so plainly instead of sending pushes that will all bounce.
  it.each([
    ['the localhost default', { FRONTEND_URL: 'http://localhost:5173' }],
    ['nothing at all', {}],
    ['a subject that is neither mailto: nor https:', { VAPID_SUBJECT: 'admin@example.com' }],
  ])('is off when the contact address is %s', (_why, env) => {
    const config = pushConfig({ ...KEYS, ...env });
    expect(config.enabled).toBe(false);
    expect(config).toMatchObject({ reason: expect.stringMatching(/FRONTEND_URL|VAPID_SUBJECT/) });
  });
});
