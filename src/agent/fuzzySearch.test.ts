import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatFuzzyMatchLabel,
  fuzzyChangeParams,
  fuzzyCloseParams,
  fuzzyOpenParams,
  parseFuzzyMatch,
  parseFuzzyOpenResponse,
  parseFuzzyStatusNotification,
} from "./fuzzySearch.ts";

describe("fuzzy params", () => {
  it("open/change/close bodies", () => {
    assert.deepEqual(
      fuzzyOpenParams({
        sessionId: "s1",
        cwd: "/repo",
        root: "src",
      }),
      {
        hidden: false,
        sessionId: "s1",
        cwd: "/repo",
        root: "src",
      },
    );
    assert.deepEqual(
      fuzzyChangeParams({ searchId: "sid", query: "main", limit: 20 }),
      {
        searchId: "sid",
        query: "main",
        dirsOnly: false,
        limit: 20,
      },
    );
    assert.deepEqual(fuzzyCloseParams("sid"), { searchId: "sid" });
  });
});

describe("parseFuzzyOpenResponse", () => {
  it("parses camel + envelope", () => {
    const r = parseFuzzyOpenResponse({
      result: { sessionId: "s1", searchId: "search-9" },
    });
    assert.equal(r?.searchId, "search-9");
    assert.equal(r?.sessionId, "s1");
  });

  it("null without searchId", () => {
    assert.equal(parseFuzzyOpenResponse({}), null);
  });
});

describe("parseFuzzyMatch / status", () => {
  it("parses agent FuzzyMatchResult shape", () => {
    const m = parseFuzzyMatch({
      name: "chat.ts",
      type: "file",
      path: "/repo/src/ui/chat.ts",
      score: 42,
      indices: [0, 1],
    });
    assert.equal(m?.name, "chat.ts");
    assert.equal(m?.isDir, false);
    assert.equal(m?.score, 42);
    assert.match(formatFuzzyMatchLabel(m!), /chat\.ts/);
  });

  it("parses status notification and sorts by score", () => {
    const st = parseFuzzyStatusNotification({
      sessionId: "s1",
      searchId: "sid",
      total: 2,
      done: true,
      generation: 3,
      matches: [
        { name: "a", type: "file", path: "/a", score: 1, indices: [] },
        { name: "b", type: "file", path: "/b", score: 99, indices: [] },
      ],
    });
    assert.equal(st?.searchId, "sid");
    assert.equal(st?.done, true);
    assert.equal(st?.matches[0]!.path, "/b");
    assert.equal(st?.matches[1]!.path, "/a");
  });

  it("directory type", () => {
    const m = parseFuzzyMatch({
      name: "src",
      type: "directory",
      path: "/repo/src",
      score: 1,
      indices: [],
    });
    assert.equal(m?.isDir, true);
  });
});
