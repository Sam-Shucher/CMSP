import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import { RowDataPacket } from 'mysql2';
import { createApp } from './app';
import { pool } from './db/connection';
import { uploadsDir } from './config';
import { startDueBookings } from './services/bookings';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from './test/dbHelpers';
import { todayInApp, addDays } from './utils/appTime';

// Where features meet. Each feature has its own suite; this one plays out the
// less likely paths where two of them touch the same mini at once — a mini
// given away while someone has days booked on it, lost with a calendar full of
// plans, a form left open while an admin flips a group setting, a second tab
// switching groups halfway through an upload. Every test drives the real HTTP
// routes against the real database, the way two people would.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const WHEN = '2026-10-01T18:00:00.000Z';

// A real (1×1) PNG — uploads are checked to be actual images.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex'
);

function day(offsetDays: number): string {
  return addDays(todayInApp(), offsetDays);
}

let chicago: number;
let dojo: number;
let olivia: TestUser; // owns the minis
let bruno: TestUser;  // borrows
let wendy: TestUser;  // books days
let theo: TestUser;   // another member

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');
  olivia = await createUser('olivia', chicago, 'admin');
  bruno = await createUser('bruno', chicago);
  wendy = await createUser('wendy', chicago);
  theo = await createUser('theo', chicago);
});

// ---- the app's own routes, as each person would use them ----

const post = (who: TestUser, url: string, body: Record<string, unknown> = {}) =>
  request(app).post(url).set('Cookie', who.cookie).send(body);
const get = (who: TestUser, url: string) => request(app).get(url).set('Cookie', who.cookie);

function book(who: TestUser, miniId: number, from: number, to: number = from) {
  return post(who, `/api/bookings/minis/${miniId}`, { startsOn: day(from), endsOn: day(to) });
}

async function requestMini(who: TestUser, miniId: number): Promise<number> {
  await post(who, '/api/cart', { miniId });
  const res = await post(who, '/api/cart/checkout');
  return res.body.created[0].loanId as number;
}

async function handedOff(owner: TestUser, borrower: TestUser, miniId: number, durationDays = 7): Promise<number> {
  const loanId = await requestMini(borrower, miniId);
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', borrower.cookie)
    .send({ when: WHEN, where: 'Shop', how: 'In person' });
  await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', owner.cookie).send({ durationDays });
  await post(borrower, `/api/loans/${loanId}/approve`);
  const handoff = await post(owner, `/api/loans/${loanId}/handoff`);
  expect(handoff.status).toBe(200);
  return loanId;
}

async function inbox(who: TestUser): Promise<{ type: string; message: string }[]> {
  return (await get(who, '/api/notifications')).body.items;
}

async function count(sql: string, params: (string | number)[]): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(sql, params);
  return Number(rows[0].n);
}

const onDisk = () => new Set(fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()) : []);

// ---------------------------------------------------------------------------

describe('giving a mini away while days are booked on it', () => {
  it('drops the new owner\'s own booking, so they are never asked to lend it to themselves', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    expect((await book(wendy, miniId, 0)).status).toBe(201); // today — due to become a request this hour

    const transfer = await post(olivia, `/api/minis/${miniId}/transfer`, { newOwnerId: wendy.userId });
    expect(transfer.status).toBe(200);

    expect(await count('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ? AND user_id = ?', [miniId, wendy.userId])).toBe(0);
    await startDueBookings();
    expect(await count('SELECT COUNT(*) AS n FROM loans WHERE mini_id = ?', [miniId])).toBe(0);
  });

  it('never turns a booking into a request from the owner to themselves, however it got there', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    // A booking by the owner can't be placed through the app — this is the
    // belt to transfer's braces, should one ever exist.
    await pool.execute(
      'INSERT INTO bookings (mini_id, collection_id, user_id, starts_on, ends_on) VALUES (?, ?, ?, ?, ?)',
      [miniId, chicago, olivia.userId, day(0), day(0)]
    );

    expect(await startDueBookings()).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM loans WHERE mini_id = ?', [miniId])).toBe(0);
  });

  it('keeps everyone else\'s bookings, and shows them to the new owner as bookings on their mini', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await book(theo, miniId, 5);

    await post(olivia, `/api/minis/${miniId}/transfer`, { newOwnerId: wendy.userId });

    const asNewOwner = (await get(wendy, '/api/bookings')).body;
    expect(asNewOwner.onMyMinis.map((b: { holderName: string }) => b.holderName)).toEqual(['theo display']);
    expect((await get(olivia, '/api/bookings')).body.onMyMinis).toEqual([]);
    // ...and the new owner, not the old one, now sees who booked it.
    const calendar = (await get(wendy, `/api/bookings/minis/${miniId}`)).body;
    expect(calendar.bookings[0].holderName).toBe('theo display');
  });
});

