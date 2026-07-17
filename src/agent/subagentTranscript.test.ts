import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentPanelModel,
  formatSubagentTranscriptMarkdown,
  parseSubagentGetResponse,
  subagentTranscriptTitle,
} from "./subagentTranscript.ts";

describe("parseSubagentGetResponse", () => {
  it("unwraps result.snapshot", () => {
    const snap = parseSubagentGetResponse({
      result: {
        snapshot: {
          subagentId: "a1",
          status: "completed",
          description: "scan",
          subagentType: "explore",
          output: "hello",
        },
      },
    });
    assert.ok(snap);
    assert.equal(snap!.subagentId, "a1");
    assert.equal(snap!.output, "hello");
  });

  it("accepts bare snapshot", () => {
    const snap = parseSubagentGetResponse({
      snapshot: { subagent_id: "x", status: "running" },
    });
    assert.ok(snap);
    assert.equal(snap!.subagent_id, "x");
  });

  it("returns null on garbage", () => {
    assert.equal(parseSubagentGetResponse(null), null);
    assert.equal(parseSubagentGetResponse("nope"), null);
  });
});

describe("formatSubagentTranscriptMarkdown", () => {
  it("includes title, description, tools, and output", () => {
    const md = formatSubagentTranscriptMarkdown({
      subagentId: "a1",
      childSessionId: "c1",
      parentSessionId: "p1",
      subagentType: "explore",
      description: "map routes",
      status: "completed",
      durationMs: 12_500,
      turns: 3,
      toolCalls: 7,
      output: "found 2 handlers",
      toolsUsed: ["grep", "read_file"],
    });
    assert.match(md, /# Subagent · Explore/);
    assert.match(md, /map routes/);
    assert.match(md, /found 2 handlers/);
    assert.match(md, /grep/);
  });

  it("notes still running without output", () => {
    const md = formatSubagentTranscriptMarkdown({
      subagentId: "a1",
      subagentType: "plan",
      description: "design",
      status: "running",
      turnCount: 1,
    });
    assert.match(md, /Still running/);
  });
});

describe("subagentTranscriptTitle", () => {
  it("truncates long description", () => {
    const t = subagentTranscriptTitle({
      subagentType: "general-purpose",
      description: "a".repeat(80),
    });
    assert.match(t, /^Subagent ·/);
    assert.ok(t.length < 80);
  });
});

describe("buildSubagentPanelModel", () => {
  it("shapes chips and canKill for running", () => {
    const m = buildSubagentPanelModel({
      subagentId: "a1",
      subagentType: "explore",
      description: "map routes",
      status: "running",
      turnCount: 2,
      toolCallCount: 4,
      contextUsagePct: 11,
      durationMs: 5000,
    });
    assert.equal(m.typeLabel, "Explore");
    assert.equal(m.canKill, true);
    assert.equal(m.statusLabel, "running");
    assert.ok(m.chips.some((c) => /turn/.test(c)));
    assert.match(m.bodyMarkdown, /Still running/);
  });

  it("completed has output and no kill", () => {
    const m = buildSubagentPanelModel({
      subagentId: "a1",
      subagentType: "plan",
      description: "design",
      status: "completed",
      output: "done body",
      durationMs: 12000,
    });
    assert.equal(m.canKill, false);
    assert.equal(m.statusLabel, "done");
    assert.match(m.bodyMarkdown, /done body/);
  });
});
