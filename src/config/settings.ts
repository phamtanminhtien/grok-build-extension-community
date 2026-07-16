import * as vscode from "vscode";

export interface GrokSettings {
  binaryPath: string;
  model: string;
  alwaysApprove: boolean;
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
  return {
    binaryPath: (cfg.get<string>("binaryPath") ?? "").trim(),
    model: (cfg.get<string>("model") ?? "").trim(),
    alwaysApprove: cfg.get<boolean>("alwaysApprove") ?? false,
    cwd: (cfg.get<string>("cwd") ?? "").trim(),
    initializeTimeoutMs: cfg.get<number>("initializeTimeoutMs") ?? 30_000,
    inheritEnvApiKey: cfg.get<boolean>("inheritEnvApiKey") ?? true,
    permissionTimeoutMs: cfg.get<number>("permissionTimeoutMs") ?? 120_000,
    showThoughts: cfg.get<boolean>("ui.showThoughts") ?? true,
    autoAttachActiveFile: cfg.get<boolean>("context.autoAttachActiveFile") ?? true,
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
    autoSave: cfg.get<boolean>("fs.autoSave") ?? false,
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
