import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { authCookie, testSessionId } from '../test/helpers';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

// The storing and sending is tested against the real database in
// push.integration.test.ts; here it's only what the routes do with requests.
vi.mock('../services/push', () => ({
  pushPublicKey: vi.fn(() => 'server-public-key'),
  saveSubscription: vi.fn(async () => {}),
  removeSubscription: vi.fn(async () => {}),
  pushTest: vi.fn(async () => 2),
  pushToUsers: vi.fn(async () => 0),
}));

import { createApp } from '../app';
import { pushPublicKey, saveSubscription, removeSubscription, pushTest } from '../services/push';

const app = createApp();
const cookie = authCookie({ userId: 4, username: 'owner', collectionId: 1 });

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const SUBSCRIPTION = {
  endpoint: ENDPOINT,
  expirationTime: null,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
    auth: Buffer.alloc(16, 9).toString('base64url'),
  },
};

beforeEach(() => {
  vi.mocked(pushPublicKey).mockReturnValue('server-public-key');
  vi.mocked(saveSubscription).mockClear();
  vi.mocked(removeSubscription).mockClear();
  vi.mocked(pushTest).mockClear();
});

describe('GET /api/push/key', () => {
  it('gives the key a browser needs to subscribe', async () => {
    const res = await request(app).get('/api/push/key').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'server-public-key' });
  });

  // The Profile page reads this to say "not set up on this server" instead of
  // offering a switch that can't work.
  it('says null when push isn\'t set up here', async () => {
    vi.mocked(pushPublicKey).mockReturnValue(null);

    const res = await request(app).get('/api/push/key').set('Cookie', cookie);

    expect(res.body).toEqual({ publicKey: null });
  });

  it('needs a login', async () => {
    expect((await request(app).get('/api/push/key')).status).toBe(401);
  });
});

describe('POST /api/push/subscriptions', () => {
  // Tied to the sign-in it came from, so it goes quiet when that session ends.
  it('saves this device for the signed-in person, and this sign-in', async () => {
    const res = await request(app).post('/api/push/subscriptions').set('Cookie', cookie).send(SUBSCRIPTION);

    expect(res.status).toBe(200);
    expect(saveSubscription).toHaveBeenCalledWith(4, testSessionId(4), {
      endpoint: ENDPOINT, p256dh: SUBSCRIPTION.keys.p256dh, auth: SUBSCRIPTION.keys.auth,
    });
  });

  // The Pi would make requests to whatever is stored.
  it('refuses an endpoint that isn\'t a browser push service', async () => {
    const res = await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
      .send({ ...SUBSCRIPTION, endpoint: 'https://192.168.1.1/admin' });

    expect(res.status).toBe(400);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('refuses keys that aren\'t keys', async () => {
    const res = await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
      .send({ ...SUBSCRIPTION, keys: { p256dh: 'x', auth: 'y' } });

    expect(res.status).toBe(400);
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it('refuses with 503 when push isn\'t set up here', async () => {
    vi.mocked(pushPublicKey).mockReturnValue(null);

    const res = await request(app).post('/api/push/subscriptions').set('Cookie', cookie).send(SUBSCRIPTION);

    expect(res.status).toBe(503);
    expect(saveSubscription).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/push/subscriptions', () => {
  it('forgets this device, for this person only', async () => {
    const res = await request(app).delete('/api/push/subscriptions').set('Cookie', cookie).send({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(removeSubscription).toHaveBeenCalledWith(4, ENDPOINT);
  });

  // Turning it off must work even after the server's push setup is removed.
  it('works whether or not push is set up here', async () => {
    vi.mocked(pushPublicKey).mockReturnValue(null);

    const res = await request(app).delete('/api/push/subscriptions').set('Cookie', cookie).send({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
  });

  it('refuses something that isn\'t an endpoint', async () => {
    const res = await request(app).delete('/api/push/subscriptions').set('Cookie', cookie).send({ endpoint: ['a'] });

    expect(res.status).toBe(400);
    expect(removeSubscription).not.toHaveBeenCalled();
  });
});

describe('POST /api/push/test', () => {
  it('sends a test to the person\'s own devices and says how many', async () => {
    const res = await request(app).post('/api/push/test').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2 });
    expect(pushTest).toHaveBeenCalledWith(4);
  });

  it('refuses with 503 when push isn\'t set up here', async () => {
    vi.mocked(pushPublicKey).mockReturnValue(null);

    const res = await request(app).post('/api/push/test').set('Cookie', cookie);

    expect(res.status).toBe(503);
    expect(pushTest).not.toHaveBeenCalled();
  });

  // Each one is a real request out to Google/Apple from the Pi.
  it('is rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(app).post('/api/push/test').set('Cookie', cookie)).status;
    }
    expect(last).toBe(429);
  });
});
