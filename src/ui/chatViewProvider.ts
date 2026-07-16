import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { pickLoginMethod, promptAndStoreApiKey } from "../auth/authService";
import { formatLogoutMessage } from "../auth/authFlow";
import {
  getCliInstallInfo,
  probeGrokBinary,
} from "../agent/binaryResolver";
import {
  handleMissingCliError,
  promptMissingCli,
} from "../agent/missingCliPrompt";
import {
  buildPromptBlocks,
  getActiveEditorChip,
  isAutoAttachEnabled,
  type ContextChip,
} from "../context/editorContext";
import { searchContextSuggestions } from "../context/contextPicker";
import { getSettings } from "../config/settings";
import {
  contextWindowFromCatalog,
  effortDisplayLabel,
  fallbackModels,
  modelDisplayLabel,
  type GrokEffortOption,
  type GrokModelOption,
} from "../config/modelService";
import { logError } from "../log/output";
import { renderMarkdownToSafeHtml } from "./markdown";
import {
  applyAgentMessageChunk,
  applyAgentThoughtChunk,
  applyToolEvent,
  applyUserMessageChunk,
  assignPromptIndices,
  assistantHasRunningThought,
  assistantPlainText,
  emptyAssistant,
  extractToolContentText,
  finishAssistantThoughts,
  formatToolValue,
  nextPromptIndex,
  truncateFromMessageId,
  type AssistantItem,
  type ThoughtSegment,
  type ToolCard,
} from "./sessionMessageMerge";
import { parseSessionNotificationMeta } from "./sessionNotificationMeta";
import {
  buildTurnStatusParts,
  formatThoughtHeader,
  processLabelForSessionUpdate,
  type SessionUsageSnapshot,
} from "./turnStatusFormat";
import {
  modeButtonLabel,
  modeCssClass,
  modeDescription,
  modeLabel,
  modeToast,
  type CycleModeId,
} from "./sessionModeCycle";
import type { DiffReviewService } from "../diff/diffReviewService";
import { readTextFileHost } from "../agent/hostFs";
import { dispatchSlash } from "../slash/dispatch";
import { slashRegistry } from "../slash/registry";
import {
  permissionOptionIcon,
  type AskUserQuestionResponse,
  type PermissionPromptPayload,
  type PermissionPromptResult,
  type QuestionPromptPayload,
} from "./interactivePrompt";

type UiMessage =
  | {
      type: "user";
      id: string;
      text: string;
      chips?: string[];
      /** Shell prompt index for edit-and-resubmit rewind (TUI parity). */
      promptIndex?: number;
    }
  | {
      type: "assistant";
      id: string;
      /** Ordered timeline: thoughts, text, tools (TUI scrollback order). */
      items: AssistantItem[];
    }
  | { type: "system"; id: string; text: string };

interface SerializedTimelineItem {
  kind: "text" | "tool" | "thought";
  text?: string;
  html?: string;
  tool?: ToolCard;
  thought?: ThoughtSegment & {
    html?: string;
    label?: string;
  };
}

interface SerializedMessage {
  type: string;
  id: string;
  text?: string;
  html?: string;
  chips?: string[];
  promptIndex?: number;
  /** Ordered timeline: thoughts, text, tools in stream order. */
  items?: SerializedTimelineItem[];
}

/** Official Grok mark (inline SVG; inherits `currentColor`). */
const GROK_MARK_SVG = `<svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M200.627 323.264L434.46 86.7826V87.0046L502 19C500.793 20.7342 499.57 22.4224 498.361 24.1106C447.041 95.2696 421.983 130.065 442.09 217.132L441.973 216.999C455.835 276.264 441.001 341.988 393.112 390.202C332.731 451.037 236.113 464.575 156.552 409.813L212.029 383.965C262.804 404.037 318.368 395.224 358.288 355.023C398.223 314.821 407.194 256.281 387.116 207.55C383.301 198.32 371.87 195.995 363.871 201.949L200.627 323.264ZM166.938 352.741L166.895 352.785L11 493C20.8837 479.299 33.1544 466.338 45.3963 453.391C79.9246 416.864 114.188 380.662 93.2849 329.5C65.297 261.037 81.5891 180.812 133.426 128.627C187.31 74.4292 266.663 60.7568 332.937 88.2186C347.609 93.6996 360.395 101.506 370.353 108.765L315.01 134.493C263.482 112.733 204.442 127.532 168.412 163.808C119.682 212.822 109.828 297.816 166.938 352.741Z"/></svg>`;

