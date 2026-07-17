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

/** QuickPick label helpers. */
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
  if (p.createdAt) {
    parts.push(p.createdAt);
  }
  return parts.join(" · ");
}
