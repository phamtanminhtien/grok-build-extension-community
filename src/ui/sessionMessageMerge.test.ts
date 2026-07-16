import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAgentMessageChunk,
  applyUserMessageChunk,
  isStreamingTailUpdate,
  shouldApplyUserMessageChunk,
  shouldCloseAssistantOnUserChunk,
  type MergeState,
} from "./sessionMessageMerge.ts";

function uidSeq(start = 1): () => string {
  let n = start;
  return () => `id-${n++}`;
}

function liveStateWithOptimistic(question: string): MergeState {
  return {
    loadingHistory: false,
    currentUserId: undefined,
    currentAssistantId: "asst-opt",
    messages: [
      { type: "user", id: "user-opt", text: question, chips: [] },
      {
        type: "assistant",
        id: "asst-opt",
        text: "",
        thought: "",
        tools: [],
      },
    ],
  };
}

describe("shouldApplyUserMessageChunk", () => {
  it("ignores live agent echo (optimistic user already shown)", () => {
    assert.equal(shouldApplyUserMessageChunk(false), false);
  });

  it("applies during history replay", () => {
    assert.equal(shouldApplyUserMessageChunk(true), true);
  });
});

describe("shouldCloseAssistantOnUserChunk", () => {
  it("does not close optimistic assistant on live user echo", () => {
    assert.equal(shouldCloseAssistantOnUserChunk(false), false);
  });

  it("closes assistant when history starts a new user turn", () => {
    assert.equal(shouldCloseAssistantOnUserChunk(true), true);
  });
});

describe("applyUserMessageChunk", () => {
  it("returns null on live turn so question is not duplicated", () => {
    const state = liveStateWithOptimistic("Hello?");
    const next = applyUserMessageChunk(state, "Hello?", uidSeq());
    assert.equal(next, null);
    // Original state untouched
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages.filter((m) => m.type === "user").length, 1);
  });

  it("creates and fills user bubble during history load", () => {
    const state: MergeState = {
      loadingHistory: true,
      currentUserId: undefined,
      currentAssistantId: undefined,
      messages: [],
    };
    const next = applyUserMessageChunk(state, "Hi", uidSeq());
    assert.ok(next);
    assert.equal(next!.messages.length, 1);
    assert.equal(next!.messages[0]?.type, "user");
    assert.equal(next!.messages[0]?.type === "user" && next!.messages[0].text, "Hi");
    assert.equal(next!.currentUserId, "id-1");
  });

  it("appends chunks to the same user during history load", () => {
    const uid = uidSeq();
    let state: MergeState = {
      loadingHistory: true,
      currentUserId: undefined,
      currentAssistantId: "old-asst",
      messages: [
        {
          type: "assistant",
          id: "old-asst",
          text: "prev",
          thought: "",
          tools: [],
        },
      ],
    };
    state = applyUserMessageChunk(state, "Hel", uid)!;
    state = applyUserMessageChunk(state, "lo", uid)!;
    assert.equal(state.messages.length, 2);
    const user = state.messages.find((m) => m.type === "user");
    assert.ok(user && user.type === "user");
    assert.equal(user.text, "Hello");
    assert.equal(state.currentAssistantId, undefined);
  });
});

describe("applyAgentMessageChunk", () => {
  it("streams into optimistic assistant without creating a second … bubble", () => {
    let state = liveStateWithOptimistic("Q?");
    state = applyAgentMessageChunk(state, "Ans", uidSeq(99));
    assert.equal(state.messages.length, 2);
    assert.equal(state.currentAssistantId, "asst-opt");
    const asst = state.messages[1];
    assert.ok(asst && asst.type === "assistant");
    assert.equal(asst.text, "Ans");
    // No second assistant
    assert.equal(state.messages.filter((m) => m.type === "assistant").length, 1);
  });

  it("creates assistant when none is open (history / late stream)", () => {
    const state = applyAgentMessageChunk(
      {
        loadingHistory: true,
        currentUserId: "u1",
        currentAssistantId: undefined,
        messages: [{ type: "user", id: "u1", text: "Q", chips: [] }],
      },
      "A",
      uidSeq(5),
    );
    assert.equal(state.messages.length, 2);
    assert.equal(state.currentAssistantId, "id-5");
    assert.equal(state.currentUserId, undefined);
    const asst = state.messages[1];
    assert.ok(asst && asst.type === "assistant");
    assert.equal(asst.text, "A");
  });

  it("regression: live user echo + agent stream must not duplicate Q and …", () => {
    // Reproduce the bug sequence before the fix:
    // 1) optimistic user + empty assistant
    // 2) user_message_chunk (must NOT create second user / clear assistant)
    // 3) agent_message_chunk appends to same assistant
    let state = liveStateWithOptimistic("Câu hỏi?");
    const afterUser = applyUserMessageChunk(state, "Câu hỏi?", uidSeq());
    assert.equal(afterUser, null, "live user chunk must be ignored");
    state = applyAgentMessageChunk(state, "Trả lời", uidSeq(100));

    const users = state.messages.filter((m) => m.type === "user");
    const assistants = state.messages.filter((m) => m.type === "assistant");
    assert.equal(users.length, 1);
    assert.equal(assistants.length, 1);
    assert.equal(users[0]?.type === "user" && users[0].text, "Câu hỏi?");
    assert.equal(
      assistants[0]?.type === "assistant" && assistants[0].text,
      "Trả lời",
    );
  });
});

describe("isStreamingTailUpdate", () => {
  it("true when only last assistant changes", () => {
    const prev = [
      { type: "user", id: "u1" },
      { type: "assistant", id: "a1" },
    ];
    const next = [
      { type: "user", id: "u1" },
      { type: "assistant", id: "a1" },
    ];
    assert.equal(isStreamingTailUpdate(prev, next), true);
  });

  it("false when length changes or last is not same assistant", () => {
    assert.equal(
      isStreamingTailUpdate([{ type: "user", id: "u1" }], [
        { type: "user", id: "u1" },
        { type: "assistant", id: "a1" },
      ]),
      false,
    );
    assert.equal(
      isStreamingTailUpdate(
        [
          { type: "user", id: "u1" },
          { type: "assistant", id: "a1" },
        ],
        [
          { type: "user", id: "u1" },
          { type: "assistant", id: "a2" },
        ],
      ),
      false,
    );
  });
});
