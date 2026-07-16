/**
 * alwaysApprove enable path — confirm once (Settings UI or slash), then persist.
 */

import * as vscode from "vscode";
import { getSettings } from "./settings";

let suppressingConfirm = false;

/** Confirm enabling YOLO-style auto-approve (security checklist). */
export async function confirmAlwaysApprove(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "This allows Grok to run tools and edit files without asking. Continue?",
    { modal: true },
    "Continue",
  );
  return choice === "Continue";
}

export function isAlwaysApproveConfirmSuppressed(): boolean {
  return suppressingConfirm;
}

/**
 * Set `grok.alwaysApprove`. When turning ON, shows a modal unless already confirmed.
 * Returns the final value after any cancel.
 */
export async function setAlwaysApprove(
  next: boolean,
  options?: { alreadyConfirmed?: boolean },
): Promise<boolean> {
  const current = getSettings().alwaysApprove;
  if (next === current) {
    return current;
  }
  if (next && !options?.alreadyConfirmed) {
    const ok = await confirmAlwaysApprove();
    if (!ok) {
      return false;
    }
  }
  suppressingConfirm = true;
  try {
    await vscode.workspace
      .getConfiguration("grok")
      .update("alwaysApprove", next, vscode.ConfigurationTarget.Global);
  } finally {
    suppressingConfirm = false;
  }
  return next;
}

/**
 * Handle Settings UI toggles: if user turned ON without our setAlwaysApprove path,
 * confirm and revert on cancel.
 */
export async function onAlwaysApproveConfigChanged(): Promise<void> {
  if (suppressingConfirm) {
    return;
  }
  if (!getSettings().alwaysApprove) {
    return;
  }
  const ok = await confirmAlwaysApprove();
  if (!ok) {
    suppressingConfirm = true;
    try {
      await vscode.workspace
        .getConfiguration("grok")
        .update("alwaysApprove", false, vscode.ConfigurationTarget.Global);
    } finally {
      suppressingConfirm = false;
    }
    void vscode.window.showInformationMessage(
      "Grok Build: always-approve left OFF",
    );
  }
}
