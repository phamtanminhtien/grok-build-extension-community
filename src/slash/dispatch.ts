/**
 * Slash dispatch — host actions, passthrough prompts, unsupported messages.
 */

import * as vscode from "vscode";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { promptAndStoreApiKey } from "../auth/authService";
import { setModelSetting } from "../config/modelService";
import { getSettings, resolveSessionCwd } from "../config/settings";
import { openOutput } from "../log/output";
import { parseInvocation } from "./detect";
import { HOST_COMMANDS } from "./hostCommands";
import type { SlashRegistry } from "./registry";
import type { HostAction, SlashCommandDef, SlashInvocation } from "./types";

export type DispatchOutcome =
  | { kind: "handled"; message?: string }
  | { kind: "passthrough"; text: string }
  | { kind: "not_slash" }
  | { kind: "error"; message: string };

export interface DispatchDeps {
  agent: AgentService;
  auth: AuthService;
  registry: SlashRegistry;
  /** Chat transcript lines for /export /copy. */
  getTranscript: () => { role: string; text: string }[];
  clearUi: () => void;
  newSession: () => Promise<void>;
}

/**
 * If `line` is a slash command, dispatch it. Otherwise `not_slash`.
 */
export async function dispatchSlash(
  line: string,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const inv = parseInvocation(line);
  if (!inv) {
    return { kind: "not_slash" };
  }
  if (!inv.key) {
    return { kind: "error", message: "Empty slash command. Type / for the list." };
  }

  const cmd = deps.registry.resolve(inv.key);
  inv.command = cmd;
  inv.name = cmd?.name ?? inv.key;

  if (!cmd) {
    // Unknown: pass through so shell/skills can still handle (TUI parity).
    return {
      kind: "passthrough",
      text: formatPassThrough(inv.name, inv.args),
    };
  }

  if (cmd.layer === "unsupported") {
    return {
      kind: "handled",
      message: `/${cmd.name} is a TUI-only command and is not available in the VS Code host.`,
    };
  }

  if (cmd.layer === "passthrough") {
    if (cmd.argsRequired && !inv.args.trim()) {
      return {
        kind: "error",
        message: `Usage: ${usageOf(cmd)}`,
      };
    }
    return {
      kind: "passthrough",
      text: formatPassThrough(cmd.name, inv.args),
    };
  }

  // host
  if (cmd.argsRequired && !inv.args.trim() && cmd.hostAction !== "selectModel") {
    // /model with no args → open QuickPick (args not required on host).
    return {
      kind: "error",
      message: `Usage: ${usageOf(cmd)}`,
    };
  }

  try {
    const message = await runHostAction(cmd, inv, deps);
    return { kind: "handled", message };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatPassThrough(name: string, args: string): string {
  const a = args.trim();
  return a ? `/${name} ${a}` : `/${name}`;
}

function usageOf(cmd: SlashCommandDef): string {
  if (cmd.argHint) {
    return `/${cmd.name} ${cmd.argHint}`;
  }
  return `/${cmd.name}`;
}

async function runHostAction(
  cmd: SlashCommandDef,
  inv: SlashInvocation,
  deps: DispatchDeps,
): Promise<string | undefined> {
  const action: HostAction = cmd.hostAction ?? "help";
  switch (action) {
    case "newSession":
      await deps.newSession();
      // handleNewSession already posts a system line
      return undefined;
    case "resumeSession":
      await vscode.commands.executeCommand("grok.resumeSession");
      return undefined;
    case "selectModel": {
      if (inv.args.trim()) {
        const model = inv.args.trim().split(/\s+/)[0]!;
        await setModelSetting(model);
        try {
          await deps.agent.restart();
        } catch {
          /* start may fail without auth */
        }
        return `Model set to ${model} (agent restart)`;
      }
      await vscode.commands.executeCommand("grok.selectModel");
      return undefined;
    }
    case "setModel": {
      const model = inv.args.trim();
      if (!model) {
        throw new Error("Usage: /model <name>");
      }
      await setModelSetting(model);
      return `Model set to ${model}`;
    }
    case "login":
      await promptAndStoreApiKey(deps.auth);
      return "API key updated";
    case "logout":
      await deps.auth.clearApiKey();
      return "API key cleared from SecretStorage (CLI ~/.grok auth may still work)";
    case "help":
      return buildHelpMessage(deps.registry);
    case "docs": {
      const arg = inv.args.trim().toLowerCase();
      const url =
        arg === "web" || arg === ""
          ? "https://docs.x.ai"
          : "https://docs.x.ai";
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return `Opened docs: ${url}`;
    }
    case "settings":
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:xai.grok-build-community",
      );
      // Fallback filter if publisher id differs
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "grok.",
      );
      return "Opened Grok settings";
    case "alwaysApprove": {
      const cfg = vscode.workspace.getConfiguration("grok");
      const arg = inv.args.trim().toLowerCase();
      let next: boolean;
      if (!arg) {
        next = !getSettings().alwaysApprove;
      } else if (["off", "false", "0", "no", "disable"].includes(arg)) {
        next = false;
      } else {
        next = true;
      }
      await cfg.update("alwaysApprove", next, vscode.ConfigurationTarget.Global);
      return next
        ? "always-approve ON — restart agent for spawn flag to apply"
        : "always-approve OFF — restart agent for spawn flag to apply";
    }
    case "export": {
      const lines = deps.getTranscript();
      const body = lines
        .map((l) => `## ${l.role}\n\n${l.text}\n`)
        .join("\n");
      const filename = inv.args.trim();
      if (filename) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) {
          await vscode.env.clipboard.writeText(body);
          return "No workspace folder — transcript copied to clipboard instead";
        }
        const uri = vscode.Uri.joinPath(folder, filename);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(body, "utf8"));
        return `Exported transcript to ${uri.fsPath}`;
      }
      await vscode.env.clipboard.writeText(body);
      return "Transcript copied to clipboard";
    }
    case "copy": {
      const lines = deps.getTranscript().filter((l) => l.role === "assistant");
      if (!lines.length) {
        throw new Error("No assistant response to copy");
      }
      const n = inv.args.trim() ? Math.max(1, parseInt(inv.args.trim(), 10) || 1) : 1;
      const idx = lines.length - n;
      if (idx < 0 || idx >= lines.length) {
        throw new Error(`No assistant response #${n}`);
      }
      await vscode.env.clipboard.writeText(lines[idx]!.text);
      return n === 1 ? "Copied last response" : `Copied response #${n} from end`;
    }
    case "context":
    case "sessionInfo": {
      const state = deps.agent.getState();
      const s = getSettings();
      const parts = [
        `cwd: ${resolveSessionCwd(s)}`,
        `model: ${s.model || "default"}`,
        `alwaysApprove: ${s.alwaysApprove}`,
        `agent: ${state.kind}`,
        state.kind === "ready"
          ? `sessionId: ${state.sessionId}`
          : state.kind === "error"
            ? `error: ${state.message}`
            : "",
        `acp commands: ${deps.registry.getAcpCount()}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    case "cd": {
      const path = inv.args.trim();
      const cfg = vscode.workspace.getConfiguration("grok");
      if (!path) {
        return `cwd: ${resolveSessionCwd()}`;
      }
      await cfg.update("cwd", path, vscode.ConfigurationTarget.Workspace);
      return `cwd set to ${path} (new sessions use this path)`;
    }
    case "home":
      deps.clearUi();
      return "Welcome — type a message or / for commands";
    case "quit":
      await deps.agent.stop();
      deps.clearUi();
      return "Agent stopped";
    case "openOutput":
      openOutput();
      return undefined;
    case "cancel":
      await deps.agent.cancelTurn();
      return "Cancel requested…";
    case "reviewEdits":
      await vscode.commands.executeCommand("grok.reviewEdits");
      return undefined;
    case "startAgent":
      await deps.agent.ensureStarted();
      return "Agent ready";
    case "restartAgent":
      await deps.agent.restart();
      return "Agent restarted";
    default:
      return `Unhandled host action for /${cmd.name}`;
  }
}

function buildHelpMessage(registry: SlashRegistry): string {
  const lines = [
    "Slash commands (Grok Build — VS Code host)",
    "Type / to autocomplete. Host commands run locally; others pass through to the agent.",
    "",
  ];
  const byLayer = {
    host: [] as string[],
    passthrough: [] as string[],
    unsupported: [] as string[],
  };
  for (const cmd of registry.allCommands()) {
    const alias =
      cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
    const row = `/${cmd.name}${alias} — ${cmd.description}`;
    byLayer[cmd.layer].push(row);
  }
  if (byLayer.host.length) {
    lines.push("Host:", ...byLayer.host.map((r) => `  ${r}`), "");
  }
  if (byLayer.passthrough.length) {
    lines.push("Agent / pass-through:", ...byLayer.passthrough.map((r) => `  ${r}`), "");
  }
  if (byLayer.unsupported.length) {
    lines.push(
      "TUI-only (listed for parity):",
      ...byLayer.unsupported.map((r) => `  ${r}`),
    );
  }
  // Keep message size reasonable for chat.
  const text = lines.join("\n");
  if (text.length > 6000) {
    return (
      "Slash commands: type / for the full list.\n" +
      `Host builtins: ${HOST_COMMANDS.length}. ACP: ${registry.getAcpCount()}.`
    );
  }
  return text;
}