/**
 * Sidebar webview chat for Grok Build - Community (L1 + L2 polish).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "grok.chatView";
  public static readonly secondaryViewType = "grok.chatView.secondary";

  private view?: vscode.WebviewView;
  private readonly views = new Map<string, vscode.WebviewView>();
  private supportsSecondarySidebar = true;
  private messages: UiMessage[] = [];
  private currentAssistantId: string | undefined;
  private stickyChips: ContextChip[] = [];
  private messagesFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private diffs: DiffReviewService | undefined;
  /** True while ACP session/load is replaying history into the UI. */
  private loadingHistory = false;
  private currentUserId: string | undefined;
  /** Avoid re-parsing markdown for messages whose source text has not changed. */
  private readonly mdCache = new Map<string, { key: string; html: string }>();
  /** Live turn clock (ms epoch); cleared when idle. */
  private turnStartedAt: number | undefined;
  private turnProcess = "";
  private sessionUsage: SessionUsageSnapshot = {};
  private turnStatusTimer: ReturnType<typeof setInterval> | undefined;
  /** Wall-clock start of the current assistant's thought stream (live only). */
  private thoughtStartedAt: number | undefined;
  /** Pending permission popover (serialized in PermissionBroker). */
  private pendingPermission:
    | {
        promptId: number;
        resolve: (r: PermissionPromptResult) => void;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** Pending ask_user_question popover. */
  private pendingQuestion:
    | {
        promptId: number;
        resolve: (r: AskUserQuestionResponse) => void;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly auth: AuthService,
    options?: { supportsSecondarySidebar?: boolean },
  ) {
    this.supportsSecondarySidebar = options?.supportsSecondarySidebar ?? true;
    this.agent.setPermissionPromptUi((p) => this.showPermissionPrompt(p));
    this.agent.setQuestionPromptUi((p) => this.showQuestionPrompt(p));
    this.disposables.push(
      this.agent.onSessionUpdate((n) => this.handleSessionUpdate(n)),
      this.agent.onBusyChange((busy) => {
        this.post({ type: "busy", busy });
        if (busy) {
          this.beginTurnStatus();
        } else {
          this.endTurnStatusClock();
          this.postTurnStatus();
          // Thought header may have frozen to "Thought for Xs" — re-render.
          this.scheduleMessagesPost(true);
        }
      }),
      this.agent.onStateChange((state) =>
        this.post({
          type: "agentState",
          state: state.kind,
          detail:
            state.kind === "ready"
              ? "ready"
              : state.kind === "error"
                ? state.message
                : "",
          model: getSettings().model || "default",
        }),
      ),
      this.agent.onAvailableCommands((cmds) => {
        slashRegistry.setAcpCommands(cmds);
      }),
      this.agent.onModelsChange((m) => {
        this.post({
          type: "models",
          models: m.models,
          currentModelId: m.currentModelId,
          currentLabel:
            m.currentLabel || modelDisplayLabel(m.models, m.currentModelId),
          efforts: m.efforts,
          currentEffortId: m.currentEffortId,
          currentEffortLabel:
            m.currentEffortLabel ||
            effortDisplayLabel(m.efforts, m.currentEffortId),
        });
        // Context bar denominator comes from agent model meta — refresh when catalog changes.
        this.postTurnStatus();
      }),
      this.agent.onModeChange((m) => {
        this.postModeState(m.mode);
      }),
      this.agent.onTurnEnd((response) => {
        this.currentAssistantId = undefined;
        if (response.usage) {
          this.sessionUsage = {
            ...this.sessionUsage,
            turnTotalTokens: response.usage.totalTokens,
            turnInputTokens: response.usage.inputTokens,
            turnOutputTokens: response.usage.outputTokens,
            // If we never got usage_update.used, prefer turn total for display.
            used: this.sessionUsage.used ?? response.usage.totalTokens,
          };
        }
        // Clock + busy UI: onBusyChange(false) runs in sendPrompt finally.
        this.postTurnStatus();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.postAutoContext()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.postAutoContext();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("grok.context.autoAttachActiveFile") ||
          e.affectsConfiguration("grok.context.autoAttachSelection") ||
          e.affectsConfiguration("grok.context.excludeGlob")
        ) {
          this.postAutoContext();
        }
        if (e.affectsConfiguration("grok.binaryPath")) {
          void this.pushFullState();
        }
      }),
      // Keep empty-state Sign in / Log out + account label in sync when the
      // CLI mutates ~/.grok/auth.json (grok login / grok logout).
      this.auth.onDidChange((status) => {
        void vscode.commands.executeCommand(
          "setContext",
          "grok.signedIn",
          status.hasAny,
        );
        void this.pushFullState();
      }),
    );
  }

  setDiffReview(diffs: DiffReviewService): void {
    this.diffs = diffs;
    this.disposables.push(
      diffs.onDidChange((entries) => {
        this.post({
          type: "review",
          count: entries.length,
          paths: entries.map((e) => e.path),
        });
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const viewId = webviewView.viewType;
    this.views.set(viewId, webviewView);
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.views.delete(viewId);
      if (this.view === webviewView) {
        this.view = this.views.values().next().value;
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.onMessage(msg);
      } catch (err) {
        logError("Chat webview message failed", err);
        this.pushSystem(`Error: ${errMessage(err)}`);
      }
    });

    // Seed UI immediately, then start agent so model catalog matches TUI
    // without waiting for another server-touching action (send, resume, …).
    void this.pushFullState();
    void this.ensureModelsLoaded();
  }

  async openChat(): Promise<void> {
    if (this.supportsSecondarySidebar) {
      try {
        await vscode.commands.executeCommand(
          "workbench.action.focusAuxiliaryBar",
        );
      } catch {
        /* older hosts */
      }
      try {
        await vscode.commands.executeCommand(
          `${ChatViewProvider.secondaryViewType}.focus`,
        );
        return;
      } catch {
        /* fall through */
      }
    }
    await vscode.commands.executeCommand(
      `${ChatViewProvider.viewType}.focus`,
    );
  }

  async openActivityBarChat(): Promise<void> {
    await vscode.commands.executeCommand(
      `${ChatViewProvider.viewType}.focus`,
    );
  }

  async sendFromCommand(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
  }

  async addContextFromPicker(): Promise<void> {
    await this.openChat();
    if (!(await this.waitForWebview())) {
      void vscode.window.showWarningMessage(
        "Grok Build: open the chat panel to add context",
      );
      return;
    }
    this.post({ type: "openMention" });
  }

  /** Open chat model popover (command palette / slash /model with no args). */
  async openModelPicker(): Promise<void> {
    await this.openChat();
    if (!(await this.waitForWebview())) {
      void vscode.window.showWarningMessage(
        "Grok Build: open the chat panel to select a model",
      );
      return;
    }
    await this.ensureModelsLoaded();
    this.post({ type: "openModel" });
  }

  /** Wait until a chat webview is registered after focus. */
  private async waitForWebview(maxMs = 500): Promise<boolean> {
    if (this.views.size > 0) {
      return true;
    }
    const step = 50;
    let waited = 0;
    while (waited < maxMs) {
      await new Promise((r) => setTimeout(r, step));
      waited += step;
      if (this.views.size > 0) {
        return true;
      }
    }
    return this.views.size > 0;
  }

  private addStickyChips(picked: ContextChip[]): void {
    for (const c of picked) {
      if (!this.stickyChips.some((x) => x.id === c.id)) {
        this.stickyChips.push(c);
      }
    }
    this.postSticky();
  }

  clearMessages(): void {
    this.messages = [];
    this.currentAssistantId = undefined;
    this.currentUserId = undefined;
    this.thoughtStartedAt = undefined;
    this.mdCache.clear();
    this.scheduleMessagesPost(true);
  }

  /**
   * Prepare UI for ACP session/load history replay.
   */
  beginHistoryLoad(_sessionId?: string, title?: string): void {
    this.loadingHistory = true;
    this.messages = [];
    this.currentAssistantId = undefined;
    this.currentUserId = undefined;
    this.thoughtStartedAt = undefined;
    this.mdCache.clear();
    this.sessionUsage = {};
    this.endTurnStatusClock();
    this.diffs?.clear();
    const label = title?.trim() || "session";
    this.pushSystem(`Loading ${label}…`);
    this.post({ type: "busy", busy: true });
  }

  endHistoryLoad(): void {
    this.loadingHistory = false;
    // Collapse any thought still marked running from replay (no wall-clock).
    for (const m of this.messages) {
      if (m.type === "assistant") {
        finishAssistantThoughts(m);
      }
    }
    // Ensure rewind targets match shell prompt order after history replay.
    assignPromptIndices(this.messages);
    this.currentAssistantId = undefined;
    this.currentUserId = undefined;
    this.thoughtStartedAt = undefined;
    this.post({ type: "busy", busy: false });
    // Drop the transient "Loading…" system line if it is the only system msg at start
    if (
      this.messages.length > 0 &&
      this.messages[0]?.type === "system" &&
      this.messages[0].text.startsWith("Loading ")
    ) {
      this.messages.shift();
    }
    this.scheduleMessagesPost(true);
    this.postTurnStatus();
  }

  async refreshState(): Promise<void> {
    await this.pushFullState();
  }

  dispose(): void {
    if (this.messagesFlushTimer) {
      clearTimeout(this.messagesFlushTimer);
    }
    this.endTurnStatusClock();
    this.agent.setPermissionPromptUi(undefined);
    this.agent.setQuestionPromptUi(undefined);
    if (this.pendingPermission) {
      const p = this.pendingPermission;
      this.pendingPermission = undefined;
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ outcome: "cancelled" });
    }
    if (this.pendingQuestion) {
      const q = this.pendingQuestion;
      this.pendingQuestion = undefined;
      if (q.timer) clearTimeout(q.timer);
      q.resolve({ outcome: "cancelled" });
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Show permission options in the chat popover (TUI permission view).
   * Opens the chat panel so the user can answer.
   */
  private async showPermissionPrompt(
    payload: PermissionPromptPayload,
  ): Promise<PermissionPromptResult> {
    await this.openChat();
    if (!(await this.waitForWebview())) {
      throw new Error("webview not ready");
    }
    return new Promise<PermissionPromptResult>((resolve) => {
      if (this.pendingPermission) {
        const prev = this.pendingPermission;
        this.pendingPermission = undefined;
        if (prev.timer) clearTimeout(prev.timer);
        prev.resolve({ outcome: "cancelled" });
      }
      const timer = setTimeout(() => {
        if (this.pendingPermission?.promptId === payload.promptId) {
          this.pendingPermission = undefined;
          this.post({ type: "closePermissionPrompt" });
          resolve({ outcome: "timeout" });
        }
      }, payload.timeoutMs);
      this.pendingPermission = {
        promptId: payload.promptId,
        resolve,
        timer,
      };
      this.post({
        type: "permissionPrompt",
        promptId: payload.promptId,
        title: payload.title,
        detail: payload.detail,
        options: payload.options.map((o) => ({
          ...o,
          icon: permissionOptionIcon(o.kind),
        })),
      });
    });
  }

  /**
   * Show structured questions in the chat popover (TUI question view).
   */
  private async showQuestionPrompt(
    payload: QuestionPromptPayload,
  ): Promise<AskUserQuestionResponse> {
    await this.openChat();
    if (!(await this.waitForWebview())) {
      throw new Error("webview not ready");
    }
    return new Promise<AskUserQuestionResponse>((resolve) => {
      if (this.pendingQuestion) {
        const prev = this.pendingQuestion;
        this.pendingQuestion = undefined;
        if (prev.timer) clearTimeout(prev.timer);
        prev.resolve({ outcome: "cancelled" });
      }
      const timer = setTimeout(() => {
        if (this.pendingQuestion?.promptId === payload.promptId) {
          this.pendingQuestion = undefined;
          this.post({ type: "closeQuestionPrompt" });
          resolve({ outcome: "cancelled" });
        }
      }, payload.timeoutMs);
      this.pendingQuestion = {
        promptId: payload.promptId,
        resolve,
        timer,
      };
      this.post({
        type: "questionPrompt",
        promptId: payload.promptId,
        toolCallId: payload.toolCallId,
        mode: payload.mode,
        questions: payload.questions,
      });
    });
  }

  private beginTurnStatus(): void {
    if (!this.turnStartedAt) {
      this.turnStartedAt = Date.now();
    }
    if (!this.turnProcess) {
      this.turnProcess = "Working…";
    }
    if (!this.turnStatusTimer) {
      this.turnStatusTimer = setInterval(() => this.postTurnStatus(), 250);
    }
    this.postTurnStatus();
  }

  private endTurnStatusClock(): void {
    if (this.turnStatusTimer) {
      clearInterval(this.turnStatusTimer);
      this.turnStatusTimer = undefined;
    }
    this.turnStartedAt = undefined;
    this.turnProcess = "";
    // Freeze any open thought header to "Thought for Xs" (TUI finish).
    this.finishThoughtPhase();
  }

  /**
   * End the live thinking stream: freeze elapsed for the TUI-style
   * "Thought for Xs" label and collapse the open thought on the timeline.
   * History replay never arms the local timer (matches TUI streaming_replay).
   */
  private finishThoughtPhase(): void {
    const id = this.currentAssistantId;
    if (!id) {
      this.thoughtStartedAt = undefined;
      return;
    }
    const msg = this.messages.find(
      (m) => m.type === "assistant" && m.id === id,
    );
    if (!msg || msg.type !== "assistant" || !assistantHasRunningThought(msg)) {
      this.thoughtStartedAt = undefined;
      return;
    }
    const elapsed =
      this.thoughtStartedAt != null
        ? Math.max(0, Date.now() - this.thoughtStartedAt)
        : undefined;
    finishAssistantThoughts(msg, elapsed);
    this.thoughtStartedAt = undefined;
  }

  /** Current model context window from agent catalog (meta.totalContextTokens). */
  private agentContextWindow(): number | undefined {
    const catalog = this.agent.getModels();
    return contextWindowFromCatalog(catalog.models, catalog.currentModelId);
  }

  private postTurnStatus(): void {
    const busy = this.agent.isBusy();
    const elapsedMs =
      busy && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    const parts = buildTurnStatusParts(
      {
        busy,
        process: this.turnProcess,
        elapsedMs,
        usage: this.sessionUsage,
      },
      this.agentContextWindow(),
    );
    this.post({
      type: "turnStatus",
      ...parts,
    });
    // Always push context bar (even when process row is hidden when idle).
    this.post({
      type: "contextBar",
      ...parts.context,
    });
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    path?: string;
    id?: string;
    query?: string;
    requestId?: number;
    chip?: ContextChip;
    enabled?: boolean;
    modelId?: string;
    effortId?: string;
    promptId?: number;
    optionId?: string;
    outcome?: string;
    answers?: Record<string, string[]>;
    annotations?: Record<string, { preview?: string; notes?: string }>;
    partial_answers?: Record<string, string>;
    promptIndex?: number;
    mode?: string;
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushFullState();
        await this.ensureModelsLoaded();
        break;
      case "ensureModels":
        await this.ensureModelsLoaded();
        break;
      case "send":
        if (msg.text?.trim()) {
          await this.handleSend(msg.text.trim());
        }
        break;
      case "editMessage":
        if (msg.id && msg.text !== undefined) {
          await this.handleEditMessage(
            msg.id,
            msg.text,
            msg.promptIndex,
            msg.mode === "all" || msg.mode === "conversation_only"
              ? msg.mode
              : undefined,
          );
        }
        break;
      case "copyText":
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
        }
        break;
      case "cancel":
        await this.agent.cancelTurn();
        this.pushSystem("Cancel requested…");
        break;
      case "newSession":
        await this.handleNewSession();
        break;
      case "openFile":
        if (msg.path) {
          await vscode.window.showTextDocument(vscode.Uri.file(msg.path));
        }
        break;
      case "openDiff":
        if (msg.path && this.diffs) {
          await this.diffs.openDiff(msg.path);
        }
        break;
      case "reviewEdits":
        await this.diffs?.pickAndOpen();
        break;
      case "login": {
        const status = await this.auth.getStatus();
        const choice = await pickLoginMethod(status);
        if (choice === "apiKey") {
          await promptAndStoreApiKey(this.auth);
          try {
            if (this.agent.getState().kind === "ready") {
              await this.agent.restart();
            } else if (await this.auth.hasAnyAuth()) {
              await this.agent.ensureStarted();
            }
          } catch (err) {
            await this.showStartError(err);
          }
        } else if (choice === "browser") {
          try {
            await this.agent.interactiveBrowserLogin();
            await this.auth.refresh();
            const after = await this.auth.getStatus();
            this.pushSystem(
              after.cliEmail
                ? `Signed in with browser as ${after.cliEmail} (CLI session)`
                : "Signed in with browser (CLI session)",
            );
          } catch (err) {
            await this.showStartError(err);
          }
        }
        await this.pushFullState();
        break;
      }
      case "logout": {
        const status = await this.auth.getStatus();
        if (!status.hasAny && this.agent.getState().kind !== "ready") {
          this.pushSystem("Already signed out");
          await this.pushFullState();
          break;
        }
        const confirm = await vscode.window.showWarningMessage(
          "Sign out of Grok? This clears the CLI session (~/.grok/auth.json) and any API key stored in VS Code — same as `grok logout`.",
          { modal: true },
          "Log out",
        );
        if (confirm !== "Log out") {
          break;
        }
        try {
          const { logout, clearedSecretKey } = await this.agent.logout();
          this.pushSystem(formatLogoutMessage(logout, clearedSecretKey));
          await this.auth.refresh();
        } catch (err) {
          await this.showStartError(err);
        }
        await this.pushFullState();
        break;
      }
      case "startAgent":
        try {
          const probe = await probeGrokBinary();
          if (!probe.found) {
            const outcome = await promptMissingCli();
            if (outcome === "retry") {
              await this.agent.ensureStarted();
              this.pushSystem("Agent ready");
            }
          } else {
            await this.agent.ensureStarted();
            this.pushSystem("Agent ready");
          }
        } catch (err) {
          await this.showStartError(err);
        }
        await this.pushFullState();
        break;
      case "copyInstallCommand": {
        const info = getCliInstallInfo();
        await vscode.env.clipboard.writeText(info.command);
        void vscode.window.showInformationMessage(
          `Copied install command — paste in a terminal, then click “I installed it”.`,
        );
        break;
      }
      case "openInstallDocs": {
        const info = getCliInstallInfo();
        await vscode.env.openExternal(vscode.Uri.parse(info.docsUrl));
        break;
      }
      case "setBinaryPath":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "grok.binaryPath",
        );
        break;
      case "recheckCli": {
        const probe = await probeGrokBinary();
        if (probe.found) {
          void vscode.window.showInformationMessage(
            `Found grok at ${probe.path}`,
          );
          try {
            await this.agent.ensureStarted();
            this.pushSystem("Agent ready");
          } catch (err) {
            await this.showStartError(err);
          }
        } else {
          void vscode.window.showWarningMessage(
            "Still cannot find `grok`. Install the CLI, then try again.",
          );
        }
        await this.pushFullState();
        break;
      }
      case "addContext":
        // Open in-webview mention popover.
        this.post({ type: "openMention" });
        break;
      case "searchMention": {
        const requestId = msg.requestId ?? 0;
        const query = msg.query ?? "";
        try {
          const items = await searchContextSuggestions(query, 24);
          this.post({
            type: "mentionResults",
            requestId,
            query,
            items: items.map((s) => ({
              id: s.id,
              label: s.label,
              description: s.description ?? "",
              icon: s.icon,
              chip: s.chip,
            })),
          });
        } catch (err) {
          logError("Mention search failed", err);
          this.post({
            type: "mentionResults",
            requestId,
            query,
            items: [],
          });
        }
        break;
      }
      case "searchSlash": {
        const requestId = msg.requestId ?? 0;
        const query = msg.query ?? "";
        // Refresh ACP list if agent already has one
        slashRegistry.setAcpCommands(this.agent.getAvailableCommands());
        const items = slashRegistry.suggest(query, 48);
        this.post({
          type: "slashResults",
          requestId,
          query,
          items,
        });
        break;
      }
      case "pickMention":
        if (msg.chip) {
          this.addStickyChips([msg.chip]);
        }
        break;
      case "removeChip":
        if (msg.id) {
          this.stickyChips = this.stickyChips.filter((c) => c.id !== msg.id);
          this.postSticky();
        }
        break;
      case "setAutoAttach": {
        const enabled = msg.enabled !== false;
        const cfg = vscode.workspace.getConfiguration("grok");
        await cfg.update(
          "context.autoAttachActiveFile",
          enabled,
          vscode.ConfigurationTarget.Global,
        );
        await cfg.update(
          "context.autoAttachSelection",
          enabled,
          vscode.ConfigurationTarget.Global,
        );
        this.postAutoContext();
        break;
      }
      case "selectModel":
        // Host / legacy message: open in-webview model popover only.
        await this.ensureModelsLoaded();
        this.post({ type: "openModel" });
        break;
      case "setModel": {
        const modelId = (msg.modelId ?? "").trim();
        if (!modelId) {
          break;
        }
        try {
          if (this.agent.isBusy()) {
            this.pushSystem(
              "Wait for the current turn or press Stop before switching model.",
            );
            break;
          }
          await this.agent.setSessionModel(modelId);
          const cat = this.agent.getModels();
          this.pushSystem(
            `Model set to ${modelDisplayLabel(cat.models, modelId)}`,
          );
          await this.pushFullState();
        } catch (err) {
          this.pushSystem(errMessage(err));
          this.post({ type: "openModel" });
        }
        break;
      }
      case "cycleMode": {
        try {
          const next = await this.agent.cycleSessionMode();
          this.postModeState(next);
          // TUI shows a short mode-switch banner; use a compact system line.
          this.pushSystem(modeToast(next));
        } catch (err) {
          this.pushSystem(errMessage(err));
        }
        break;
      }
      case "setEffort": {
        const effortId = (msg.effortId ?? "").trim();
        if (!effortId) {
          break;
        }
        try {
          if (this.agent.isBusy()) {
            this.pushSystem(
              "Wait for the current turn or press Stop before changing effort.",
            );
            break;
          }
          await this.agent.setReasoningEffort(effortId);
          const cat = this.agent.getModels();
          this.pushSystem(
            `Reasoning effort set to ${effortDisplayLabel(cat.efforts, effortId) || effortId}`,
          );
          await this.pushFullState();
        } catch (err) {
          this.pushSystem(errMessage(err));
        }
        break;
      }
      case "permissionResponse": {
        const promptId = msg.promptId ?? 0;
        const pending = this.pendingPermission;
        if (!pending || pending.promptId !== promptId) {
          break;
        }
        this.pendingPermission = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.outcome === "selected" && msg.optionId) {
          pending.resolve({ outcome: "selected", optionId: msg.optionId });
        } else if (msg.outcome === "timeout") {
          pending.resolve({ outcome: "timeout" });
        } else {
          pending.resolve({ outcome: "cancelled" });
        }
        break;
      }
      case "questionResponse": {
        const promptId = msg.promptId ?? 0;
        const pending = this.pendingQuestion;
        if (!pending || pending.promptId !== promptId) {
          break;
        }
        this.pendingQuestion = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        const outcome = msg.outcome ?? "cancelled";
        if (outcome === "accepted" && msg.answers) {
          pending.resolve({
            outcome: "accepted",
            answers: msg.answers,
            annotations: msg.annotations,
          });
        } else if (outcome === "chat_about_this") {
          pending.resolve({
            outcome: "chat_about_this",
            partial_answers: msg.partial_answers ?? {},
          });
        } else if (outcome === "skip_interview") {
          pending.resolve({
            outcome: "skip_interview",
            partial_answers: msg.partial_answers ?? {},
          });
        } else {
          pending.resolve({ outcome: "cancelled" });
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleSend(
    text: string,
    options?: { literal?: boolean },
  ): Promise<void> {
    if (this.agent.isBusy()) {
      this.pushSystem("Wait for the current turn or press Stop.");
      return;
    }

    // Require CLI before any chat turn — force install if missing.
    const probe = await probeGrokBinary();
    if (!probe.found) {
      await promptMissingCli();
      await this.pushFullState();
      return;
    }

    // TUI inline-edit resubmit uses literal=true so slash-lookalike text is
    // sent as a normal prompt (conversation already truncated).
    if (!options?.literal) {
      // Slash commands (host / pass-through / unsupported) — like TUI pager.
      slashRegistry.setAcpCommands(this.agent.getAvailableCommands());
      const outcome = await dispatchSlash(text, {
        agent: this.agent,
        auth: this.auth,
        registry: slashRegistry,
        getTranscript: () =>
          this.messages
            .filter((m) => m.type === "user" || m.type === "assistant")
            .map((m) => ({
              role: m.type,
              text:
                m.type === "assistant" ? assistantPlainText(m) : m.text,
            })),
        clearUi: () => {
          this.messages = [];
          this.currentAssistantId = undefined;
          this.mdCache.clear();
          this.scheduleMessagesPost(true);
        },
        newSession: async () => {
          await this.handleNewSession();
        },
      });

      if (outcome.kind === "handled") {
        if (outcome.message) {
          this.pushSystem(outcome.message);
        }
        return;
      }
      if (outcome.kind === "error") {
        this.pushSystem(outcome.message);
        return;
      }
      if (outcome.kind === "passthrough") {
        text = outcome.text;
      }
    }

    const { blocks, chips } = buildPromptBlocks(text, {
      stickyChips: this.stickyChips,
    });
    const userId = uid();
    this.messages.push({
      type: "user",
      id: userId,
      text,
      chips: chips.map((c) => c.label),
      promptIndex: nextPromptIndex(this.messages),
    });

    const asstId = uid();
    this.currentAssistantId = asstId;
    this.messages.push(emptyAssistant(asstId));
    this.scheduleMessagesPost(true);
    this.turnProcess = "Working…";
    this.beginTurnStatus();
    this.post({ type: "busy", busy: true });

    try {
      await this.agent.ensureStarted();
      await this.agent.sendPrompt(blocks);
    } catch (err) {
      this.currentAssistantId = undefined;
      this.post({ type: "busy", busy: false });
      await this.showStartError(err);
      this.pushSystem(errMessage(err));
    }
  }

  /**
   * Edit a previous user prompt and resubmit (TUI inline-edit parity).
   * Webview owns mode selection popover (Both / Conversation only) and
   * pre-fills the composer; host rewinds then resubmits.
   */
  private async handleEditMessage(
    messageId: string,
    newText: string,
    promptIndexHint?: number,
    modeHint?: "all" | "conversation_only",
  ): Promise<void> {
    const text = newText.trim();
    if (!text) {
      this.pushSystem("Edited message is empty — nothing to resubmit.");
      this.post({ type: "restoreEditComposer", id: messageId, text: newText });
      return;
    }

    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") {
      this.pushSystem("Could not find that user message to edit.");
      return;
    }
    if (text === msg.text.trim()) {
      return;
    }

    const mode = modeHint ?? "conversation_only";

    const promptIndex =
      typeof promptIndexHint === "number" && Number.isFinite(promptIndexHint)
        ? promptIndexHint
        : typeof msg.promptIndex === "number"
          ? msg.promptIndex
          : nextPromptIndex(
              this.messages.slice(
                0,
                this.messages.findIndex((m) => m.id === messageId),
              ),
            );

    try {
      if (this.agent.isBusy()) {
        await this.agent.cancelTurn();
        this.pushSystem("Cancelled current turn to edit message…");
      }

      const sessionId = this.agent.getSessionId();
      if (!sessionId) {
        this.pushSystem("No active session — cannot rewind to edit.");
        this.post({ type: "restoreEditComposer", id: messageId, text });
        return;
      }

      await this.agent.ensureStarted();
      const res = await this.agent.requestExt<{
        success?: boolean;
        error?: string | null;
        result?: { success?: boolean; error?: string | null };
      }>("x.ai/rewind/execute", {
        sessionId,
        targetPromptIndex: promptIndex,
        force: true,
        mode,
      });

      const body =
        res && typeof res === "object" && "result" in res && res.result
          ? res.result
          : res;
      if (body && body.success === false) {
        this.pushSystem(
          body.error?.trim()
            ? `Edit failed: ${body.error}`
            : "Edit failed: rewind was not successful.",
        );
        this.post({ type: "restoreEditComposer", id: messageId, text });
        return;
      }

      // Truncate UI from the edited user bubble (TUI remove_from anchor).
      this.messages = truncateFromMessageId(
        this.messages,
        messageId,
      ) as UiMessage[];
      this.currentUserId = undefined;
      this.currentAssistantId = undefined;
      this.thoughtStartedAt = undefined;
      this.mdCache.clear();
      this.scheduleMessagesPost(true);

      // Resubmit edited text as a new prompt (literal — not slash re-dispatch).
      await this.handleSend(text, { literal: true });
    } catch (err) {
      this.pushSystem(errMessage(err));
      this.post({ type: "restoreEditComposer", id: messageId, text });
    }
  }

  private async handleNewSession(): Promise<void> {
    try {
      if (this.agent.isBusy()) {
        await this.agent.cancelTurn();
      }
      await this.agent.newSession();
      this.messages = [];
      this.currentAssistantId = undefined;
      this.thoughtStartedAt = undefined;
      this.mdCache.clear();
      this.sessionUsage = {};
      this.endTurnStatusClock();
      this.diffs?.clear();
      this.pushSystem("New session");
      this.scheduleMessagesPost(true);
      this.postTurnStatus();
    } catch (err) {
      this.pushSystem(errMessage(err));
    }
  }

  private handleSessionUpdate(n: SessionNotification): void {
    const update = n.update;
    const showThoughts = getSettings().showThoughts;
    const kind = update.sessionUpdate;

    // Grok shell stamps `_meta.totalTokens` on (almost) every session/update —
    // same source as TUI turn_status `⇣Nk` / context bar. Apply before any
    // early-return so tokens stay live while streaming.
    const notifMeta = parseSessionNotificationMeta(n);
    let statusDirty = false;
    if (notifMeta.totalTokens != null) {
      const next = notifMeta.totalTokens;
      const prev = this.sessionUsage.used;
      const allow =
        this.loadingHistory || notifMeta.isReplay
          ? true // replay: chronological last-wins
          : prev == null || next >= prev; // live: monotonic
      if (allow && next !== prev) {
        this.sessionUsage = { ...this.sessionUsage, used: next };
        statusDirty = true;
      }
    }

    // Optional ACP standard usage_update (cost + window size when present).
    if (kind === "usage_update") {
      this.sessionUsage = {
        ...this.sessionUsage,
        used: update.used,
        size: update.size,
        costAmount: update.cost?.amount ?? this.sessionUsage.costAmount,
        currency: update.cost?.currency ?? this.sessionUsage.currency,
      };
      this.postTurnStatus();
      return;
    }

    // Live process label for turn-status (TUI turn_status activity).
    if (!this.loadingHistory) {
      const toolTitle =
        kind === "tool_call" || kind === "tool_call_update"
          ? (update.title ?? this.findToolCard(update.toolCallId)?.title)
          : undefined;
      const label = processLabelForSessionUpdate(
        kind,
        toolTitle ?? undefined,
      );
      if (label && label !== this.turnProcess) {
        this.turnProcess = label;
        statusDirty = true;
      }
    }

    // Token/process changes: push immediately; elapsed still ticks via interval.
    if (statusDirty) {
      this.postTurnStatus();
    }

    // History replay only: live turns already pushed the user bubble in
    // handleSend. Applying agent user_message_chunk again duplicates the
    // question and clears currentAssistantId, leaving a leftover empty assistant.
    if (kind === "user_message_chunk") {
      const text =
        update.content.type === "text" ? update.content.text : "";
      const next = applyUserMessageChunk(
        {
          messages: this.messages,
          currentUserId: this.currentUserId,
          currentAssistantId: this.currentAssistantId,
          loadingHistory: this.loadingHistory,
        },
        text,
        uid,
      );
      if (!next) {
        return;
      }
      this.messages = next.messages as UiMessage[];
      this.currentUserId = next.currentUserId;
      this.currentAssistantId = next.currentAssistantId;
      this.scheduleMessagesPost();
      return;
    }

    // End of a turn (seen on session/load replay; may be extension-specific)
    if ((kind as string) === "turn_completed") {
      this.finishThoughtPhase();
      this.currentUserId = undefined;
      this.currentAssistantId = undefined;
      this.scheduleMessagesPost();
      return;
    }

    if (
      kind !== "agent_message_chunk" &&
      kind !== "agent_thought_chunk" &&
      kind !== "tool_call" &&
      kind !== "tool_call_update"
    ) {
      return;
    }

    if (kind === "agent_message_chunk") {
      // Leaving thinking → responding: freeze "Thought for Xs" like TUI.
      this.finishThoughtPhase();
      const text =
        update.content.type === "text" ? update.content.text : "";
      const next = applyAgentMessageChunk(
        {
          messages: this.messages,
          currentUserId: this.currentUserId,
          currentAssistantId: this.currentAssistantId,
          loadingHistory: this.loadingHistory,
        },
        text,
        uid,
      );
      this.messages = next.messages as UiMessage[];
      this.currentUserId = next.currentUserId;
      this.currentAssistantId = next.currentAssistantId;
      this.scheduleMessagesPost();
      return;
    }

    // Thought / tool updates still need an open assistant bubble.
    if (kind === "tool_call" || kind === "tool_call_update") {
      // Tool activity ends the thinking stream (TUI collapses thinking block).
      this.finishThoughtPhase();
      const paths =
        update.locations?.map((l) => l.path).filter(Boolean) ?? [];
      // Capture input/output so expanding a tool row shows results (TUI fold).
      const input = formatToolValue(
        (update as { rawInput?: unknown }).rawInput,
      );
      const contentText = extractToolContentText(
        (update as { content?: unknown }).content,
      );
      const rawOut = formatToolValue(
        (update as { rawOutput?: unknown }).rawOutput,
      );
      const output = contentText || rawOut || undefined;
      const next = applyToolEvent(
        {
          messages: this.messages,
          currentUserId: this.currentUserId,
          currentAssistantId: this.currentAssistantId,
          loadingHistory: this.loadingHistory,
        },
        {
          id: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? undefined,
          kind: update.kind ?? undefined,
          paths,
          input: input ?? undefined,
          output,
        },
        uid,
      );
      this.messages = next.messages as UiMessage[];
      this.currentUserId = next.currentUserId;
      this.currentAssistantId = next.currentAssistantId;

      if (!this.loadingHistory) {
        const title =
          update.title ??
          (kind === "tool_call_update"
            ? (this.findToolCard(update.toolCallId)?.title ?? "")
            : "");
        void this.maybeSnapshotToolPaths(
          update.toolCallId,
          title,
          update.kind ?? this.findToolCard(update.toolCallId)?.kind,
          paths,
        );
      }
      this.scheduleMessagesPost();
      return;
    }

    // agent_thought_chunk — timeline Thought item (TUI ThinkingBlock order)
    if (!showThoughts || update.content.type !== "text") {
      return;
    }
    const thoughtText = update.content.text;
    const wasRunning =
      !!this.currentAssistantId &&
      (() => {
        const m = this.messages.find(
          (x) => x.type === "assistant" && x.id === this.currentAssistantId,
        );
        return !!m && m.type === "assistant" && assistantHasRunningThought(m);
      })();
    const next = applyAgentThoughtChunk(
      {
        messages: this.messages,
        currentUserId: this.currentUserId,
        currentAssistantId: this.currentAssistantId,
        loadingHistory: this.loadingHistory,
      },
      thoughtText,
      uid,
      // Keep segment open so consecutive chunks merge; tool/text/finish closes it.
      { running: true },
    );
    this.messages = next.messages as UiMessage[];
    this.currentUserId = next.currentUserId;
    this.currentAssistantId = next.currentAssistantId;
    // Live only: arm wall-clock for "Thought for Xs" (history has no timer).
    if (!this.loadingHistory && !wasRunning) {
      this.thoughtStartedAt = Date.now();
    }
    this.scheduleMessagesPost();
  }

  private findToolCard(toolCallId: string): ToolCard | undefined {
    for (const m of this.messages) {
      if (m.type !== "assistant") {
        continue;
      }
      for (const item of m.items) {
        if (item.kind === "tool" && item.tool.id === toolCallId) {
          return item.tool;
        }
      }
    }
    return undefined;
  }

  private async maybeSnapshotToolPaths(
    toolCallId: string,
    title: string,
    kind: string | undefined,
    paths: string[],
  ): Promise<void> {
    if (!this.diffs || paths.length === 0) {
      return;
    }
    const s = `${kind ?? ""} ${title}`.toLowerCase();
    const isEdit = /edit|write|patch|replace|create.?file|search_replace|apply/.test(
      s,
    );
    if (!isEdit) {
      return;
    }
    for (const p of paths) {
      await this.diffs.captureIfMissing(p, async () => {
        const { content } = await readTextFileHost(p);
        return content;
      });
      this.diffs.recordEdit({ path: p, toolCallId, title });
    }
  }

  private pushSystem(text: string): void {
    this.messages.push({ type: "system", id: uid(), text });
    this.scheduleMessagesPost(true);
  }

  private cachedMarkdown(cacheId: string, source: string): string {
    const key = source || "";
    const hit = this.mdCache.get(cacheId);
    if (hit && hit.key === key) {
      return hit.html;
    }
    const html = renderMarkdownToSafeHtml(key);
    this.mdCache.set(cacheId, { key, html });
    return html;
  }

  private serializeMessages(messages: UiMessage[]): SerializedMessage[] {
    const liveIds = new Set(messages.map((m) => m.id));
    for (const id of this.mdCache.keys()) {
      // cacheId is message id, `${id}:thought`, or `${id}:tN`
      const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
      if (!liveIds.has(base)) {
        this.mdCache.delete(id);
      }
    }

    return messages.map((m) => {
      if (m.type === "assistant") {
        const items: SerializedTimelineItem[] = m.items.map((item, i) => {
          if (item.kind === "text") {
            return {
              kind: "text",
              text: item.text,
              html: this.cachedMarkdown(`${m.id}:t${i}`, item.text || ""),
            };
          }
          if (item.kind === "thought") {
            const t = item.thought;
            return {
              kind: "thought",
              thought: {
                ...t,
                html: t.text
                  ? this.cachedMarkdown(`${m.id}:thought:${t.id}`, t.text)
                  : "",
                label: formatThoughtHeader({
                  running: !!t.running,
                  elapsedMs: t.elapsedMs,
                }),
              },
            };
          }
          return { kind: "tool", tool: item.tool };
        });
        const plain = assistantPlainText(m);
        const hasStructured = items.some(
          (it) => it.kind === "tool" || it.kind === "thought",
        );
        return {
          type: m.type,
          id: m.id,
          text: plain,
          // Legacy single-bubble fields kept empty when timeline has structure;
          // webview prefers `items` when present.
          html: hasStructured
            ? ""
            : this.cachedMarkdown(`${m.id}:t0`, plain || ""),
          items,
        };
      }
      if (m.type === "user") {
        return {
          type: m.type,
          id: m.id,
          text: m.text,
          chips: m.chips,
          promptIndex: m.promptIndex,
        };
      }
      return { type: m.type, id: m.id, text: m.text };
    });
  }

  private scheduleMessagesPost(immediate = false): void {
    if (immediate) {
      if (this.messagesFlushTimer) {
        clearTimeout(this.messagesFlushTimer);
        this.messagesFlushTimer = undefined;
      }
      this.post({
        type: "messages",
        messages: this.serializeMessages(this.messages),
      });
      return;
    }
    if (this.messagesFlushTimer) {
      return;
    }
    this.messagesFlushTimer = setTimeout(() => {
      this.messagesFlushTimer = undefined;
      this.post({
        type: "messages",
        messages: this.serializeMessages(this.messages),
      });
    }, 50);
  }

  private postSticky(): void {
    this.post({
      type: "stickyChips",
      chips: this.stickyChips.map((c) => ({ id: c.id, label: c.label })),
    });
    this.postAutoContext();
  }

  private serializeAutoChip(chip: ContextChip | null): {
    id: string;
    label: string;
    kind: ContextChip["kind"];
    fsPath: string;
  } | null {
    if (!chip) {
      return null;
    }
    return {
      id: chip.id,
      label: chip.label,
      kind: chip.kind,
      fsPath: chip.fsPath,
    };
  }

  private postAutoContext(): void {
    const settings = getSettings();
    // Preview chip always reflects focused editor (even when auto-attach is off)
    // so the sticky row keeps a stable layout when toggling.
    this.post({
      type: "autoContext",
      enabled: isAutoAttachEnabled(settings),
      chip: this.serializeAutoChip(getActiveEditorChip(settings)),
    });
  }

  /**
   * Start the agent (when auth exists) so session/new + models catalog load
   * without requiring a later server action. Safe to call repeatedly.
   */
  private async ensureModelsLoaded(): Promise<void> {
    const catalog = this.agent.getModels();
    if (
      this.agent.getState().kind === "ready" &&
      catalog.models.length > 0
    ) {
      await this.pushFullState();
      return;
    }
    try {
      const hasAuth = await this.auth.hasAnyAuth();
      if (!hasAuth) {
        await this.pushFullState();
        return;
      }
      await this.agent.ensureStarted();
    } catch (err) {
      logError("Auto-start agent for model catalog failed", err);
    }
    await this.pushFullState();
  }

  private async pushFullState(): Promise<void> {
    const authStatus = await this.auth.getStatus();
    const hasAuth = authStatus.hasAny;
    void vscode.commands.executeCommand("setContext", "grok.signedIn", hasAuth);
    const probe = await probeGrokBinary();
    const install = getCliInstallInfo();
    void vscode.commands.executeCommand(
      "setContext",
      "grok.cliFound",
      probe.found,
    );
    const state = this.agent.getState();
    const settings = getSettings();
    const busy = this.agent.isBusy();
    const elapsedMs =
      busy && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    const catalog = this.agent.getModels();
    // Only use bundled fallback for the button label when the agent has not
    // produced a catalog yet — never pretend it is the full TUI list.
    const models: GrokModelOption[] =
      catalog.models.length > 0
        ? catalog.models
        : fallbackModels().map((m) => ({
            ...m,
            selected: m.id === (catalog.currentModelId || settings.model),
          }));
    const currentModelId =
      catalog.currentModelId || settings.model || models[0]?.id || "";
    const modelCw = contextWindowFromCatalog(models, currentModelId);
    const turnStatus = buildTurnStatusParts(
      {
        busy,
        process: this.turnProcess,
        elapsedMs,
        usage: this.sessionUsage,
      },
      modelCw,
    );
    const currentLabel =
      catalog.currentLabel ||
      modelDisplayLabel(models, currentModelId) ||
      currentModelId ||
      "model";
    const efforts: GrokEffortOption[] = catalog.efforts;
    const currentEffortId = catalog.currentEffortId;
    const currentEffortLabel =
      catalog.currentEffortLabel ||
      effortDisplayLabel(efforts, currentEffortId);
    const modeState = this.agent.getModeState();
    this.post({
      type: "init",
      messages: this.serializeMessages(this.messages),
      busy,
      hasAuth,
      authSummary: authStatus.summary,
      cliFound: probe.found,
      cliPath: probe.found ? probe.path : "",
      installCommand: install.command,
      installDocsUrl: install.docsUrl,
      installTypicalPath: install.typicalPath,
      agentState: state.kind,
      agentDetail:
        state.kind === "ready"
          ? "ready"
          : state.kind === "error"
            ? state.message
            : "",
      model: currentModelId || settings.model || "default",
      models,
      currentModelId,
      currentLabel,
      efforts,
      currentEffortId,
      currentEffortLabel,
      mode: modeState.mode,
      modeLabel: modeButtonLabel(modeState.mode),
      modeCss: modeCssClass(modeState.mode),
      modeTitle: `Mode: ${modeLabel(modeState.mode)} — ${modeDescription(modeState.mode)} (Shift+Tab)`,
      stickyChips: this.stickyChips.map((c) => ({
        id: c.id,
        label: c.label,
      })),
      autoAttachEnabled: isAutoAttachEnabled(settings),
      autoChip: this.serializeAutoChip(getActiveEditorChip(settings)),
      reviewCount: this.diffs?.getEntries().length ?? 0,
      turnStatus,
      context: turnStatus.context,
    });
  }

  private postModeState(mode: CycleModeId): void {
    this.post({
      type: "mode",
      mode,
      modeLabel: modeButtonLabel(mode),
      modeCss: modeCssClass(mode),
      modeTitle: `Mode: ${modeLabel(mode)} — ${modeDescription(mode)} (Shift+Tab)`,
    });
  }

  private post(payload: unknown): void {
    if (this.views.size === 0) {
      void this.view?.webview.postMessage(payload);
      return;
    }
    for (const v of this.views.values()) {
      void v.webview.postMessage(payload);
    }
  }

  private async showStartError(err: unknown): Promise<void> {
    logError("Chat start/send failed", err);
    if (await handleMissingCliError(err)) {
      await this.pushFullState();
      return;
    }
    void vscode.window.showErrorMessage(`Grok Build: ${errMessage(err)}`);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tablerCss = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "tabler",
        "tabler-icons.min.css",
      ),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Grok Build</title>
<link rel="stylesheet" href="${tablerCss}" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--border));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground, var(--btn-bg));
    --btn-sec: var(--vscode-button-secondaryBackground);
    --btn-sec-fg: var(--vscode-button-secondaryForeground);
    --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, var(--btn-sec));
    --bubble-user: var(--vscode-button-background);
    --bubble-user-fg: var(--vscode-button-foreground);
    --bubble-asst: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,0.15));
    --link: var(--vscode-textLink-foreground);
    --error: var(--vscode-errorForeground);
    --focus: var(--vscode-focusBorder, var(--link));
    --list-hover: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12));
    --font: var(--vscode-font-family);
    --font-size: var(--vscode-font-size, 13px);
    --code-bg: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
    --radius-xs: 8px;
    --radius-sm: 10px;
    --radius-md: 14px;
    --radius-lg: 18px;
    --radius-pill: 999px;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --shadow-soft: 0 1px 2px rgba(0,0,0,0.06);
    --ease: 140ms ease;
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font-family: var(--font); font-size: var(--font-size);
    -webkit-font-smoothing: antialiased;
  }
  .ti { font-size: 1.05em; vertical-align: -0.1em; line-height: 1; }
  .ti-spin { display: inline-block; animation: ti-spin 1s linear infinite; }
  @keyframes ti-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .ti-spin { animation: none; }
    button, .chip, .tool, #composer, header button.linkish {
      transition: none !important;
    }
  }
  #app { display: flex; flex-direction: column; height: 100%; }

  /* ── Header ── */
  header {
    display: flex; align-items: center; gap: var(--space-2);
    padding: 10px 12px;
    flex-shrink: 0; flex-wrap: wrap;
  }
  header .brand {
    display: flex; align-items: center; gap: 8px;
    font-weight: 600; flex: 1; min-width: 0;
  }
  header .brand .brand-mark {
    width: 26px; height: 26px; border-radius: var(--radius-sm);
    display: inline-flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--btn-bg) 18%, transparent);
    color: var(--btn-bg); flex-shrink: 0;
  }
  header .brand .brand-mark svg,
  #empty .hero-icon svg {
    width: 16px; height: 16px; display: block;
  }
  #empty .hero-icon svg {
    width: 28px; height: 28px;
  }
  header .brand .title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    letter-spacing: -0.01em;
  }
  header .header-right {
    display: flex; align-items: center; gap: 6px;
    margin-left: auto; flex-shrink: 0;
  }
  /* TUI status-bar style: tokens / context window, top-right */
  #ctx-bar {
    font-size: 11px; font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    padding: 4px 10px; border-radius: var(--radius-pill);
    color: var(--fg);
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    white-space: nowrap;
    user-select: none;
    max-width: 12em;
    overflow: hidden; text-overflow: ellipsis;
  }
  #ctx-bar[hidden] { display: none !important; }
  #ctx-bar.level-ok {
    color: var(--fg);
  }
  #ctx-bar.level-warn {
    color: var(--vscode-editorWarning-foreground, #d29922);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 14%, transparent);
  }
  #ctx-bar.level-critical {
    color: var(--vscode-errorForeground, #f85149);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 14%, transparent);
  }
  header .meta {
    color: var(--muted); font-size: 11px;
    display: flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    max-width: 100%;
  }
  header .meta span {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  header button.linkish {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
    padding: 5px 10px; font-size: 11px; font-weight: 500;
    border: none; border-radius: var(--radius-pill);
    transition: background var(--ease), color var(--ease);
  }
  header button.linkish:hover {
    background: var(--list-hover); color: var(--fg);
  }
  header button.linkish:focus-visible {
    outline: 1px solid var(--focus); outline-offset: 1px;
  }

  /* ── Review bar ── */
  #review-bar {
    display: none; padding: 8px 12px;
    font-size: 12px; align-items: center; gap: 8px; flex-shrink: 0;
    background: color-mix(in srgb, var(--btn-bg) 8%, transparent);
  }
  #review-bar.visible { display: flex; }
  #review-bar #btn-review {
    margin-left: auto; padding: 4px 12px; font-size: 11px; min-height: 26px;
  }

  /* ── Messages ── */
  #messages {
    flex: 1; overflow-y: auto; padding: 14px 12px;
    display: flex; flex-direction: column; gap: 12px;
    /* No CSS smooth scroll — continuous stream updates fight it (jank). */
    scroll-behavior: auto;
  }
  .msg { max-width: 100%; }
  /* Enter animation only for newly inserted messages (not stream patches / re-mounts). */
  .msg.msg-enter {
    animation: msg-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes msg-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  /* Timeline tool/thought enter: light opacity only (no stream text anim). */
  .assistant-timeline > .tool-row,
  .assistant-timeline > .tool-group,
  .assistant-timeline > .thought {
    animation: stream-block-in 160ms ease both;
  }
  @keyframes stream-block-in {
    from { opacity: 0.4; }
    to { opacity: 1; }
  }
  .assistant-timeline.stream-settled > .tool-row,
  .assistant-timeline.stream-settled > .tool-group,
  .assistant-timeline.stream-settled > .thought {
    animation: none;
  }
  .assistant-timeline.stream-settled > .tl-new {
    animation: stream-block-in 160ms ease both;
  }
  @media (prefers-reduced-motion: reduce) {
    .msg.msg-enter,
    .assistant-timeline > .tool-row,
    .assistant-timeline > .tool-group,
    .assistant-timeline > .thought,
    .assistant-timeline.stream-settled > .tl-new {
      animation: none;
    }
  }
  .msg.user { align-self: flex-end; max-width: 92%; }
  .msg.assistant, .msg.system { align-self: stretch; }
  .msg { position: relative; }
  .msg-actions {
    display: flex; gap: 2px; align-items: center;
    opacity: 0; pointer-events: none;
    transition: opacity var(--ease);
    margin-top: 2px;
  }
  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions,
  .msg.editing .msg-actions {
    opacity: 1; pointer-events: auto;
  }
  .msg.user.editing .bubble {
    outline: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 55%, transparent);
    outline-offset: 1px;
  }
  .msg.user .msg-actions { justify-content: flex-end; }
  .msg.assistant .msg-actions { justify-content: flex-start; }
  .msg-actions button {
    display: inline-flex; align-items: center; justify-content: center;
    border: none; background: transparent; color: var(--muted);
    font-size: 11px; padding: 4px 6px; border-radius: var(--radius-xs);
    cursor: pointer; line-height: 1;
    min-width: 24px; min-height: 24px;
  }
  .msg-actions button.msg-act-icon {
    width: 26px; height: 26px; padding: 0;
    font-size: 14px;
  }
  .msg-actions button.msg-act-icon .ti {
    font-size: 14px; line-height: 1;
  }
  .msg-actions button:hover {
    color: var(--fg);
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  .msg-actions button.copied {
    color: var(--vscode-testing-iconPassed, #3fb950);
  }
  .bubble {
    padding: 10px 14px; border-radius: var(--radius-md);
    word-break: break-word; line-height: 1.5; border: none;
  }
  .msg.user .bubble {
    background: var(--bubble-user); color: var(--bubble-user-fg);
    white-space: pre-wrap;
    border-radius: var(--radius-md) var(--radius-md) var(--radius-xs) var(--radius-md);
    box-shadow: var(--shadow-soft);
  }
  .msg.assistant .bubble {
    background: var(--bubble-asst);
    border-radius: var(--radius-md) var(--radius-md) var(--radius-md) var(--radius-xs);
  }
  .msg.assistant .bubble.md p { margin: 0 0 0.65em; }
  .msg.assistant .bubble.md p:last-child { margin-bottom: 0; }
  .msg.assistant .bubble.md pre {
    position: relative; background: var(--code-bg); padding: 12px 14px;
    border-radius: var(--radius-sm); overflow: auto; margin: 0.55em 0;
    border: none;
  }
  .msg.assistant .bubble.md code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }
  .msg.assistant .bubble.md :not(pre) > code {
    background: var(--code-bg); padding: 0.15em 0.45em; border-radius: 6px;
  }
  .msg.assistant .bubble.md table {
    border-collapse: separate; border-spacing: 0;
    width: 100%; margin: 0.55em 0; font-size: 0.92em;
    border: none; border-radius: var(--radius-sm); overflow: hidden;
    background: color-mix(in srgb, var(--muted) 6%, transparent);
  }
  .msg.assistant .bubble.md th,
  .msg.assistant .bubble.md td {
    border: none; padding: 6px 10px;
  }
  .msg.assistant .bubble.md th {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    text-align: left;
  }
  .copy-code {
    position: absolute; top: 8px; right: 8px;
    background: var(--btn-sec); color: var(--btn-sec-fg);
    border: none; border-radius: var(--radius-xs); padding: 3px 8px;
    font-size: 10px; font-weight: 500; cursor: pointer;
    opacity: 0.85; transition: opacity var(--ease), background var(--ease);
  }
  .copy-code:hover { opacity: 1; background: var(--btn-sec-hover); }
  .msg.system .bubble {
    color: var(--muted); font-size: 12px; padding: 8px 0; background: transparent;
    display: flex; align-items: center; gap: 10px; width: 100%;
    border: none; border-radius: 0; box-shadow: none;
  }
  .msg.system .system-sep-line {
    flex: 1 1 0; min-width: 12px; height: 1px;
    background: color-mix(in srgb, var(--muted) 22%, transparent);
  }
  .msg.system .system-sep-text {
    flex: 0 1 auto; max-width: 85%;
    text-align: center; line-height: 1.35; white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── Chips ── */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .msg.user .chips { justify-content: flex-end; }
  .chip {
    font-size: 11px; padding: 3px 6px 3px 9px; border-radius: var(--radius-pill);
    border: 1px solid transparent;
    box-sizing: border-box;
    color: var(--muted);
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    display: inline-flex; align-items: center; gap: 4px;
    max-width: 100%; line-height: 1.25; min-height: 24px;
    transition: background var(--ease), color var(--ease), border-color var(--ease), opacity var(--ease);
  }
  .chip:hover {
    color: var(--fg);
    background: var(--list-hover);
  }
  .chip .chip-badge {
    color: var(--btn-bg);
    flex-shrink: 0;
    width: 14px; height: 14px;
    display: inline-flex; align-items: center; justify-content: center;
    opacity: 0.95;
  }
  .chip .chip-badge .ti { font-size: 13px; line-height: 1; }
  .chip .chip-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  /* Auto-attach chip: same structure on/off so toggle does not jump */
  .chip.chip-auto {
    color: var(--fg);
    background: color-mix(in srgb, var(--btn-bg) 14%, transparent);
    border-color: color-mix(in srgb, var(--btn-bg) 28%, transparent);
  }
  .chip.chip-auto.chip-auto-off {
    color: var(--muted);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    border-color: color-mix(in srgb, var(--fg) 16%, transparent);
    border-style: solid;
    opacity: 0.78;
  }
  .chip.chip-auto.chip-auto-off .chip-badge { color: var(--muted); opacity: 0.8; }
  .chip.chip-auto.chip-auto-off:hover {
    color: var(--fg);
    opacity: 1;
    border-color: color-mix(in srgb, var(--btn-bg) 35%, transparent);
    background: color-mix(in srgb, var(--btn-bg) 10%, transparent);
  }
  /* Override global button min-height/padding so close stays a circle */
  .chip button {
    background: transparent; border: none; color: inherit;
    cursor: pointer; padding: 0 !important;
    width: 16px; height: 16px; min-width: 16px; min-height: 0 !important;
    max-width: 16px; max-height: 16px;
    border-radius: 50%; font-size: 12px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0; box-shadow: none; transform: none;
    opacity: 0.7; transition: opacity var(--ease), background var(--ease);
  }
  .chip button:hover {
    opacity: 1; background: color-mix(in srgb, var(--fg) 12%, transparent);
  }
  .chip button:active:not(:disabled) { transform: none; }

  /* ── Thoughts (TUI ThinkingBlock) — no fill; muted text only ── */
  .thought {
    margin-bottom: 8px; font-size: 12px; color: var(--muted);
    border: none; border-radius: 0; padding: 0;
    background: transparent;
  }
  .thought.thought-running {
    background: transparent;
  }
  .thought summary {
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; list-style: none;
    font-weight: 600;
    color: var(--muted);
  }
  .thought.thought-running summary {
    color: var(--fg);
  }
  .thought summary .thought-label { min-width: 0; }
  .thought summary::-webkit-details-marker { display: none; }
  .thought .thought-body {
    margin: 6px 0 0; max-height: 160px; overflow: auto; opacity: 0.88;
    padding-top: 0; border: none;
    font-weight: 400; color: var(--muted);
    background: transparent;
  }
  .thought .thought-body.md p { margin: 0 0 0.5em; }
  .thought .thought-body.md p:last-child { margin-bottom: 0; }
  /* Assistant timeline: text bubbles + tool rows in stream order */
  .assistant-timeline {
    display: flex; flex-direction: column; gap: 6px;
  }
  /* Single-line tool row — no chevron; click row to show detail (TUI fold) */
  .tool-row {
    margin: 0;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .tool-row > summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    padding: 2px 0;
    min-height: 20px;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
  }
  .tool-row > summary::-webkit-details-marker { display: none; }
  .tool-row .tool-ico {
    flex-shrink: 0;
    opacity: 0.75;
    display: inline-flex;
  }
  .tool-row .tool-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .tool-row .tool-status {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    opacity: 0.8;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .tool-row .tool-detail {
    padding: 2px 0 4px 20px;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tool-row .tool-detail .paths {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
  }
  .tool-row .tool-detail a,
  .tool-row .tool-detail button.link {
    color: var(--link); cursor: pointer; text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px;
    background: none; border: none; padding: 0;
    font: inherit;
  }
  .tool-row .tool-detail a:hover,
  .tool-row .tool-detail button.link:hover { text-decoration: underline; }
  .tool-row .tool-meta {
    opacity: 0.75;
  }
  /* Tool expand body — TUI-style truncated output */
  .tool-row .tool-io {
    margin: 0;
    padding: 6px 8px;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.4;
    color: var(--fg);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    border-radius: 4px;
  }
  /* Verb-group header: "Read 2 files, Edited 4 files" (TUI fold) */
  .tool-group {
    margin: 0;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .tool-group > summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    padding: 2px 0;
    min-height: 20px;
    line-height: 1.35;
  }
  .tool-group > summary::-webkit-details-marker { display: none; }
  .tool-group .tool-group-label {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    color: var(--fg);
    opacity: 0.88;
  }
  .tool-group.running .tool-group-label {
    color: var(--vscode-charts-blue, var(--link));
  }
  .tool-group.failed .tool-group-label {
    color: var(--vscode-errorForeground, #f14c4c);
  }
  .tool-group-members {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 0 4px 14px;
    border-left: 1px solid color-mix(in srgb, var(--muted) 28%, transparent);
    margin-left: 6px;
  }
  .tool-group-members .tool-row {
    font-size: 11.5px;
  }
  .tool-row .tool-io-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.7;
    margin-top: 2px;
  }
  /* Thoughts inside the assistant timeline (not only at the top) */
  .assistant-timeline > .thought {
    margin-bottom: 2px;
  }

  /* ── Empty state ── */
  #empty {
    margin: auto; text-align: center; color: var(--muted); padding: 28px 18px;
    max-width: 320px; line-height: 1.55;
  }
  #empty .hero-icon {
    width: 52px; height: 52px; margin: 0 auto 12px;
    border-radius: var(--radius-md);
    display: flex; align-items: center; justify-content: center;
    color: var(--btn-bg);
    background: color-mix(in srgb, var(--btn-bg) 14%, transparent);
  }
  #empty.cli-missing .hero-icon {
    color: var(--vscode-errorForeground, #f14c4c);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 14%, transparent);
  }
  #empty h2 {
    color: var(--fg); font-size: 15px; font-weight: 600;
    margin: 0 0 8px; letter-spacing: -0.01em;
  }
  #empty p { margin: 0 0 6px; }
  #empty .empty-actions {
    display: flex; flex-direction: column; gap: 8px; margin-top: 16px;
  }
  #empty .empty-actions button {
    width: 100%; justify-content: center; min-height: 36px;
    border-radius: var(--radius-pill); /* match Send / Mode pills */
  }
  #empty .install-cmd {
    margin-top: 12px;
    text-align: left;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.4;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--input-bg);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    color: var(--fg);
    word-break: break-all;
    user-select: all;
    cursor: pointer;
  }
  #empty .install-note {
    margin-top: 8px;
    font-size: 11px;
    opacity: 0.85;
  }
  #empty-ready[hidden], #empty-cli-missing[hidden] { display: none !important; }

  /* ── Footer / composer ── */
  footer {
    padding: 10px 12px 12px; flex-shrink: 0;
    display: flex; flex-direction: column; gap: 8px;
    background: color-mix(in srgb, var(--bg) 92%, var(--input-bg));
  }
  #sticky {
    display: flex; flex-wrap: wrap; gap: 6px; min-height: 0;
  }
  .composer-wrap {
    position: relative;
    display: flex; flex-direction: column;
  }
  /* @ mention + / slash + model/effort + permission/question + rewind popovers */
  #mention-popover, #slash-popover, #model-popover, #effort-popover,
  #permission-popover, #question-popover, #rewind-popover {
    position: absolute;
    left: 0; right: 0; bottom: calc(100% + 6px);
    z-index: 20;
    max-height: min(280px, 42vh);
    display: flex; flex-direction: column;
    background: var(--input-bg);
    color: var(--fg);
    border-radius: var(--radius-md);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--fg) 12%, transparent),
      0 8px 24px color-mix(in srgb, var(--bg) 55%, #000);
    overflow: hidden;
  }
  #permission-popover, #question-popover {
    z-index: 30;
    max-height: min(420px, 58vh);
  }
  #rewind-popover { z-index: 25; max-height: min(220px, 36vh); }
  #mention-popover[hidden], #slash-popover[hidden], #model-popover[hidden],
  #effort-popover[hidden], #permission-popover[hidden], #question-popover[hidden],
  #rewind-popover[hidden] {
    display: none !important;
  }
  #mention-head, #slash-head, #model-head, #effort-head,
  #permission-head, #question-head, #rewind-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 10px 6px;
    font-size: 11px; color: var(--muted); font-weight: 500;
    border-bottom: 1px solid color-mix(in srgb, var(--fg) 8%, transparent);
    flex-shrink: 0;
  }
  #mention-head .hint, #slash-head .hint, #model-head .hint, #effort-head .hint,
  #permission-head .hint, #question-head .hint, #rewind-head .hint { opacity: 0.85; }
  #mention-list, #slash-list, #model-list, #effort-list,
  #permission-list, #question-list, #rewind-list {
    overflow-y: auto; padding: 4px;
    flex: 1; min-height: 0;
  }
  #edit-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; margin: 0 0 6px;
    font-size: 11px; color: var(--muted);
    background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 12%, transparent);
    border-radius: var(--radius-sm);
  }
  #edit-banner[hidden] { display: none !important; }
  #edit-banner .edit-banner-text { flex: 1; min-width: 0; }
  #edit-banner button {
    min-height: 22px; padding: 2px 8px; font-size: 11px;
  }
  .rewind-item {
    display: flex; flex-direction: column; gap: 2px;
    width: 100%; text-align: left;
    padding: 8px 10px; border: none; border-radius: var(--radius-xs);
    background: transparent; color: var(--fg); cursor: pointer; font: inherit;
  }
  .rewind-item:hover, .rewind-item.active {
    background: var(--list-hover, color-mix(in srgb, var(--fg) 10%, transparent));
  }
  .rewind-item .rewind-label { font-size: 12px; font-weight: 500; }
  .rewind-item .rewind-detail { font-size: 11px; color: var(--muted); }
  #permission-detail, #question-body {
    padding: 8px 10px 4px;
    font-size: 12px;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 7em;
    overflow-y: auto;
    border-bottom: 1px solid color-mix(in srgb, var(--fg) 6%, transparent);
    flex-shrink: 0;
  }
  #permission-detail:empty, #question-body:empty { display: none; }
  .permission-item.kind-reject_once .mi-icon,
  .permission-item.kind-reject_always .mi-icon {
    color: #f48771;
    background: color-mix(in srgb, #f48771 16%, transparent);
  }
  .permission-item.kind-allow_once .mi-icon,
  .permission-item.kind-allow_always .mi-icon {
    color: #89d185;
    background: color-mix(in srgb, #89d185 18%, transparent);
  }
  .permission-item.active.kind-reject_once .mi-icon,
  .permission-item.active.kind-reject_always .mi-icon {
    color: #1a1a1a;
    background: #f48771;
  }
  .permission-item.active.kind-allow_once .mi-icon,
  .permission-item.active.kind-allow_always .mi-icon {
    color: #1a1a1a;
    background: #89d185;
  }
  #question-tabs {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding: 6px 8px 0; flex-shrink: 0;
  }
  #question-tabs:empty { display: none; }
  .q-tab {
    border: none; background: transparent; color: var(--muted);
    font: inherit; font-size: 11px; padding: 4px 8px; border-radius: 999px;
    cursor: pointer;
  }
  .q-tab.active {
    background: color-mix(in srgb, var(--btn-bg) 28%, transparent);
    color: var(--fg); font-weight: 600;
  }
  .question-item.selected {
    outline: 1px solid color-mix(in srgb, #89d185 55%, transparent);
    background: color-mix(in srgb, #89d185 10%, transparent);
  }
  .question-item .mi-check {
    width: 18px; flex-shrink: 0; opacity: 0;
    display: inline-flex; align-items: center; justify-content: center;
    color: #89d185;
    font-size: 1.05em;
    font-weight: 700;
    text-shadow: 0 0 8px color-mix(in srgb, #89d185 45%, transparent);
  }
  .question-item.selected .mi-check { opacity: 1; }
  .question-item.active.selected .mi-check,
  .question-item:hover.selected .mi-check {
    color: #b5f0b0;
  }
  #question-notes {
    margin: 4px 8px 0; width: calc(100% - 16px);
    box-sizing: border-box;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
    background: var(--bg); color: var(--fg);
    font: inherit; font-size: 12px; padding: 6px 8px;
    resize: vertical; min-height: 36px; max-height: 80px;
  }
  #question-notes[hidden] { display: none !important; }
  #permission-foot, #question-foot {
    display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
    padding: 6px 8px 8px;
    border-top: 1px solid color-mix(in srgb, var(--fg) 8%, transparent);
    flex-shrink: 0;
  }
  #permission-foot button, #question-foot button {
    font-size: 11px; padding: 5px 10px;
  }
  .mention-item, .slash-item, .model-item, .effort-item,
  .permission-item, .question-item {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 7px 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--fg);
    font: inherit; font-size: 12px; cursor: pointer;
    min-height: 32px;
  }
  .mention-item:hover, .slash-item:hover, .model-item:hover, .effort-item:hover,
  .permission-item:hover, .question-item:hover {
    background: var(--list-hover);
  }
  .mention-item.active, .slash-item.active, .model-item.active, .effort-item.active,
  .permission-item.active, .question-item.active {
    background: color-mix(in srgb, var(--btn-bg) 28%, transparent);
  }
  .mention-item .mi-icon, .slash-item .mi-icon, .model-item .mi-icon, .effort-item .mi-icon,
  .permission-item .mi-icon, .question-item .mi-icon {
    width: 22px; height: 22px; border-radius: 7px;
    display: inline-flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    color: color-mix(in srgb, var(--fg) 72%, var(--muted));
    flex-shrink: 0;
  }
  .mention-item.active .mi-icon, .slash-item.active .mi-icon, .model-item.active .mi-icon,
  .effort-item.active .mi-icon, .permission-item.active .mi-icon, .question-item.active .mi-icon {
    color: var(--btn-fg);
    background: var(--btn-bg);
  }
  .mention-item:hover:not(.active) .mi-icon,
  .slash-item:hover:not(.active) .mi-icon,
  .model-item:hover:not(.active) .mi-icon,
  .effort-item:hover:not(.active) .mi-icon,
  .permission-item:hover:not(.active) .mi-icon,
  .question-item:hover:not(.active) .mi-icon {
    color: var(--fg);
    background: color-mix(in srgb, var(--fg) 14%, transparent);
  }
  .mention-item .mi-body, .slash-item .mi-body, .model-item .mi-body, .effort-item .mi-body,
  .permission-item .mi-body, .question-item .mi-body {
    min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px;
  }
  .mention-item .mi-label, .slash-item .mi-label, .model-item .mi-label, .effort-item .mi-label,
  .permission-item .mi-label, .question-item .mi-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500;
  }
  .mention-item .mi-desc, .slash-item .mi-desc, .model-item .mi-desc, .effort-item .mi-desc,
  .permission-item .mi-desc, .question-item .mi-desc {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; color: var(--muted);
  }
  .model-item.current .mi-label, .effort-item.current .mi-label { font-weight: 600; }
  #btn-model, #btn-effort {
    /* Cap width; allow shrink so the row never overflows the shell */
    max-width: 140px;
    border-radius: var(--radius-pill);
    padding: 6px 10px;
    min-height: 30px;
    font-weight: 500;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  #btn-effort[hidden] { display: none !important; }
  #btn-model .model-btn-label, #btn-effort .effort-btn-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0; max-width: 90px;
  }
  #mention-empty, #slash-empty, #model-empty, #effort-empty {
    padding: 14px 12px; color: var(--muted); font-size: 12px; text-align: center;
  }
  .slash-item .mi-badge, .model-item .mi-badge {
    font-size: 9px; color: var(--muted); flex-shrink: 0;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  /* Turn status above composer — process · time · tokens · cost (TUI-like) */
  #turn-status {
    display: flex; align-items: center; gap: 8px;
    padding: 0 4px 6px;
    font-size: 11px; color: var(--muted);
    min-height: 18px; line-height: 1.3;
    user-select: none;
  }
  #turn-status[hidden] { display: none !important; }
  #turn-status .ts-left {
    display: inline-flex; align-items: center; gap: 6px;
    min-width: 0; flex: 1;
    overflow: hidden;
  }
  #turn-status .ts-process {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg); font-weight: 500;
  }
  /* Busy: use link/focus accent — not button bg (often too dark as text). */
  #turn-status.busy .ts-process {
    color: var(--link);
    font-weight: 500;
  }
  #turn-status .ts-right {
    display: inline-flex; align-items: center; gap: 8px;
    flex-shrink: 0; font-variant-numeric: tabular-nums;
    opacity: 0.95;
  }
  #turn-status .ts-tokens {
    color: color-mix(in srgb, var(--fg) 82%, var(--muted));
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  #turn-status .ts-sep { opacity: 0.4; }
  #turn-status .ts-cost {
    color: color-mix(in srgb, var(--fg) 70%, var(--muted));
  }
  #turn-status .ts-time {
    color: var(--muted);
  }
  #turn-status .ts-spin {
    display: none; width: 12px; height: 12px; flex-shrink: 0;
    color: var(--link);
    opacity: 0.9;
  }
  #turn-status.busy .ts-spin { display: inline-flex; }
  #turn-status .ts-spin .ti { font-size: 12px; color: inherit; }

  .composer-shell {
    display: flex; flex-direction: column; gap: 10px;
    background: var(--input-bg);
    border: none;
    /* Fixed radius — not pill: 999px turns a tall multi-line shell into an oval */
    border-radius: 20px;
    padding: 12px;
    box-shadow: var(--shadow-soft);
    transition: box-shadow var(--ease), background var(--ease);
    /* Keep buttons/text inside the rounded shell */
    overflow: hidden;
    min-width: 0;
  }
  .composer-shell:focus-within {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 40%, transparent), var(--shadow-soft);
  }
  #composer {
    width: 100%;
    /* ~2 lines at line-height 1.45; keep in sync with autosizeComposer minPx */
    min-height: 44px; max-height: 180px;
    resize: none; overflow-y: hidden;
    background: transparent; color: var(--input-fg);
    border: none; border-radius: 0; outline: none;
    /* shell owns outer inset; light y so first line isn’t flush */
    padding: 2px 0;
    font-family: inherit; font-size: inherit;
    line-height: 1.45;
    field-sizing: content; /* Chromium: grow with content; JS fallback below */
  }
  #composer:focus { outline: none; }
  #composer::placeholder { color: var(--muted); opacity: 0.85; }
  .actions {
    display: flex; gap: 6px; align-items: center;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  /* mode | spacer | model · reasoning · send — stay inside shell, shrink if narrow */
  .actions-right {
    margin-left: auto;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    gap: 6px;
    align-items: center;
    justify-content: flex-end;
    padding: 0;
  }
  .actions-right > button {
    margin: 0;
    flex: 0 1 auto;
    min-width: 0;
  }
  /* Mode cycle — left of action row (Shift+Tab); pill matches #send */
  #btn-mode {
    font-size: 12px;
    padding: 6px 10px;
    min-height: 30px;
    gap: 5px;
    flex-shrink: 0;
    border-radius: var(--radius-pill);
  }
  #btn-mode .mode-btn-label {
    max-width: 11em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #btn-mode.mode-plan {
    color: color-mix(in srgb, var(--focus) 85%, var(--fg));
    background: color-mix(in srgb, var(--focus) 14%, transparent);
  }
  #btn-mode.mode-plan:hover:not(:disabled) {
    background: color-mix(in srgb, var(--focus) 22%, transparent);
  }
  /* TUI accent_system for auto flag */
  #btn-mode.mode-auto {
    color: color-mix(in srgb, #5b9fd4 90%, var(--fg));
    background: color-mix(in srgb, #5b9fd4 14%, transparent);
  }
  #btn-mode.mode-auto:hover:not(:disabled) {
    background: color-mix(in srgb, #5b9fd4 22%, transparent);
  }
  /* always-approve (YOLO) — red for destructive auto-run */
  #btn-mode.mode-always-approve {
    color: color-mix(in srgb, #e05353 92%, var(--fg));
    background: color-mix(in srgb, #e05353 16%, transparent);
  }
  #btn-mode.mode-always-approve:hover:not(:disabled) {
    background: color-mix(in srgb, #e05353 26%, transparent);
  }

  /* ── Buttons ── */
  button {
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 12px; min-height: 32px;
    cursor: pointer;
    background: var(--btn-bg); color: var(--btn-fg);
    font: inherit; font-weight: 500;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background var(--ease), opacity var(--ease),
      transform 80ms ease, box-shadow var(--ease);
  }
  button:hover:not(:disabled) {
    background: var(--btn-hover);
  }
  button:active:not(:disabled) {
    transform: translateY(0.5px);
  }
  button:focus-visible {
    outline: 1px solid var(--focus); outline-offset: 2px;
  }
  button.secondary {
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    color: var(--fg);
  }
  button.secondary:hover:not(:disabled) {
    background: var(--list-hover);
    color: var(--fg);
  }
  button.icon-btn {
    width: 32px; min-width: 32px; padding: 0;
    border-radius: var(--radius-sm);
  }
  button:disabled {
    opacity: 0.45; cursor: not-allowed;
  }
  #send {
    border-radius: var(--radius-pill);
    padding: 6px 12px;
    min-height: 30px;
    min-width: 0;
    flex: 0 0 auto; /* keep primary action full width of its label */
    box-shadow: 0 1px 2px color-mix(in srgb, var(--btn-bg) 35%, transparent);
  }
  #send:hover:not(:disabled) {
    box-shadow: 0 2px 6px color-mix(in srgb, var(--btn-bg) 40%, transparent);
  }
  /* Busy + empty composer → Stop (TUI-like) */
  #send.is-stop {
    background: color-mix(in srgb, #f48771 88%, var(--btn-bg));
    color: #1a1a1a;
    box-shadow: 0 1px 2px color-mix(in srgb, #f48771 40%, transparent);
  }
  #send.is-stop:hover:not(:disabled) {
    background: #f48771;
    box-shadow: 0 2px 6px color-mix(in srgb, #f48771 45%, transparent);
  }
  .vspacer { flex-shrink: 0; width: 100%; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">${GROK_MARK_SVG}</span>
      <span class="title">Grok Build</span>
    </div>
    <div class="header-right">
      <div id="ctx-bar" hidden title="Context window usage" aria-label="Context tokens">—</div>
      <div class="meta" id="meta"><i class="ti ti-circle-dashed"></i><span>idle</span></div>
    </div>
  </header>
  <div id="review-bar">
    <i class="ti ti-file-diff" aria-hidden="true"></i>
    <span id="review-label">Review edits</span>
    <button type="button" class="secondary" id="btn-review">Open</button>
  </div>
  <div id="messages"></div>
  <div id="empty" hidden>
    <div class="hero-icon" aria-hidden="true">${GROK_MARK_SVG}</div>
    <div id="empty-ready">
      <h2>Grok Build - Community</h2>
      <p>Ask about this workspace. Use / for commands, @ for files. The focused file can auto-attach (toggle on the chip).</p>
      <p id="empty-hint"></p>
      <div class="empty-actions">
        <button id="empty-start" type="button"><i class="ti ti-player-play"></i> Start agent</button>
        <button id="empty-auth" class="secondary" type="button" data-action="login" title="Sign in with browser or API key (same as grok login)"><i class="ti ti-login-2"></i> Sign in</button>
      </div>
    </div>
    <div id="empty-cli-missing" hidden>
      <h2>Install Grok Build CLI</h2>
      <p>This extension needs the <code>grok</code> binary. It is not bundled — install the CLI first, then come back.</p>
      <div class="install-cmd" id="empty-install-cmd" title="Click to copy" role="button" tabindex="0"></div>
      <p class="install-note" id="empty-install-path"></p>
      <div class="empty-actions">
        <button id="empty-copy-install" type="button"><i class="ti ti-copy"></i> Copy install command</button>
        <button id="empty-recheck" type="button"><i class="ti ti-refresh"></i> I installed it — check again</button>
        <button id="empty-open-docs" class="secondary" type="button"><i class="ti ti-external-link"></i> Open install docs</button>
        <button id="empty-set-path" class="secondary" type="button"><i class="ti ti-folder"></i> Set binary path…</button>
      </div>
    </div>
  </div>
  <footer>
    <div id="sticky"></div>
    <div class="composer-wrap">
      <div id="edit-banner" hidden>
        <i class="ti ti-pencil" aria-hidden="true"></i>
        <span class="edit-banner-text">Editing message — send to resubmit · Esc cancel</span>
        <button type="button" class="secondary" id="edit-banner-cancel">Cancel</button>
      </div>
      <div id="slash-popover" hidden role="listbox" aria-label="Slash commands">
        <div id="slash-head">
          <span id="slash-title">/ commands</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="slash-list"></div>
        <div id="slash-empty" hidden>No matches</div>
      </div>
      <div id="mention-popover" hidden role="listbox" aria-label="Mention context">
        <div id="mention-head">
          <span id="mention-title">@ context</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="mention-list"></div>
        <div id="mention-empty" hidden>No matches</div>
      </div>
      <div id="model-popover" hidden role="listbox" aria-label="Select model">
        <div id="model-head">
          <span id="model-title">Models</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="model-list"></div>
        <div id="model-empty" hidden>No models from agent</div>
      </div>
      <div id="effort-popover" hidden role="listbox" aria-label="Reasoning effort">
        <div id="effort-head">
          <span id="effort-title">Reasoning</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="effort-list"></div>
        <div id="effort-empty" hidden>Not supported on this model</div>
      </div>
      <div id="rewind-popover" hidden role="listbox" aria-label="Rewind mode">
        <div id="rewind-head">
          <span id="rewind-title">Resubmit — what to rewind?</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="rewind-list"></div>
      </div>
      <div id="permission-popover" hidden role="dialog" aria-label="Permission request" aria-modal="true">
        <div id="permission-head">
          <span id="permission-title">Permission</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="permission-detail"></div>
        <div id="permission-list" role="listbox"></div>
        <div id="permission-foot">
          <button type="button" class="secondary" id="permission-cancel">Deny</button>
        </div>
      </div>
      <div id="question-popover" hidden role="dialog" aria-label="Agent question" aria-modal="true">
        <div id="question-head">
          <span id="question-title">Question</span>
          <span class="hint">↑↓ · Space · Enter · Esc</span>
        </div>
        <div id="question-tabs"></div>
        <div id="question-body"></div>
        <div id="question-list" role="listbox"></div>
        <textarea id="question-notes" hidden rows="2" placeholder="Optional notes…"></textarea>
        <div id="question-foot">
          <button type="button" class="secondary" id="question-cancel">Cancel</button>
          <button type="button" class="secondary" id="question-chat" hidden>Chat about this</button>
          <button type="button" class="secondary" id="question-skip" hidden>Skip interview</button>
          <button type="button" id="question-accept">Accept</button>
        </div>
      </div>
      <div id="turn-status" hidden aria-live="polite">
        <span class="ts-left">
          <span class="ts-spin" aria-hidden="true"><i class="ti ti-loader ti-spin"></i></span>
          <span class="ts-process"></span>
        </span>
        <span class="ts-right">
          <span class="ts-time"></span>
          <span class="ts-tokens"></span>
          <span class="ts-cost"></span>
        </span>
      </div>
      <div class="composer-shell">
        <textarea id="composer" placeholder="Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)" rows="1"></textarea>
        <div class="actions">
          <button id="btn-mode" class="secondary mode-normal" type="button" title="Mode: Normal — Ask before running tools (Shift+Tab)" aria-label="Cycle session mode">
            <i class="ti ti-route-alt-left" aria-hidden="true"></i>
            <span class="mode-btn-label" id="mode-btn-label">Normal</span>
          </button>
          <div class="actions-right">
            <button id="btn-model" class="secondary" type="button" title="Select model (same catalog as TUI)" aria-label="Select model" aria-haspopup="listbox">
              <i class="ti ti-cpu" aria-hidden="true"></i>
              <span class="model-btn-label" id="model-btn-label">model</span>
              <i class="ti ti-chevron-up" aria-hidden="true"></i>
            </button>
            <button id="btn-effort" class="secondary" type="button" hidden title="Reasoning effort" aria-label="Reasoning effort" aria-haspopup="listbox">
              <i class="ti ti-brain" aria-hidden="true"></i>
              <span class="effort-btn-label" id="effort-btn-label">effort</span>
              <i class="ti ti-chevron-up" aria-hidden="true"></i>
            </button>
            <button id="send" type="button" title="Send"><i class="ti ti-send"></i> Send</button>
          </div>
        </div>
      </div>
    </div>
  </footer>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const emptyReady = document.getElementById('empty-ready');
const emptyCliMissing = document.getElementById('empty-cli-missing');
const emptyHint = document.getElementById('empty-hint');
const emptyAuthBtn = document.getElementById('empty-auth');
const emptyInstallCmd = document.getElementById('empty-install-cmd');
const emptyInstallPath = document.getElementById('empty-install-path');
/** Toggle empty-state auth CTA: Sign in when logged out, Log out when signed in (CLI/API). */
function updateEmptyAuthUi(hasAuth, authSummary) {
  emptyHint.textContent = hasAuth
    ? (authSummary || 'Signed in. You can start chatting.')
    : 'Not signed in — use Sign in (browser OAuth or API key), same as grok login.';
  if (!emptyAuthBtn) return;
  if (hasAuth) {
    emptyAuthBtn.setAttribute('data-action', 'logout');
    emptyAuthBtn.title =
      'Sign out of Grok — clears CLI session (~/.grok/auth.json), same as grok logout';
    emptyAuthBtn.innerHTML = '<i class="ti ti-logout"></i> Log out';
  } else {
    emptyAuthBtn.setAttribute('data-action', 'login');
    emptyAuthBtn.title =
      'Sign in with browser or API key (same as grok login)';
    emptyAuthBtn.innerHTML = '<i class="ti ti-login-2"></i> Sign in';
  }
}
/** True when the grok binary is not resolved — blocks chat until installed. */
let cliMissing = false;
/** Show install-CLI panel when binary is missing (blocks agent use). */
function updateEmptyCliUi(cliFound, installCommand, typicalPath) {
  cliMissing = !cliFound;
  emptyEl.classList.toggle('cli-missing', cliMissing);
  if (emptyReady) emptyReady.hidden = cliMissing;
  if (emptyCliMissing) emptyCliMissing.hidden = !cliMissing;
  if (emptyInstallCmd && installCommand) {
    emptyInstallCmd.textContent = installCommand;
  }
  if (emptyInstallPath) {
    emptyInstallPath.textContent = typicalPath
      ? 'Typical path after install: ' + typicalPath
      : '';
  }
  // Soft-lock composer when CLI is missing
  if (composer) {
    composer.disabled = cliMissing;
    composer.placeholder = cliMissing
      ? 'Install Grok Build CLI to chat…'
      : 'Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)';
  }
  updateSendStopButton();
}
const meta = document.getElementById('meta');
const composer = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const stickyEl = document.getElementById('sticky');
const reviewBar = document.getElementById('review-bar');
const reviewLabel = document.getElementById('review-label');
const ctxBarEl = document.getElementById('ctx-bar');
const turnStatusEl = document.getElementById('turn-status');
const tsProcess = turnStatusEl.querySelector('.ts-process');
const tsTime = turnStatusEl.querySelector('.ts-time');
const tsTokens = turnStatusEl.querySelector('.ts-tokens');
const tsCost = turnStatusEl.querySelector('.ts-cost');
const mentionPopover = document.getElementById('mention-popover');
const mentionList = document.getElementById('mention-list');
const mentionEmpty = document.getElementById('mention-empty');
const mentionTitle = document.getElementById('mention-title');
const slashPopover = document.getElementById('slash-popover');
const slashList = document.getElementById('slash-list');
const slashEmpty = document.getElementById('slash-empty');
const slashTitle = document.getElementById('slash-title');
const modelPopover = document.getElementById('model-popover');
const modelList = document.getElementById('model-list');
const modelEmpty = document.getElementById('model-empty');
const modelTitle = document.getElementById('model-title');
const btnModel = document.getElementById('btn-model');
const modelBtnLabel = document.getElementById('model-btn-label');
const effortPopover = document.getElementById('effort-popover');
const effortList = document.getElementById('effort-list');
const effortEmpty = document.getElementById('effort-empty');
const effortTitle = document.getElementById('effort-title');
const btnEffort = document.getElementById('btn-effort');
const effortBtnLabel = document.getElementById('effort-btn-label');
const btnMode = document.getElementById('btn-mode');
const modeBtnLabel = document.getElementById('mode-btn-label');
const permissionPopover = document.getElementById('permission-popover');
const permissionTitle = document.getElementById('permission-title');
const permissionDetail = document.getElementById('permission-detail');
const permissionList = document.getElementById('permission-list');
const permissionCancel = document.getElementById('permission-cancel');
const questionPopover = document.getElementById('question-popover');
const questionTitle = document.getElementById('question-title');
const questionTabs = document.getElementById('question-tabs');
const questionBody = document.getElementById('question-body');
const questionList = document.getElementById('question-list');
const questionNotes = document.getElementById('question-notes');
const questionCancel = document.getElementById('question-cancel');
const questionChat = document.getElementById('question-chat');
const questionSkip = document.getElementById('question-skip');
const questionAccept = document.getElementById('question-accept');
let busy = false;
let currentMode = 'normal';
let allMessages = [];
let stickyChips = [];
let autoAttachEnabled = true;
let autoChip = null; // { id, label, kind, fsPath } | null
/** Agent catalog — same source as TUI ModelsManager.available(). */
let modelItems = [];
let currentModelId = '';
let currentModelLabel = 'model';
let modelOpen = false;
let modelIndex = 0;
/** Reasoning effort menu for current model (TUI sessionConfig category mode). */
let effortItems = [];
let currentEffortId = '';
let currentEffortLabel = '';
let effortOpen = false;
let effortIndex = 0;
const EST_ROW = 96;
const VIRT_THRESHOLD = 40;

/* ── model + effort popovers (TUI /model + /effort) ── */
function setModelButtonLabel(label) {
  currentModelLabel = label || currentModelId || 'model';
  modelBtnLabel.textContent = currentModelLabel;
  btnModel.title = 'Model: ' + currentModelLabel + ' (same catalog as TUI)';
}

function setEffortButtonLabel(label) {
  currentEffortLabel = label || currentEffortId || '';
  if (!effortItems.length) {
    btnEffort.hidden = true;
    return;
  }
  btnEffort.hidden = false;
  effortBtnLabel.textContent = currentEffortLabel || 'effort';
  btnEffort.title = 'Reasoning effort: ' + (currentEffortLabel || currentEffortId || '—');
}

/** Map cycle mode id → button label (keep in sync with sessionModeCycle.ts). */
function modeLabelForId(id) {
  switch (String(id || '')) {
    case 'plan': return 'Plan';
    case 'auto': return 'Auto';
    case 'always-approve': return 'Always Approve';
    case 'normal':
    default: return 'Normal';
  }
}

function modeCssForId(id) {
  switch (String(id || '')) {
    case 'plan': return 'mode-plan';
    case 'auto': return 'mode-auto';
    case 'always-approve': return 'mode-always-approve';
    case 'normal':
    default: return 'mode-normal';
  }
}

function applyModeState(s) {
  if (!s) return;
  if (s.mode) currentMode = String(s.mode);
  const label = s.modeLabel || s.label || modeLabelForId(currentMode);
  modeBtnLabel.textContent = label;
  const css = s.modeCss || modeCssForId(currentMode);
  btnMode.className = 'secondary ' + css;
  btnMode.title = s.modeTitle || ('Mode: ' + label + ' (Shift+Tab)');
}

function applyModelsState(s) {
  if (!s) return;
  if (Array.isArray(s.models)) {
    modelItems = s.models.slice();
  }
  if (s.currentModelId != null) currentModelId = String(s.currentModelId || '');
  if (s.currentLabel) setModelButtonLabel(s.currentLabel);
  else if (currentModelId) {
    const hit = modelItems.find((m) => m.id === currentModelId);
    setModelButtonLabel(hit ? hit.label : currentModelId);
  }
  if (Array.isArray(s.efforts)) {
    effortItems = s.efforts.slice();
  }
  if (s.currentEffortId != null) currentEffortId = String(s.currentEffortId || '');
  if (s.currentEffortLabel) setEffortButtonLabel(s.currentEffortLabel);
  else setEffortButtonLabel(
    (effortItems.find((e) => e.id === currentEffortId) || {}).label || currentEffortId
  );
  if (modelOpen) renderModelList();
  if (effortOpen) renderEffortList();
}

function closeModelPopover() {
  modelOpen = false;
  modelPopover.hidden = true;
  modelList.innerHTML = '';
  modelEmpty.hidden = true;
}

function closeEffortPopover() {
  effortOpen = false;
  effortPopover.hidden = true;
  effortList.innerHTML = '';
  effortEmpty.hidden = true;
}

/* ── permission + question popovers (TUI overlays) ── */
let permissionOpen = false;
let permissionPromptId = 0;
let permissionItems = [];
let permissionIndex = 0;
let questionOpen = false;
let questionPromptId = 0;
let questionMode = 'default';
let questionItems = []; // full questions array
let questionTab = 0;
let questionSelections = []; // per-tab: number | Set
let questionIndex = 0;
let questionNotesByTab = [];

function closeOtherDropdowns() {
  if (typeof closeModelPopover === 'function') closeModelPopover();
  if (typeof closeEffortPopover === 'function') closeEffortPopover();
  if (typeof closeSlash === 'function') closeSlash();
  if (typeof closeMention === 'function') closeMention();
  if (typeof closeRewindPopover === 'function') closeRewindPopover();
}

function closePermissionPopover(send) {
  if (!permissionOpen && permissionPopover.hidden) return;
  const id = permissionPromptId;
  permissionOpen = false;
  permissionPopover.hidden = true;
  permissionList.innerHTML = '';
  permissionItems = [];
  if (send) {
    vscode.postMessage({
      type: 'permissionResponse',
      promptId: id,
      outcome: send.outcome,
      optionId: send.optionId,
    });
  }
}

function openPermissionPrompt(msg) {
  closeOtherDropdowns();
  closeQuestionPopover(null);
  permissionOpen = true;
  permissionPromptId = msg.promptId || 0;
  permissionItems = msg.options || [];
  permissionIndex = 0;
  permissionTitle.textContent = msg.title ? String(msg.title) : 'Permission';
  permissionDetail.textContent = msg.detail ? String(msg.detail) : '';
  permissionPopover.hidden = false;
  renderPermissionList();
  // Focus list so keyboard works even if composer isn't focused
  const first = permissionList.querySelector('.permission-item');
  if (first) first.focus();
}

function renderPermissionList() {
  if (!permissionOpen) return;
  permissionList.innerHTML = permissionItems.map((o, i) => {
    const icon = o.icon || 'ti-circle-dot';
    const kind = o.kind || '';
    const label = o.label || o.name || o.optionId || '';
    const desc = o.kind || '';
    return '<button type="button" class="permission-item kind-' + esc(kind) +
      (i === permissionIndex ? ' active' : '') +
      '" data-i="' + i + '" role="option" tabindex="0" aria-selected="' +
      (i === permissionIndex ? 'true' : 'false') + '">' +
      '<span class="mi-icon"><i class="ti ' + esc(icon) + '"></i></span>' +
      '<span class="mi-body"><span class="mi-label">' + esc(label) + '</span>' +
      '<span class="mi-desc">' + esc(desc) + '</span></span>' +
      '</button>';
  }).join('');
  highlightPermissionIndex(false);
}

/** Update active row without rebuilding DOM (avoids killing click on mouseenter). */
function highlightPermissionIndex(scroll) {
  const buttons = permissionList.querySelectorAll('.permission-item');
  buttons.forEach((btn, i) => {
    const on = i === permissionIndex;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && scroll) btn.scrollIntoView({ block: 'nearest' });
  });
}

function movePermission(delta) {
  if (!permissionItems.length) return;
  permissionIndex = (permissionIndex + delta + permissionItems.length) % permissionItems.length;
  highlightPermissionIndex(true);
}

function acceptPermission(i) {
  const idx = typeof i === 'number' ? i : permissionIndex;
  const o = permissionItems[idx];
  if (!o || !o.optionId) return;
  closePermissionPopover({ outcome: 'selected', optionId: o.optionId });
}

// Event delegation — stable handlers (re-render must not re-bind)
permissionList.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.permission-item') : null;
  if (!btn || !permissionOpen) return;
  e.preventDefault();
  e.stopPropagation();
  const i = Number(btn.getAttribute('data-i'));
  if (Number.isFinite(i)) acceptPermission(i);
});
permissionList.addEventListener('mouseover', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.permission-item') : null;
  if (!btn || !permissionOpen) return;
  const i = Number(btn.getAttribute('data-i'));
  if (!Number.isFinite(i) || i === permissionIndex) return;
  permissionIndex = i;
  highlightPermissionIndex(false);
});

