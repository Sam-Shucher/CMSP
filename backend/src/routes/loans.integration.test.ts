import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { uploadsDir } from '../config';
import { MAX_MESSAGES_PER_LOAN } from '../utils/loanMessages';
import { LOAN_HISTORY_PAGE_SIZE } from './loans';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from '../test/dbHelpers';
import { todayInApp, addDays } from '../utils/appTime';
import { removeMember } from '../services/membership';

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

// Removing someone from their last group deletes their account, but their
// loans stay (migration 022): borrower_id goes NULL and their name is kept on
// the loan. The owner's Loans page must still show it — under that name.
describe('a loan whose borrower has since left for good', () => {
  async function loanWithBorrowerGone(): Promise<number> {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await act(borrower, loanId, 'cancel');
    const removed = await removeMember(borrower.userId, owner.collectionId, owner.userId);
    expect(removed).toMatchObject({ ok: true, accountDeleted: true });
    return loanId;
  }

  it("still shows on the owner's Loans page, under the name they had", async () => {
    const loanId = await loanWithBorrowerGone();

    const res = await request(app).get('/api/loans').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{
      id: loanId, role: 'owner', status: 'cancelled',
      counterpart: { id: null, username: null, displayName: 'borrower display' },
    }]);
  });

  it('still shows when paging back through older history', async () => {
    const older = await loanWithBorrowerGone();
    const newer = await requestMini(bystander, await createMini(owner, 'Beholder'));
    await act(bystander, newer, 'cancel');

    const res = await request(app).get(`/api/loans/history?before=${newer}`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{ id: older, counterpart: { displayName: 'borrower display' } }]);
  });
});

