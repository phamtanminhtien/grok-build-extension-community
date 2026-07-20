/**
 * Wire builders/parsers for `x.ai/git/worktree/*` ACP extension methods.
 * Pure — no vscode / agent imports (unit-testable).
 *
 * Server: xai-grok-shell `extensions/worktree.rs`
 * CLI:   xai-grok-pager `worktree_cmd/`
 * Types: xai-fast-worktree `WorktreeRecord`, workspace-types apply/create.
 */

export const WORKTREE_METHODS = {
  list: "x.ai/git/worktree/list",
  show: "x.ai/git/worktree/show",
  remove: "x.ai/git/worktree/remove",
  apply: "x.ai/git/worktree/apply",
  create: "x.ai/git/worktree/create",
  gc: "x.ai/git/worktree/gc",
  status: "x.ai/git/worktree/status",
} as const;

export type WorktreeKind =
  | "session"
  | "ab"
  | "pool"
  | "fork"
  | "manual"
  | "subagent"
  | string;

export type WorktreeAliveStatus = "alive" | "dead" | string;

export type ApplyMode = "overwrite" | "merge";

/** Tracked worktree row from list/show (camel or snake tolerant). */
export interface WorktreeRecord {
  id: string;
  path: string;
  sourceRepo: string;
  repoName: string;
  kind: WorktreeKind;
  creationMode: string;
  gitRef?: string;
  headCommit?: string;
  sessionId?: string;
  creatorPid?: number;
  createdAt: number;
  lastAccessedAt?: number;
  status: WorktreeAliveStatus;
  /** Optional metadata.label from agent. */
  label?: string;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  resolvedPath?: string;
}

export interface GcReport {
  deadRemoved: number;
  expiredRemoved: number;
  skippedAlive: number;
  removeFailed: number;
}

export interface ApplySuccess {
  status: "success";
  files: { path: string }[];
  gitRoot: string;
}

export interface ApplyConflicts {
  status: "conflicts";
  files: { path: string }[];
  conflicts: { path: string; type?: string }[];
}

export type ApplyResult = ApplySuccess | ApplyConflicts;

export interface CreateWorktreeResult {
  status: "creating" | "exists" | string;
  sessionId?: string;
  worktreePath?: string;
  commit?: string;
  sourceGitRoot?: string;
}

/** Progress notification payload (`x.ai/git/worktree/status`). */
export interface WorktreeStatusEvent {
  status: string;
  sessionId?: string;
  message?: string;
  worktreePath?: string;
  commit?: string;
  phase?: string;
  current?: number;
  total?: number;
  currentFile?: string;
  raw: Record<string, unknown>;
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
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  return undefined;
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

function pathString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  // PathBuf-like { path? } not expected; serde PathBuf → string
  return undefined;
}

function extractLabel(meta: unknown): string | undefined {
  const m = asRecord(meta);
  if (!m) {
    return undefined;
  }
  return asString(m.label) ?? asString(m.Label);
}

export function listWorktreeParams(opts?: {
  repo?: string;
  types?: string[];
  includeAll?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: opts?.types ?? [],
    // CLI uses camelCase; some agents expect snake — send both.
    includeAll: opts?.includeAll === true,
    include_all: opts?.includeAll === true,
  };
  if (opts?.repo) {
    body.repo = opts.repo;
  }
  return body;
}

export function showWorktreeParams(idOrPath: string): Record<string, unknown> {
  return { idOrPath: idOrPath };
}

export function removeWorktreeParams(opts: {
  idOrPath: string;
  force?: boolean;
  dryRun?: boolean;
}): Record<string, unknown> {
  return {
    idOrPath: opts.idOrPath,
    force: opts.force === true,
    dryRun: opts.dryRun === true,
  };
}

export function applyWorktreeParams(opts: {
  sessionId: string;
  worktreePath: string;
  mode?: ApplyMode;
}): Record<string, unknown> {
  return {
    sessionId: opts.sessionId,
    worktreePath: opts.worktreePath,
    mode: opts.mode ?? "overwrite",
  };
}

export function createWorktreeParams(opts: {
  sessionId: string;
  sourcePath: string;
  label?: string;
  copyMode?: "clean" | "dirty";
  gitRef?: string;
  worktreeType?: "linked" | "standalone" | "git";
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionId: opts.sessionId,
    sourcePath: opts.sourcePath,
    copyMode: opts.copyMode ?? "dirty",
  };
  if (opts.label) {
    body.label = opts.label;
  }
  if (opts.gitRef) {
    body.gitRef = opts.gitRef;
  }
  if (opts.worktreeType) {
    body.worktreeType = opts.worktreeType;
  }
  return body;
}

