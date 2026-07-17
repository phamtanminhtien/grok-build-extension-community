/**
 * Server-authoritative prompt queue types (Grok TUI / xai-prompt-queue wire).
 *
 * Broadcast: `x.ai/queue/changed`
 * Ops (fire-and-forget notifications): remove | reorder | clear | edit | interject
 */

export interface QueueEntryWire {
  id: string;
  version: number;
  owner?: string;
  lastEditor?: string;
  kind: string;
  text: string;
  /** 0-based position among queued, not-yet-running prompts. */
  position: number;
  /** Client-only: true until confirmed by a queue/changed broadcast. */
  optimistic?: boolean;
}

export interface QueueChanged {
  sessionId: string;
  entries: QueueEntryWire[];
  runningPromptId?: string;
}

export interface PromptQueueSnapshot {
  sessionId: string;
  entries: QueueEntryWire[];
  runningPromptId?: string;
}

export function emptyQueueSnapshot(sessionId = ""): PromptQueueSnapshot {
  return { sessionId, entries: [], runningPromptId: undefined };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function parseQueueEntry(raw: unknown, index = 0): QueueEntryWire | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const id = asString(o.id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    version: asNumber(o.version, 0),
    owner: asString(o.owner),
    lastEditor: asString(o.lastEditor),
    kind: asString(o.kind) ?? "",
    text: asString(o.text) ?? "",
    position: asNumber(o.position, index),
  };
}

/**
 * Parse `x.ai/queue/changed` params (camelCase wire).
 */
export function parseQueueChanged(raw: unknown): QueueChanged | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const sessionId = asString(o.sessionId) ?? asString(o.session_id);
  if (!sessionId) {
    return undefined;
  }
  const entriesRaw = Array.isArray(o.entries) ? o.entries : [];
  const entries: QueueEntryWire[] = [];
  for (let i = 0; i < entriesRaw.length; i++) {
    const e = parseQueueEntry(entriesRaw[i], i);
    if (e) {
      entries.push(e);
    }
  }
  const running =
    asString(o.runningPromptId) ?? asString(o.running_prompt_id) ?? undefined;
  return {
    sessionId,
    entries,
    runningPromptId: running || undefined,
  };
}

/**
 * Merge a server broadcast with any still-unconfirmed optimistic rows.
 * Confirmed optimistic ids (present in broadcast) drop the optimistic flag.
 * Unconfirmed optimistics that still match by id or text are re-pinned at the end.
 */
export function reconcileQueue(
  prev: PromptQueueSnapshot,
  changed: QueueChanged,
): PromptQueueSnapshot {
  const serverIds = new Set(changed.entries.map((e) => e.id));
  const serverTexts = new Set(
    changed.entries.map((e) => e.text.trim()).filter(Boolean),
  );

  const merged: QueueEntryWire[] = changed.entries.map((e, i) => ({
    ...e,
    position: e.position ?? i,
    optimistic: false,
  }));

  // Re-pin optimistic echoes not yet visible under any server id/text.
  for (const o of prev.entries) {
    if (!o.optimistic) {
      continue;
    }
    if (serverIds.has(o.id)) {
      continue;
    }
    const t = o.text.trim();
    if (t && serverTexts.has(t)) {
      // Content matched a server row under a different id — drop client echo.
      continue;
    }
    merged.push({
      ...o,
      position: merged.length,
      optimistic: true,
    });
  }

  return {
    sessionId: changed.sessionId,
    entries: merged.map((e, i) => ({ ...e, position: i })),
    runningPromptId: changed.runningPromptId,
  };
}

export function makeOptimisticEntry(
  id: string,
  text: string,
  kind = "prompt",
  position = 0,
): QueueEntryWire {
  return {
    id,
    version: 0,
    kind,
    text,
    position,
    optimistic: true,
    owner: "grok-vscode",
  };
}

/** First non-empty line for compact queue UI. */
export function queueEntryFirstLine(text: string, max = 80): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (line.length <= max) {
    return line;
  }
  return `${line.slice(0, max - 1)}…`;
}

export function newPromptId(): string {
  // crypto.randomUUID is available in VS Code extension host (Node 19+ / modern Electron).
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
