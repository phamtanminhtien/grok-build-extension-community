/**
 * Always-approve toggle — confirms once, then persists to
 * `~/.grok/config.toml` `[ui].permission_mode` (same as TUI/CLI).
 *
 * There is no VS Code-only setting for this; disk is the sole store.
 */

import * as vscode from "vscode";
import {
  isAlwaysApproveMode,
  loadPermissionMode,
  persistPermissionMode,
} from "./permissionMode.ts";

/** Confirm enabling YOLO-style auto-approve (security checklist). */
export async function confirmAlwaysApprove(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "This allows Grok to run tools and edit files without asking. Continue?",
    { modal: true },
    "Continue",
  );
  return choice === "Continue";
}

/**
 * Effective always-approve from `~/.grok/config.toml` (shared with CLI).
 */
export function getAlwaysApprove(): boolean {
  return isAlwaysApproveMode(loadPermissionMode());
}

/**
 * Set always-approve by writing `[ui].permission_mode` to config.toml.
 * When turning ON, shows a modal unless already confirmed.
 * Returns the final value after any cancel.
 */
export async function setAlwaysApprove(
  next: boolean,
  options?: { alreadyConfirmed?: boolean },
): Promise<boolean> {
  const current = getAlwaysApprove();
  if (next === current) {
    return current;
  }
  if (next && !options?.alreadyConfirmed) {
    const ok = await confirmAlwaysApprove();
    if (!ok) {
      return false;
    }
  }
  persistPermissionMode(next ? "always-approve" : "ask");
  return next;
}
