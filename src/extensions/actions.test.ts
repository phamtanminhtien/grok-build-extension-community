import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hooksEnableDisable,
  marketplacePluginButtons,
  mcpToggleButton,
  parseActionOutcome,
  pluginsEnableDisable,
  skillsToggleButton,
  tabToolbarActions,
  toExtRequest,
} from "./actions.ts";

describe("row action builders", () => {
  it("hooks enable when disabled", () => {
    const b = hooksEnableDisable("pre:foo", true);
    assert.equal(b.label, "Enable");
    assert.deepEqual(b.action, {
      kind: "hooks_action",
      action: { type: "enable", hook_name: "pre:foo" },
    });
  });

  it("plugins disable when enabled", () => {
    const b = pluginsEnableDisable("user/ab/p", true);
    assert.equal(b.label, "Disable");
    assert.equal(
      (b.action as { action: { type: string } }).action.type,
      "disable",
    );
  });

  it("skills toggle flips enabled", () => {
    const b = skillsToggleButton("commit", true);
    assert.deepEqual(b.action, {
      kind: "skills_toggle",
      name: "commit",
      enabled: false,
    });
  });

  it("mcp toggle enable when disabled", () => {
    const b = mcpToggleButton("my-server", false);
    assert.deepEqual(b.action, {
      kind: "mcp_toggle",
      serverName: "my-server",
      enabled: true,
    });
  });

  it("marketplace not_installed → install", () => {
    const bs = marketplacePluginButtons(
      "https://github.com/x/y",
      "plugins/demo",
      "not_installed",
    );
    assert.equal(bs.length, 1);
    assert.equal(bs[0]!.id, "install");
  });

  it("marketplace installed → uninstall", () => {
    const bs = marketplacePluginButtons("/local", "p", "installed");
    assert.equal(bs.map((b) => b.id).join(","), "uninstall");
  });

  it("marketplace update_available → update + uninstall", () => {
    const bs = marketplacePluginButtons("u", "p", "update_available");
    assert.deepEqual(
      bs.map((b) => b.id),
      ["update", "uninstall"],
    );
  });
});

describe("toExtRequest", () => {
  it("requires session for hooks", () => {
    assert.equal(
      toExtRequest({ kind: "hooks_action", action: { type: "reload" } }, {}),
      null,
    );
  });

  it("builds hooks action params", () => {
    const r = toExtRequest(
      {
        kind: "hooks_action",
        action: { type: "disable", hook_name: "h" },
      },
      { sessionId: "s1" },
    );
    assert.deepEqual(r, {
      method: "x.ai/hooks/action",
      params: {
        sessionId: "s1",
        action: { type: "disable", hook_name: "h" },
      },
    });
  });

  it("builds skills toggle with cwd", () => {
    const r = toExtRequest(
      { kind: "skills_toggle", name: "x", enabled: true },
      { cwd: "/repo" },
    );
    assert.deepEqual(r, {
      method: "x.ai/skills/toggle",
      params: { name: "x", enabled: true, cwd: "/repo" },
    });
  });

  it("builds mcp toggle (snake_case wire)", () => {
    const r = toExtRequest(
      { kind: "mcp_toggle", serverName: "srv", enabled: false },
      { sessionId: "s" },
    );
    assert.deepEqual(r, {
      method: "x.ai/mcp/toggle",
      params: {
        session_id: "s",
        server_name: "srv",
        enabled: false,
      },
    });
  });
});

describe("parseActionOutcome", () => {
  it("reads ActionOutcome", () => {
    const o = parseActionOutcome({
      status: "ok",
      message: "Reloaded",
      requiresReload: true,
      requiresRestart: false,
    });
    assert.equal(o.message, "Reloaded");
    assert.equal(o.requiresReload, true);
  });

  it("unwraps result envelope", () => {
    const o = parseActionOutcome({ result: { ok: true, message: "done" } });
    assert.equal(o.message, "done");
  });

  it("surfaces error string", () => {
    const o = parseActionOutcome({ error: "nope" });
    assert.equal(o.ok, false);
    assert.equal(o.message, "nope");
  });
});

describe("tabToolbarActions", () => {
  it("hooks has reload", () => {
    assert.equal(tabToolbarActions("hooks")[0]?.id, "reload");
  });
  it("skills has no toolbar action", () => {
    assert.equal(tabToolbarActions("skills").length, 0);
  });
});
