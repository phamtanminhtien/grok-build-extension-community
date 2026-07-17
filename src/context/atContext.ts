/**
 * @-context detection — mirrors grok-build `file_search/context.rs`.
 *
 * Given prompt text + cursor, detect whether the cursor is inside an `@`-token
 * and extract the query for fuzzy matching.
 *
 * Rules:
 * - `@` must not be preceded by alphanumeric or `_` (avoids emails)
 * - Token runs from `@` to first whitespace / `,` / `;`
 * - Cursor must be within the token
 * - Query is text after `@` up to the cursor
 */

export interface AtContext {
  /** Character range in the input (includes the leading `@`). */
  range: { start: number; end: number };
  /** Cursor position. */
  cursor: number;
  /** Text after `@` (and after `!` if hidden mode) up to cursor. */
  query: string;
}

export function isDirMode(ctx: AtContext): boolean {
  return ctx.query.endsWith("/");
}

export function isHiddenMode(ctx: AtContext): boolean {
  return ctx.query.startsWith("!");
}

/** Query for the matcher (strips leading `!`). */
export function matcherQuery(ctx: AtContext): string {
  return ctx.query.startsWith("!") ? ctx.query.slice(1) : ctx.query;
}

/**
 * Byte/char range covering only the path portion of the @-token
 * (after `@` and optional `!`).
 */
export function pathRange(ctx: AtContext): { start: number; end: number } {
  const prefix = 1 + (isHiddenMode(ctx) ? 1 : 0);
  return { start: ctx.range.start + prefix, end: ctx.range.end };
}

/**
 * Detect an @-completion context from prompt text and cursor position.
 * Returns `null` if the cursor is not inside an @-token.
 */
export function detectAtContext(
  text: string,
  cursor: number,
): AtContext | null {
  if (cursor < 0 || cursor > text.length) {
    return null;
  }

  const before = text.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) {
    return null;
  }

  // Reject email-like: `@` preceded by alphanumeric or underscore.
  if (atIdx > 0) {
    const prev = text[atIdx - 1]!;
    if (/[A-Za-z0-9_]/.test(prev)) {
      return null;
    }
  }

  // Token end: first whitespace, comma, or semicolon after `@`.
  let tokenEnd = text.length;
  for (let i = atIdx + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch) || ch === "," || ch === ";") {
      tokenEnd = i;
      break;
    }
  }

  if (cursor > tokenEnd) {
    return null;
  }

  return {
    range: { start: atIdx, end: tokenEnd },
    cursor,
    query: text.slice(atIdx + 1, cursor),
  };
}

/**
 * Replace the full @-token (including `@`) with `replacement` and return
 * the new text + cursor. Used when accepting a mention.
 */
export function replaceAtToken(
  text: string,
  ctx: AtContext,
  replacement: string,
): { text: string; cursor: number } {
  const next =
    text.slice(0, ctx.range.start) + replacement + text.slice(ctx.range.end);
  const cursor = ctx.range.start + replacement.length;
  return { text: next, cursor };
}

/**
 * Build the inline composer token for a context chip (mirrors TUI KIND_FILE_REF).
 * Agent `prompt_parser` collects these `@path` tokens from the message text.
 *
 * @param kind file | selection | folder
 * @param displayPath workspace-relative path when possible
 * @param lines optional selection range (1-based, inclusive)
 */
export function formatMentionInsertText(
  kind: "file" | "selection" | "folder",
  displayPath: string,
  lines?: { startLine?: number; endLine?: number },
  basenameFallback = "file",
): string {
  let p = displayPath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Normalize accidental kind prefixes from legacy labels.
  p = p
    .replace(/^file:/, "")
    .replace(/^folder:/, "")
    .replace(/^selection:/, "");
  p = p.replace(/\/+$/, "");
  if (!p) {
    p = basenameFallback;
  }
  if (kind === "selection" && lines?.startLine != null) {
    const start = lines.startLine;
    const end = lines.endLine ?? start;
    if (end === start) {
      return `@${p}:${start} `;
    }
    return `@${p}:${start}-${end} `;
  }
  if (kind === "folder") {
    return `@${p}/ `;
  }
  return `@${p} `;
}
