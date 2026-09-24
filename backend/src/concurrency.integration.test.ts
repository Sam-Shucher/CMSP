import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { RowDataPacket } from 'mysql2';
import { createApp } from './app';
import { pool } from './db/connection';
import { MAX_MESSAGES_PER_LOAN } from './utils/loanMessages';
import { MAX_DURATION_DAYS } from './utils/loanRules';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from './test/dbHelpers';

// Two people doing the same thing at the same instant — or one person's
// double-click. Each test fires its requests together (Promise.all) against the
// real database and then checks the rule that must hold however they
// interleave: never two loans for one mini, never a thread past its ceiling,
// never a fourth person in a line of three. A rule enforced by "read, then
// write" in two steps is exactly what these catch.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const WHEN = '2026-10-01T18:00:00.000Z';

let chicago: number;
let olivia: TestUser;
let bruno: TestUser;
let wendy: TestUser;
let theo: TestUser;
let nina: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabase();
  chicago = await createCollection('Chicago');
  olivia = await createUser('olivia', chicago);
  bruno = await createUser('bruno', chicago);
  wendy = await createUser('wendy', chicago);
  theo = await createUser('theo', chicago);
  nina = await createUser('nina', chicago);
});

const post = (who: TestUser, url: string, body: Record<string, unknown> = {}) =>
  request(app).post(url).set('Cookie', who.cookie).send(body);

async function count(sql: string, params: (string | number)[]): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(sql, params);
  return Number(rows[0].n);
}

const statuses = (responses: { status: number }[]) => responses.map(r => r.status).sort();

async function requested(who: TestUser, miniId: number): Promise<number> {
  await post(who, '/api/cart', { miniId });
  const res = await post(who, '/api/cart/checkout');
  return res.body.created[0].loanId as number;
}

async function agreed(borrower: TestUser, miniId: number, durationDays = 7): Promise<number> {
  const loanId = await requested(borrower, miniId);
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', borrower.cookie)
    .send({ when: WHEN, where: 'Shop', how: 'In person' });
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', olivia.cookie).send({ durationDays });
  await post(borrower, `/api/loans/${loanId}/approve`);
  return loanId;
}