describe('a mini that goes missing or comes back broken, with days booked on it', () => {
  it.each(['lost', 'critically_wounded'])('marked %s: the bookings go and each booker is told', async (outcome) => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await book(wendy, miniId, 20);
    await book(theo, miniId, 30);
    const loanId = await handedOff(olivia, bruno, miniId);

    const res = await post(olivia, `/api/loans/${loanId}/return`, { outcome });
    expect(res.status).toBe(200);

    expect(await count('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ?', [miniId])).toBe(0);
    for (const booker of [wendy, theo]) {
      expect((await inbox(booker)).map(n => n.type)).toContain('mini_removed');
    }
    // And nobody can claim new days on it while it's flagged.
    expect((await book(wendy, miniId, 40)).status).toBe(409);
  });

  it('can be booked, carted and requested again once the owner clears it', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await handedOff(olivia, bruno, miniId);
    await post(olivia, `/api/loans/${loanId}/return`, { outcome: 'critically_wounded' });

    expect((await post(wendy, '/api/cart', { miniId })).status).toBe(409);
    expect((await post(olivia, `/api/minis/${miniId}/clear-condition`)).status).toBe(200);

    expect((await book(wendy, miniId, 20)).status).toBe(201);
    expect((await post(theo, '/api/cart', { miniId })).status).toBe(201);
    expect((await post(theo, '/api/cart/checkout')).status).toBe(201);
  });

  it('keeps the record of the loan it went wrong on: the return is still open to note, the chat is closed', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await handedOff(olivia, bruno, miniId);
    await post(bruno, `/api/loans/${loanId}/messages`, { body: 'Dropped it, so sorry' });
    await post(olivia, `/api/loans/${loanId}/return`, { outcome: 'critically_wounded' });

    const handoff = await request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', olivia.cookie)
      .field('phase', 'handoff').field('note', 'It was perfect when it left');
    const back = await request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', olivia.cookie)
      .field('phase', 'return').field('note', 'Spear snapped clean off');
    expect(handoff.status).toBe(409);
    expect(back.status).toBe(201);

    expect((await post(bruno, `/api/loans/${loanId}/messages`, { body: 'Can I pay for it?' })).status).toBe(409);
    expect((await get(olivia, `/api/loans/${loanId}/messages`)).body.map((m: { body: string }) => m.body))
      .toEqual(['Dropped it, so sorry']);
  });
});

describe('deleting a mini people have plans for', () => {
  it('tells everyone who booked it, not just the hold line', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await book(wendy, miniId, 10);

    expect((await request(app).delete(`/api/minis/${miniId}`).set('Cookie', olivia.cookie)).status).toBe(200);

    expect((await inbox(wendy)).map(n => n.type)).toContain('mini_removed');
    expect((await get(wendy, '/api/bookings')).body.mine).toEqual([]);
  });
});

