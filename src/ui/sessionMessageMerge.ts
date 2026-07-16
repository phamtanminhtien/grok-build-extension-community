/**
 * Pure helpers for merging ACP session/update chunks into the chat message list.
 *
 * Live turns push an optimistic user + empty assistant in handleSend. The agent
 * then echoes user_message_chunk; treating that like history replay duplicates
 * the question and clears currentAssistantId, leaving a leftover empty assistant
 * when a second assistant is created for the reply.
 *
 * Assistant content is a timeline of items (thoughts, text segments, tool calls)
 * so each block appears where it happened in the stream — matching TUI scrollback
 * order instead of bunched/merged fields.
 */

const DETAIL_MAX = 8000;

export interface ToolCard {
  id: string;
  title: string;
  status: string;
  kind?: string;
  paths: string[];
  /** Human-readable tool input (command, args, …) for expand detail. */
  input?: string;
  /** Human-readable tool output / result for expand detail. */
  output?: string;
}

/** One thinking phase on the timeline (TUI ThinkingBlock). */
export interface ThoughtSegment {
  id: string;
  text: string;
  /** True while thought chunks are still streaming. */
  running?: boolean;
  /** Frozen wall-clock ms for "Thought for Xs" (live turns only). */
  elapsedMs?: number;
}

export type AssistantItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCard }
  | { kind: "thought"; thought: ThoughtSegment };

export type MergeUiMessage =
  | { type: "user"; id: string; text: string; chips?: string[] }
  | {
      type: "assistant";
      id: string;
      items: AssistantItem[];
    }
  | { type: "system"; id: string; text: string };

export interface MergeState {
  messages: MergeUiMessage[];
  currentUserId: string | undefined;
  currentAssistantId: string | undefined;
  loadingHistory: boolean;
}

export function emptyAssistant(id: string): Extract<MergeUiMessage, { type: "assistant" }> {
  return { type: "assistant", id, items: [] };
}

/** Concatenate text segments for transcript / search. */
export function assistantPlainText(msg: {
  items: readonly AssistantItem[];
}): string {
  return msg.items
    .filter((i): i is { kind: "text"; text: string } => i.kind === "text")
    .map((i) => i.text)
    .join("");
}

/** Whether any thought segment is still streaming. */
export function assistantHasRunningThought(msg: {
  items: readonly AssistantItem[];
}): boolean {
  return msg.items.some(
    (i) => i.kind === "thought" && !!i.thought.running,
  );
}

/**
 * Live sends already show the user bubble optimistically — ignore agent echo.
 * History replay must create user bubbles from user_message_chunk.
 */
export function shouldApplyUserMessageChunk(loadingHistory: boolean): boolean {
  return loadingHistory;
}

/**
 * Only history replay should close the open assistant when a user chunk starts
 * (next turn). Live turns keep the optimistic assistant so streaming appends
 * into it instead of spawning a second empty assistant bubble.
 */
export function shouldCloseAssistantOnUserChunk(
  loadingHistory: boolean,
): boolean {
  return loadingHistory;
}

/**
 * Apply a user text chunk. Returns null when the event should be ignored
 * (live echo). Otherwise returns the next merge state.
 */
export function applyUserMessageChunk(
  state: MergeState,
  text: string,
  uid: () => string,
): MergeState | null {
  if (!shouldApplyUserMessageChunk(state.loadingHistory)) {
    return null;
  }

  let currentAssistantId = state.currentAssistantId;
  if (shouldCloseAssistantOnUserChunk(state.loadingHistory)) {
    currentAssistantId = undefined;
  }

  const messages = state.messages.slice();
  let currentUserId = state.currentUserId;
  if (!currentUserId) {
    currentUserId = uid();
    messages.push({ type: "user", id: currentUserId, text: "", chips: [] });
  }

  const user = messages.find(
    (m) => m.type === "user" && m.id === currentUserId,
  );
  if (user && user.type === "user" && text) {
    user.text += text;
  }

  return {
    ...state,
    messages,
    currentUserId,
    currentAssistantId,
  };
}

function ensureAssistant(
  messages: MergeUiMessage[],
  currentAssistantId: string | undefined,
  uid: () => string,
): { messages: MergeUiMessage[]; currentAssistantId: string; msg: Extract<MergeUiMessage, { type: "assistant" }> } {
  let id = currentAssistantId;
  if (!id) {
    id = uid();
    const created = emptyAssistant(id);
    messages.push(created);
    return { messages, currentAssistantId: id, msg: created };
  }
  const found = messages.find((m) => m.type === "assistant" && m.id === id);
  if (found && found.type === "assistant") {
    return { messages, currentAssistantId: id, msg: found };
  }
  const created = emptyAssistant(id);
  messages.push(created);
  return { messages, currentAssistantId: id, msg: created };
}

