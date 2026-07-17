/**
 * Extension-native background work model (TUI Tasks pane equivalent).
 *
 * Sources:
 * - `x.ai/task_backgrounded` / `x.ai/task_completed` (bash + monitors)
 * - `x.ai/session_notification` subagent_* (+ optional scheduled_task_*)
 * - `x.ai/task/list` + `x.ai/subagent/list_running` bootstrap/refresh
 *
 * UI is IDE-native (webview list above the composer), not a ratatui port.
 */

import type { XaiSessionEvent } from "./xaiSessionNotification";

export type WorkKind = "subagent" | "task" | "monitor" | "loop";
export type WorkStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "stopping";

/** One row in the extension Tasks panel. */
export interface BackgroundWorkItem {
  id: string;
  kind: WorkKind;
  /** Short type tag for the UI (Explore, Task, Monitor, Loop). */
  tag: string;
  /** Human title (description / command first line). */
  label: string;
  status: WorkStatus;
  /** Secondary line (schedule, activity, exit). */
  detail?: string;
  startedAtMs?: number;
  /** Last known duration (ms). */
  durationMs?: number;
  outputFile?: string;
  /** Truncated completion output for quick view. */
  outputPreview?: string;
  childSessionId?: string;
  subagentId?: string;
  canKill: boolean;
  canView: boolean;
  /** When status left "running"; used to auto-prune finished rows. */
  finishedAtMs?: number;
}

export interface TasksSnapshot {
  sessionId: string;
  items: BackgroundWorkItem[];
  runningCount: number;
}

/**
 * Evict finished rows from the internal map after this delay (memory).
 * The Tasks **list** hides finished immediately (TUI default `show_done=false`);
 * we only keep them briefly so `get(id)` can still open View right after complete.
 */
export const FINISHED_TTL_MS = 45_000;

export function emptyTasksSnapshot(sessionId = ""): TasksSnapshot {
  return { sessionId, items: [], runningCount: 0 };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
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

function firstLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) {
    return line;
  }
  return line.slice(0, max - 1) + "…";
}

