import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExtensionsTab, tabFromSlashName, EXTENSIONS_TABS } from "./tabs.ts";
import { rowsForTab } from "./rows.ts";
import type { ExtensionsTabPayload } from "./extensionsTypes.ts";

describe("extensions tabs", () => {
  it("maps slash names to tabs", () => {
    assert.equal(tabFromSlashName("skills"), "skills");
    assert.equal(tabFromSlashName("/plugins"), "plugins");
    assert.equal(tabFromSlashName("plugin"), "plugins");
    assert.equal(tabFromSlashName("mcps"), "mcp");
    assert.equal(tabFromSlashName("mcp"), "mcp");
    assert.equal(tabFromSlashName("hooks"), "hooks");
    assert.equal(tabFromSlashName("marketplace"), "marketplace");
    assert.equal(tabFromSlashName("unknown"), undefined);
  });

  it("validates tab ids", () => {
    for (const t of EXTENSIONS_TABS) {
      assert.equal(isExtensionsTab(t), true);
    }
    assert.equal(isExtensionsTab("nope"), false);
  });
});

describe("rowsForTab", () => {
  it("maps skills payload with toggle action", () => {
    const payload: ExtensionsTabPayload = {
      tab: "skills",
      data: {
        skills: [
          {
            name: "commit",
            description: "Commit changes",
            path: "/tmp/skills/commit/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ],
      },
    };
    const rows = rowsForTab(payload);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.title, "commit");
    assert.equal(rows[0]!.path, "/tmp/skills/commit/SKILL.md");
    assert.ok(rows[0]!.subtitle.includes("user"));
    assert.equal(rows[0]!.actions?.[0]?.id, "disable");
    assert.deepEqual(rows[0]!.actions?.[0]?.action, {
      kind: "skills_toggle",
      name: "commit",
      enabled: false,
    });
  });

  it("maps marketplace sources + plugins with install", () => {
    const payload: ExtensionsTabPayload = {
      tab: "marketplace",
      data: {
        sources: [
          {
            sourceName: "official",
            sourceUrlOrPath: "https://example.com/mkt",
            plugins: [
              {
                name: "foo",
                installStatus: "not_installed",
                relativePath: "plugins/foo",
                description: "A plugin",
              },
            ],
          },
        ],
      },
    };
    const rows = rowsForTab(payload);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.isHeader, true);
    assert.equal(rows[1]!.title, "foo");
    assert.equal(rows[1]!.actions?.[0]?.id, "install");
  });

  it("maps mcp toggle action", () => {
    const payload: ExtensionsTabPayload = {
      tab: "mcp",
      data: {
        servers: [{ name: "srv", enabled: false, status: "ready" }],
      },
    };
    const rows = rowsForTab(payload);
    assert.equal(rows[0]!.actions?.[0]?.id, "enable");
  });
});
