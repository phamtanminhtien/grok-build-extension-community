import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { pickLoginMethod, promptAndStoreApiKey } from "../auth/authService";
import { formatLogoutMessage } from "../auth/authFlow";
import { getCliInstallInfo, probeGrokBinary } from "../agent/binaryResolver";
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
import {
  AttachImageError,
  AttachedImageStore,
  decodeBase64ToBytes,
  isAllowedImagePath,
  parseImagePathsFromText,
  type AttachedImage,
} from "../context/promptImages";
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
import { logError, logInfo } from "../log/output";
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
  finalizeAssistantStream,
  finishAssistantThoughts,
  formatToolValue,
  nextPromptIndex,
  truncateFromMessageId,
  truncateFromPromptIndex,
  type AssistantItem,
  type ThoughtSegment,
  type ToolCard,
} from "./sessionMessageMerge";
import {
  basenamePath,
  conflictTypeLabel,
  decidePreviewAction,
  formatRewindSuccessMessage,
  modeTruncatesConversation,
  parseRewindArgs,
  serializeModesForUi,
  serializeRewindPointsForUi,
  type RewindMode,
  type RewindPoint,
  type RewindResult,
} from "../agent/rewind";
import { parseSessionNotificationMeta } from "./sessionNotificationMeta";
import {
  billingUsageResponseShape,
  buildBillingUsageParts,
  buildTurnStatusParts,
  formatThoughtHeader,
  parseBillingUsageResponse,
  type BillingUsageSnapshot,
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
import {
  newPromptId,
  queueEntryFirstLine,
  type PromptQueueSnapshot,
} from "../agent/promptQueue";
import { dispatchSlash, runRewindPicker } from "../slash/dispatch";
import { slashRegistry } from "../slash/registry";
import {
  permissionOptionIcon,
  type AskUserQuestionResponse,
  type PermissionPromptPayload,
  type PermissionPromptResult,
  type QuestionPromptPayload,
} from "./interactivePrompt";
import {
  exitPlanModeResponse,
  type ExitPlanModePromptPayload,
  type ExitPlanModeResponse,
} from "../agent/exitPlanMode";
import { bannerTextForEvent } from "../agent/xaiSessionNotification";

/** Image shown in user bubble (live session thumbs). */
export interface MessageImage {
  displayNumber: number;
  mimeType: string;
  thumbUri?: string;
  openPath?: string;
  width?: number;
  height?: number;
  fileName?: string;
}

type UiMessage =
  | {
      type: "user";
      id: string;
      text: string;
      chips?: string[];
      images?: MessageImage[];
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
  images?: MessageImage[];
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
  private imageStore: AttachedImageStore;
  /** Staged files kept after send for history thumbs (session lifetime). */
  private historyImagePaths = new Set<string>();
  private messagesFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private diffs: DiffReviewService | undefined;
  /** In-chat multi-step rewind panel state. */
  private sessionRewind:
    | {
        points: RewindPoint[];
        selected?: RewindPoint;
        mode?: RewindMode;
        busy: boolean;
      }
    | undefined;
  /** True while ACP session/load is replaying history into the UI. */
  private loadingHistory = false;
  private currentUserId: string | undefined;
  /** Avoid re-parsing markdown for messages whose source text has not changed. */
  private readonly mdCache = new Map<string, { key: string; html: string }>();
  /** Live turn clock (ms epoch); cleared when idle. */
  private turnStartedAt: number | undefined;
  private turnProcess = "";
  private sessionUsage: SessionUsageSnapshot = {};
  private billingUsage: BillingUsageSnapshot | undefined;
  private billingRefreshInFlight: Promise<void> | undefined;
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
  /** Pending exit_plan_mode popover. */
  private pendingPlan:
    | {
        promptId: number;
        resolve: (r: ExitPlanModeResponse) => void;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** Centered loading indicator (start / new session) — nest-safe. */
  private blockingLoadCount = 0;
  /** Prompt ids already rendered as user bubbles (idle optimistic or queue adopt). */
  private shownPromptIds = new Set<string>();
  /** Last `runningPromptId` from the shared queue (detect drain → new turn). */
  private lastRunningPromptId: string | undefined;
  /** Local queue edit: composer targets this server row instead of a new send. */
  private editingQueueId: string | undefined;
  /** Subagent panel currently open (live stream id = subagentId or childSessionId). */
  private openSubagentId: string | undefined;
  private liveSubagentFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly auth: AuthService,
    options?: {
      supportsSecondarySidebar?: boolean;
      globalStorageUri?: vscode.Uri;
    },
  ) {
    this.supportsSecondarySidebar = options?.supportsSecondarySidebar ?? true;
    const storageRoot =
      options?.globalStorageUri ??
      vscode.Uri.joinPath(this.extensionUri, ".prompt-images-staging");
    this.imageStore = new AttachedImageStore(
      vscode.Uri.joinPath(storageRoot, "prompt-images").fsPath,
    );
    this.agent.setPermissionPromptUi((p) => this.showPermissionPrompt(p));
    this.agent.setQuestionPromptUi((p) => this.showQuestionPrompt(p));
    this.agent.setPlanApprovalUi((p) => this.showPlanApproval(p));
    this.disposables.push(
      this.agent.onSessionUpdate((n) => this.handleSessionUpdate(n)),
      this.agent.onXaiSessionEvent((n) => this.handleXaiSessionEvent(n)),
      this.agent.onQueueChange((q) => this.handleQueueChange(q)),
      this.agent.onTasksChange(() => this.postTasks()),
      this.agent.onLiveSubagentChange((stream) => {
        this.onLiveSubagentStream(stream);
      }),
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
      this.agent.onStateChange((state) => {
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
        });
        if (state.kind === "ready") {
          void this.refreshBillingUsage();
        } else if (this.billingUsage) {
          this.billingUsage = undefined;
          this.postTurnStatus();
        }
      }),
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
        void this.refreshBillingUsage();
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
      // Profile / gate from agent (auth/info + check_subscription).
      this.agent.onAuthProfileChange(() => {
        void this.pushFullState();
        void this.refreshBillingUsage();
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
      localResourceRoots: this.webviewLocalRoots(),
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
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  async openActivityBarChat(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  async sendFromCommand(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
  }

  /**
   * Open chat and fill the composer draft (does not send).
   * Optionally attach sticky context chips (e.g. file for Fix with Grok).
   */
  async fillComposer(text: string, chips?: ContextChip[]): Promise<void> {
    await this.openChat();
    if (!(await this.waitForWebview(1500))) {
      void vscode.window.showWarningMessage(
        "Grok Build: open the chat panel to fill the composer",
      );
      return;
    }
    if (chips?.length) {
      this.addStickyChips(chips);
    }
    this.post({ type: "setComposer", text });
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
    this.shownPromptIds.clear();
    this.lastRunningPromptId = undefined;
    this.editingQueueId = undefined;
    this.scheduleMessagesPost(true);
    this.postQueue();
    this.postTasks();
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
    this.shownPromptIds.clear();
    this.lastRunningPromptId = undefined;
    this.editingQueueId = undefined;
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
    void this.clearAllImages();
    this.agent.setPermissionPromptUi(undefined);
    this.agent.setQuestionPromptUi(undefined);
    this.agent.setPlanApprovalUi(undefined);
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
    if (this.pendingPlan) {
      const pl = this.pendingPlan;
      this.pendingPlan = undefined;
      if (pl.timer) clearTimeout(pl.timer);
      pl.resolve(exitPlanModeResponse("abandoned"));
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

  /**
   * Plan approval for `x.ai/exit_plan_mode` — dedicated plan panel (not a
   * composer popover): full plan body + Approve / Request changes / Abandon.
   */
  private async showPlanApproval(
    payload: ExitPlanModePromptPayload,
  ): Promise<ExitPlanModeResponse> {
    await this.openChat();
    if (!(await this.waitForWebview())) {
      throw new Error("webview not ready");
    }
    return new Promise<ExitPlanModeResponse>((resolve) => {
      if (this.pendingPlan) {
        const prev = this.pendingPlan;
        this.pendingPlan = undefined;
        if (prev.timer) clearTimeout(prev.timer);
        prev.resolve(exitPlanModeResponse("abandoned"));
      }
      const timer = setTimeout(() => {
        if (this.pendingPlan?.promptId === payload.promptId) {
          this.pendingPlan = undefined;
          this.post({ type: "closePlanApproval" });
          this.pushSystem("Plan approval timed out");
          resolve(exitPlanModeResponse("abandoned"));
        }
      }, payload.timeoutMs);
      this.pendingPlan = {
        promptId: payload.promptId,
        resolve,
        timer,
      };
      const planHtml = renderMarkdownToSafeHtml(payload.planContent || "");
      this.post({
        type: "planApproval",
        promptId: payload.promptId,
        toolCallId: payload.toolCallId,
        hasPlan: payload.hasPlan,
        planContent: payload.planContent,
        planHtml,
      });
    });
  }

  /** Banners from `x.ai/session_notification` (retry, compact, subagent…). */
  private handleXaiSessionEvent(n: {
    sessionId: string;
    events: import("../agent/xaiSessionNotification").XaiSessionEvent[];
  }): void {
    const active = this.agent.getSessionId();
    if (active && n.sessionId && n.sessionId !== active) {
      return;
    }
    for (const ev of n.events) {
      const text = bannerTextForEvent(ev);
      if (text) {
        this.pushSystem(text);
      }
    }
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

  /**
   * When a new turn is injected (queue adopt / next prompt), settle previous
   * assistants so tool/thought loading animations stop on older bubbles.
   */
  private finalizeLiveAssistantForInject(): void {
    const elapsed =
      this.thoughtStartedAt != null
        ? Math.max(0, Date.now() - this.thoughtStartedAt)
        : undefined;
    this.thoughtStartedAt = undefined;

    for (const m of this.messages) {
      if (m.type !== "assistant") continue;
      // Wall-clock freeze only for the open live assistant.
      const isLive = m.id === this.currentAssistantId;
      finalizeAssistantStream(m, isLive ? elapsed : undefined);
    }
  }

  /**
   * After plan Approve / Request changes / Abandon: close the live planning
   * assistant so subsequent session/update chunks append *after* the system
   * banner instead of growing the bubble above it.
   */
  private sealLiveAssistantForPlanBoundary(): void {
    this.finalizeLiveAssistantForInject();
    this.currentAssistantId = undefined;
    this.currentUserId = undefined;
    this.thoughtStartedAt = undefined;
    this.scheduleMessagesPost(true);
  }

  /**
   * Agent leaves plan mode on approve/abandon (`leave_plan_mode_to_default`).
   * Keep the mode button in sync without another set_mode or "Mode: Normal" toast.
   */
  private syncModeAfterPlanExit(): void {
    this.agent.adoptDefaultModeAfterPlanExit();
    this.postModeState(this.agent.getModeState().mode);
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
    const qn = this.agent.getQueue().entries.length;
    const process =
      busy && qn > 0
        ? `${this.turnProcess || "Working…"} · ${qn} queued`
        : this.turnProcess;
    const parts = buildTurnStatusParts(
      {
        busy,
        process,
        elapsedMs,
        usage: this.sessionUsage,
      },
      this.agentContextWindow(),
    );
    const billingUsage = buildBillingUsageParts(this.billingUsage);
    this.post({
      type: "turnStatus",
      ...parts,
      billingUsage,
      queueCount: qn,
    });
    // Always push context bar (even when process row is hidden when idle).
    this.post({
      type: "contextBar",
      ...parts.context,
    });
  }

  private async refreshBillingUsage(): Promise<void> {
    if (this.billingRefreshInFlight) {
      return this.billingRefreshInFlight;
    }
    this.billingRefreshInFlight = (async () => {
      try {
        const raw = await this.agent.requestExt<unknown>("x.ai/billing", {});
        let autoTopupRaw: unknown | undefined;
        try {
          autoTopupRaw = await this.agent.requestExt<unknown>(
            "x.ai/auto-topup-rule",
            {},
          );
        } catch (err) {
          logInfo(`billing auto-topup unavailable: ${errMessage(err)}`);
        }
        const next = parseBillingUsageResponse(raw, autoTopupRaw);
        if (next) {
          this.billingUsage = next;
          logInfo(
            `billing usage ${Math.floor(next.usagePct)}% reset=${next.periodEndIso ?? ""}`,
          );
          this.postTurnStatus();
        } else {
          logInfo(`billing usage empty response (${billingUsageResponseShape(raw)})`);
        }
      } catch (err) {
        logInfo(`billing usage unavailable: ${errMessage(err)}`);
      } finally {
        this.billingRefreshInFlight = undefined;
      }
    })();
    return this.billingRefreshInFlight;
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    path?: string;
    id?: string;
    /** Background work kind for taskKill / taskView. */
    kind?: string;
    query?: string;
    requestId?: number;
    chip?: ContextChip;
    /** When set with pickMention, host skips sticky (inline insert already done). */
    insertText?: string;
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
    expectedVersion?: number;
    orderedIds?: string[];
    newText?: string;
    feedback?: string;
    dataBase64?: string;
    mimeType?: string;
    byteLength?: number;
    fileName?: string;
    paths?: string[];
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushFullState();
        await this.ensureModelsLoaded();
        break;
      case "ensureModels":
        await this.ensureModelsLoaded();
        break;
      case "send": {
        const text = typeof msg.text === "string" ? msg.text : "";
        if (text.trim() || this.imageStore.count() > 0) {
          await this.handleSend(text);
        }
        break;
      }
      case "attachImageBytes":
        await this.handleAttachImageBytes(msg);
        break;
      case "attachImagePaths":
        if (Array.isArray(msg.paths)) {
          await this.handleAttachImagePaths(
            msg.paths.filter((p): p is string => typeof p === "string"),
            "drop",
          );
        }
        break;
      case "dropShiftHint":
        // VS Code steals OS/explorer drops unless Shift is held over webviews.
        void vscode.window.showInformationMessage(
          "Hold Shift while dropping images into Grok chat. Without Shift, VS Code intercepts the drop.",
        );
        break;
      case "attachImagePathsFromPaste":
        if (typeof msg.text === "string" && msg.text.trim()) {
          const paths = parseImagePathsFromText(msg.text);
          if (paths?.length) {
            await this.handleAttachImagePaths(
              paths.filter(isAllowedImagePath),
              "path",
            );
          }
        }
        break;
      case "removeImage":
        if (msg.id) {
          await this.handleRemoveImage(msg.id);
        }
        break;
      case "openImage":
        if (msg.path && typeof msg.path === "string") {
          try {
            await vscode.commands.executeCommand(
              "vscode.open",
              vscode.Uri.file(msg.path),
            );
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "taskKill":
        if (msg.id && typeof msg.kind === "string") {
          try {
            await this.agent.killBackgroundWork(
              msg.id,
              msg.kind as import("../agent/tasksStore").WorkKind,
            );
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "taskView":
        if (msg.id) {
          await this.handleTaskView(String(msg.id));
        }
        break;
      case "tasksRefresh":
        try {
          await this.agent.refreshTasks();
        } catch (err) {
          this.pushSystem(errMessage(err));
        }
        break;
      case "subagentPanelClose":
        this.openSubagentId = undefined;
        break;
      case "subagentPanelRefresh":
        if (msg.id) {
          try {
            // Force snapshot refresh even when live is present.
            this.openSubagentId = String(msg.id);
            const live = this.agent.getLiveSubagent(String(msg.id));
            if (
              live &&
              (live.status === "running" || live.status === "stopping")
            ) {
              this.postLiveSubagentPanel(live, false);
            } else {
              await this.openSubagentPanel(String(msg.id));
            }
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "subagentPanelKill":
        if (msg.id) {
          try {
            await this.agent.killBackgroundWork(String(msg.id), "subagent");
            // Refresh panel to show stopping/cancelled state.
            try {
              await this.openSubagentPanel(String(msg.id));
            } catch {
              this.post({ type: "closeSubagentPanel" });
            }
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "queueRemove":
        if (msg.id) {
          try {
            await this.agent.queueRemove(
              msg.id,
              typeof msg.expectedVersion === "number" ? msg.expectedVersion : 0,
            );
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "queueClear":
        try {
          await this.agent.queueClear();
        } catch (err) {
          this.pushSystem(errMessage(err));
        }
        break;
      case "queueReorder":
        if (Array.isArray(msg.orderedIds) && msg.orderedIds.length > 0) {
          try {
            await this.agent.queueReorder(msg.orderedIds);
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "queueEditStart":
        if (msg.id) {
          const entry = this.agent
            .getQueue()
            .entries.find((e) => e.id === msg.id);
          if (!entry) {
            this.pushSystem("That queue entry is gone.");
            break;
          }
          this.editingQueueId = entry.id;
          this.post({
            type: "queueEditMode",
            active: true,
            id: entry.id,
            text: entry.text,
          });
        }
        break;
      case "queueEditCancel":
        this.editingQueueId = undefined;
        this.post({ type: "queueEditMode", active: false });
        break;
      case "queueInterject":
        if (msg.id) {
          try {
            await this.agent.queueInterject(
              msg.id,
              typeof msg.expectedVersion === "number" ? msg.expectedVersion : 0,
              msg.newText,
            );
          } catch (err) {
            this.pushSystem(errMessage(err));
          }
        }
        break;
      case "queueSendNowTop":
        try {
          const ok = await this.agent.queueSendNowTop();
          if (!ok) {
            // Fall back to cancel (empty Enter with empty queue).
            await this.agent.cancelTurn();
          }
        } catch (err) {
          this.pushSystem(errMessage(err));
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
      case "sessionRewindPick":
        if (typeof msg.promptIndex === "number") {
          await this.sessionRewindPickPoint(msg.promptIndex);
        }
        break;
      case "sessionRewindMode":
        if (
          msg.mode === "all" ||
          msg.mode === "conversation_only" ||
          msg.mode === "files_only"
        ) {
          await this.sessionRewindPickMode(msg.mode);
        }
        break;
      case "sessionRewindConfirm":
        await this.sessionRewindConfirm();
        break;
      case "sessionRewindBack":
        this.sessionRewindBack();
        break;
      case "sessionRewindCancel":
        this.closeSessionRewind();
        break;
      case "sessionRewindFromMessage":
        if (typeof msg.promptIndex === "number") {
          await this.runRewind(String(msg.promptIndex));
        } else {
          await this.runRewind();
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
        await this.runNewSession();
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
      case "acceptAllEdits": {
        if (!this.diffs || this.diffs.getEntries().length === 0) {
          void vscode.window.showInformationMessage("No Grok edits to accept");
          break;
        }
        try {
          const n = this.diffs.getEntries().length;
          await this.diffs.acceptAll();
          void vscode.window.showInformationMessage(
            n === 1 ? "Accepted 1 Grok edit" : `Accepted ${n} Grok edits`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Accept failed: ${errMessage(err)}`,
          );
        }
        break;
      }
      case "rejectAllEdits": {
        if (!this.diffs || this.diffs.getEntries().length === 0) {
          void vscode.window.showInformationMessage("No Grok edits to reject");
          break;
        }
        const n = this.diffs.getEntries().length;
        const choice = await vscode.window.showWarningMessage(
          `Reject all ${n} Grok edit(s)? Disk files will be reverted.`,
          { modal: true },
          "Reject all",
        );
        if (choice !== "Reject all") {
          break;
        }
        try {
          await this.diffs.rejectAll();
          void vscode.window.showInformationMessage(
            n === 1 ? "Rejected 1 Grok edit" : `Rejected ${n} Grok edits`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Reject failed: ${errMessage(err)}`,
          );
        }
        break;
      }
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
            const profile = this.agent.formatAuthProfileSummary(
              after.cliEmail
                ? `CLI session (${after.cliEmail})`
                : "CLI session",
            );
            this.pushSystem(`Signed in with browser — ${profile}`);
            const gate = this.agent.getAccessGate();
            if (gate?.message) {
              this.pushSystem(
                `Access gate: ${gate.message}` +
                  (gate.url ? ` — ${gate.url}` : ""),
              );
            }
          } catch (err) {
            await this.showStartError(err);
          }
        }
        await this.pushFullState();
        break;
      }
      case "pasteAuthCode":
        try {
          await this.agent.pasteAuthCode();
        } catch (err) {
          await this.showStartError(err);
        }
        break;
      case "checkSubscription":
        await this.runCheckSubscription();
        break;
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
        await this.runStartAgent();
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
          await this.runStartAgent();
        } else {
          void vscode.window.showWarningMessage(
            "Still cannot find `grok`. Install the CLI, then try again.",
          );
          await this.pushFullState();
        }
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
              // Inline editor token — accept inserts this into #composer (not sticky).
              insertText: s.insertText,
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
        // Legacy: older webviews added sticky chips. Mentions now insert
        // `@path` into the composer; keep sticky only if insertText is absent.
        if (msg.chip && !msg.insertText) {
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
      case "planApprovalResponse": {
        const promptId = msg.promptId ?? 0;
        const pending = this.pendingPlan;
        if (!pending || pending.promptId !== promptId) {
          break;
        }
        this.pendingPlan = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        const outcome = msg.outcome ?? "abandoned";
        // Plan decision is mid-turn. Seal the planning assistant so the next
        // agent chunks open a *new* bubble *below* the system line (otherwise
        // stream continues into the bubble above "Plan approved").
        this.sealLiveAssistantForPlanBoundary();
        if (outcome === "approved") {
          this.pushSystem("Plan approved — implementing");
          this.syncModeAfterPlanExit();
          pending.resolve(exitPlanModeResponse("approved"));
        } else if (outcome === "cancelled") {
          const feedback = typeof msg.feedback === "string" ? msg.feedback : "";
          this.pushSystem(
            feedback.trim()
              ? `Requested plan changes: ${feedback.trim()}`
              : "Requested plan changes",
          );
          // Stay in plan mode for revisions; new bubble still starts below.
          pending.resolve(exitPlanModeResponse("cancelled", feedback));
        } else {
          this.pushSystem("Plan abandoned");
          this.syncModeAfterPlanExit();
          pending.resolve(exitPlanModeResponse("abandoned"));
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
    // Require CLI before any chat turn — force install if missing.
    const probe = await probeGrokBinary();
    if (!probe.found) {
      await promptMissingCli();
      await this.pushFullState();
      return;
    }

    // Queue-row edit: save via x.ai/queue/edit.
    if (this.editingQueueId) {
      const id = this.editingQueueId;
      this.editingQueueId = undefined;
      this.post({ type: "queueEditMode", active: false });
      try {
        await this.agent.queueEdit(id, text);
        this.pushSystem(
          `Updated queued prompt: ${queueEntryFirstLine(text, 48)}`,
        );
      } catch (err) {
        this.pushSystem(errMessage(err));
      }
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
              text: m.type === "assistant" ? assistantPlainText(m) : m.text,
            })),
        clearUi: () => {
          this.messages = [];
          this.currentAssistantId = undefined;
          this.mdCache.clear();
          this.scheduleMessagesPost(true);
        },
        newSession: async () => {
          await this.runNewSession();
        },
        startAgent: async () => {
          await this.runStartAgent();
        },
        restartAgent: async () => {
          await this.runRestartAgent();
        },
        withHostLoading: (message, fn) => this.withBlockingLoad(message, fn),
        beginHistoryLoad: (sessionId, title) => {
          this.beginHistoryLoad(sessionId, title);
        },
        endHistoryLoad: () => {
          this.endHistoryLoad();
        },
        applyRewindResult: (result) => {
          this.applyRewindResult(result);
        },
        runRewind: async (args) => {
          await this.runRewind(args ?? "");
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

    // Snapshot images for this send (detach from composer; keep files for thumbs).
    const sendImages = this.imageStore.takeForSend();
    for (const img of sendImages) {
      this.historyImagePaths.add(img.stagedPath);
    }
    this.postImageAttachments();

    let blocks;
    let chips;
    let finalText = text;
    try {
      const built = await buildPromptBlocks(text, {
        stickyChips: this.stickyChips,
        images: sendImages,
      });
      blocks = built.blocks;
      chips = built.chips;
      finalText = built.text;
    } catch (err) {
      // Re-attach images on build failure so user can retry.
      for (const img of sendImages) {
        this.historyImagePaths.delete(img.stagedPath);
      }
      // Cannot put back into store easily after take — leave files; push error.
      this.pushSystem(errMessage(err));
      return;
    }

    const msgImages = this.toMessageImages(sendImages);
    const promptId = newPromptId();
    const queueWhileBusy = this.agent.isBusy();

    // Mid-turn: enqueue server-side (TUI immediate send) — do not paint user
    // bubble until the prompt starts running (queue/changed runningPromptId).
    if (queueWhileBusy) {
      this.agent.pushOptimisticQueueEntry(promptId, finalText, "prompt");
      this.turnProcess = "Working…";
      this.beginTurnStatus();
      this.post({ type: "busy", busy: true });
      try {
        await this.agent.ensureStarted();
        // Do not await end of turn — other in-flight prompts may still run.
        void this.agent
          .sendPrompt(blocks, { promptId, queueText: finalText })
          .catch(async (err) => {
            await this.showStartError(err);
            this.pushSystem(errMessage(err));
          });
      } catch (err) {
        await this.showStartError(err);
        this.pushSystem(errMessage(err));
      }
      return;
    }

    const userId = uid();
    this.messages.push({
      type: "user",
      id: userId,
      text: finalText,
      chips: chips.map((c) => c.label),
      images: msgImages,
      promptIndex: nextPromptIndex(this.messages),
    });
    this.shownPromptIds.add(promptId);

    const asstId = uid();
    this.currentAssistantId = asstId;
    this.messages.push(emptyAssistant(asstId));
    this.scheduleMessagesPost(true);
    this.turnProcess = "Working…";
    this.beginTurnStatus();
    this.post({ type: "busy", busy: true });

    try {
      await this.agent.ensureStarted();
      await this.agent.sendPrompt(blocks, {
        promptId,
        queueText: finalText,
      });
    } catch (err) {
      this.currentAssistantId = undefined;
      this.post({ type: "busy", busy: false });
      await this.showStartError(err);
      this.pushSystem(errMessage(err));
    }
  }

  /** Open-file dialog attach (command palette). */
  async attachImagesFromDialog(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"],
      },
    });
    if (!uris?.length) {
      return;
    }
    await this.handleAttachImagePaths(
      uris.map((u) => u.fsPath),
      "dialog",
    );
  }

  private webviewLocalRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, "media"),
      // Staging root so asWebviewUri can load image thumbs
      vscode.Uri.file(this.imageStore.stagingRoot),
    ];
  }

  private toMessageImages(images: AttachedImage[]): MessageImage[] {
    return images.map((img) => ({
      displayNumber: img.displayNumber,
      mimeType: img.mimeType,
      thumbUri: this.thumbUriForPath(img.stagedPath),
      openPath: img.stagedPath,
      width: img.width,
      height: img.height,
      fileName: img.fileName,
    }));
  }

  private thumbUriForPath(fsPath: string): string | undefined {
    const view = this.view ?? this.views.values().next().value;
    if (!view) {
      return undefined;
    }
    try {
      return view.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
    } catch {
      return undefined;
    }
  }

  private postImageAttachments(): void {
    // Extension UI uses image cards only — no TUI `[Image #N]` composer tokens.
    const images = this.imageStore.getAll().map((img) => ({
      id: img.id,
      displayNumber: img.displayNumber,
      mimeType: img.mimeType,
      thumbUri: this.thumbUriForPath(img.stagedPath),
      openPath: img.stagedPath,
      width: img.width,
      height: img.height,
      fileName: img.fileName,
      label: img.fileName || `Image ${img.displayNumber}`,
    }));
    this.post({
      type: "imageAttachments",
      images,
      count: images.length,
    });
  }

  private async handleAttachImageBytes(msg: {
    dataBase64?: string;
    mimeType?: string;
    byteLength?: number;
    fileName?: string;
    source?: string;
  }): Promise<void> {
    if (!msg.dataBase64) {
      return;
    }
    try {
      const bytes = decodeBase64ToBytes(msg.dataBase64);
      if (
        typeof msg.byteLength === "number" &&
        msg.byteLength > 0 &&
        bytes.length !== msg.byteLength
      ) {
        // Prefer decoded length; webview may report original size.
      }
      const source =
        msg.source === "drop"
          ? "drop"
          : msg.source === "dialog"
            ? "dialog"
            : "clipboard";
      const img = await this.imageStore.attachBytes(bytes, {
        source,
        fileName: msg.fileName,
        fromWebviewTransfer: true,
      });
      logInfo(
        `image attached ${source} #${img.displayNumber} ${img.mimeType} ${img.byteLen}b`,
      );
      this.postImageAttachments();
    } catch (err) {
      this.pushSystem(
        err instanceof AttachImageError ? err.message : errMessage(err),
      );
    }
  }

  private async handleAttachImagePaths(
    paths: string[],
    source: "path" | "dialog" | "drop",
  ): Promise<void> {
    let attached = 0;
    for (const p of paths) {
      if (!isAllowedImagePath(p)) {
        continue;
      }
      try {
        const img = await this.imageStore.attachFromPath(
          p,
          source === "dialog" ? "dialog" : source === "drop" ? "drop" : "path",
        );
        attached += 1;
        logInfo(
          `image attached ${source} #${img.displayNumber} ${img.fileName}`,
        );
        this.postImageAttachments();
      } catch (err) {
        this.pushSystem(
          err instanceof AttachImageError ? err.message : errMessage(err),
        );
      }
    }
    if (attached === 0 && paths.length > 0) {
      this.pushSystem("No supported images found to attach.");
    }
  }

  private async handleRemoveImage(id: string): Promise<void> {
    await this.imageStore.remove(id);
    this.postImageAttachments();
  }

  /**
   * Reconcile shared queue UI + adopt a drained prompt into the message list
   * when `runningPromptId` advances (TUI turn-start shim).
   */
  private handleQueueChange(q: PromptQueueSnapshot): void {
    this.postQueue(q);
    // Keep turn-status "N queued" suffix in sync with queue depth.
    if (this.agent.isBusy()) {
      this.postTurnStatus();
    }

    const running = q.runningPromptId;
    if (!running || running === this.lastRunningPromptId) {
      this.lastRunningPromptId = running;
      return;
    }
    const prev = this.lastRunningPromptId;
    this.lastRunningPromptId = running;

    // First observation of this running id: if we never painted a user bubble
    // for it (queued follow-up), adopt it into the transcript now.
    if (this.shownPromptIds.has(running)) {
      return;
    }
    const text = this.agent.getKnownPromptText(running);
    if (!text?.trim()) {
      // Unknown origin (other client) — still mark so we do not thrash.
      this.shownPromptIds.add(running);
      return;
    }

    // Close prior assistant stream focus; drop loading UI on old bubbles.
    this.finalizeLiveAssistantForInject();
    this.currentUserId = undefined;
    this.currentAssistantId = undefined;

    const userId = uid();
    this.messages.push({
      type: "user",
      id: userId,
      text,
      chips: [],
      promptIndex: nextPromptIndex(this.messages),
    });
    this.shownPromptIds.add(running);
    const asstId = uid();
    this.currentAssistantId = asstId;
    this.messages.push(emptyAssistant(asstId));
    // Force full re-render so older assistants lose streaming/shimmer.
    this.scheduleMessagesPost(true);
    this.turnProcess = "Working…";
    this.beginTurnStatus();
    this.post({ type: "busy", busy: true });
    // Explicit settle signal for webview (even if message list patch is skipped).
    this.post({ type: "streamTail", assistantId: asstId });
    logInfo(
      `queue adopt running=${running} prev=${prev ?? "-"} text=${text.slice(0, 48)}`,
    );
  }

  private postQueue(q?: PromptQueueSnapshot): void {
    const snap = q ?? this.agent.getQueue();
    this.post({
      type: "queue",
      sessionId: snap.sessionId,
      runningPromptId: snap.runningPromptId ?? null,
      entries: snap.entries.map((e) => ({
        id: e.id,
        version: e.version,
        kind: e.kind || "prompt",
        text: e.text,
        firstLine: queueEntryFirstLine(e.text),
        position: e.position,
        optimistic: !!e.optimistic,
      })),
    });
  }

  private postTasks(): void {
    const payload = this.agent.getTasksForWebview();
    this.post({
      type: "tasks",
      sessionId: payload.sessionId,
      runningCount: payload.runningCount,
      items: payload.items,
    });
  }

  /** Open output file, in-chat subagent panel, or preview for a work item. */
  private async handleTaskView(id: string): Promise<void> {
    const item = this.agent.getTask(id);
    if (!item) {
      this.pushSystem("That task is no longer listed.");
      return;
    }

    // Subagents: in-webview panel (same chrome as plan panel).
    if (item.kind === "subagent") {
      const subId = item.subagentId ?? item.id;
      try {
        await this.openSubagentPanel(subId);
      } catch (err) {
        this.pushSystem(
          `Subagent ${item.tag}: ${item.label}` +
            (item.detail ? ` — ${item.detail}` : "") +
            ` [${item.status}]` +
            ` — ${errMessage(err)}`,
        );
      }
      return;
    }

    if (item.outputFile) {
      try {
        await vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(item.outputFile),
        );
        return;
      } catch (err) {
        this.pushSystem(errMessage(err));
      }
    }
    if (item.outputPreview) {
      const doc = await vscode.workspace.openTextDocument({
        content: item.outputPreview,
        language: "log",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    this.pushSystem(`No output available for “${item.label}”.`);
  }

  /**
   * Open the in-chat subagent panel. Prefer **live stream** (TUI-style
   * thinking/tools/text) when the child is still registered; fall back to
   * `subagent/get` snapshot markdown when only a finished snapshot exists.
   */
  private async openSubagentPanel(subagentId: string): Promise<void> {
    this.openSubagentId = subagentId;
    const live = this.agent.getLiveSubagent(subagentId);
    if (
      live &&
      (live.status === "running" ||
        live.status === "stopping" ||
        live.messages.length > 0)
    ) {
      this.postLiveSubagentPanel(live, true);
      // Also pull snapshot in background when finished for full output footer.
      if (live.status !== "running" && live.status !== "stopping") {
        void this.mergeSnapshotIntoOpenPanel(subagentId).catch(() => undefined);
      }
      return;
    }
    // Snapshot-only path (completed subagent no longer streaming).
    try {
      const model = await this.agent.getSubagentPanelModel(subagentId);
      const bodyHtml = renderMarkdownToSafeHtml(model.bodyMarkdown);
      this.post({
        type: "subagentPanel",
        subagentId: model.subagentId || subagentId,
        typeLabel: model.typeLabel,
        description: model.description,
        status: model.status,
        statusLabel: model.statusLabel,
        duration: model.duration,
        chips: model.chips,
        canKill: model.canKill,
        live: false,
        bodyHtml,
        messages: [],
      });
    } catch (err) {
      // Last resort: open empty live shell if still running in tasks store.
      const item = this.agent.getTask(subagentId);
      if (item?.kind === "subagent" && item.status === "running") {
        this.post({
          type: "subagentPanel",
          subagentId,
          typeLabel: item.tag,
          description: item.label,
          status: "running",
          statusLabel: "running",
          duration: "…",
          chips: item.detail ? [item.detail] : [],
          canKill: true,
          live: true,
          bodyHtml: "",
          messages: [],
        });
        return;
      }
      throw err;
    }
  }

  private onLiveSubagentStream(
    stream: import("../agent/subagentLiveStore").LiveSubagentStream,
  ): void {
    const open = this.openSubagentId;
    if (!open) {
      return;
    }
    if (open !== stream.subagentId && open !== stream.childSessionId) {
      return;
    }
    // Throttle UI posts while streaming chunks.
    if (this.liveSubagentFlushTimer) {
      return;
    }
    this.liveSubagentFlushTimer = setTimeout(() => {
      this.liveSubagentFlushTimer = undefined;
      const latest = this.agent.getLiveSubagent(stream.subagentId);
      if (latest) {
        this.postLiveSubagentPanel(latest, false);
      }
    }, 50);
  }

  private postLiveSubagentPanel(
    stream: import("../agent/subagentLiveStore").LiveSubagentStream,
    open: boolean,
  ): void {
    const now = Date.now();
    const elapsedMs = Math.max(
      0,
      (stream.finishedAtMs ?? now) - stream.startedAtMs,
    );
    const elapsed =
      elapsedMs < 60_000
        ? `${Math.floor(elapsedMs / 1000)}s`
        : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs / 1000) % 60)}s`;
    const statusLabel =
      stream.status === "running"
        ? "running"
        : stream.status === "stopping"
          ? "stopping"
          : stream.status === "failed"
            ? "failed"
            : stream.status === "cancelled"
              ? "cancelled"
              : "done";
    const chips: string[] = [elapsed];
    if (stream.activity) {
      chips.push(stream.activity);
    }
    // Serialize child timeline with the same pipeline as main chat.
    const messages = this.serializeMessages(
      stream.messages as unknown as UiMessage[],
    );
    this.post({
      type: open ? "subagentPanel" : "subagentPanelUpdate",
      subagentId: stream.subagentId,
      childSessionId: stream.childSessionId,
      typeLabel: stream.typeLabel,
      description: stream.description,
      status: stream.status,
      statusLabel,
      duration: elapsed,
      chips,
      canKill: stream.status === "running" || stream.status === "stopping",
      live: true,
      generation: stream.generation,
      messages,
      bodyHtml: "",
    });
  }

  private async mergeSnapshotIntoOpenPanel(subagentId: string): Promise<void> {
    const model = await this.agent.getSubagentPanelModel(subagentId);
    // Append snapshot output as a system-like footer via bodyHtml only when
    // live messages already cover the stream — skip if still open live.
    const live = this.agent.getLiveSubagent(subagentId);
    if (live && (live.status === "running" || live.status === "stopping")) {
      return;
    }
    if (
      this.openSubagentId !== subagentId &&
      this.openSubagentId !== model.subagentId
    ) {
      return;
    }
    // Re-open as hybrid: keep live messages if any, plus snapshot body for full output.
    const bodyHtml = renderMarkdownToSafeHtml(model.bodyMarkdown);
    const messages = live
      ? this.serializeMessages(live.messages as unknown as UiMessage[])
      : [];
    this.post({
      type: "subagentPanelUpdate",
      subagentId: model.subagentId || subagentId,
      typeLabel: model.typeLabel,
      description: model.description,
      status: model.status,
      statusLabel: model.statusLabel,
      duration: model.duration,
      chips: model.chips,
      canKill: model.canKill,
      live: false,
      messages,
      bodyHtml: messages.length ? "" : bodyHtml,
      snapshotHtml: messages.length ? bodyHtml : undefined,
    });
  }

  /**
   * Apply a successful agent rewind to the chat webview (TUI remove_from).
   * Conversation modes drop later turns; files-only keeps transcript.
   * Prefills composer with `promptText` when the shell provides it.
   */
  applyRewindResult(result: RewindResult): void {
    if (modeTruncatesConversation(result.mode)) {
      this.messages = truncateFromPromptIndex(
        this.messages,
        result.targetPromptIndex,
      ) as UiMessage[];
      this.currentUserId = undefined;
      this.currentAssistantId = undefined;
      this.thoughtStartedAt = undefined;
      this.mdCache.clear();
      this.scheduleMessagesPost(true);
    }
    if (result.promptText?.trim()) {
      this.post({ type: "setComposer", text: result.promptText });
    }
    if (result.revertedFiles.length > 0) {
      this.diffs?.clear();
    }
  }

  /**
   * `/rewind` · command palette · message action.
   * Opens in-chat panel (TUI picker parity); falls back to QuickPick if
   * the webview is not ready.
   */
  async runRewind(args = ""): Promise<void> {
    const parsed = parseRewindArgs(args);
    try {
      if (!this.view) {
        const message = await runRewindPicker(
          {
            agent: this.agent,
            applyRewindResult: (result) => {
              this.applyRewindResult(result);
            },
          },
          args,
        );
        if (message) {
          this.pushSystem(message);
        }
        return;
      }
      await this.openSessionRewind(parsed);
    } catch (err) {
      this.pushSystem(errMessage(err));
      this.post({
        type: "sessionRewind",
        phase: "error",
        error: errMessage(err),
      });
      throw err;
    }
  }

  private async openSessionRewind(opts: {
    targetPromptIndex?: number;
    mode?: RewindMode;
  }): Promise<void> {
    await this.agent.ensureStarted();
    if (this.agent.isBusy()) {
      await this.agent.cancelTurn();
      this.pushSystem("Cancelled current turn for rewind…");
    }
    const points = await this.agent.rewindGetPoints();
    if (points.length === 0) {
      this.pushSystem("No rewind points yet — send a prompt first.");
      return;
    }

    this.sessionRewind = { points, busy: false };
    this.post({
      type: "sessionRewind",
      phase: "points",
      points: serializeRewindPointsForUi(points),
      selectPromptIndex: opts.targetPromptIndex,
    });

    // Optional shortcuts: /rewind 2  or  /rewind 2 conversation_only
    if (opts.targetPromptIndex !== undefined) {
      const hit = points.find((p) => p.promptIndex === opts.targetPromptIndex);
      if (!hit) {
        this.pushSystem(
          `No rewind point for prompt #${opts.targetPromptIndex}`,
        );
        return;
      }
      this.sessionRewind.selected = hit;
      if (opts.mode) {
        if (
          opts.mode === "files_only" &&
          !hit.hasFileChanges &&
          serializeModesForUi(hit).every((m) => m.mode !== "files_only")
        ) {
          this.post({
            type: "sessionRewind",
            phase: "error",
            error:
              "That turn has no file snapshots — pick conversation or both.",
          });
          return;
        }
        await this.sessionRewindPickMode(opts.mode);
        return;
      }
      this.post({
        type: "sessionRewind",
        phase: "mode",
        point: {
          promptIndex: hit.promptIndex,
          label: serializeRewindPointsForUi([hit])[0]!.label,
          description: serializeRewindPointsForUi([hit])[0]!.description,
          hasFileChanges: hit.hasFileChanges,
        },
        modes: serializeModesForUi(hit),
      });
    }
  }

  private async sessionRewindPickPoint(promptIndex: number): Promise<void> {
    const st = this.sessionRewind;
    if (!st || st.busy) {
      return;
    }
    const hit = st.points.find((p) => p.promptIndex === promptIndex);
    if (!hit) {
      return;
    }
    st.selected = hit;
    st.mode = undefined;
    this.post({
      type: "sessionRewind",
      phase: "mode",
      point: {
        promptIndex: hit.promptIndex,
        label: serializeRewindPointsForUi([hit])[0]!.label,
        description: serializeRewindPointsForUi([hit])[0]!.description,
        hasFileChanges: hit.hasFileChanges,
      },
      modes: serializeModesForUi(hit),
    });
  }

  private async sessionRewindPickMode(mode: RewindMode): Promise<void> {
    const st = this.sessionRewind;
    if (!st?.selected || st.busy) {
      return;
    }
    st.mode = mode;
    st.busy = true;
    this.post({
      type: "sessionRewind",
      phase: "busy",
      message: "Checking rewind…",
    });
    try {
      const preview = await this.agent.rewindExecute({
        targetPromptIndex: st.selected.promptIndex,
        mode,
        force: false,
      });
      const decision = decidePreviewAction(preview, mode);
      if (decision.kind === "error") {
        st.busy = false;
        this.post({
          type: "sessionRewind",
          phase: "error",
          error: decision.error,
        });
        return;
      }
      if (decision.kind === "ready") {
        await this.sessionRewindExecute(true);
        return;
      }
      st.busy = false;
      const files =
        decision.kind === "confirm_files"
          ? decision.cleanFiles
          : decision.conflicts.map((c) => c.path);
      const conflicts =
        decision.kind === "confirm_force"
          ? decision.conflicts
          : decision.kind === "confirm_files"
            ? decision.conflicts
            : [];
      this.post({
        type: "sessionRewind",
        phase: "confirm",
        force: decision.kind === "confirm_force",
        promptIndex: st.selected.promptIndex,
        mode,
        title:
          decision.kind === "confirm_force"
            ? `Force rewind past ${conflicts.length} conflict(s)?`
            : `Revert ${files.length} file(s)?`,
        files: files.slice(0, 12).map((p) => ({
          path: p,
          name: basenamePath(p),
        })),
        conflicts: conflicts.slice(0, 12).map((c) => ({
          path: c.path,
          name: basenamePath(c.path),
          label: conflictTypeLabel(c.conflictType),
        })),
        moreFiles: Math.max(0, files.length - 12),
      });
    } catch (err) {
      st.busy = false;
      this.post({
        type: "sessionRewind",
        phase: "error",
        error: errMessage(err),
      });
    }
  }

  private async sessionRewindConfirm(): Promise<void> {
    await this.sessionRewindExecute(true);
  }

  private async sessionRewindExecute(force: boolean): Promise<void> {
    const st = this.sessionRewind;
    if (!st?.selected || !st.mode) {
      return;
    }
    st.busy = true;
    this.post({
      type: "sessionRewind",
      phase: "busy",
      message: "Rewinding…",
    });
    try {
      const result = await this.agent.rewindExecute({
        targetPromptIndex: st.selected.promptIndex,
        mode: st.mode,
        force,
      });
      if (!result.success) {
        st.busy = false;
        this.post({
          type: "sessionRewind",
          phase: "error",
          error: result.error?.trim() || "Rewind failed",
        });
        return;
      }
      this.applyRewindResult(result);
      this.closeSessionRewind();
      this.pushSystem(formatRewindSuccessMessage(result));
    } catch (err) {
      st.busy = false;
      this.post({
        type: "sessionRewind",
        phase: "error",
        error: errMessage(err),
      });
    }
  }

  private sessionRewindBack(): void {
    const st = this.sessionRewind;
    if (!st || st.busy) {
      return;
    }
    if (st.mode || st.selected) {
      // From mode/confirm → points
      st.selected = undefined;
      st.mode = undefined;
      this.post({
        type: "sessionRewind",
        phase: "points",
        points: serializeRewindPointsForUi(st.points),
      });
      return;
    }
    this.closeSessionRewind();
  }

  private closeSessionRewind(): void {
    this.sessionRewind = undefined;
    this.post({ type: "sessionRewind", phase: "close" });
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

      if (!this.agent.getSessionId()) {
        this.pushSystem("No active session — cannot rewind to edit.");
        this.post({ type: "restoreEditComposer", id: messageId, text });
        return;
      }

      await this.agent.ensureStarted();
      const result = await this.agent.rewindExecute({
        targetPromptIndex: promptIndex,
        mode,
        force: true,
      });

      if (!result.success) {
        this.pushSystem(
          result.error?.trim()
            ? `Edit failed: ${result.error}`
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
      if (result.revertedFiles.length > 0) {
        this.diffs?.clear();
      }

      // Resubmit edited text as a new prompt (literal — not slash re-dispatch).
      await this.handleSend(text, { literal: true });
    } catch (err) {
      this.pushSystem(errMessage(err));
      this.post({ type: "restoreEditComposer", id: messageId, text });
    }
  }

  /**
   * Centered loading indicator for long host ops (start / new session).
   * Non-blocking — does not disable the webview.
   */
  private setBlockingLoad(active: boolean, message?: string): void {
    if (active) {
      this.blockingLoadCount += 1;
      this.post({
        type: "blockingLoad",
        active: true,
        message: message?.trim() || "Loading…",
      });
      return;
    }
    this.blockingLoadCount = Math.max(0, this.blockingLoadCount - 1);
    if (this.blockingLoadCount === 0) {
      this.post({ type: "blockingLoad", active: false, message: "" });
    }
  }

  private async withBlockingLoad<T>(
    message: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.setBlockingLoad(true, message);
    try {
      return await fn();
    } finally {
      this.setBlockingLoad(false);
    }
  }

  /** Start (or re-check) the agent with a centered loading indicator. */
  async runStartAgent(): Promise<void> {
    if (this.blockingLoadCount > 0) {
      return;
    }
    await this.withBlockingLoad("Starting agent…", async () => {
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
    });
  }

  /** Restart the agent with a centered loading indicator. */
  async runRestartAgent(): Promise<void> {
    if (this.blockingLoadCount > 0) {
      return;
    }
    await this.withBlockingLoad("Restarting agent…", async () => {
      try {
        await this.agent.restart();
        this.pushSystem("Agent restarted");
      } catch (err) {
        await this.showStartError(err);
      }
      await this.pushFullState();
    });
  }

  /** New ACP session with a centered loading indicator. */
  async runNewSession(): Promise<void> {
    if (this.blockingLoadCount > 0) {
      return;
    }
    await this.withBlockingLoad("Creating new session…", async () => {
      try {
        if (this.agent.isBusy()) {
          await this.agent.cancelTurn();
        }
        await this.agent.newSession();
        // Clear transcript so the webview empty-state (home) is shown —
        // do not push a "New session" system line that would hide it.
        this.messages = [];
        this.currentAssistantId = undefined;
        this.thoughtStartedAt = undefined;
        this.mdCache.clear();
        this.sessionUsage = {};
        this.endTurnStatusClock();
        this.diffs?.clear();
        await this.clearAllImages();
        this.scheduleMessagesPost(true);
        this.postTurnStatus();
      } catch (err) {
        this.pushSystem(errMessage(err));
      }
      await this.pushFullState();
    });
  }

  private async clearAllImages(): Promise<void> {
    await this.imageStore.clearComposerAttachments();
    for (const p of this.historyImagePaths) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(p));
      } catch {
        /* ignore */
      }
    }
    this.historyImagePaths.clear();
    this.postImageAttachments();
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
      const label = processLabelForSessionUpdate(kind, toolTitle ?? undefined);
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
      const text = update.content.type === "text" ? update.content.text : "";
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
      const text = update.content.type === "text" ? update.content.text : "";
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
      const paths = update.locations?.map((l) => l.path).filter(Boolean) ?? [];
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
    const isEdit =
      /edit|write|patch|replace|create.?file|search_replace|apply/.test(s);
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

  private cachedMarkdown(
    cacheId: string,
    source: string,
    options?: { breaks?: boolean },
  ): string {
    const key = source || "";
    // Include breaks flag in cache identity so user vs assistant don't collide.
    const cacheKey = options?.breaks ? `b1:${key}` : key;
    const hit = this.mdCache.get(cacheId);
    if (hit && hit.key === cacheKey) {
      return hit.html;
    }
    const html = renderMarkdownToSafeHtml(key, {
      breaks: options?.breaks === true,
    });
    this.mdCache.set(cacheId, { key: cacheKey, html });
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
          // GFM like assistant, but soft-breaks so Shift+Enter line breaks show.
          html: this.cachedMarkdown(m.id, m.text || "", { breaks: true }),
          chips: m.chips,
          images: (m.images ?? []).map((img) => ({
            ...img,
            // Refresh webview URI each serialize (webview can re-resolve).
            thumbUri:
              img.openPath != null
                ? (this.thumbUriForPath(img.openPath) ?? img.thumbUri)
                : img.thumbUri,
          })),
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
    if (this.agent.getState().kind === "ready" && catalog.models.length > 0) {
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

  /** Re-check paywall / subscription gate (TUI retry button). */
  async runCheckSubscription(): Promise<void> {
    try {
      await this.agent.ensureStarted();
      this.pushSystem("Checking subscription…");
      const result = await this.agent.checkSubscription();
      if (!result.authenticated) {
        this.pushSystem(
          "Subscription check: not authenticated — sign in again.",
        );
      } else if (result.meta?.gate?.message) {
        const g = result.meta.gate;
        this.pushSystem(
          `Still gated: ${g.message}` + (g.url ? ` — ${g.url}` : ""),
        );
        if (g.url && g.url.startsWith("https://")) {
          const open = await vscode.window.showWarningMessage(
            g.message,
            g.label?.trim() || "Open link",
            "Dismiss",
          );
          if (open && open !== "Dismiss") {
            await vscode.env.openExternal(vscode.Uri.parse(g.url));
          }
        }
      } else {
        this.pushSystem(
          result.meta?.subscriptionTier
            ? `Access OK · tier ${result.meta.subscriptionTier}`
            : "Access OK — subscription check passed",
        );
      }
    } catch (err) {
      await this.showStartError(err);
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
    const gate = this.agent.getAccessGate();
    const authSummary = this.agent.formatAuthProfileSummary(authStatus.summary);
    this.post({
      type: "init",
      messages: this.serializeMessages(this.messages),
      busy,
      hasAuth,
      authSummary,
      accessGated: !!gate?.message,
      gateMessage: gate?.message ?? "",
      gateUrl: gate?.url ?? "",
      gateLabel: gate?.label ?? "",
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
      imageAttachments: this.imageStore.getAll().map((img) => ({
        id: img.id,
        displayNumber: img.displayNumber,
        mimeType: img.mimeType,
        thumbUri: this.thumbUriForPath(img.stagedPath),
        openPath: img.stagedPath,
        width: img.width,
        height: img.height,
        fileName: img.fileName,
        label: img.fileName || `Image ${img.displayNumber}`,
      })),
      stickyChips: this.stickyChips.map((c) => ({
        id: c.id,
        label: c.label,
      })),
      autoAttachEnabled: isAutoAttachEnabled(settings),
      autoChip: this.serializeAutoChip(getActiveEditorChip(settings)),
      reviewCount: this.diffs?.getEntries().length ?? 0,
      turnStatus,
      context: turnStatus.context,
      queue: (() => {
        const snap = this.agent.getQueue();
        return {
          sessionId: snap.sessionId,
          runningPromptId: snap.runningPromptId ?? null,
          entries: snap.entries.map((e) => ({
            id: e.id,
            version: e.version,
            kind: e.kind || "prompt",
            text: e.text,
            firstLine: queueEntryFirstLine(e.text),
            position: e.position,
            optimistic: !!e.optimistic,
          })),
        };
      })(),
      tasks: this.agent.getTasksForWebview(),
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
    const chatCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat", "chat.css"),
    );
    const chatJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat", "chat.js"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Grok Build</title>
<link rel="stylesheet" href="${tablerCss}" />
<link rel="stylesheet" href="${chatCss}" />
</head>
<body>
<div id="blocking-load" role="status" aria-live="polite" aria-busy="false" hidden>
  <div class="bl-card">
    <i class="ti ti-loader ti-spin bl-spinner" aria-hidden="true"></i>
    <span class="bl-label" id="blocking-load-label">Loading…</span>
  </div>
</div>
<div id="drop-overlay" hidden aria-hidden="true">
  <div class="drop-overlay-card">
    <div class="drop-overlay-title">Drop images to attach</div>
    <div class="drop-overlay-hint">Hold <kbd>Shift</kbd> while releasing · VS Code intercepts drops without Shift</div>
  </div>
</div>
<div id="drop-toast" role="status" aria-live="polite" hidden></div>
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
    <div class="review-actions">
      <button type="button" class="secondary" id="btn-review">Open</button>
      <button type="button" class="secondary review-accept" id="btn-review-accept" title="Accept all edits (update agent baselines)">Accept</button>
      <button type="button" class="secondary review-reject" id="btn-review-reject" title="Reject all edits (revert disk)">Reject</button>
    </div>
  </div>
  <div id="messages"></div>
  <section id="session-rewind-panel" hidden role="dialog" aria-label="Rewind conversation">
    <div id="session-rewind-head">
      <div class="session-rewind-head-left">
        <i class="ti ti-arrow-back-up" aria-hidden="true"></i>
        <span id="session-rewind-title">Rewind</span>
        <span id="session-rewind-badge" class="session-rewind-badge" hidden></span>
      </div>
      <div class="session-rewind-head-right">
        <button type="button" class="secondary session-rewind-icon" id="session-rewind-back" title="Back" aria-label="Back" hidden>
          <i class="ti ti-arrow-left" aria-hidden="true"></i>
        </button>
        <button type="button" class="secondary session-rewind-icon" id="session-rewind-close" title="Close (Esc)" aria-label="Close">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div id="session-rewind-scroll">
      <div id="session-rewind-body"></div>
    </div>
    <div id="session-rewind-foot" hidden>
      <div id="session-rewind-actions" role="toolbar" aria-label="Rewind actions">
        <button type="button" class="secondary" id="session-rewind-cancel-btn">Cancel</button>
        <button type="button" id="session-rewind-confirm-btn">Rewind</button>
      </div>
    </div>
  </section>
  <section id="plan-panel" hidden role="region" aria-label="Plan approval">
    <div id="plan-head">
      <div class="plan-head-left">
        <i class="ti ti-clipboard-list" aria-hidden="true"></i>
        <span id="plan-title">Plan approval</span>
        <span id="plan-badge" class="plan-badge" hidden>No plan</span>
      </div>
      <span class="plan-hint">Esc abandon · ⌘/Ctrl+Enter approve · Request changes uses composer</span>
    </div>
    <div id="plan-scroll">
      <div class="msg assistant plan-msg">
        <div id="plan-body" class="bubble md" tabindex="0"></div>
      </div>
    </div>
    <div id="plan-foot">
      <div id="plan-actions" role="toolbar" aria-label="Plan actions">
        <button type="button" class="secondary" id="plan-abandon" title="Discard plan and exit plan mode">
          <i class="ti ti-x" aria-hidden="true"></i> Abandon
        </button>
        <button type="button" class="secondary" id="plan-request" title="Send composer text as plan feedback and keep planning">
          <i class="ti ti-edit" aria-hidden="true"></i> Request changes
        </button>
        <button type="button" id="plan-approve" title="Leave plan mode and implement">
          <i class="ti ti-check" aria-hidden="true"></i> Approve
        </button>
      </div>
    </div>
  </section>
  <section id="subagent-panel" hidden role="region" aria-label="Subagent detail">
    <div id="subagent-head">
      <div class="subagent-head-left">
        <i class="ti ti-hierarchy-2" aria-hidden="true"></i>
        <span id="subagent-type">Subagent</span>
        <span id="subagent-status" class="subagent-badge">running</span>
      </div>
      <button type="button" class="secondary subagent-close" id="subagent-close" title="Close (Esc)" aria-label="Close">
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
    </div>
    <div id="subagent-desc" class="subagent-desc"></div>
    <div id="subagent-chips" class="subagent-chips" hidden></div>
    <div id="subagent-scroll">
      <div id="subagent-timeline" class="subagent-timeline" aria-live="polite"></div>
      <div class="msg assistant subagent-msg" id="subagent-snapshot-wrap" hidden>
        <div id="subagent-body" class="bubble md" tabindex="0"></div>
      </div>
    </div>
    <div id="subagent-foot">
      <div id="subagent-actions" role="toolbar" aria-label="Subagent actions">
        <button type="button" class="secondary" id="subagent-refresh" title="Refresh snapshot">
          <i class="ti ti-refresh" aria-hidden="true"></i> Refresh
        </button>
        <button type="button" class="secondary" id="subagent-kill" title="Stop subagent" hidden>
          <i class="ti ti-player-stop" aria-hidden="true"></i> Stop
        </button>
        <button type="button" class="secondary" id="subagent-done" title="Close panel">
          Close
        </button>
      </div>
    </div>
  </section>
  <div id="empty" hidden>
    <div class="hero-icon" aria-hidden="true">${GROK_MARK_SVG}</div>
    <div id="empty-ready">
      <h2>Grok Build - Community</h2>
      <p>Ask about this workspace. Use / for commands, @ for files. The focused file can auto-attach (toggle on the chip).</p>
      <p id="empty-hint"></p>
      <p id="empty-gate" class="empty-gate" hidden></p>
      <div class="empty-actions">
        <button id="empty-start" type="button"><i class="ti ti-player-play"></i> Start agent</button>
        <button id="empty-auth" class="secondary" type="button" data-action="login" title="Sign in with browser or API key (same as grok login)"><i class="ti ti-login-2"></i> Sign in</button>
        <button id="empty-check-sub" class="secondary" type="button" data-action="checkSubscription" hidden title="Re-check subscription / paywall (same as TUI)"><i class="ti ti-refresh"></i> Check subscription</button>
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
    <div id="tasks-pane" aria-label="Background tasks and subagents">
      <div id="tasks-head">
        <span class="th-left">
          <i class="ti ti-hierarchy-2" aria-hidden="true"></i>
          <span id="tasks-title">Background</span>
        </span>
        <button type="button" class="secondary" id="tasks-refresh" title="Refresh task list">
          <i class="ti ti-refresh" aria-hidden="true"></i>
        </button>
      </div>
      <div id="tasks-list" role="list"></div>
    </div>
    <div id="queue-pane" aria-label="Queued prompts">
      <div id="queue-head">
        <span class="qh-left">
          <i class="ti ti-stack-2" aria-hidden="true"></i>
          <span id="queue-title">Queued</span>
        </span>
        <button type="button" class="secondary" id="queue-clear" title="Clear all queued prompts">Clear</button>
      </div>
      <div id="queue-list" role="list"></div>
    </div>
    <div class="composer-wrap">
      <div id="queue-edit-banner">
        <i class="ti ti-pencil" aria-hidden="true"></i>
        <span class="edit-banner-text">Editing queued prompt — send to save · Esc cancel</span>
        <button type="button" class="secondary" id="queue-edit-cancel">Cancel</button>
      </div>
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
      <div id="model-popover" hidden role="dialog" aria-label="Select model and reasoning">
        <div id="model-head">
          <span id="model-title">Models</span>
          <span class="hint">↑↓ · Enter · Esc</span>
        </div>
        <div id="model-list" role="listbox" aria-label="Models"></div>
        <div id="model-empty" hidden>No models from agent</div>
        <div id="model-effort-panel" class="model-effort-panel" hidden>
          <div class="me-head">
            <span class="me-title"><i class="ti ti-brain" aria-hidden="true"></i> Reasoning</span>
            <span class="me-value" id="model-effort-value">—</span>
          </div>
          <div class="me-slider-wrap">
            <input type="range" id="model-effort-slider" min="0" max="0" step="1" value="0" aria-label="Reasoning effort" />
            <div class="me-ticks" id="model-effort-ticks" aria-hidden="true"></div>
          </div>
          <div class="me-desc" id="model-effort-desc"></div>
        </div>
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
        <div id="image-previews" class="image-previews" hidden aria-label="Attached images"></div>
        <div class="composer-input-wrap">
          <div id="composer-highlight" class="composer-highlight" aria-hidden="true"></div>
          <textarea id="composer" placeholder="Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)" rows="1" spellcheck="true"></textarea>
        </div>
        <div class="actions">
          <button id="btn-mode" class="secondary mode-normal" type="button" title="Mode: Normal — Ask before running tools (Shift+Tab)" aria-label="Cycle session mode">
            <i class="ti ti-route-alt-left" aria-hidden="true"></i>
            <span class="mode-btn-label" id="mode-btn-label">Normal</span>
          </button>
          <div id="ctx-usage" class="ctx-usage" hidden title="Context window usage" aria-label="Context window usage">
            <span class="ctx-sep" aria-hidden="true">|</span>
            <svg class="ctx-ring" viewBox="0 0 36 36" width="14" height="14" aria-hidden="true">
              <circle class="ctx-ring-track" cx="18" cy="18" r="14" fill="none" stroke-width="3.5" />
              <circle class="ctx-ring-fill" cx="18" cy="18" r="14" fill="none" stroke-width="3.5" stroke-linecap="round" transform="rotate(-90 18 18)" stroke-dasharray="87.96" stroke-dashoffset="87.96" />
            </svg>
            <span class="ctx-usage-text" id="ctx-usage-text">—</span>
          </div>
          <div id="billing-usage" class="billing-usage" hidden title="Credit usage" aria-label="Credit usage">
            <span class="billing-sep" aria-hidden="true">|</span>
            <i class="ti ti-battery-2" aria-hidden="true"></i>
            <span id="billing-usage-text">Usage 0%</span>
          </div>
          <div id="sticky" class="composer-sticky is-empty" aria-label="Attached context" aria-hidden="true"></div>
          <div class="actions-right">
            <button id="btn-model" class="secondary" type="button" title="Select model (same catalog as TUI)" aria-label="Select model" aria-haspopup="dialog" aria-expanded="false">
              <i class="ti ti-cpu" aria-hidden="true"></i>
              <span class="model-btn-text">
                <span class="model-btn-label" id="model-btn-label">model</span>
                <span class="model-btn-effort" id="model-btn-effort" hidden></span>
              </span>
              <i class="ti ti-chevron-up" aria-hidden="true"></i>
            </button>
            <button id="send" type="button" title="Send" aria-label="Send"><i class="ti ti-send" aria-hidden="true"></i></button>
          </div>
        </div>
      </div>
    </div>
  </footer>
</div>
<script nonce="${nonce}" src="${chatJs}"></script>
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