describe('seeing loans a page at a time', () => {
  type Listed = { id: number; status: string };

  // Finished loans straight into the table, in one statement — most share a
  // created_at second, which is when only the id keeps the order stable.
  async function finishedLoans(count: number, miniId: number): Promise<void> {
    const statuses = ['returned', 'cancelled', 'lost', 'critically_wounded'];
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status) VALUES ${Array(count).fill('(?, ?, ?, ?, ?)').join(', ')}`,
      Array.from({ length: count }, (_, i) => [miniId, owner.collectionId, borrower.userId, owner.userId, statuses[i % statuses.length]]).flat()
    );
  }

  it('lists every open loan, but only the latest page of finished ones', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    await finishedLoans(LOAN_HISTORY_PAGE_SIZE + 7, wolf);
    const open = await requestMini(borrower, await createMini(owner, 'Beholder'));

    const res = await request(app).get('/api/loans').set('Cookie', borrower.cookie);

    expect(res.status).toBe(200);
    const listed = res.body as Listed[];
    expect(listed.filter(l => l.id === open)).toHaveLength(1);
    expect(listed.filter(l => l.status !== 'negotiating')).toHaveLength(LOAN_HISTORY_PAGE_SIZE);
  });

  it('pages back through the rest of the history, each loan once, newest first', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const total = LOAN_HISTORY_PAGE_SIZE * 2 + 3;
    await finishedLoans(total, wolf);

    const seen: Listed[] = (await request(app).get('/api/loans').set('Cookie', owner.cookie)).body;
    const pageSizes: number[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await request(app).get(`/api/loans/history?before=${seen.at(-1)!.id}`).set('Cookie', owner.cookie);
      expect(res.status).toBe(200);
      pageSizes.push(res.body.length);
      seen.push(...(res.body as Listed[]));
      if (res.body.length < LOAN_HISTORY_PAGE_SIZE) break;
    }

    expect(pageSizes).toEqual([LOAN_HISTORY_PAGE_SIZE, 3]);
    const [all] = await pool.query<import('mysql2').RowDataPacket[]>(
      'SELECT id FROM loans WHERE collection_id = ? ORDER BY created_at DESC, id DESC', [owner.collectionId]
    );
    expect(seen.map(l => l.id)).toEqual(all.map(row => Number(row.id)));
  });

  it('never pages into an open loan', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    await finishedLoans(3, wolf);
    const open = await requestMini(borrower, await createMini(owner, 'Beholder'));
    await finishedLoans(2, wolf);
    const [[newest]] = await pool.query<import('mysql2').RowDataPacket[]>('SELECT MAX(id) AS id FROM loans');

    const res = await request(app).get(`/api/loans/history?before=${Number(newest.id)}`).set('Cookie', borrower.cookie);

    expect((res.body as Listed[]).map(l => l.id)).not.toContain(open);
    expect(res.body).toHaveLength(4);
  });

  // Carrying on from someone else's loan would say where it sorts — that is,
  // when it was made — and loans are only ever visible to their two people.
  it("gives nothing when carrying on from a loan that isn't yours", async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    // The bystander's own finished loan, older than the others — a cursor
    // that worked would page straight to it.
    await pool.execute(
      "INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status) VALUES (?, ?, ?, ?, 'returned')",
      [wolf, owner.collectionId, bystander.userId, owner.userId]
    );
    await finishedLoans(3, wolf);
    const [[newest]] = await pool.query<import('mysql2').RowDataPacket[]>('SELECT MAX(id) AS id FROM loans');

    const res = await request(app).get(`/api/loans/history?before=${Number(newest.id)}`).set('Cookie', bystander.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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

function returnAs(who: TestUser, loanId: number, outcome?: string) {
  return request(app).post(`/api/loans/${loanId}/return`).set('Cookie', who.cookie).send(outcome ? { outcome } : {});
}

describe('lost and critically wounded outcomes', () => {
  it.each(['lost', 'critically_wounded'])('marking a loan %s hides the mini from browse and notifies the borrower', async (outcome) => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');

    const res = await returnAs(owner, loanId, outcome);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(outcome);
    expect((await request(app).get('/api/minis').set('Cookie', bystander.cookie)).body).toEqual([]);

    const inbox = (await request(app).get('/api/notifications').set('Cookie', borrower.cookie)).body.items;
    expect(inbox[0]).toMatchObject({ type: outcome, message: expect.stringContaining(outcome === 'lost' ? 'lost' : 'critically wounded') });
  });

  it('clears a real hold line and cart entries instead of promoting anyone, when marked lost', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await request(app).post(`/api/holds/minis/${miniId}`).set('Cookie', bystander.cookie);

    await returnAs(owner, loanId, 'lost');

    // Nothing was promoted into a new request for the mini.
    const loans = (await request(app).get('/api/loans').set('Cookie', bystander.cookie)).body;
    expect(loans).toEqual([]);
    expect((await request(app).get('/api/holds').set('Cookie', bystander.cookie)).body.holds).toEqual([]);
  });

  it('reveals the outcome to the owner\'s history, but a bystander still can\'t see the mini at all', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await returnAs(owner, loanId, 'critically_wounded');

    const history = await request(app).get(`/api/minis/${miniId}/history`).set('Cookie', owner.cookie);
    expect(history.status).toBe(200);
    expect(history.body[0]).toMatchObject({ outcome: 'critically_wounded' });

    expect((await request(app).get(`/api/minis/${miniId}`).set('Cookie', bystander.cookie)).status).toBe(200); // GET :id isn't hidden...
    expect((await request(app).get('/api/minis').set('Cookie', bystander.cookie)).body).toEqual([]); // ...but browse is
  });

  it('rejects placing a hold on a critically wounded mini even by direct request', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await returnAs(owner, loanId, 'critically_wounded');

    const res = await request(app).post(`/api/holds/minis/${miniId}`).set('Cookie', bystander.cookie);

    expect(res.status).toBe(409);
  });

  it('lets the owner clear a critically wounded mini back into service', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    await returnAs(owner, loanId, 'critically_wounded');

    const cleared = await request(app).post(`/api/minis/${miniId}/clear-condition`).set('Cookie', owner.cookie);

    expect(cleared.status).toBe(200);
    expect(cleared.body.status).toBe('available');
    expect((await request(app).get('/api/minis').set('Cookie', bystander.cookie)).body).toHaveLength(1);
  });

  it('rejects an admin or owner clearing a mini that has no condition to clear', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');

    const res = await request(app).post(`/api/minis/${miniId}/clear-condition`).set('Cookie', owner.cookie);

    expect(res.status).toBe(409);
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

// Feature 12: a note and a photo at each end, so "the spear was already bent"
// is a fact instead of an argument. Against a real database, because what
// matters is that both sides' records really coexist and survive.
describe('condition reports', () => {
  async function adventuring(): Promise<{ miniId: number; loanId: number }> {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    return { miniId, loanId };
  }

  function record(who: TestUser, loanId: number, phase: string, note: string) {
    return request(app).post(`/api/loans/${loanId}/condition`)
      .set('Cookie', who.cookie)
      .field('phase', phase)
      .field('note', note);
  }

  it('keeps both sides\' accounts of the same handoff side by side', async () => {
    const { loanId } = await adventuring();

    await record(owner, loanId, 'handoff', 'Spear straight, base scuffed');
    const res = await record(borrower, loanId, 'handoff', 'Spear looked bent to me');

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { authorName: string; note: string }) => [r.authorName, r.note])).toEqual([
      ['owner display', 'Spear straight, base scuffed'],
      ['borrower display', 'Spear looked bent to me'],
    ]);
  });

  it('refuses to let the same person rewrite their own account of an end', async () => {
    const { loanId } = await adventuring();
    await record(borrower, loanId, 'handoff', 'Looked fine');

    const second = await record(borrower, loanId, 'handoff', 'Actually it was broken');

    expect(second.status).toBe(409);
    const reports = await request(app).get(`/api/loans/${loanId}/condition`).set('Cookie', borrower.cookie);
    expect(reports.body).toHaveLength(1);
    expect(reports.body[0].note).toBe('Looked fine');
  });

  it('lets the same person record both ends of the same loan', async () => {
    const { loanId } = await adventuring();

    expect((await record(borrower, loanId, 'handoff', 'Fine at pickup')).status).toBe(201);
    expect((await record(borrower, loanId, 'return', 'Still fine going back')).status).toBe(201);
  });

  // The window the whole feature depends on: a claim about the handoff can't
  // be invented once the mini is back and something is wrong with it.
  it('closes the handoff once the loan is over, but leaves the return open', async () => {
    const { loanId } = await adventuring();
    await act(owner, loanId, 'return');

    expect((await record(owner, loanId, 'handoff', 'It was perfect, honest')).status).toBe(409);
    expect((await record(owner, loanId, 'return', 'Came back with a chipped base')).status).toBe(201);
  });

  it('is invisible to anyone else in the collection', async () => {
    const { loanId } = await adventuring();
    await record(owner, loanId, 'handoff', 'Spear straight');

    expect((await request(app).get(`/api/loans/${loanId}/condition`).set('Cookie', bystander.cookie)).status).toBe(404);
    expect((await record(bystander, loanId, 'return', 'Looks broken to me')).status).toBe(404);
  });

  it('counts on the loan itself, and says which ends are still open', async () => {
    const { loanId } = await adventuring();
    await record(owner, loanId, 'handoff', 'Spear straight');

    const loans = await request(app).get('/api/loans').set('Cookie', owner.cookie);
    expect(loans.body[0]).toMatchObject({ conditionReports: 1, openConditionPhases: ['handoff', 'return'] });

    await act(owner, loanId, 'return');
    const after = await request(app).get('/api/loans').set('Cookie', owner.cookie);
    expect(after.body[0].openConditionPhases).toEqual(['return']);
  });

  it('goes with the loan when the mini is deleted', async () => {
    const { miniId, loanId } = await adventuring();
    await record(owner, loanId, 'handoff', 'Spear straight');
    await act(owner, loanId, 'return');

    expect((await request(app).delete(`/api/minis/${miniId}`).set('Cookie', owner.cookie)).status).toBe(200);
    const [left] = await pool.query('SELECT id FROM loan_condition_reports');
    expect(left).toEqual([]);
  });
});

// Condition photos go through the same upload pipeline as a mini's
// (middleware/uploads.ts), so the same promises have to hold here: at most
// three, only real images, and nothing left on disk when the report is refused.
describe('condition report photos', () => {
  // A real (1×1) PNG — uploads are checked to be actual images.
  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
    'hex'
  );
  const onDisk = () => new Set(fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()) : []);
  const newFiles = (before: Set<string>) => [...onDisk()].filter(name => !before.has(name));

  async function adventuring(): Promise<number> {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');
    return loanId;
  }

  function report(who: TestUser, loanId: number, phase: string, photos: { bytes: Buffer; name: string }[], note?: string) {
    let req = request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', who.cookie).field('phase', phase);
    if (note !== undefined) req = req.field('note', note);
    for (const photo of photos) req = req.attach('photos', photo.bytes, { filename: photo.name, contentType: 'image/png' });
    return req;
  }

  async function reportCount(): Promise<number> {
    const [rows] = await pool.query<import('mysql2').RowDataPacket[]>('SELECT COUNT(*) AS n FROM loan_condition_reports');
    return Number(rows[0].n);
  }

  it('saves the photos with the report, under server-chosen names, and they are on disk', async () => {
    const loanId = await adventuring();
    const before = onDisk();

    const res = await report(borrower, loanId, 'handoff', [
      { bytes: PNG_BYTES, name: 'bent spear.png' },
      { bytes: PNG_BYTES, name: 'base.png' },
    ]);

    expect(res.status).toBe(201);
    const photos: string[] = res.body[0].photos;
    expect(photos).toHaveLength(2);
    for (const photo of photos) {
      expect(photo).toMatch(/^\/uploads\/[A-Za-z0-9-]+\.png$/); // never the uploader's filename
    }
    expect(newFiles(before).sort()).toEqual(photos.map(p => p.replace('/uploads/', '')).sort());
  });

  it('takes a photo with no note — a photo alone is a record', async () => {
    const loanId = await adventuring();

    const res = await report(owner, loanId, 'handoff', [{ bytes: PNG_BYTES, name: 'a.png' }]);

    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({ note: null });
    expect(res.body[0].photos).toHaveLength(1);
  });

  it('refuses a fourth photo, records nothing, and keeps none of the files', async () => {
    const loanId = await adventuring();
    const before = onDisk();

    const res = await report(borrower, loanId, 'handoff', ['a', 'b', 'c', 'd'].map(n => ({ bytes: PNG_BYTES, name: `${n}.png` })), 'Four angles');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 3 photos/);
    expect(await reportCount()).toBe(0);
    expect(newFiles(before)).toEqual([]);
  });

  it('refuses a text file renamed .png, records nothing, and keeps none of the files', async () => {
    const loanId = await adventuring();
    const before = onDisk();

    const res = await report(borrower, loanId, 'handoff', [
      { bytes: PNG_BYTES, name: 'real.png' },
      { bytes: Buffer.from('definitely a photo'), name: 'notes.png' },
    ], 'Looked fine');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notes\.png/);
    expect(await reportCount()).toBe(0);
    expect(newFiles(before)).toEqual([]);
  });

  it('deletes the photos of a second report on the same end, since that report is refused', async () => {
    const loanId = await adventuring();
    await report(borrower, loanId, 'handoff', [], 'Looked fine');
    const before = onDisk();

    const res = await report(borrower, loanId, 'handoff', [{ bytes: PNG_BYTES, name: 'actually-broken.png' }]);

    expect(res.status).toBe(409);
    expect(newFiles(before)).toEqual([]);
    const [photos] = await pool.query('SELECT id FROM loan_condition_photos');
    expect(photos).toEqual([]);
  });

  it('deletes the photos sent by someone who is not on the loan', async () => {
    const loanId = await adventuring();
    const before = onDisk();

    const res = await report(bystander, loanId, 'return', [{ bytes: PNG_BYTES, name: 'not-mine.png' }]);

    expect(res.status).toBe(404);
    expect(newFiles(before)).toEqual([]);
  });
});

// Feature 16: a message thread per loan, so "running 20 minutes late" stays
// next to what was agreed instead of in a text thread. Against a real
// database, because what matters is who can see it and what "seen" means.
describe('loan messages', () => {
  function say(who: TestUser, loanId: number, body: string) {
    return request(app).post(`/api/loans/${loanId}/messages`).set('Cookie', who.cookie).send({ body });
  }
  function thread(who: TestUser, loanId: number) {
    return request(app).get(`/api/loans/${loanId}/messages`).set('Cookie', who.cookie);
  }
  function markRead(who: TestUser, loanId: number) {
    return request(app).post(`/api/loans/${loanId}/messages/read`).set('Cookie', who.cookie);
  }
  async function loanAs(who: TestUser, loanId: number) {
    const loans = await request(app).get('/api/loans').set('Cookie', who.cookie);
    return (loans.body as { id: number; messageCount: number; unreadMessages: number; messagesOpen: boolean }[])
      .find(loan => loan.id === loanId)!;
  }

  it('keeps both sides\' messages in the order they were sent, each seen from its reader\'s side', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));

    await say(borrower, loanId, 'Can we do Thursday?');
    await say(owner, loanId, 'Thursday works — front door, ring twice');
    const res = await say(borrower, loanId, 'Running 20 minutes late');

    expect(res.status).toBe(201);
    expect(res.body.map((m: { body: string; mine: boolean }) => [m.body, m.mine])).toEqual([
      ['Can we do Thursday?', true],
      ['Thursday works — front door, ring twice', false],
      ['Running 20 minutes late', true],
    ]);
    const asOwner = await thread(owner, loanId);
    expect(asOwner.body.map((m: { authorName: string; mine: boolean }) => [m.authorName, m.mine])).toEqual([
      ['borrower display', false],
      ['owner display', true],
      ['borrower display', false],
    ]);
  });

  it('is invisible to anyone else in the collection, and they can\'t post to it', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await say(borrower, loanId, 'Front door?');

    expect((await thread(bystander, loanId)).status).toBe(404);
    expect((await say(bystander, loanId, 'Can I have it after?')).status).toBe(404);
    expect((await markRead(bystander, loanId)).status).toBe(404);
    expect((await thread(borrower, loanId)).body).toHaveLength(1);
  });

  it('counts unread messages for the reader only, until they open the thread', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await say(borrower, loanId, 'Can we do Thursday?');
    await say(borrower, loanId, 'Or Friday');

    expect(await loanAs(owner, loanId)).toMatchObject({ messageCount: 2, unreadMessages: 2, messagesOpen: true });
    expect(await loanAs(borrower, loanId)).toMatchObject({ messageCount: 2, unreadMessages: 0 });

    // Reading the thread alone changes nothing; saying you've seen it does.
    await thread(owner, loanId);
    expect((await loanAs(owner, loanId)).unreadMessages).toBe(2);

    expect((await markRead(owner, loanId)).body).toEqual({ read: 2 });
    expect((await loanAs(owner, loanId)).unreadMessages).toBe(0);
  });

  it('shows the sender when the other side has seen their message', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await say(borrower, loanId, 'Can we do Thursday?');
    expect((await thread(borrower, loanId)).body[0].read).toBe(false);

    // Marking your OWN messages read is not a thing — only the reader can.
    await markRead(borrower, loanId);
    expect((await thread(borrower, loanId)).body[0].read).toBe(false);

    await markRead(owner, loanId);
    expect((await thread(borrower, loanId)).body[0].read).toBe(true);
  });

  it('stays open through the handoff, then keeps the record but takes nothing new', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await say(borrower, loanId, 'See you at the store');
    await agreeOnTerms(loanId);
    await act(owner, loanId, 'handoff');

    expect((await say(borrower, loanId, 'Got it, thanks!')).status).toBe(201);

    await act(owner, loanId, 'return');
    const late = await say(borrower, loanId, 'One more thing');

    expect(late.status).toBe(409);
    expect((await thread(owner, loanId)).body.map((m: { body: string }) => m.body)).toEqual(['See you at the store', 'Got it, thanks!']);
    expect(await loanAs(owner, loanId)).toMatchObject({ messageCount: 2, messagesOpen: false });
  });

  it('closes when a request is cancelled', async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    await act(owner, loanId, 'cancel');

    expect((await say(borrower, loanId, 'Why?')).status).toBe(409);
  });

  it('keeps each loan\'s thread to itself', async () => {
    const first = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const second = await requestMini(borrower, await createMini(owner, 'Owlbear'));
    await say(borrower, first, 'About the wolf');

    expect((await thread(borrower, second)).body).toEqual([]);
    expect(await loanAs(owner, second)).toMatchObject({ messageCount: 0, unreadMessages: 0 });
  });

  // The ceiling that stops a stuck client growing one thread without bound —
  // checked through the route, not just utils/loanMessages.ts.
  it(`takes no more than ${MAX_MESSAGES_PER_LOAN} messages on one loan`, async () => {
    const loanId = await requestMini(borrower, await createMini(owner, 'Dire Wolf'));
    const values = Array.from({ length: MAX_MESSAGES_PER_LOAN - 1 }, () => '(?, ?, ?)').join(', ');
    const params = Array.from({ length: MAX_MESSAGES_PER_LOAN - 1 }, (_, i) => [loanId, borrower.userId, `line ${i}`]).flat();
    await pool.execute(`INSERT INTO loan_messages (loan_id, author_id, body) VALUES ${values}`, params);

    expect((await say(owner, loanId, 'The last one there is room for')).status).toBe(201);
    const over = await say(borrower, loanId, 'One too many');

    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(new RegExp(String(MAX_MESSAGES_PER_LOAN)));
    expect((await thread(owner, loanId)).body).toHaveLength(MAX_MESSAGES_PER_LOAN);
  });

  it('goes with the loan when the mini is deleted', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await say(borrower, loanId, 'Changed my mind');
    await act(borrower, loanId, 'cancel');

    expect((await request(app).delete(`/api/minis/${miniId}`).set('Cookie', owner.cookie)).status).toBe(200);
    const [left] = await pool.query('SELECT id FROM loan_messages');
    expect(left).toEqual([]);
  });
});

// Feature 13, where it meets a loan: a booking constrains the calendar, so the
// mini has to be home before someone else's booked window begins.
describe('a booking blocking a loan', () => {
  function day(offset: number): string {
    return addDays(todayInApp(), offset);
  }

  async function bookedBy(who: TestUser, miniId: number, from: number, to: number = from) {
    return request(app).post(`/api/bookings/minis/${miniId}`).set('Cookie', who.cookie)
      .send({ startsOn: day(from), endsOn: day(to) });
  }

  it('refuses a handoff whose loan would still be out on the booked day', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    expect((await bookedBy(bystander, miniId, 7)).status).toBe(201);
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId, 14); // 14 days out, so it runs straight through day 7

    const res = await act(owner, loanId, 'handoff');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bystander display has this booked/i);
  });

  it('allows a handoff that lands back before the booked day', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await bookedBy(bystander, miniId, 20);
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId, 5);

    expect((await act(owner, loanId, 'handoff')).status).toBe(200);
  });

  it('never blocks someone on their own booking', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    await bookedBy(borrower, miniId, 7);
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId, 14);

    expect((await act(owner, loanId, 'handoff')).status).toBe(200);
  });

  it('refuses an extension that would run into the booked days', async () => {
    const miniId = await createMini(owner, 'Dire Wolf');
    const loanId = await requestMini(borrower, miniId);
    await agreeOnTerms(loanId, 5);
    await act(owner, loanId, 'handoff');
    await bookedBy(bystander, miniId, 10);

    const res = await request(app).post(`/api/loans/${loanId}/extend`)
      .set('Cookie', borrower.cookie).send({ extraDays: 14 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has this booked from/i);
  });
});