/** Append text to the last text segment, or open a new one after a tool/thought. */
export function appendAssistantText(
  msg: Extract<MergeUiMessage, { type: "assistant" }>,
  text: string,
): void {
  if (!text) {
    return;
  }
  const last = msg.items[msg.items.length - 1];
  if (last && last.kind === "text") {
    last.text += text;
    return;
  }
  msg.items.push({ kind: "text", text });
}

/**
 * Append thought text. Continues the last *running* thought segment; otherwise
 * opens a new thought item so think → tool → think stays split on the timeline.
 */
export function appendAssistantThought(
  msg: Extract<MergeUiMessage, { type: "assistant" }>,
  text: string,
  opts?: { running?: boolean; newId?: () => string },
): void {
  if (!text && !opts?.running) {
    return;
  }
  const last = msg.items[msg.items.length - 1];
  if (last && last.kind === "thought" && last.thought.running) {
    if (text) {
      last.thought.text += text;
    }
    if (opts?.running !== undefined) {
      last.thought.running = opts.running;
    }
    return;
  }
  // Only open a segment when there is content (or we're arming a live stream).
  if (!text && !opts?.running) {
    return;
  }
  const id = opts?.newId?.() ?? `thought-${msg.items.length}`;
  msg.items.push({
    kind: "thought",
    thought: {
      id,
      text: text || "",
      running: opts?.running ?? false,
    },
  });
}

/**
 * Finish every running thought on the assistant (usually the last one).
 * Freezes elapsed when provided (live wall-clock from the host).
 */
export function finishAssistantThoughts(
  msg: Extract<MergeUiMessage, { type: "assistant" }>,
  elapsedMs?: number,
): void {
  for (const item of msg.items) {
    if (item.kind !== "thought" || !item.thought.running) {
      continue;
    }
    item.thought.running = false;
    if (
      elapsedMs != null &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= 0 &&
      (item.thought.elapsedMs == null || item.thought.elapsedMs <= 0)
    ) {
      item.thought.elapsedMs = elapsedMs;
    }
  }
}

