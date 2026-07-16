import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayTitle,
  formatTimeAgo,
  isEmptyHistorySession,
  isHiddenSession,
  repoNameFromCwd,
} from "./grokSession.ts";

describe("repoNameFromCwd", () => {
  it("uses last two components", () => {
    assert.equal(
      repoNameFromCwd("/Users/tienpham/Work/entj-pham/grok-build"),
      "entj-pham-grok-build",
    );
  });
});

describe("displayTitle", () => {
  it("prefers generated_title", () => {
    assert.equal(
      displayTitle({
        generatedTitle: "Gen",
        sessionSummary: "Sum",
        sessionId: "x",
      }),
      "Gen",
    );
  });
  it("falls back to session_summary", () => {
    assert.equal(
      displayTitle({
        generatedTitle: "",
        sessionSummary: "Hi",
        sessionId: "x",
      }),
      "Hi",
    );
  });
  it("uses no summary placeholder", () => {
    assert.equal(
      displayTitle({ sessionId: "abc" }),
      "(no summary)",
    );
  });
});

describe("isHiddenSession", () => {
  it("hides subagent kinds by default", () => {
    assert.equal(isHiddenSession({ sessionKind: "subagent" }), true);
    assert.equal(isHiddenSession({ sessionKind: "subagent_fork" }), true);
  });
  it("shows normal sessions", () => {
    assert.equal(isHiddenSession({ sessionKind: undefined }), false);
  });
});

describe("formatTimeAgo", () => {
  it("formats minutes", () => {
    const now = 1_000_000;
    assert.equal(formatTimeAgo(now - 5 * 60 * 1000, now), "5m ago");
  });
});

describe("isEmptyHistorySession", () => {
  it("hides no-summary placeholders", () => {
    assert.equal(
      isEmptyHistorySession({ title: "(no summary)", messageCount: 0 }),
      true,
    );
    assert.equal(isEmptyHistorySession({ title: "", messageCount: 2 }), true);
  });
  it("hides zero-message shells", () => {
    assert.equal(
      isEmptyHistorySession({ title: "Hi", messageCount: 0 }),
      true,
    );
  });
  it("keeps real conversations", () => {
    assert.equal(
      isEmptyHistorySession({ title: "Hi", messageCount: 3 }),
      false,
    );
  });
});
