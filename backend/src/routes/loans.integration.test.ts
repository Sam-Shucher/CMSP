import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from '../test/dbHelpers';

const app = createApp();

let owner: TestUser;
let borrower: TestUser;
let bystander: TestUser;

const WHEN = '2026-10-01T18:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  const chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
  bystander = await createUser('bystander', chicago);
});

// Goes through the real cart + checkout flow, returning the new loan's id.
async function requestMini(who: TestUser, miniId: number): Promise<number> {
  await request(app).post('/api/cart').set('Cookie', who.cookie).send({ miniId });
  const res = await request(app).post('/api/cart/checkout').set('Cookie', who.cookie);
  return res.body.created.find((c: { miniId: number }) => c.miniId === miniId).loanId;
}

function proposeTerms(who: TestUser, loanId: number, body: Record<string, unknown>) {
  return request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', who.cookie).send(body);
}

function act(who: TestUser, loanId: number, action: 'approve' | 'handoff' | 'received' | 'return' | 'cancel' | 'apply-terms-to-all') {
  return request(app).post(`/api/loans/${loanId}/${action}`).set('Cookie', who.cookie);
}

// Borrower proposes when/where/how, owner sets duration, borrower approves.
async function agreeOnTerms(loanId: number, durationDays = 14): Promise<void> {
  await proposeTerms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
  await proposeTerms(owner, loanId, { durationDays });
  await act(borrower, loanId, 'approve');
}

describe('seeing loans', () => {
  it('shows the loan to both borrower and owner, each from their own side', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);

    const asBorrower = await request(app).get('/api/loans').set('Cookie', borrower.cookie);
    expect(asBorrower.body).toMatchObject([{
      id: loanId, miniId, miniName: 'Dire Wolf', role: 'borrower',
      counterpart: { id: owner.userId, username: 'owner' }, stage: 'negotiating',
    }]);

    const asOwner = await request(app).get('/api/loans').set('Cookie', owner.cookie);
    expect(asOwner.body).toMatchObject([{ id: loanId, role: 'owner', counterpart: { id: borrower.userId } }]);
  });

  it('hides it from everyone else in the collection, and returns 404 if they try to touch it', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));

    const list = await request(app).get('/api/loans').set('Cookie', bystander.cookie);
    expect(list.body).toEqual([]);

    expect((await proposeTerms(bystander, loanId, { where: 'My house' })).status).toBe(404);
    expect((await act(bystander, loanId, 'cancel')).status).toBe(404);
  });

  it('returns 404 when acting from a different collection, even as a participant', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const dojo = await createCollection('dojo');
    await pool.execute('INSERT INTO collection_memberships (user_id, collection_id) VALUES (?, ?)', [borrower.userId, dojo]);
    const { authCookie } = await import('../test/helpers');
    const borrowerInDojo = { ...borrower, cookie: authCookie({ userId: borrower.userId, username: 'borrower', role: 'user', collectionId: dojo }) };

    expect((await proposeTerms(borrowerInDojo, loanId, { where: 'Game store' })).status).toBe(404);
  });
});

describe('negotiating terms (two keys)', () => {
  it('lets the borrower propose when/where/how, round-tripping the exact time', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));

    const res = await proposeTerms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person',
      borrowerApproved: false, // duration isn't set yet, so nothing to approve
      stage: 'negotiating',
    });
  });

  it('forbids the borrower from setting the duration', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    expect((await proposeTerms(borrower, loanId, { durationDays: 30 })).status).toBe(403);
  });

  it('only reaches "agreed" once both sides have approved the same complete terms', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await proposeTerms(borrower, loanId, { when: WHEN, where: 'Game store', how: 'In person' });

    const ownerSetsDuration = await proposeTerms(owner, loanId, { durationDays: 14 });
    expect(ownerSetsDuration.body).toMatchObject({ ownerApproved: true, borrowerApproved: false, stage: 'negotiating' });

    const borrowerApproves = await act(borrower, loanId, 'approve');
    expect(borrowerApproves.status).toBe(200);
    expect(borrowerApproves.body).toMatchObject({ ownerApproved: true, borrowerApproved: true, stage: 'agreed' });
  });

  it('un-turns the other key when terms change after agreement', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId);

    const res = await proposeTerms(owner, loanId, { durationDays: 21 });
    expect(res.body).toMatchObject({ durationDays: 21, ownerApproved: true, borrowerApproved: false, stage: 'negotiating' });
  });

  it('refuses to approve incomplete terms', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await proposeTerms(borrower, loanId, { where: 'Game store' });
    expect((await act(owner, loanId, 'approve')).status).toBe(400);
  });

  it('rejects an invalid duration', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    expect((await proposeTerms(owner, loanId, { durationDays: 0 })).status).toBe(400);
  });
});

