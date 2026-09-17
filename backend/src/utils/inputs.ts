// Shared checks for request input. Every value from a request body or query
// string is untrusted: it may be missing, the wrong type (an array from
// ?q=a&q=b, an object from crafted JSON), or far longer than the database
// column. These turn all of that into a clean 400 message instead of a crash,
// a truncated value, or a CPU-heavy request.

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export const LIMITS = {
  email: 255,
  displayName: 100,
  phone: 20,
  neighborhood: 100,
  miniName: 255,
  description: 5000,
  tag: 50,
  tagsPerMini: 20,
  search: 100,
  password: 1024,
} as const;

// Whitespace plus invisible formatting characters (zero-width spaces, joiners,
// direction marks). Text made only of these looks blank on screen.
const INVISIBLE = /[\s\p{Cf}]/gu;

function looksBlank(value: string): boolean {
  return value.replace(INVISIBLE, '') === '';
}

export function requiredText(value: unknown, label: string, max: number): Check<string> {
  if (typeof value !== 'string' || looksBlank(value)) {
    return { ok: false, error: `${label} is required` };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

export function optionalText(value: unknown, label: string, max: number): Check<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${label} must be text` };
  const trimmed = value.trim();
  if (looksBlank(trimmed)) return { ok: true, value: null };
  if (trimmed.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

// Deliberately simple: one @, something on each side, a dot in the domain, no
// spaces or quotes. The invite list is the real gate; this just keeps junk out.
const EMAIL_PATTERN = /^[^\s@'"<>;]+@[^\s@'"<>;]+\.[^\s@'"<>;]+$/;

export function emailAddress(value: unknown): Check<string> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Email is required' };
  const email = value.trim().toLowerCase();
  if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter a valid email address' };
  }
  return { ok: true, value: email };
}

export function tagList(value: unknown): Check<string[]> {
  if (value === undefined || value === null || value === '') return { ok: true, value: [] };
  if (typeof value !== 'string') return { ok: false, error: 'Tags must be text' };
  const tags = [...new Set(value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > LIMITS.tagsPerMini) {
    return { ok: false, error: `A mini can have at most ${LIMITS.tagsPerMini} tags` };
  }
  if (tags.some(t => t.length > LIMITS.tag)) {
    return { ok: false, error: `Each tag must be ${LIMITS.tag} characters or fewer` };
  }
  return { ok: true, value: tags };
}

export function positiveId(value: unknown): Check<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'A valid id is required' };
  }
  return { ok: true, value };
}