function closeQuestionPopover(send) {
  if (!questionOpen && questionPopover.hidden) return;
  const id = questionPromptId;
  questionOpen = false;
  questionPopover.hidden = true;
  questionList.innerHTML = '';
  questionTabs.innerHTML = '';
  questionBody.textContent = '';
  questionNotes.value = '';
  questionNotes.hidden = true;
  questionItems = [];
  questionSelections = [];
  questionNotesByTab = [];
  if (send) {
    vscode.postMessage(Object.assign({ type: 'questionResponse', promptId: id }, send));
  }
}

function openQuestionPrompt(msg) {
  closeOtherDropdowns();
  closePermissionPopover(null);
  questionOpen = true;
  questionPromptId = msg.promptId || 0;
  questionMode = msg.mode === 'plan' ? 'plan' : 'default';
  questionItems = msg.questions || [];
  questionTab = 0;
  questionIndex = 0;
  questionSelections = questionItems.map((q) =>
    q.multiSelect ? new Set() : null
  );
  questionNotesByTab = questionItems.map(() => '');
  questionTitle.textContent = questionItems.length > 1
    ? 'Questions (' + questionItems.length + ')'
    : 'Question';
  questionChat.hidden = questionMode !== 'plan';
  questionSkip.hidden = questionMode !== 'plan';
  questionPopover.hidden = false;
  renderQuestionView();
  const first = questionList.querySelector('.question-item');
  if (first) first.focus();
}

