/**
 * Wire builders for x.ai/rewind/* ACP extension methods.
 * Pure — no vscode / agent imports (unit-testable).
 *
 * Shell: xai-grok-shell `extensions/rewind.rs` + `session/acp_types.rs`
 * TUI: xai-grok-pager `views/rewind.rs` (preview force=false, execute force=true).
 */

export const REWIND_METHODS = {
  points: "x.ai/rewind/points",
  execute: "x.ai/rewind/execute",
} as const;

/** Wire mode strings (snake_case). */
export type RewindMode = "all" | "conversation_only" | "files_only";

export interface RewindPoint {
  promptIndex: number;
  createdAt: string;
  numFileSnapshots: number;
  hasFileChanges: boolean;
  promptPreview?: string;
}

export interface RewindConflict {
  path: string;
  conflictType: string;
}

export interface RewindResult {
  success: boolean;
  targetPromptIndex: number;
  mode: RewindMode;
  revertedFiles: string[];
  cleanFiles: string[];
  conflicts: RewindConflict[];
  promptText?: string;
  error?: string;
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
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalize mode string (case-insensitive, code_only → files_only). */
export function normalizeRewindMode(
  raw: string | null | undefined,
): RewindMode | undefined {
  if (raw == null) {
    return undefined;
  }
  const m = raw.trim().toLowerCase().replace(/-/g, "_");
  if (m === "all") {
    return "all";
  }
  if (m === "conversation_only" || m === "conversation") {
    return "conversation_only";
  }
  if (m === "files_only" || m === "code_only" || m === "files") {
    return "files_only";
  }
  return undefined;
}

export function rewindPointsParams(sessionId: string): Record<string, unknown> {
  return { sessionId };
}

export function rewindExecuteParams(opts: {
  sessionId: string;
  targetPromptIndex: number;
  mode: RewindMode;
  force?: boolean;
}): Record<string, unknown> {
  return {
    sessionId: opts.sessionId,
    targetPromptIndex: opts.targetPromptIndex,
    mode: opts.mode,
    force: opts.force === true,
  };
}

/** Modes offered after picking a point (TUI ModeSelect). */
export function modesForPoint(point: {
  hasFileChanges: boolean;
}): Array<{ mode: RewindMode; label: string; detail: string }> {
  const modes: Array<{ mode: RewindMode; label: string; detail: string }> = [
    {
      mode: "all",
      label: "Both (conversation + files)",
      detail: "Full time-travel to this turn",
    },
    {
      mode: "conversation_only",
      label: "Conversation only",
      detail: "Keep files; drop later chat turns",
    },
  ];
  if (point.hasFileChanges) {
    modes.push({
      mode: "files_only",
      label: "Files only",
      detail: "Revert file snapshots; keep chat",
    });
  }
  return modes;
}

/** Whether this mode drops later conversation turns in the UI. */
export function modeTruncatesConversation(mode: RewindMode): boolean {
  return mode === "all" || mode === "conversation_only";
}

export function parseRewindPointsResponse(raw: unknown): RewindPoint[] {
  const v = unwrapResult(raw);
  const o = asRecord(v);
  const list = o?.rewindPoints ?? o?.rewind_points;
  if (!Array.isArray(list)) {
    return [];
  }
  const out: RewindPoint[] = [];
  for (const item of list) {
    const p = asRecord(item);
    if (!p) {
      continue;
    }
    const promptIndex = asNumber(p.promptIndex) ?? asNumber(p.prompt_index);
    if (promptIndex === undefined) {
      continue;
    }
    out.push({
      promptIndex,
      createdAt: asString(p.createdAt) ?? asString(p.created_at) ?? "",
      numFileSnapshots:
        asNumber(p.numFileSnapshots) ?? asNumber(p.num_file_snapshots) ?? 0,
      hasFileChanges: p.hasFileChanges === true || p.has_file_changes === true,
      promptPreview: asString(p.promptPreview) ?? asString(p.prompt_preview),
    });
  }
  // Newest first for picker (higher index = later turn).
  out.sort((a, b) => b.promptIndex - a.promptIndex);
  return out;
}

export function parseRewindResponse(raw: unknown): RewindResult {
  const v = unwrapResult(raw);
  const o = asRecord(v);
  if (!o) {
    return {
      success: false,
      targetPromptIndex: 0,
      mode: "all",
      revertedFiles: [],
      cleanFiles: [],
      conflicts: [],
      error: "Invalid rewind response",
    };
  }

  const mode =
    normalizeRewindMode(asString(o.mode)) ??
    normalizeRewindMode(typeof o.mode === "string" ? o.mode : undefined) ??
    "all";

  const conflictsRaw = Array.isArray(o.conflicts) ? o.conflicts : [];
  const conflicts: RewindConflict[] = [];
  for (const c of conflictsRaw) {
    const r = asRecord(c);
    if (!r) {
      continue;
    }
    const path = asString(r.path);
    if (!path) {
      continue;
    }
    conflicts.push({
      path,
      conflictType:
        asString(r.conflictType) ?? asString(r.conflict_type) ?? "conflict",
    });
  }

  const stringList = (key: string, snake: string): string[] => {
    const arr = o[key] ?? o[snake];
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr.filter((x): x is string => typeof x === "string");
  };

  return {
    success: o.success === true,
    targetPromptIndex:
      asNumber(o.targetPromptIndex) ?? asNumber(o.target_prompt_index) ?? 0,
    mode,
    revertedFiles: stringList("revertedFiles", "reverted_files"),
    cleanFiles: stringList("cleanFiles", "clean_files"),
    conflicts,
    promptText: asString(o.promptText) ?? asString(o.prompt_text),
    error: asString(o.error),
  };
}

/** QuickPick / panel label helpers. */
export function formatRewindPointLabel(p: RewindPoint): string {
  const preview = (p.promptPreview ?? "").replace(/\s+/g, " ").trim();
  const short =
    preview.length > 72 ? `${preview.slice(0, 69)}…` : preview || "(empty)";
  return `#${p.promptIndex}  ${short}`;
}

export function formatRewindPointDescription(p: RewindPoint): string {
  const parts: string[] = [];
  if (p.hasFileChanges || p.numFileSnapshots > 0) {
    parts.push(
      p.numFileSnapshots > 0
        ? `${p.numFileSnapshots} file snapshot(s)`
        : "file changes",
    );
  } else {
    parts.push("conversation only");
  }
  const when = formatRewindTimestamp(p.createdAt);
  if (when) {
    parts.push(when);
  }
  return parts.join(" · ");
}

/** Parse optional `/rewind [index] [mode]` args. */
export function parseRewindArgs(args: string): {
  targetPromptIndex?: number;
  mode?: RewindMode;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return {};
  }
  let targetPromptIndex: number | undefined;
  let mode: RewindMode | undefined;
  for (const t of tokens) {
    const asMode = normalizeRewindMode(t);
    if (asMode) {
      mode = asMode;
      continue;
    }
    if (/^\d+$/.test(t)) {
      targetPromptIndex = Number(t);
      continue;
    }
  }
  return { targetPromptIndex, mode };
}

