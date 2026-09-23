import { Check, LIMITS } from './inputs';
import { NotificationType } from './notificationMessages';

// Web Push: a phone (or browser) that has said yes to notifications gives us
// a subscription — the URL of its push service, plus the keys to encrypt for
// it. services/push.ts sends to it; this file decides what's acceptable and
// what gets sent.

// A phone, a tablet, a laptop and a couple of browsers. Past this the oldest
// is dropped: a device that stopped being used never says so, and nothing
// else would stop the list growing.
export const MAX_PUSH_DEVICES = 10;

// The server makes a request to every stored endpoint, so an endpoint is only
// accepted on a browser vendor's push service. Anything else — localhost, the
// router's admin page, any other site — would let a signed-in member aim the
// Pi's requests wherever they liked.
const PUSH_SERVICES = [
  'fcm.googleapis.com',         // Chrome, Android, Opera, Samsung
  'push.services.mozilla.com',  // Firefox
  'push.apple.com',             // Safari, and home-screen apps on iPhone/iPad
  'notify.windows.com',         // Edge
];

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function parsePushEndpoint(value: unknown): Check<string> {
  const refused = { ok: false as const, error: 'That isn\'t a push address this server sends to' };
  if (typeof value !== 'string' || value.length > LIMITS.pushEndpoint) return refused;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused;
  }
  const knownService = PUSH_SERVICES.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !knownService) return refused;
  return { ok: true, value };
}

// A key as base64url with no padding, if it decodes to `length` bytes.
function key(value: unknown, length: number): string | null {
  if (typeof value !== 'string') return null;
  const unpadded = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(unpadded)) return null;
  const bytes = Buffer.from(unpadded, 'base64url');
  return bytes.length === length ? bytes.toString('base64url') : null;
}

// The shape of PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }.
export function parsePushSubscription(value: unknown): Check<PushSubscriptionInput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Subscription is required' };
  }
  const { endpoint, keys } = value as Record<string, unknown>;
  const where = parsePushEndpoint(endpoint);
  if (!where.ok) return where;

  const given = (typeof keys === 'object' && keys !== null ? keys : {}) as Record<string, unknown>;
  const p256dh = key(given.p256dh, 65); // an uncompressed P-256 public key
  const auth = key(given.auth, 16);
  if (!p256dh || Buffer.from(p256dh, 'base64url')[0] !== 4 || !auth) {
    return { ok: false, error: 'Subscription keys are missing or invalid' };
  }
  return { ok: true, value: { endpoint: where.value, p256dh, auth } };
}

export interface PushNotice {
  title: string;
  body: string;
  url: string;
  tag?: string;   // on the phone: a newer notice with the same tag replaces the older
  topic?: string; // at the push service: same idea, for ones not yet delivered
}

// What the service worker (frontend/public/sw.js) shows. Every notice is
// about a loan or a hold, and the bell sends all of those to the Loans page.
export function pushNotice(
  notice: { type: NotificationType; message: string; loanId?: number | null },
  groupName: string | null
): PushNotice {
  const result: PushNotice = {
    title: groupName ? `Mini Library · ${groupName}` : 'Mini Library',
    body: notice.message,
    url: '/loans',
  };
  // One entry per conversation, the same as the bell (loanEvents.messagePosted).
  if (notice.type === 'loan_message' && notice.loanId) {
    result.tag = result.topic = `loan-${notice.loanId}-messages`;
  }
  return result;
}
