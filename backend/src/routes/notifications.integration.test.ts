import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { runHousekeeping } from '../maintenance/housekeeping';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// Loan notifications and the inbox itself, against the real database.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const WHEN = '2026-10-01T18:00:00.000Z';

let chicago: number;
let owner: TestUser;
let borrower: TestUser;
let bystander: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
  bystander = await createUser('bystander', chicago);
});

async function inbox(who: TestUser) {
  return (await request(app).get('/api/notifications').set('Cookie', who.cookie)).body as {
    unread: number;
    items: Array<{ id: number; type: string; message: string; loanId: number | null; miniId: number | null; read: boolean; expiresAt: string | null; createdAt: string }>;
  };
}

async function requestMini(miniName = 'Dire Wolf'): Promise<{ miniId: number; loanId: number }> {
  const miniId = await createMini(owner, miniName);
  await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId });
  const res = await request(app).post('/api/cart/checkout').set('Cookie', borrower.cookie);
  return { miniId, loanId: res.body.created[0].loanId };
}

const terms = (who: TestUser, loanId: number, body: Record<string, unknown>) =>
  request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', who.cookie).send(body);
const act = (who: TestUser, loanId: number, action: string) =>
  request(app).post(`/api/loans/${loanId}/${action}`).set('Cookie', who.cookie);

describe('loan notifications', () => {
  it('tells the owner when someone requests their mini', async () => {
    const { miniId, loanId } = await requestMini();

    const { items, unread } = await inbox(owner);
    expect(unread).toBe(1);
    expect(items[0]).toMatchObject({ type: 'request_created', miniId, loanId, read: false, message: 'borrower display requested Dire Wolf' });
    expect((await inbox(borrower)).items).toEqual([]); // not told about their own action
  });

  it('tells the other side when terms are proposed — but not for an edit that changes nothing', async () => {
    const { loanId } = await requestMini();

    await terms(borrower, loanId, { where: 'Game store' });
    expect((await inbox(owner)).items[0]).toMatchObject({ type: 'terms_proposed', message: 'borrower display proposed new terms for Dire Wolf' });

    await terms(borrower, loanId, { where: 'Game store' });
    expect((await inbox(owner)).items.filter(n => n.type === 'terms_proposed')).toHaveLength(1);

    await terms(owner, loanId, { durationDays: 7 });
    expect((await inbox(borrower)).items[0]).toMatchObject({ type: 'terms_proposed', message: 'owner display proposed new terms for Dire Wolf' });
  });

  it('tells the other side when terms are approved, and says so when you\'re both agreed', async () => {
    const { loanId } = await requestMini();
    await terms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
    await terms(owner, loanId, { durationDays: 7 }); // owner's proposal counts as their approval

    await act(borrower, loanId, 'approve');

    expect((await inbox(owner)).items[0]).toMatchObject({
      type: 'terms_approved', message: 'borrower display approved the terms for Dire Wolf — you\'re both agreed',
    });
  });

  it('tells the other side when a request is cancelled', async () => {
    const { loanId } = await requestMini();

    await act(owner, loanId, 'cancel');

    expect((await inbox(borrower)).items[0]).toMatchObject({ type: 'request_cancelled', message: 'owner display cancelled the request for Dire Wolf' });
  });

  it('tells the borrower when the handoff is confirmed and when the mini is marked returned', async () => {
    const { loanId } = await requestMini();
    await terms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
    await terms(owner, loanId, { durationDays: 7 });
    await act(borrower, loanId, 'approve');

    await act(owner, loanId, 'handoff');
    expect((await inbox(borrower)).items[0]).toMatchObject({
      type: 'handed_off', loanId, message: expect.stringMatching(/^owner display confirmed the handoff — Dire Wolf is adventuring with you until [A-Z][a-z]{2} \d{1,2}$/),
    });

    await act(owner, loanId, 'return');
    expect((await inbox(borrower)).items[0]).toMatchObject({ type: 'returned', message: 'owner display marked Dire Wolf as returned' });
  });

  it('tells the owner when the borrower confirms they got it', async () => {
    const { loanId } = await requestMini();
    await terms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
    await terms(owner, loanId, { durationDays: 7 });
    await act(borrower, loanId, 'approve');
    await act(owner, loanId, 'handoff');
    const borrowerInboxBefore = (await inbox(borrower)).items.length;

    await act(borrower, loanId, 'received');

    expect((await inbox(owner)).items[0]).toMatchObject({ type: 'received', loanId, message: 'borrower display confirmed they got Dire Wolf' });
    expect((await inbox(borrower)).items).toHaveLength(borrowerInboxBefore); // not told about their own action
  });

  it('tells the other side once when terms are applied to several requests', async () => {
    const first = await requestMini('Dire Wolf');
    await requestMini('Owlbear');
    await terms(owner, first.loanId, { where: 'Game store', durationDays: 7 });
    const before = (await inbox(borrower)).items.length;

    await act(owner, first.loanId, 'apply-terms-to-all');

    const items = (await inbox(borrower)).items;
    expect(items.length).toBe(before + 1);
    expect(items[0]).toMatchObject({ type: 'terms_proposed', message: 'owner display updated the terms on 1 other request with you' });
  });

  it('tells both sides once when a loan becomes overdue', async () => {
    const { loanId } = await requestMini();
    await terms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
    await terms(owner, loanId, { durationDays: 7 });
    await act(borrower, loanId, 'approve');
    await act(owner, loanId, 'handoff');
    await pool.execute('UPDATE loans SET due_at = NOW() - INTERVAL 1 HOUR WHERE id = ?', [loanId]);

    await runHousekeeping({ log: () => {} });
    await runHousekeeping({ log: () => {} });

    for (const who of [owner, borrower]) {
      const overdue = (await inbox(who)).items.filter(n => n.type === 'overdue');
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({ loanId, message: 'Dire Wolf is overdue' });
    }
  });
});

