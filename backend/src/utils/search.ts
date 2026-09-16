// Standard edit-distance DP: how many single-character insertions,
// deletions, or substitutions turn `a` into `b`.
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    let prevDiagonal = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prevDiagonal
        : 1 + Math.min(prevDiagonal, dp[j], dp[j - 1]);
      prevDiagonal = temp;
    }
  }

  return dp[n];
}

// How many typos we tolerate for a word of this length — roughly "70% of
// the characters have to match", so a 6-7 letter word like "tabaxi" still
// matches "tabaxe" or "tabaxii" (distance 1) but not something unrelated.
function maxTypos(wordLength: number): number {
  return Math.max(1, Math.ceil(wordLength * 0.3));
}

// True if `query` is a plain substring of `text` (case-insensitive), or
// close enough (within maxTypos) to any individual word in `text`.
export function fuzzyIncludes(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const t = text.toLowerCase();
  if (t.includes(q)) return true;

  const tolerance = maxTypos(q.length);
  const words = t.split(/[^a-z0-9]+/i).filter(Boolean);
  return words.some(word => levenshteinDistance(q, word) <= tolerance);
}

// True if the query matches any of the given fields — used to search a
// mini's name, description, and tags together the same way the old
// SQL `LIKE` search did, but typo-tolerant. Fields can be plain strings
// (name, description) or string arrays (tags).
export function matchesSearch(fields: (string | string[] | null | undefined)[], query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  return fields.some(field => {
    if (field == null) return false;
    const values = Array.isArray(field) ? field : [field];
    return values.some(value => fuzzyIncludes(value, q));
  });
}
