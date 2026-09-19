import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LIMITS } from './utils/inputs';
import { MAX_DURATION_DAYS } from './utils/loanRules';
import { MAX_QUEST_DAYS } from './utils/quest';
import { MAX_IMAGES, MAX_PHOTO_BYTES, MAX_PRICE } from './routes/minis';

// frontend/src/limits.ts is a hand-copied mirror of the numbers this side
// enforces, so a form can stop someone before the server has to. Nothing kept
// the two in step, and that is exactly how a quest came to be capped at a year
// while a loan was capped at three months: the cap was added to loanRules.ts,
// the quest's own limit was left at 365, and the date picker offered every day
// of it. Every suite stayed green.
//
// This reads the frontend file as text rather than importing it — the two
// packages build separately, and a test that needed them wired together would
// be the kind of thing someone later deletes.

const MIRROR_PATH = path.join(__dirname, '../../frontend/src/limits.ts');
const mirror = fs.readFileSync(MIRROR_PATH, 'utf8');

// Pulls `name: <number>` out of the mirror, arithmetic included (photoBytes is
// written as 10 * 1024 * 1024, the way it reads on this side too).
function mirrored(name: string): number {
  const match = new RegExp(`\\b${name}:\\s*([0-9_.*\\s]+?),`).exec(mirror);
  expect(match, `frontend/src/limits.ts has no "${name}"`).not.toBeNull();
  const expression = match![1].replace(/_/g, '').trim();
  expect(expression, `"${name}" is not a plain number in the mirror`).toMatch(/^[0-9.]+(\s*\*\s*[0-9.]+)*$/);
  // A number, or numbers multiplied together (10 * 1024 * 1024) — worked out
  // by multiplying the parts rather than evaluating the string.
  return expression.split('*').reduce((total, part) => total * Number(part.trim()), 1);
}

describe('frontend/src/limits.ts mirrors what the server actually enforces', () => {
  // The pair that drifted for real.
  it('caps a loan and a quest at the same three months the server does', () => {
    expect(mirrored('loanDays')).toBe(MAX_DURATION_DAYS);
    expect(mirrored('questDays')).toBe(MAX_QUEST_DAYS);
  });

  // A quest is "borrowing your own mini", so the two ceilings are one decision.
  // If they ever should differ, this is the line to argue with.
  it('keeps the loan and quest ceilings equal to each other', () => {
    expect(MAX_QUEST_DAYS).toBe(MAX_DURATION_DAYS);
  });

  it.each([
    ['displayName', () => LIMITS.displayName],
    ['neighborhood', () => LIMITS.neighborhood],
    ['miniName', () => LIMITS.miniName],
    ['description', () => LIMITS.description],
    ['tag', () => LIMITS.tag],
    ['tagsPerMini', () => LIMITS.tagsPerMini],
    ['search', () => LIMITS.search],
    ['setName', () => LIMITS.setName],
    ['setMembers', () => LIMITS.setMembers],
  ])('mirrors the %s length limit', (name: string, server: () => number) => {
    expect(mirrored(name)).toBe(server());
  });

  it('mirrors the photo count, photo size, and price ceiling', () => {
    expect(mirrored('photosPerMini')).toBe(MAX_IMAGES);
    expect(mirrored('photoBytes')).toBe(MAX_PHOTO_BYTES);
    expect(mirrored('price')).toBe(MAX_PRICE);
  });

  // If a limit is added on this side, the mirror should grow with it — this at
  // least fails loudly when the file stops being parseable in the shape above.
  it('can still read every value it checks', () => {
    for (const name of ['loanDays', 'questDays', 'photosPerMini', 'photoBytes', 'price', 'search']) {
      expect(Number.isFinite(mirrored(name)), name).toBe(true);
    }
  });
});
