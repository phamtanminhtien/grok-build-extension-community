import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyWorktreeParams,
  createWorktreeParams,
  formatGcReportMessage,
  formatStatusToast,
  formatWorktreeAge,
  formatWorktreeLabel,
  gcWorktreeParams,
  listWorktreeParams,
  parseApplyResponse,
  parseCreateWorktreeResponse,
  parseGcReport,
  parseRemoveWorktreeResponse,
  parseWorktreeListResponse,
  parseWorktreeShowResponse,
  parseWorktreeStatusNotification,
  removeWorktreeParams,
  showWorktreeParams,
} from "./worktree.ts";

describe("worktree params", () => {
  it("listWorktreeParams sends dual include flags", () => {
    const p = listWorktreeParams({
      repo: "myrepo",
      types: ["session", "fork"],
      includeAll: true,
    });
    assert.equal(p.repo, "myrepo");
    assert.deepEqual(p.type, ["session", "fork"]);
    assert.equal(p.includeAll, true);
    assert.equal(p.include_all, true);
  });

  it("show/remove/apply/create/gc bodies match wire", () => {
    assert.deepEqual(showWorktreeParams("wt-1"), { idOrPath: "wt-1" });
    assert.deepEqual(removeWorktreeParams({ idOrPath: "wt-1", force: true }), {
      idOrPath: "wt-1",
      force: true,
      dryRun: false,
    });
    assert.deepEqual(
      applyWorktreeParams({
        sessionId: "s1",
        worktreePath: "/tmp/wt",
        mode: "merge",
      }),
      {
        sessionId: "s1",
        worktreePath: "/tmp/wt",
        mode: "merge",
      },
    );
    const create = createWorktreeParams({
      sessionId: "s1",
      sourcePath: "/repo",
      label: "feature",
    });
    assert.equal(create.sessionId, "s1");
    assert.equal(create.sourcePath, "/repo");
    assert.equal(create.label, "feature");
    assert.equal(create.copyMode, "dirty");
    assert.deepEqual(gcWorktreeParams({ dryRun: true, maxAge: "7d" }), {
      dryRun: true,
      force: false,
      maxAge: "7d",
    });
  });
});

describe("parseWorktreeListResponse", () => {
  it("parses camelCase records", () => {
    const list = parseWorktreeListResponse([
      {
        id: "abc123",
        path: "/home/u/.grok/worktrees/repo/abc123",
        sourceRepo: "/home/u/repo",
        repoName: "repo",
        kind: "session",
        creationMode: "linked",
        gitRef: "main",
        headCommit: "deadbeef",
        sessionId: "sess-1",
        createdAt: 1_700_000_000,
        status: "alive",
        metadata: { label: "my-label" },
      },
    ]);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "abc123");
    assert.equal(list[0]!.label, "my-label");
    assert.equal(list[0]!.sessionId, "sess-1");
    assert.equal(list[0]!.kind, "session");
  });

  it("parses snake_case + result envelope", () => {
    const list = parseWorktreeListResponse({
      result: [
        {
          id: "x",
          path: "/wt",
          source_repo: "/repo",
          repo_name: "repo",
          kind: "fork",
          creation_mode: "git",
          created_at: 100,
          status: "dead",
        },
      ],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.sourceRepo, "/repo");
    assert.equal(list[0]!.status, "dead");
  });

  it("returns empty for garbage", () => {
    assert.deepEqual(parseWorktreeListResponse(null), []);
    assert.deepEqual(parseWorktreeListResponse({}), []);
  });
});

describe("parse show/remove/gc/apply/create", () => {
  it("show null", () => {
    assert.equal(parseWorktreeShowResponse(null), null);
    assert.equal(parseWorktreeShowResponse({ result: null }), null);
  });

  it("remove", () => {
    const r = parseRemoveWorktreeResponse({
      result: { removed: true, resolvedPath: "/wt" },
    });
    assert.equal(r.removed, true);
    assert.equal(r.resolvedPath, "/wt");
  });

  it("gc report", () => {
    const r = parseGcReport({
      dead_removed: 1,
      expiredRemoved: 2,
      skipped_alive: 3,
      removeFailed: 0,
    });
    assert.deepEqual(r, {
      deadRemoved: 1,
      expiredRemoved: 2,
      skippedAlive: 3,
      removeFailed: 0,
    });
    assert.match(formatGcReportMessage(r, true), /dry-run/);
  });

  it("apply success and conflicts", () => {
    const ok = parseApplyResponse({
      status: "success",
      files: [{ path: "a.ts" }],
      gitRoot: "/repo",
    });
    assert.equal(ok?.status, "success");
    if (ok?.status === "success") {
      assert.equal(ok.gitRoot, "/repo");
      assert.equal(ok.files[0]!.path, "a.ts");
    }

    const bad = parseApplyResponse({
      status: "conflicts",
      files: [],
      conflicts: [{ path: "b.ts", type: "both_modified" }],
    });
    assert.equal(bad?.status, "conflicts");
    if (bad?.status === "conflicts") {
      assert.equal(bad.conflicts[0]!.path, "b.ts");
    }
  });

  it("create response", () => {
    const c = parseCreateWorktreeResponse({
      status: "creating",
      sessionId: "s1",
      worktreePath: "/wt",
    });
    assert.equal(c?.status, "creating");
    assert.equal(c?.worktreePath, "/wt");
  });
});

describe("status notification + labels", () => {
  it("parses progress events", () => {
    const ev = parseWorktreeStatusNotification({
      status: "created",
      sessionId: "s1",
      worktreePath: "/wt",
      commit: "abc",
    });
    assert.equal(ev?.status, "created");
    assert.match(formatStatusToast(ev!), /ready/);
  });

  it("formats age and labels", () => {
    assert.equal(formatWorktreeAge(100, 160), "1m");
    assert.equal(formatWorktreeAge(100, 100 + 86400 * 2), "2d");
    const label = formatWorktreeLabel({
      id: "id1",
      path: "/p",
      sourceRepo: "/r",
      repoName: "r",
      kind: "session",
      creationMode: "linked",
      createdAt: 1,
      status: "alive",
      label: "feat",
    });
    assert.match(label, /feat/);
    assert.match(label, /session/);
  });
});
