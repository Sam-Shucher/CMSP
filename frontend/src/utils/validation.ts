import { LIMITS } from '../limits';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const USERNAME_MIN = 4;
const USERNAME_MAX = 32;
// Whitelist-only: letters, numbers, underscore. Anything else (spaces, quotes,
// semicolons, dashes, etc.) is rejected outright, which also blocks the
// characters SQL injection payloads rely on (e.g. "'; DROP TABLE users; --").
// The backend already uses parameterized queries, so this isn't the only
// defense against injection — but it stops garbage usernames before they
// ever reach the server.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

// Passwords allow ANY character — they're only ever hashed, never put into SQL
// or shown on a page. The cap is in bytes because bcrypt (which hashes them)
// silently ignores everything past 72 bytes; longer passwords are refused
// rather than quietly shortened.
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 72;

export function validateUsername(username: string): ValidationResult {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return {
      valid: false,
      error: `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`,
    };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      valid: false,
      error: 'Username can only contain letters, numbers, and underscores',
    };
  }
  return { valid: true };
}

// Same rule the server applies (backend/src/utils/inputs.ts): one @, something
// on each side, a dot in the domain, no spaces or quotes, 255 characters max.
const EMAIL_MAX = 255;
const EMAIL_PATTERN = /^[^\s@'"<>;]+@[^\s@'"<>;]+\.[^\s@'"<>;]+$/;

export function validateEmail(email: string): ValidationResult {
  const trimmed = email.trim();
  if (!trimmed) return { valid: false, error: 'Enter your email address.' };
  if (trimmed.length > EMAIL_MAX || !EMAIL_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Enter an email like name@example.com.' };
  }
  return { valid: true };
}

// Same rule as the server: text made only of spaces and invisible characters
// (zero-width spaces, joiners, direction marks) looks blank, so it is blank.
export function looksBlank(value: string): boolean {
  return value.replace(/[\s\p{Cf}]/gu, '') === '';
}

// Prices are typed as dollars and cents. A comma works as the decimal point too
// ("12,50"), since a number box would silently turn that into 1250.
const MAX_PRICE = LIMITS.price;

export function normalizePrice(value: string): string {
  const trimmed = value.trim();
  return /^\d*,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
}

export function priceProblem(value: string): string | null {
  const price = normalizePrice(value);
  if (!price) return null;
  if (price.startsWith('-')) return 'Price can\'t be negative.';
  if (/^\d*\.\d{3,}$/.test(price)) return 'Use at most 2 decimal places, like 12.50.';
  if (!/^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(price)) return 'Enter a price like 12.50, or leave it blank.';
  if (Number(price) > MAX_PRICE) return `Price must be ${MAX_PRICE} or less.`;
  return null;
}

// A comma-separated tag list, judged the way the server saves it: trimmed,
// lowercased, each once.
export function tagsProblem(value: string): string | null {
  const tagNames = new Set(value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
  if (tagNames.size > LIMITS.tagsPerMini) return `Use ${LIMITS.tagsPerMini} tags or fewer.`;
  if ([...tagNames].some(t => t.length > LIMITS.tag)) return `Keep each tag to ${LIMITS.tag} characters or fewer.`;
  return null;
}

export function validatePassword(password: string): ValidationResult {
  if ([...password].length < PASSWORD_MIN_CHARS) {
    return { valid: false, error: `Password must be at least ${PASSWORD_MIN_CHARS} characters` };
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return { valid: false, error: `Password is too long (${PASSWORD_MAX_BYTES} bytes max — about ${PASSWORD_MAX_BYTES} letters, fewer with emoji)` };
  }
  return { valid: true };
}