describe('apply terms to all requests with the same person', () => {
  it('copies the owner\'s terms onto every other open request with that borrower, and only that borrower', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const beholder = await createMini(owner, 'Beholder');
    const dragon = await createMini(owner, 'Dragon');
    const wolfLoan = await requestMini(borrower, wolf);
    const beholderLoan = await requestMini(borrower, beholder);
    const bystanderLoan = await requestMini(bystander, dragon);

    await proposeTerms(owner, wolfLoan, { when: WHEN, where: 'Game store', how: 'In person', durationDays: 10 });

    const res = await act(owner, wolfLoan, 'apply-terms-to-all');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const ownerView = (await request(app).get('/api/loans').set('Cookie', owner.cookie)).body;
    expect(ownerView.find((l: { id: number }) => l.id === beholderLoan)).toMatchObject({
      handoffWhen: WHEN, handoffWhere: 'Game store', handoffHow: 'In person', durationDays: 10,
      ownerApproved: true, borrowerApproved: false,
    });
    expect(ownerView.find((l: { id: number }) => l.id === bystanderLoan)).toMatchObject({
      handoffWhere: null, durationDays: null,
    });
  });

  it('never touches the same borrower\'s requests with a different owner', async () => {
    const secondOwner = await createUser('second-owner', owner.collectionId);
    const wolfLoan = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const otherOwnersLoan = await requestMini(borrower, await createMini(secondOwner, 'Owlbear'));

    await proposeTerms(borrower, wolfLoan, { when: WHEN, where: 'Game store', how: 'In person' });
    const res = await act(borrower, wolfLoan, 'apply-terms-to-all');

    expect(res.body.updated).toBe(0);
    const view = (await request(app).get('/api/loans').set('Cookie', borrower.cookie)).body;
    expect(view.find((l: { id: number }) => l.id === otherOwnersLoan)).toMatchObject({ handoffWhere: null });
  });

  it('refuses with 400 when there are no terms on this request to copy yet', async () => {
    const wolfLoan = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await requestMini(borrower, await createMini(owner, 'Beholder'));

    const res = await act(owner, wolfLoan, 'apply-terms-to-all');
    expect(res.status).toBe(400);
  });

  it('refuses with 409 from a request that is no longer being negotiated', async () => {
    const wolfLoan = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await requestMini(borrower, await createMini(owner, 'Beholder'));
    await proposeTerms(owner, wolfLoan, { where: 'Game store' });
    await act(owner, wolfLoan, 'cancel');

    const res = await act(owner, wolfLoan, 'apply-terms-to-all');
    expect(res.status).toBe(409);
  });

  it('skips the other person\'s requests that already moved past negotiation', async () => {
    const wolfLoan = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const adventuringLoan = await requestMini(borrower, await createMini(owner, 'Beholder'));
    await agreeOnTerms(adventuringLoan, 7);
    await act(owner, adventuringLoan, 'handoff');

    await proposeTerms(owner, wolfLoan, { where: 'Somewhere new', durationDays: 30 });
    const res = await act(owner, wolfLoan, 'apply-terms-to-all');

    expect(res.body.updated).toBe(0);
    const view = (await request(app).get('/api/loans').set('Cookie', owner.cookie)).body;
    expect(view.find((l: { id: number }) => l.id === adventuringLoan)).toMatchObject({ handoffWhere: 'Game store', durationDays: 7 });
  });

  it('never carries a duration across when the borrower applies terms', async () => {
    const wolfLoan = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const beholderLoan = await requestMini(borrower, await createMini(owner, 'Beholder'));
    await proposeTerms(owner, wolfLoan, { durationDays: 10 });
    await proposeTerms(borrower, wolfLoan, { when: WHEN, where: 'Game store', how: 'In person' });

    await act(borrower, wolfLoan, 'apply-terms-to-all');

    const view = (await request(app).get('/api/loans').set('Cookie', borrower.cookie)).body;
    expect(view.find((l: { id: number }) => l.id === beholderLoan)).toMatchObject({
      handoffWhere: 'Game store', durationDays: null,
    });
  });
});

