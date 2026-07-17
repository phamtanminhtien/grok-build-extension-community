/**
 * Registry tests stay self-contained (node --test + strip-types needs .ts
 * import paths; production modules use extensionless imports for tsc/esbuild).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOST_COMMANDS, hostCommandsByKey } from "./hostCommands.ts";
import { fuzzyScore } from "../context/fuzzyScore.ts";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { SlashCommandDef, SlashSuggestion } from "./types.ts";

/** Minimal mirror of SlashRegistry for unit tests (same merge rules). */
function buildAll(acp: AvailableCommand[] = []): SlashCommandDef[] {
  const seen = new Set<string>();
  const out: SlashCommandDef[] = [];
  for (const cmd of HOST_COMMANDS) {
    const n = cmd.name.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(cmd);
  }
  for (const c of acp) {
    const n = c.name.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({
      name: c.name,
      aliases: [],
      description: c.description || c.name,
      takesArgs: !!c.input,
      argsRequired: false,
      layer: "passthrough",
      source: "acp",
    });
  }
  return out;
}

function resolve(
  key: string,
  acp: AvailableCommand[] = [],
): SlashCommandDef | undefined {
  const k = key.trim().toLowerCase().replace(/^\//, "");
  const host = hostCommandsByKey().get(k);
  if (host) return host;
  return buildAll(acp).find(
    (c) => c.name.toLowerCase() === k && c.source === "acp",
  );
}

function suggest(query: string, limit = 40): SlashSuggestion[] {
  const q = query.trim().toLowerCase();
  const all = buildAll();
  if (!q) {
    return all.slice(0, limit).map((cmd) => ({
      name: cmd.name,
      display: `/${cmd.name}`,
      description: cmd.description,
      insertText: cmd.takesArgs ? `/${cmd.name} ` : `/${cmd.name}`,
      takesArgs: cmd.takesArgs,
      argsRequired: cmd.argsRequired,
      source: cmd.source,
      layer: cmd.layer,
    }));
  }
  const scored: { cmd: SlashCommandDef; score: number }[] = [];
  for (const cmd of all) {
    let best = Infinity;
    for (const key of [cmd.name, ...cmd.aliases]) {
      best = Math.min(best, fuzzyScore(key.toLowerCase(), q));
      if (key.toLowerCase().startsWith(q)) {
        best = Math.min(best, -10);
      }
    }
    if (best < Infinity) scored.push({ cmd, score: best });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name),
  );
  return scored.slice(0, limit).map(({ cmd }) => ({
    name: cmd.name,
    display: `/${cmd.name}`,
    description: cmd.description,
    insertText: cmd.takesArgs ? `/${cmd.name} ` : `/${cmd.name}`,
    takesArgs: cmd.takesArgs,
    argsRequired: cmd.argsRequired,
    source: cmd.source,
    layer: cmd.layer,
  }));
}

describe("host slash catalog (full reimplement)", () => {
  it("includes full host catalog", () => {
    assert.ok(HOST_COMMANDS.length >= 60);
    assert.ok(resolve("new"));
    assert.ok(resolve("clear"));
    assert.ok(resolve("m"));
    assert.ok(resolve("yolo"));
    assert.ok(resolve("compact"));
    assert.ok(resolve("imagine-video"));
    assert.ok(resolve("fullscreen"));
    assert.ok(resolve("hooks-trust"));
  });

  it("extensions browse commands are host openExtensions", () => {
    for (const name of ["hooks", "plugins", "marketplace", "skills", "mcps"]) {
      const cmd = resolve(name)!;
      assert.equal(cmd.layer, "host", name);
      assert.equal(cmd.hostAction, "openExtensions", name);
    }
    assert.equal(resolve("plugin")?.hostAction, "openExtensions");
  });

  it("host wins over acp on collision", () => {
    const acp: AvailableCommand[] = [
      { name: "compact", description: "ACP compact" },
      { name: "my-skill", description: "A skill", input: { hint: "args" } },
    ];
    const compact = resolve("compact", acp)!;
    assert.equal(compact.source, "host");
    assert.equal(compact.description, "Compact conversation history");
    assert.equal(compact.hostAction, "compact");
    const skill = resolve("my-skill", acp)!;
    assert.equal(skill.source, "acp");
    assert.equal(skill.layer, "passthrough");
  });

  it("compact fork rename are host ext-method actions", () => {
    assert.equal(resolve("compact")?.layer, "host");
    assert.equal(resolve("compact")?.hostAction, "compact");
    assert.equal(resolve("fork")?.layer, "host");
    assert.equal(resolve("fork")?.hostAction, "fork");
    assert.equal(resolve("rename")?.layer, "host");
    assert.equal(resolve("rename")?.hostAction, "rename");
    assert.equal(resolve("title")?.hostAction, "rename");
  });

  it("suggest fuzzy matches model", () => {
    const hits = suggest("mod");
    assert.ok(hits.some((h) => h.name === "model"));
    assert.ok(hits[0]!.display.startsWith("/"));
  });

  it("empty query returns catalog order", () => {
    const hits = suggest("", 10);
    assert.equal(hits.length, 10);
    assert.equal(hits[0]!.name, "new");
  });

  it("layers cover host, passthrough, unsupported", () => {
    const layers = new Set(HOST_COMMANDS.map((c) => c.layer));
    assert.ok(layers.has("host"));
    assert.ok(layers.has("passthrough"));
    assert.ok(layers.has("unsupported"));
  });
});