function capitalize(s: string): string {
  if (!s) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kindOrder(k: WorkKind): number {
  switch (k) {
    case "subagent":
      return 0;
    case "task":
      return 1;
    case "monitor":
      return 2;
    case "loop":
      return 3;
  }
}

function isRunningStatus(s: WorkStatus): boolean {
  return s === "running" || s === "stopping";
}

/**
 * Unwrap ExtNotification / SessionNotification envelopes to `{ sessionId, update }`.
 */
export function unwrapTaskNotificationParams(raw: unknown): {
  sessionId: string;
  update: Record<string, unknown>;
} | null {
  let cur: unknown = raw;
  for (let i = 0; i < 4; i++) {
    const o = asRecord(cur);
    if (!o) {
      break;
    }
    if (o.params != null && o.sessionId == null && o.session_id == null) {
      cur = o.params;
      continue;
    }
    if (o.result != null && o.sessionId == null && o.session_id == null) {
      cur = o.result;
      continue;
    }
    break;
  }
  const root = asRecord(cur);
  if (!root) {
    return null;
  }
  const sessionId = asString(root.sessionId) ?? asString(root.session_id) ?? "";
  const update = asRecord(root.update);
  if (!update) {
    return null;
  }
  return { sessionId, update };
}

export function sessionUpdateName(update: Record<string, unknown>): string {
  return (
    asString(update.sessionUpdate) ?? asString(update.session_update) ?? ""
  );
}

/** Parse `x.ai/task_backgrounded` (or same update nested under session_notification). */
export function parseTaskBackgrounded(
  update: Record<string, unknown>,
): BackgroundWorkItem | null {
  const taskId = asString(update.task_id ?? update.taskId);
  if (!taskId) {
    return null;
  }
  const monitorDesc = asString(
    update.monitor_description ?? update.monitorDescription,
  );
  const description = asString(update.description);
  const command = asString(update.command) ?? "";
  const isMonitor = !!monitorDesc;
  const label = firstLine(
    monitorDesc || description || command || "Background task",
  );
  return {
    id: taskId,
    kind: isMonitor ? "monitor" : "task",
    tag: isMonitor ? "Monitor" : "Task",
    label,
    status: "running",
    detail: isMonitor
      ? undefined
      : command
        ? firstLine(command, 80)
        : undefined,
    startedAtMs: Date.now(),
    outputFile: asString(update.output_file ?? update.outputFile),
    canKill: true,
    canView: true,
  };
}

/** Parse `x.ai/task_completed` update (task_snapshot + will_wake). */
export function parseTaskCompleted(
  update: Record<string, unknown>,
  now = Date.now(),
): BackgroundWorkItem | null {
  const snap =
    asRecord(update.task_snapshot) ?? asRecord(update.taskSnapshot) ?? update;
  const taskId = asString(snap.task_id ?? snap.taskId);
  if (!taskId) {
    return null;
  }
  const kindRaw = asString(snap.kind)?.toLowerCase() ?? "bash";
  const isMonitor = kindRaw === "monitor";
  const command =
    asString(snap.display_command ?? snap.displayCommand) ??
    asString(snap.command) ??
    "";
  const exitCode = asNumber(snap.exit_code ?? snap.exitCode);
  const signal = asString(snap.signal);
  const explicitlyKilled = asBool(
    snap.explicitly_killed ?? snap.explicitlyKilled,
  );
  let status: WorkStatus = "done";
  if (explicitlyKilled) {
    status = "cancelled";
  } else if (signal || (exitCode != null && exitCode !== 0)) {
    status = "failed";
  }
  const output = asString(snap.output) ?? "";
  const detailParts: string[] = [];
  if (exitCode != null) {
    detailParts.push(`exit ${exitCode}`);
  }
  if (signal) {
    detailParts.push(signal);
  }
  return {
    id: taskId,
    kind: isMonitor ? "monitor" : "task",
    tag: isMonitor ? "Monitor" : "Task",
    label: firstLine(command || (isMonitor ? "Monitor" : "Background task")),
    status,
    detail: detailParts.join(" · ") || undefined,
    durationMs: undefined,
    outputFile: asString(snap.output_file ?? snap.outputFile),
    outputPreview: output ? firstLine(output, 200) : undefined,
    canKill: false,
    canView: true,
    finishedAtMs: now,
  };
}

export function parseScheduledTaskCreated(
  update: Record<string, unknown>,
): BackgroundWorkItem | null {
  const taskId = asString(update.task_id ?? update.taskId);
  if (!taskId) {
    return null;
  }
  const prompt = asString(update.prompt) ?? "Scheduled task";
  const schedule =
    asString(update.human_schedule ?? update.humanSchedule) ?? "";
  const next = asString(update.next_fire_at ?? update.nextFireAt);
  return {
    id: taskId,
    kind: "loop",
    tag: "Loop",
    label: firstLine(prompt),
    status: "running",
    detail: [schedule, next ? `next ${next}` : ""].filter(Boolean).join(" · "),
    startedAtMs: Date.now(),
    canKill: true,
    canView: false,
  };
}

/** Map a subagent session event into a work item (or partial update). */
export function itemFromSubagentEvent(
  ev: Extract<XaiSessionEvent, { kind: "subagent" }>,
  now = Date.now(),
): BackgroundWorkItem | null {
  const id = asString(ev.subagentId) ?? asString(ev.childSessionId);
  if (!id) {
    return null;
  }
  const typeLabel = capitalize(ev.subagentType ?? "Agent");
  if (ev.phase === "spawned") {
    return {
      id,
      kind: "subagent",
      tag: typeLabel,
      label: firstLine(ev.description ?? "Subagent"),
      status: "running",
      startedAtMs: now,
      childSessionId: ev.childSessionId,
      subagentId: ev.subagentId ?? id,
      canKill: true,
      canView: true,
    };
  }
  if (ev.phase === "progress") {
    return {
      id,
      kind: "subagent",
      tag: typeLabel,
      label: firstLine(ev.description ?? "Subagent"),
      status: "running",
      detail: ev.message,
      childSessionId: ev.childSessionId,
      subagentId: ev.subagentId ?? id,
      canKill: true,
      canView: true,
    };
  }
  // finished
  const st = (ev.status ?? "completed").toLowerCase();
  let status: WorkStatus = "done";
  if (st === "failed") {
    status = "failed";
  } else if (st === "cancelled") {
    status = "cancelled";
  }
  return {
    id,
    kind: "subagent",
    tag: typeLabel,
    label: firstLine(ev.description ?? "Subagent"),
    status,
    detail: ev.message,
    childSessionId: ev.childSessionId,
    subagentId: ev.subagentId ?? id,
    canKill: false,
    canView: true,
    finishedAtMs: now,
  };
}

/** Parse one row from `x.ai/task/list` tasks[]. */
export function itemFromTaskListEntry(
  raw: unknown,
  now = Date.now(),
): BackgroundWorkItem | null {
  const snap = asRecord(raw);
  if (!snap) {
    return null;
  }
  const taskId = asString(snap.task_id ?? snap.taskId);
  if (!taskId) {
    return null;
  }
  const kindRaw = asString(snap.kind)?.toLowerCase() ?? "bash";
  const isMonitor = kindRaw === "monitor";
  const completed = asBool(snap.completed) === true;
  const command =
    asString(snap.display_command ?? snap.displayCommand) ??
    asString(snap.command) ??
    "";
  const exitCode = asNumber(snap.exit_code ?? snap.exitCode);
  const signal = asString(snap.signal);
  const killed = asBool(snap.explicitly_killed ?? snap.explicitlyKilled);
  let status: WorkStatus = "running";
  if (completed) {
    if (killed) {
      status = "cancelled";
    } else if (signal || (exitCode != null && exitCode !== 0)) {
      status = "failed";
    } else {
      status = "done";
    }
  }
  return {
    id: taskId,
    kind: isMonitor ? "monitor" : "task",
    tag: isMonitor ? "Monitor" : "Task",
    label: firstLine(command || (isMonitor ? "Monitor" : "Background task")),
    status,
    detail: completed
      ? exitCode != null
        ? `exit ${exitCode}`
        : undefined
      : undefined,
    startedAtMs: now,
    outputFile: asString(snap.output_file ?? snap.outputFile),
    canKill: !completed,
    canView: true,
    finishedAtMs: completed ? now : undefined,
  };
}

/** Parse one row from `x.ai/subagent/list_running` subagents[]. */
export function itemFromSubagentListEntry(
  raw: unknown,
  now = Date.now(),
): BackgroundWorkItem | null {
  const o = asRecord(raw);
  if (!o) {
    return null;
  }
  const id =
    asString(o.subagent_id ?? o.subagentId) ??
    asString(o.child_session_id ?? o.childSessionId);
  if (!id) {
    return null;
  }
  const typeLabel = capitalize(
    asString(o.subagent_type ?? o.subagentType) ?? "Agent",
  );
  const turns = asNumber(o.turn_count ?? o.turnCount);
  const tools = asNumber(o.tool_call_count ?? o.toolCallCount);
  const pct = asNumber(o.context_usage_pct ?? o.contextUsagePct);
  const detailParts: string[] = [];
  if (turns != null) {
    detailParts.push(`${turns} turns`);
  }
  if (tools != null) {
    detailParts.push(`${tools} tools`);
  }
  if (pct != null) {
    detailParts.push(`${pct}% ctx`);
  }
  return {
    id,
    kind: "subagent",
    tag: typeLabel,
    label: firstLine(asString(o.description) ?? "Subagent"),
    status: "running",
    detail: detailParts.join(" · ") || undefined,
    startedAtMs: asNumber(o.started_at_epoch_ms ?? o.startedAtEpochMs) ?? now,
    durationMs: asNumber(o.duration_ms ?? o.durationMs),
    childSessionId: asString(o.child_session_id ?? o.childSessionId),
    subagentId: asString(o.subagent_id ?? o.subagentId) ?? id,
    canKill: true,
    canView: true,
  };
}

export function unwrapExtResult<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "result" in raw) {
    return (raw as { result: T }).result;
  }
  return raw as T;
}

