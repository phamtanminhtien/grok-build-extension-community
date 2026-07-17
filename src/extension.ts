import * as vscode from "vscode";
import { AgentService } from "./agent/agentService";
import { handleMissingCliError } from "./agent/missingCliPrompt";
import { readTextFileHost, setBeforeWriteHook } from "./agent/hostFs";
import {
  AuthService,
  pickLoginMethod,
  promptAndStoreApiKey,
} from "./auth/authService";
import { formatLogoutMessage } from "./auth/authFlow";

import { DiffReviewService } from "./diff/diffReviewService";
import { ExtensionsPanel } from "./extensions/extensionsPanel";
import { isExtensionsTab, type ExtensionsTab } from "./extensions/tabs";
import { disposeOutput, logError, logInfo, openOutput } from "./log/output";
import { resolveSessionCwd } from "./config/settings";
import { pickGrokSessionToResume } from "./session/sessionPicker";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { GrokStatusBar } from "./ui/statusBar";

let agentService: AgentService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Match Claude Code / Codex: Secondary Side Bar tabs need VS Code ≥ 1.106
  const [major = 0, minor = 0] = vscode.version.split(".").map(Number);
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  void vscode.commands.executeCommand(
    "setContext",
    "grok.doesNotSupportSecondarySidebar",
    !supportsSecondarySidebar,
  );

  agentService = new AgentService();
  const auth = new AuthService(context.secrets);
  agentService.setAuthService(auth);
  context.subscriptions.push(auth);

  const diffs = new DiffReviewService();

  setBeforeWriteHook(async (filePath) => {
    await diffs.captureIfMissing(filePath, async () => {
      const { content } = await readTextFileHost(filePath);
      return content;
    });
    diffs.recordEdit({ path: filePath });
  });

  const chat = new ChatViewProvider(context.extensionUri, agentService, auth, {
    supportsSecondarySidebar,
  });
  chat.setDiffReview(diffs);

  const statusBar = new GrokStatusBar(agentService);

  const webviewOpts = { webviewOptions: { retainContextWhenHidden: true } };

  context.subscriptions.push(
    agentService,
    chat,
    statusBar,
    diffs,
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
        await chat.openChat();
        await chat.runStartAgent();
        const state = agentService!.getState();
        if (state.kind === "ready") {
          void vscode.window.showInformationMessage("Grok Build agent ready");
        }
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.restartAgent", async () => {
      openOutput();
      try {
        await chat.openChat();
        await chat.runRestartAgent();
        const state = agentService!.getState();
        if (state.kind === "ready") {
          void vscode.window.showInformationMessage(
            "Grok Build agent restarted",
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
        await chat.runNewSession();
        void vscode.window.showInformationMessage("Grok Build: new session");
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
      await runLoginFlow(agentService!, auth, chat);
    }),

    vscode.commands.registerCommand("grok.logout", async () => {
      await runLogoutFlow(agentService!, auth, chat);
    }),

    vscode.commands.registerCommand("grok.pasteAuthCode", async () => {
      try {
        await agentService!.pasteAuthCode();
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.checkSubscription", async () => {
      try {
        await chat.openChat();
        await chat.runCheckSubscription();
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.accountInfo", async () => {
      try {
        await agentService!.ensureStarted();
        const info = await agentService!.refreshAuthInfo();
        let meta = agentService!.getAuthMeta();
        try {
          const sub = await agentService!.checkSubscription();
          meta = sub.meta ?? meta;
        } catch {
          /* optional */
        }
        const summary =
          agentService!.formatAuthProfileSummary(
            (await auth.getStatus()).summary,
          ) || "No account details";
        const lines = [summary];
        if (info?.email) {
          lines.push(`Email: ${info.email}`);
        }
        if (info?.methodId) {
          lines.push(`Method: ${info.methodId}`);
        }
        if (meta?.subscriptionTier) {
          lines.push(`Tier: ${meta.subscriptionTier}`);
        }
        if (meta?.gate?.message) {
          lines.push(`Gate: ${meta.gate.message}`);
        }
        if (info?.teamName) {
          lines.push(
            `Team: ${info.teamName}${info.teamRole ? ` (${info.teamRole})` : ""}`,
          );
        }
        void vscode.window.showInformationMessage(lines.join(" · "));
        await chat.refreshState();
      } catch (err) {
        await showStartError(err);
      }
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

    vscode.commands.registerCommand("grok.addContext", async () => {
      await chat.addContextFromPicker();
    }),

    vscode.commands.registerCommand("grok.selectModel", async () => {
      // Chat webview model popover only (same UX as header model button).
      await chat.openModelPicker();
    }),

    vscode.commands.registerCommand("grok.resumeSession", async () => {
      try {
        await chat.openChat();
        const workspaceCwd = resolveSessionCwd();

        // Same list source + UX as Grok TUI `/resume` and `grok sessions list`
        const entry = await pickGrokSessionToResume(
          agentService!,
          workspaceCwd,
        );
        if (!entry) {
          return;
        }

        await agentService!.ensureStarted();
        const caps = agentService!.getCapabilities();
        if (!caps.loadSession) {
          void vscode.window.showWarningMessage(
            "This agent binary does not advertise session/load — cannot resume like the TUI.",
          );
          return;
        }

        chat.beginHistoryLoad(entry.sessionId, entry.title);
        try {
          await agentService!.loadSession(
            entry.sessionId,
            entry.cwd || workspaceCwd,
          );
          await new Promise((r) => setTimeout(r, 400));
          chat.endHistoryLoad();
          void vscode.window.showInformationMessage(
            `Resumed ${entry.title || "session"}`,
          );
          await chat.refreshState();
        } catch (err) {
          chat.endHistoryLoad();
          throw err;
        }
      } catch (err) {
        await showStartError(err);
      }
    }),

    vscode.commands.registerCommand("grok.reviewEdits", async () => {
      await diffs.pickAndOpen();
    }),

    vscode.commands.registerCommand(
      "grok.openExtensions",
      async (args?: { tab?: string } | ExtensionsTab) => {
        let tab: ExtensionsTab = "hooks";
        if (typeof args === "string" && isExtensionsTab(args)) {
          tab = args;
        } else if (
          args &&
          typeof args === "object" &&
          isExtensionsTab(args.tab)
        ) {
          tab = args.tab;
        }
        ExtensionsPanel.show(context.extensionUri, agentService!, tab);
      },
    ),

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

  logInfo("Grok Build - Community activated (L2 polish)");
}

export async function deactivate(): Promise<void> {
  logInfo("Grok Build - Community deactivating…");
  try {
    setBeforeWriteHook(undefined);
    await agentService?.disposeAsync();
  } catch (err) {
    logError("Error during deactivate", err);
  } finally {
    agentService = undefined;
    disposeOutput();
  }
}

async function runLoginFlow(
  agent: AgentService,
  auth: AuthService,
  chat: ChatViewProvider,
): Promise<void> {
  const status = await auth.getStatus();
  const choice = await pickLoginMethod(status);
  if (!choice) {
    return;
  }
  if (choice === "apiKey") {
    const ok = await promptAndStoreApiKey(auth);
    if (ok) {
      try {
        if (agent.getState().kind === "ready") {
          await agent.restart();
        } else {
          await agent.ensureStarted();
        }
      } catch (err) {
        await showStartError(err);
      }
      await chat.refreshState();
    }
    return;
  }

  // Browser OAuth via ACP authenticate + openExternal (writes ~/.grok/auth.json — same store as CLI)
  try {
    await agent.interactiveBrowserLogin();
    const after = await auth.refresh();
    const summary = agent.formatAuthProfileSummary(
      after.cliEmail ? `CLI session (${after.cliEmail})` : "CLI session",
    );
    void vscode.window.showInformationMessage(
      `Grok Build: signed in — ${summary}`,
    );
    const gate = agent.getAccessGate();
    if (gate?.message) {
      const action = gate.url?.startsWith("https://")
        ? await vscode.window.showWarningMessage(
            gate.message,
            gate.label?.trim() || "Open link",
            "Check subscription",
          )
        : await vscode.window.showWarningMessage(
            gate.message,
            "Check subscription",
          );
      if (action === "Check subscription") {
        await chat.runCheckSubscription();
      } else if (action && action !== "Check subscription" && gate.url) {
        await vscode.env.openExternal(vscode.Uri.parse(gate.url));
      }
    }
    await chat.refreshState();
  } catch (err) {
    await showStartError(err);
  }
}

async function runLogoutFlow(
  agent: AgentService,
  auth: AuthService,
  chat: ChatViewProvider,
): Promise<void> {
  const status = await auth.getStatus();
  if (!status.hasAny && agent.getState().kind !== "ready") {
    void vscode.window.showInformationMessage("Grok Build: already signed out");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "Sign out of Grok? This clears the CLI session (~/.grok/auth.json) and any API key stored in VS Code — same as `grok logout`.",
    { modal: true },
    "Log out",
  );
  if (confirm !== "Log out") {
    return;
  }
  try {
    const { logout, clearedSecretKey } = await agent.logout();
    await auth.refresh();
    void vscode.window.showInformationMessage(
      `Grok Build: ${formatLogoutMessage(logout, clearedSecretKey)}`,
    );
  } catch (err) {
    // Still try to clear secret key if agent path failed.
    if (await auth.hasSecretApiKey()) {
      await auth.clearApiKey();
    }
    await showStartError(err);
  }
  await chat.refreshState();
}

async function showStartError(err: unknown): Promise<void> {
  logError("Command failed", err);
  if (await handleMissingCliError(err)) {
    return;
  }
  void vscode.window.showErrorMessage(`Grok Build: ${errMessage(err)}`);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
