import * as vscode from "vscode";
import { loadModelsConfig } from "./modelsConfig.ts";
import {
  isAlwaysApproveMode,
  loadPermissionMode,
  type PermissionModeResolved,
} from "./permissionMode.ts";

export interface GrokSettings {
  binaryPath: string;
  /**
   * Minimum `grok` CLI semver required to start the agent.
   * Empty / "off" disables the gate. Default `0.1.0`.
   */
  minCliVersion: string;
  /**
   * Default model from `~/.grok/config.toml` `[models].default`
   * (shared with CLI/TUI).
   */
  model: string;
  /**
   * Default reasoning effort from
   * `~/.grok/config.toml` `[models].default_reasoning_effort`.
   */
  reasoningEffort: string;
  /**
   * Always-approve from `~/.grok/config.toml` `[ui].permission_mode`
   * (shared with CLI/TUI).
   */
  alwaysApprove: boolean;
  /** Full resolved permission mode from config.toml. */
  permissionMode: PermissionModeResolved;
  cwd: string;
  initializeTimeoutMs: number;
  inheritEnvApiKey: boolean;
  permissionTimeoutMs: number;
  showThoughts: boolean;
  autoAttachActiveFile: boolean;
  autoAttachSelection: boolean;
  excludeGlob: string[];
  preferOpenBuffers: boolean;
  autoSave: boolean;
  maxReadBytes: number;
}

export function getSettings(): GrokSettings {
  const cfg = vscode.workspace.getConfiguration("grok");
  const permissionMode = loadPermissionMode();
  const models = loadModelsConfig();
  return {
    binaryPath: (cfg.get<string>("binaryPath") ?? "").trim(),
    minCliVersion: (cfg.get<string>("minCliVersion") ?? "0.1.0").trim(),
    model: models.defaultModel,
    reasoningEffort: models.defaultReasoningEffort,
    alwaysApprove: isAlwaysApproveMode(permissionMode),
    permissionMode,
    cwd: (cfg.get<string>("cwd") ?? "").trim(),
    initializeTimeoutMs: cfg.get<number>("initializeTimeoutMs") ?? 30_000,
    inheritEnvApiKey: cfg.get<boolean>("inheritEnvApiKey") ?? true,
    permissionTimeoutMs: cfg.get<number>("permissionTimeoutMs") ?? 120_000,
    showThoughts: cfg.get<boolean>("ui.showThoughts") ?? true,
    autoAttachActiveFile:
      cfg.get<boolean>("context.autoAttachActiveFile") ?? true,
    autoAttachSelection:
      cfg.get<boolean>("context.autoAttachSelection") ?? true,
    excludeGlob: cfg.get<string[]>("context.excludeGlob") ?? [
      "**/.env",
      "**/.env.*",
      "**/secrets/**",
      "**/*credential*",
      "**/*.pem",
    ],
    preferOpenBuffers: cfg.get<boolean>("fs.preferOpenBuffers") ?? true,
    autoSave: cfg.get<boolean>("fs.autoSave") ?? true,
    maxReadBytes: cfg.get<number>("fs.maxReadBytes") ?? 5_000_000,
  };
}

/**
 * Resolve absolute cwd for ACP session/new.
 * Prefer setting, then first workspace folder, else process.cwd().
 */
export function resolveSessionCwd(
  settings: GrokSettings = getSettings(),
): string {
  if (settings.cwd) {
    return settings.cwd;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    return folder;
  }
  return process.cwd();
}
