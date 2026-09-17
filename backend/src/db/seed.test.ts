import { describe, it, expect } from 'vitest';
import { assertSeedAllowed } from './seedGuard';

// The seed script creates accounts with published passwords (including an
// admin, password123). Run against the real site's database by mistake, that
// would be an open admin login — so it must refuse.
describe('assertSeedAllowed', () => {
  it('refuses to run in production', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(/production/i);
  });

  it('refuses when NODE_ENV is not set, since the Pi\'s .env might just be missing it', () => {
    expect(() => assertSeedAllowed({})).toThrow();
  });

  it('runs in development', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).not.toThrow();
  });
});
