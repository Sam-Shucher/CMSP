import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));
vi.mock('../services/membership', () => ({
  removeMember: vi.fn(),
}));

import { pool } from '../db/connection';
import { removeMember } from '../services/membership';
import { createApp } from '../app';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const COLLECTION_A = 10;
const COLLECTION_B = 20;

const ADMIN = { userId: 1, username: 'boss', role: 'admin', collectionId: COLLECTION_A };
const ADMIN_OTHER_COLLECTION = { userId: 1, username: 'boss', role: 'admin', collectionId: COLLECTION_B };
const USER = { userId: 2, username: 'grunt', role: 'user', collectionId: COLLECTION_A };

// requireCollectionMembership's lookup — it also returns the member's CURRENT role.
const MEMBERSHIP_CONFIRMED = [[{ role: 'admin' }]];
const MEMBERSHIP_AS_USER = [[{ role: 'user' }]];

beforeEach(() => {
  execute.mockReset();
  vi.mocked(removeMember).mockReset();
});

describe('Collection access control', () => {
  it('rejects a non-admin with 403 even if they are a member of the collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app).get('/api/admin/users').set('Cookie', authCookie(USER));

    expect(res.status).toBe(403);
  });

  it('rejects a demoted admin whose login cookie still says "admin"', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER); // the database says they're a user now

    const res = await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1); // no admin data was read
  });

  it('rejects a user who edited their cookie to say "admin" (only possible with the secret, but still checked)', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie({ ...USER, role: 'admin' }))
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), expect.anything());
  });

  it('rejects an admin who is not a member of their claimed collection with 403', async () => {
    execute.mockResolvedValueOnce([[]]); // no membership row

    const res = await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/approved-emails', () => {
  it('scopes the invite list to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('ae.collection_id = ?'),
      [COLLECTION_A]
    );
  });
});

describe('POST /api/admin/approved-emails', () => {
  it('adds the email scoped to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(ADMIN))
      .send({ email: 'friend@example.com' });

    expect(res.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO approved_emails'),
      ['friend@example.com', COLLECTION_A, ADMIN.userId]
    );
  });

  it('normalizes the email to trimmed lowercase, so it matches at registration', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(ADMIN))
      .send({ email: '  Friend@Example.COM ' });

    expect(res.body.email).toBe('friend@example.com');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO approved_emails'),
      ['friend@example.com', COLLECTION_A, ADMIN.userId]
    );
  });

  it.each([
    ['missing', {}],
    ['blank', { email: '   ' }],
  ])('rejects a %s email with 400', async (_why, body) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN)).send(body);

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // only the membership check
  });

  it.each([
    ['not an email address', { email: 'not-an-email' }],
    ['SQL pretending to be an email', { email: "x'; DROP TABLE approved_emails; --" }],
    ['an object', { email: { $ne: null } }],
    ['longer than the database allows', { email: `${'a'.repeat(250)}@example.com` }],
  ])('rejects an email that is %s with 400', async (_why, body) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).post('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN)).send(body);

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns 409 for an email already on this collection\'s invite list', async () => {
    const duplicate = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValueOnce(duplicate);

    const res = await request(app)
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(ADMIN))
      .send({ email: 'friend@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on this collection/i);
  });

  it('rejects a non-admin with 403 without inserting anything', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app)
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(USER))
      .send({ email: 'friend@example.com' });

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT'), expect.anything());
  });
});

describe('DELETE /api/admin/approved-emails/:id', () => {
  it('deletes an invite row belonging to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .delete('/api/admin/approved-emails/7')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_id'), [7, COLLECTION_A]);
  });

  it('returns 404 for an invite row belonging to a different collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .delete('/api/admin/approved-emails/7')
      .set('Cookie', authCookie(ADMIN_OTHER_COLLECTION));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/users', () => {
  it('only returns members of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('cm.collection_id = ?'),
      [COLLECTION_A]
    );
  });

  it('shows each member\'s role in THIS collection, not a site-wide role', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN));

    const query = String(execute.mock.calls[1][0]);
    expect(query).toMatch(/cm\.role/);
    expect(query).not.toMatch(/u\.role/);
  });
});

