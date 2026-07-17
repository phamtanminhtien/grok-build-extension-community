/**
 * Slash dispatch — host actions, passthrough prompts, unsupported messages.
 */

import * as vscode from "vscode";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { pickLoginMethod, promptAndStoreApiKey } from "../auth/authService";
import { formatLogoutMessage } from "../auth/authFlow";
import { setModelSetting } from "../config/modelService";
import { getAlwaysApprove, setAlwaysApprove } from "../config/alwaysApprove";
import { getSettings, resolveSessionCwd } from "../config/settings";
import { openOutput } from "../log/output";
import { tabFromSlashName } from "../extensions/tabs";
import {
  formatRewindPointDescription,
  formatRewindPointLabel,
  modeTruncatesConversation,
  modesForPoint,
  type RewindMode,
  type RewindPoint,
  type RewindResult,
} from "../agent/rewind";
import { formatTasksReport } from "../agent/tasksStore";
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
  /** Optional host wrappers (loading indicator, system lines). */
  startAgent?: () => Promise<void>;
  restartAgent?: () => Promise<void>;
  /** Session/load history replay (TUI `/resume` parity) for `/fork`. */
  beginHistoryLoad?: (sessionId?: string, title?: string) => void;
  endHistoryLoad?: () => void;
  /**
   * Apply successful rewind to chat UI (truncate turns / prefill composer).
   * Required for `/rewind` host action.
   */
  applyRewindResult?: (result: RewindResult) => void;
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
    return {
      kind: "error",
      message: "Empty slash command. Type / for the list.",
    };
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
  if (
    cmd.argsRequired &&
    !inv.args.trim() &&
    cmd.hostAction !== "selectModel"
  ) {
    // /model with no args → open model popover (args not required on host).
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
      // runNewSession clears the UI to the home/empty state
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
    case "login": {
      const status = await deps.auth.getStatus();
      const choice = await pickLoginMethod(status);
      if (!choice) {
        return "Login cancelled";
      }
      if (choice === "apiKey") {
        const ok = await promptAndStoreApiKey(deps.auth);
        return ok ? "API key updated" : "Login cancelled";
      }
      await deps.agent.interactiveBrowserLogin();
      const after = await deps.auth.refresh();
      return after.cliEmail
        ? `Signed in as ${after.cliEmail} (CLI session)`
        : "Signed in with browser (CLI session)";
    }
    case "logout": {
      const { logout, clearedSecretKey } = await deps.agent.logout();
      await deps.auth.refresh();
      return formatLogoutMessage(logout, clearedSecretKey);
    }
    case "help":
      return buildHelpMessage(deps.registry);
    case "docs": {
      const arg = inv.args.trim().toLowerCase();
      const url =
        arg === "web" || arg === "" ? "https://docs.x.ai" : "https://docs.x.ai";
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return `Opened docs: ${url}`;
    }
    case "settings":
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:tienpham.grok-build-community-edition",
      );
      // Fallback filter if publisher id differs
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "grok.",
      );
      return "Opened Grok settings";
    case "alwaysApprove": {
      const arg = inv.args.trim().toLowerCase();
      let next: boolean;
      if (!arg) {
        next = !getAlwaysApprove();
      } else if (["off", "false", "0", "no", "disable"].includes(arg)) {
        next = false;
      } else {
        next = true;
      }
      const applied = await setAlwaysApprove(next);
      if (next && !applied) {
        return "always-approve left OFF";
      }
      // Live session: apply like TUI (disk already written by setAlwaysApprove).
      if (deps.agent.getState().kind === "ready") {
        try {
          await deps.agent.applyCycleMode(
            applied ? "always-approve" : "normal",
          );
        } catch {
          // applyCycleMode re-persists; ignore if notify fails mid-restart.
        }
      }
      return applied
        ? "always-approve ON — saved to ~/.grok/config.toml (shared with CLI)"
        : "always-approve OFF — saved to ~/.grok/config.toml (shared with CLI)";
    }
    case "export": {
      const lines = deps.getTranscript();
      const body = lines.map((l) => `## ${l.role}\n\n${l.text}\n`).join("\n");
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
      const n = inv.args.trim()
        ? Math.max(1, parseInt(inv.args.trim(), 10) || 1)
        : 1;
      const idx = lines.length - n;
      if (idx < 0 || idx >= lines.length) {
        throw new Error(`No assistant response #${n}`);
      }
      await vscode.env.clipboard.writeText(lines[idx]!.text);
      return n === 1
        ? "Copied last response"
        : `Copied response #${n} from end`;
    }
    case "context":
    case "sessionInfo": {
      const state = deps.agent.getState();
      const s = getSettings();
      const parts = [
        `cwd: ${resolveSessionCwd(s)}`,
        `model: ${s.model || "(config.toml [models].default empty)"}`,
        `reasoningEffort: ${s.reasoningEffort || "(unset)"}`,
        `permissionMode: ${s.permissionMode}`,
        `alwaysApprove: ${s.alwaysApprove}`,
        `(model/effort/permission from ~/.grok/config.toml)`,
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
      if (deps.startAgent) {
        await deps.startAgent();
        return undefined;
      }
      await deps.agent.ensureStarted();
      return "Agent ready";
    case "restartAgent":
      if (deps.restartAgent) {
        await deps.restartAgent();
        return undefined;
      }
      await deps.agent.restart();
      return "Agent restarted";
    case "openExtensions": {
      const tab = tabFromSlashName(cmd.name) ?? "hooks";
      await vscode.commands.executeCommand("grok.openExtensions", { tab });
      return undefined;
    }
    case "compact": {
      await deps.agent.ensureStarted();
      const ctx = inv.args.trim();
      await deps.agent.compactConversation(ctx || undefined);
      return ctx
        ? `Compaction requested (preserve: ${ctx})`
        : "Compaction requested";
    }
    case "rename": {
      const title = inv.args.trim();
      if (!title) {
        throw new Error("Usage: /rename <title>");
      }
      await deps.agent.ensureStarted();
      await deps.agent.renameSession(title);
      return `Session renamed to “${title}”`;
    }
    case "fork": {
      await deps.agent.ensureStarted();
      const result = await deps.agent.forkSession(inv.args);
      const caps = deps.agent.getCapabilities();
      if (caps.loadSession) {
        deps.beginHistoryLoad?.(result.newSessionId, "forked session");
        try {
          await deps.agent.loadSession(
            result.newSessionId,
            result.newCwd || resolveSessionCwd(),
          );
          // Allow replay session/update notifications to land (resume parity).
          await new Promise((r) => setTimeout(r, 400));
          deps.endHistoryLoad?.();
        } catch (err) {
          deps.endHistoryLoad?.();
          throw err;
        }
      } else {
        deps.clearUi();
      }
      const msgs =
        result.chatMessagesCopied != null
          ? ` (${result.chatMessagesCopied} messages copied)`
          : "";
      return `Forked session → ${result.newSessionId}${msgs}`;
    }
    case "showTasks": {
      await deps.agent.ensureStarted();
      try {
        await deps.agent.refreshTasks();
      } catch {
        /* list APIs may be missing on older binaries */
      }
      // Prefer chat panel focus so the Tasks pane is visible.
      try {
        await vscode.commands.executeCommand("grok.openChat");
      } catch {
        /* ignore */
      }
      return formatTasksReport(deps.agent.getTasks());
    }
    case "rewind":
      return runRewindPicker(deps);
    default:
      return `Unhandled host action for /${cmd.name}`;
  }
}

