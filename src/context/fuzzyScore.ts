/**
 * Subsequence fuzzy score: all query chars in order.
 * Returns Infinity if no match; lower is better.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  const indices = fuzzyMatchIndices(haystack, needle);
  if (indices.length !== needle.length) {
    return Infinity;
  }
  let score = 0;
  let last = -1;
  for (const found of indices) {
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
  if (base.toLowerCase().includes(needle.toLowerCase())) {
    score -= 20;
  }
  return score;
}

/**
 * Indices of subsequence match of `needle` in `haystack` (case-insensitive).
 * Empty if no full match. Prefers matching inside the basename (path after last
 * `/`) so labels like `src/chat.ts` highlight `chat` on the file name.
 */
export function fuzzyMatchIndices(haystack: string, needle: string): number[] {
  if (!needle) {
    return [];
  }
  const baseStart = Math.max(0, haystack.lastIndexOf("/") + 1);
  if (baseStart > 0 && baseStart < haystack.length) {
    const inBase = matchSubsequenceIndices(haystack.slice(baseStart), needle);
    if (inBase.length === needle.length) {
      return inBase.map((i) => i + baseStart);
    }
  }
  return matchSubsequenceIndices(haystack, needle);
}

function matchSubsequenceIndices(haystack: string, needle: string): number[] {
  const hLower = haystack.toLowerCase();
  const nLower = needle.toLowerCase();
  const indices: number[] = [];
  let hi = 0;
  for (let ni = 0; ni < nLower.length; ni++) {
    const ch = nLower[ni]!;
    let found = -1;
    for (; hi < hLower.length; hi++) {
      if (hLower[hi] === ch) {
        found = hi;
        hi++;
        break;
      }
    }
    if (found < 0) {
      return [];
    }
    indices.push(found);
  }
  return indices;
}

/**
 * Prefer agent indices when they apply to `displayPath`; otherwise recompute
 * from the query. Indices always refer to the display path string.
 */
export function highlightIndicesForLabel(
  displayPath: string,
  query: string,
  agentPath?: string,
  agentIndices?: number[],
): number[] {
  const q = query.replace(/^!/, "").replace(/\/$/, "").trim();
  if (!q || !displayPath) {
    return [];
  }
  if (
    agentPath &&
    agentIndices &&
    agentIndices.length > 0 &&
    agentIndices.length === q.length
  ) {
    const remapped = remapIndicesToDisplay(
      agentPath,
      displayPath,
      agentIndices,
    );
    if (remapped && remapped.length > 0) {
      return remapped;
    }
  }
  return fuzzyMatchIndices(displayPath, q);
}

/**
 * Map indices from an absolute/full path onto a relative display path when the
 * display string is a suffix of the agent path (common after absolutization).
 */
export function remapIndicesToDisplay(
  agentPath: string,
  displayPath: string,
  indices: number[],
): number[] | null {
  const ap = agentPath.replace(/\\/g, "/");
  const dp = displayPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (!dp) {
    return null;
  }
  // display is suffix of agent path
  let offset = -1;
  if (ap === dp) {
    offset = 0;
  } else if (ap.endsWith("/" + dp)) {
    offset = ap.length - dp.length;
  } else if (ap.endsWith(dp)) {
    offset = ap.length - dp.length;
  } else {
    const base = dp.includes("/") ? dp.slice(dp.lastIndexOf("/") + 1) : dp;
    const bi = ap.lastIndexOf(base);
    if (bi >= 0 && base.length > 0) {
      // only remap indices that fall inside basename
      const out: number[] = [];
      for (const i of indices) {
        if (i >= bi && i < bi + base.length) {
          // map onto end of display path (basename region)
          const displayBaseStart = dp.length - base.length;
          out.push(displayBaseStart + (i - bi));
        }
      }
      return out.length > 0 ? out : null;
    }
    return null;
  }
  const out: number[] = [];
  for (const i of indices) {
    const j = i - offset;
    if (j >= 0 && j < dp.length) {
      out.push(j);
    }
  }
  // trailing slash on folder labels
  return out.length > 0 ? out : null;
}
