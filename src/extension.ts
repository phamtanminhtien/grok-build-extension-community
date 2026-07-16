import * as vscode from "vscode";
import { AgentService } from "./agent/agentService";
import { BinaryNotFoundError } from "./agent/binaryResolver";
import { AuthService, promptAndStoreApiKey } from "./auth/authService";
import {
  disposeOutput,
  logError,
  logInfo,
  openOutput,
} from "./log/output";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { GrokStatusBar } from "./ui/statusBar";

let agentService: AgentService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Match Claude Code / Codex: Secondary Side Bar tabs need VS Code ≥ 1.106
  const [major = 0, minor = 0] = vscode.version.split(".").map(Number);
  const supportsSecondarySidebar =
    major > 1 || (major === 1 && minor >= 106);
  void vscode.commands.executeCommand(
    "setContext",
    "grok.doesNotSupportSecondarySidebar",
    !supportsSecondarySidebar,
  );

  agentService = new AgentService();
  const auth = new AuthService(context.secrets);
  agentService.setAuthService(auth);

  const chat = new ChatViewProvider(
    context.extensionUri,
    agentService,
    auth,
    { supportsSecondarySidebar },
  );
  const statusBar = new GrokStatusBar(agentService);

  const webviewOpts = { webviewOptions: { retainContextWhenHidden: true } };

  context.subscriptions.push(
    agentService,
    chat,
    statusBar,
    // Same provider instance for activity-bar fallback + secondary sidebar
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chat,
      webviewOpts,
    ),
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.secondaryViewType,
      chat,
      webviewOpts,
    ),

    vscode.commands.registerCommand("grok.openChat", async () => {
      await chat.openChat();
    }),

    vscode.commands.registerCommand("grok.openChatActivityBar", async () => {
      await chat.openActivityBarChat();
    }),

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

    vscode.commands.registerCommand("grok.newSession", async () => {
      try {
        await chat.openChat();
        const id = await agentService!.newSession();
        void vscode.window.showInformationMessage(
          `Grok Build: new session ${id.slice(0, 8)}…`,
        );
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.cancel", async () => {
      await agentService!.cancelTurn();
    }),

    vscode.commands.registerCommand("grok.setApiKey", async () => {
      await promptAndStoreApiKey(auth);
    }),

    vscode.commands.registerCommand("grok.clearApiKey", async () => {
      await auth.clearApiKey();
      void vscode.window.showInformationMessage(
        "Grok Build: API key cleared from SecretStorage",
      );
    }),

    vscode.commands.registerCommand("grok.login", async () => {
      const has = await auth.hasAnyAuth();
      if (has) {
        const choice = await vscode.window.showInformationMessage(
          "Auth already present (SecretStorage, env, or ~/.grok). Set a new API key?",
          "Set API key",
          "Cancel",
        );
        if (choice !== "Set API key") {
          return;
        }
      }
      await promptAndStoreApiKey(auth);
    }),

    vscode.commands.registerCommand("grok.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage("No selection");
        return;
      }
      const text = editor.document.getText(editor.selection);
      await chat.sendFromCommand(
        `Regarding the current selection:\n\n\`\`\`\n${text.slice(0, 20_000)}\n\`\`\`\n\n`,
      );
    }),

    vscode.commands.registerCommand("grok.addFileToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        void vscode.window.showWarningMessage("No active file");
        return;
      }
      await chat.sendFromCommand(
        `Look at the active file: ${editor.document.uri.fsPath}`,
      );
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
  );

  logInfo("Grok Build - Community activated (L1)");
}

export async function deactivate(): Promise<void> {
  logInfo("Grok Build - Community deactivating…");
  try {
    await agentService?.disposeAsync();
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
