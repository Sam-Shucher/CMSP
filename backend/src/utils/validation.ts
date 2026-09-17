// Server-side copy of the register page's rules (frontend/src/utils/validation.ts).
// The browser check is only a convenience — anyone can call the API directly,
// so the server enforces the same rules before anything reaches the database.
// Keep the two files in sync.

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const USERNAME_MIN = 4;
const USERNAME_MAX = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

// Any character allowed; capped in bytes because bcrypt ignores past 72.
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 72;

export function validateUsername(username: string): ValidationResult {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { valid: false, error: `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters` };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
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
