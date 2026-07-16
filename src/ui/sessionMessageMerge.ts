/**
 * Pure helpers for merging ACP session/update chunks into the chat message list.
 *
 * Live turns push an optimistic user + empty assistant in handleSend. The agent
 * then echoes user_message_chunk; treating that like history replay duplicates
 * the question and clears currentAssistantId, leaving a leftover "…" bubble
 * when a second assistant is created for the reply.
 *
 * Assistant content is a timeline of items (text segments + tool calls) so tools
 * appear where they happened in the stream, not bunched after all text.
 */

export interface ToolCard {
  id: string;
  title: string;
  status: string;
  kind?: string;
  paths: string[];
}

export type AssistantItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCard };

export type MergeUiMessage =
  | { type: "user"; id: string; text: string; chips?: string[] }
  | {
      type: "assistant";
      id: string;
      thought: string;
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
  return { type: "assistant", id, thought: "", items: [] };
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
 * into it instead of spawning a second "…" bubble.
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

/** Append text to the last text segment, or open a new one after a tool. */
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
 * Insert a new tool at the end of the timeline (correct order), or merge
 * fields into an existing tool with the same id.
 */
export function upsertAssistantTool(
  msg: Extract<MergeUiMessage, { type: "assistant" }>,
  patch: {
    id: string;
    title?: string;
    status?: string;
    kind?: string;
    paths?: string[];
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
    },
  });
}

/**
 * Ensure an assistant bubble exists for streaming, then append text.
 */
export function applyAgentMessageChunk(
  state: MergeState,
  text: string,
  uid: () => string,
): MergeState {
  const messages = state.messages.slice();
  const ensured = ensureAssistant(messages, state.currentAssistantId, uid);
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
 */
export function applyToolEvent(
  state: MergeState,
  patch: {
    id: string;
    title?: string;
    status?: string;
    kind?: string;
    paths?: string[];
  },
  uid: () => string,
): MergeState {
  const messages = state.messages.slice();
  const ensured = ensureAssistant(messages, state.currentAssistantId, uid);
  upsertAssistantTool(ensured.msg, patch);

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
