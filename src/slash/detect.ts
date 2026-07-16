/**
 * Slash detection / parse — mirrors grok-build pager
 * `analyze_input` + `parse_invocation` (leading `/` only for MVP).
 */

import type { SlashContext, SlashInvocation } from "./types";

/**
 * Detect leading slash-completion context from prompt text + cursor.
 * Returns null if the line is not a slash command under the cursor.
 *
 * Rules (aligned with TUI leading `/`):
 * - First non-whitespace char must be `/`
 * - Command token: `/` + non-whitespace (no second `/` inside name)
 * - Cursor must be within the command token or args for that invocation
 */
export function detectSlashContext(
  text: string,
  cursor: number,
): SlashContext | null {
  if (cursor < 0 || cursor > text.length) {
    return null;
  }

  // Leading whitespace ok (TUI trims for analysis).
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) {
    i++;
  }
  if (i >= text.length || text[i] !== "/") {
    return null;
  }

  const slashStart = i;
  // Command name ends at first whitespace.
  let nameEnd = slashStart + 1;
  while (nameEnd < text.length && !/\s/.test(text[nameEnd]!)) {
    // Double-slash or path-like mid-name: reject completion.
    if (nameEnd > slashStart + 1 && text[nameEnd] === "/") {
      return null;
    }
    nameEnd++;
  }

  const commandRange = { start: slashStart, end: nameEnd };
  const inCommand = cursor >= slashStart && cursor <= nameEnd;

  // Args: after first whitespace run following the name.
  let argsStart = nameEnd;
  while (argsStart < text.length && /\s/.test(text[argsStart]!)) {
    argsStart++;
  }
  const args = text.slice(argsStart);
  const query = inCommand
    ? text.slice(slashStart + 1, cursor)
    : text.slice(slashStart + 1, nameEnd);

  // Cursor past end of line content for this invocation is still "args" mode
  // when we already left the command token.
  if (!inCommand && cursor < nameEnd) {
    return null;
  }

  return {
    range: commandRange,
    cursor,
    query,
    inCommand,
    args,
  };
}

/**
 * Parse a submitted line as `/command args`.
 * Returns null if the line does not start with `/`.
 */
export function parseInvocation(line: string): SlashInvocation | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const body = trimmed.slice(1);
  if (!body) {
    return {
      raw: line,
      key: "",
      name: "",
      args: "",
    };
  }
  const sp = body.search(/\s/);
  const key = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const args = sp < 0 ? "" : body.slice(sp + 1).trimStart();
  return {
    raw: line,
    key,
    name: key,
    args,
  };
}

/**
 * Replace the command token (from `/` through name) with `insertText`
 * and place cursor at the end of the insert.
 */
export function replaceSlashToken(
  text: string,
  ctx: SlashContext,
  insertText: string,
): { text: string; cursor: number } {
  // Keep any args after the command token when completing the name only.
  const after = text.slice(ctx.range.end);
  const next = text.slice(0, ctx.range.start) + insertText + after;
  const cursor = ctx.range.start + insertText.length;
  return { text: next, cursor };
}