describe('handoff and return', () => {
  it('only lets the owner confirm the handoff, and only once terms are agreed', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);

    expect((await act(owner, loanId, 'handoff')).status).toBe(409); // not agreed yet

    await agreeOnTerms(loanId, 14);
    expect((await act(borrower, loanId, 'handoff')).status).toBe(403);

    const res = await act(owner, loanId, 'handoff');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('adventuring');
    expect(res.body.stage).toBe('adventuring');
    expect(new Date(res.body.dueAt).getTime() - new Date(res.body.handedOffAt).getTime()).toBe(14 * DAY_MS);

    const mini = await request(app).get(`/api/minis/${miniId}`).set('Cookie', bystander.cookie);
    expect(mini.body.status).toBe('adventuring');
  });

  it('lets the owner mark an adventuring mini returned, making it available again', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');

    expect((await act(borrower, loanId, 'return')).status).toBe(403);

    const res = await act(owner, loanId, 'return');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('returned');
    expect(res.body.returnedAt).not.toBeNull();

    const mini = await request(app).get(`/api/minis/${miniId}`).set('Cookie', bystander.cookie);
    expect(mini.body.status).toBe('available');
  });

  it('refuses to mark a loan returned that was never handed off', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    expect((await act(owner, loanId, 'return')).status).toBe(409);
  });

  it('refuses a second handoff or a second return', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');

    expect((await act(owner, loanId, 'handoff')).status).toBe(409);
    await act(owner, loanId, 'return');
    expect((await act(owner, loanId, 'return')).status).toBe(409);
  });

  it('locks the terms once the mini is adventuring', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId, 14);
    await act(owner, loanId, 'handoff');

    expect((await proposeTerms(owner, loanId, { durationDays: 60 })).status).toBe(409);
    expect((await act(borrower, loanId, 'approve')).status).toBe(409);
  });

  it('shows the loan as overdue to both sides once the due date passes, without returning it', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await pool.execute('UPDATE loans SET due_at = ? WHERE id = ?', [new Date(Date.now() - DAY_MS), loanId]);

    for (const who of [owner, borrower]) {
      const view = (await request(app).get('/api/loans').set('Cookie', who.cookie)).body;
      expect(view.find((l: { id: number }) => l.id === loanId)).toMatchObject({ status: 'adventuring', stage: 'overdue' });
    }
    const mini = await request(app).get(`/api/minis/${miniId}`).set('Cookie', bystander.cookie);
    expect(mini.body.status).toBe('adventuring');
  });

  it('lets someone else request the mini once it is back, and lets the owner delete it', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await act(owner, loanId, 'return');

    const nextLoan = await requestMini(bystander, miniId);
    expect(nextLoan).toBeGreaterThan(loanId);

    await act(bystander, nextLoan, 'cancel');
    expect((await request(app).delete(`/api/minis/${miniId}`).set('Cookie', owner.cookie)).status).toBe(200);
  });
});

