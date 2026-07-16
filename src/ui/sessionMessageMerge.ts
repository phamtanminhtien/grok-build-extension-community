/**
 * Pure helpers for merging ACP session/update chunks into the chat message list.
 *
 * Live turns push an optimistic user + empty assistant in handleSend. The agent
 * then echoes user_message_chunk; treating that like history replay duplicates
 * the question and clears currentAssistantId, leaving a leftover "…" bubble
 * when a second assistant is created for the reply.
 */

export type MergeUiMessage =
  | { type: "user"; id: string; text: string; chips?: string[] }
  | {
      type: "assistant";
      id: string;
      text: string;
      thought: string;
      tools: unknown[];
    }
  | { type: "system"; id: string; text: string };

export interface MergeState {
  messages: MergeUiMessage[];
  currentUserId: string | undefined;
  currentAssistantId: string | undefined;
  loadingHistory: boolean;
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

/**
 * Ensure an assistant bubble exists for streaming, then append text.
 */
export function applyAgentMessageChunk(
  state: MergeState,
  text: string,
  uid: () => string,
): MergeState {
  const messages = state.messages.slice();
  let currentAssistantId = state.currentAssistantId;

  // Starting assistant output ends user chunk accumulation (history path).
  const currentUserId = undefined;

  if (!currentAssistantId) {
    currentAssistantId = uid();
    messages.push({
      type: "assistant",
      id: currentAssistantId,
      text: "",
      thought: "",
      tools: [],
    });
  }

  const msg = messages.find(
    (m) => m.type === "assistant" && m.id === currentAssistantId,
  );
  if (msg && msg.type === "assistant" && text) {
    msg.text += text;
  }

  return {
    ...state,
    messages,
    currentUserId,
    currentAssistantId,
  };
}

/**
 * True when two serialized message lists only differ in the last assistant's
 * streamed fields (text/html/thought/tools). Used by the webview to patch DOM
 * instead of full re-render (reduces streaming jank).
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
