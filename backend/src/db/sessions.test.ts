import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every other unit test file swaps this module for an always-valid stand-in
// (see test/unitSetup.ts). This file tests the real thing, with the database
// mocked. The time-based rules are also checked against real MariaDB in
// sessions.integration.test.ts.
vi.unmock('./sessions');

vi.mock('./connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from './connection';
import { createSession, touchSession, revokeSession, revokeAllSessions, revokeOtherSessions, purgeEndedSessions } from './sessions';
import { SESSION_LIFETIME_DAYS, SESSION_IDLE_DAYS } from '../config';

const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execute.mockReset();
});

describe('session settings', () => {
  it('end after 2 days of inactivity, and after 7 days no matter what', () => {
    expect(SESSION_IDLE_DAYS).toBe(2);
    expect(SESSION_LIFETIME_DAYS).toBe(7);
  });
});

describe('createSession', () => {
  it('stores a long random id for the user, expiring after the full lifetime', async () => {
    execute.mockResolvedValueOnce([{}]);

    const id = await createSession(42);

    expect(id).toMatch(/^[0-9a-f]{64}$/); // 256 random bits — unguessable
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sessions'), [id, 42, SESSION_LIFETIME_DAYS]);
  });

  it('never reuses an id', async () => {
    execute.mockResolvedValue([{}]);

    const ids = new Set(await Promise.all(Array.from({ length: 50 }, () => createSession(1))));

    expect(ids.size).toBe(50);
  });
});

describe('touchSession', () => {
  it('is valid only for a session that belongs to the user, is not revoked, not expired, and not idle', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 0, must_change_password: 0 }]]);

    expect(await touchSession('abc', 7)).toEqual({ mustChangePassword: false });
    const [sql, params] = execute.mock.calls[0];
    // The first placeholder is the group (none here) — see the tests below.
    expect(params).toEqual([null, 'abc', 7, SESSION_IDLE_DAYS]);
    expect(sql).toMatch(/user_id = \?/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
    expect(sql).toMatch(/last_seen_at > NOW\(\) - INTERVAL \? DAY/);
  });

  // Read in the same query, so enforcing it costs nothing extra per request.
  it('says when the account is still on a temporary password', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 0, must_change_password: 1 }]]);

    expect(await touchSession('abc', 7)).toEqual({ mustChangePassword: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // Every collection-scoped request needs both answers; asking for them in one
  // query halves the database round trips per API call on the Pi.
  it('reads their place in the group the cookie names, in the same query', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 0, must_change_password: 0, member_of: 5, role: 'admin', show_prices: 0 }]]);

    expect(await touchSession('abc', 7, 5)).toEqual({
      mustChangePassword: false,
      membership: { role: 'admin', showPrices: false },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN collection_memberships/);
    expect(params).toEqual([5, 'abc', 7, SESSION_IDLE_DAYS]);
  });

  // A live session for someone who has since been removed from that group:
  // still signed in, but no longer a member there.
  it('says so when they are not (or no longer) in that group', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 0, must_change_password: 0, member_of: null, role: null, show_prices: null }]]);

    expect(await touchSession('abc', 7, 5)).toEqual({ mustChangePassword: false, membership: null });
  });

  it('is invalid when no such live session exists', async () => {
    execute.mockResolvedValueOnce([[]]);

    expect(await touchSession('abc', 7)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records activity, but at most every few minutes rather than on every request', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 1, must_change_password: 0 }]]).mockResolvedValueOnce([{}]);
    expect(await touchSession('abc', 7)).toEqual({ mustChangePassword: false });
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE sessions SET last_seen_at = NOW()'), ['abc']);

    execute.mockReset().mockResolvedValueOnce([[{ needs_touch: 0, must_change_password: 0 }]]);
    await touchSession('abc', 7);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('ending sessions', () => {
  it('revokes one session', async () => {
    execute.mockResolvedValueOnce([{}]);
    await revokeSession('abc');
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/UPDATE sessions SET revoked_at = NOW\(\) WHERE id = \?/), ['abc']);
  });

  it('revokes every live session a user has', async () => {
    execute.mockResolvedValue([{}]);
    await revokeAllSessions(7);
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/WHERE user_id = \? AND revoked_at IS NULL/), [7]);
  });

  // Signing out everywhere after losing a phone has to stop that phone
  // showing their notifications too.
  it('forgets every device they get phone notifications on', async () => {
    execute.mockResolvedValue([{}]);
    await revokeAllSessions(7);
    expect(execute).toHaveBeenCalledWith('DELETE FROM push_subscriptions WHERE user_id = ?', [7]);
  });

  it('does the same when signing out everywhere else (a password change)', async () => {
    execute.mockResolvedValue([{}]);
    await revokeOtherSessions(7, 'keep-me');
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/AND id <> \?/), [7, 'keep-me']);
    expect(execute).toHaveBeenCalledWith('DELETE FROM push_subscriptions WHERE user_id = ?', [7]);
  });

  it('purges sessions that ended over a day ago and reports how many', async () => {
    execute.mockResolvedValueOnce([{ affectedRows: 3 }]);

    expect(await purgeEndedSessions()).toBe(3);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM sessions'), [SESSION_IDLE_DAYS]);
  });
});
