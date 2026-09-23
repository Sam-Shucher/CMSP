import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import webpush from 'web-push';
import { RowDataPacket } from 'mysql2';

// The push services are on the internet; what reaches them is checked here.
vi.mock('web-push', async (importOriginal) => {
  const real = await importOriginal<typeof import('web-push')>();
  return { ...real, default: real, sendNotification: vi.fn(async () => ({ statusCode: 201, body: '', headers: {} })) };
});

import { sendNotification } from 'web-push';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { MAX_PUSH_DEVICES } from '../utils/pushSubscription';
import { assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser } from '../test/dbHelpers';
import { authCookie, testSessionId } from '../test/helpers';
import { purgeEndedSessions } from '../db/sessions';

// Phone notifications against the real database: which devices are stored for
// whom, and which of them a notice goes to.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const send = vi.mocked(sendNotification);
const KEYS = webpush.generateVAPIDKeys();

let chicago: number;
let owner: TestUser;
let borrower: TestUser;

function device(name: string) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  };
}

const subscribe = (who: TestUser, name: string) =>
  request(app).post('/api/push/subscriptions').set('Cookie', who.cookie).send(device(name));

async function devicesOf(who: TestUser): Promise<string[]> {
  const [found] = await pool.execute<RowDataPacket[]>(
    'SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id', [who.userId]
  );
  return found.map(row => String(row.endpoint).split('/').pop()!);
}

// A loan request: the owner gets a notice, and so a push.
async function requestMini(): Promise<number> {
  const miniId = await createMini(owner, 'Owlbear');
  await request(app).post('/api/cart').set('Cookie', borrower.cookie).send({ miniId });
  const res = await request(app).post('/api/cart/checkout').set('Cookie', borrower.cookie);
  return res.body.created[0].loanId as number;
}

// What a push carried: the JSON the service worker gets, and the send options.
function sent(call: number) {
  const [target, payload, options] = send.mock.calls[call] as unknown as [{ endpoint: string }, string, { topic?: string; TTL?: number }];
  return { endpoint: target.endpoint.split('/').pop(), payload: JSON.parse(payload) as Record<string, string>, options };
}

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  vi.stubEnv('VAPID_PUBLIC_KEY', KEYS.publicKey);
  vi.stubEnv('VAPID_PRIVATE_KEY', KEYS.privateKey);
  vi.stubEnv('VAPID_SUBJECT', 'mailto:admin@example.com');
  send.mockClear();
  send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  await resetDatabase();
  chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  borrower = await createUser('borrower', chicago);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signing a device up', () => {
  it('stores it once, however often the app re-sends it', async () => {
    await subscribe(owner, 'phone');
    await subscribe(owner, 'phone');

    expect(await devicesOf(owner)).toEqual(['phone']);
  });

  // A shared tablet: whoever signed in last is who it notifies.
  it('moves a device to whoever signs in on it next', async () => {
    await subscribe(owner, 'tablet');
    await subscribe(borrower, 'tablet');

    expect(await devicesOf(owner)).toEqual([]);
    expect(await devicesOf(borrower)).toEqual(['tablet']);
  });

  it(`keeps the newest ${MAX_PUSH_DEVICES} devices per person`, async () => {
    for (let i = 0; i <= MAX_PUSH_DEVICES; i++) await subscribe(owner, `device-${i}`);

    const kept = await devicesOf(owner);
    expect(kept).toHaveLength(MAX_PUSH_DEVICES);
    expect(kept).not.toContain('device-0');
    expect(kept).toContain(`device-${MAX_PUSH_DEVICES}`);
  });

  it('turning it off removes only your own device', async () => {
    await subscribe(owner, 'phone');
    await subscribe(borrower, 'laptop');

    await request(app).delete('/api/push/subscriptions').set('Cookie', owner.cookie).send(device('laptop'));
    expect(await devicesOf(borrower)).toEqual(['laptop']);

    await request(app).delete('/api/push/subscriptions').set('Cookie', owner.cookie).send(device('phone'));
    expect(await devicesOf(owner)).toEqual([]);
  });

  it('"log out everywhere" forgets every device', async () => {
    await subscribe(owner, 'phone');
    await subscribe(owner, 'laptop');

    await request(app).post('/api/auth/logout-all').set('Cookie', owner.cookie);

    expect(await devicesOf(owner)).toEqual([]);
  });

  it('goes with the account when it is deleted', async () => {
    await subscribe(owner, 'phone');

    await pool.execute('DELETE FROM users WHERE id = ?', [owner.userId]);

    const [left] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM push_subscriptions');
    expect(Number(left[0].n)).toBe(0);
  });
});

