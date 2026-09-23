import { describe, it, expect } from 'vitest';
import { parsePushSubscription, parsePushEndpoint, pushNotice, MAX_PUSH_DEVICES } from './pushSubscription';
import { LIMITS } from './inputs';

// What a browser hands over from pushManager.subscribe(): where to send, and
// the keys to encrypt with. The server will make requests to that URL, so it
// is checked as carefully as anything else a visitor sends.

const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'); // 65 bytes, 0x04 first
const AUTH = Buffer.alloc(16, 9).toString('base64url');
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123:APA91b-xyz';

function subscription(overrides: Record<string, unknown> = {}, keys: Record<string, unknown> = {}) {
  return { endpoint: FCM, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH, ...keys }, ...overrides };
}

describe('parsePushSubscription', () => {
  it('accepts what a browser sends', () => {
    expect(parsePushSubscription(subscription())).toEqual({
      ok: true, value: { endpoint: FCM, p256dh: P256DH, auth: AUTH },
    });
  });

  // Every browser's push service, as each one names its endpoints.
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',                      // Chrome, Android
    'https://updates.push.services.mozilla.com/wpush/v2/abc',       // Firefox
    'https://web.push.apple.com/QGx2abc',                           // Safari, iPhone PWA
    'https://wns2-by3p.notify.windows.com/w/?token=abc',            // Edge
  ])('accepts %s', (endpoint) => {
    expect(parsePushSubscription(subscription({ endpoint })).ok).toBe(true);
  });

  // The server POSTs to whatever endpoint is stored. Left open, anyone signed
  // in could have the Pi make requests into the home network or to any site.
  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['this machine', 'https://localhost/fcm/send/abc'],
    ['a home-network address', 'https://192.168.1.1/admin'],
    ['some other site', 'https://example.com/push'],
    ['a look-alike host', 'https://fcm.googleapis.com.example.com/abc'],
    ['a look-alike suffix', 'https://evilpush.apple.com.attacker.net/abc'],
    ['an unusual port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['a username in the URL', 'https://me@fcm.googleapis.com/fcm/send/abc'],
    ['not a URL', 'fcm/send/abc'],
  ])('refuses an endpoint that is %s', (_why, endpoint) => {
    expect(parsePushSubscription(subscription({ endpoint }))).toEqual({ ok: false, error: expect.any(String) });
  });

  it('refuses an endpoint longer than the column', () => {
    const endpoint = `https://fcm.googleapis.com/${'a'.repeat(LIMITS.pushEndpoint)}`;
    expect(parsePushSubscription(subscription({ endpoint })).ok).toBe(false);
  });

  it.each([
    ['a p256dh that is not a P-256 point', { p256dh: Buffer.alloc(65, 7).toString('base64url') }],
    ['a p256dh of the wrong length', { p256dh: AUTH }],
    ['an auth secret of the wrong length', { auth: P256DH }],
    ['keys that are not base64url', { auth: 'not base64!!' }],
    ['a missing key', { auth: undefined }],
    ['a key that is not text', { p256dh: 42 }],
  ])('refuses %s', (_why, keys) => {
    expect(parsePushSubscription(subscription({}, keys)).ok).toBe(false);
  });

  it('accepts keys with base64 padding, stored without it', () => {
    const result = parsePushSubscription(subscription({}, { auth: `${AUTH}==` }));
    expect(result).toMatchObject({ ok: true, value: { auth: AUTH } });
  });

  it.each([undefined, null, 'text', 42, [], { endpoint: FCM }])('refuses %j', (value) => {
    expect(parsePushSubscription(value).ok).toBe(false);
  });
});

describe('parsePushEndpoint', () => {
  it('accepts a push service URL', () => {
    expect(parsePushEndpoint(FCM)).toEqual({ ok: true, value: FCM });
  });

  it.each([undefined, 42, '', 'https://example.com/push'])('refuses %j', (value) => {
    expect(parsePushEndpoint(value).ok).toBe(false);
  });
});

describe('pushNotice', () => {
  const notice = { type: 'returned' as const, message: 'Alex returned Owlbear.', loanId: 7 };

  it('names the group, so someone in two groups knows which one it is about', () => {
    expect(pushNotice(notice, 'Chicago')).toEqual({
      title: 'Mini Library · Chicago', body: 'Alex returned Owlbear.', url: '/loans',
    });
  });

  it('falls back to the app name when the group has none', () => {
    expect(pushNotice(notice, null).title).toBe('Mini Library');
  });

  // The bell keeps one entry per conversation; the phone does the same, and
  // the push service can drop an undelivered older one for the newer.
  it('gives a loan\'s messages one shared tag and topic', () => {
    const result = pushNotice({ type: 'loan_message', message: 'Alex: running late', loanId: 12 }, 'Chicago');
    expect(result.tag).toBe('loan-12-messages');
    expect(result.topic).toBe('loan-12-messages');
  });

  it('leaves everything else untagged, so one notice never hides another', () => {
    expect(pushNotice(notice, 'Chicago').tag).toBeUndefined();
    expect(pushNotice({ type: 'loan_message', message: 'x', loanId: null }, 'Chicago').tag).toBeUndefined();
  });
});

describe('MAX_PUSH_DEVICES', () => {
  it('allows a phone, a tablet, and a few browsers, but not without bound', () => {
    expect(MAX_PUSH_DEVICES).toBeGreaterThanOrEqual(5);
    expect(MAX_PUSH_DEVICES).toBeLessThanOrEqual(20);
  });
});