function saveQuestionNotes() {
  if (questionTab >= 0 && questionTab < questionNotesByTab.length) {
    questionNotesByTab[questionTab] = questionNotes.value || '';
  }
}

function renderQuestionView() {
  if (!questionOpen) return;
  const q = questionItems[questionTab];
  if (!q) return;
  // tabs
  if (questionItems.length > 1) {
    questionTabs.innerHTML = questionItems.map((qq, i) =>
      '<button type="button" class="q-tab' + (i === questionTab ? ' active' : '') +
      '" data-i="' + i + '">Q' + (i + 1) + '</button>'
    ).join('');
  } else {
    questionTabs.innerHTML = '';
  }
  questionBody.textContent = q.question || '';
  questionNotes.hidden = false;
  questionNotes.value = questionNotesByTab[questionTab] || '';
  const opts = q.options || [];
  const sel = questionSelections[questionTab];
  questionList.innerHTML = opts.map((o, i) => {
    const selected = q.multiSelect
      ? !!(sel && sel.has(i))
      : sel === i;
    return '<button type="button" class="question-item' +
      (i === questionIndex ? ' active' : '') +
      (selected ? ' selected' : '') +
      '" data-i="' + i + '" role="option" tabindex="0">' +
      '<span class="mi-check"><i class="ti ti-check"></i></span>' +
      '<span class="mi-body"><span class="mi-label">' + esc(o.label || '') + '</span>' +
      '<span class="mi-desc">' + esc(o.description || '') + '</span></span>' +
      '</button>';
  }).join('');
  highlightQuestionIndex(false);
}