describe('a booking that became a request', () => {
  async function started(): Promise<{ miniId: number; loanId: number }> {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await book(wendy, miniId, 0, 2);
    expect(await startDueBookings()).toBe(1);
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT id FROM loans WHERE mini_id = ?', [miniId]);
    return { miniId, loanId: Number(rows[0].id) };
  }

  it('is an ordinary request from there: both sides see it, and can message on it', async () => {
    const { loanId } = await started();

    expect((await get(wendy, '/api/loans')).body[0]).toMatchObject({ id: loanId, role: 'borrower', stage: 'negotiating' });
    expect((await get(olivia, '/api/loans')).body[0]).toMatchObject({ id: loanId, role: 'owner' });
    expect((await post(wendy, `/api/loans/${loanId}/messages`, { body: 'Picking up at 6?' })).status).toBe(201);
    expect((await get(wendy, '/api/bookings')).body.mine[0]).toMatchObject({ started: true, loanId });
  });

  it('isn\'t turned back into a request by the next sweep if the owner cancels it', async () => {
    const { miniId, loanId } = await started();

    expect((await post(olivia, `/api/loans/${loanId}/cancel`)).status).toBe(200);
    await startDueBookings();

    expect(await count("SELECT COUNT(*) AS n FROM loans WHERE mini_id = ? AND status = 'negotiating'", [miniId])).toBe(0);
  });

  it('doesn\'t stand in the way of its own loan, however long the owner agrees to lend it', async () => {
    const { loanId } = await started();
    await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', wendy.cookie)
      .send({ when: WHEN, where: 'Shop', how: 'In person' });
    await request(app).patch(`/api/loans/${loanId}/terms`).set('Cookie', olivia.cookie).send({ durationDays: 30 });
    await post(wendy, `/api/loans/${loanId}/approve`);

    expect((await post(olivia, `/api/loans/${loanId}/handoff`)).status).toBe(200);
  });
});

describe('an edit form left open while an admin switches prices', () => {
  async function pricedMini(price: number): Promise<number> {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await pool.execute('UPDATE minis SET price = ? WHERE id = ?', [price, miniId]);
    return miniId;
  }
  const storedPrice = async (miniId: number) =>
    count('SELECT price AS n FROM minis WHERE id = ?', [miniId]);
  const setPrices = (showPrices: boolean) =>
    request(app).patch('/api/admin/settings').set('Cookie', olivia.cookie).send({ showPrices });

  // The form had no price box (prices were off when it opened), so it sends no
  // price; prices are back on by the time it's saved. That must not read as
  // "set it to 0".
  it('keeps the stored price when a form without a price box is saved after prices come back on', async () => {
    const miniId = await pricedMini(25);
    await setPrices(false);
    await setPrices(true);

    const res = await request(app).patch(`/api/minis/${miniId}`).set('Cookie', olivia.cookie)
      .field('name', 'Dire Wolf, repainted');

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(25);
    expect(await storedPrice(miniId)).toBe(25);
  });

  it('still lets someone clear a price to nothing on purpose', async () => {
    const miniId = await pricedMini(25);

    const res = await request(app).patch(`/api/minis/${miniId}`).set('Cookie', olivia.cookie)
      .field('name', 'Dire Wolf').field('price', '');

    expect(res.status).toBe(200);
    expect(await storedPrice(miniId)).toBe(0);
  });

  it('ignores a price from a form opened before prices went off', async () => {
    const miniId = await pricedMini(25);
    await setPrices(false);

    await request(app).patch(`/api/minis/${miniId}`).set('Cookie', olivia.cookie)
      .field('name', 'Dire Wolf').field('price', '1.00');
    await setPrices(true);

    expect(await storedPrice(miniId)).toBe(25);
  });
});

