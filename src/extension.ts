import * as vscode from "vscode";
import { AgentService } from "./agent/agentService";
import { BinaryNotFoundError } from "./agent/binaryResolver";
import {
  disposeOutput,
  logError,
  logInfo,
  openOutput,
} from "./log/output";

let agentService: AgentService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  agentService = new AgentService();
  logInfo("Grok Build - Community activated (L0)");

  context.subscriptions.push(
    vscode.commands.registerCommand("grok.openOutput", () => {
      openOutput();
    }),

    vscode.commands.registerCommand("grok.startAgent", async () => {
      openOutput();
      try {
        await agentService!.ensureStarted();
        const state = agentService!.getState();
        if (state.kind === "ready") {
          void vscode.window.showInformationMessage(
            `Grok Build agent ready (session ${state.sessionId})`,
          );
        }
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.restartAgent", async () => {
      openOutput();
      try {
        await agentService!.restart();
        const state = agentService!.getState();
        if (state.kind === "ready") {
          void vscode.window.showInformationMessage(
            `Grok Build agent restarted (session ${state.sessionId})`,
          );
        }
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.stopAgent", async () => {
      openOutput();
      try {
        await agentService!.stop();
        logInfo("Agent stopped");
        void vscode.window.showInformationMessage("Grok Build agent stopped");
      } catch (err) {
        logError("Stop failed", err);
        void vscode.window.showErrorMessage(
          `Failed to stop Grok Build agent: ${errMessage(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("grok.smokeTest", async () => {
      openOutput();
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Grok Build L0 smoke test",
            cancellable: false,
          },
          async () => {
            await agentService!.smokeTest();
          },
        );
        void vscode.window.showInformationMessage(
          "Grok Build smoke test finished — see Output → Grok Build",
        );
      } catch (err) {
        await showStartError(err);
      }
    }),

    {
      dispose: () => {
        // fire-and-forget; deactivate also awaits
        void agentService?.dispose();
      },
    },
  );
}

export async function deactivate(): Promise<void> {
  logInfo("Grok Build - Community deactivating…");
  try {
    await agentService?.dispose();
  } catch (err) {
    logError("Error during deactivate", err);
  } finally {
    agentService = undefined;
    disposeOutput();
  }
}

async function showStartError(err: unknown): Promise<void> {
  logError("Command failed", err);
  const msg = errMessage(err);

  if (err instanceof BinaryNotFoundError || /binary|not find|ENOENT/i.test(msg)) {
    const openSettings = "Open Settings";
    const choice = await vscode.window.showErrorMessage(
      msg.split("\n")[0] ?? msg,
      openSettings,
    );
    if (choice === openSettings) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "grok.binaryPath",
      );
    }
    return;
  }

  void vscode.window.showErrorMessage(`Grok Build: ${msg}`);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