function highlightQuestionIndex(scroll) {
  const q = questionItems[questionTab];
  const sel = questionSelections[questionTab];
  const buttons = questionList.querySelectorAll('.question-item');
  buttons.forEach((btn, i) => {
    const on = i === questionIndex;
    btn.classList.toggle('active', on);
    const selected = q && q.multiSelect
      ? !!(sel && sel.has(i))
      : sel === i;
    btn.classList.toggle('selected', selected);
    if (on && scroll) btn.scrollIntoView({ block: 'nearest' });
  });
}

function toggleQuestionOption(i) {
  const q = questionItems[questionTab];
  if (!q) return;
  if (q.multiSelect) {
    const set = questionSelections[questionTab] || new Set();
    if (set.has(i)) set.delete(i);
    else set.add(i);
    questionSelections[questionTab] = set;
  } else {
    questionSelections[questionTab] = i;
  }
  questionIndex = i;
  highlightQuestionIndex(false);
}

function moveQuestion(delta) {
  const q = questionItems[questionTab];
  if (!q || !(q.options || []).length) return;
  const n = q.options.length;
  questionIndex = (questionIndex + delta + n) % n;
  highlightQuestionIndex(true);
}

questionTabs.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.q-tab') : null;
  if (!btn || !questionOpen) return;
  e.preventDefault();
  saveQuestionNotes();
  questionTab = Number(btn.getAttribute('data-i')) || 0;
  questionIndex = 0;
  renderQuestionView();
});
questionList.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.question-item') : null;
  if (!btn || !questionOpen) return;
  e.preventDefault();
  e.stopPropagation();
  const i = Number(btn.getAttribute('data-i'));
  if (Number.isFinite(i)) toggleQuestionOption(i);
});
questionList.addEventListener('mouseover', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.question-item') : null;
  if (!btn || !questionOpen) return;
  const i = Number(btn.getAttribute('data-i'));
  if (!Number.isFinite(i) || i === questionIndex) return;
  questionIndex = i;
  highlightQuestionIndex(false);
});

function buildQuestionAnswers() {
  saveQuestionNotes();
  const answers = {};
  const annotations = {};
  let any = false;
  questionItems.forEach((q, ti) => {
    const sel = questionSelections[ti];
    const labels = [];
    let preview;
    if (q.multiSelect && sel && sel.size) {
      Array.from(sel).sort((a, b) => a - b).forEach((i) => {
        const o = q.options[i];
        if (o) labels.push(o.label);
      });
    } else if (typeof sel === 'number' && q.options[sel]) {
      labels.push(q.options[sel].label);
      if (q.options[sel].preview) preview = q.options[sel].preview;
    }
    const notes = (questionNotesByTab[ti] || '').trim();
    // Freeform-only (TUI): no option picked but notes → answer "Other"
    if (!labels.length && notes) {
      labels.push('Other');
    }
    if (labels.length) {
      answers[q.question] = labels;
      any = true;
    }
    if (preview || notes) {
      annotations[q.question] = {};
      if (preview) annotations[q.question].preview = preview;
      if (notes) annotations[q.question].notes = notes;
    }
  });
  return { answers, annotations, any };
}

function acceptQuestion() {
  const { answers, annotations, any } = buildQuestionAnswers();
  if (!any) return;
  const payload = { outcome: 'accepted', answers };
  if (Object.keys(annotations).length) payload.annotations = annotations;
  closeQuestionPopover(payload);
}

function partialAnswersFromSelections() {
  const { answers } = buildQuestionAnswers();
  const partial = {};
  Object.keys(answers).forEach((k) => {
    partial[k] = answers[k].join(', ');
  });
  return partial;
}

permissionCancel.addEventListener('click', () => {
  closePermissionPopover({ outcome: 'cancelled' });
});
questionCancel.addEventListener('click', () => {
  closeQuestionPopover({ outcome: 'cancelled' });
});
questionAccept.addEventListener('click', () => acceptQuestion());
questionChat.addEventListener('click', () => {
  closeQuestionPopover({
    outcome: 'chat_about_this',
    partial_answers: partialAnswersFromSelections(),
  });
});
questionSkip.addEventListener('click', () => {
  closeQuestionPopover({
    outcome: 'skip_interview',
    partial_answers: partialAnswersFromSelections(),
  });
});

