/**
 * Pure helpers for "Fix with Grok" diagnostic → composer draft.
 * No vscode imports so unit tests run under plain node:test.
 */

/** JSON-serializable payload for command / hover command links. */
export interface FixWithGrokPayload {
  uri: string;
  message: string;
  /** vscode.DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3 */
  severity: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  source?: string;
  code?: string;
  languageId?: string;
}

const MESSAGE_MAX = 2000;
const DEFAULT_SNIPPET_RADIUS = 3;

/** Map DiagnosticSeverity ordinal to a human label. */
export function severityLabel(severity: number): string {
  switch (severity) {
    case 0:
      return "Error";
    case 1:
      return "Warning";
    case 2:
      return "Info";
    case 3:
      return "Hint";
    default:
      return "Problem";
  }
}

/**
 * Prefer workspace-relative path; else last path segment of a file URI / path.
 */
export function displayPathForUri(
  uri: string,
  workspaceRelative?: string,
): string {
  if (workspaceRelative && workspaceRelative.length > 0) {
    return workspaceRelative;
  }
  try {
    if (uri.startsWith("file:")) {
      // Avoid importing node:url for simple display — strip file:// and decode.
      let path = uri.replace(/^file:\/\//, "");
      // file:///C:/... on Windows after strip is /C:/... — leave as-is for display.
      if (path.startsWith("/") && /^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1);
      }
      try {
        path = decodeURIComponent(path);
      } catch {
        /* keep raw */
      }
      return path;
    }
  } catch {
    /* fall through */
  }
  return uri;
}

/**
 * Extract lines around a 0-based line range with 1-based line number prefixes.
 */
export function snippetAround(
  lines: string[],
  startLine: number,
  endLine: number,
  radius: number = DEFAULT_SNIPPET_RADIUS,
): string {
  if (lines.length === 0) {
    return "";
  }
  const from = Math.max(0, startLine - radius);
  const to = Math.min(lines.length - 1, endLine + radius);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${i + 1}| ${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

function truncateMessage(message: string): string {
  if (message.length <= MESSAGE_MAX) {
    return message;
  }
  return `${message.slice(0, MESSAGE_MAX - 1)}…`;
}

export interface FormatFixOptions {
  displayPath: string;
  lines: string[];
  snippetRadius?: number;
}

/** Build the composer draft for a diagnostic payload. */
export function formatFixWithGrokPrompt(
  payload: FixWithGrokPayload,
  options: FormatFixOptions,
): string {
  const sev = severityLabel(payload.severity);
  const line = payload.startLine + 1;
  const message = truncateMessage(payload.message || "(no message)");
  const lang = payload.languageId?.trim() || "";
  const snippet = snippetAround(
    options.lines,
    payload.startLine,
    payload.endLine,
    options.snippetRadius ?? DEFAULT_SNIPPET_RADIUS,
  );

  const parts = [
    `Fix this ${sev} in \`${options.displayPath}\` at line ${line}:`,
    "",
    "```",
    message,
    "```",
  ];

  if (snippet) {
    parts.push("", "Surrounding code:", `\`\`\`${lang}`, snippet, "```");
  }

  return parts.join("\n");
}

/** Build a stable sticky chip id for a file path. */
export function fileChipId(fsPath: string): string {
  return `file:${fsPath}`;
}
