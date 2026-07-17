import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendAssistantText,
  appendAssistantThought,
  applyAgentMessageChunk,
  applyAgentThoughtChunk,
  applyToolEvent,
  applyUserMessageChunk,
  assignPromptIndices,
  assistantHasRunningThought,
  assistantPlainText,
  classifyToolVerb,
  emptyAssistant,
  extractToolContentText,
  finalizeAssistantStream,
  finishAssistantThoughts,
  formatToolValue,
  formatToolVerbGroupLabel,
  groupConsecutiveTools,
  isStreamingTailUpdate,
  messageCopyText,
  nextPromptIndex,
  shouldApplyUserMessageChunk,
  shouldCloseAssistantOnUserChunk,
  truncateFromMessageId,
  truncateFromPromptIndex,
  upsertAssistantTool,
  type MergeState,
  type ToolCard,
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
    assert.equal(
      next!.messages[0]?.type === "user" && next!.messages[0].text,
      "Hi",
    );
    assert.equal(
      next!.messages[0]?.type === "user" && next!.messages[0].promptIndex,
      0,
    );
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
    assert.equal(
      msg.items[0]?.kind === "text" && msg.items[0].text,
      "Hello world",
    );
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
      output: "ok",
    });

    assert.equal(msg.items.length, 3);
    assert.equal(msg.items[1]?.kind, "tool");
    if (msg.items[1]?.kind === "tool") {
      assert.equal(msg.items[1].tool.status, "completed");
      assert.deepEqual(msg.items[1].tool.paths, ["/x.ts"]);
      assert.equal(msg.items[1].tool.title, "Edit");
      assert.equal(msg.items[1].tool.output, "ok");
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

describe("timeline: thoughts stay split across tools", () => {
  it("does not merge think → tool → think into one thought blob", () => {
    const msg = emptyAssistant("a1");
    appendAssistantThought(msg, "Plan A ", {
      running: true,
      newId: () => "th1",
    });
    appendAssistantThought(msg, "more A", { running: true });
    finishAssistantThoughts(msg, 1200);
    upsertAssistantTool(msg, {
      id: "t1",
      title: "Read",
      status: "completed",
      output: "file body",
    });
    appendAssistantThought(msg, "Plan B after tool", {
      running: true,
      newId: () => "th2",
    });
    finishAssistantThoughts(msg, 800);
    appendAssistantText(msg, "Final answer");

    assert.equal(msg.items.length, 4);
    assert.equal(msg.items[0]?.kind, "thought");
    assert.equal(msg.items[1]?.kind, "tool");
    assert.equal(msg.items[2]?.kind, "thought");
    assert.equal(msg.items[3]?.kind, "text");

    if (msg.items[0]?.kind === "thought") {
      assert.equal(msg.items[0].thought.text, "Plan A more A");
      assert.equal(msg.items[0].thought.running, false);
      assert.equal(msg.items[0].thought.elapsedMs, 1200);
      assert.equal(msg.items[0].thought.id, "th1");
    }
    if (msg.items[2]?.kind === "thought") {
      assert.equal(msg.items[2].thought.text, "Plan B after tool");
      assert.equal(msg.items[2].thought.running, false);
      assert.equal(msg.items[2].thought.elapsedMs, 800);
      assert.equal(msg.items[2].thought.id, "th2");
    }
    assert.equal(assistantPlainText(msg), "Final answer");
    assert.equal(assistantHasRunningThought(msg), false);
  });

  it("finalizeAssistantStream freezes thoughts and settles running tools", () => {
    const msg = emptyAssistant("a-live");
    appendAssistantThought(msg, "still thinking", {
      running: true,
      newId: () => "th-live",
    });
    upsertAssistantTool(msg, {
      id: "tool-run",
      title: "grep",
      status: "in_progress",
    });
    finalizeAssistantStream(msg, 1500);
    assert.equal(assistantHasRunningThought(msg), false);
    if (msg.items[0]?.kind === "thought") {
      assert.equal(msg.items[0].thought.running, false);
      assert.equal(msg.items[0].thought.elapsedMs, 1500);
    }
    if (msg.items[1]?.kind === "tool") {
      assert.equal(msg.items[1].tool.status, "completed");
    }
  });

  it("applyAgentThoughtChunk + tool + thought preserve stream order", () => {
    let state = liveStateWithOptimistic("Q?");
    const uid = uidSeq(10);
    state = applyAgentThoughtChunk(state, "Think 1", uid, { running: true });
    state = applyToolEvent(
      state,
      {
        id: "tc1",
        title: "bash",
        status: "completed",
        input: "ls",
        output: "a.ts\nb.ts",
      },
      uid,
    );
    state = applyAgentThoughtChunk(state, "Think 2", uid, { running: true });
    state = applyAgentMessageChunk(state, "Answer", uid);

    const asst = state.messages.find((m) => m.type === "assistant");
    assert.ok(asst && asst.type === "assistant");
    assert.equal(
      asst.items.map((i) => i.kind).join(","),
      "thought,tool,thought,text",
    );
    if (asst.items[0]?.kind === "thought") {
      assert.equal(asst.items[0].thought.text, "Think 1");
      assert.equal(asst.items[0].thought.running, false);
    }
    if (asst.items[1]?.kind === "tool") {
      assert.equal(asst.items[1].tool.input, "ls");
      assert.equal(asst.items[1].tool.output, "a.ts\nb.ts");
    }
    if (asst.items[2]?.kind === "thought") {
      assert.equal(asst.items[2].thought.text, "Think 2");
      assert.equal(asst.items[2].thought.running, false);
    }
  });
});

describe("tool detail helpers", () => {
  it("formatToolValue prefers output/command fields", () => {
    assert.equal(formatToolValue("plain"), "plain");
    assert.equal(formatToolValue({ output: "hi" }), "hi");
    assert.equal(
      formatToolValue({ command: "rg foo", description: "search" }),
      "rg foo\nsearch",
    );
    assert.equal(formatToolValue({ stdout: "out", stderr: "err" }), "out\nerr");
    assert.equal(
      formatToolValue({ type: "ReadFile", data: { raw_output: "file body" } }),
      "file body",
    );
  });

  it("extractToolContentText flattens ACP content blocks", () => {
    const text = extractToolContentText([
      { type: "content", content: { type: "text", text: "hello" } },
      { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
    ]);
    assert.ok(text);
    assert.match(text!, /hello/);
    assert.match(text!, /diff \/a\.ts/);
    assert.match(text!, /b/);
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
    assert.equal(
      state.messages.filter((m) => m.type === "assistant").length,
      1,
    );
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
      isStreamingTailUpdate(
        [{ type: "user", id: "u1" }],
        [
          { type: "user", id: "u1" },
          { type: "assistant", id: "a1" },
        ],
      ),
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

describe("promptIndex / edit helpers", () => {
  it("nextPromptIndex counts user messages", () => {
    assert.equal(nextPromptIndex([]), 0);
    assert.equal(
      nextPromptIndex([
        { type: "user", id: "u0", text: "a", promptIndex: 0 },
        emptyAssistant("a0"),
        { type: "user", id: "u1", text: "b", promptIndex: 1 },
      ]),
      2,
    );
  });

  it("assignPromptIndices renumbers user turns", () => {
    const messages = [
      { type: "user" as const, id: "u0", text: "a" },
      emptyAssistant("a0"),
      { type: "system" as const, id: "s", text: "note" },
      { type: "user" as const, id: "u1", text: "b" },
    ];
    assignPromptIndices(messages);
    assert.equal(messages[0]?.type === "user" && messages[0].promptIndex, 0);
    assert.equal(messages[3]?.type === "user" && messages[3].promptIndex, 1);
  });

  it("truncateFromMessageId drops target and tail", () => {
    const messages = [
      { type: "user" as const, id: "u0", text: "a", promptIndex: 0 },
      emptyAssistant("a0"),
      { type: "user" as const, id: "u1", text: "b", promptIndex: 1 },
      emptyAssistant("a1"),
    ];
    const next = truncateFromMessageId(messages, "u1");
    assert.equal(next.length, 2);
    assert.equal(next[0]?.id, "u0");
    assert.equal(next[1]?.id, "a0");
    assert.equal(messages.length, 4, "input not mutated");
  });

  it("truncateFromPromptIndex keeps turns before target", () => {
    const messages = [
      { type: "user" as const, id: "u0", text: "a", promptIndex: 0 },
      emptyAssistant("a0"),
      { type: "user" as const, id: "u1", text: "b", promptIndex: 1 },
      emptyAssistant("a1"),
      { type: "user" as const, id: "u2", text: "c", promptIndex: 2 },
    ];
    const next = truncateFromPromptIndex(messages, 1);
    assert.equal(next.length, 2);
    assert.equal(next[0]?.id, "u0");
    assert.deepEqual(truncateFromPromptIndex(messages, 9), messages);
  });

  it("messageCopyText uses plain text for user/assistant", () => {
    assert.equal(
      messageCopyText({ type: "user", id: "u", text: "hello" }),
      "hello",
    );
    assert.equal(
      messageCopyText({
        type: "assistant",
        id: "a",
        items: [
          { kind: "thought", thought: { id: "t", text: "secret" } },
          { kind: "text", text: "answer" },
        ],
      }),
      "answer",
    );
  });
});

describe("tool verb groups (TUI Read 2 files / Edited 4 files)", () => {
  function tool(id: string, title: string, status = "completed"): ToolCard {
    return { id, title, status, paths: [] };
  }

  it("classifies read / write / search / shell", () => {
    assert.equal(classifyToolVerb({ title: "Read package.json" }), "file");
    assert.equal(classifyToolVerb({ title: "Write src/a.ts" }), "edit");
    assert.equal(classifyToolVerb({ title: "search_replace" }), "edit");
    assert.equal(classifyToolVerb({ title: "Grep pattern" }), "search");
    assert.equal(
      classifyToolVerb({ title: "run_terminal_command" }),
      "command",
    );
  });

  it("labels mixed batch like TUI", () => {
    const { label, running, failed } = formatToolVerbGroupLabel([
      tool("1", "Read a.ts"),
      tool("2", "Read b.ts"),
      tool("3", "Write c.ts"),
      tool("4", "Write d.ts"),
      tool("5", "Write e.ts"),
      tool("6", "Write f.ts"),
    ]);
    assert.equal(label, "Read 2 files, Edited 4 files");
    assert.equal(running, false);
    assert.equal(failed, 0);
  });

  it("uses present tense while any tool is running", () => {
    const { label, running } = formatToolVerbGroupLabel([
      tool("1", "Read a", "completed"),
      tool("2", "Read b", "in_progress"),
    ]);
    assert.equal(running, true);
    assert.equal(label, "Reading 2 files");
  });

  it("groups consecutive tools; text/thought break runs; singleton stays flat", () => {
    const nodes = groupConsecutiveTools([
      { kind: "tool", tool: tool("r1", "Read a") },
      { kind: "tool", tool: tool("r2", "Read b") },
      { kind: "text", text: "then" },
      { kind: "tool", tool: tool("w1", "Write x") },
      { kind: "tool", tool: tool("w2", "Write y") },
      { kind: "tool", tool: tool("w3", "Write z") },
      { kind: "tool", tool: tool("w4", "Write w") },
      { kind: "thought", thought: { id: "t1", text: "hmm" } },
      { kind: "tool", tool: tool("solo", "Read solo") },
    ]);
    assert.equal(nodes.length, 5);
    assert.equal(nodes[0]?.type, "toolGroup");
    if (nodes[0]?.type === "toolGroup") {
      assert.equal(nodes[0].group.label, "Read 2 files");
      assert.equal(nodes[0].group.tools.length, 2);
    }
    assert.equal(nodes[1]?.type, "text");
    assert.equal(nodes[2]?.type, "toolGroup");
    if (nodes[2]?.type === "toolGroup") {
      assert.equal(nodes[2].group.label, "Edited 4 files");
    }
    assert.equal(nodes[3]?.type, "thought");
    assert.equal(nodes[4]?.type, "tool");
    if (nodes[4]?.type === "tool") {
      assert.equal(nodes[4].tool.id, "solo");
    }
  });
});
