import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bannerTextForEvent,
  parseXaiSessionNotification,
  unwrapSessionNotificationParams,
} from "./xaiSessionNotification.ts";

describe("unwrapSessionNotificationParams", () => {
  it("unwraps nested method/params envelope", () => {
    const inner = {
      sessionId: "s1",
      update: { sessionUpdate: "auto_compact_started", percentage: 80 },
    };
    assert.deepEqual(
      unwrapSessionNotificationParams({
        method: "x.ai/session_notification",
        params: inner,
      }),
      inner,
    );
  });
});

describe("parseXaiSessionNotification", () => {
  it("parses retry_state retrying (flattened wire)", () => {
    const p = parseXaiSessionNotification({
      sessionId: "sess-a",
      update: {
        sessionUpdate: "retry_state",
        type: "retrying",
        attempt: 2,
        maxRetries: 5,
        reason: "timeout",
      },
    });
    assert.ok(p);
    assert.equal(p!.sessionId, "sess-a");
    assert.equal(p!.events[0]!.kind, "retry");
    if (p!.events[0]!.kind === "retry") {
      assert.equal(p!.events[0]!.phase, "retrying");
      assert.match(p!.events[0]!.message, /2\/5/);
      assert.match(p!.events[0]!.message, /timeout/);
    }
  });

  it("parses auto_compact_completed with snake_case fields", () => {
    const p = parseXaiSessionNotification({
      session_id: "s2",
      update: {
        sessionUpdate: "auto_compact_completed",
        tokens_before: 120_000,
        tokens_after: 40_000,
      },
    });
    assert.ok(p);
    const ev = p!.events[0]!;
    assert.equal(ev.kind, "auto_compact");
    if (ev.kind === "auto_compact") {
      assert.equal(ev.phase, "completed");
      assert.equal(ev.tokensAfter, 40_000);
      assert.match(ev.message, /→/);
    }
  });

  it("parses subagent_spawned and finished", () => {
    const spawn = parseXaiSessionNotification({
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "c1",
        parent_session_id: "parent",
        child_session_id: "c1",
        subagent_type: "explore",
        description: "scan repo",
      },
    });
    assert.equal(spawn!.events[0]!.kind, "subagent");
    if (spawn!.events[0]!.kind === "subagent") {
      assert.equal(spawn!.events[0]!.phase, "spawned");
      assert.match(spawn!.events[0]!.message, /explore/);
      assert.match(spawn!.events[0]!.message, /scan repo/);
    }

    const fin = parseXaiSessionNotification({
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: "c1",
        child_session_id: "c1",
        status: "completed",
        tool_calls: 3,
        turns: 2,
        duration_ms: 1000,
      },
    });
    if (fin!.events[0]!.kind === "subagent") {
      assert.equal(fin!.events[0]!.phase, "finished");
      assert.equal(fin!.events[0]!.status, "completed");
    }
  });

  it("parses pending_interaction plan_approval", () => {
    const p = parseXaiSessionNotification({
      sessionId: "s",
      update: {
        sessionUpdate: "pending_interaction",
        tool_call_id: "tc-plan",
        kind: "plan_approval",
      },
    });
    const ev = p!.events[0]!;
    assert.equal(ev.kind, "interaction");
    if (ev.kind === "interaction") {
      assert.equal(ev.phase, "pending");
      assert.equal(ev.interactionKind, "plan_approval");
      assert.equal(ev.toolCallId, "tc-plan");
    }
  });

  it("returns null without update", () => {
    assert.equal(parseXaiSessionNotification({ sessionId: "x" }), null);
  });
});

describe("bannerTextForEvent", () => {
  it("suppresses progress and unknown", () => {
    assert.equal(
      bannerTextForEvent({
        kind: "subagent",
        phase: "progress",
        message: "…",
      }),
      null,
    );
    assert.equal(
      bannerTextForEvent({ kind: "unknown", sessionUpdate: "foo" }),
      null,
    );
  });

  it("suppresses interaction banners (UI owns those prompts)", () => {
    assert.equal(
      bannerTextForEvent({
        kind: "interaction",
        phase: "pending",
        toolCallId: "tc",
        interactionKind: "plan_approval",
        message: "Waiting for plan approval",
      }),
      null,
    );
    assert.equal(
      bannerTextForEvent({
        kind: "interaction",
        phase: "resolved",
        toolCallId: "tc",
        message: "Interaction resolved",
      }),
      null,
    );
  });

  it("surfaces retry and compact", () => {
    assert.ok(
      bannerTextForEvent({
        kind: "retry",
        phase: "retrying",
        message: "Retrying…",
      }),
    );
    assert.ok(
      bannerTextForEvent({
        kind: "auto_compact",
        phase: "started",
        message: "Compacting…",
      }),
    );
  });
});
