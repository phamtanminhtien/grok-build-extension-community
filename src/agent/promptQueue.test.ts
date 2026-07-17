import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emptyQueueSnapshot,
  makeOptimisticEntry,
  parseQueueChanged,
  queueEntryFirstLine,
  reconcileQueue,
} from "./promptQueue.ts";

describe("parseQueueChanged", () => {
  it("parses full camelCase payload", () => {
    const parsed = parseQueueChanged({
      sessionId: "s1",
      entries: [
        {
          id: "p1",
          version: 2,
          owner: "alice",
          lastEditor: "bob",
          kind: "prompt",
          text: "hi",
          position: 0,
        },
      ],
      runningPromptId: "p0",
    });
    assert.ok(parsed);
    assert.equal(parsed!.sessionId, "s1");
    assert.equal(parsed!.runningPromptId, "p0");
    assert.equal(parsed!.entries.length, 1);
    assert.equal(parsed!.entries[0]!.id, "p1");
    assert.equal(parsed!.entries[0]!.lastEditor, "bob");
  });

  it("requires sessionId", () => {
    assert.equal(parseQueueChanged({ entries: [] }), undefined);
  });

  it("defaults sparse entries", () => {
    const parsed = parseQueueChanged({
      sessionId: "s1",
      entries: [{ id: "p1" }],
    });
    assert.ok(parsed);
    assert.equal(parsed!.entries[0]!.version, 0);
    assert.equal(parsed!.entries[0]!.kind, "");
    assert.equal(parsed!.entries[0]!.text, "");
  });
});

describe("reconcileQueue", () => {
  it("keeps unconfirmed optimistic rows", () => {
    const prev = emptyQueueSnapshot("s1");
    prev.entries = [makeOptimisticEntry("local-1", "queued text")];
    const next = reconcileQueue(prev, {
      sessionId: "s1",
      entries: [],
      runningPromptId: "running",
    });
    assert.equal(next.entries.length, 1);
    assert.equal(next.entries[0]!.id, "local-1");
    assert.equal(next.entries[0]!.optimistic, true);
  });

  it("drops optimistic when server confirms by id", () => {
    const prev = emptyQueueSnapshot("s1");
    prev.entries = [makeOptimisticEntry("p1", "hello")];
    const next = reconcileQueue(prev, {
      sessionId: "s1",
      entries: [
        {
          id: "p1",
          version: 0,
          kind: "prompt",
          text: "hello",
          position: 0,
        },
      ],
    });
    assert.equal(next.entries.length, 1);
    assert.equal(next.entries[0]!.optimistic, false);
  });

  it("drops optimistic when server confirms by text under new id", () => {
    const prev = emptyQueueSnapshot("s1");
    prev.entries = [makeOptimisticEntry("local-1", "same text")];
    const next = reconcileQueue(prev, {
      sessionId: "s1",
      entries: [
        {
          id: "server-9",
          version: 0,
          kind: "prompt",
          text: "same text",
          position: 0,
        },
      ],
    });
    assert.equal(next.entries.length, 1);
    assert.equal(next.entries[0]!.id, "server-9");
    assert.equal(next.entries[0]!.optimistic, false);
  });
});

describe("queueEntryFirstLine", () => {
  it("picks first non-empty line and truncates", () => {
    assert.equal(queueEntryFirstLine("\n  hello world  \nmore"), "hello world");
    assert.equal(queueEntryFirstLine("x".repeat(100), 10).endsWith("…"), true);
  });
});
