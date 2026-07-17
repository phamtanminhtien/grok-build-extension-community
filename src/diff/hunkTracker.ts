/**
 * Wire builders for x.ai/hunk-tracker/* ACP extension methods.
 * Pure — no vscode / agent imports (unit-testable).
 *
 * Shell handlers: xai-grok-shell `extensions/hunk_tracker.rs`
 * (camelCase params; action strings "accept" | "reject").
 */

export type HunkActionKind = "accept" | "reject";

export const HUNK_TRACKER_METHODS = {
  getHunks: "x.ai/hunk-tracker/get-hunks",
  getFiles: "x.ai/hunk-tracker/get-files",
  getSummary: "x.ai/hunk-tracker/get-summary",
  getAllFileContents: "x.ai/hunk-tracker/get-all-file-contents",
  hunkAction: "x.ai/hunk-tracker/hunk-action",
  fileAction: "x.ai/hunk-tracker/file-action",
  turnAction: "x.ai/hunk-tracker/turn-action",
  allAction: "x.ai/hunk-tracker/all-action",
} as const;

export type HunkTrackerMethod =
  (typeof HUNK_TRACKER_METHODS)[keyof typeof HUNK_TRACKER_METHODS];

export interface HunkActionResult {
  success: boolean;
  error?: string;
  affectedCount?: number;
}

export interface HunkFileSummary {
  path: string;
  isAgentFile: boolean;
  staged: boolean;
  hunkCount: number;
  additions: number;
  deletions: number;
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

/** Normalize accept/reject string (case-insensitive). */
export function normalizeHunkAction(
  action: string,
): HunkActionKind | undefined {
  const a = action.trim().toLowerCase();
  if (a === "accept" || a === "reject") {
    return a;
  }
  return undefined;
}

export function fileActionParams(
  sessionId: string,
  path: string,
  action: HunkActionKind,
): Record<string, unknown> {
  return { sessionId, path, action };
}

export function allActionParams(
  sessionId: string,
  action: HunkActionKind,
): Record<string, unknown> {
  return { sessionId, action };
}

export function hunkActionParams(
  sessionId: string,
  hunkId: string,
  action: HunkActionKind,
): Record<string, unknown> {
  return { sessionId, hunkId, action };
}

export function turnActionParams(
  sessionId: string,
  promptIndex: number,
  action: HunkActionKind,
): Record<string, unknown> {
  return { sessionId, promptIndex, action };
}

export function getFilesParams(sessionId: string): Record<string, unknown> {
  return { sessionId };
}

export function getHunksParams(
  sessionId: string,
  opts?: { path?: string; source?: "agent" | "external" | "all" },
): Record<string, unknown> {
  const params: Record<string, unknown> = { sessionId };
  if (opts?.path) {
    params.path = opts.path;
  }
  if (opts?.source && opts.source !== "all") {
    params.source = opts.source;
  }
  return params;
}

export function getSummaryParams(sessionId: string): Record<string, unknown> {
  return { sessionId };
}

/** Parse ActionResponse from shell (camelCase + optional envelope). */
export function parseHunkActionResponse(raw: unknown): HunkActionResult {
  const v = unwrapResult(raw);
  const o = asRecord(v);
  if (!o) {
    return { success: false, error: "Invalid hunk-tracker response" };
  }
  if (typeof o.error === "string" && o.error && o.success !== true) {
    return {
      success: false,
      error: o.error,
      affectedCount:
        typeof o.affectedCount === "number"
          ? o.affectedCount
          : typeof o.affected_count === "number"
            ? o.affected_count
            : undefined,
    };
  }
  const success = o.success === true || o.ok === true;
  const affectedCount =
    typeof o.affectedCount === "number"
      ? o.affectedCount
      : typeof o.affected_count === "number"
        ? o.affected_count
        : undefined;
  const error = typeof o.error === "string" && o.error ? o.error : undefined;
  return { success, error, affectedCount };
}

/** Parse get-files response into path summaries. */
export function parseGetFilesResponse(raw: unknown): HunkFileSummary[] {
  const v = unwrapResult(raw);
  const o = asRecord(v);
  const files = o?.files;
  if (!Array.isArray(files)) {
    return [];
  }
  const out: HunkFileSummary[] = [];
  for (const item of files) {
    const f = asRecord(item);
    if (!f) {
      continue;
    }
    const path =
      typeof f.path === "string"
        ? f.path
        : f.path != null
          ? String(f.path)
          : "";
    if (!path) {
      continue;
    }
    out.push({
      path,
      isAgentFile: f.isAgentFile === true || f.is_agent_file === true,
      staged: f.staged === true,
      hunkCount:
        typeof f.hunkCount === "number"
          ? f.hunkCount
          : typeof f.hunk_count === "number"
            ? f.hunk_count
            : 0,
      additions: typeof f.additions === "number" ? f.additions : 0,
      deletions: typeof f.deletions === "number" ? f.deletions : 0,
    });
  }
  return out;
}
