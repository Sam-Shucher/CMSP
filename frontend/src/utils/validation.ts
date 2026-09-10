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

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 32;
// No special characters allowed for now, per product decision — letters and
// numbers only. Same whitelist reasoning as usernames.
const PASSWORD_PATTERN = /^[a-zA-Z0-9]+$/;

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

export function validatePassword(password: string): ValidationResult {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return {
      valid: false,
      error: `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
    };
  }
  if (!PASSWORD_PATTERN.test(password)) {
    return {
      valid: false,
      error: 'Password can only contain letters and numbers (no special characters for now)',
    };
  }
  return { valid: true };
}
