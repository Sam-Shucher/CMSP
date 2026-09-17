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

export function validatePassword(password: string): ValidationResult {
  if ([...password].length < PASSWORD_MIN_CHARS) {
    return { valid: false, error: `Password must be at least ${PASSWORD_MIN_CHARS} characters` };
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return { valid: false, error: `Password is too long (${PASSWORD_MAX_BYTES} bytes max — about ${PASSWORD_MAX_BYTES} letters, fewer with emoji)` };
  }
  return { valid: true };
}
