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
  setName: 100,
  setMembers: 50, // most a single set-membership change can touch at once
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

// A query-string value restricted to a fixed set of strings (e.g. ?sort=name).
// Missing/empty means "not specified" (the caller supplies the default);
// anything else not in the allowed list — including the array/object shapes
// a crafted query string can produce — is rejected.
export function optionalEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): Check<T | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return { ok: false, error: `${label} must be one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: value as T };
}

// A query-string id (e.g. ?owner=5). Missing/empty means "not specified".
export function optionalId(value: unknown, label: string): Check<number | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${label} must be a valid id` };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: `${label} must be a valid id` };
  return { ok: true, value: id };
}

// A query-string boolean flag (e.g. ?available=1). Missing/empty means false;
// the only other accepted value is '1', so a stray "false"/"0" from a client
// bug is caught instead of silently doing nothing.
export function optionalFlag(value: unknown, label: string): Check<boolean> {
  if (value === undefined || value === null || value === '') return { ok: true, value: false };
  if (value !== '1') return { ok: false, error: `${label} must be a valid flag` };
  return { ok: true, value: true };
}

export function positiveId(value: unknown): Check<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'A valid id is required' };
  }
  return { ok: true, value };
}

// A JSON body's list of ids (e.g. { miniIds: [1, 2, 3] }) — optional (missing
// or null means none), capped so a request can't ask the server to touch an
// unbounded number of rows, and deduplicated since a client sending the same
// id twice never means anything different from sending it once.
export function idList(value: unknown, label: string, max: number): Check<number[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${label} must be a list of ids` };
  if (value.length > max) return { ok: false, error: `${label} can have at most ${max} at a time` };

  const ids: number[] = [];
  for (const entry of value) {
    const checked = positiveId(entry);
    if (!checked.ok) return { ok: false, error: `${label} must all be valid ids` };
    ids.push(checked.value);
  }
  return { ok: true, value: [...new Set(ids)] };
}
