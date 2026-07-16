/**
 * Subsequence fuzzy score: all query chars in order.
 * Returns Infinity if no match; lower is better.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let hi = 0;
  let score = 0;
  let last = -1;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]!;
    let found = -1;
    for (; hi < haystack.length; hi++) {
      if (haystack[hi] === ch) {
        found = hi;
        hi++;
        break;
      }
    }
    if (found < 0) {
      return Infinity;
    }
    // Prefer contiguous / early matches (basename-friendly).
    if (last >= 0) {
      score += found - last - 1;
    } else {
      score += found;
    }
    last = found;
  }
  // Bonus: basename match
  const base = haystack.includes("/")
    ? haystack.slice(haystack.lastIndexOf("/") + 1)
    : haystack;
  if (base.includes(needle)) {
    score -= 20;
  }
  return score;
}
