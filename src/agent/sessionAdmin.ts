/**
 * Host-side session admin ops via ACP ext methods (TUI parity):
 * compact, fork, rename.
 */

export interface CompactParams {
  sessionId: string;
  userContext?: string;
}

export interface RenameParams {
  sessionId: string;
  title: string;
  cwd?: string;
}

export interface ForkParams {
  sourceSessionId: string;
  sourceCwd: string;
  newCwd: string;
  /** Optional directive / note — not sent on wire; used for host messaging. */
  directive?: string;
}

export interface ForkResult {
  newSessionId: string;
  newCwd: string;
  parentSessionId: string;
  chatMessagesCopied?: number;
  updatesCopied?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build compact_conversation params (accepts sessionId + optional context). */
export function buildCompactParams(
  sessionId: string,
  args: string,
): CompactParams {
  const userContext = args.trim() || undefined;
  return userContext ? { sessionId, userContext } : { sessionId };
}

/**
 * Parse `/rename <title>` args. Title is required and non-blank after trim.
 */
export function parseRenameArgs(args: string): string | null {
  const title = args.trim();
  return title.length > 0 ? title : null;
}

/**
 * Parse `/fork` args. Optional flags:
 * `--worktree` / `--no-worktree` (ignored for now — host uses same cwd fork)
 * remaining text is an optional directive (not on wire).
 */
export function parseForkArgs(args: string): { directive?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  for (const t of tokens) {
    if (t === "--worktree" || t === "--no-worktree") {
      continue;
    }
    rest.push(t);
  }
  const directive = rest.join(" ").trim();
  return directive ? { directive } : {};
}

export function buildForkParams(
  sourceSessionId: string,
  cwd: string,
  args: string,
): ForkParams {
  const { directive } = parseForkArgs(args);
  return {
    sourceSessionId,
    sourceCwd: cwd,
    newCwd: cwd,
    directive,
  };
}

/** Wire body for `x.ai/session/fork` (camelCase). */
export function forkRequestBody(p: ForkParams): Record<string, unknown> {
  return {
    sourceSessionId: p.sourceSessionId,
    sourceCwd: p.sourceCwd,
    newCwd: p.newCwd,
  };
}

/** Wire body for `x.ai/session/rename`. */
export function renameRequestBody(p: RenameParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionId: p.sessionId,
    title: p.title,
  };
  if (p.cwd) {
    body.cwd = p.cwd;
  }
  return body;
}

/** Wire body for `x.ai/compact_conversation`. */
export function compactRequestBody(p: CompactParams): Record<string, unknown> {
  const body: Record<string, unknown> = { sessionId: p.sessionId };
  if (p.userContext) {
    body.userContext = p.userContext;
  }
  return body;
}

/**
 * Normalize fork response (direct or `{ result: … }`, camel or snake).
 */
export function parseForkResponse(raw: unknown): ForkResult | null {
  let cur: unknown = raw;
  const outer = asRecord(cur);
  if (outer?.result != null) {
    cur = outer.result;
  }
  const o = asRecord(cur);
  if (!o) {
    return null;
  }
  const newSessionId = asString(o.newSessionId) ?? asString(o.new_session_id);
  const newCwd = asString(o.newCwd) ?? asString(o.new_cwd) ?? "";
  const parentSessionId =
    asString(o.parentSessionId) ?? asString(o.parent_session_id) ?? "";
  if (!newSessionId) {
    return null;
  }
  return {
    newSessionId,
    newCwd,
    parentSessionId,
    chatMessagesCopied:
      typeof o.chatMessagesCopied === "number"
        ? o.chatMessagesCopied
        : typeof o.chat_messages_copied === "number"
          ? o.chat_messages_copied
          : undefined,
    updatesCopied:
      typeof o.updatesCopied === "number"
        ? o.updatesCopied
        : typeof o.updates_copied === "number"
          ? o.updates_copied
          : undefined,
  };
}

export function parseSuccessFlag(raw: unknown): boolean {
  let cur: unknown = raw;
  const outer = asRecord(cur);
  if (outer?.result != null) {
    cur = outer.result;
  }
  const o = asRecord(cur);
  if (!o) {
    // Empty compact response is success.
    return (
      raw == null ||
      (typeof raw === "object" && Object.keys(raw as object).length === 0)
    );
  }
  if (o.success === true || o.ok === true) {
    return true;
  }
  if (o.success === false || o.ok === false) {
    return false;
  }
  // compact returns `{}` — treat as ok
  return true;
}
