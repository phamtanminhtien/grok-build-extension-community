/**
 * Command registry: host builtins + ACP advertised commands.
 * Host wins on name collision (pager parity).
 */

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { fuzzyScore } from "../context/fuzzyScore";
import { HOST_COMMANDS, hostCommandsByKey } from "./hostCommands";
import type { SlashCommandDef, SlashSuggestion } from "./types";

export class SlashRegistry {
  private acp: SlashCommandDef[] = [];
  private readonly hostByKey = hostCommandsByKey();

  /** Replace ACP-advertised commands (skills + shell builtins). */
  setAcpCommands(commands: AvailableCommand[]): void {
    this.acp = commands.map(acpToDef);
  }

  getAcpCount(): number {
    return this.acp.length;
  }

  /** Resolve by canonical name or alias (host first, then ACP). */
  resolve(key: string): SlashCommandDef | undefined {
    const k = key.trim().toLowerCase().replace(/^\//, "");
    if (!k) {
      return undefined;
    }
    return this.hostByKey.get(k) ?? this.acp.find((c) => c.name.toLowerCase() === k);
  }

  /** All unique commands for the dropdown (host first, then ACP not shadowed). */
  allCommands(): SlashCommandDef[] {
    const seen = new Set<string>();
    const out: SlashCommandDef[] = [];
    for (const cmd of HOST_COMMANDS) {
      const n = cmd.name.toLowerCase();
      if (seen.has(n)) {
        continue;
      }
      seen.add(n);
      out.push(cmd);
    }
    for (const cmd of this.acp) {
      const n = cmd.name.toLowerCase();
      if (seen.has(n)) {
        continue;
      }
      seen.add(n);
      out.push(cmd);
    }
    return out;
  }

  /**
   * Fuzzy rank suggestions for a command-name query.
   * Empty query → insertion order (host catalog first).
   */
  suggest(query: string, limit = 40): SlashSuggestion[] {
    const q = query.trim();
    if (q.includes("/")) {
      return [];
    }
    const all = this.allCommands();
    const rows = all.map((cmd) => toSuggestion(cmd));

    if (!q) {
      return rows.slice(0, limit);
    }

    const qLower = q.toLowerCase();
    const scored: { row: SlashSuggestion; score: number }[] = [];
    for (const cmd of all) {
      const keys = [cmd.name, ...cmd.aliases];
      let best = Infinity;
      for (const key of keys) {
        const s = fuzzyScore(key.toLowerCase(), qLower);
        if (s < best) {
          best = s;
        }
        // Prefix bonus (TUI smart prefix feel).
        if (key.toLowerCase().startsWith(qLower)) {
          best = Math.min(best, -10 - (key.length === qLower.length ? 5 : 0));
        }
      }
      if (best < Infinity) {
        scored.push({ row: toSuggestion(cmd), score: best });
      }
    }
    scored.sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name));
    return scored.slice(0, limit).map((s) => s.row);
  }
}

function toSuggestion(cmd: SlashCommandDef): SlashSuggestion {
  let insertText = `/${cmd.name}`;
  if (cmd.takesArgs) {
    insertText += " ";
  }
  return {
    name: cmd.name,
    display: `/${cmd.name}`,
    description: cmd.description,
    insertText,
    takesArgs: cmd.takesArgs,
    argsRequired: cmd.argsRequired,
    source: cmd.source,
    layer: cmd.layer,
  };
}

function acpToDef(cmd: AvailableCommand): SlashCommandDef {
  const hint =
    cmd.input && typeof cmd.input === "object" && "hint" in cmd.input
      ? String((cmd.input as { hint?: string }).hint ?? "")
      : undefined;
  return {
    name: cmd.name,
    aliases: [],
    description: cmd.description || cmd.name,
    takesArgs: !!cmd.input,
    argsRequired: false,
    argHint: hint || undefined,
    layer: "passthrough",
    source: "acp",
  };
}

/** Singleton used by the chat host. */
export const slashRegistry = new SlashRegistry();