describe('switching groups in another tab halfway through an upload', () => {
  it('refuses a condition report aimed at the old group, and keeps none of its photos', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await handedOff(olivia, bruno, miniId);
    const brunoInDojo = await joinCollection(bruno, dojo);
    const before = onDisk();

    // The tab still says Chicago; the session has since moved to dojo.
    const res = await request(app).post(`/api/loans/${loanId}/condition`)
      .set('Cookie', brunoInDojo.cookie).set('X-Collection-Id', String(chicago))
      .field('phase', 'handoff').field('note', 'Looked fine')
      .attach('photos', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('group_changed');
    expect(await count('SELECT COUNT(*) AS n FROM loan_condition_reports', [])).toBe(0);
    expect([...onDisk()].filter(name => !before.has(name))).toEqual([]);
  });

  it('refuses a new mini aimed at the old group, and keeps none of its photos', async () => {
    const oliviaInDojo = await joinCollection(olivia, dojo);
    const before = onDisk();

    const res = await request(app).post('/api/minis')
      .set('Cookie', oliviaInDojo.cookie).set('X-Collection-Id', String(chicago))
      .field('name', 'Meant for Chicago')
      .attach('images', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM minis', [])).toBe(0);
    expect([...onDisk()].filter(name => !before.has(name))).toEqual([]);
  });

  it('keeps each group\'s bookings to that group, for someone in both', async () => {
    const chicagoMini = await createMini(olivia, 'Dire Wolf');
    await book(wendy, chicagoMini, 10);
    const wendyInDojo = await joinCollection(wendy, dojo);

    expect((await get(wendyInDojo, '/api/bookings')).body).toEqual({ mine: [], onMyMinis: [] });
    expect((await get(wendyInDojo, `/api/bookings/minis/${chicagoMini}`)).status).toBe(404);
    expect((await book(wendyInDojo, chicagoMini, 20)).status).toBe(404);
  });
});

describe('sets: a change is all or nothing', () => {
  it('keeps the old name when the same request tries to add someone else\'s mini', async () => {
    const mine = await createMini(olivia, 'Dire Wolf');
    const brunos = await createMini(bruno, 'Owlbear');
    const created = await post(olivia, '/api/sets', { name: 'Wolf Pack', miniIds: [mine] });

    const res = await request(app).patch(`/api/sets/${created.body.id}`).set('Cookie', olivia.cookie)
      .send({ name: 'Renamed', addMiniIds: [brunos] });

    expect(res.status).toBe(400);
    const after = await get(olivia, `/api/sets/${created.body.id}`);
    expect(after.body.name).toBe('Wolf Pack');
    expect(after.body.members.map((m: { name: string }) => m.name)).toEqual(['Dire Wolf']);
  });

  it('adds nothing when the same request tries to remove a mini that isn\'t in the set', async () => {
    const first = await createMini(olivia, 'Dire Wolf');
    const second = await createMini(olivia, 'Owlbear');
    const stray = await createMini(olivia, 'Beholder');
    const created = await post(olivia, '/api/sets', { name: 'Wolf Pack', miniIds: [first] });

    const res = await request(app).patch(`/api/sets/${created.body.id}`).set('Cookie', olivia.cookie)
      .send({ addMiniIds: [second], removeMiniIds: [stray] });

    expect(res.status).toBe(400);
    const after = await get(olivia, `/api/sets/${created.body.id}`);
    expect(after.body.members.map((m: { name: string }) => m.name)).toEqual(['Dire Wolf']);
  });

  it('lets a set be borrowed while one of its minis is out, taking only the rest', async () => {
    const first = await createMini(olivia, 'Dire Wolf');
    const second = await createMini(olivia, 'Owlbear');
    const created = await post(olivia, '/api/sets', { name: 'Wolf Pack', miniIds: [first, second] });
    await handedOff(olivia, bruno, first);

    const res = await post(wendy, `/api/sets/${created.body.id}/cart`);

    expect(res.status).toBe(201);
    expect(res.body.added.map((m: { name: string }) => m.name)).toEqual(['Owlbear']);
    expect(res.body.skipped).toEqual([expect.objectContaining({ name: 'Dire Wolf', reason: 'unavailable' })]);
  });
});

// A quest is a loan to yourself: it counts as "out" to anyone booking, and it
// has to be home before anyone's booked days, like any loan.
describe('quests and the calendar', () => {
  it('won\'t let the owner take a mini on a quest over someone\'s booked day', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await book(wendy, miniId, 10);

    const through = await post(olivia, `/api/minis/${miniId}/take-out`, { backBy: day(12) });
    const open = await post(olivia, `/api/minis/${miniId}/take-out`, {});

    expect(through.status).toBe(409);
    expect(through.body.error).toMatch(/wendy display has this booked from .*needs to be back before then/);
    expect(open.status).toBe(409);
    expect(open.body.error).toMatch(/set a back-by date before then/);
    expect((await post(olivia, `/api/minis/${miniId}/take-out`, { backBy: day(9) })).status).toBe(200);
  });

  it('can be booked only from the day after the quest\'s back-by date, and not at all without one', async () => {
    const withDate = await createMini(olivia, 'Dire Wolf');
    const openEnded = await createMini(olivia, 'Owlbear');
    await post(olivia, `/api/minis/${withDate}/take-out`, { backBy: day(5) });
    await post(olivia, `/api/minis/${openEnded}/take-out`, {});

    expect((await book(wendy, withDate, 5)).status).toBe(409);
    expect((await book(wendy, withDate, 6)).status).toBe(201);
    const refused = await book(wendy, openEnded, 30);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/place a hold/);
  });

  // The hold line is how you get a mini that's out; it goes first when it's back.
  it('leaves the hold line as the way to be next for a quest with no end date', async () => {
    const miniId = await createMini(olivia, 'Owlbear');
    await post(olivia, `/api/minis/${miniId}/take-out`, {});

    expect((await post(wendy, `/api/holds/minis/${miniId}`)).status).toBe(201);
    await post(olivia, `/api/minis/${miniId}/bring-back`);

    expect((await get(wendy, '/api/loans')).body[0]).toMatchObject({ miniId, role: 'borrower', stage: 'negotiating' });
  });
});

