import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendAssistantText,
  applyAgentMessageChunk,
  applyToolEvent,
  applyUserMessageChunk,
  assistantPlainText,
  emptyAssistant,
  isStreamingTailUpdate,
  shouldApplyUserMessageChunk,
  shouldCloseAssistantOnUserChunk,
  upsertAssistantTool,
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
      emptyAssistant("asst-opt"),
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
      messages: [emptyAssistant("old-asst")],
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

describe("timeline: text + tools in stream order", () => {
  it("appends text into one segment until a tool splits the timeline", () => {
    const msg = emptyAssistant("a1");
    appendAssistantText(msg, "Hello ");
    appendAssistantText(msg, "world");
    assert.deepEqual(msg.items, [{ kind: "text", text: "Hello world" }]);

    upsertAssistantTool(msg, {
      id: "t1",
      title: "Read file",
      status: "pending",
      kind: "read",
      paths: ["/a.ts"],
    });
    appendAssistantText(msg, "Done.");

    assert.equal(msg.items.length, 3);
    assert.equal(msg.items[0]?.kind, "text");
    assert.equal(msg.items[0]?.kind === "text" && msg.items[0].text, "Hello world");
    assert.equal(msg.items[1]?.kind, "tool");
    assert.equal(
      msg.items[1]?.kind === "tool" && msg.items[1].tool.title,
      "Read file",
    );
    assert.equal(msg.items[2]?.kind, "text");
    assert.equal(msg.items[2]?.kind === "text" && msg.items[2].text, "Done.");
    assert.equal(assistantPlainText(msg), "Hello worldDone.");
  });

  it("tool updates merge in place without moving timeline position", () => {
    const msg = emptyAssistant("a1");
    appendAssistantText(msg, "Before");
    upsertAssistantTool(msg, {
      id: "t1",
      title: "Edit",
      status: "in_progress",
      paths: [],
    });
    appendAssistantText(msg, "After");
    upsertAssistantTool(msg, {
      id: "t1",
      status: "completed",
      paths: ["/x.ts"],
    });

    assert.equal(msg.items.length, 3);
    assert.equal(msg.items[1]?.kind, "tool");
    if (msg.items[1]?.kind === "tool") {
      assert.equal(msg.items[1].tool.status, "completed");
      assert.deepEqual(msg.items[1].tool.paths, ["/x.ts"]);
      assert.equal(msg.items[1].tool.title, "Edit");
    }
    // Still between the two text segments
    assert.equal(msg.items[0]?.kind, "text");
    assert.equal(msg.items[2]?.kind, "text");
  });

  it("applyAgentMessageChunk + applyToolEvent preserve order", () => {
    let state = liveStateWithOptimistic("Q?");
    state = applyAgentMessageChunk(state, "Looking…", uidSeq(99));
    state = applyToolEvent(
      state,
      { id: "tc1", title: "grep", status: "pending", kind: "search" },
      uidSeq(100),
    );
    state = applyAgentMessageChunk(state, " Found it.", uidSeq(101));

    const asst = state.messages.find((m) => m.type === "assistant");
    assert.ok(asst && asst.type === "assistant");
    assert.equal(asst.items.length, 3);
    assert.equal(asst.items[0]?.kind, "text");
    assert.equal(asst.items[1]?.kind, "tool");
    assert.equal(asst.items[2]?.kind, "text");
    assert.equal(assistantPlainText(asst), "Looking… Found it.");
  });
});

describe("applyAgentMessageChunk", () => {
  it("streams into optimistic assistant without creating a second empty bubble", () => {
    let state = liveStateWithOptimistic("Q?");
    state = applyAgentMessageChunk(state, "Ans", uidSeq(99));
    assert.equal(state.messages.length, 2);
    assert.equal(state.currentAssistantId, "asst-opt");
    const asst = state.messages[1];
    assert.ok(asst && asst.type === "assistant");
    assert.equal(assistantPlainText(asst), "Ans");
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
    assert.equal(assistantPlainText(asst), "A");
  });

  it("regression: live user echo + agent stream must not duplicate Q and empty assistant", () => {
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
      assistants[0]?.type === "assistant" && assistantPlainText(assistants[0]),
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