function renderModelList() {
  if (!modelOpen) return;
  modelPopover.hidden = false;
  modelTitle.textContent = 'Models' + (modelItems.length ? ' (' + modelItems.length + ')' : '');
  if (!modelItems.length) {
    modelList.innerHTML = '';
    modelEmpty.hidden = false;
    modelEmpty.textContent = 'Waiting for agent catalog…';
    return;
  }
  modelEmpty.hidden = true;
  modelList.innerHTML = modelItems.map((m, i) => {
    const cur = m.id === currentModelId || m.selected;
    return '<button type="button" class="model-item' +
      (i === modelIndex ? ' active' : '') +
      (cur ? ' current' : '') +
      '" role="option" data-model-idx="' + i + '" aria-selected="' + (i === modelIndex) + '">' +
      '<span class="mi-icon">' + icon(cur ? 'check' : 'cpu') + '</span>' +
      '<span class="mi-body">' +
        '<span class="mi-label">' + esc(m.label || m.id) + '</span>' +
        (m.id && m.id !== m.label
          ? '<span class="mi-desc">' + esc(m.id) + '</span>'
          : (m.description ? '<span class="mi-desc">' + esc(m.description) + '</span>' : '')) +
      '</span>' +
      (cur ? '<span class="mi-badge">current</span>' : '') +
    '</button>';
  }).join('');
  const active = modelList.querySelector('.model-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderEffortList() {
  if (!effortOpen) return;
  effortPopover.hidden = false;
  effortTitle.textContent = 'Reasoning';
  if (!effortItems.length) {
    effortList.innerHTML = '';
    effortEmpty.hidden = false;
    return;
  }
  effortEmpty.hidden = true;
  effortList.innerHTML = effortItems.map((e, i) => {
    const cur = e.id === currentEffortId || e.selected;
    return '<button type="button" class="effort-item' +
      (i === effortIndex ? ' active' : '') +
      (cur ? ' current' : '') +
      '" role="option" data-effort-idx="' + i + '" aria-selected="' + (i === effortIndex) + '">' +
      '<span class="mi-icon">' + icon(cur ? 'check' : 'brain') + '</span>' +
      '<span class="mi-body">' +
        '<span class="mi-label">' + esc(e.label || e.id) + '</span>' +
        (e.description ? '<span class="mi-desc">' + esc(e.description) + '</span>' : '') +
      '</span>' +
      (cur ? '<span class="mi-badge">current</span>' : '') +
    '</button>';
  }).join('');
  const active = effortList.querySelector('.effort-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function focusPopoverActive(listEl, selector) {
  requestAnimationFrame(() => {
    const el =
      (listEl && listEl.querySelector(selector + '.active')) ||
      (listEl && listEl.querySelector(selector));
    if (el && typeof el.focus === 'function') {
      try { el.focus(); } catch (_) { /* ignore */ }
    }
  });
}

function openModelPopover() {
  if (slashOpen) closeSlash();
  if (mentionOpen) closeMention();
  if (effortOpen) closeEffortPopover();
  // Always re-fetch catalog from agent so we don't stick on bundled fallback
  // until some other server action happens to start the agent.
  vscode.postMessage({ type: 'ensureModels' });
  modelOpen = true;
  modelIndex = Math.max(0, modelItems.findIndex((m) => m.id === currentModelId));
  if (modelIndex < 0) modelIndex = 0;
  renderModelList();
  // Focus list so keyboard works even when opened from the model button.
  // Empty catalog shows "Waiting for agent catalog…" until models post arrives.
  focusPopoverActive(modelList, '.model-item');
}

function openEffortPopover() {
  if (slashOpen) closeSlash();
  if (mentionOpen) closeMention();
  if (modelOpen) closeModelPopover();
  if (!effortItems.length) return;
  effortOpen = true;
  effortIndex = Math.max(0, effortItems.findIndex((e) => e.id === currentEffortId));
  if (effortIndex < 0) effortIndex = 0;
  renderEffortList();
  focusPopoverActive(effortList, '.effort-item');
}

function acceptModel(idx) {
  const m = modelItems[idx];
  if (!m || !m.id) return;
  closeModelPopover();
  if (m.id === currentModelId) return;
  vscode.postMessage({ type: 'setModel', modelId: m.id });
}

function acceptEffort(idx) {
  const e = effortItems[idx];
  if (!e || !e.id) return;
  closeEffortPopover();
  if (e.id === currentEffortId) return;
  vscode.postMessage({ type: 'setEffort', effortId: e.id });
}

function moveModel(delta) {
  if (!modelItems.length) return;
  modelIndex = (modelIndex + delta + modelItems.length) % modelItems.length;
  renderModelList();
}

function moveEffort(delta) {
  if (!effortItems.length) return;
  effortIndex = (effortIndex + delta + effortItems.length) % effortItems.length;
  renderEffortList();
}

/* ── / slash popover (synced with grok-build slash dropdown) ── */
let slashOpen = false;
let slashItems = [];
let slashIndex = 0;
let slashRequestId = 0;
let slashCtx = null; // { start, end, query, inCommand }
let slashSearchTimer = null;

function detectSlashContext(text, cursor) {
  if (cursor < 0 || cursor > text.length) return null;
  let i = 0;
  while (i < text.length && /\\s/.test(text[i])) i++;
  if (i >= text.length || text[i] !== '/') return null;
  const slashStart = i;
  let nameEnd = slashStart + 1;
  while (nameEnd < text.length && !/\\s/.test(text[nameEnd])) {
    if (nameEnd > slashStart + 1 && text[nameEnd] === '/') return null;
    nameEnd++;
  }
  const inCommand = cursor >= slashStart && cursor <= nameEnd;
  if (!inCommand && cursor < nameEnd) return null;
  let argsStart = nameEnd;
  while (argsStart < text.length && /\\s/.test(text[argsStart])) argsStart++;
  return {
    start: slashStart,
    end: nameEnd,
    query: inCommand ? text.slice(slashStart + 1, cursor) : text.slice(slashStart + 1, nameEnd),
    inCommand,
    args: text.slice(argsStart),
  };
}

function closeSlash() {
  slashOpen = false;
  slashItems = [];
  slashIndex = 0;
  slashCtx = null;
  slashPopover.hidden = true;
  slashList.innerHTML = '';
  slashEmpty.hidden = true;
  if (slashSearchTimer) {
    clearTimeout(slashSearchTimer);
    slashSearchTimer = null;
  }
}

function slashIconName(layer) {
  if (layer === 'host') return 'device-desktop';
  if (layer === 'unsupported') return 'device-desktop-off';
  return 'robot';
}

function renderSlashList() {
  if (!slashOpen) return;
  slashPopover.hidden = false;
  slashTitle.textContent = slashCtx
    ? ('/' + (slashCtx.query || '…'))
    : '/ commands';
  if (!slashItems.length) {
    slashList.innerHTML = '';
    slashEmpty.hidden = false;
    slashEmpty.textContent = 'No matches';
    return;
  }
  slashEmpty.hidden = true;
  slashList.innerHTML = slashItems.map((it, i) =>
    '<button type="button" class="slash-item' + (i === slashIndex ? ' active' : '') +
    '" role="option" data-slash-idx="' + i + '" aria-selected="' + (i === slashIndex) + '">' +
      '<span class="mi-icon">' + icon(slashIconName(it.layer)) + '</span>' +
      '<span class="mi-body">' +
        '<span class="mi-label">' + esc(it.display) + '</span>' +
        (it.description
          ? '<span class="mi-desc">' + esc(it.description) + '</span>'
          : '') +
      '</span>' +
      '<span class="mi-badge">' + esc(it.layer === 'passthrough' ? 'agent' : it.layer) + '</span>' +
    '</button>'
  ).join('');
  const active = slashList.querySelector('.slash-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function requestSlashSearch(query) {
  const requestId = ++slashRequestId;
  vscode.postMessage({ type: 'searchSlash', query: query || '', requestId });
}

function openSlashFromContext(ctx) {
  if (mentionOpen) closeMention();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  slashOpen = true;
  slashCtx = ctx;
  slashIndex = 0;
  slashPopover.hidden = false;
  slashEmpty.hidden = false;
  slashEmpty.textContent = 'Loading…';
  slashList.innerHTML = '';
  slashTitle.textContent = '/' + (ctx.query || '…');
  if (slashSearchTimer) clearTimeout(slashSearchTimer);
  slashSearchTimer = setTimeout(() => {
    requestSlashSearch(ctx.query || '');
  }, 20);
}

function syncSlashFromComposer() {
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  const ctx = detectSlashContext(text, cursor);
  // Only show dropdown while editing the command name (TUI parity).
  if (!ctx || !ctx.inCommand) {
    if (slashOpen) closeSlash();
    return;
  }
  const same =
    slashCtx &&
    slashCtx.start === ctx.start &&
    slashCtx.query === ctx.query;
  slashCtx = ctx;
  if (!slashOpen) {
    openSlashFromContext(ctx);
    return;
  }
  if (!same) {
    slashIndex = 0;
    if (slashSearchTimer) clearTimeout(slashSearchTimer);
    slashSearchTimer = setTimeout(() => {
      requestSlashSearch(ctx.query || '');
    }, 40);
    slashTitle.textContent = '/' + (ctx.query || '…');
  }
}

function acceptSlash(idx) {
  const item = slashItems[idx];
  if (!item) return;
  const text = composer.value;
  const ctx = slashCtx || detectSlashContext(text, composer.selectionStart || 0);
  if (ctx) {
    const after = text.slice(ctx.end);
    const next = text.slice(0, ctx.start) + item.insertText + after;
    composer.value = next;
    const pos = ctx.start + item.insertText.length;
    composer.setSelectionRange(pos, pos);
    autosizeComposer();
  }
  closeSlash();
  composer.focus();
  // If command takes no args, send immediately (TUI-like).
  if (!item.takesArgs) {
    sendBtn.click();
  }
}

function moveSlash(delta) {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashList();
}

/* ── @ mention popover (synced with grok-build file_search UX) ── */
let mentionOpen = false;
let mentionItems = [];
let mentionIndex = 0;
let mentionRequestId = 0;
let mentionAtCtx = null; // { start, end } of full @-token
let mentionSearchTimer = null;

function detectAtContext(text, cursor) {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const atIdx = before.lastIndexOf('@');
  if (atIdx < 0) return null;
  if (atIdx > 0) {
    const prev = text[atIdx - 1];
    if (/[A-Za-z0-9_]/.test(prev)) return null;
  }
  let tokenEnd = text.length;
  for (let i = atIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (/\\s/.test(ch) || ch === ',' || ch === ';') {
      tokenEnd = i;
      break;
    }
  }
  if (cursor > tokenEnd) return null;
  return {
    start: atIdx,
    end: tokenEnd,
    query: text.slice(atIdx + 1, cursor),
  };
}

function closeMention() {
  mentionOpen = false;
  mentionItems = [];
  mentionIndex = 0;
  mentionAtCtx = null;
  mentionPopover.hidden = true;
  mentionList.innerHTML = '';
  mentionEmpty.hidden = true;
  if (mentionSearchTimer) {
    clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  }
}

function syncComposerMenus() {
  // Prefer @ when inside @-token; else slash when leading /.
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  if (detectAtContext(text, cursor)) {
    if (slashOpen) closeSlash();
    syncMentionFromComposer();
    return;
  }
  if (mentionOpen) closeMention();
  syncSlashFromComposer();
}

function mentionIconName(icon) {
  if (icon === 'folder') return 'folder';
  if (icon === 'selection') return 'highlight';
  if (icon === 'search') return 'search';
  return 'file';
}

function renderMentionList() {
  if (!mentionOpen) return;
  mentionPopover.hidden = false;
  mentionTitle.textContent = mentionAtCtx
    ? ('@' + (mentionAtCtx.query || '…'))
    : '@ context';
  if (!mentionItems.length) {
    mentionList.innerHTML = '';
    mentionEmpty.hidden = false;
    mentionEmpty.textContent = 'No matches';
    return;
  }
  mentionEmpty.hidden = true;
  mentionEmpty.textContent = 'No matches';
  mentionList.innerHTML = mentionItems.map((it, i) =>
    '<button type="button" class="mention-item' + (i === mentionIndex ? ' active' : '') +
    '" role="option" data-idx="' + i + '" aria-selected="' + (i === mentionIndex) + '">' +
      '<span class="mi-icon">' + icon(mentionIconName(it.icon)) + '</span>' +
      '<span class="mi-body">' +
        '<span class="mi-label">' + esc(it.label) + '</span>' +
        (it.description
          ? '<span class="mi-desc">' + esc(it.description) + '</span>'
          : '') +
      '</span>' +
    '</button>'
  ).join('');
  const active = mentionList.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function requestMentionSearch(query) {
  const requestId = ++mentionRequestId;
  vscode.postMessage({ type: 'searchMention', query: query || '', requestId });
}

function openMentionFromContext(ctx) {
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  mentionOpen = true;
  mentionAtCtx = ctx;
  mentionIndex = 0;
  mentionPopover.hidden = false;
  mentionEmpty.hidden = false;
  mentionEmpty.textContent = 'Searching…';
  mentionList.innerHTML = '';
  mentionTitle.textContent = '@' + (ctx.query || '…');
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  mentionSearchTimer = setTimeout(() => {
    requestMentionSearch(ctx.query || '');
  }, 40);
}

function syncMentionFromComposer() {
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  const ctx = detectAtContext(text, cursor);
  if (!ctx) {
    if (mentionOpen) closeMention();
    return;
  }
  const same =
    mentionAtCtx &&
    mentionAtCtx.start === ctx.start &&
    mentionAtCtx.query === ctx.query;
  mentionAtCtx = ctx;
  if (!mentionOpen) {
    openMentionFromContext(ctx);
    return;
  }
  if (!same) {
    mentionIndex = 0;
    if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
    mentionSearchTimer = setTimeout(() => {
      requestMentionSearch(ctx.query || '');
    }, 60);
    mentionTitle.textContent = '@' + (ctx.query || '…');
  }
}

function acceptMention(idx) {
  const item = mentionItems[idx];
  if (!item || !item.chip) return;
  const text = composer.value;
  const ctx = mentionAtCtx || detectAtContext(text, composer.selectionStart || 0);
  if (ctx) {
    const next = text.slice(0, ctx.start) + text.slice(ctx.end);
    composer.value = next;
    const pos = ctx.start;
    composer.setSelectionRange(pos, pos);
    autosizeComposer();
  }
  vscode.postMessage({ type: 'pickMention', chip: item.chip });
  closeMention();
  composer.focus();
}

function moveMention(delta) {
  if (!mentionItems.length) return;
  mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  renderMentionList();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function icon(name, extraClass) {
  return '<i class="ti ti-' + name + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"></i>';
}

function toolIconName(t) {
  const s = ((t.kind || '') + ' ' + (t.title || '')).toLowerCase();
  if (/read|grep|search|glob|find|list/.test(s)) return 'search';
  if (/edit|write|patch|replace|create.?file/.test(s)) return 'pencil';
  if (/terminal|bash|shell|command|run/.test(s)) return 'terminal-2';
  if (/web|fetch|http|browser/.test(s)) return 'world';
  if (/task|subagent|agent/.test(s)) return 'robot';
  if (/git/.test(s)) return 'brand-git';
  return 'tool';
}

function statusIcon(status) {
  const s = String(status || '').toLowerCase();
  if (/complet|success|done|ok/.test(s)) return icon('check');
  if (/fail|error/.test(s)) return icon('x');
  if (/run|progress|pending|in_progress/.test(s)) return icon('loader', 'ti-spin');
  return icon('circle-dashed');
}

function chipIcon(label) {
  if (String(label).startsWith('selection:')) return 'highlight';
  if (String(label).startsWith('folder:')) return 'folder';
  if (String(label).startsWith('file:')) return 'file';
  return 'paperclip';
}

function computeVirtualWindow(args) {
  const total = args.total, scrollTop = args.scrollTop, viewportHeight = args.viewportHeight;
  const estimatedRowHeight = args.estimatedRowHeight, overscan = args.overscan ?? 5;
  if (total <= 0 || estimatedRowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / estimatedRowHeight);
  const visible = Math.ceil(viewportHeight / estimatedRowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + visible + overscan),
  };
}

function shouldStickToBottom(scrollTop, scrollHeight, viewportHeight, thresholdPx) {
  thresholdPx = thresholdPx == null ? 48 : thresholdPx;
  return scrollTop + viewportHeight >= scrollHeight - thresholdPx;
}

function attachCopyButtons(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = pre.innerText.replace(/^Copy\\n?/, '');
      navigator.clipboard.writeText(text);
    });
    pre.style.position = 'relative';
    pre.prepend(btn);
  });
}

/**
 * Fill assistant text bubble. Prefers markdown HTML when present (including
 * while streaming). No stream text animation.
 */
function fillTextBubble(b, text, html, _opts) {
  const nextPlain = text || '';
  const key = html ? 'h:' + html : 't:' + nextPlain;
  if (b.dataset.streamKey === key) return;
  b.dataset.streamKey = key;

  if (html) {
    b.innerHTML = html;
    attachCopyButtons(b);
  } else if (nextPlain) {
    b.textContent = nextPlain;
  } else {
    // No placeholder — empty assistant waits silently (TUI turn-status / Thinking).
    b.textContent = '';
  }
}

/** TUI ThinkingBlock header: Thinking… / Thought for Xs / Thought */
function thoughtHeaderLabel(t) {
  if (t && t.label) return t.label;
  if (t && t.running) return 'Thinking…';
  return 'Thought';
}

/** Fill a thought <details> from a timeline thought segment. */
function fillThoughtBlock(d, t) {
  const running = !!(t && t.running);
  d.className = 'thought' + (running ? ' thought-running' : '');
  if (t && t.id) d.dataset.thoughtId = t.id;
  let summary = d.querySelector('summary');
  if (!summary) {
    summary = document.createElement('summary');
    d.appendChild(summary);
  }
  summary.innerHTML =
    icon('brain') +
    ' <span class="thought-label">' + esc(thoughtHeaderLabel(t)) + '</span>';
  let body = d.querySelector('.thought-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'thought-body md';
    d.appendChild(body);
  } else {
    body.className = 'thought-body md';
  }
  const bodyKey = t && t.html ? 'h:' + t.html : 't:' + ((t && t.text) || '');
  if (body.dataset.streamKey !== bodyKey) {
    body.dataset.streamKey = bodyKey;
    if (t && t.html) {
      body.innerHTML = t.html;
    } else {
      body.textContent = (t && t.text) || '';
    }
  }
  if (running && body.scrollHeight > body.clientHeight) {
    body.scrollTop = body.scrollHeight;
  }
}

function renderThoughtRow(t, forceOpen) {
  const d = document.createElement('details');
  fillThoughtBlock(d, t);
  // Running → open; finished → collapsed unless user had it expanded (forceOpen).
  d.open = !!(t && t.running) || !!forceOpen;
  return d;
}

function renderToolRow(t, open) {
  const d = document.createElement('details');
  d.className = 'tool-row';
  d.dataset.toolId = t.id || '';
  d.dataset.streamKey =
    (t.status || '') +
    '|' +
    (t.title || '') +
    '|' +
    (t.input || '') +
    '|' +
    (t.output || '') +
    '|' +
    ((t.paths && t.paths.join(',')) || '');
  if (open) d.open = true;
  const summary = document.createElement('summary');
  // No disclosure arrow — click the row to expand detail (TUI-style fold).
  summary.innerHTML =
    '<span class="tool-ico">' + icon(toolIconName(t)) + '</span>' +
    '<span class="tool-title">' + esc(t.title || t.id || 'tool') + '</span>' +
    '<span class="tool-status">' + statusIcon(t.status) + esc(t.status || '') + '</span>';
  d.appendChild(summary);

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  const metaBits = [];
  if (t.kind) metaBits.push(esc(t.kind));
  if (t.status) metaBits.push(esc(t.status));
  if (metaBits.length) {
    const meta = document.createElement('div');
    meta.innerHTML = metaBits.join(' · ');
    detail.appendChild(meta);
  }
  if (t.paths && t.paths.length) {
    const paths = document.createElement('div');
    paths.className = 'paths';
    paths.innerHTML = t.paths.map(p => {
      const isEdit = /edit|write|patch|replace|create.?file|search_replace|apply/i.test(
        (t.kind || '') + ' ' + (t.title || '')
      );
      return '<a data-path="' + esc(p) + '" href="#">' + icon('file') + esc(p) + '</a>' +
        (isEdit
          ? '<button type="button" class="link" data-diff="' + esc(p) + '">' + icon('file-diff') + ' Diff</button>'
          : '');
    }).join('');
    detail.appendChild(paths);
  }
  // Input / output body — what TUI shows when a tool block is expanded.
  if (t.input) {
    const lab = document.createElement('div');
    lab.className = 'tool-io-label';
    lab.textContent = 'Input';
    detail.appendChild(lab);
    const pre = document.createElement('pre');
    pre.className = 'tool-io';
    pre.textContent = t.input;
    detail.appendChild(pre);
  }
  if (t.output) {
    const lab = document.createElement('div');
    lab.className = 'tool-io-label';
    lab.textContent = 'Output';
    detail.appendChild(lab);
    const pre = document.createElement('pre');
    pre.className = 'tool-io';
    pre.textContent = t.output;
    detail.appendChild(pre);
  }
  if (!t.input && !t.output && !(t.paths && t.paths.length) && !metaBits.length) {
    const empty = document.createElement('div');
    empty.className = 'tool-meta';
    empty.textContent = 'No extra details';
    detail.appendChild(empty);
  }
  d.appendChild(detail);
  return d;
}

/** Visible timeline items (empty text segments omitted, TUI-aligned). */
function visibleTimelineItems(m) {
  const items = Array.isArray(m.items) ? m.items : null;
  if (items && items.length) {
    const out = [];
    for (const item of items) {
      if (item.kind === 'text') {
        if (!(item.text || item.html)) continue;
        out.push(item);
      } else if (item.kind === 'tool' && item.tool) {
        out.push(item);
      } else if (item.kind === 'thought' && item.thought) {
        out.push(item);
      }
    }
    return out;
  }
  // Legacy shape → synthetic items
  const out = [];
  if (m.html || m.text) {
    out.push({ kind: 'text', text: m.text || '', html: m.html || '' });
  }
  if (m.tools && m.tools.length) {
    for (const t of m.tools) out.push({ kind: 'tool', tool: t });
  }
  return out;
}

// ── Verb-group: consecutive toolcalls → "Read 2 files, Edited 4 files" ──
function classifyToolVerb(t) {
  const s = ((t && t.kind) || '') + ' ' + ((t && t.title) || '');
  const low = s.toLowerCase();
  if (/list.?dir|list_dir|listdir/.test(low)) return 'dir';
  if (/search_replace|str_replace|apply.?patch|write.?file|edit|write|patch|create.?file|apply/.test(low)) {
    return 'edit';
  }
  if (/grep|glob|search|find|rg\\b|fuzzy/.test(low)) return 'search';
  if (/read|open.?file|cat\\b|view.?file/.test(low)) return 'file';
  if (/web.?fetch|fetch|http|browser|web.?search|browse/.test(low)) return 'web';
  if (/terminal|bash|shell|command|execute|run_terminal|run /.test(low)) return 'command';
  if (/use.?tool|mcp|integration|call.?tool/.test(low)) return 'mcp';
  return 'other';
}

function isToolStatusRunning(status) {
  return /run|progress|pending|in_progress|start|stream/.test(String(status || '').toLowerCase());
}
function isToolStatusFailed(status) {
  return /fail|error|denied|cancel/.test(String(status || '').toLowerCase());
}

function formatToolVerbGroupLabel(tools) {
  const buckets = [];
  let running = false;
  let failed = 0;
  const verbTable = {
    file: ['Read', 'Reading'],
    search: ['Searched', 'Searching'],
    dir: ['Listed', 'Listing'],
    edit: ['Edited', 'Editing'],
    command: ['Ran', 'Running'],
    web: ['Fetched', 'Fetching'],
    mcp: ['Called', 'Calling'],
    other: ['Ran', 'Running'],
  };
  const nounTable = {
    file: ['file', 'files'],
    search: ['pattern', 'patterns'],
    dir: ['dir', 'dirs'],
    edit: ['file', 'files'],
    command: ['command', 'commands'],
    web: ['website', 'websites'],
    mcp: ['MCP tool', 'MCP tools'],
    other: ['tool', 'tools'],
  };
  for (const t of tools) {
    const kind = classifyToolVerb(t);
    const pos = buckets.findIndex((b) => b.kind === kind);
    if (pos < 0) buckets.push({ kind, count: 1 });
    else buckets[pos].count += 1;
    if (isToolStatusRunning(t.status)) running = true;
    if (isToolStatusFailed(t.status)) failed += 1;
  }
  const parts = buckets.map((b) => {
    const v = verbTable[b.kind] || verbTable.other;
    const n = nounTable[b.kind] || nounTable.other;
    const verb = running ? v[1] : v[0];
    const noun = b.count === 1 ? n[0] : n[1];
    return verb + ' ' + b.count + ' ' + noun;
  });
  let label = parts.join(', ');
  if (failed > 0) label += ' · ' + failed + ' failed';
  return { label, running, failed };
}

