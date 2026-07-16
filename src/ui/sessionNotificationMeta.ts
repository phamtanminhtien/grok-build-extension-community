/**
 * Parse Grok Build / xAI session notification `_meta` (same keys as TUI
 * `NotificationMeta` in xai-grok-pager).
 *
 * The shell stamps `totalTokens` on nearly every session/update — that is how
 * the TUI context bar and turn-status `⇣Nk` stay live. Standard ACP
 * `usage_update` is optional and often absent.
 */

export interface SessionNotificationMeta {
  totalTokens?: number;
  turnStartMs?: number;
  streamStartMs?: number;
  agentTimestampMs?: number;
  promptId?: string;
  isReplay?: boolean;
  eventId?: string;
}

function asFiniteNumber(v: unknown): number | undefined {
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Extract typed meta from a SessionNotification-like object.
 * Accepts `_meta` (wire/SDK) or `meta` (some intermediate shapes).
 */
export function parseSessionNotificationMeta(
  notification: unknown,
): SessionNotificationMeta {
  if (!notification || typeof notification !== "object") {
    return {};
  }
  const n = notification as Record<string, unknown>;
  const raw = n._meta ?? n.meta;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const m = raw as Record<string, unknown>;
  return {
    totalTokens: asFiniteNumber(m.totalTokens),
    turnStartMs: asFiniteNumber(m.turnStartMs),
    streamStartMs: asFiniteNumber(m.streamStartMs),
    agentTimestampMs: asFiniteNumber(m.agentTimestampMs),
    promptId: asString(m.promptId),
    isReplay: typeof m.isReplay === "boolean" ? m.isReplay : undefined,
    eventId: asString(m.eventId),
  };
}