describe('booking a mini that is out on loan', () => {
  it('refuses its due date and anything before, and takes the day after', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    await handedOff(olivia, bruno, miniId, 7);

    const onDueDay = await book(wendy, miniId, 7);
    expect(onDueDay.status).toBe(409);
    expect(onDueDay.body.error).toMatch(/out on loan until .* earliest you can book it is/);
    expect((await book(wendy, miniId, 8)).status).toBe(201);

    const calendar = (await get(wendy, `/api/bookings/minis/${miniId}`)).body;
    expect(calendar).toMatchObject({ out: { until: day(7), reason: 'loan' }, bookable: true, earliestStart: day(8) });
  });
});

// The note about how it came back closes 12 hours after the loan ends.
describe('the return note after a loan ends', () => {
  it('is open straight after the return, and closed half a day later', async () => {
    const miniId = await createMini(olivia, 'Dire Wolf');
    const loanId = await handedOff(olivia, bruno, miniId);
    await post(olivia, `/api/loans/${loanId}/return`, { outcome: 'returned' });

    expect((await get(olivia, '/api/loans')).body[0].openConditionPhases).toEqual(['return']);
    await pool.execute('UPDATE loans SET returned_at = ? WHERE id = ?', [new Date(Date.now() - 13 * 60 * 60 * 1000), loanId]);

    expect((await get(olivia, '/api/loans')).body[0].openConditionPhases).toEqual([]);
    const late = await request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', olivia.cookie)
      .field('phase', 'return').field('note', 'Found a chip on the shelf');
    expect(late.status).toBe(409);
  });
});

