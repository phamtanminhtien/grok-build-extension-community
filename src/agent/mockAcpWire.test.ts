/**
 * Mock-ACP wire smoke: no live binary — exercises parse/build contracts
 * the extension relies on for host UI (worktree + fuzzy + queue envelopes).
 *
 * Full process integration remains `yarn smoke:cli` when `grok` is installed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toAcpExtWireMethod } from "./acpExtMethod.ts";
import {
  fuzzyChangeParams,
  fuzzyCloseParams,
  fuzzyOpenParams,
  parseFuzzyOpenResponse,
  parseFuzzyStatusNotification,
} from "./fuzzySearch.ts";
import {
  applyWorktreeParams,
  listWorktreeParams,
  parseWorktreeListResponse,
  removeWorktreeParams,
} from "./worktree.ts";
import { parseQueueChanged } from "./promptQueue.ts";

/** Minimal JSON-RPC style ext response envelope (agent → client). */
function extOk<T>(result: T): { result: T } {
  return { result };
}

describe("mock ACP wire — method naming", () => {
  it("prefixes search and worktree routes for ext_method routing", () => {
    assert.equal(
      toAcpExtWireMethod("x.ai/search/fuzzy/open"),
      "_x.ai/search/fuzzy/open",
    );
    assert.equal(
      toAcpExtWireMethod("x.ai/git/worktree/list"),
      "_x.ai/git/worktree/list",
    );
  });
});

describe("mock ACP wire — fuzzy open session", () => {
  it("open → status → close request shapes", () => {
    const openBody = fuzzyOpenParams({
      sessionId: "sess-mock",
      cwd: "/tmp/repo",
    });
    assert.equal(openBody.sessionId, "sess-mock");
    assert.equal(openBody.cwd, "/tmp/repo");

    const openResp = parseFuzzyOpenResponse(
      extOk({ sessionId: "sess-mock", searchId: "search-1" }),
    );
    assert.equal(openResp?.searchId, "search-1");

    const changeBody = fuzzyChangeParams({
      searchId: openResp!.searchId,
      query: "chat",
      limit: 10,
    });
    assert.equal(changeBody.searchId, "search-1");
    assert.equal(changeBody.query, "chat");

    // Simulate agent push notification (not a request response).
    const status = parseFuzzyStatusNotification({
      sessionId: "sess-mock",
      searchId: "search-1",
      matches: [
        {
          name: "chat.ts",
          type: "file",
          path: "/tmp/repo/src/chat.ts",
          score: 100,
          indices: [0, 1, 2, 3],
        },
      ],
      total: 1,
      done: true,
      generation: 1,
    });
    assert.equal(status?.matches.length, 1);
    assert.equal(status?.matches[0]!.path, "/tmp/repo/src/chat.ts");

    assert.deepEqual(fuzzyCloseParams("search-1"), { searchId: "search-1" });
  });
});

describe("mock ACP wire — worktree list/remove", () => {
  it("list envelope + remove params", () => {
    const listBody = listWorktreeParams({ includeAll: false });
    assert.equal(listBody.includeAll, false);

    const records = parseWorktreeListResponse(
      extOk([
        {
          id: "wt1",
          path: "/tmp/.grok/worktrees/repo/wt1",
          sourceRepo: "/tmp/repo",
          repoName: "repo",
          kind: "session",
          creationMode: "linked",
          createdAt: 1_700_000_000,
          status: "alive",
        },
      ]),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, "wt1");

    const remove = removeWorktreeParams({ idOrPath: "wt1", force: false });
    assert.equal(remove.idOrPath, "wt1");

    const apply = applyWorktreeParams({
      sessionId: "sess-mock",
      worktreePath: records[0]!.path,
      mode: "overwrite",
    });
    assert.equal(apply.mode, "overwrite");
  });
});

describe("mock ACP wire — queue changed notification", () => {
  it("parses server-authoritative queue snapshot", () => {
    const changed = parseQueueChanged({
      sessionId: "sess-mock",
      entries: [
        {
          id: "p1",
          text: "follow up",
          version: 0,
          status: "queued",
        },
      ],
    });
    assert.ok(changed);
    assert.equal(changed!.sessionId, "sess-mock");
    assert.equal(changed!.entries.length, 1);
    assert.equal(changed!.entries[0]!.text, "follow up");
  });
});
