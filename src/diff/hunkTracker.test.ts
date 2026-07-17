import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HUNK_TRACKER_METHODS,
  allActionParams,
  fileActionParams,
  getFilesParams,
  getHunksParams,
  hunkActionParams,
  normalizeHunkAction,
  parseGetFilesResponse,
  parseHunkActionResponse,
  turnActionParams,
} from "./hunkTracker.ts";

describe("normalizeHunkAction", () => {
  it("accepts accept/reject case-insensitively", () => {
    assert.equal(normalizeHunkAction("Accept"), "accept");
    assert.equal(normalizeHunkAction("REJECT"), "reject");
    assert.equal(normalizeHunkAction("  accept  "), "accept");
  });

  it("rejects unknown", () => {
    assert.equal(normalizeHunkAction("maybe"), undefined);
    assert.equal(normalizeHunkAction(""), undefined);
  });
});

describe("request params", () => {
  it("file-action camelCase", () => {
    assert.deepEqual(fileActionParams("s1", "/repo/a.ts", "accept"), {
      sessionId: "s1",
      path: "/repo/a.ts",
      action: "accept",
    });
  });

  it("all-action", () => {
    assert.deepEqual(allActionParams("s1", "reject"), {
      sessionId: "s1",
      action: "reject",
    });
  });

  it("hunk-action + turn-action", () => {
    assert.deepEqual(hunkActionParams("s1", "h-1", "accept"), {
      sessionId: "s1",
      hunkId: "h-1",
      action: "accept",
    });
    assert.deepEqual(turnActionParams("s1", 3, "reject"), {
      sessionId: "s1",
      promptIndex: 3,
      action: "reject",
    });
  });

  it("get-files / get-hunks", () => {
    assert.deepEqual(getFilesParams("s1"), { sessionId: "s1" });
    assert.deepEqual(getHunksParams("s1", { path: "/a", source: "agent" }), {
      sessionId: "s1",
      path: "/a",
      source: "agent",
    });
    assert.deepEqual(getHunksParams("s1", { source: "all" }), {
      sessionId: "s1",
    });
  });
});

describe("method names", () => {
  it("match shell routes", () => {
    assert.equal(
      HUNK_TRACKER_METHODS.fileAction,
      "x.ai/hunk-tracker/file-action",
    );
    assert.equal(
      HUNK_TRACKER_METHODS.allAction,
      "x.ai/hunk-tracker/all-action",
    );
  });
});

describe("parseHunkActionResponse", () => {
  it("parses success with affectedCount", () => {
    assert.deepEqual(
      parseHunkActionResponse({ success: true, affectedCount: 2 }),
      { success: true, error: undefined, affectedCount: 2 },
    );
  });

  it("unwraps result envelope", () => {
    assert.deepEqual(
      parseHunkActionResponse({
        result: { success: false, error: "nope", affected_count: 0 },
      }),
      { success: false, error: "nope", affectedCount: 0 },
    );
  });

  it("handles invalid", () => {
    assert.equal(parseHunkActionResponse(null).success, false);
  });
});

describe("parseGetFilesResponse", () => {
  it("maps camelCase and snake_case", () => {
    const files = parseGetFilesResponse({
      files: [
        {
          path: "/a.ts",
          isAgentFile: true,
          staged: false,
          hunkCount: 2,
          additions: 3,
          deletions: 1,
        },
        {
          path: "/b.ts",
          is_agent_file: false,
          staged: true,
          hunk_count: 1,
          additions: 0,
          deletions: 4,
        },
      ],
    });
    assert.equal(files.length, 2);
    assert.deepEqual(files[0], {
      path: "/a.ts",
      isAgentFile: true,
      staged: false,
      hunkCount: 2,
      additions: 3,
      deletions: 1,
    });
    assert.equal(files[1]!.hunkCount, 1);
    assert.equal(files[1]!.staged, true);
  });

  it("empty on bad payload", () => {
    assert.deepEqual(parseGetFilesResponse({}), []);
  });
});
