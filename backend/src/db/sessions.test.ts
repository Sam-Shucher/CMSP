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
    execute.mockResolvedValueOnce([[{ needs_touch: 0 }]]);

    expect(await touchSession('abc', 7)).toBe(true);
    const [sql, params] = execute.mock.calls[0];
    expect(params).toEqual(['abc', 7, SESSION_IDLE_DAYS]);
    expect(sql).toMatch(/user_id = \?/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
    expect(sql).toMatch(/last_seen_at > NOW\(\) - INTERVAL \? DAY/);
  });

  it('is invalid when no such live session exists', async () => {
    execute.mockResolvedValueOnce([[]]);

    expect(await touchSession('abc', 7)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records activity, but at most every few minutes rather than on every request', async () => {
    execute.mockResolvedValueOnce([[{ needs_touch: 1 }]]).mockResolvedValueOnce([{}]);
    expect(await touchSession('abc', 7)).toBe(true);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE sessions SET last_seen_at = NOW()'), ['abc']);

    execute.mockReset().mockResolvedValueOnce([[{ needs_touch: 0 }]]);
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
