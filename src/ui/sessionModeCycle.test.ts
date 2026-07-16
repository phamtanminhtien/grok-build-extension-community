import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CYCLE_ORDER,
  cycleMode,
  cycleModeFromAgent,
  modeButtonLabel,
  modeLabel,
  modeToAcpModeId,
  modeToPermissionCanonical,
  modeToast,
  modeWantsAlwaysApprove,
  modeWantsAuto,
  modeWantsYolo,
} from "./sessionModeCycle.ts";

describe("cycleMode", () => {
  it("rotates Normal → Plan → Auto → Always-Approve → Normal (TUI)", () => {
    assert.equal(cycleMode("normal"), "plan");
    assert.equal(cycleMode("plan"), "auto");
    assert.equal(cycleMode("auto"), "always-approve");
    assert.equal(cycleMode("always-approve"), "normal");
  });

  it("full ring returns to start", () => {
    let m: ReturnType<typeof cycleMode> = "normal";
    for (let i = 0; i < CYCLE_ORDER.length; i++) {
      m = cycleMode(m);
    }
    assert.equal(m, "normal");
  });
});

describe("mode labels match TUI cycle banner", () => {
  it("button labels are Title Case (not YOLO / not wire ids)", () => {
    assert.equal(modeButtonLabel("normal"), "Normal");
    assert.equal(modeButtonLabel("plan"), "Plan");
    assert.equal(modeButtonLabel("auto"), "Auto");
    assert.equal(modeButtonLabel("always-approve"), "Always Approve");
    assert.equal(modeLabel("always-approve"), "Always Approve");
  });

  it("maps ACP + permission wire", () => {
    assert.equal(modeToAcpModeId("plan"), "plan");
    assert.equal(modeToAcpModeId("auto"), "default");
    assert.equal(modeToAcpModeId("always-approve"), "default");
    assert.equal(modeToPermissionCanonical("auto"), "auto");
    assert.equal(modeToPermissionCanonical("always-approve"), "always-approve");
    assert.equal(modeToPermissionCanonical("normal"), "ask");
    assert.equal(modeWantsYolo("always-approve"), true);
    assert.equal(modeWantsAuto("auto"), true);
    assert.equal(modeWantsAlwaysApprove("always-approve"), true);
    assert.equal(modeWantsYolo("auto"), false);
  });

  it("yolo toast warns like TUI", () => {
    assert.match(modeToast("always-approve"), /Always Approve ON/);
    assert.match(modeToast("auto"), /Auto \(classifier\)/);
  });
});

describe("cycleModeFromAgent", () => {
  it("prefers plan over yolo/auto", () => {
    assert.equal(cycleModeFromAgent("plan", { yolo: true, auto: true }), "plan");
  });

  it("yolo wins over auto", () => {
    assert.equal(
      cycleModeFromAgent("default", { yolo: true, auto: true }),
      "always-approve",
    );
  });

  it("maps auto and normal", () => {
    assert.equal(cycleModeFromAgent("default", { auto: true }), "auto");
    assert.equal(cycleModeFromAgent("default", { yolo: false }), "normal");
    // Back-compat boolean second arg
    assert.equal(cycleModeFromAgent("default", true), "always-approve");
    assert.equal(cycleModeFromAgent("default", false), "normal");
  });
});