describe('at the same instant', () => {
  it('two people checking out the same mini: one request, not two', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await post(bruno, '/api/cart', { miniId });
    await post(wendy, '/api/cart', { miniId });

    const results = await Promise.all([post(bruno, '/api/cart/checkout'), post(wendy, '/api/cart/checkout')]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM loans WHERE mini_id = ? AND status = 'negotiating'", [miniId])).toBe(1);
  });

  it('two messages into a thread with room for one: one lands, and the thread stops at its ceiling', async () => {
    const loanId = await requested(bruno, await createMini(olivia, 'Dire Wolf'));
    const values = Array.from({ length: MAX_MESSAGES_PER_LOAN - 1 }, () => '(?, ?, ?)').join(', ');
    const params = Array.from({ length: MAX_MESSAGES_PER_LOAN - 1 }, (_, i) => [loanId, bruno.userId, `line ${i}`]).flat();
    await pool.execute(`INSERT INTO loan_messages (loan_id, author_id, body) VALUES ${values}`, params);

    const results = await Promise.all([
      post(bruno, `/api/loans/${loanId}/messages`, { body: 'From my phone' }),
      post(olivia, `/api/loans/${loanId}/messages`, { body: 'From my laptop' }),
    ]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(await count('SELECT COUNT(*) AS n FROM loan_messages WHERE loan_id = ?', [loanId])).toBe(MAX_MESSAGES_PER_LOAN);
  });

  it('a message and a cancel: the message is either in before the cancel or refused, never after', async () => {
    const loanId = await requested(bruno, await createMini(olivia, 'Dire Wolf'));

    const [message, cancel] = await Promise.all([
      post(bruno, `/api/loans/${loanId}/messages`, { body: 'On my way' }),
      post(olivia, `/api/loans/${loanId}/cancel`),
    ]);

    expect(cancel.status).toBe(200);
    expect([201, 409]).toContain(message.status);
    const [thread] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM loan_messages WHERE loan_id = ?', [loanId]);
    expect(Number(thread[0].n)).toBe(message.status === 201 ? 1 : 0);
  });

  it('a double-clicked condition report: one record, not two', async () => {
    const loanId = await agreed(bruno, await createMini(olivia, 'Dire Wolf'));
    await post(olivia, `/api/loans/${loanId}/handoff`);

    const report = () => request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', bruno.cookie)
      .field('phase', 'handoff').field('note', 'Spear already bent');
    const results = await Promise.all([report(), report()]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(await count('SELECT COUNT(*) AS n FROM loan_condition_reports WHERE loan_id = ?', [loanId])).toBe(1);
  });

  it('a double-clicked handoff: handed over once, with one due date', async () => {
    const loanId = await agreed(bruno, await createMini(olivia, 'Dire Wolf'));

    const results = await Promise.all([post(olivia, `/api/loans/${loanId}/handoff`), post(olivia, `/api/loans/${loanId}/handoff`)]);

    expect(statuses(results)).toEqual([200, 409]);
    const [loan] = await pool.execute<RowDataPacket[]>('SELECT status, handed_off_at, due_at FROM loans WHERE id = ?', [loanId]);
    expect(loan[0].status).toBe('adventuring');
    expect(new Date(loan[0].due_at).getTime() - new Date(loan[0].handed_off_at).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('two people taking the last place in a hold line: the line never grows past three', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await agreed(bruno, miniId);
    await post(olivia, `/api/loans/${loanId}/handoff`);
    await post(wendy, `/api/holds/minis/${miniId}`);
    const extra = await createUser('extra', chicago);
    await post(extra, `/api/holds/minis/${miniId}`);

    const results = await Promise.all([post(theo, `/api/holds/minis/${miniId}`), post(nina, `/api/holds/minis/${miniId}`)]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(await count('SELECT COUNT(*) AS n FROM holds WHERE mini_id = ?', [miniId])).toBe(3);
  });

  it('a transfer and a checkout of the same mini: never a request for a mini that changed hands under it', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await post(bruno, '/api/cart', { miniId });

    const [transfer, checkout] = await Promise.all([
      post(olivia, `/api/minis/${miniId}/transfer`, { newOwnerId: theo.userId }),
      post(bruno, '/api/cart/checkout'),
    ]);

    // Either order is fine — a checkout that waited for the transfer simply
    // becomes a request to the new owner. What must never happen is a request
    // naming someone who no longer owns the mini, or a transfer of a mini
    // that already had a request on it.
    expect(transfer.status === 200 || checkout.status === 201).toBe(true);
    const [mini] = await pool.execute<RowDataPacket[]>('SELECT owner_id FROM minis WHERE id = ?', [miniId]);
    const [loans] = await pool.execute<RowDataPacket[]>('SELECT owner_id, borrower_id FROM loans WHERE mini_id = ?', [miniId]);
    expect(loans.length).toBeLessThanOrEqual(1);
    for (const loan of loans) {
      expect(loan.owner_id).toBe(mini[0].owner_id);
      expect(loan.borrower_id).not.toBe(loan.owner_id);
    }
  });

  it('two extensions at once never take a loan past three months', async () => {
    const loanId = await agreed(bruno, await createMini(olivia, 'Dire Wolf'), 30);
    await post(olivia, `/api/loans/${loanId}/handoff`);

    await Promise.all([
      post(bruno, `/api/loans/${loanId}/extend`, { extraDays: 50 }),
      post(olivia, `/api/loans/${loanId}/extend`, { extraDays: 50 }),
    ]);

    const [loan] = await pool.execute<RowDataPacket[]>('SELECT duration_days FROM loans WHERE id = ?', [loanId]);
    expect(Number(loan[0].duration_days)).toBeLessThanOrEqual(MAX_DURATION_DAYS);
  });

  // The handoff asks "has anyone booked days this loan would run into?" and
  // then starts the loan. A booking landing between the two would leave the
  // mini out on someone's booked day.
  it('a handoff and a booking of days the loan would run into: never both', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await agreed(bruno, miniId, 7);
    const { todayInApp, addDays } = await import('./utils/appTime');
    const day = (n: number) => addDays(todayInApp(), n);

    const [handoff, booking] = await Promise.all([
      post(olivia, `/api/loans/${loanId}/handoff`),
      post(wendy, `/api/bookings/minis/${miniId}`, { startsOn: day(3), endsOn: day(4) }),
    ]);

    expect(handoff.status === 200 && booking.status === 201).toBe(false);
    const [loan] = await pool.execute<RowDataPacket[]>('SELECT status FROM loans WHERE id = ?', [loanId]);
    const booked = await count('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ?', [miniId]);
    expect(loan[0].status === 'adventuring' && booked > 0).toBe(false);
  });

  it('an extension and a booking of the days it would add: never both', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await agreed(bruno, miniId, 7);
    await post(olivia, `/api/loans/${loanId}/handoff`);
    const { todayInApp, addDays } = await import('./utils/appTime');
    const day = (n: number) => addDays(todayInApp(), n);

    const [extension, booking] = await Promise.all([
      post(bruno, `/api/loans/${loanId}/extend`, { extraDays: 10 }),
      post(wendy, `/api/bookings/minis/${miniId}`, { startsOn: day(10), endsOn: day(11) }),
    ]);

    expect(extension.status === 200 && booking.status === 201).toBe(false);
    const [loan] = await pool.execute<RowDataPacket[]>('SELECT duration_days FROM loans WHERE id = ?', [loanId]);
    const booked = await count('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ?', [miniId]);
    expect(Number(loan[0].duration_days) > 7 && booked > 0).toBe(false);
  });

  // Deleting cascades a mini's loans away. A request made in the instant
  // between the delete's check and the delete itself would vanish unnoticed.
  it('a delete and a checkout of the same mini: never a request deleted out from under someone', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await post(bruno, '/api/cart', { miniId });

    const [removal, checkout] = await Promise.all([
      request(app).delete(`/api/minis/${miniId}`).set('Cookie', olivia.cookie),
      post(bruno, '/api/cart/checkout'),
    ]);

    expect(removal.status === 200 && checkout.status === 201).toBe(false);
    const minisLeft = await count('SELECT COUNT(*) AS n FROM minis WHERE id = ?', [miniId]);
    expect(minisLeft).toBe(removal.status === 200 ? 0 : 1);
  });

  it('two people booking overlapping days on the same mini: only one gets them', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const { todayInApp, addDays } = await import('./utils/appTime');
    const day = (n: number) => addDays(todayInApp(), n);

    const results = await Promise.all([
      post(wendy, `/api/bookings/minis/${miniId}`, { startsOn: day(10), endsOn: day(12) }),
      post(theo, `/api/bookings/minis/${miniId}`, { startsOn: day(12), endsOn: day(14) }),
    ]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(await count('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ?', [miniId])).toBe(1);
  });
});
