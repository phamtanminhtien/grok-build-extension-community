import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCompactParams,
  buildForkParams,
  compactRequestBody,
  forkRequestBody,
  parseForkArgs,
  parseForkResponse,
  parseRenameArgs,
  parseSuccessFlag,
  renameRequestBody,
} from "./sessionAdmin.ts";

describe("sessionAdmin compact", () => {
  it("builds params with optional context", () => {
    assert.deepEqual(buildCompactParams("s1", ""), { sessionId: "s1" });
    assert.deepEqual(buildCompactParams("s1", " keep auth "), {
      sessionId: "s1",
      userContext: "keep auth",
    });
    assert.deepEqual(
      compactRequestBody({ sessionId: "s1", userContext: "x" }),
      {
        sessionId: "s1",
        userContext: "x",
      },
    );
  });
});

describe("sessionAdmin rename", () => {
  it("requires non-blank title", () => {
    assert.equal(parseRenameArgs(""), null);
    assert.equal(parseRenameArgs("   "), null);
    assert.equal(parseRenameArgs(" My title "), "My title");
    assert.deepEqual(
      renameRequestBody({ sessionId: "s", title: "T", cwd: "/w" }),
      { sessionId: "s", title: "T", cwd: "/w" },
    );
  });
});

describe("sessionAdmin fork", () => {
  it("strips worktree flags and keeps directive", () => {
    assert.deepEqual(parseForkArgs("--worktree continue here"), {
      directive: "continue here",
    });
    assert.deepEqual(parseForkArgs(""), {});
    const p = buildForkParams("src", "/repo", "--no-worktree hello");
    assert.equal(p.sourceSessionId, "src");
    assert.equal(p.sourceCwd, "/repo");
    assert.equal(p.newCwd, "/repo");
    assert.equal(p.directive, "hello");
    assert.deepEqual(forkRequestBody(p), {
      sourceSessionId: "src",
      sourceCwd: "/repo",
      newCwd: "/repo",
    });
  });

  it("parses fork response camel and nested", () => {
    const r = parseForkResponse({
      result: {
        newSessionId: "n1",
        newCwd: "/r",
        parentSessionId: "p1",
        chatMessagesCopied: 3,
      },
    });
    assert.deepEqual(r, {
      newSessionId: "n1",
      newCwd: "/r",
      parentSessionId: "p1",
      chatMessagesCopied: 3,
      updatesCopied: undefined,
    });
  });
});

describe("parseSuccessFlag", () => {
  it("treats empty / success true as ok", () => {
    assert.equal(parseSuccessFlag({}), true);
    assert.equal(parseSuccessFlag({ result: { success: true } }), true);
    assert.equal(parseSuccessFlag({ result: { success: false } }), false);
  });
});
