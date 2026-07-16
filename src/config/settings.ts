import * as vscode from "vscode";

export interface GrokSettings {
  binaryPath: string;
  model: string;
  alwaysApprove: boolean;
  cwd: string;
  initializeTimeoutMs: number;
}

export function getSettings(): GrokSettings {
  const cfg = vscode.workspace.getConfiguration("grok");
  return {
    binaryPath: (cfg.get<string>("binaryPath") ?? "").trim(),
    model: (cfg.get<string>("model") ?? "").trim(),
    alwaysApprove: cfg.get<boolean>("alwaysApprove") ?? false,
    cwd: (cfg.get<string>("cwd") ?? "").trim(),
    initializeTimeoutMs: cfg.get<number>("initializeTimeoutMs") ?? 30_000,
  };
}

/**
 * Resolve absolute cwd for ACP session/new.
 * Prefer setting, then first workspace folder, else process.cwd().
 */
export function resolveSessionCwd(settings: GrokSettings = getSettings()): string {
  if (settings.cwd) {
    return settings.cwd;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    return folder;
  }
  return process.cwd();
}