export function gcWorktreeParams(opts?: {
  dryRun?: boolean;
  maxAge?: string;
  force?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dryRun: opts?.dryRun === true,
    force: opts?.force === true,
  };
  if (opts?.maxAge) {
    body.maxAge = opts.maxAge;
  }
  return body;
}

export function parseWorktreeRecord(raw: unknown): WorktreeRecord | null {
  const o = asRecord(raw);
  if (!o) {
    return null;
  }
  const id = asString(o.id);
  const path =
    pathString(o.path) ??
    pathString(o.worktree_path) ??
    pathString(o.worktreePath);
  if (!id || !path) {
    return null;
  }
  const sourceRepo =
    pathString(o.source_repo) ??
    pathString(o.sourceRepo) ??
    pathString(o.source_path) ??
    "";
  const repoName =
    asString(o.repo_name) ?? asString(o.repoName) ?? asString(o.repo) ?? "";
  const kind = (asString(o.kind) ??
    asString(o.type) ??
    "manual") as WorktreeKind;
  const creationMode =
    asString(o.creation_mode) ?? asString(o.creationMode) ?? "";
  const status = (asString(o.status) ?? "alive") as WorktreeAliveStatus;
  const createdAt = asNumber(o.created_at) ?? asNumber(o.createdAt) ?? 0;
  return {
    id,
    path,
    sourceRepo,
    repoName,
    kind,
    creationMode,
    gitRef: asString(o.git_ref) ?? asString(o.gitRef),
    headCommit: asString(o.head_commit) ?? asString(o.headCommit),
    sessionId: asString(o.session_id) ?? asString(o.sessionId),
    creatorPid: asNumber(o.creator_pid) ?? asNumber(o.creatorPid),
    createdAt,
    lastAccessedAt: asNumber(o.last_accessed_at) ?? asNumber(o.lastAccessedAt),
    status,
    label: extractLabel(o.metadata),
  };
}

export function parseWorktreeListResponse(raw: unknown): WorktreeRecord[] {
  const unwrapped = unwrapResult(raw);
  if (!Array.isArray(unwrapped)) {
    // Some agents wrap: { worktrees: [...] }
    const o = asRecord(unwrapped);
    const arr = o?.worktrees ?? o?.records ?? o?.items;
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .map(parseWorktreeRecord)
      .filter((r): r is WorktreeRecord => r != null);
  }
  return unwrapped
    .map(parseWorktreeRecord)
    .filter((r): r is WorktreeRecord => r != null);
}

export function parseWorktreeShowResponse(raw: unknown): WorktreeRecord | null {
  const unwrapped = unwrapResult(raw);
  if (unwrapped == null) {
    return null;
  }
  return parseWorktreeRecord(unwrapped);
}

export function parseRemoveWorktreeResponse(
  raw: unknown,
): RemoveWorktreeResult {
  const unwrapped = unwrapResult(raw);
  const o = asRecord(unwrapped);
  if (!o) {
    return { removed: false };
  }
  return {
    removed: o.removed === true,
    resolvedPath:
      asString(o.resolved_path) ?? asString(o.resolvedPath) ?? undefined,
  };
}

export function parseGcReport(raw: unknown): GcReport {
  const unwrapped = unwrapResult(raw);
  const o = asRecord(unwrapped) ?? {};
  return {
    deadRemoved: asNumber(o.dead_removed) ?? asNumber(o.deadRemoved) ?? 0,
    expiredRemoved:
      asNumber(o.expired_removed) ?? asNumber(o.expiredRemoved) ?? 0,
    skippedAlive: asNumber(o.skipped_alive) ?? asNumber(o.skippedAlive) ?? 0,
    removeFailed: asNumber(o.remove_failed) ?? asNumber(o.removeFailed) ?? 0,
  };
}

export function parseApplyResponse(raw: unknown): ApplyResult | null {
  const unwrapped = unwrapResult(raw);
  const o = asRecord(unwrapped);
  if (!o) {
    return null;
  }
  const status = asString(o.status) ?? "";
  const filesRaw = Array.isArray(o.files) ? o.files : [];
  const files = filesRaw
    .map((f) => {
      const fr = asRecord(f);
      const p = fr ? asString(fr.path) : undefined;
      return p ? { path: p } : null;
    })
    .filter((x): x is { path: string } => x != null);

  if (status === "conflicts") {
    const conflictsRaw = Array.isArray(o.conflicts) ? o.conflicts : [];
    const conflicts = conflictsRaw
      .map((c) => {
        const cr = asRecord(c);
        if (!cr) {
          return null;
        }
        const p = asString(cr.path);
        if (!p) {
          return null;
        }
        return {
          path: p,
          type: asString(cr.type) ?? asString(cr.change_type),
        };
      })
      .filter((x): x is { path: string; type?: string } => x != null);
    return { status: "conflicts", files, conflicts };
  }

  if (
    status === "success" ||
    files.length > 0 ||
    asString(o.gitRoot) ||
    asString(o.git_root)
  ) {
    return {
      status: "success",
      files,
      gitRoot: asString(o.gitRoot) ?? asString(o.git_root) ?? "",
    };
  }
  return null;
}

