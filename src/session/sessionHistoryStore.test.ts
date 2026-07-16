import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SessionHistoryStore,
  deriveTitle,
} from "./sessionHistoryStore.ts";

function mem() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
  };
}

describe("SessionHistoryStore", () => {
  it("upserts and lists newest first", async () => {
    const s = new SessionHistoryStore(mem());
    await s.upsert({
      sessionId: "a",
      cwd: "/w",
      title: "A",
      updatedAt: 1,
      preview: "hi",
      messageCount: 1,
    });
    await s.upsert({
      sessionId: "b",
      cwd: "/w",
      title: "B",
      updatedAt: 2,
      preview: "yo",
      messageCount: 2,
    });
    assert.equal(s.list()[0]?.sessionId, "b");
  });

  it("replaces same session id", async () => {
    const s = new SessionHistoryStore(mem());
    await s.upsert({
      sessionId: "a",
      cwd: "/w",
      title: "A",
      updatedAt: 1,
      preview: "hi",
      messageCount: 1,
    });
    await s.upsert({
      sessionId: "a",
      cwd: "/w",
      title: "A2",
      updatedAt: 3,
      preview: "hi2",
      messageCount: 2,
    });
    assert.equal(s.list().length, 1);
    assert.equal(s.list()[0]?.title, "A2");
  });
});

describe("deriveTitle", () => {
  it("uses first line", () => {
    assert.equal(deriveTitle("Hello\nWorld", "xyz"), "Hello");
  });
});
