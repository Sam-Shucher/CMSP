import { describe, it, expect } from 'vitest';
import { levenshteinDistance, fuzzyIncludes, matchesSearch } from './search';

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('tabaxi', 'tabaxi')).toBe(0);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshteinDistance('tabaxi', 'tabaxe')).toBe(1);
  });

  it('counts a single insertion as distance 1', () => {
    expect(levenshteinDistance('tabaxi', 'tabaxii')).toBe(1);
  });

  it('is large for unrelated words', () => {
    expect(levenshteinDistance('tabaxi', 'goblin')).toBeGreaterThan(3);
  });

  it('is the other string\'s length when one side is empty', () => {
    expect(levenshteinDistance('', 'wolf')).toBe(4);
    expect(levenshteinDistance('wolf', '')).toBe(4);
    expect(levenshteinDistance('', '')).toBe(0);
  });
});

describe('fuzzyIncludes', () => {
  it('matches an exact substring', () => {
    expect(fuzzyIncludes('Tabaxi Bard', 'tabaxi')).toBe(true);
  });

  it('matches a one-letter misspelling of a word ("tabaxe" for "tabaxi")', () => {
    expect(fuzzyIncludes('Tabaxi Bard', 'tabaxe')).toBe(true);
  });

  it('matches a one-letter-too-many misspelling ("tabaxii" for "tabaxi")', () => {
    expect(fuzzyIncludes('Tabaxi Bard', 'tabaxii')).toBe(true);
  });

  it('does not match an unrelated word', () => {
    expect(fuzzyIncludes('Tabaxi Bard', 'goblin')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(fuzzyIncludes('TABAXI BARD', 'Tabaxi')).toBe(true);
  });

  it('treats an empty query as matching everything', () => {
    expect(fuzzyIncludes('Anything at all', '')).toBe(true);
  });
});

describe('matchesSearch', () => {
  it('matches if any field matches, including typo-tolerant fields', () => {
    expect(matchesSearch(['Dire Wolf', 'A fierce wolf', ['painted']], 'wolf')).toBe(true);
    expect(matchesSearch(['Beholder', null, ['tabaxi', 'painted']], 'tabaxe')).toBe(true);
  });

  it('returns false when no field matches', () => {
    expect(matchesSearch(['Dire Wolf', 'A fierce wolf', ['painted']], 'beholder')).toBe(false);
  });

  it('ignores null/undefined fields', () => {
    expect(matchesSearch([null, undefined, 'Dire Wolf'], 'wolf')).toBe(true);
  });

  it('treats a blank query as matching everything, even with no fields', () => {
    expect(matchesSearch([], '   ')).toBe(true);
    expect(matchesSearch([null], '')).toBe(true);
  });

  it('does not match a typo that is too far off for a short word', () => {
    expect(fuzzyIncludes('Orc', 'elf')).toBe(false);
  });
});
