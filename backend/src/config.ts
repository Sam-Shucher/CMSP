// Security-sensitive settings, validated in one place.
import path from 'path';

type Env = Record<string, string | undefined>;

// Where uploaded mini photos live. Tests point UPLOADS_DIR at a scratch folder
// so they never write into (or clean up) the real photos.
export function uploadsDir(env: Env = process.env): string {
  // An empty UPLOADS_DIR means "not set", not "the current directory".
  const configured = env.UPLOADS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(path.join(__dirname, '../uploads'));
}

const MIN_SECRET_LENGTH = 32;

// Values that have appeared in this repo at some point — anyone who has read
// the code knows them, so they're no better than no secret at all.
const KNOWN_PLACEHOLDERS = new Set([
  'change-me-in-production',
  'change_this_to_a_long_random_string',
]);

// Only ever used by the test suites, which never talk to the real site.
export const TEST_JWT_SECRET = 'test-only-jwt-secret-never-used-outside-vitest';

// The secret that signs login cookies. Whoever knows it can mint a cookie for
// any user, including an admin — so there is deliberately no fallback: the
// server refuses to start rather than run with a guessable one.
export function jwtSecret(env: Env = process.env): string {
  const secret = env.JWT_SECRET?.trim();

  if (!secret && env.NODE_ENV === 'test') return TEST_JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not set. Add a long random value to backend/.env (e.g. `openssl rand -hex 32`).');
  }
  if (env.NODE_ENV !== 'test') {
    if (KNOWN_PLACEHOLDERS.has(secret)) {
      throw new Error('JWT_SECRET is still a placeholder value. Replace it in backend/.env with `openssl rand -hex 32`.');
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`);
    }
  }
  return secret;
}

// How long a login lasts. A session ends after SESSION_IDLE_DAYS without any
// use, and after SESSION_LIFETIME_DAYS no matter what — whichever comes first.
// Logging out ends it immediately either way.
export const SESSION_IDLE_DAYS = 2;
export const SESSION_LIFETIME_DAYS = 7;

// How long a temporary password from an admin stays usable. Long enough for a
// text message to go unread over a weekend, short enough that an old message
// isn't a permanent key to someone's account.
export const TEMP_PASSWORD_DAYS = 7;

// How long a notification sticks around after it's been read. The bell shows a
// countdown, and the hourly sweep deletes them once it runs out. Marking one
// unread again stops the clock; unread notifications are never removed.
export const NOTIFICATION_KEEP_READ_DAYS = 2;

// How long an archived mini (its owner was removed from the collection, but
// keeps another one) stays recoverable before maintenance/housekeeping.ts
// deletes it for good. See services/membership.ts.
export const MINI_ARCHIVE_GRACE_DAYS = 30;

// The group's own timezone. Everyone using this is in one city, so "today",
// a booking's days, a quest's back-by date and the hours a handoff may happen
// are all read on that city's clock — never the server's, the database's, or
// UTC, which can each be a day off in the evening (utils/appTime.ts).
export const DEFAULT_APP_TIMEZONE = 'America/Chicago';

export function appTimezone(env: Env = process.env): string {
  const zone = env.APP_TIMEZONE?.trim() || DEFAULT_APP_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`APP_TIMEZONE "${zone}" isn't a timezone — use a name like America/Chicago.`);
  }
  return zone;
}

// Web Push (phone notifications). The VAPID key pair identifies this server to
// the browsers' push services; scripts/rpi-update.sh generates one into
// backend/.env the first time it runs without one. The subject is a contact
// address the push services may use — Apple refuses localhost or plain http,
// so it's the site's https address unless VAPID_SUBJECT says otherwise.
//
// Unlike JWT_SECRET, a problem here never stops the server: push is an extra,
// and the site works without it. The reason is logged at startup instead.
export type PushConfig =
  | { enabled: true; publicKey: string; privateKey: string; subject: string }
  | { enabled: false; reason: string };

function base64UrlBytes(value: string): Buffer | null {
  return /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, 'base64url') : null;
}

export function pushConfig(env: Env = process.env): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  if (!publicKey || !privateKey) {
    return { enabled: false, reason: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not both set in backend/.env (scripts/rpi-update.sh generates them)' };
  }
  // An uncompressed P-256 point is 65 bytes starting 0x04; the private key is 32.
  const pub = base64UrlBytes(publicKey);
  const priv = base64UrlBytes(privateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !priv || priv.length !== 32) {
    return { enabled: false, reason: 'VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in backend/.env is not a valid key' };
  }

  const explicit = env.VAPID_SUBJECT?.trim();
  const site = env.FRONTEND_URL?.trim();
  const subject = explicit || (site?.startsWith('https://') ? site : '');
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    return { enabled: false, reason: 'set FRONTEND_URL to the site\'s https:// address (or VAPID_SUBJECT to a mailto: or https:// contact) in backend/.env' };
  }
  return { enabled: true, publicKey, privateKey, subject };
}

// Which network interfaces to listen on (undefined = all). In production only
// the Cloudflare tunnel on this same machine should reach the app — both
// loopback addresses, since "localhost" can resolve to either one.
export function listenHosts(env: Env = process.env): string[] | undefined {
  if (env.HOST) return [env.HOST];
  return env.NODE_ENV === 'production' ? ['127.0.0.1', '::1'] : undefined;
}
