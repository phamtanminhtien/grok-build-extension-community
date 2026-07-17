/**
 * Parse Grok `x.ai/session_notification` (and replay-path `x.ai/session/update`
 * when wrapped the same way). Wire shape matches
 * `xai-grok-shell::extensions::notification::{SessionNotification, SessionUpdate}`.
 *
 * Only the variants the VS Code host surfaces as banners/status are decoded:
 * retry, auto-compact, subagent lifecycle, pending/resolved interactions.
 */

export type XaiSessionEvent =
  | {
      kind: "retry";
      phase: "retrying" | "exhausted" | "failed";
      message: string;
      attempt?: number;
      maxRetries?: number;
      isRateLimited?: boolean;
      errorType?: string;
    }
  | {
      kind: "auto_compact";
      phase: "started" | "completed" | "failed" | "cancelled";
      message: string;
      tokensBefore?: number;
      tokensAfter?: number;
      percentage?: number;
    }
  | {
      kind: "subagent";
      phase: "spawned" | "progress" | "finished";
      message: string;
      /** Coordinator id (use for cancel). Often same as childSessionId. */
      subagentId?: string;
      childSessionId?: string;
      subagentType?: string;
      description?: string;
      status?: string;
    }
  | {
      kind: "interaction";
      phase: "pending" | "resolved";
      message: string;
      toolCallId: string;
      interactionKind?: "permission" | "question" | "plan_approval" | string;
    }
  | { kind: "unknown"; sessionUpdate: string };