export function parseCreateWorktreeResponse(
  raw: unknown,
): CreateWorktreeResult | null {
  const unwrapped = unwrapResult(raw);
  const o = asRecord(unwrapped);
  if (!o) {
    return null;
  }
  return {
    status: asString(o.status) ?? "unknown",
    sessionId: asString(o.sessionId) ?? asString(o.session_id),
    worktreePath: asString(o.worktreePath) ?? asString(o.worktree_path),
    commit: asString(o.commit),
    sourceGitRoot: asString(o.sourceGitRoot) ?? asString(o.source_git_root),
  };
}

export function parseWorktreeStatusNotification(
  raw: unknown,
): WorktreeStatusEvent | null {
  const o = asRecord(raw) ?? asRecord(unwrapResult(raw));
  if (!o) {
    return null;
  }
  // Nested params envelope
  const nested = asRecord(o.params) ?? o;
  const status = asString(nested.status);
  if (!status) {
    return null;
  }
  return {
    status,
    sessionId: asString(nested.sessionId) ?? asString(nested.session_id),
    message: asString(nested.message),
    worktreePath:
      asString(nested.worktreePath) ?? asString(nested.worktree_path),
    commit: asString(nested.commit),
    phase: asString(nested.phase),
    current: asNumber(nested.current),
    total: asNumber(nested.total),
    currentFile: asString(nested.currentFile) ?? asString(nested.current_file),
    raw: nested,
  };
}

/** Human age string from unix seconds (CLI `format_age` parity). */
export function formatWorktreeAge(
  createdAtSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  if (!createdAtSec || createdAtSec <= 0) {
    return "—";
  }
  const delta = Math.max(0, nowSec - createdAtSec);
  if (delta < 60) {
    return `${delta}s`;
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m`;
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)}h`;
  }
  return `${Math.floor(delta / 86400)}d`;
}

export function formatWorktreeLabel(rec: WorktreeRecord): string {
  const title = rec.label || rec.id;
  const kind = rec.kind || "worktree";
  return `$(git-branch) ${title}  ·  ${kind}`;
}

export function formatWorktreeDescription(rec: WorktreeRecord): string {
  const branch = rec.gitRef ?? "(detached)";
  const age = formatWorktreeAge(rec.createdAt);
  const repo = rec.repoName || "repo";
  return `${repo} · ${branch} · ${age} · ${rec.status}`;
}

export function formatWorktreeDetail(rec: WorktreeRecord): string {
  return rec.path;
}

export function formatGcReportMessage(r: GcReport, dryRun: boolean): string {
  const prefix = dryRun ? "GC dry-run" : "GC";
  const parts = [
    `dead ${r.deadRemoved}`,
    `expired ${r.expiredRemoved}`,
    `skipped alive ${r.skippedAlive}`,
  ];
  if (r.removeFailed > 0) {
    parts.push(`failed ${r.removeFailed}`);
  }
  return `${prefix}: ${parts.join(", ")}`;
}

export function formatStatusToast(ev: WorktreeStatusEvent): string {
  switch (ev.status) {
    case "progress":
    case "analyzing":
      return ev.message ? `Worktree: ${ev.message}` : `Worktree ${ev.status}…`;
    case "copyingChanges": {
      const frac =
        ev.total != null && ev.current != null
          ? ` (${ev.current}/${ev.total})`
          : "";
      const file = ev.currentFile ? ` ${ev.currentFile}` : "";
      return `Worktree copying${frac}${file}`;
    }
    case "copyingIgnored":
      return ev.message
        ? `Worktree: ${ev.message}`
        : "Worktree copying ignored files…";
    case "created":
      return ev.worktreePath
        ? `Worktree ready: ${ev.worktreePath}`
        : "Worktree created";
    case "error":
      return ev.message
        ? `Worktree error: ${ev.message}`
        : "Worktree creation failed";
    case "sourceInfo":
      return "Worktree: analyzing source…";
    default:
      return ev.message
        ? `Worktree (${ev.status}): ${ev.message}`
        : `Worktree: ${ev.status}`;
  }
}