// Keeping a mini longer, against the real hold line.
describe('extending a loan', () => {
  function extend(who: TestUser, loanId: number, extraDays: number) {
    return request(app).post(`/api/loans/${loanId}/extend`).set('Cookie', who.cookie).send({ extraDays });
  }

  async function lendOut(durationDays = 14): Promise<{ miniId: number; loanId: number }> {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId, durationDays);
    await act(owner, loanId, 'handoff');
    return { miniId, loanId };
  }

  it('moves the due date, measured from the handoff', async () => {
    const { loanId } = await lendOut(14);

    const res = await extend(borrower, loanId, 7);

    expect(res.status).toBe(200);
    expect(res.body.durationDays).toBe(21);
    expect(new Date(res.body.dueAt).getTime() - new Date(res.body.handedOffAt).getTime()).toBe(21 * DAY_MS);
    expect(res.body.stage).toBe('adventuring');
  });

  // The rule the whole feature hangs on: a library won't renew a reserved book.
  it('refuses once somebody is in the hold line, and leaves the due date alone', async () => {
    const { miniId, loanId } = await lendOut(14);
    const before = (await request(app).get('/api/loans').set('Cookie', borrower.cookie)).body[0].dueAt;

    // bystander joins the line for a mini that's out — the real endpoint.
    expect((await request(app).post(`/api/holds/minis/${miniId}`).set('Cookie', bystander.cookie)).status).toBe(201);

    const res = await extend(borrower, loanId, 7);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/waiting in line/i);
    const after = (await request(app).get('/api/loans').set('Cookie', borrower.cookie)).body[0];
    expect(after.dueAt).toBe(before);
    expect(after.durationDays).toBe(14);
  });

  it('can be extended again once that person leaves the line', async () => {
    const { miniId, loanId } = await lendOut(14);
    await request(app).post(`/api/holds/minis/${miniId}`).set('Cookie', bystander.cookie);
    expect((await extend(borrower, loanId, 7)).status).toBe(409);

    await request(app).delete(`/api/holds/minis/${miniId}`).set('Cookie', bystander.cookie);

    expect((await extend(borrower, loanId, 7)).status).toBe(200);
  });

  it('tells both sides how many days are left to give', async () => {
    const { loanId } = await lendOut(80);

    const list = await request(app).get('/api/loans').set('Cookie', borrower.cookie);
    expect(list.body[0]).toMatchObject({ holdsWaiting: 0, extendableDays: 10 });

    expect((await extend(borrower, loanId, 11)).status).toBe(400);
    expect((await extend(borrower, loanId, 10)).status).toBe(200);
    const after = await request(app).get('/api/loans').set('Cookie', owner.cookie);
    expect(after.body[0]).toMatchObject({ durationDays: 90, extendableDays: 0 });
  });

  it('lets the owner extend it as well, and tells the other person', async () => {
    const { loanId } = await lendOut(14);

    expect((await extend(owner, loanId, 3)).status).toBe(200);

    const inbox = await request(app).get('/api/notifications').set('Cookie', borrower.cookie);
    expect(inbox.body.items[0].message).toMatch(/kept Dire Wolf for 3 more days/);
  });

  it('is nobody else\'s business', async () => {
    const { loanId } = await lendOut(14);

    expect((await extend(bystander, loanId, 7)).status).toBe(404);
  });

  it('can\'t be done before the handoff, or after it comes back', async () => {
    const miniId = await createMini(owner, 'Owlbear');
    const loanId = await requestMini(borrower, miniId);
    expect((await extend(borrower, loanId, 7)).status).toBe(409); // still negotiating

    await agreeOnTerms(loanId, 14);
    await act(owner, loanId, 'handoff');
    await act(owner, loanId, 'return');

    expect((await extend(borrower, loanId, 7)).status).toBe(409);
  });

  // An overdue loan that gets more time is no longer overdue, and the hourly
  // sweep should be able to say so again if it runs out a second time.
  it('clears the overdue announcement so a fresh one can be made later', async () => {
    const { loanId } = await lendOut(14);
    await pool.execute(
      'UPDATE loans SET due_at = NOW() - INTERVAL 1 DAY, overdue_notified_at = NOW() WHERE id = ?', [loanId]
    );

    expect((await extend(borrower, loanId, 7)).status).toBe(200);

    const [rows] = await pool.execute<import('mysql2').RowDataPacket[]>(
      'SELECT overdue_notified_at FROM loans WHERE id = ?', [loanId]
    );
    expect(rows[0].overdue_notified_at).toBeNull();
  });
});

