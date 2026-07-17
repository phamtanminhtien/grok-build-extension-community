import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REWIND_METHODS,
  formatRewindPointDescription,
  formatRewindPointLabel,
  modeTruncatesConversation,
  modesForPoint,
  normalizeRewindMode,
  parseRewindPointsResponse,
  parseRewindResponse,
  rewindExecuteParams,
  rewindPointsParams,
} from "./rewind.ts";

describe("normalizeRewindMode", () => {
  it("accepts wire + aliases", () => {
    assert.equal(normalizeRewindMode("all"), "all");
    assert.equal(normalizeRewindMode("conversation_only"), "conversation_only");
    assert.equal(normalizeRewindMode("Conversation-Only"), "conversation_only");
    assert.equal(normalizeRewindMode("files_only"), "files_only");
    assert.equal(normalizeRewindMode("code_only"), "files_only");
  });

  it("rejects unknown", () => {
    assert.equal(normalizeRewindMode("maybe"), undefined);
    assert.equal(normalizeRewindMode(""), undefined);
  });
});

describe("params", () => {
  it("points + execute camelCase", () => {
    assert.deepEqual(rewindPointsParams("s1"), { sessionId: "s1" });
    assert.deepEqual(
      rewindExecuteParams({
        sessionId: "s1",
        targetPromptIndex: 2,
        mode: "conversation_only",
        force: true,
      }),
      {
        sessionId: "s1",
        targetPromptIndex: 2,
        mode: "conversation_only",
        force: true,
      },
    );
  });
});

describe("modesForPoint", () => {
  it("omits files_only without file changes", () => {
    assert.deepEqual(
      modesForPoint({ hasFileChanges: false }).map((m) => m.mode),
      ["all", "conversation_only"],
    );
    assert.deepEqual(
      modesForPoint({ hasFileChanges: true }).map((m) => m.mode),
      ["all", "conversation_only", "files_only"],
    );
  });
});

describe("modeTruncatesConversation", () => {
  it("all and conversation_only truncate", () => {
    assert.equal(modeTruncatesConversation("all"), true);
    assert.equal(modeTruncatesConversation("conversation_only"), true);
    assert.equal(modeTruncatesConversation("files_only"), false);
  });
});

describe("parseRewindPointsResponse", () => {
  it("maps camel + snake and sorts newest first", () => {
    const pts = parseRewindPointsResponse({
      rewind_points: [
        {
          prompt_index: 0,
          created_at: "t0",
          num_file_snapshots: 0,
          has_file_changes: false,
          prompt_preview: "first",
        },
        {
          promptIndex: 2,
          createdAt: "t2",
          numFileSnapshots: 3,
          hasFileChanges: true,
          promptPreview: "later",
        },
      ],
    });
    assert.equal(pts.length, 2);
    assert.equal(pts[0]!.promptIndex, 2);
    assert.equal(pts[0]!.hasFileChanges, true);
    assert.equal(pts[1]!.promptIndex, 0);
  });

  it("unwraps result envelope", () => {
    const pts = parseRewindPointsResponse({
      result: {
        rewindPoints: [{ promptIndex: 1, createdAt: "", numFileSnapshots: 0 }],
      },
    });
    assert.equal(pts[0]!.promptIndex, 1);
  });
});

describe("parseRewindResponse", () => {
  it("parses success", () => {
    const r = parseRewindResponse({
      success: true,
      targetPromptIndex: 1,
      mode: "all",
      revertedFiles: ["/a.ts"],
      cleanFiles: ["/a.ts"],
      conflicts: [],
      promptText: "hello",
    });
    assert.equal(r.success, true);
    assert.equal(r.targetPromptIndex, 1);
    assert.deepEqual(r.revertedFiles, ["/a.ts"]);
    assert.equal(r.promptText, "hello");
  });

  it("parses conflicts failure", () => {
    const r = parseRewindResponse({
      result: {
        success: false,
        target_prompt_index: 0,
        mode: "files_only",
        conflicts: [{ path: "/x", conflict_type: "content_mismatch" }],
        error: "conflicts",
      },
    });
    assert.equal(r.success, false);
    assert.equal(r.conflicts[0]!.conflictType, "content_mismatch");
    assert.equal(r.error, "conflicts");
  });
});

describe("labels", () => {
  it("formats point row", () => {
    const label = formatRewindPointLabel({
      promptIndex: 3,
      createdAt: "",
      numFileSnapshots: 0,
      hasFileChanges: false,
      promptPreview: "fix the bug in auth",
    });
    assert.match(label, /^#3 /);
    assert.match(label, /fix the bug/);
    assert.match(
      formatRewindPointDescription({
        promptIndex: 0,
        createdAt: "now",
        numFileSnapshots: 2,
        hasFileChanges: true,
      }),
      /2 file/,
    );
  });
});

describe("method names", () => {
  it("match shell routes", () => {
    assert.equal(REWIND_METHODS.points, "x.ai/rewind/points");
    assert.equal(REWIND_METHODS.execute, "x.ai/rewind/execute");
  });
});