describe('sending', () => {
  it('sends a notice to the recipient\'s devices, titled with the group', async () => {
    await subscribe(owner, 'owner-phone');
    await subscribe(borrower, 'borrower-phone');

    await requestMini();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const push = sent(0);
    expect(push.endpoint).toBe('owner-phone');
    expect(push.payload).toMatchObject({ title: 'Mini Library · Chicago', url: '/loans' });
    expect(push.payload.body).toMatch(/Owlbear/);
    expect(push.options.TTL).toBeGreaterThan(0);
  });

  it('gives a loan\'s messages one topic, so an unread older one is replaced', async () => {
    const loanId = await requestMini();
    await subscribe(owner, 'owner-phone');

    await request(app).post(`/api/loans/${loanId}/messages`).set('Cookie', borrower.cookie).send({ body: 'Thursday?' });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent(0).payload).toMatchObject({ tag: `loan-${loanId}-messages`, body: expect.stringMatching(/Thursday\?/) });
    expect(sent(0).options.topic).toBe(`loan-${loanId}-messages`);
    expect(sent(0).payload).not.toHaveProperty('topic'); // a header for the push service, not for the phone
  });

  // The phone was wiped, or the app removed: the push service says so, once.
  it('forgets a device the push service says is gone', async () => {
    await subscribe(owner, 'old-phone');
    send.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));

    await requestMini();

    await vi.waitFor(async () => expect(await devicesOf(owner)).toEqual([]));
  });

  it('keeps a device through a failure that may pass', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await subscribe(owner, 'phone');
    send.mockRejectedValueOnce(Object.assign(new Error('Busy'), { statusCode: 503 }));

    await requestMini();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await devicesOf(owner)).toEqual(['phone']);
  });

  it('a failed push never fails the action that caused it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await subscribe(owner, 'phone');
    send.mockRejectedValueOnce(new Error('network down'));

    const loanId = await requestMini();

    expect(loanId).toBeGreaterThan(0);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1)); // settled before the next test resets
  });

  it('sends nothing when push isn\'t set up on the server', async () => {
    await subscribe(owner, 'phone');
    vi.stubEnv('VAPID_PRIVATE_KEY', '');

    await requestMini();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(send).not.toHaveBeenCalled();
  });

  it('"send a test" reaches all of your own devices and nobody else\'s', async () => {
    await subscribe(owner, 'phone');
    await subscribe(owner, 'laptop');
    await subscribe(borrower, 'other');

    const res = await request(app).post('/api/push/test').set('Cookie', owner.cookie);

    expect(res.body).toEqual({ sent: 2 });
    expect(send.mock.calls.map((_c, i) => sent(i).endpoint).sort()).toEqual(['laptop', 'phone']);
  });
});

// A device belongs to the sign-in that turned notifications on. When that
// session ends — expired, idle too long, signed out — the device goes quiet,
// rather than showing someone's loan chatter on a phone or shared computer
// nobody is signed in to any more. Signing in again brings it back.
describe('a device goes quiet when its sign-in ends', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 100));
  const sessionOf = (who: TestUser) => testSessionId(who.userId);

  it.each([
    ['expired', 'UPDATE sessions SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?'],
    ['gone idle', 'UPDATE sessions SET last_seen_at = NOW() - INTERVAL 3 DAY WHERE id = ?'],
    ['been signed out', 'UPDATE sessions SET revoked_at = NOW() WHERE id = ?'],
  ])('gets nothing once that session has %s', async (_why, endSession) => {
    await subscribe(owner, 'owner-phone');
    await pool.execute(endSession, [sessionOf(owner)]);

    await requestMini();
    await settle();

    expect(send).not.toHaveBeenCalled();
  });

  it('comes back when they sign in again on it', async () => {
    await subscribe(owner, 'owner-phone');
    await pool.execute('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [sessionOf(owner)]);

    // A fresh sign-in on the same device; the app re-sends its subscription.
    const fresh = 'f'.repeat(64);
    await pool.execute('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 7 DAY)', [fresh, owner.userId]);
    const again = authCookie({ userId: owner.userId, username: owner.username, collectionId: chicago, sid: fresh });
    await request(app).post('/api/push/subscriptions').set('Cookie', again).send(device('owner-phone'));

    await requestMini();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await devicesOf(owner)).toEqual(['owner-phone']); // the same device, not a second row
  });

  it('keeps one device\'s notices going when a different sign-in of theirs ends', async () => {
    await subscribe(owner, 'owner-phone');
    const laptop = 'e'.repeat(64);
    await pool.execute('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 7 DAY)', [laptop, owner.userId]);
    const onLaptop = authCookie({ userId: owner.userId, username: owner.username, collectionId: chicago, sid: laptop });
    await request(app).post('/api/push/subscriptions').set('Cookie', onLaptop).send(device('owner-laptop'));
    await pool.execute('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [laptop]);

    await requestMini();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent(0).endpoint).toBe('owner-phone');
  });

  it('is forgotten altogether when the ended session is cleared out', async () => {
    await subscribe(owner, 'owner-phone');
    await pool.execute('UPDATE sessions SET revoked_at = NOW() - INTERVAL 2 DAY WHERE id = ?', [sessionOf(owner)]);

    await purgeEndedSessions();

    expect(await devicesOf(owner)).toEqual([]);
  });

  // Rows from before sessions were recorded here have none: they wait for the
  // app's next sign-in to re-send them rather than going to whoever.
  it('sends nothing to a device with no sign-in recorded', async () => {
    await subscribe(owner, 'owner-phone');
    await pool.execute('UPDATE push_subscriptions SET session_id = NULL WHERE user_id = ?', [owner.userId]);

    await requestMini();
    await settle();

    expect(send).not.toHaveBeenCalled();
  });
});