export interface ParsedXaiSessionNotification {
  sessionId: string;
  events: XaiSessionEvent[];
  /** Raw update object for debugging / forward-compat. */
  rawUpdate?: Record<string, unknown>;
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

/**
 * Unwrap nested ExtNotification params:
 * `{ method, params }` or direct `{ sessionId, update }`.
 */
export function unwrapSessionNotificationParams(raw: unknown): unknown {
  let cur: unknown = raw;
  for (let i = 0; i < 3; i++) {
    const o = asRecord(cur);
    if (!o) {
      break;
    }
    // Nested: { method: "x.ai/session_notification", params: { sessionId, update } }
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
  return cur;
}

/**
 * Parse a fire-and-forget `x.ai/session_notification` payload into UI events.
 * Returns null when the envelope is unusable.
 */
export function parseXaiSessionNotification(
  raw: unknown,
): ParsedXaiSessionNotification | null {
  const unwrapped = unwrapSessionNotificationParams(raw);
  const root = asRecord(unwrapped);
  if (!root) {
    return null;
  }
  const sessionId = asString(root.sessionId) ?? asString(root.session_id) ?? "";
  const update = asRecord(root.update);
  if (!update) {
    return null;
  }
  const sessionUpdate =
    asString(update.sessionUpdate) ?? asString(update.session_update) ?? "";
  if (!sessionUpdate) {
    return null;
  }

  const events = decodeUpdate(sessionUpdate, update);
  return {
    sessionId,
    events,
    rawUpdate: update,
  };
}

function decodeUpdate(
  sessionUpdate: string,
  u: Record<string, unknown>,
): XaiSessionEvent[] {
  switch (sessionUpdate) {
    case "retry_state":
      return [decodeRetry(u)];
    case "auto_compact_started":
      return [
        {
          kind: "auto_compact",
          phase: "started",
          message: formatCompactStarted(u),
          percentage: asNumber(u.percentage),
        },
      ];
    case "auto_compact_completed":
      return [
        {
          kind: "auto_compact",
          phase: "completed",
          message: formatCompactCompleted(u),
          tokensBefore: asNumber(u.tokens_before ?? u.tokensBefore),
          tokensAfter: asNumber(u.tokens_after ?? u.tokensAfter),
        },
      ];
    case "auto_compact_failed":
      return [
        {
          kind: "auto_compact",
          phase: "failed",
          message: `Compaction failed: ${asString(u.error) ?? "unknown error"}`,
        },
      ];
    case "auto_compact_cancelled":
      return [
        {
          kind: "auto_compact",
          phase: "cancelled",
          message: "Compaction cancelled",
        },
      ];
    case "subagent_spawned":
      return [decodeSubagentSpawned(u)];
    case "subagent_progress":
      return [decodeSubagentProgress(u)];
    case "subagent_finished":
      return [decodeSubagentFinished(u)];
    case "pending_interaction":
      return [decodePending(u)];
    case "interaction_resolved":
      return [decodeResolved(u)];
    default:
      return [{ kind: "unknown", sessionUpdate }];
  }
}

function decodeRetry(u: Record<string, unknown>): XaiSessionEvent {
  const type =
    asString(u.type)?.toLowerCase() ??
    // Flattened retrying without type (seen in some leader fixtures).
    (asNumber(u.attempt) != null ? "retrying" : undefined);

  if (type === "retrying") {
    const attempt = asNumber(u.attempt) ?? 0;
    const maxRetries = asNumber(u.maxRetries ?? u.max_retries) ?? 0;
    const reason = asString(u.reason) ?? "transient error";
    return {
      kind: "retry",
      phase: "retrying",
      attempt,
      maxRetries,
      message:
        maxRetries > 0
          ? `Retrying (${attempt}/${maxRetries}): ${reason}`
          : `Retrying: ${reason}`,
    };
  }
  if (type === "exhausted") {
    const attempts = asNumber(u.attempts) ?? 0;
    const reason = asString(u.reason) ?? "retries exhausted";
    const isRateLimited = !!(u.isRateLimited ?? u.is_rate_limited);
    return {
      kind: "retry",
      phase: "exhausted",
      attempt: attempts,
      isRateLimited,
      message: isRateLimited
        ? `Rate limited after ${attempts} attempt(s): ${reason}`
        : `Retries exhausted (${attempts}): ${reason}`,
    };
  }
  // failed or unknown
  const errorType = asString(u.errorType ?? u.error_type);
  const message = asString(u.message) ?? asString(u.reason) ?? "Request failed";
  return {
    kind: "retry",
    phase: "failed",
    errorType,
    message: errorType ? `${errorType}: ${message}` : message,
  };
}

function formatCompactStarted(u: Record<string, unknown>): string {
  const pct = asNumber(u.percentage);
  const reason = asString(u.reason);
  if (pct != null && reason) {
    return `Compacting conversation (${pct}% context) — ${reason}`;
  }
  if (pct != null) {
    return `Compacting conversation (${pct}% context)…`;
  }
  return reason
    ? `Compacting conversation — ${reason}`
    : "Compacting conversation…";
}

function formatCompactCompleted(u: Record<string, unknown>): string {
  const before = asNumber(u.tokens_before ?? u.tokensBefore);
  const after = asNumber(u.tokens_after ?? u.tokensAfter);
  if (before != null && after != null) {
    return `Compacted conversation: ${formatTokens(before)} → ${formatTokens(after)} tokens`;
  }
  if (after != null) {
    return `Compacted conversation → ${formatTokens(after)} tokens`;
  }
  const preview = asString(u.summary_preview ?? u.summaryPreview);
  return preview
    ? `Compacted conversation — ${preview.slice(0, 80)}`
    : "Compacted conversation";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}

function decodeSubagentSpawned(u: Record<string, unknown>): XaiSessionEvent {
  const childSessionId = asString(u.child_session_id ?? u.childSessionId);
  const subagentId = asString(u.subagent_id ?? u.subagentId) ?? childSessionId;
  const subagentType = asString(u.subagent_type ?? u.subagentType) ?? "agent";
  const description = asString(u.description) ?? "task";
  return {
    kind: "subagent",
    phase: "spawned",
    subagentId,
    childSessionId,
    subagentType,
    description,
    message: `Subagent started (${subagentType}): ${description}`,
  };
}

function decodeSubagentProgress(u: Record<string, unknown>): XaiSessionEvent {
  const childSessionId = asString(u.child_session_id ?? u.childSessionId);
  const subagentId = asString(u.subagent_id ?? u.subagentId) ?? childSessionId;
  const turns = asNumber(u.turn_count ?? u.turnCount) ?? 0;
  const tools = asNumber(u.tool_call_count ?? u.toolCallCount) ?? 0;
  const pct = asNumber(u.context_usage_pct ?? u.contextUsagePct);
  const pctPart = pct != null ? `, ${pct}% context` : "";
  return {
    kind: "subagent",
    phase: "progress",
    subagentId,
    childSessionId,
    message: `Subagent running… ${turns} turns, ${tools} tools${pctPart}`,
  };
}

function decodeSubagentFinished(u: Record<string, unknown>): XaiSessionEvent {
  const childSessionId = asString(u.child_session_id ?? u.childSessionId);
  const subagentId = asString(u.subagent_id ?? u.subagentId) ?? childSessionId;
  const status = asString(u.status) ?? "completed";
  const error = asString(u.error);
  const desc =
    status === "failed" && error
      ? `Subagent failed: ${error}`
      : status === "cancelled"
        ? "Subagent cancelled"
        : `Subagent ${status}`;
  return {
    kind: "subagent",
    phase: "finished",
    subagentId,
    childSessionId,
    status,
    message: desc,
  };
}

function decodePending(u: Record<string, unknown>): XaiSessionEvent {
  const toolCallId = asString(u.tool_call_id ?? u.toolCallId) ?? "";
  const kind = (asString(u.kind) ?? "permission").toLowerCase();
  const label =
    kind === "plan_approval"
      ? "Waiting for plan approval"
      : kind === "question"
        ? "Waiting for your answer"
        : "Waiting for permission";
  return {
    kind: "interaction",
    phase: "pending",
    toolCallId,
    interactionKind: kind,
    message: label,
  };
}

function decodeResolved(u: Record<string, unknown>): XaiSessionEvent {
  const toolCallId = asString(u.tool_call_id ?? u.toolCallId) ?? "";
  return {
    kind: "interaction",
    phase: "resolved",
    toolCallId,
    message: "Interaction resolved",
  };
}

/**
 * Human banner text for an event, or null when the host should stay silent
 * (unknown updates, transient progress noise).
 */
export function bannerTextForEvent(ev: XaiSessionEvent): string | null {
  switch (ev.kind) {
    case "retry":
      return ev.message;
    case "auto_compact":
      return ev.message;
    case "subagent":
      // Progress is noisy; only show spawn/finish as system lines.
      if (ev.phase === "progress") {
        return null;
      }
      return ev.message;
    case "interaction":
      // Permission / question / plan_approval reverse-requests open real UI
      // (popovers or the plan panel). System banners only confuse order —
      // e.g. "Waiting for plan approval" before/after the user's
      // "Requested plan changes" / "Plan approved" lines.
      return null;
    case "unknown":
      return null;
  }
}
