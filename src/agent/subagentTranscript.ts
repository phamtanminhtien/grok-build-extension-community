/**
 * Format `x.ai/subagent/get` snapshots into a readable markdown "transcript"
 * document for the VS Code host (IDE-native view, not TUI fullscreen).
 *
 * Kept free of other local module imports so Node's test runner (strip-types
 * ESM) can load this file without extension-resolution issues.
 */

export interface SubagentSnapshotWire {
  subagentId?: string;
  subagent_id?: string;
  parentSessionId?: string;
  parent_session_id?: string;
  childSessionId?: string;
  child_session_id?: string;
  subagentType?: string;
  subagent_type?: string;
  description?: string;
  startedAtEpochMs?: number;
  started_at_epoch_ms?: number;
  durationMs?: number;
  duration_ms?: number;
  status?: string;
  turnCount?: number;
  turn_count?: number;
  toolCallCount?: number;
  tool_call_count?: number;
  tokensUsed?: number;
  tokens_used?: number;
  contextWindowTokens?: number;
  context_window_tokens?: number;
  contextUsagePct?: number;
  context_usage_pct?: number;
  toolsUsed?: string[];
  tools_used?: string[];
  errorCount?: number;
  error_count?: number;
  output?: string;
  toolCalls?: number;
  tool_calls?: number;
  turns?: number;
  worktreePath?: string;
  worktree_path?: string;
  failureError?: string;
  failure_error?: string;
  cancelReason?: string;
  cancel_reason?: string;
  resumedFrom?: string;
  resumed_from?: string;
}

