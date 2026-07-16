import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore } from "./fuzzyScore.ts";

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
});
