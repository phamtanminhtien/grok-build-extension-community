import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  cycleModeToPermissionCanonical,
  loadPermissionMode,
  parsePermissionModeCanonical,
  permissionModeToCycleMode,
  persistPermissionMode,
  resolvePermissionModeFromToml,
  upsertPermissionModeInToml,
} from "./permissionMode.ts";

describe("parsePermissionModeCanonical", () => {
  it("maps known values", () => {
    assert.equal(
      parsePermissionModeCanonical("always-approve"),
      "always-approve",
    );
    assert.equal(parsePermissionModeCanonical("AUTO"), "auto");
    assert.equal(parsePermissionModeCanonical("ask"), "ask");
    assert.equal(parsePermissionModeCanonical("default"), "ask");
    assert.equal(
      parsePermissionModeCanonical("bypassPermissions"),
      "always-approve",
    );
    assert.equal(parsePermissionModeCanonical("garbage"), "ask");
  });
});

describe("resolvePermissionModeFromToml", () => {
  it("defaults to ask when missing or empty", () => {
    assert.equal(resolvePermissionModeFromToml(""), "ask");
    assert.equal(
      resolvePermissionModeFromToml('[models]\ndefault = "x"\n'),
      "ask",
    );
    assert.equal(
      resolvePermissionModeFromToml('[ui]\ntheme = "dark"\n'),
      "ask",
    );
  });

  it("reads permission_mode (wins over yolo)", () => {
    const text = `[ui]
yolo = false
permission_mode = "always-approve"
theme = "groknight"
`;
    assert.equal(resolvePermissionModeFromToml(text), "always-approve");
  });

  it("supports auto and ask", () => {
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\npermission_mode = "auto"\n`),
      "auto",
    );
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\npermission_mode = "ask"\n`),
      "ask",
    );
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\npermission_mode = "default"\n`),
      "ask",
    );
  });

  it("legacy approval_mode and yolo", () => {
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\napproval_mode = "always-approve"\n`),
      "always-approve",
    );
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\napproval_mode = "other"\n`),
      "ask",
    );
    assert.equal(
      resolvePermissionModeFromToml(`[ui]\nyolo = true\n`),
      "always-approve",
    );
    // yolo = false with key present → ask (blocks remote in TUI)
    assert.equal(resolvePermissionModeFromToml(`[ui]\nyolo = false\n`), "ask");
  });

  it("ignores nested tables after [ui]", () => {
    const text = `[ui]
permission_mode = "auto"

[mcp_servers.foo]
enabled = true
`;
    assert.equal(resolvePermissionModeFromToml(text), "auto");
  });
});

describe("upsertPermissionModeInToml", () => {
  it("replaces existing permission_mode and strips legacy yolo", () => {
    const before = `[ui]
yolo = false
permission_mode = "ask"
theme = "x"
`;
    const after = upsertPermissionModeInToml(before, "always-approve");
    assert.match(after, /permission_mode = "always-approve"/);
    assert.match(after, /theme = "x"/);
    assert.doesNotMatch(after, /^\s*yolo\s*=/m);
    assert.equal(resolvePermissionModeFromToml(after), "always-approve");
  });

  it("inserts under [ui] when key missing", () => {
    const before = `[ui]
theme = "x"
`;
    const after = upsertPermissionModeInToml(before, "auto");
    assert.match(after, /\[ui\]\npermission_mode = "auto"/);
    assert.equal(resolvePermissionModeFromToml(after), "auto");
  });

  it("appends [ui] when section missing", () => {
    const before = `[models]\ndefault = "g"\n`;
    const after = upsertPermissionModeInToml(before, "ask");
    assert.match(after, /\[ui\]\npermission_mode = "ask"/);
    assert.equal(resolvePermissionModeFromToml(after), "ask");
  });
});

describe("cycle mode mapping", () => {
  it("round-trips arms", () => {
    assert.equal(permissionModeToCycleMode("always-approve"), "always-approve");
    assert.equal(permissionModeToCycleMode("auto"), "auto");
    assert.equal(permissionModeToCycleMode("ask"), "normal");
    assert.equal(
      cycleModeToPermissionCanonical("always-approve"),
      "always-approve",
    );
    assert.equal(cycleModeToPermissionCanonical("auto"), "auto");
    assert.equal(cycleModeToPermissionCanonical("normal"), "ask");
    assert.equal(cycleModeToPermissionCanonical("plan"), undefined);
  });
});

describe("loadPermissionMode / persistPermissionMode", () => {
  it("reads and writes a temp config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-perm-"));
    const cfg = path.join(dir, "config.toml");
    try {
      fs.writeFileSync(
        cfg,
        `[ui]\nyolo = false\npermission_mode = "always-approve"\n`,
        "utf8",
      );
      assert.equal(loadPermissionMode(cfg), "always-approve");
      persistPermissionMode("ask", cfg);
      assert.equal(loadPermissionMode(cfg), "ask");
      const text = fs.readFileSync(cfg, "utf8");
      assert.match(text, /permission_mode = "ask"/);
      assert.doesNotMatch(text, /^\s*yolo\s*=/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