/**
 * Fold consecutive tools into verb-groups (singleton stays flat).
 * Text / thought break the run.
 */
function groupConsecutiveTools(items) {
  const out = [];
  let run = [];
  function flush() {
    if (!run.length) return;
    if (run.length === 1) {
      out.push({ type: 'tool', tool: run[0] });
    } else {
      const meta = formatToolVerbGroupLabel(run);
      const id = run.map((t) => t.id).filter(Boolean).join('|') || ('tg-' + out.length);
      out.push({
        type: 'toolGroup',
        group: {
          id,
          tools: run.slice(),
          label: meta.label,
          running: meta.running,
          failed: meta.failed,
        },
      });
    }
    run = [];
  }
  for (const item of items) {
    if (item.kind === 'tool' && item.tool) {
      run.push(item.tool);
      continue;
    }
    flush();
    if (item.kind === 'text') out.push({ type: 'text', item });
    else if (item.kind === 'thought') out.push({ type: 'thought', item });
  }
  flush();
  return out;
}

function visibleGroupedTimeline(m) {
  return groupConsecutiveTools(visibleTimelineItems(m));
}

function timelineNodeSig(node) {
  if (node.type === 'text') return 't';
  if (node.type === 'tool' && node.tool) return 'tool:' + (node.tool.id || '');
  if (node.type === 'toolGroup' && node.group) return 'tg:' + (node.group.id || '');
  if (node.type === 'thought' && node.item && node.item.thought) {
    return 'th:' + (node.item.thought.id || '');
  }
  return '?';
}

function domTimelineSig(timeline) {
  return Array.from(timeline.children).map((el) => {
    if (el.classList.contains('bubble')) return 't';
    if (el.classList.contains('tool-row')) return 'tool:' + (el.dataset.toolId || '');
    if (el.classList.contains('tool-group')) return 'tg:' + (el.dataset.groupId || '');
    if (el.classList.contains('thought')) return 'th:' + (el.dataset.thoughtId || '');
    return '?';
  }).join('|');
}

function nodesTimelineSig(nodes) {
  return nodes.map(timelineNodeSig).join('|');
}

function renderToolGroup(group, openToolIds, openGroupIds) {
  const d = document.createElement('details');
  d.className = 'tool-group' +
    (group.running ? ' running' : '') +
    (group.failed ? ' failed' : '');
  d.dataset.groupId = group.id || '';
  d.dataset.streamKey =
    group.label + '|' + group.running + '|' + group.failed + '|' +
    group.tools.map((t) =>
      (t.id || '') + ':' + (t.status || '') + ':' + (t.title || '')
    ).join(';');
  const forceOpen =
    !!group.running ||
    (openGroupIds && openGroupIds.has(group.id)) ||
    (openToolIds && group.tools.some((t) => openToolIds.has(t.id)));
  if (forceOpen) d.open = true;
  const summary = document.createElement('summary');
  const first = group.tools[0];
  const ico = first ? toolIconName(first) : 'tool';
  let statusHtml = '';
  if (group.running) {
    statusHtml = statusIcon('in_progress') + '…';
  } else if (group.failed) {
    statusHtml = statusIcon('failed') + esc(String(group.failed) + ' failed');
  } else {
    statusHtml = statusIcon('completed');
  }
  summary.innerHTML =
    '<span class="tool-ico">' + icon(ico) + '</span>' +
    '<span class="tool-group-label">' + esc(group.label || '') + '</span>' +
    '<span class="tool-status">' + statusHtml + '</span>';
  d.appendChild(summary);
  const members = document.createElement('div');
  members.className = 'tool-group-members';
  for (const t of group.tools) {
    const open = openToolIds && openToolIds.has(t.id);
    members.appendChild(renderToolRow(t, open));
  }
  d.appendChild(members);
  return d;
}

/** Build one timeline child for a grouped node. */
function renderTimelineNode(node, openToolIds, openThoughtIds, openGroupIds, streamText) {
  if (node.type === 'text' && node.item) {
    const b = document.createElement('div');
    b.className = 'bubble md';
    fillTextBubble(b, node.item.text || '', node.item.html || '', {
      stream: !!streamText,
    });
    return b;
  }
  if (node.type === 'tool' && node.tool) {
    const open = openToolIds && openToolIds.has(node.tool.id);
    return renderToolRow(node.tool, open);
  }
  if (node.type === 'toolGroup' && node.group) {
    return renderToolGroup(node.group, openToolIds, openGroupIds);
  }
  if (node.type === 'thought' && node.item && node.item.thought) {
    const t = node.item.thought;
    const open =
      !!t.running ||
      (openThoughtIds && openThoughtIds.has(t.id));
    return renderThoughtRow(t, open);
  }
  return null;
}

/**
 * Patch timeline in place when structure matches — only last text/thought/tool
 * content updates. Avoids full DOM replace flicker while tokens stream.
 * Returns true if patched; false if caller should rebuild.
 */
function patchTimelineInPlace(timeline, m, openToolIds, openThoughtIds, openGroupIds) {
  const nodes = visibleGroupedTimeline(m);
  if (nodesTimelineSig(nodes) !== domTimelineSig(timeline)) return false;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const el = timeline.children[i];
    if (!el) return false;
    if (node.type === 'text' && node.item) {
      // Only the live tail text node streams per-character.
      const streamTail = busy && i === nodes.length - 1;
      fillTextBubble(el, node.item.text || '', node.item.html || '', {
        stream: streamTail,
      });
    } else if (node.type === 'tool' && node.tool) {
      const t = node.tool;
      const key =
        (t.status || '') +
        '|' +
        (t.title || '') +
        '|' +
        (t.input || '') +
        '|' +
        (t.output || '') +
        '|' +
        ((t.paths && t.paths.join(',')) || '');
      if (el.dataset.streamKey !== key) {
        const wasOpen = el.open || (openToolIds && openToolIds.has(t.id));
        const next = renderToolRow(t, wasOpen);
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === 'toolGroup' && node.group) {
      const g = node.group;
      const key =
        g.label + '|' + g.running + '|' + g.failed + '|' +
        g.tools.map((t) =>
          (t.id || '') + ':' + (t.status || '') + ':' + (t.title || '')
        ).join(';');
      if (el.dataset.streamKey !== key) {
        const wasOpen =
          el.open ||
          (openGroupIds && openGroupIds.has(g.id)) ||
          !!g.running;
        const next = renderToolGroup(g, openToolIds, openGroupIds);
        if (wasOpen) next.open = true;
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === 'thought' && node.item && node.item.thought) {
      const th = node.item.thought;
      const forceOpen =
        !!th.running ||
        (openThoughtIds && openThoughtIds.has(th.id)) ||
        el.open;
      fillThoughtBlock(el, th);
      el.open = forceOpen;
    }
  }
  timeline.classList.add('stream-settled');
  return true;
}

/** Build timeline nodes (thoughts + text + tools) in stream order. */
function renderAssistantTimeline(m, openToolIds, openThoughtIds, openGroupIds) {
  const timeline = document.createElement('div');
  timeline.className = 'assistant-timeline';
  const nodes = visibleGroupedTimeline(m);
  for (let i = 0; i < nodes.length; i++) {
    const streamText = busy && i === nodes.length - 1 && nodes[i].type === 'text';
    const el = renderTimelineNode(
      nodes[i], openToolIds, openThoughtIds, openGroupIds, streamText,
    );
    if (el) timeline.appendChild(el);
  }
  // After first frame, only newly appended blocks (class tl-new) animate.
  requestAnimationFrame(() => timeline.classList.add('stream-settled'));
  return timeline;
}

/**
 * When structure only grows at the end (new top-level nodes), update prefix
 * content in place and append new nodes. Group fold (1 tool → "Read 2 files")
 * changes the prefix signature, so the caller rebuilds instead.
 */
function appendTimelineDelta(timeline, m, openToolIds, openThoughtIds, openGroupIds) {
  const nodes = visibleGroupedTimeline(m);
  const domCount = timeline.children.length;
  if (domCount === 0 || nodes.length <= domCount) return false;
  const prefixNodes = nodes.slice(0, domCount);
  if (nodesTimelineSig(prefixNodes) !== domTimelineSig(timeline)) return false;

  // Patch prefix content without requiring full-list signature match.
  for (let i = 0; i < prefixNodes.length; i++) {
    const node = prefixNodes[i];
    const el = timeline.children[i];
    if (!el) return false;
    if (node.type === 'text' && node.item) {
      // Prefix nodes are never the growing tail when we append after them.
      fillTextBubble(el, node.item.text || '', node.item.html || '', {
        stream: false,
      });
    } else if (node.type === 'tool' && node.tool) {
      const t = node.tool;
      const key =
        (t.status || '') + '|' + (t.title || '') + '|' +
        (t.input || '') + '|' + (t.output || '') + '|' +
        ((t.paths && t.paths.join(',')) || '');
      if (el.dataset.streamKey !== key) {
        const wasOpen = el.open || (openToolIds && openToolIds.has(t.id));
        const next = renderToolRow(t, wasOpen);
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === 'toolGroup' && node.group) {
      const g = node.group;
      const key =
        g.label + '|' + g.running + '|' + g.failed + '|' +
        g.tools.map((t) =>
          (t.id || '') + ':' + (t.status || '') + ':' + (t.title || '')
        ).join(';');
      if (el.dataset.streamKey !== key) {
        const wasOpen =
          el.open ||
          (openGroupIds && openGroupIds.has(g.id)) ||
          !!g.running;
        const next = renderToolGroup(g, openToolIds, openGroupIds);
        if (wasOpen) next.open = true;
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === 'thought' && node.item && node.item.thought) {
      const th = node.item.thought;
      const forceOpen =
        !!th.running ||
        (openThoughtIds && openThoughtIds.has(th.id)) ||
        el.open;
      fillThoughtBlock(el, th);
      el.open = forceOpen;
    }
  }
  for (let i = domCount; i < nodes.length; i++) {
    const streamText = busy && i === nodes.length - 1 && nodes[i].type === 'text';
    const el = renderTimelineNode(
      nodes[i], openToolIds, openThoughtIds, openGroupIds, streamText,
    );
    if (!el) continue;
    el.classList.add('tl-new');
    timeline.appendChild(el);
  }
  timeline.classList.add('stream-settled');
  return true;
}

function collectOpenToolIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll('details.tool-row[open]').forEach((el) => {
    const id = el.dataset.toolId;
    if (id) ids.add(id);
  });
  return ids;
}

function collectOpenThoughtIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll('details.thought[open]').forEach((el) => {
    const id = el.dataset.thoughtId;
    if (id) ids.add(id);
  });
  return ids;
}

function collectOpenGroupIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll('details.tool-group[open]').forEach((el) => {
    const id = el.dataset.groupId;
    if (id) ids.add(id);
  });
  return ids;
}

/**
 * Plain text for copy. Prefer live allMessages entry — streaming patches the
 * DOM/timeline without remounting actions, so the closed-over m is often the
 * empty optimistic assistant from first paint.
 */
function messageCopyPlain(m) {
  if (!m) return '';
  if (m.type === 'user' || m.type === 'system') return (m.text || '').trim();
  if (m.type === 'assistant') {
    if (m.text && String(m.text).trim()) return String(m.text);
    const items = Array.isArray(m.items) ? m.items : [];
    const parts = [];
    for (const it of items) {
      if (it && it.kind === 'text' && it.text) parts.push(it.text);
    }
    return parts.join('\\n\\n').trim();
  }
  return '';
}

/** Visible text from rendered assistant bubbles (fallback when model data is stale). */
function messageCopyFromDom(wrap) {
  if (!wrap) return '';
  if (wrap.classList.contains('user') || wrap.classList.contains('system')) {
    const b = wrap.querySelector(':scope > .bubble');
    return ((b && (b.innerText || b.textContent)) || '').trim();
  }
  // Assistant: text bubbles only (skip tools / thoughts).
  const bubbles = wrap.querySelectorAll(
    ':scope > .assistant-timeline > .bubble.md, :scope > .bubble.md',
  );
  const parts = [];
  bubbles.forEach((b) => {
    let t = (b.innerText || b.textContent || '').trim();
    // Drop code-block "Copy" button label if present at start of pre text.
    t = t.replace(/^Copy\\n?/gm, '').trim();
    if (t) parts.push(t);
  });
  return parts.join('\\n\\n').trim();
}

function flashCopyBtn(copyBtn) {
  copyBtn.classList.add('copied');
  copyBtn.innerHTML = icon('check');
  setTimeout(() => {
    copyBtn.classList.remove('copied');
    copyBtn.innerHTML = icon('copy');
  }, 1200);
}

function renderMsgActions(m) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Message actions');

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-act-copy msg-act-icon';
  copyBtn.title = 'Copy';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.innerHTML = icon('copy');
  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = copyBtn.closest('.msg');
    const live =
      (m && m.id && allMessages.find((x) => x && x.id === m.id)) || m;
    let text = messageCopyPlain(live);
    if (!text) text = messageCopyFromDom(wrap);
    if (!text) return;
    // Host clipboard is reliable in VS Code webviews; navigator is best-effort.
    vscode.postMessage({ type: 'copyText', text: text });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { /* host already has it */ });
    }
    flashCopyBtn(copyBtn);
  });
  bar.appendChild(copyBtn);

  if (m.type === 'user') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'msg-act-edit msg-act-icon';
    editBtn.title = 'Edit and resubmit';
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.innerHTML = icon('pencil');
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Resolve from allMessages so we always use the live list entry.
      const live =
        (m && m.id && allMessages.find((x) => x && x.id === m.id && x.type === 'user')) || m;
      enterUserMessageEdit(live);
    });
    bar.appendChild(editBtn);
  }
  return bar;
}

/**
 * Composer-based edit of a previous user prompt (TUI inline-edit intent).
 * Click Edit → draft lands in composer; Send opens rewind-mode popover.
 */
let pendingEdit = null; // { id, promptIndex?, original }
let rewindOpen = false;
let rewindIndex = 0;
const REWIND_MODES = [
  {
    mode: 'all',
    label: 'Both conversation and file changes',
    detail: 'Rewind chat and revert file snapshots from this prompt',
  },
  {
    mode: 'conversation_only',
    label: 'Conversation only',
    detail: 'Rewind chat only — leave workspace files as they are',
  },
];

const editBanner = document.getElementById('edit-banner');
const editBannerCancel = document.getElementById('edit-banner-cancel');
const rewindPopover = document.getElementById('rewind-popover');
const rewindList = document.getElementById('rewind-list');

function updateEditBanner() {
  if (!editBanner) return;
  editBanner.hidden = !pendingEdit;
  if (pendingEdit) {
    composer.placeholder = 'Edit message… (Enter resubmit · Esc cancel)';
  } else {
    composer.placeholder = 'Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)';
  }
  updateSendStopButton();
}

function clearPendingEdit(opts) {
  const keepText = !!(opts && opts.keepText);
  pendingEdit = null;
  closeRewindPopover();
  if (!keepText) {
    // Leave composer alone if caller already set draft / cleared it.
  }
  updateEditBanner();
}

function cancelPendingEdit() {
  if (!pendingEdit) return;
  pendingEdit = null;
  closeRewindPopover();
  composer.value = '';
  autosizeComposer();
  updateEditBanner();
  renderMessages(allMessages, { force: true });
  composer.focus();
}

function enterUserMessageEdit(m) {
  if (!m || m.type !== 'user' || !m.id) return;
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  closeRewindPopover();
  pendingEdit = {
    id: m.id,
    promptIndex: typeof m.promptIndex === 'number' ? m.promptIndex : undefined,
    original: (m.text || '').trim(),
  };
  composer.value = m.text || '';
  autosizeComposer();
  updateEditBanner();
  // Highlight source bubble
  renderMessages(allMessages, { force: true });
  composer.focus();
  const len = composer.value.length;
  try { composer.setSelectionRange(len, len); } catch (_) { /* ignore */ }
}

function restoreEditComposer(id, text) {
  const draft = text != null ? String(text) : '';
  const src = allMessages.find((m) => m && m.id === id && m.type === 'user');
  pendingEdit = {
    id: id,
    promptIndex:
      src && typeof src.promptIndex === 'number' ? src.promptIndex : undefined,
    original: src ? (src.text || '').trim() : '',
  };
  composer.value = draft;
  autosizeComposer();
  updateEditBanner();
  composer.focus();
}

function closeRewindPopover() {
  rewindOpen = false;
  rewindIndex = 0;
  if (rewindPopover) rewindPopover.hidden = true;
}

function renderRewindList() {
  if (!rewindList) return;
  rewindList.innerHTML = REWIND_MODES.map((item, i) =>
    '<button type="button" class="rewind-item' + (i === rewindIndex ? ' active' : '') +
    '" data-rewind-idx="' + i + '" role="option" aria-selected="' +
    (i === rewindIndex ? 'true' : 'false') + '">' +
    '<span class="rewind-label">' + esc(item.label) + '</span>' +
    '<span class="rewind-detail">' + esc(item.detail) + '</span>' +
    '</button>'
  ).join('');
  const active = rewindList.querySelector('.rewind-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function openRewindPopover() {
  if (!pendingEdit) return;
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  rewindOpen = true;
  rewindIndex = 0;
  if (rewindPopover) rewindPopover.hidden = false;
  renderRewindList();
}

function moveRewind(delta) {
  if (!REWIND_MODES.length) return;
  rewindIndex = (rewindIndex + delta + REWIND_MODES.length) % REWIND_MODES.length;
  renderRewindList();
}

function acceptRewind(idx) {
  const item = REWIND_MODES[idx];
  if (!item || !pendingEdit) return;
  const text = composer.value.trim();
  if (!text) {
    closeRewindPopover();
    return;
  }
  const pe = pendingEdit;
  closeRewindPopover();
  pendingEdit = null;
  updateEditBanner();
  composer.value = '';
  autosizeComposer();
  updateSendStopButton();
  renderMessages(allMessages, { force: true });
  vscode.postMessage({
    type: 'editMessage',
    id: pe.id,
    text: text,
    promptIndex: pe.promptIndex,
    mode: item.mode,
  });
}

/** True when a dismissible (non-modal) popover is open. */
function anyDropdownOpen() {
  return !!(modelOpen || effortOpen || slashOpen || mentionOpen || rewindOpen);
}

/**
 * Close popovers when clicking outside them.
 * - Model / effort / slash / mention / rewind: dismiss
 * - Permission / question: modal — only cancel if click is fully outside
 *   those dialogs (not on their chrome)
 * - Toggle buttons (#btn-model / #btn-effort) are excluded so click can toggle
 * - Composer keeps slash/mention open (filter still driven by typing)
 */
document.addEventListener('pointerdown', (e) => {
  if (!anyDropdownOpen() && !permissionOpen && !questionOpen) return;
  const t = e.target;
  if (!t || !t.closest) return;

  // Inside any popover surface — leave open.
  if (t.closest(
    '#model-popover, #effort-popover, #slash-popover, #mention-popover, ' +
    '#rewind-popover, #permission-popover, #question-popover',
  )) {
    return;
  }

  // Model/effort toggle buttons: their click handlers own open/close.
  if (t.closest('#btn-model, #btn-effort')) {
    return;
  }

  // Composer / shell: dismiss model/effort/rewind but keep slash/mention.
  if (t.closest('#composer, .composer-shell, #edit-banner')) {
    if (modelOpen) closeModelPopover();
    if (effortOpen) closeEffortPopover();
    if (rewindOpen) closeRewindPopover();
    return;
  }

  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  if (slashOpen) closeSlash();
  if (mentionOpen) closeMention();
  if (rewindOpen) closeRewindPopover();

  // Modal dialogs: outside click = cancel (same as Esc).
  if (permissionOpen) {
    closePermissionPopover({ outcome: 'cancelled' });
  }
  if (questionOpen) {
    closeQuestionPopover({ outcome: 'cancelled' });
  }
}, true);

/** Send path when a composer edit is pending: open mode popover or no-op. */
function trySubmitPendingEdit() {
  if (!pendingEdit) return false;
  const text = composer.value.trim();
  if (!text) return true; // swallow empty
  if (text === pendingEdit.original) {
    // Unchanged → just cancel edit mode (TUI Enter-with-same exits).
    cancelPendingEdit();
    return true;
  }
  openRewindPopover();
  return true;
}

if (editBannerCancel) {
  editBannerCancel.addEventListener('click', () => cancelPendingEdit());
}
if (rewindList) {
  rewindList.addEventListener('mousedown', (e) => e.preventDefault());
  rewindList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rewind-idx]');
    if (!btn) return;
    acceptRewind(Number(btn.getAttribute('data-rewind-idx')));
  });
}

function renderOneMessage(m, isNew) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.type + (isNew ? ' msg-enter' : '');
  wrap.dataset.msgId = m.id || '';
  if (m.type === 'user' && typeof m.promptIndex === 'number') {
    wrap.dataset.promptIndex = String(m.promptIndex);
  }
  if (m.type === 'assistant' && busy) {
    // Only the live tail should show stream caret — refined after append.
    wrap.classList.add('streaming');
  }
  if (m.type === 'user') {
    if (m.chips && m.chips.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.innerHTML = m.chips.map(c =>
        '<span class="chip">' + icon(chipIcon(c)) + esc(c) + '</span>'
      ).join('');
      wrap.appendChild(chips);
    }
    if (pendingEdit && m.id === pendingEdit.id) {
      wrap.classList.add('editing');
    }
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.text || '';
    wrap.appendChild(b);
    wrap.appendChild(renderMsgActions(m));
  } else if (m.type === 'assistant') {
    // Thoughts live on the timeline with tools/text (TUI scrollback order).
    wrap.appendChild(renderAssistantTimeline(m, null, null, null));
    wrap.appendChild(renderMsgActions(m));
  } else {
    // System lifecycle/info: full-width dashed separator with text in the middle.
    const b = document.createElement('div');
    b.className = 'bubble system-sep';
    const left = document.createElement('span');
    left.className = 'system-sep-line';
    left.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'system-sep-text';
    text.textContent = m.text || '';
    const right = document.createElement('span');
    right.className = 'system-sep-line';
    right.setAttribute('aria-hidden', 'true');
    b.appendChild(left);
    b.appendChild(text);
    b.appendChild(right);
    wrap.appendChild(b);
  }
  return wrap;
}