export function formatElapsed(
  ms: number | undefined,
  now = Date.now(),
): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return "";
  }
  // Epoch timestamps are ~1.7e12; pure durations for agent turns stay smaller.
  const elapsed = ms > 1e12 ? Math.max(0, now - ms) : ms;
  const sec = Math.floor(elapsed / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ${sec % 60}s`;
  }
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/**
 * Mutable store for background work rows.
 */
export class TasksStore {
  private sessionId = "";
  private readonly byId = new Map<string, BackgroundWorkItem>();

  reset(sessionId = ""): void {
    this.sessionId = sessionId;
    this.byId.clear();
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  upsert(item: BackgroundWorkItem): void {
    const prev = this.byId.get(item.id);
    if (!prev) {
      this.byId.set(item.id, item);
      return;
    }
    // Merge: keep richer fields from previous when new is sparse.
    this.byId.set(item.id, {
      ...prev,
      ...item,
      label: item.label || prev.label,
      tag: item.tag || prev.tag,
      detail: item.detail ?? prev.detail,
      startedAtMs: item.startedAtMs ?? prev.startedAtMs,
      durationMs: item.durationMs ?? prev.durationMs,
      outputFile: item.outputFile ?? prev.outputFile,
      outputPreview: item.outputPreview ?? prev.outputPreview,
      childSessionId: item.childSessionId ?? prev.childSessionId,
      subagentId: item.subagentId ?? prev.subagentId,
      finishedAtMs:
        item.finishedAtMs ??
        (isRunningStatus(item.status) ? undefined : prev.finishedAtMs),
    });
  }

  markStopping(id: string): void {
    const prev = this.byId.get(id);
    if (!prev || !isRunningStatus(prev.status)) {
      return;
    }
    this.byId.set(id, {
      ...prev,
      status: "stopping",
      canKill: true,
      detail: "stopping…",
    });
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  get(id: string): BackgroundWorkItem | undefined {
    return this.byId.get(id);
  }

  /** Drop finished rows past TTL; returns true if anything changed. */
  pruneFinished(now = Date.now(), ttlMs = FINISHED_TTL_MS): boolean {
    let changed = false;
    for (const [id, item] of this.byId) {
      if (isRunningStatus(item.status)) {
        continue;
      }
      const fin = item.finishedAtMs ?? now;
      if (now - fin >= ttlMs) {
        this.byId.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  applyTaskNotification(
    sessionId: string,
    update: Record<string, unknown>,
    now = Date.now(),
  ): boolean {
    if (sessionId) {
      this.sessionId = sessionId;
    }
    const name = sessionUpdateName(update);
    if (name === "task_backgrounded") {
      const item = parseTaskBackgrounded(update);
      if (item) {
        this.upsert(item);
        return true;
      }
      return false;
    }
    if (name === "task_completed") {
      const item = parseTaskCompleted(update, now);
      if (item) {
        const prev = this.byId.get(item.id);
        if (prev) {
          item.label = prev.label || item.label;
          item.tag = prev.tag || item.tag;
          item.startedAtMs = prev.startedAtMs;
          if (prev.startedAtMs) {
            item.durationMs = now - prev.startedAtMs;
          }
          item.outputFile = item.outputFile ?? prev.outputFile;
        }
        this.upsert(item);
        return true;
      }
      return false;
    }
    if (name === "scheduled_task_created") {
      const item = parseScheduledTaskCreated(update);
      if (item) {
        this.upsert(item);
        return true;
      }
      return false;
    }
    if (
      name === "scheduled_task_deleted" ||
      name === "scheduled_task_cancelled"
    ) {
      const id = asString(update.task_id ?? update.taskId);
      if (id && this.byId.has(id)) {
        this.remove(id);
        return true;
      }
      return false;
    }
    return false;
  }

  applySubagentEvent(
    ev: Extract<XaiSessionEvent, { kind: "subagent" }>,
    now = Date.now(),
  ): boolean {
    const item = itemFromSubagentEvent(ev, now);
    if (!item) {
      return false;
    }
    if (ev.phase === "progress") {
      const prev = this.byId.get(item.id);
      if (prev) {
        this.upsert({
          ...prev,
          detail: item.detail ?? prev.detail,
          status: "running",
          canKill: true,
        });
        return true;
      }
    }
    if (ev.phase === "finished") {
      const prev = this.byId.get(item.id);
      if (prev) {
        item.label = prev.label || item.label;
        item.tag = prev.tag || item.tag;
        item.startedAtMs = prev.startedAtMs;
        if (prev.startedAtMs) {
          item.durationMs = now - prev.startedAtMs;
        }
      }
    }
    this.upsert(item);
    return true;
  }

  /**
   * Replace task/monitor rows from list API; keep subagents/loops not in list.
   * `runningOnly` keeps completed list rows out of the panel.
   */
  mergeTaskList(
    tasks: unknown[],
    runningOnly = true,
    now = Date.now(),
  ): boolean {
    const seen = new Set<string>();
    let changed = false;
    for (const raw of tasks) {
      const item = itemFromTaskListEntry(raw, now);
      if (!item) {
        continue;
      }
      if (runningOnly && !isRunningStatus(item.status)) {
        continue;
      }
      seen.add(item.id);
      const prev = this.byId.get(item.id);
      if (
        !prev ||
        prev.status !== item.status ||
        prev.label !== item.label ||
        prev.outputFile !== item.outputFile
      ) {
        this.upsert(item);
        changed = true;
      }
    }
    // Drop task/monitor rows that vanished from the running list.
    for (const [id, item] of this.byId) {
      if (item.kind !== "task" && item.kind !== "monitor") {
        continue;
      }
      if (!isRunningStatus(item.status)) {
        continue;
      }
      if (!seen.has(id)) {
        // Don't force-remove; completion notify may lag. Leave as-is.
      }
    }
    return changed;
  }

  mergeSubagentList(subagents: unknown[], now = Date.now()): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const raw of subagents) {
      const item = itemFromSubagentListEntry(raw, now);
      if (!item) {
        continue;
      }
      seen.add(item.id);
      this.upsert(item);
      changed = true;
    }
    // Mark subagents that disappeared as done if still running (optional soft).
    for (const [id, item] of this.byId) {
      if (item.kind !== "subagent" || !isRunningStatus(item.status)) {
        continue;
      }
      if (!seen.has(id) && seen.size > 0) {
        // list_running is authoritative for live set when non-empty response path
        // — only drop if we successfully listed (caller passes empty when fail).
      }
    }
    return changed;
  }

  /**
   * List snapshot for the Tasks pane.
   * Matches TUI default: **only running/stopping** rows (hide completed/failed/
   * cancelled immediately). Finished entries remain in `get()` until TTL prune.
   */
  snapshot(now = Date.now()): TasksSnapshot {
    this.pruneFinished(now);
    const items = [...this.byId.values()]
      .filter((i) => isRunningStatus(i.status))
      .sort((a, b) => {
        const ko = kindOrder(a.kind) - kindOrder(b.kind);
        if (ko !== 0) {
          return ko;
        }
        return (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0);
      });
    return {
      sessionId: this.sessionId,
      items,
      runningCount: items.length,
    };
  }
}

/**
 * Plain-text report for `/tasks` (host) and system blocks.
 * Grouped like the TUI status block: Subagents → Tasks/Monitors → Loops.
 */
export function formatTasksReport(
  snap: TasksSnapshot,
  now = Date.now(),
): string {
  if (snap.items.length === 0) {
    return "No background tasks, subagents, or scheduled loops.";
  }
  const groups: { title: string; kinds: WorkKind[] }[] = [
    { title: "Subagents", kinds: ["subagent"] },
    { title: "Tasks", kinds: ["task"] },
    { title: "Monitors", kinds: ["monitor"] },
    { title: "Loops", kinds: ["loop"] },
  ];
  const lines: string[] = [
    `Background work (${snap.runningCount} running · ${snap.items.length} listed):`,
  ];
  for (const g of groups) {
    const rows = snap.items.filter((i) => g.kinds.includes(i.kind));
    if (rows.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`${g.title}:`);
    for (const i of rows) {
      let elapsed = "";
      if (i.durationMs != null && !isRunningStatus(i.status)) {
        elapsed = formatElapsed(i.durationMs, now);
      } else if (i.startedAtMs != null) {
        elapsed = formatElapsed(i.startedAtMs, now);
      }
      const time = elapsed ? `  (${elapsed})` : "";
      const detail = i.detail ? ` — ${i.detail}` : "";
      lines.push(
        `  ${i.status.padEnd(9)} ${i.tag} · ${i.label}${detail}${time}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Manage in the Tasks panel above the composer (View / Stop), or click the Grok status bar badge.",
  );
  return lines.join("\n");
}

/** Serialize for webview (adds display elapsed). */
export function serializeTasksForWebview(
  snap: TasksSnapshot,
  now = Date.now(),
): {
  sessionId: string;
  runningCount: number;
  items: Array<BackgroundWorkItem & { elapsed: string; statusLabel: string }>;
} {
  return {
    sessionId: snap.sessionId,
    runningCount: snap.runningCount,
    items: snap.items.map((item) => {
      let elapsed = "";
      if (item.durationMs != null && !isRunningStatus(item.status)) {
        elapsed = formatElapsed(item.durationMs, now);
      } else if (item.startedAtMs != null) {
        elapsed = formatElapsed(item.startedAtMs, now);
      } else if (item.durationMs != null) {
        elapsed = formatElapsed(item.durationMs, now);
      }
      const statusLabel =
        item.status === "running"
          ? "running"
          : item.status === "stopping"
            ? "stopping"
            : item.status === "done"
              ? "done"
              : item.status === "failed"
                ? "failed"
                : item.status === "cancelled"
                  ? "cancelled"
                  : item.status;
      return { ...item, elapsed, statusLabel };
    }),
  };
}
