import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClientCapabilitiesMeta,
  buildInitializeClientCapabilities,
  canonicalHunkTrackerMode,
} from "./clientCapabilities.ts";

describe("canonicalHunkTrackerMode", () => {
  it("defaults blank/absent to agent_only", () => {
    assert.equal(canonicalHunkTrackerMode(undefined), "agent_only");
    assert.equal(canonicalHunkTrackerMode(null), "agent_only");
    assert.equal(canonicalHunkTrackerMode(""), "agent_only");
    assert.equal(canonicalHunkTrackerMode("   "), "agent_only");
  });

  it("canonicalizes off aliases", () => {
    assert.equal(canonicalHunkTrackerMode("off"), "off");
    assert.equal(canonicalHunkTrackerMode("OFF"), "off");
    assert.equal(canonicalHunkTrackerMode("Disabled"), "off");
  });

  it("canonicalizes agent_only aliases", () => {
    assert.equal(canonicalHunkTrackerMode("agent_only"), "agent_only");
    assert.equal(canonicalHunkTrackerMode("agent-only"), "agent_only");
  });
});

describe("buildClientCapabilitiesMeta", () => {
  it("matches TUI default flags", () => {
    const meta = buildClientCapabilitiesMeta();
    assert.equal(meta["x.ai/incrementalBashOutput"], true);
    assert.equal(meta["x.ai/bashOutputNoColor"], true);
    assert.equal(meta["x.ai/gitHeadChanged"], true);
    assert.deepEqual(meta["x.ai/hunkTracker"], { mode: "agent_only" });
  });

  it("honors hunk mode override", () => {
    const meta = buildClientCapabilitiesMeta({ hunkTrackerMode: "off" });
    assert.deepEqual(meta["x.ai/hunkTracker"], { mode: "off" });
  });
});

describe("buildInitializeClientCapabilities", () => {
  it("advertises fs, no terminal, and meta", () => {
    const caps = buildInitializeClientCapabilities();
    assert.equal(caps.fs.readTextFile, true);
    assert.equal(caps.fs.writeTextFile, true);
    assert.equal(caps.terminal, false);
    assert.equal(caps._meta["x.ai/incrementalBashOutput"], true);
  });
});