/** Same length + same prefix ids; only last assistant streams — patch that node. */
function isStreamingTailUpdate(prev, next) {
  if (!next.length || prev.length !== next.length) return false;
  const last = next[next.length - 1];
  if (!last || last.type !== 'assistant') return false;
  for (let i = 0; i < next.length - 1; i++) {
    const a = prev[i], b = next[i];
    if (!a || !b || a.id !== b.id || a.type !== b.type) return false;
  }
  const prevLast = prev[prev.length - 1];
  return !!(prevLast && prevLast.id === last.id && prevLast.type === 'assistant');
}

/** Message ids already mounted — used so re-renders don't re-play enter anim. */
const seenMsgIds = new Set();
let stickScrollRaf = 0;
let stickScrollWanted = false;

/**
 * Follow stream to bottom without fighting the browser.
 * rAF-coalesced; small growth snaps, large jumps ease via scrollTo.
 */
function requestStickScroll(opts) {
  const force = !!(opts && opts.force);
  const smooth = !!(opts && opts.smooth);
  if (!force) {
    const near = shouldStickToBottom(
      messagesEl.scrollTop,
      messagesEl.scrollHeight,
      messagesEl.clientHeight,
      busy ? 96 : 48,
    );
    if (!near) return;
  }
  stickScrollWanted = true;
  if (stickScrollRaf) return;
  stickScrollRaf = requestAnimationFrame(() => {
    stickScrollRaf = 0;
    if (!stickScrollWanted) return;
    stickScrollWanted = false;
    const max = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    const delta = max - messagesEl.scrollTop;
    if (delta <= 1) return;
    if (smooth && delta > 80 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      messagesEl.scrollTo({ top: max, behavior: 'smooth' });
    } else {
      messagesEl.scrollTop = max;
    }
  });
}

function patchLastAssistant(m) {
  // Prefer data-msg-id; fall back to last .msg.assistant in the list.
  let wrap = m.id
    ? messagesEl.querySelector('.msg.assistant[data-msg-id="' + CSS.escape(m.id) + '"]')
    : null;
  if (!wrap) {
    const nodes = messagesEl.querySelectorAll('.msg.assistant');
    wrap = nodes.length ? nodes[nodes.length - 1] : null;
  }
  if (!wrap) return false;

  // Preserve which tool/thought rows the user has expanded across stream patches.
  const openToolIds = collectOpenToolIds(wrap);
  const openThoughtIds = collectOpenThoughtIds(wrap);
  const openGroupIds = collectOpenGroupIds(wrap);

  // Drop legacy top-level thought (pre-timeline); everything is in the timeline now.
  wrap.querySelectorAll(':scope > details.thought').forEach((el) => el.remove());

  wrap.classList.toggle('streaming', !!busy);

  const oldTimeline = wrap.querySelector(':scope > .assistant-timeline');
  if (oldTimeline) {
    if (patchTimelineInPlace(oldTimeline, m, openToolIds, openThoughtIds, openGroupIds)) {
      return true;
    }
    if (appendTimelineDelta(oldTimeline, m, openToolIds, openThoughtIds, openGroupIds)) {
      return true;
    }
  }
  const nextTimeline = renderAssistantTimeline(m, openToolIds, openThoughtIds, openGroupIds);
  if (oldTimeline) oldTimeline.replaceWith(nextTimeline);
  else wrap.appendChild(nextTimeline);
  return true;
}

function renderMessages(messages, opts) {
  const force = !!(opts && opts.force);
  const next = messages || [];
  const stick = shouldStickToBottom(
    messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight,
    busy ? 96 : 48,
  );

  // Streaming fast path: only the last assistant bubble changed — avoid wiping
  // the whole list (main source of UI jank / flicker while tokens arrive).
  if (
    !force &&
    allMessages.length > 0 &&
    isStreamingTailUpdate(allMessages, next) &&
    allMessages.length <= VIRT_THRESHOLD
  ) {
    allMessages = next;
    emptyEl.hidden = true;
    if (patchLastAssistant(next[next.length - 1])) {
      if (stick) requestStickScroll({ force: true });
      return;
    }
  }

  const prevIds = new Set(allMessages.map((m) => m && m.id).filter(Boolean));
  allMessages = next;
  emptyEl.hidden = allMessages.length > 0;
  messagesEl.innerHTML = '';

  let start = 0;
  let end = allMessages.length;
  if (allMessages.length > VIRT_THRESHOLD) {
    const w = computeVirtualWindow({
      total: allMessages.length,
      scrollTop: messagesEl.scrollTop,
      viewportHeight: messagesEl.clientHeight || 400,
      estimatedRowHeight: EST_ROW,
      overscan: 6,
    });
    start = w.start;
    end = w.end;
    const top = document.createElement('div');
    top.className = 'vspacer';
    top.style.height = (start * EST_ROW) + 'px';
    messagesEl.appendChild(top);
  }

  for (let i = start; i < end; i++) {
    const m = allMessages[i];
    // Enter anim only for messages that just appeared (not history load / re-mount).
    const isNew = !!(m && m.id && !prevIds.has(m.id) && prevIds.size > 0);
    messagesEl.appendChild(renderOneMessage(m, isNew));
    if (m && m.id) seenMsgIds.add(m.id);
  }

  if (allMessages.length > VIRT_THRESHOLD) {
    const bottom = document.createElement('div');
    bottom.className = 'vspacer';
    bottom.style.height = ((allMessages.length - end) * EST_ROW) + 'px';
    messagesEl.appendChild(bottom);
  }

  // Prune seen ids that left the conversation
  const live = new Set(allMessages.map((m) => m && m.id).filter(Boolean));
  for (const id of seenMsgIds) {
    if (!live.has(id)) seenMsgIds.delete(id);
  }

  // Mark last assistant streaming state
  const lastAsst = messagesEl.querySelector('.msg.assistant:last-of-type');
  if (lastAsst) lastAsst.classList.toggle('streaming', !!busy);

  if (stick || allMessages.length <= VIRT_THRESHOLD) {
    requestStickScroll({ force: true, smooth: true });
  }
}

function renderSticky() {
  let html = '';
  // Always use the same chip shell for auto on/off (same icons + label + action slot)
  // so toggling does not reflow the sticky row.
  if (autoChip) {
    const on = !!autoAttachEnabled;
    const title = on
      ? 'Auto-attached from focused editor — click × to disable'
      : 'Auto-attach off — click to enable for focused file';
    const action = on
      ? '<button type="button" data-auto-toggle="0" title="Disable auto-attach">×</button>'
      : '<button type="button" data-auto-toggle="1" title="Enable auto-attach">' +
          icon('plus') + '</button>';
    html +=
      '<span class="chip chip-auto' + (on ? '' : ' chip-auto-off') + '" title="' + esc(title) + '"' +
        (on ? '' : ' data-auto-toggle="1" role="button" tabindex="0"') + '>' +
        '<span class="chip-badge" aria-hidden="true">' + icon('focus-2') + '</span>' +
        icon(chipIcon(autoChip.label)) +
        '<span class="chip-label">' + esc(autoChip.label) + '</span>' +
        action +
      '</span>';
  }
  html += stickyChips.map(c =>
    '<span class="chip">' + icon(chipIcon(c.label)) +
    '<span class="chip-label">' + esc(c.label) + '</span>' +
    '<button type="button" data-chip-id="' + esc(c.id) + '" title="Remove">×</button></span>'
  ).join('');
  stickyEl.innerHTML = html;
}

function setMeta(text, spinning) {
  meta.innerHTML = (spinning ? icon('loader', 'ti-spin') : icon('circle-dashed')) +
    '<span>' + esc(text) + '</span>';
}

// Top-right context bar — TUI style: 8.5K / 200K (used / context window).
function renderContextBar(c) {
  if (!c || !c.visible || !c.text) {
    ctxBarEl.hidden = true;
    ctxBarEl.textContent = '';
    ctxBarEl.className = '';
    ctxBarEl.removeAttribute('title');
    return;
  }
  ctxBarEl.hidden = false;
  ctxBarEl.textContent = c.text;
  ctxBarEl.className = 'level-' + (c.level || 'ok');
  ctxBarEl.title = c.title || ('Context ' + c.text);
}

function renderTurnStatus(s) {
  if (!s) return;
  if (s.context) renderContextBar(s.context);

  if (!s.visible) {
    turnStatusEl.hidden = true;
    turnStatusEl.classList.remove('busy');
    return;
  }
  turnStatusEl.hidden = false;
  turnStatusEl.classList.toggle('busy', !!s.spinning);
  tsProcess.textContent = s.process || '';
  tsTime.textContent = s.time || '';
  tsTokens.textContent = s.tokens || '';
  tsCost.textContent = s.cost || '';
  tsTime.style.display = s.time ? '' : 'none';
  tsTokens.style.display = s.tokens ? '' : 'none';
  tsCost.style.display = s.cost ? '' : 'none';
}

function setBusy(b) {
  const wasBusy = busy;
  busy = b;
  composer.disabled = cliMissing;
  if (b) setMeta('working…', true);
  else setMeta(meta.dataset.base || 'idle', false);
  // Mark live assistant while turn is running (styling / stream path).
  messagesEl.querySelectorAll('.msg.assistant.streaming').forEach((el) => {
    el.classList.remove('streaming');
  });
  if (b) {
    const nodes = messagesEl.querySelectorAll('.msg.assistant');
    const last = nodes.length ? nodes[nodes.length - 1] : null;
    if (last) last.classList.add('streaming');
  } else if (wasBusy) {
    // Turn ended: re-render tail so plain stream chars become full markdown.
    const lastMsg =
      allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    if (lastMsg && lastMsg.type === 'assistant') {
      patchLastAssistant(lastMsg);
    }
  }
  updateSendStopButton();
}

/**
 * While a turn is running and the composer is empty, the primary action is Stop.
 * Typing into the composer switches back to Send (still blocked until idle).
 */
function updateSendStopButton() {
  const empty = !composer.value.trim();
  const asStop = busy && empty && !cliMissing;
  sendBtn.classList.toggle('is-stop', asStop);
  // Block send while CLI missing; otherwise only disable when busy with draft.
  sendBtn.disabled = cliMissing || (busy && !empty);
  if (cliMissing) {
    sendBtn.innerHTML = '<i class="ti ti-send"></i> Send';
    sendBtn.title = 'Install Grok Build CLI first';
    sendBtn.setAttribute('aria-label', 'Send (disabled — CLI missing)');
  } else if (asStop) {
    sendBtn.innerHTML = '<i class="ti ti-player-stop"></i> Stop';
    sendBtn.title = 'Stop current turn (Esc)';
    sendBtn.setAttribute('aria-label', 'Stop');
  } else if (pendingEdit) {
    sendBtn.innerHTML = '<i class="ti ti-check"></i> Resubmit';
    sendBtn.title = 'Resubmit edited message (choose rewind mode)';
    sendBtn.setAttribute('aria-label', 'Resubmit');
  } else {
    sendBtn.innerHTML = '<i class="ti ti-send"></i> Send';
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', 'Send');
  }
}

function setReview(count) {
  if (count > 0) {
    reviewBar.classList.add('visible');
    reviewLabel.textContent = 'Review edits (' + count + ')';
  } else {
    reviewBar.classList.remove('visible');
  }
}

messagesEl.addEventListener('scroll', () => {
  if (allMessages.length > VIRT_THRESHOLD) {
    const stick = shouldStickToBottom(
      messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight
    );
    if (!stick) renderMessages(allMessages);
  }
});

messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-path]');
  if (a) {
    e.preventDefault();
    vscode.postMessage({ type: 'openFile', path: a.getAttribute('data-path') });
    return;
  }
  const d = e.target.closest('[data-diff]');
  if (d) {
    e.preventDefault();
    vscode.postMessage({ type: 'openDiff', path: d.getAttribute('data-diff') });
  }
});

stickyEl.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-auto-toggle]');
  if (toggle) {
    const enabled = toggle.getAttribute('data-auto-toggle') === '1';
    vscode.postMessage({ type: 'setAutoAttach', enabled });
    return;
  }
  const btn = e.target.closest('[data-chip-id]');
  if (btn) {
    vscode.postMessage({ type: 'removeChip', id: btn.getAttribute('data-chip-id') });
  }
});

sendBtn.addEventListener('click', () => {
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  if (rewindOpen) {
    acceptRewind(rewindIndex);
    return;
  }
  // Busy + empty → Stop; otherwise Send
  if (busy && !composer.value.trim()) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  if (trySubmitPendingEdit()) return;
  const text = composer.value.trim();
  if (!text || busy) return;
  vscode.postMessage({ type: 'send', text });
  composer.value = '';
  autosizeComposer();
  updateSendStopButton();
});

btnModel.addEventListener('click', () => {
  if (modelOpen) closeModelPopover();
  else openModelPopover();
});
btnEffort.addEventListener('click', () => {
  if (effortOpen) closeEffortPopover();
  else openEffortPopover();
});
document.getElementById('empty-start').addEventListener('click', () =>
  vscode.postMessage({ type: 'startAgent' }));
document.getElementById('empty-auth').addEventListener('click', () => {
  const btn = document.getElementById('empty-auth');
  const action = (btn && btn.getAttribute('data-action')) || 'login';
  vscode.postMessage({ type: action === 'logout' ? 'logout' : 'login' });
});
document.getElementById('empty-copy-install')?.addEventListener('click', () =>
  vscode.postMessage({ type: 'copyInstallCommand' }));
document.getElementById('empty-install-cmd')?.addEventListener('click', () =>
  vscode.postMessage({ type: 'copyInstallCommand' }));
document.getElementById('empty-install-cmd')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    vscode.postMessage({ type: 'copyInstallCommand' });
  }
});
document.getElementById('empty-recheck')?.addEventListener('click', () =>
  vscode.postMessage({ type: 'recheckCli' }));
document.getElementById('empty-open-docs')?.addEventListener('click', () =>
  vscode.postMessage({ type: 'openInstallDocs' }));
document.getElementById('empty-set-path')?.addEventListener('click', () =>
  vscode.postMessage({ type: 'setBinaryPath' }));
document.getElementById('btn-review').addEventListener('click', () =>
  vscode.postMessage({ type: 'reviewEdits' }));

mentionList.addEventListener('mousedown', (e) => {
  // Prevent composer blur before click completes.
  e.preventDefault();
});
mentionList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-idx]');
  if (!btn) return;
  acceptMention(Number(btn.getAttribute('data-idx')));
});
slashList.addEventListener('mousedown', (e) => {
  e.preventDefault();
});
slashList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-slash-idx]');
  if (!btn) return;
  acceptSlash(Number(btn.getAttribute('data-slash-idx')));
});
modelList.addEventListener('mousedown', (e) => {
  e.preventDefault();
});
modelList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-model-idx]');
  if (!btn) return;
  acceptModel(Number(btn.getAttribute('data-model-idx')));
});
effortList.addEventListener('mousedown', (e) => {
  e.preventDefault();
});
effortList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-effort-idx]');
  if (!btn) return;
  acceptEffort(Number(btn.getAttribute('data-effort-idx')));
});

/** Grow #composer with content; cap at max-height and scroll when full. */
function autosizeComposer() {
  if (!composer) return;
  const minPx = 44; // match #composer min-height
  const maxPx = 180;
  composer.style.height = 'auto';
  const sh = composer.scrollHeight;
  const next = Math.min(Math.max(sh, minPx), maxPx);
  composer.style.height = next + 'px';
  composer.style.overflowY = sh > maxPx ? 'auto' : 'hidden';
}

composer.addEventListener('input', () => {
  autosizeComposer();
  syncComposerMenus();
  updateSendStopButton();
});
composer.addEventListener('click', () => syncComposerMenus());
composer.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    syncComposerMenus();
  }
});

btnMode.addEventListener('click', () => {
  vscode.postMessage({ type: 'cycleMode' });
});

/**
 * Global key handling for ALL popovers (capture phase).
 * Model/effort open from header buttons without focusing the composer — Esc and
 * arrow keys must work even when focus is not in the input.
 */
window.addEventListener('keydown', (e) => {
  if (permissionOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      movePermission(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      movePermission(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (permissionItems.length) {
        e.preventDefault();
        acceptPermission(permissionIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePermissionPopover({ outcome: 'cancelled' });
      return;
    }
  }
  if (questionOpen) {
    const inNotes = document.activeElement === questionNotes;
    if (!inNotes && e.key === 'ArrowDown') {
      e.preventDefault();
      moveQuestion(1);
      return;
    }
    if (!inNotes && e.key === 'ArrowUp') {
      e.preventDefault();
      moveQuestion(-1);
      return;
    }
    if (!inNotes && (e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      toggleQuestionOption(questionIndex);
      return;
    }
    if (!inNotes && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      acceptQuestion();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuestionPopover({ outcome: 'cancelled' });
      return;
    }
  }
  if (modelOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveModel(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveModel(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (modelItems.length) {
        e.preventDefault();
        acceptModel(modelIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModelPopover();
      return;
    }
  }
  if (effortOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveEffort(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveEffort(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (effortItems.length) {
        e.preventDefault();
        acceptEffort(effortIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEffortPopover();
      return;
    }
  }
  if (rewindOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveRewind(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveRewind(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptRewind(rewindIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRewindPopover();
      return;
    }
  }
  if (slashOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSlash(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlash(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (slashItems.length) {
        e.preventDefault();
        acceptSlash(slashIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  if (mentionOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveMention(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveMention(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (mentionItems.length) {
        e.preventDefault();
        acceptMention(mentionIndex);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
  }
}, true);

composer.addEventListener('keydown', (e) => {
  // TUI Shift+Tab: cycle Normal → Plan → Always-Approve (even with draft text).
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    vscode.postMessage({ type: 'cycleMode' });
    return;
  }
  // Popover nav/Esc handled on window capture above — do not also Send/Cancel.
  if (
    permissionOpen ||
    questionOpen ||
    modelOpen ||
    effortOpen ||
    rewindOpen ||
    slashOpen ||
    mentionOpen
  ) {
    return;
  }
  if (pendingEdit && e.key === 'Escape') {
    e.preventDefault();
    cancelPendingEdit();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Enter with empty input while busy → stop; else send
    sendBtn.click();
  }
  if (e.key === 'Escape' && busy) {
    vscode.postMessage({ type: 'cancel' });
  }
});

// Keep Send/Stop + composer height in sync on first paint
autosizeComposer();
updateSendStopButton();

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'init') {
    renderMessages(msg.messages || []);
    stickyChips = msg.stickyChips || [];
    autoAttachEnabled = msg.autoAttachEnabled !== false;
    autoChip = msg.autoChip || null;
    renderSticky();
    setReview(msg.reviewCount || 0);
    applyModelsState(msg);
    applyModeState(msg);
    const base = !msg.cliFound
      ? 'cli missing'
      : (msg.agentState || 'idle') +
        (msg.agentDetail ? ' · ' + String(msg.agentDetail).slice(0, 12) : '');
    meta.dataset.base = base;
    setBusy(!!msg.busy);
    if (msg.turnStatus) renderTurnStatus(msg.turnStatus);
    if (msg.context) renderContextBar(msg.context);
    updateEmptyAuthUi(!!msg.hasAuth, msg.authSummary || '');
    updateEmptyCliUi(
      msg.cliFound !== false,
      msg.installCommand || '',
      msg.installTypicalPath || '',
    );
    // Always show empty install panel when CLI missing (even with leftover messages).
    emptyEl.hidden = msg.cliFound !== false && (msg.messages || []).length > 0;
  } else if (msg.type === 'messages') {
    renderMessages(msg.messages || []);
  } else if (msg.type === 'restoreEditComposer') {
    restoreEditComposer(msg.id, msg.text);
  } else if (msg.type === 'busy') {
    setBusy(!!msg.busy);
  } else if (msg.type === 'turnStatus') {
    renderTurnStatus(msg);
  } else if (msg.type === 'contextBar') {
    renderContextBar(msg);
  } else if (msg.type === 'models') {
    applyModelsState(msg);
  } else if (msg.type === 'mode') {
    applyModeState(msg);
  } else if (msg.type === 'agentState') {
    const base = (msg.state || 'idle') +
      (msg.detail ? ' · ' + String(msg.detail).slice(0, 12) : '');
    meta.dataset.base = base;
    if (!busy) setMeta(base, false);
  } else if (msg.type === 'stickyChips') {
    stickyChips = msg.chips || [];
    renderSticky();
  } else if (msg.type === 'autoContext') {
    autoAttachEnabled = !!msg.enabled;
    autoChip = msg.chip || null;
    renderSticky();
  } else if (msg.type === 'review') {
    setReview(msg.count || 0);
  } else if (msg.type === 'openMention') {
    composer.focus();
    const pos = composer.selectionStart || 0;
    const v = composer.value;
    if (!detectAtContext(v, pos)) {
      const insert = (pos === 0 || /\\s/.test(v[pos - 1] || '')) ? '@' : ' @';
      composer.value = v.slice(0, pos) + insert + v.slice(pos);
      const next = pos + insert.length;
      composer.setSelectionRange(next, next);
      autosizeComposer();
    }
    syncMentionFromComposer();
  } else if (msg.type === 'openModel') {
    openModelPopover();
  } else if (msg.type === 'mentionResults') {
    if (msg.requestId !== mentionRequestId) return;
    mentionItems = msg.items || [];
    mentionIndex = 0;
    if (!mentionOpen) {
      mentionOpen = true;
    }
    renderMentionList();
  } else if (msg.type === 'slashResults') {
    if (msg.requestId !== slashRequestId) return;
    slashItems = msg.items || [];
    slashIndex = 0;
    if (!slashOpen) {
      slashOpen = true;
    }
    renderSlashList();
  } else if (msg.type === 'permissionPrompt') {
    openPermissionPrompt(msg);
  } else if (msg.type === 'closePermissionPrompt') {
    closePermissionPopover(null);
  } else if (msg.type === 'questionPrompt') {
    openQuestionPrompt(msg);
  } else if (msg.type === 'closeQuestionPrompt') {
    closeQuestionPopover(null);
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let n = "";
  for (let i = 0; i < 32; i++) {
    n += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return n;
}