/**
 * TUI `/rewind` parity: list points → mode → preview → force execute.
 * UI truncation/prefill is delegated to `applyRewindResult`.
 */
export async function runRewindPicker(
  deps: Pick<DispatchDeps, "agent" | "applyRewindResult">,
): Promise<string | undefined> {
  await deps.agent.ensureStarted();
  if (deps.agent.isBusy()) {
    await deps.agent.cancelTurn();
  }

  const points = await deps.agent.rewindGetPoints();
  if (points.length === 0) {
    return "No rewind points yet — send a prompt first.";
  }

  type PointItem = vscode.QuickPickItem & { point: RewindPoint };
  const pointPick = await vscode.window.showQuickPick<PointItem>(
    points.map((p) => ({
      label: formatRewindPointLabel(p),
      description: formatRewindPointDescription(p),
      point: p,
    })),
    {
      title: "Rewind to turn",
      placeHolder: "Restore state before this prompt ran",
      matchOnDescription: true,
    },
  );
  if (!pointPick) {
    return "Rewind cancelled";
  }

  const modeChoices = modesForPoint(pointPick.point);
  type ModeItem = vscode.QuickPickItem & { mode: RewindMode };
  const modePick = await vscode.window.showQuickPick<ModeItem>(
    modeChoices.map((m) => ({
      label: m.label,
      description: m.detail,
      mode: m.mode,
    })),
    {
      title: `Rewind mode · #${pointPick.point.promptIndex}`,
      placeHolder: "What should be rewound?",
    },
  );
  if (!modePick) {
    return "Rewind cancelled";
  }

  const target = pointPick.point.promptIndex;
  const mode = modePick.mode;

  // Preview (force=false) — surfaces conflicts without applying.
  const preview = await deps.agent.rewindExecute({
    targetPromptIndex: target,
    mode,
    force: false,
  });

  if (!preview.success && preview.conflicts.length > 0) {
    const sample = preview.conflicts
      .slice(0, 5)
      .map((c) => `${c.path} (${c.conflictType})`)
      .join("\n");
    const more =
      preview.conflicts.length > 5
        ? `\n…and ${preview.conflicts.length - 5} more`
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Rewind has ${preview.conflicts.length} file conflict(s). Force anyway?\n${sample}${more}`,
      { modal: true },
      "Force rewind",
    );
    if (choice !== "Force rewind") {
      return "Rewind cancelled (conflicts)";
    }
  } else if (!preview.success) {
    throw new Error(preview.error?.trim() || "Rewind preview failed");
  } else if (
    (mode === "all" || mode === "files_only") &&
    preview.cleanFiles.length > 0
  ) {
    const n = preview.cleanFiles.length;
    const choice = await vscode.window.showInformationMessage(
      `Rewind will revert ${n} file(s). Continue?`,
      { modal: true },
      "Rewind",
    );
    if (choice !== "Rewind") {
      return "Rewind cancelled";
    }
  }

  const result = await deps.agent.rewindExecute({
    targetPromptIndex: target,
    mode,
    force: true,
  });
  if (!result.success) {
    throw new Error(result.error?.trim() || "Rewind failed");
  }

  deps.applyRewindResult?.(result);

  const parts = [`Rewound to before prompt #${result.targetPromptIndex}`];
  if (modeTruncatesConversation(result.mode)) {
    parts.push(
      result.mode === "all" ? "(chat + files)" : "(conversation only)",
    );
  } else {
    parts.push("(files only)");
  }
  if (result.revertedFiles.length > 0) {
    parts.push(`· ${result.revertedFiles.length} file(s) reverted`);
  }
  return parts.join(" ");
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
      cmd.aliases.length > 0
        ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})`
        : "";
    const row = `/${cmd.name}${alias} — ${cmd.description}`;
    byLayer[cmd.layer].push(row);
  }
  if (byLayer.host.length) {
    lines.push("Host:", ...byLayer.host.map((r) => `  ${r}`), "");
  }
  if (byLayer.passthrough.length) {
    lines.push(
      "Agent / pass-through:",
      ...byLayer.passthrough.map((r) => `  ${r}`),
      "",
    );
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
