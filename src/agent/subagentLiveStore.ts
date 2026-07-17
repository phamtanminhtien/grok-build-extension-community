/**
 * Live subagent transcript store — mirrors TUI `subagent_views` routing.
 *
 * Child `session/update` notifications (sessionId = child) are merged into a
 * per-subagent timeline using the same helpers as the main chat, so the
 * in-webview subagent panel can stream thinking / tools / text while running.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  applyAgentMessageChunk,
  applyAgentThoughtChunk,
  applyToolEvent,
  applyUserMessageChunk,
  extractToolContentText,
  finalizeAssistantStream,
  formatToolValue,
  type MergeUiMessage,
  type ToolCard,
} from "../ui/sessionMessageMerge.ts";

export type LiveSubagentStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "stopping";

export interface LiveSubagentStream {
  subagentId: string;
  childSessionId: string;
  typeLabel: string;
  description: string;
  status: LiveSubagentStatus;
  /** Live activity suffix (e.g. "Running: cargo test"). */
  activity?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  messages: MergeUiMessage[];
  currentAssistantId?: string;
  currentUserId?: string;
  /** Bumps on every applied update (UI versioning). */
  generation: number;
}

function uid(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function capitalize(s: string): string {
  if (!s) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function notifSessionId(n: SessionNotification): string {
  const raw = n.sessionId as unknown;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw === "object" && "toString" in raw) {
    return String(raw);
  }
  return "";
}

/**
 * Mutable registry of live child-session streams.
 */
export class SubagentLiveStore {
  private readonly byChild = new Map<string, LiveSubagentStream>();
  /** subagentId → childSessionId */
  private readonly subToChild = new Map<string, string>();

  clear(): void {
    this.byChild.clear();
    this.subToChild.clear();
  }

  /** Register (or refresh) a stream when `subagent_spawned` fires. */
  register(opts: {
    subagentId: string;
    childSessionId: string;
    subagentType?: string;
    description?: string;
  }): LiveSubagentStream {
    const childSessionId = opts.childSessionId || opts.subagentId;
    const subagentId = opts.subagentId || childSessionId;
    const existing = this.byChild.get(childSessionId);
    if (existing) {
      existing.typeLabel =
        capitalize(opts.subagentType || "") || existing.typeLabel;
      if (opts.description) {
        existing.description = opts.description;
      }
      existing.status = "running";
      existing.finishedAtMs = undefined;
      this.subToChild.set(subagentId, childSessionId);
      return existing;
    }
    const stream: LiveSubagentStream = {
      subagentId,
      childSessionId,
      typeLabel: capitalize(opts.subagentType || "agent"),
      description: opts.description || "Subagent",
      status: "running",
      startedAtMs: Date.now(),
      messages: [],
      generation: 0,
    };
    this.byChild.set(childSessionId, stream);
    this.subToChild.set(subagentId, childSessionId);
    // Also allow lookup when subagentId === childSessionId only once.
    if (subagentId !== childSessionId) {
      this.subToChild.set(childSessionId, childSessionId);
    }
    return stream;
  }

  markStopping(id: string): void {
    const s = this.resolve(id);
    if (s && (s.status === "running" || s.status === "stopping")) {
      s.status = "stopping";
      s.activity = "stopping…";
      s.generation += 1;
    }
  }

  finish(
    id: string,
    status: "done" | "failed" | "cancelled",
    detail?: string,
  ): LiveSubagentStream | undefined {
    const s = this.resolve(id);
    if (!s) {
      return undefined;
    }
    s.status = status;
    s.finishedAtMs = Date.now();
    s.activity = detail;
    // Settle open thoughts/tools on the live tail.
    for (const m of s.messages) {
      if (m.type === "assistant") {
        finalizeAssistantStream(m, s.finishedAtMs - s.startedAtMs);
      }
    }
    s.currentAssistantId = undefined;
    s.currentUserId = undefined;
    s.generation += 1;
    return s;
  }

  resolve(id: string): LiveSubagentStream | undefined {
    const byChild = this.byChild.get(id);
    if (byChild) {
      return byChild;
    }
    const child = this.subToChild.get(id);
    if (child) {
      return this.byChild.get(child);
    }
    return undefined;
  }

  isChildSession(sessionId: string): boolean {
    return this.byChild.has(sessionId);
  }

  listRunning(): LiveSubagentStream[] {
    return [...this.byChild.values()].filter(
      (s) => s.status === "running" || s.status === "stopping",
    );
  }

  /**
   * Apply a standard ACP `session/update` for a known child session.
   * Returns true when the update was consumed by a live stream.
   */
  applySessionUpdate(n: SessionNotification): boolean {
    const sid = notifSessionId(n);
    if (!sid) {
      return false;
    }
    const stream = this.byChild.get(sid);
    if (!stream) {
      return false;
    }
    if (stream.status !== "running" && stream.status !== "stopping") {
      // Still accept late chunks briefly after finish? Prefer ignore.
      return false;
    }

    const u = n.update as Record<string, unknown>;
    const kind = String(u.sessionUpdate ?? "");

    const mergeState = {
      messages: stream.messages,
      currentUserId: stream.currentUserId,
      currentAssistantId: stream.currentAssistantId,
      // Treat as history-style so user_message_chunk (task prompt) is kept.
      loadingHistory: true,
    };

    if (kind === "user_message_chunk") {
      const content = u.content as { type?: string; text?: string } | undefined;
      const text = content?.type === "text" ? content.text || "" : "";
      const next = applyUserMessageChunk(mergeState, text, uid);
      if (next) {
        stream.messages = next.messages;
        stream.currentUserId = next.currentUserId;
        stream.currentAssistantId = next.currentAssistantId;
        stream.generation += 1;
      }
      return true;
    }

    if (kind === "agent_message_chunk") {
      const content = u.content as { type?: string; text?: string } | undefined;
      const text = content?.type === "text" ? content.text || "" : "";
      const next = applyAgentMessageChunk(mergeState, text, uid);
      stream.messages = next.messages;
      stream.currentUserId = next.currentUserId;
      stream.currentAssistantId = next.currentAssistantId;
      stream.activity = "Responding…";
      stream.generation += 1;
      return true;
    }

    if (kind === "agent_thought_chunk") {
      const content = u.content as { type?: string; text?: string } | undefined;
      const text = content?.type === "text" ? content.text || "" : "";
      const next = applyAgentThoughtChunk(mergeState, text, uid, {
        running: true,
      });
      stream.messages = next.messages;
      stream.currentUserId = next.currentUserId;
      stream.currentAssistantId = next.currentAssistantId;
      stream.activity = "Thinking…";
      stream.generation += 1;
      return true;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = String(u.toolCallId ?? "");
      if (!toolCallId) {
        return true;
      }
      const title = typeof u.title === "string" ? u.title : undefined;
      const status = typeof u.status === "string" ? u.status : undefined;
      const toolKind = typeof u.kind === "string" ? u.kind : undefined;
      const locations = u.locations as Array<{ path?: string }> | undefined;
      const paths =
        locations?.map((l) => l.path).filter((p): p is string => !!p) ?? [];
      const input = formatToolValue(u.rawInput);
      const contentText = extractToolContentText(u.content);
      const rawOut = formatToolValue(u.rawOutput);
      const output = contentText || rawOut || undefined;

      const next = applyToolEvent(
        mergeState,
        {
          id: toolCallId,
          title,
          status,
          kind: toolKind,
          paths,
          input,
          output,
        },
        uid,
      );
      stream.messages = next.messages;
      stream.currentUserId = next.currentUserId;
      stream.currentAssistantId = next.currentAssistantId;
      if (title) {
        const running =
          !status ||
          /run|progress|pending|in_progress|start|stream/i.test(status);
        stream.activity = running
          ? `Running: ${title}`
          : status
            ? `${title} (${status})`
            : title;
      }
      stream.generation += 1;
      return true;
    }

    // Ignore other update kinds for child streams (usage, etc.).
    return true;
  }

  /**
   * No-op reserved for future warm-up. We intentionally do **not** inject an
   * empty assistant shell — that only triggers main-chat stream shimmer and
   * looks wrong in the subagent panel while the child is still quiet.
   */
  ensureStarted(_id: string): void {
    /* intentionally empty */
  }

  /** Find tool card by id across all streams (for activity only). */
  findTool(toolCallId: string): ToolCard | undefined {
    for (const s of this.byChild.values()) {
      for (const m of s.messages) {
        if (m.type !== "assistant") {
          continue;
        }
        for (const item of m.items) {
          if (item.kind === "tool" && item.tool.id === toolCallId) {
            return item.tool;
          }
        }
      }
    }
    return undefined;
  }
}

export function liveStreamElapsed(
  s: LiveSubagentStream,
  now = Date.now(),
): number {
  const end = s.finishedAtMs ?? now;
  return Math.max(0, end - s.startedAtMs);
}