function truncateDetail(s: string, max = DETAIL_MAX): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n…`;
}

/**
 * Format rawInput / rawOutput / similar unknowns for tool expand detail.
 * Prefer common string fields over full JSON when present.
 */
export function formatToolValue(value: unknown, maxLen = DETAIL_MAX): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    const t = value.trim();
    return t ? truncateDetail(t, maxLen) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Prefer readable payload fields when present (ACP / ToolOutput shapes).
    for (const key of [
      "output",
      "raw_output",
      "content",
      "result",
      "output_for_prompt",
      "text",
      "message",
    ]) {
      if (typeof o[key] === "string" && (o[key] as string).trim()) {
        return truncateDetail(o[key] as string, maxLen);
      }
    }
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
      const parts: string[] = [];
      if (typeof o.stdout === "string" && o.stdout) {
        parts.push(o.stdout);
      }
      if (typeof o.stderr === "string" && o.stderr) {
        parts.push(o.stderr);
      }
      if (parts.length) {
        return truncateDetail(parts.join("\n"), maxLen);
      }
    }
    if (typeof o.command === "string" && o.command.trim()) {
      // Input-style object: show command (+ description if present).
      const bits = [o.command.trim()];
      if (typeof o.description === "string" && o.description.trim()) {
        bits.push(o.description.trim());
      }
      return truncateDetail(bits.join("\n"), maxLen);
    }
    // Tagged ToolOutput: { type, data: { raw_output | content | … } }
    if (o.data != null && typeof o.data === "object") {
      const nested = formatToolValue(o.data, maxLen);
      if (nested) {
        return nested;
      }
    }
    try {
      return truncateDetail(JSON.stringify(value, null, 2), maxLen);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Extract display text from ACP tool `content[]` (replace-semantics on update).
 */
export function extractToolContentText(
  content: unknown,
  maxLen = DETAIL_MAX,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const c = item as Record<string, unknown>;
    if (c.type === "content" && c.content && typeof c.content === "object") {
      const inner = c.content as Record<string, unknown>;
      if (inner.type === "text" && typeof inner.text === "string" && inner.text) {
        parts.push(inner.text);
      }
    } else if (c.type === "diff") {
      const path = typeof c.path === "string" ? c.path : "file";
      const lines = [`diff ${path}`];
      if (typeof c.oldText === "string" && c.oldText) {
        lines.push(`--- old\n${c.oldText}`);
      }
      if (typeof c.newText === "string" && c.newText) {
        lines.push(`+++ new\n${c.newText}`);
      }
      parts.push(lines.join("\n"));
    } else if (c.type === "terminal") {
      const id =
        typeof c.terminalId === "string"
          ? c.terminalId
          : typeof (c as { terminalId?: unknown }).terminalId === "number"
            ? String((c as { terminalId: number }).terminalId)
            : "";
      parts.push(id ? `terminal ${id}` : "terminal");
    }
  }
  if (!parts.length) {
    return undefined;
  }
  return truncateDetail(parts.join("\n\n"), maxLen);
}

/**
 * Insert a new tool at the end of the timeline (correct order), or merge
 * fields into an existing tool with the same id (status/output in place).
 */
export function upsertAssistantTool(
  msg: Extract<MergeUiMessage, { type: "assistant" }>,
  patch: {
    id: string;
    title?: string;
    status?: string;
    kind?: string;
    paths?: string[];
    input?: string;
    output?: string;
  },
): void {
  for (const item of msg.items) {
    if (item.kind === "tool" && item.tool.id === patch.id) {
      if (patch.status !== undefined) {
        item.tool.status = patch.status;
      }
      if (patch.title !== undefined) {
        item.tool.title = patch.title;
      }
      if (patch.kind !== undefined) {
        item.tool.kind = patch.kind;
      }
      if (patch.paths && patch.paths.length) {
        item.tool.paths = patch.paths;
      }
      if (patch.input !== undefined) {
        item.tool.input = patch.input;
      }
      if (patch.output !== undefined) {
        item.tool.output = patch.output;
      }
      return;
    }
  }
  msg.items.push({
    kind: "tool",
    tool: {
      id: patch.id,
      title: patch.title ?? patch.id,
      status: patch.status ?? "pending",
      kind: patch.kind,
      paths: patch.paths ?? [],
      input: patch.input,
      output: patch.output,
    },
  });
}

/**
 * Ensure an assistant bubble exists for streaming, then append text.
 * Finishes any open thought so text sits after it on the timeline.
 */
export function applyAgentMessageChunk(
  state: MergeState,
  text: string,
  uid: () => string,
): MergeState {
  const messages = state.messages.slice();
  const ensured = ensureAssistant(messages, state.currentAssistantId, uid);
  finishAssistantThoughts(ensured.msg);
  appendAssistantText(ensured.msg, text);

  return {
    ...state,
    messages: ensured.messages,
    currentUserId: undefined,
    currentAssistantId: ensured.currentAssistantId,
  };
}

/**
 * Ensure an assistant exists, then upsert a tool call on its timeline.
 * Finishes any open thought so the tool sits after it (TUI order).
 */
export function applyToolEvent(
  state: MergeState,
  patch: {
    id: string;
    title?: string;
    status?: string;
    kind?: string;
    paths?: string[];
    input?: string;
    output?: string;
  },
  uid: () => string,
): MergeState {
  const messages = state.messages.slice();
  const ensured = ensureAssistant(messages, state.currentAssistantId, uid);
  finishAssistantThoughts(ensured.msg);
  upsertAssistantTool(ensured.msg, patch);

  return {
    ...state,
    messages: ensured.messages,
    currentUserId: undefined,
    currentAssistantId: ensured.currentAssistantId,
  };
}

/**
 * Ensure an assistant exists, then append thought text on the timeline.
 * If the last item is a finished tool/text, a new thought segment is created.
 */
export function applyAgentThoughtChunk(
  state: MergeState,
  text: string,
  uid: () => string,
  opts?: { running?: boolean },
): MergeState {
  const messages = state.messages.slice();
  const ensured = ensureAssistant(messages, state.currentAssistantId, uid);
  appendAssistantThought(ensured.msg, text, {
    running: opts?.running ?? true,
    newId: uid,
  });

  return {
    ...state,
    messages: ensured.messages,
    currentUserId: undefined,
    currentAssistantId: ensured.currentAssistantId,
  };
}

/**
 * True when two serialized message lists only differ in the last assistant's
 * streamed fields. Used by the webview to patch DOM instead of full re-render.
 */
export function isStreamingTailUpdate(
  prev: ReadonlyArray<{ type: string; id: string }>,
  next: ReadonlyArray<{ type: string; id: string }>,
): boolean {
  if (next.length === 0 || prev.length !== next.length) {
    return false;
  }
  const last = next[next.length - 1];
  if (!last || last.type !== "assistant") {
    return false;
  }
  for (let i = 0; i < next.length - 1; i++) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b || a.id !== b.id || a.type !== b.type) {
      return false;
    }
  }
  const prevLast = prev[prev.length - 1];
  return !!prevLast && prevLast.id === last.id && prevLast.type === "assistant";
}