function pickString(
  o: SubagentSnapshotWire,
  a: keyof SubagentSnapshotWire,
  b: keyof SubagentSnapshotWire,
): string | undefined {
  const v = o[a] ?? o[b];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(
  o: SubagentSnapshotWire,
  a: keyof SubagentSnapshotWire,
  b: keyof SubagentSnapshotWire,
): number | undefined {
  const v = o[a] ?? o[b];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pickStringArray(
  o: SubagentSnapshotWire,
  a: keyof SubagentSnapshotWire,
  b: keyof SubagentSnapshotWire,
): string[] | undefined {
  const v = o[a] ?? o[b];
  return Array.isArray(v)
    ? (v as string[]).filter((x) => typeof x === "string")
    : undefined;
}

/**
 * Parse `x.ai/subagent/get` response (may be wrapped in `{ result: { snapshot } }`).
 */
export function parseSubagentGetResponse(
  raw: unknown,
): SubagentSnapshotWire | null {
  let cur: unknown = raw;
  if (cur && typeof cur === "object" && "result" in cur) {
    cur = (cur as { result: unknown }).result;
  }
  if (!cur || typeof cur !== "object") {
    return null;
  }
  const root = cur as Record<string, unknown>;
  const snap = root.snapshot ?? root;
  if (!snap || typeof snap !== "object") {
    return null;
  }
  return snap as SubagentSnapshotWire;
}

/** Structured model for the in-chat subagent panel (matches plan-panel UX). */
export interface SubagentPanelModel {
  subagentId: string;
  typeLabel: string;
  description: string;
  status: string;
  statusLabel: string;
  duration: string;
  turns?: number;
  toolCalls?: number;
  contextPct?: number;
  canKill: boolean;
  /** Meta chips for the head row. */
  chips: string[];
  /** Markdown for the scroll body (sanitized on host). */
  bodyMarkdown: string;
}

/**
 * Build markdown body for export / fallback. Panel prefers
 * {@link buildSubagentPanelModel}.
 */
export function formatSubagentTranscriptMarkdown(
  snap: SubagentSnapshotWire,
  now = Date.now(),
): string {
  const model = buildSubagentPanelModel(snap, now);
  const lines = [
    `# Subagent · ${model.typeLabel}`,
    "",
    `> ${model.description}`,
    "",
    model.bodyMarkdown,
  ];
  return lines.join("\n");
}

export function subagentTranscriptTitle(snap: SubagentSnapshotWire): string {
  const type = pickString(snap, "subagentType", "subagent_type") ?? "agent";
  const desc = pickString(snap, "description", "description") ?? "subagent";
  const short = desc.length > 40 ? desc.slice(0, 39) + "…" : desc;
  return `Subagent · ${capitalize(type)} · ${short}`;
}

/** Panel model used by the chat webview (same visual language as plan panel). */
export function buildSubagentPanelModel(
  snap: SubagentSnapshotWire,
  now = Date.now(),
): SubagentPanelModel {
  const type = pickString(snap, "subagentType", "subagent_type") ?? "agent";
  const typeLabel = capitalize(type);
  const desc =
    pickString(snap, "description", "description") ?? "(no description)";
  const status = (
    pickString(snap, "status", "status") ?? "unknown"
  ).toLowerCase();
  const subId = pickString(snap, "subagentId", "subagent_id") ?? "";
  const durationMs = pickNumber(snap, "durationMs", "duration_ms");
  const turns =
    pickNumber(snap, "turns", "turns") ??
    pickNumber(snap, "turnCount", "turn_count");
  const toolCalls =
    pickNumber(snap, "toolCalls", "tool_calls") ??
    pickNumber(snap, "toolCallCount", "tool_call_count");
  const tokens = pickNumber(snap, "tokensUsed", "tokens_used");
  const ctxPct = pickNumber(snap, "contextUsagePct", "context_usage_pct");
  const tools = pickStringArray(snap, "toolsUsed", "tools_used");
  const errors = pickNumber(snap, "errorCount", "error_count");
  const output = pickString(snap, "output", "output");
  const fail = pickString(snap, "failureError", "failure_error");
  const cancel = pickString(snap, "cancelReason", "cancel_reason");
  const worktree = pickString(snap, "worktreePath", "worktree_path");
  const resumed = pickString(snap, "resumedFrom", "resumed_from");

  const running = status === "running" || status === "initializing";
  const statusLabel =
    status === "completed"
      ? "done"
      : status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : status === "initializing"
            ? "starting"
            : status === "running"
              ? "running"
              : status;

  const duration =
    durationMs != null ? formatElapsed(durationMs, now) : running ? "…" : "—";

  const chips: string[] = [];
  if (duration && duration !== "—") {
    chips.push(duration);
  }
  if (turns != null) {
    chips.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  }
  if (toolCalls != null) {
    chips.push(`${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
  }
  if (ctxPct != null) {
    chips.push(`${ctxPct}% ctx`);
  }
  if (tokens != null) {
    chips.push(formatTokens(tokens));
  }
  if (errors != null && errors > 0) {
    chips.push(`${errors} err`);
  }
  if (resumed) {
    chips.push("resumed");
  }

  const body: string[] = [];
  body.push(`> ${desc}`, "");

  if (fail) {
    body.push("### Failure", "", "```", fail, "```", "");
  }
  if (cancel) {
    body.push("### Cancelled", "", cancel, "");
  }
  if (tools && tools.length > 0) {
    body.push("### Tools", "");
    for (const t of tools) {
      body.push(`- \`${t}\``);
    }
    body.push("");
  }
  if (worktree) {
    body.push(`**Worktree:** \`${worktree}\``, "");
  }

  body.push("### Output", "");
  if (output && output.trim()) {
    body.push("```", output.trimEnd(), "```");
  } else if (running) {
    body.push(
      "_Still running — use **Refresh** when it finishes for full output._",
    );
  } else {
    body.push("_No output captured._");
  }

  return {
    subagentId: subId,
    typeLabel,
    description: desc,
    status,
    statusLabel,
    duration,
    turns: turns ?? undefined,
    toolCalls: toolCalls ?? undefined,
    contextPct: ctxPct ?? undefined,
    canKill: running,
    chips,
    bodyMarkdown: body.join("\n"),
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M tok`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k tok`;
  }
  return `${n} tok`;
}

function capitalize(s: string): string {
  if (!s) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format duration ms (or epoch start > 1e12) for the status table. */
function formatElapsed(ms: number | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
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
