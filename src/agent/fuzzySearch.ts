/**
 * Wire builders/parsers for `x.ai/search/fuzzy/*` (+ content status hooks).
 * Pure — unit-testable. Server: xai-grok-shell `extensions/search.rs`.
 *
 * Flow (client → agent):
 *   open → searchId
 *   change(query) → agent streams `x.ai/search/fuzzy/status`
 *   close
 */

export const FUZZY_SEARCH_METHODS = {
  open: "x.ai/search/fuzzy/open",
  change: "x.ai/search/fuzzy/change",
  close: "x.ai/search/fuzzy/close",
  status: "x.ai/search/fuzzy/status",
} as const;

export interface FuzzyMatch {
  path: string;
  name: string;
  /** "file" | "directory" | other */
  type: string;
  score: number;
  indices: number[];
  isDir: boolean;
}

export interface FuzzyOpenResult {
  sessionId: string;
  searchId: string;
}

export interface FuzzyStatusUpdate {
  sessionId?: string;
  searchId: string;
  matches: FuzzyMatch[];
  total: number;
  done: boolean;
  generation: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function unwrapResult(raw: unknown): unknown {
  const o = asRecord(raw);
  if (o && "result" in o) {
    return o.result;
  }
  return raw;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function fuzzyOpenParams(opts: {
  sessionId?: string;
  cwd?: string;
  root?: string;
  hidden?: boolean;
  requestId?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    hidden: opts.hidden === true,
  };
  if (opts.sessionId) {
    body.sessionId = opts.sessionId;
  }
  if (opts.cwd) {
    body.cwd = opts.cwd;
  }
  if (opts.root) {
    body.root = opts.root;
  }
  if (opts.requestId) {
    body.requestId = opts.requestId;
  }
  return body;
}

export function fuzzyChangeParams(opts: {
  searchId: string;
  query: string;
  dirsOnly?: boolean;
  limit?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    searchId: opts.searchId,
    query: opts.query,
    dirsOnly: opts.dirsOnly === true,
  };
  if (opts.limit != null) {
    body.limit = opts.limit;
  }
  return body;
}

export function fuzzyCloseParams(searchId: string): Record<string, unknown> {
  return { searchId };
}

export function parseFuzzyOpenResponse(raw: unknown): FuzzyOpenResult | null {
  const unwrapped = unwrapResult(raw);
  const o = asRecord(unwrapped);
  if (!o) {
    return null;
  }
  const searchId = asString(o.searchId) ?? asString(o.search_id);
  if (!searchId) {
    return null;
  }
  return {
    searchId,
    sessionId: asString(o.sessionId) ?? asString(o.session_id) ?? "agent",
  };
}

export function parseFuzzyMatch(raw: unknown): FuzzyMatch | null {
  const o = asRecord(raw);
  if (!o) {
    return null;
  }
  const path = asString(o.path);
  if (!path) {
    return null;
  }
  const type =
    asString(o.type) ??
    (o.is_dir === true || o.isDir === true ? "directory" : "file");
  const name =
    asString(o.name) ?? path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  const score = asNumber(o.score) ?? 0;
  const indicesRaw = o.indices ?? o.matched_indices ?? o.matchedIndices;
  const indices = Array.isArray(indicesRaw)
    ? indicesRaw.map((x) => asNumber(x)).filter((n): n is number => n != null)
    : [];
  const isDir =
    type === "directory" ||
    type === "dir" ||
    o.is_dir === true ||
    o.isDir === true;
  return { path, name, type, score, indices, isDir };
}

export function parseFuzzyStatusNotification(
  raw: unknown,
): FuzzyStatusUpdate | null {
  const o = asRecord(raw) ?? asRecord(unwrapResult(raw));
  if (!o) {
    return null;
  }
  const nested = asRecord(o.params) ?? o;
  const searchId = asString(nested.searchId) ?? asString(nested.search_id);
  if (!searchId) {
    return null;
  }
  const matchesRaw = Array.isArray(nested.matches) ? nested.matches : [];
  const matches = matchesRaw
    .map(parseFuzzyMatch)
    .filter((m): m is FuzzyMatch => m != null);
  // Prefer higher score first (agent already ranks; re-sort for safety).
  matches.sort((a, b) => b.score - a.score);
  return {
    searchId,
    sessionId: asString(nested.sessionId) ?? asString(nested.session_id),
    matches,
    total: asNumber(nested.total) ?? matches.length,
    done: asBool(nested.done) === true,
    generation: asNumber(nested.generation) ?? 0,
  };
}

/** QuickPick label for a match (icon + basename). */
export function formatFuzzyMatchLabel(m: FuzzyMatch): string {
  const icon = m.isDir ? "$(folder)" : "$(file)";
  return `${icon} ${m.name}`;
}

export function formatFuzzyMatchDescription(
  m: FuzzyMatch,
  workspaceRoot?: string,
): string {
  if (workspaceRoot && m.path.startsWith(workspaceRoot)) {
    const rel = m.path.slice(workspaceRoot.length).replace(/^[/\\]/, "");
    return rel || m.path;
  }
  return m.path;
}