// A removed member's sets go the way their minis do.
describe('a removed member\'s sets', () => {
  it('disappear from the Sets page with their minis, and come back if the minis are restored to them', async () => {
    const theosMini = await createMini(theo, 'Owlbear');
    const created = await post(theo, '/api/sets', { name: 'Theo\'s pack', miniIds: [theosMini] });
    await joinCollection(theo, dojo); // still in another group, so archived rather than deleted

    expect((await request(app).delete(`/api/admin/users/${theo.userId}`).set('Cookie', olivia.cookie)).status).toBe(200);
    expect((await get(bruno, '/api/sets')).body).toEqual([]);
    expect((await get(bruno, `/api/sets/${created.body.id}`)).status).toBe(404);

    // Theo is re-invited during the grace period and gets his mini back.
    await joinCollection(theo, chicago);
    const restored = await post(olivia, `/api/admin/archived-minis/${theosMini}/restore`, { newOwnerId: theo.userId });
    expect(restored.status).toBe(200);

    const sets = (await get(bruno, '/api/sets')).body;
    expect(sets.map((s: { name: string }) => s.name)).toEqual(['Theo\'s pack']);
    expect(sets[0].members.map((m: { name: string }) => m.name)).toEqual(['Owlbear']);
  });

  it('stay gone when the mini is restored to someone else', async () => {
    const theosMini = await createMini(theo, 'Owlbear');
    await post(theo, '/api/sets', { name: 'Theo\'s pack', miniIds: [theosMini] });
    await joinCollection(theo, dojo);
    await request(app).delete(`/api/admin/users/${theo.userId}`).set('Cookie', olivia.cookie);

    await post(olivia, `/api/admin/archived-minis/${theosMini}/restore`, { newOwnerId: wendy.userId });

    expect((await get(bruno, '/api/sets')).body).toEqual([]);
  });
});

// Every newer table has to store the full range of characters — an emoji needs
// four bytes, which a table on MySQL's old three-byte "utf8" refuses with a
// server error. What people type into these is exactly where emoji turn up.
describe('text beyond plain English, in every newer place people type', () => {
  const FANCY = 'Drache 🐉 — «très» bien, 竜, नमस्ते';

  it('comes back exactly as typed from a message, a condition note, a booking note, and a set name', async () => {
    const miniId = await createMini(olivia, FANCY);
    const loanId = await handedOff(olivia, bruno, miniId);

    const message = await post(bruno, `/api/loans/${loanId}/messages`, { body: FANCY });
    const note = await request(app).post(`/api/loans/${loanId}/condition`).set('Cookie', bruno.cookie)
      .field('phase', 'handoff').field('note', FANCY);
    const booked = await post(wendy, `/api/bookings/minis/${miniId}`, { startsOn: day(40), endsOn: day(40), note: FANCY });
    const set = await post(olivia, '/api/sets', { name: FANCY });

    expect([message.status, note.status, booked.status, set.status]).toEqual([201, 201, 201, 201]);
    expect((await get(olivia, `/api/loans/${loanId}/messages`)).body[0].body).toBe(FANCY);
    expect((await get(olivia, `/api/loans/${loanId}/condition`)).body[0].note).toBe(FANCY);
    expect((await get(olivia, `/api/bookings/minis/${miniId}`)).body.bookings[0].note).toBe(FANCY);
    expect((await get(olivia, `/api/sets/${set.body.id}`)).body.name).toBe(FANCY);
    // ...and the bell entry quoting the message.
    expect((await inbox(olivia)).find(n => n.type === 'loan_message')?.message).toContain('🐉');
  });
});

describe('ids that only look like ids', () => {
  // Each would have been read as the real mini's id by Number().
  it.each([
    ['a one-item list', (id: number): unknown => [id]],
    ['a numeric string', (id: number): unknown => String(id)],
    ['a number with a space', (id: number): unknown => ` ${id}`],
  ])('won\'t put a mini in the cart from %s', async (_why, shape) => {
    const miniId = await createMini(olivia, 'Dire Wolf');

    const res = await post(bruno, '/api/cart', { miniId: shape(miniId) });

    expect(res.status).toBe(400);
    expect((await get(bruno, '/api/cart')).body).toEqual([]);
  });
});