describe('PATCH /api/admin/users/:id/role', () => {
  // Roles belong to a membership: being an admin of Chicago says nothing about dojo.
  it('changes the member\'s role in the admin\'s active collection only', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE collection_memberships SET role = ?'),
      ['admin', 2, COLLECTION_A]
    );
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), expect.anything());
  });

  it('returns 404 for a user who is not a member of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'admin' });

    expect(res.status).toBe(404);
  });

  // Also guarantees a collection always keeps at least one admin: whoever
  // demotes someone else is, by definition, still an admin themselves.
  it('refuses to change your own role, so an admin can\'t accidentally lock themselves out', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .patch(`/api/admin/users/${ADMIN.userId}/role`)
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'user' });

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid role value with 400', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .patch('/api/admin/users/2/role')
      .set('Cookie', authCookie(ADMIN))
      .send({ role: 'superadmin' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/users/:id (remove from collection)', () => {
  // What removal does to loans, minis, and holds is covered against the real
  // database in admin.integration.test.ts; these check the route's replies.
  it('removes them from the active collection only', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    vi.mocked(removeMember).mockResolvedValueOnce({ ok: true, accountDeleted: false, minisRemoved: 2 });

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      'Removed from this group — their 2 minis here were archived, and will be permanently deleted in 30 days unless an admin restores them'
    );
    expect(removeMember).toHaveBeenCalledWith(2, COLLECTION_A, ADMIN.userId);
  });

  it('says so when the account was deleted too', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    vi.mocked(removeMember).mockResolvedValueOnce({ ok: true, accountDeleted: true, minisRemoved: 0 });

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.body.message).toMatch(/account was deleted too/);
  });

  it('passes on a refusal, such as a mini still out on loan', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    vi.mocked(removeMember).mockResolvedValueOnce({ ok: false, status: 409, error: 'Grunt has 1 mini out on loan in this group — it needs to be marked returned first' });

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/out on loan/);
  });

  it('returns 404 for a user who is not a member of the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);
    vi.mocked(removeMember).mockResolvedValueOnce({ ok: false, status: 404, error: 'User not found in this collection' });

    const res = await request(app)
      .delete('/api/admin/users/2')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(404);
  });

  it('returns 404 for an id that isn\'t a number, without looking anyone up', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app)
      .delete('/api/admin/users/abc')
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(404);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('blocks removing your own membership from your own active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED); // requireCollectionMembership's own check

    const res = await request(app)
      .delete('/api/admin/users/1') // ADMIN.userId
      .set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // nothing deleted
  });
});

describe('GET /api/admin/audit-log', () => {
  it('scopes the log to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/audit-log').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('collection_id = ?'), [COLLECTION_A]);
  });

  it('returns entries camelCased, newest first as the query already orders them', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{
      id: 1, action: 'member_removed', actor_name: 'Boss', target_name: 'Grunt',
      details: 'Removed Grunt from the group', created_at: '2026-01-01T00:00:00.000Z',
    }]]);

    const res = await request(app).get('/api/admin/audit-log').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: 1, action: 'member_removed', actorName: 'Boss', targetName: 'Grunt',
      details: 'Removed Grunt from the group', createdAt: '2026-01-01T00:00:00.000Z',
    }]);
  });
});

describe('GET /api/admin/archived-minis', () => {
  it('scopes the list to the admin\'s active collection and only archived minis', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/archived-minis').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/m\.collection_id = \?[\s\S]*archived_at IS NOT NULL/),
      [COLLECTION_A]
    );
  });

  it('shows the former owner and days left before it\'s purged', async () => {
    const archivedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{
      id: 42, name: 'Dire Wolf', price: '5.00', owner_id: 2, owner_name: 'Grunt', archived_at: archivedAt,
    }]]);

    const res = await request(app).get('/api/admin/archived-minis').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: 42, name: 'Dire Wolf', price: 5, formerOwnerId: 2, formerOwnerName: 'Grunt', daysLeft: 25,
    });
  });

  it('leaves the price out in a group with prices turned off', async () => {
    execute.mockResolvedValueOnce([[{ role: 'admin', show_prices: 0 }]]).mockResolvedValueOnce([[{
      id: 42, name: 'Dire Wolf', price: '5.00', owner_id: 2, owner_name: 'Grunt', archived_at: new Date(),
    }]]);

    const res = await request(app).get('/api/admin/archived-minis').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body[0].price).toBeNull();
  });
});

