import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fuzzyMatchIndices,
  fuzzyScore,
  highlightIndicesForLabel,
  remapIndicesToDisplay,
} from "./fuzzyScore.ts";

describe("fuzzyScore", () => {
  it("matches subsequence", () => {
    assert.ok(fuzzyScore("src/ui/chat.ts", "sct") < Infinity);
    assert.equal(fuzzyScore("src/ui/chat.ts", "zzz"), Infinity);
  });

  it("prefers basename hits", () => {
    const base = fuzzyScore("src/ui/chat.ts", "chat");
    const mid = fuzzyScore("src/chat/ui.ts", "chat");
    assert.ok(base < mid);
  });

  it("empty needle always matches", () => {
    assert.equal(fuzzyScore("anything", ""), 0);
  });

  it("is case-insensitive", () => {
    assert.ok(fuzzyScore("Src/Chat.ts", "chat") < Infinity);
  });
});

describe("fuzzyMatchIndices", () => {
  it("prefers basename for file-name queries", () => {
    assert.deepEqual(fuzzyMatchIndices("src/chat.ts", "chat"), [4, 5, 6, 7]);
  });

  it("falls back to full path subsequence", () => {
    // "sct" cannot fully match basename "chat.ts" → whole path
    // s@0, c@2 (src), t@7 (chat)
    assert.deepEqual(fuzzyMatchIndices("src/chat.ts", "sct"), [0, 2, 7]);
    assert.deepEqual(fuzzyMatchIndices("src/chat.ts", "zzz"), []);
  });
});

describe("remapIndicesToDisplay", () => {
  it("maps absolute path indices onto relative suffix", () => {
    const agent = "/Users/me/repo/src/chat.ts";
    const display = "src/chat.ts";
    // indices of "chat" in agent path
    const start = agent.indexOf("chat");
    const indices = [start, start + 1, start + 2, start + 3];
    const remapped = remapIndicesToDisplay(agent, display, indices);
    assert.deepEqual(remapped, [4, 5, 6, 7]);
  });
});

describe("highlightIndicesForLabel", () => {
  it("falls back to query match on display path", () => {
    const idx = highlightIndicesForLabel("src/chat.ts", "chat");
    assert.deepEqual(idx, [4, 5, 6, 7]);
  });
});
