import * as vscode from "vscode";
import { getCliInstallInfo, isBinaryMissingError } from "./cliInstallInfo";
import { probeGrokBinary } from "./binaryResolver";

const COPY_INSTALL = "Copy install command";
const OPEN_DOCS = "Open install docs";
const SET_PATH = "Set binary path";
const RETRY = "I installed it — Retry";

/**
 * Modal / error flow when `grok` is missing. Blocks agent use until CLI is installed
 * or binary path is configured.
 */
export async function promptMissingCli(
  detail?: string,
): Promise<"retry" | "dismissed"> {
  const info = getCliInstallInfo();
  const headline =
    detail?.split("\n").find((l) => l.trim().length > 0)?.trim() ||
    "Grok Build CLI (`grok`) is not installed or not on PATH.";

  const choice = await vscode.window.showErrorMessage(
    `${headline} Install the CLI to use this extension.`,
    { modal: false },
    COPY_INSTALL,
    OPEN_DOCS,
    SET_PATH,
    RETRY,
  );

  if (choice === COPY_INSTALL) {
    await vscode.env.clipboard.writeText(info.command);
    void vscode.window.showInformationMessage(
      `Copied: ${info.command}  — paste in a terminal, then Retry.`,
    );
    return "dismissed";
  }
  if (choice === OPEN_DOCS) {
    await vscode.env.openExternal(vscode.Uri.parse(info.docsUrl));
    return "dismissed";
  }
  if (choice === SET_PATH) {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "grok.binaryPath",
    );
    return "dismissed";
  }
  if (choice === RETRY) {
    const probe = await probeGrokBinary();
    if (probe.found) {
      void vscode.window.showInformationMessage(
        `Found grok at ${probe.path}`,
      );
      return "retry";
    }
    void vscode.window.showWarningMessage(
      "Still cannot find `grok`. Install the CLI or set grok.binaryPath.",
    );
    // Offer again once
    return promptMissingCli(
      "Still cannot find the `grok` binary after retry.",
    );
  }
  return "dismissed";
}

/**
 * If err is a missing-binary failure, run install prompt. Returns true when handled.
 */
export async function handleMissingCliError(err: unknown): Promise<boolean> {
  if (!isBinaryMissingError(err)) {
    return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  await promptMissingCli(msg);
  return true;
}
