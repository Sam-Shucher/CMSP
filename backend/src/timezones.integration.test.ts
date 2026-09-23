import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mysql, { RowDataPacket } from 'mysql2/promise';
import { INTEGRATION_ENV } from './test/integrationEnv';

// The database's clock in a timezone far from both the app's process and the
// group's city: UTC+13 (MariaDB's furthest offset), where it is already
// tomorrow in Chicago for most of the day. Everything a person picks as a day
// — a booking, a back-by date — is judged on the group's clock (APP_TIMEZONE),
// handed to SQL as a value rather
// than left to CURDATE(), so none of it should notice. The one thing that
// can't be made independent — the database's NOW() against times this process
// writes — is caught at startup instead (databaseClockSkewMinutes).
// Requires: docker compose -f docker-compose.test.yml up -d

const FAR_ZONE = '+13:00';

async function setDatabaseZone(zone: string): Promise<void> {
  const admin = await mysql.createConnection({
    host: INTEGRATION_ENV.DB_HOST, port: Number(INTEGRATION_ENV.DB_PORT),
    user: INTEGRATION_ENV.DB_USER, password: INTEGRATION_ENV.DB_PASS, database: INTEGRATION_ENV.DB_NAME,
  });
  try {
    await admin.query('SET GLOBAL time_zone = ?', [zone]);
  } finally {
    await admin.end();
  }
}

// Set before anything opens a pooled connection — each new connection takes
// the global zone as its own. Imported afterwards for the same reason.
let pool: typeof import('./db/connection').pool;
let app: ReturnType<typeof import('./app').createApp>;
let helpers: typeof import('./test/dbHelpers');
let bookings: typeof import('./services/bookings');
let appTime: typeof import('./utils/appTime');

beforeAll(async () => {
  await setDatabaseZone(FAR_ZONE);
  ({ pool } = await import('./db/connection'));
  app = (await import('./app')).createApp();
  helpers = await import('./test/dbHelpers');
  bookings = await import('./services/bookings');
  appTime = await import('./utils/appTime');
  await helpers.assertDatabaseReachable();
});

afterAll(async () => {
  // Put the shared test database back first, even if setup failed part-way.
  await setDatabaseZone('SYSTEM');
  await pool?.end();
});

let olivia: import('./test/dbHelpers').TestUser;
let wendy: import('./test/dbHelpers').TestUser;
let chicago: number;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await helpers.resetDatabase();
  chicago = await helpers.createCollection('Chicago');
  olivia = await helpers.createUser('olivia', chicago);
  wendy = await helpers.createUser('wendy', chicago);
});

const today = () => appTime.todayInApp();
const day = (offset: number) => appTime.addDays(today(), offset);

describe('with the database running in another timezone', () => {
  it('is really set up that way — the database\'s NOW() is hours away from ours', async () => {
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT @@session.time_zone AS zone');
    expect(row.zone).toBe(FAR_ZONE);

    const { databaseClockSkewMinutes } = await import('./db/connection');
    expect(await databaseClockSkewMinutes()).toBeGreaterThan(60);
  });

  it('still takes a booking for the group\'s today, and shows it as a day still to come', async () => {
    const miniId = await helpers.createMini(olivia, 'Dire Wolf');

    const res = await request(app).post(`/api/bookings/minis/${miniId}`).set('Cookie', wendy.cookie)
      .send({ startsOn: today(), endsOn: today() });
    expect(res.status).toBe(201);

    const calendar = await request(app).get(`/api/bookings/minis/${miniId}`).set('Cookie', wendy.cookie);
    expect(calendar.body.bookings.map((b: { startsOn: string }) => b.startsOn)).toEqual([today()]);
    expect((await request(app).get('/api/bookings').set('Cookie', wendy.cookie)).body.mine).toHaveLength(1);
  });

  it('refuses the group\'s yesterday, judged on the group\'s calendar', async () => {
    const miniId = await helpers.createMini(olivia, 'Dire Wolf');

    const res = await request(app).post(`/api/bookings/minis/${miniId}`).set('Cookie', wendy.cookie)
      .send({ startsOn: day(-1), endsOn: day(-1) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/);
  });

  it('turns a booking into a request on the group\'s first day, not the database\'s', async () => {
    const miniId = await helpers.createMini(olivia, 'Dire Wolf');
    await bookings.placeBooking(miniId, wendy.userId, chicago, { startsOn: today(), endsOn: today() }, null);

    expect(await bookings.startDueBookings()).toBe(1);
  });

  it('sweeps only bookings whose last day has gone for the group, not for the database', async () => {
    const miniId = await helpers.createMini(olivia, 'Dire Wolf');
    const insert = (from: number, to: number, who: typeof wendy) => pool.execute(
      'INSERT INTO bookings (mini_id, collection_id, user_id, starts_on, ends_on) VALUES (?, ?, ?, ?, ?)',
      [miniId, chicago, who.userId, day(from), day(to)]
    );
    await insert(-3, -1, wendy);  // over for the group: swept
    const theo = await helpers.createUser('theo', chicago);
    // Today for the group — which, for most of the day, a database at UTC+13
    // already calls yesterday. CURDATE() would have swept it: kept.
    await insert(0, 0, theo);

    expect(await bookings.sweepPastBookings()).toBe(1);
    const [left] = await pool.query<RowDataPacket[]>('SELECT user_id FROM bookings');
    expect(left.map(row => row.user_id)).toEqual([theo.userId]);
  });

  it('takes a quest back-by date of the group\'s today', async () => {
    const miniId = await helpers.createMini(olivia, 'Dire Wolf');

    const res = await request(app).post(`/api/minis/${miniId}/take-out`).set('Cookie', olivia.cookie).send({ backBy: today() });

    expect(res.status).toBe(200);
    expect(res.body.on_quest_until).toBe(today());
  });

  it('announces a loan overdue by our clock, and not one that is merely overdue by the database\'s', async () => {
    const { notifyOverdueLoans } = await import('./services/loanEvents');
    const late = await helpers.createMini(olivia, 'Late Wolf');
    const onTime = await helpers.createMini(olivia, 'On-time Owlbear');
    const hour = 60 * 60 * 1000;
    for (const [miniId, dueAt] of [[late, new Date(Date.now() - hour)], [onTime, new Date(Date.now() + hour)]] as const) {
      await pool.execute(
        `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, due_at)
         VALUES (?, ?, ?, ?, 'adventuring', ?, ?)`,
        [miniId, chicago, wendy.userId, olivia.userId, new Date(Date.now() - 7 * 24 * hour), dueAt]
      );
    }

    expect(await notifyOverdueLoans()).toBe(1);
    const [notified] = await pool.query<RowDataPacket[]>('SELECT mini_id FROM loans WHERE overdue_notified_at IS NOT NULL');
    expect(notified.map(row => row.mini_id)).toEqual([late]);
  });

  it('keeps sign-ins working: a session is judged entirely on the database\'s own clock', async () => {
    expect((await request(app).get('/api/auth/me').set('Cookie', wendy.cookie)).status).toBe(200);
  });
});
