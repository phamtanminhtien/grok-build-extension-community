import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FINISHED_TTL_MS,
  TasksStore,
  formatElapsed,
  formatTasksReport,
  itemFromSubagentEvent,
  itemFromSubagentListEntry,
  itemFromTaskListEntry,
  parseTaskBackgrounded,
  parseTaskCompleted,
  serializeTasksForWebview,
  unwrapTaskNotificationParams,
} from "./tasksStore.ts";

describe("parseTaskBackgrounded", () => {
  it("parses bash background task", () => {
    const item = parseTaskBackgrounded({
      sessionUpdate: "task_backgrounded",
      task_id: "t1",
      command: "npm test",
      cwd: "/w",
      output_file: "/tmp/out.log",
      description: "Run tests",
    });
    assert.ok(item);
    assert.equal(item!.id, "t1");
    assert.equal(item!.kind, "task");
    assert.equal(item!.tag, "Task");
    assert.equal(item!.label, "Run tests");
    assert.equal(item!.status, "running");
    assert.equal(item!.outputFile, "/tmp/out.log");
    assert.equal(item!.canKill, true);
  });

  it("tags monitors", () => {
    const item = parseTaskBackgrounded({
      taskId: "m1",
      command: "tail -f log",
      monitorDescription: "Watch errors",
    });
    assert.ok(item);
    assert.equal(item!.kind, "monitor");
    assert.equal(item!.tag, "Monitor");
    assert.equal(item!.label, "Watch errors");
  });
});

describe("parseTaskCompleted", () => {
  it("marks non-zero exit as failed", () => {
    const item = parseTaskCompleted({
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "t1",
        command: "false",
        completed: true,
        exit_code: 1,
        output: "boom",
        output_file: "/tmp/x",
      },
    });
    assert.ok(item);
    assert.equal(item!.status, "failed");
    assert.equal(item!.canKill, false);
    assert.match(item!.detail ?? "", /exit 1/);
  });

  it("marks kill as cancelled", () => {
    const item = parseTaskCompleted({
      taskSnapshot: {
        taskId: "t2",
        command: "sleep 99",
        completed: true,
        explicitlyKilled: true,
        exit_code: -1,
      },
    });
    assert.ok(item);
    assert.equal(item!.status, "cancelled");
  });
});

describe("unwrapTaskNotificationParams", () => {
  it("unwraps nested params", () => {
    const got = unwrapTaskNotificationParams({
      method: "x.ai/task_backgrounded",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "task_backgrounded", task_id: "t1" },
      },
    });
    assert.ok(got);
    assert.equal(got!.sessionId, "s1");
    assert.equal(got!.update.task_id, "t1");
  });
});

describe("itemFromSubagentEvent", () => {
  it("spawn uses description and type", () => {
    const item = itemFromSubagentEvent({
      kind: "subagent",
      phase: "spawned",
      message: "started",
      subagentId: "a1",
      childSessionId: "c1",
      subagentType: "explore",
      description: "map routes",
    });
    assert.ok(item);
    assert.equal(item!.kind, "subagent");
    assert.equal(item!.tag, "Explore");
    assert.equal(item!.label, "map routes");
    assert.equal(item!.status, "running");
  });

  it("finished failed", () => {
    const item = itemFromSubagentEvent({
      kind: "subagent",
      phase: "finished",
      message: "Subagent failed: boom",
      subagentId: "a1",
      status: "failed",
    });
    assert.ok(item);
    assert.equal(item!.status, "failed");
    assert.equal(item!.canKill, false);
  });
});

describe("list parsers", () => {
  it("task list entry", () => {
    const item = itemFromTaskListEntry({
      task_id: "t9",
      command: "cargo test",
      completed: false,
      kind: "bash",
    });
    assert.ok(item);
    assert.equal(item!.status, "running");
    assert.equal(item!.label, "cargo test");
  });

  it("subagent list entry", () => {
    const item = itemFromSubagentListEntry({
      subagentId: "s1",
      childSessionId: "c1",
      subagentType: "plan",
      description: "design auth",
      turnCount: 2,
      toolCallCount: 5,
      contextUsagePct: 12,
    });
    assert.ok(item);
    assert.equal(item!.tag, "Plan");
    assert.match(item!.detail ?? "", /2 turns/);
  });
});