describe('the inbox', () => {
  it('shows newest first, only your own, only for the group you\'re in', async () => {
    await requestMini('Dire Wolf');
    await requestMini('Owlbear');
    const dojo = await createCollection('dojo');
    const ownerInDojo = await joinCollection(owner, dojo);
    await pool.execute(
      "INSERT INTO notifications (user_id, collection_id, type, message) VALUES (?, ?, 'hold_placed', 'dojo only')",
      [owner.userId, dojo]
    );

    const chicagoInbox = await inbox(owner);
    expect(chicagoInbox.items.map(n => n.message)).toEqual(['borrower display requested Owlbear', 'borrower display requested Dire Wolf']);
    expect((await inbox(ownerInDojo)).items.map(n => n.message)).toEqual(['dojo only']);
    expect((await inbox(bystander)).items).toEqual([]);
  });

  it('marks one as read', async () => {
    await requestMini();
    const { items } = await inbox(owner);

    const res = await request(app).post(`/api/notifications/${items[0].id}/read`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(await inbox(owner)).toMatchObject({ unread: 0, items: [expect.objectContaining({ read: true })] });
  });

  it('marks all as read', async () => {
    await requestMini('Dire Wolf');
    await requestMini('Owlbear');

    await request(app).post('/api/notifications/read-all').set('Cookie', owner.cookie);

    expect((await inbox(owner)).unread).toBe(0);
  });

  it('can\'t touch someone else\'s notification', async () => {
    await requestMini();
    const { items } = await inbox(owner);

    const res = await request(app).post(`/api/notifications/${items[0].id}/read`).set('Cookie', bystander.cookie);

    expect(res.status).toBe(404);
    expect((await inbox(owner)).unread).toBe(1);
  });

  it('says when a read notification will disappear, and nothing for an unread one', async () => {
    await requestMini('Dire Wolf');
    await requestMini('Owlbear');
    const { items } = await inbox(owner);

    await request(app).post(`/api/notifications/${items[0].id}/read`).set('Cookie', owner.cookie);

    const after = (await inbox(owner)).items;
    const twoDaysOut = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect(new Date(after[0].expiresAt!).getTime()).toBeGreaterThan(twoDaysOut - 60_000);
    expect(new Date(after[0].expiresAt!).getTime()).toBeLessThan(twoDaysOut + 60_000);
    expect(after[1].expiresAt).toBeNull();
  });

  it('puts a notification back to unread, so it stops counting down', async () => {
    await requestMini();
    const { items } = await inbox(owner);
    await request(app).post(`/api/notifications/${items[0].id}/read`).set('Cookie', owner.cookie);

    const res = await request(app).post(`/api/notifications/${items[0].id}/unread`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(await inbox(owner)).toMatchObject({ unread: 1, items: [expect.objectContaining({ read: false, expiresAt: null })] });
  });

  it('dismisses one for good, and only your own', async () => {
    await requestMini('Dire Wolf');
    await requestMini('Owlbear');
    const { items } = await inbox(owner);

    expect((await request(app).delete(`/api/notifications/${items[0].id}`).set('Cookie', bystander.cookie)).status).toBe(404);
    const res = await request(app).delete(`/api/notifications/${items[0].id}`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect((await inbox(owner)).items.map(n => n.message)).toEqual(['borrower display requested Dire Wolf']);
    expect((await request(app).delete(`/api/notifications/${items[0].id}`).set('Cookie', owner.cookie)).status).toBe(404);
  });

  it('hides read notifications once their two days are up, and keeps unread ones however old', async () => {
    await requestMini('Dire Wolf');
    await requestMini('Owlbear');
    const { items } = await inbox(owner);
    await request(app).post(`/api/notifications/${items[0].id}/read`).set('Cookie', owner.cookie);
    await pool.execute('UPDATE notifications SET read_at = NOW() - INTERVAL 3 DAY WHERE id = ?', [items[0].id]);
    await pool.execute('UPDATE notifications SET created_at = NOW() - INTERVAL 30 DAY WHERE id = ?', [items[1].id]);

    expect((await inbox(owner)).items.map(n => n.message)).toEqual(['borrower display requested Dire Wolf']);
  });

  it('refuses ids that aren\'t ids', async () => {
    for (const path of ['/api/notifications/abc/unread', '/api/notifications/-1/unread']) {
      expect((await request(app).post(path).set('Cookie', owner.cookie)).status).toBe(404);
    }
    expect((await request(app).delete('/api/notifications/abc').set('Cookie', owner.cookie)).status).toBe(404);
  });

  it('keeps the list to the 50 most recent', async () => {
    for (let i = 0; i < 55; i++) {
      await pool.execute(
        "INSERT INTO notifications (user_id, collection_id, type, message) VALUES (?, ?, 'hold_placed', ?)",
        [owner.userId, chicago, `n${i}`]
      );
    }

    const { items, unread } = await inbox(owner);

    expect(items).toHaveLength(50);
    expect(items[0].message).toBe('n54');
    expect(unread).toBe(55);
  });
});
