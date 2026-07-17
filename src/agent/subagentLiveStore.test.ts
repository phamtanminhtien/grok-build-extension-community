import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentLiveStore } from "./subagentLiveStore.ts";
import type { SessionNotification } from "@agentclientprotocol/sdk";

function notif(
  sessionId: string,
  update: Record<string, unknown>,
): SessionNotification {
  return { sessionId, update } as SessionNotification;
}

describe("SubagentLiveStore", () => {
  it("registers and routes child session updates", () => {
    const store = new SubagentLiveStore();
    store.register({
      subagentId: "a1",
      childSessionId: "c1",
      subagentType: "explore",
      description: "scan repo",
    });
    assert.equal(store.isChildSession("c1"), true);
    assert.equal(store.isChildSession("parent"), false);

    assert.equal(
      store.applySessionUpdate(
        notif("c1", {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hmm " },
        }),
      ),
      true,
    );
    assert.equal(
      store.applySessionUpdate(
        notif("c1", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        }),
      ),
      true,
    );
    assert.equal(
      store.applySessionUpdate(
        notif("c1", {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "grep patterns",
          status: "running",
          kind: "search",
        }),
      ),
      true,
    );

    const s = store.resolve("a1");
    assert.ok(s);
    assert.equal(s!.status, "running");
    assert.match(s!.activity || "", /grep/);
    const asst = s!.messages.find((m) => m.type === "assistant");
    assert.ok(asst && asst.type === "assistant");
    assert.ok(asst.items.some((i) => i.kind === "thought"));
    assert.ok(asst.items.some((i) => i.kind === "text"));
    assert.ok(asst.items.some((i) => i.kind === "tool"));
  });

  it("ignores parent / unknown session updates", () => {
    const store = new SubagentLiveStore();
    store.register({
      subagentId: "a1",
      childSessionId: "c1",
      description: "x",
    });
    assert.equal(
      store.applySessionUpdate(
        notif("other", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "nope" },
        }),
      ),
      false,
    );
  });

  it("finish settles stream", () => {
    const store = new SubagentLiveStore();
    store.register({
      subagentId: "a1",
      childSessionId: "c1",
      description: "x",
    });
    store.applySessionUpdate(
      notif("c1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      }),
    );
    const fin = store.finish("a1", "done", "Subagent completed");
    assert.ok(fin);
    assert.equal(fin!.status, "done");
    assert.ok(fin!.finishedAtMs);
    const asst = fin!.messages.find((m) => m.type === "assistant");
    if (asst && asst.type === "assistant") {
      for (const it of asst.items) {
        if (it.kind === "thought") {
          assert.equal(it.thought.running, false);
        }
      }
    }
  });
});
