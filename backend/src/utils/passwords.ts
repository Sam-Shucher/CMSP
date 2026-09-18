import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// Everything to do with turning a password into something safe to store.
//
// bcrypt generates a random salt per password and writes it, along with the
// cost, into the hash itself — so no two people with the same password get the
// same hash, and a stolen database can't be attacked with a rainbow table.
//
// The cost is how many rounds of work each single guess takes: one step up
// doubles it, for us and for anyone cracking a stolen database. It's a setting
// rather than a constant because the right number depends on the machine —
// see `npm run bench:hash`, and PASSWORD_COST in backend/.env.

type Env = Record<string, string | undefined>;

// 12 because the Pi this runs on is a Cortex-A72 doing pure-JS bcrypt: each
// step up doubles a sign-in that's already measured in seconds there. Raise it
// on faster hardware — `npm run bench:hash` tells you what a step costs.
const DEFAULT_COST = 12;
const MIN_COST = 4;  // bcrypt's own floor; only sensible in tests
const MAX_COST = 15; // beyond this a Raspberry Pi login takes many seconds

export function passwordCost(env: Env = process.env): number {
  const configured = Number(env.PASSWORD_COST);
  if (!Number.isInteger(configured) || configured < MIN_COST || configured > MAX_COST) return DEFAULT_COST;
  return configured;
}

export function hashPassword(password: string, env: Env = process.env): Promise<string> {
  return bcrypt.hash(password, passwordCost(env));
}

// False for anything that isn't a hash we made, rather than throwing — a
// corrupt or empty stored hash must read as "wrong password", never a 500.
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

// True when a stored hash was made at a weaker cost than we now use, so it can
// be quietly upgraded the next time that person signs in (routes/auth.ts).
export function needsRehash(hash: string, env: Env = process.env): boolean {
  const cost = Number(hash.split('$')[2]);
  if (!Number.isInteger(cost)) return false;
  return cost < passwordCost(env);
}

// The temporary password an admin reads out or texts to someone who's locked
// out. Ambiguous characters (O/0, I/l/1) are left out so it survives being
// typed from a phone screen, and the length makes up for the smaller alphabet.
const SAFE_CHARACTERS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEMPORARY_LENGTH = 16;

export function temporaryPassword(): string {
  const picked = Array.from(
    crypto.randomBytes(TEMPORARY_LENGTH),
    byte => SAFE_CHARACTERS[byte % SAFE_CHARACTERS.length]
  ).join('');
  // Grouped for reading aloud: "abcd-efgh-ijkl-mnop".
  return (picked.match(/.{1,4}/g) ?? [picked]).join('-');
}