describe('PATCH /api/admin/settings', () => {
  it.each([false, true])('sets showPrices to %s for the admin\'s active collection only', async (showPrices) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app).patch('/api/admin/settings').set('Cookie', authCookie(ADMIN)).send({ showPrices });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ showPrices });
    expect(execute).toHaveBeenCalledWith('UPDATE collections SET show_prices = ? WHERE id = ?', [showPrices, COLLECTION_A]);
  });

  it.each([
    ['missing', {}],
    ['a string', { showPrices: 'false' }],
    ['a number', { showPrices: 0 }],
    ['null', { showPrices: null }],
  ])('rejects a showPrices that is %s with 400 and changes nothing', async (_why, body) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED);

    const res = await request(app).patch('/api/admin/settings').set('Cookie', authCookie(ADMIN)).send(body);

    expect(res.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1); // membership only
  });

  it('refuses a member who is not an admin', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app).patch('/api/admin/settings').set('Cookie', authCookie(USER)).send({ showPrices: false });

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/archived-minis/:id/restore', () => {
  it('restores to a current member, clearing its old set (a set is one owner\'s own minis)', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 5, set_id: 9, name: 'Dire Wolf' }]]) // archived mini lookup
      .mockResolvedValueOnce([[{ display_name: 'New Owner' }]])                // newOwnerId is a member
      .mockResolvedValueOnce([{ affectedRows: 1 }])                            // UPDATE minis
      .mockResolvedValueOnce([[{ display_name: 'Boss' }]])                     // actor's own display name
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                           // INSERT INTO audit_log

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), [2, null, 42, COLLECTION_A]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'), expect.arrayContaining(['mini_restored']));
  });

  it('keeps its set when restored to the mini\'s ORIGINAL owner (re-invited during the grace period)', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 5, set_id: 9, name: 'Dire Wolf' }]])
      .mockResolvedValueOnce([[{ display_name: 'Original Owner' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // the set comes back out of the archive too
      .mockResolvedValueOnce([[{ display_name: 'Boss' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 5 }); // same as mini.owner_id

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), [5, 9, 42, COLLECTION_A]);
    expect(execute).toHaveBeenCalledWith('UPDATE sets SET archived_at = NULL WHERE id = ?', [9]);
  });

  it('returns 404 for a mini that is not archived (or does not exist)', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(404);
  });

  it('rejects an invalid newOwnerId with 400', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[{ owner_id: 5, set_id: null, name: 'Dire Wolf' }]]);

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 'nope' });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE minis'), expect.anything());
  });

  it('rejects a newOwnerId who isn\'t a member of this collection', async () => {
    execute
      .mockResolvedValueOnce(MEMBERSHIP_CONFIRMED)
      .mockResolvedValueOnce([[{ owner_id: 5, set_id: null, name: 'Dire Wolf' }]])
      .mockResolvedValueOnce([[]]); // not a member

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(ADMIN))
      .send({ newOwnerId: 99 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/isn't a member/i);
  });

  it('rejects a non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app)
      .post('/api/admin/archived-minis/42/restore')
      .set('Cookie', authCookie(USER))
      .send({ newOwnerId: 2 });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/loan-incidents', () => {
  it('scopes the tally to the admin\'s active collection', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[]]);

    await request(app).get('/api/admin/loan-incidents').set('Cookie', authCookie(ADMIN));

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/l\.collection_id = \?[\s\S]*status IN \('lost', 'critically_wounded'\)/),
      [COLLECTION_A]
    );
  });

  it('returns each borrower\'s lost and critically-wounded counts, camelCased', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockResolvedValueOnce([[
      { borrower_id: 2, borrower_name: 'Grunt', lost_count: 2, wounded_count: 1 },
    ]]);

    const res = await request(app).get('/api/admin/loan-incidents').set('Cookie', authCookie(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ borrowerId: 2, borrowerName: 'Grunt', lostCount: 2, woundedCount: 1 }]);
  });

  it('rejects a non-admin with 403', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP_AS_USER);

    const res = await request(app).get('/api/admin/loan-incidents').set('Cookie', authCookie(USER));

    expect(res.status).toBe(403);
  });
});

describe('Requests with no login at all', () => {
  it('returns 401 before touching the database', async () => {
    const res = await request(app).get('/api/admin/users');

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('database failures', () => {
  it.each([
    ['GET approved-emails', () => request(app).get('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN))],
    ['POST approved-emails', () => request(app).post('/api/admin/approved-emails').set('Cookie', authCookie(ADMIN)).send({ email: 'friend@example.com' })],
    ['DELETE approved-emails/:id', () => request(app).delete('/api/admin/approved-emails/7').set('Cookie', authCookie(ADMIN))],
    ['GET users', () => request(app).get('/api/admin/users').set('Cookie', authCookie(ADMIN))],
    ['PATCH users/:id/role', () => request(app).patch('/api/admin/users/2/role').set('Cookie', authCookie(ADMIN)).send({ role: 'admin' })],
    ['DELETE users/:id', () => request(app).delete('/api/admin/users/2').set('Cookie', authCookie(ADMIN))],
    ['GET audit-log', () => request(app).get('/api/admin/audit-log').set('Cookie', authCookie(ADMIN))],
    ['GET archived-minis', () => request(app).get('/api/admin/archived-minis').set('Cookie', authCookie(ADMIN))],
    ['POST archived-minis/:id/restore', () => request(app).post('/api/admin/archived-minis/42/restore').set('Cookie', authCookie(ADMIN)).send({ newOwnerId: 2 })],
    ['GET loan-incidents', () => request(app).get('/api/admin/loan-incidents').set('Cookie', authCookie(ADMIN))],
  ])('%s returns a generic 500', async (_route, send) => {
    execute.mockResolvedValueOnce(MEMBERSHIP_CONFIRMED).mockRejectedValue(new Error('connection lost'));
    vi.mocked(removeMember).mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Server error' });
  });
});