describe("TasksStore", () => {
  it("hides completed from list immediately (TUI show_done=false)", () => {
    const store = new TasksStore();
    store.applyTaskNotification("sess", {
      sessionUpdate: "task_backgrounded",
      task_id: "t1",
      command: "npm test",
      description: "tests",
      output_file: "/tmp/o",
    });
    assert.equal(store.snapshot().items.length, 1);
    store.applyTaskNotification("sess", {
      sessionUpdate: "task_completed",
      task_snapshot: {
        task_id: "t1",
        command: "npm test",
        completed: true,
        exit_code: 0,
        output: "ok",
      },
    });
    const snap = store.snapshot();
    assert.equal(snap.runningCount, 0);
    assert.equal(snap.items.length, 0);
    // Still resolvable for View until TTL prune
    const kept = store.get("t1");
    assert.ok(kept);
    assert.equal(kept!.status, "done");
    assert.equal(kept!.label, "tests");
    assert.equal(kept!.outputFile, "/tmp/o");
  });

  it("hides finished subagents from list immediately", () => {
    const store = new TasksStore();
    store.applySubagentEvent({
      kind: "subagent",
      phase: "spawned",
      message: "go",
      subagentId: "a1",
      subagentType: "explore",
      description: "scan",
    });
    assert.equal(store.snapshot().items.length, 1);
    store.applySubagentEvent({
      kind: "subagent",
      phase: "finished",
      message: "Subagent completed",
      subagentId: "a1",
      status: "completed",
    });
    assert.equal(store.snapshot().items.length, 0);
    assert.equal(store.get("a1")!.status, "done");
  });

  it("prunes finished from internal map after TTL", () => {
    const store = new TasksStore();
    const t0 = 1_000_000;
    store.applyTaskNotification(
      "s",
      {
        sessionUpdate: "task_backgrounded",
        task_id: "t1",
        command: "x",
      },
      t0,
    );
    store.applyTaskNotification(
      "s",
      {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "t1",
          command: "x",
          completed: true,
          exit_code: 0,
        },
      },
      t0 + 100,
    );
    assert.equal(store.snapshot(t0 + 100).items.length, 0);
    assert.ok(store.get("t1"));
    store.pruneFinished(t0 + 100 + FINISHED_TTL_MS + 1);
    assert.equal(store.get("t1"), undefined);
  });

  it("markStopping", () => {
    const store = new TasksStore();
    store.applySubagentEvent({
      kind: "subagent",
      phase: "spawned",
      message: "go",
      subagentId: "a1",
      subagentType: "explore",
      description: "scan",
    });
    store.markStopping("a1");
    assert.equal(store.get("a1")!.status, "stopping");
  });
});

describe("formatElapsed / serialize", () => {
  it("formats seconds and epoch start", () => {
    assert.equal(formatElapsed(5_000), "5s");
    const now = 1_700_000_000_000;
    assert.equal(formatElapsed(now - 90_000, now), "1m 30s");
  });

  it("serialize adds statusLabel", () => {
    const store = new TasksStore();
    store.applySubagentEvent({
      kind: "subagent",
      phase: "spawned",
      message: "go",
      subagentId: "a1",
      description: "x",
      subagentType: "explore",
    });
    const ser = serializeTasksForWebview(store.snapshot());
    assert.equal(ser.runningCount, 1);
    assert.equal(ser.items[0]!.statusLabel, "running");
  });
});

describe("formatTasksReport", () => {
  it("empty message", () => {
    assert.match(
      formatTasksReport({ sessionId: "", items: [], runningCount: 0 }),
      /No background/,
    );
  });

  it("groups rows", () => {
    const store = new TasksStore();
    store.applySubagentEvent({
      kind: "subagent",
      phase: "spawned",
      message: "go",
      subagentId: "a1",
      description: "scan",
      subagentType: "explore",
    });
    store.applyTaskNotification("s", {
      sessionUpdate: "task_backgrounded",
      task_id: "t1",
      command: "npm test",
      description: "tests",
    });
    const report = formatTasksReport(store.snapshot());
    assert.match(report, /Subagents:/);
    assert.match(report, /Tasks:/);
    assert.match(report, /Explore/);
    assert.match(report, /tests/);
  });
});