export type PreviewDecision =
  | { kind: "ready" }
  | {
      kind: "confirm_files";
      cleanFiles: string[];
      conflicts: RewindConflict[];
    }
  | {
      kind: "confirm_force";
      conflicts: RewindConflict[];
      error?: string;
    }
  | { kind: "error"; error: string };

/**
 * Decide next step after a force=false preview (TUI confirm / force flow).
 *
 * Important: the shell dry-run **always** returns `success: false` even when
 * the preview is valid (`acp_session_impl/rewind.rs` preview arm). TUI treats
 * that as data for the confirm modal — only a hard failure is
 * `error` with empty clean_files and empty conflicts
 * (`handle_rewind_preview_complete`).
 */
export function decidePreviewAction(
  preview: RewindResult,
  mode: RewindMode,
): PreviewDecision {
  // Hard fail (invalid target, internal error, …) — not a dry-run payload.
  if (
    preview.error?.trim() &&
    preview.cleanFiles.length === 0 &&
    preview.conflicts.length === 0
  ) {
    return {
      kind: "error",
      error: preview.error.trim(),
    };
  }

  if (preview.conflicts.length > 0) {
    return {
      kind: "confirm_force",
      conflicts: preview.conflicts,
      error: preview.error,
    };
  }

  // conversation_only never needs file confirm (TUI skips preview entirely).
  if (mode === "conversation_only") {
    return { kind: "ready" };
  }

  if (preview.cleanFiles.length > 0) {
    return {
      kind: "confirm_files",
      cleanFiles: preview.cleanFiles,
      conflicts: preview.conflicts,
    };
  }

  // File mode with no tracked file changes → execute immediately.
  return { kind: "ready" };
}

export function conflictTypeLabel(conflictType: string): string {
  switch (conflictType) {
    case "deleted_externally":
    case "missing_file":
      return "deleted";
    case "created_externally":
    case "extra_file":
      return "added";
    case "modified_externally":
    case "content_mismatch":
      return "modified";
    default:
      return conflictType || "conflict";
  }
}

export function basenamePath(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/** Human success line for system banner / toast. */
export function formatRewindSuccessMessage(result: RewindResult): string {
  const parts = [`Rewound to before prompt #${result.targetPromptIndex}`];
  if (modeTruncatesConversation(result.mode)) {
    parts.push(
      result.mode === "all" ? "(chat + files)" : "(conversation only)",
    );
  } else {
    parts.push("(files only)");
  }
  if (result.revertedFiles.length > 0) {
    const n = result.revertedFiles.length;
    const sample = result.revertedFiles
      .slice(0, 3)
      .map(basenamePath)
      .join(", ");
    const more = n > 3 ? ` +${n - 3}` : "";
    parts.push(`· ${n} file(s): ${sample}${more}`);
  }
  return parts.join(" ");
}

/** Format ISO / raw timestamps for point rows (best-effort relative). */
export function formatRewindTimestamp(
  raw: string,
  nowMs: number = Date.now(),
): string {
  const s = raw.trim();
  if (!s) {
    return "";
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    // Already human or opaque — show as-is if short.
    return s.length > 24 ? s.slice(0, 21) + "…" : s;
  }
  const delta = Math.max(0, nowMs - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 36) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 14) {
    return `${day}d ago`;
  }
  try {
    return new Date(t).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

/** Serialize points for webview (stable JSON-friendly). */
export function serializeRewindPointsForUi(points: RewindPoint[]): Array<{
  promptIndex: number;
  label: string;
  description: string;
  hasFileChanges: boolean;
  promptPreview?: string;
}> {
  return points.map((p) => ({
    promptIndex: p.promptIndex,
    label: formatRewindPointLabel(p),
    description: formatRewindPointDescription(p),
    hasFileChanges: p.hasFileChanges,
    promptPreview: p.promptPreview,
  }));
}

/** Mode rows for webview / QuickPick. */
export function serializeModesForUi(point: {
  hasFileChanges: boolean;
}): Array<{ mode: RewindMode; label: string; detail: string }> {
  return modesForPoint(point);
}