describe('the borrower confirming they got it', () => {
  it('the owner\'s handoff starts the loan on its own; the borrower\'s "got it" is recorded for both to see', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId, 14);

    const handoff = await act(owner, loanId, 'handoff');
    expect(handoff.body).toMatchObject({ status: 'adventuring', receivedAt: null });

    const res = await act(borrower, loanId, 'received');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('adventuring');
    expect(res.body.receivedAt).not.toBeNull();
    expect(res.body.dueAt).toBe(handoff.body.dueAt); // the clock doesn't move

    const ownerView = (await request(app).get('/api/loans').set('Cookie', owner.cookie)).body;
    expect(ownerView[0].receivedAt).toBe(res.body.receivedAt);
  });

  it('only the borrower can confirm it, and only while the mini is out with them', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));

    expect((await act(borrower, loanId, 'received')).status).toBe(409); // still negotiating
    await agreeOnTerms(loanId);
    expect((await act(borrower, loanId, 'received')).status).toBe(409); // agreed, not handed off

    await act(owner, loanId, 'handoff');
    expect((await act(owner, loanId, 'received')).status).toBe(403);
    expect((await act(bystander, loanId, 'received')).status).toBe(404);
  });

  it('refuses a second confirmation, and one after the mini is back', async () => {
    const first = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(first);
    await act(owner, first, 'handoff');
    await act(borrower, first, 'received');
    expect((await act(borrower, first, 'received')).status).toBe(409);

    const second = await requestMini(borrower, await createMini(owner, 'Owlbear'));
    await agreeOnTerms(second);
    await act(owner, second, 'handoff');
    await act(owner, second, 'return');
    expect((await act(borrower, second, 'received')).status).toBe(409);
  });
});

describe('cancelling', () => {
  it('lets either side cancel before the handoff, freeing the mini', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);

    const res = await act(borrower, loanId, 'cancel');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const mini = await request(app).get(`/api/minis/${miniId}`).set('Cookie', bystander.cookie);
    expect(mini.body.status).toBe('available');
  });

  it('refuses to cancel once the mini is adventuring', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');

    expect((await act(owner, loanId, 'cancel')).status).toBe(409);
  });

  it('refuses edits to a cancelled loan', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await act(owner, loanId, 'cancel');
    expect((await proposeTerms(borrower, loanId, { where: 'Game store' })).status).toBe(409);
  });

  it('refuses approving, handing off, or cancelling again after a cancel', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId);
    await act(borrower, loanId, 'cancel');

    expect((await act(owner, loanId, 'approve')).status).toBe(409);
    expect((await act(owner, loanId, 'handoff')).status).toBe(409);
    expect((await act(owner, loanId, 'cancel')).status).toBe(409);
  });

  it('records who cancelled', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await act(owner, loanId, 'cancel');

    const [[row]] = await pool.query<import('mysql2').RowDataPacket[]>('SELECT cancelled_by FROM loans WHERE id = ?', [loanId]);
    expect(row.cancelled_by).toBe(owner.userId);
  });

  it('frees the mini for someone else to check out', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await act(owner, loanId, 'cancel');

    expect(await requestMini(bystander, miniId)).toBeGreaterThan(loanId);
  });
});

describe('deleting a mini that is out on loan', () => {
  it('is blocked while a loan is active', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await requestMini(borrower, miniId);

    const res = await request(app).delete(`/api/minis/${miniId}`).set('Cookie', owner.cookie);
    expect(res.status).toBe(409);
  });
});
