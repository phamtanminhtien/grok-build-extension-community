import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { promptAndStoreApiKey } from "../auth/authService";
import { BinaryNotFoundError } from "../agent/binaryResolver";
import {
  buildPromptBlocks,
  getActiveEditorChip,
  isAutoAttachEnabled,
  type ContextChip,
} from "../context/editorContext";
import {
  pickContextChips,
  searchContextSuggestions,
} from "../context/contextPicker";
import { getSettings } from "../config/settings";
import {
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
  assistantHasRunningThought,
  assistantPlainText,
  emptyAssistant,
  extractToolContentText,
  finishAssistantThoughts,
  formatToolValue,
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

type UiMessage =
  | { type: "user"; id: string; text: string; chips?: string[] }
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
  /** Ordered timeline: thoughts, text, tools in stream order. */
  items?: SerializedTimelineItem[];
}

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly auth: AuthService,
    options?: { supportsSecondarySidebar?: boolean },
  ) {
    this.supportsSecondarySidebar = options?.supportsSecondarySidebar ?? true;
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
    // Prefer in-webview popover (grok-build style). Fallback QuickPick for
    // command palette when the webview is not mounted yet.
    if (this.views.size > 0) {
      this.post({ type: "openMention" });
      return;
    }
    const picked = await pickContextChips();
    this.addStickyChips(picked);
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
    for (const d of this.disposables) {
      d.dispose();
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

  private postTurnStatus(): void {
    const busy = this.agent.isBusy();
    const elapsedMs =
      busy && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    const parts = buildTurnStatusParts({
      busy,
      process: this.turnProcess,
      elapsedMs,
      usage: this.sessionUsage,
    });
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
      case "login":
        await promptAndStoreApiKey(this.auth);
        await this.pushFullState();
        break;
      case "startAgent":
        try {
          await this.agent.ensureStarted();
          this.pushSystem("Agent ready");
        } catch (err) {
          await this.showStartError(err);
        }
        await this.pushFullState();
        break;
      case "addContext":
        // Open in-webview mention popover (not VS Code QuickPick).
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
        // Ensure live catalog first (same list as TUI /model), then QuickPick.
        await this.ensureModelsLoaded();
        await vscode.commands.executeCommand("grok.selectModel");
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
          await vscode.commands.executeCommand("grok.selectModel");
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
      default:
        break;
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.pushSystem("Wait for the current turn or press Stop.");
      return;
    }

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

    const { blocks, chips } = buildPromptBlocks(text, {
      stickyChips: this.stickyChips,
    });
    const userId = uid();
    this.messages.push({
      type: "user",
      id: userId,
      text,
      chips: chips.map((c) => c.label),
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
    const hasAuth = await this.auth.hasAnyAuth();
    const state = this.agent.getState();
    const settings = getSettings();
    const busy = this.agent.isBusy();
    const elapsedMs =
      busy && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
    const turnStatus = buildTurnStatusParts({
      busy,
      process: this.turnProcess,
      elapsedMs,
      usage: this.sessionUsage,
    });
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
    const msg = errMessage(err);
    if (
      err instanceof BinaryNotFoundError ||
      /binary|not find|ENOENT/i.test(msg)
    ) {
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
    scroll-behavior: smooth;
  }
  .msg { max-width: 100%; animation: msg-in 160ms ease; }
  @keyframes msg-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .msg { animation: none; }
  }
  .msg.user { align-self: flex-end; max-width: 92%; }
  .msg.assistant, .msg.system { align-self: stretch; }
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
    color: var(--muted); font-size: 12px; padding: 6px 2px; background: transparent;
    display: flex; align-items: flex-start; gap: 8px; white-space: pre-wrap;
    border: none; border-radius: 0; box-shadow: none;
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
    max-width: 300px; line-height: 1.55;
  }
  #empty .hero-icon {
    width: 52px; height: 52px; margin: 0 auto 12px;
    border-radius: var(--radius-md);
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; color: var(--btn-bg);
    background: color-mix(in srgb, var(--btn-bg) 14%, transparent);
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
    border-radius: var(--radius-sm);
  }

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
  /* @ mention + / slash + model/effort popovers — above input, like grok-build dropdowns */
  #mention-popover, #slash-popover, #model-popover, #effort-popover {
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
  #mention-popover[hidden], #slash-popover[hidden], #model-popover[hidden],
  #effort-popover[hidden] {
    display: none !important;
  }
  #mention-head, #slash-head, #model-head, #effort-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 10px 6px;
    font-size: 11px; color: var(--muted); font-weight: 500;
    border-bottom: 1px solid color-mix(in srgb, var(--fg) 8%, transparent);
    flex-shrink: 0;
  }
  #mention-head .hint, #slash-head .hint, #model-head .hint, #effort-head .hint { opacity: 0.85; }
  #mention-list, #slash-list, #model-list, #effort-list {
    overflow-y: auto; padding: 4px;
    flex: 1; min-height: 0;
  }
  .mention-item, .slash-item, .model-item, .effort-item {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 7px 8px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--fg);
    font: inherit; font-size: 12px; cursor: pointer;
    min-height: 32px;
  }
  .mention-item:hover, .slash-item:hover, .model-item:hover, .effort-item:hover {
    background: var(--list-hover);
  }
  .mention-item.active, .slash-item.active, .model-item.active, .effort-item.active {
    background: color-mix(in srgb, var(--btn-bg) 28%, transparent);
  }
  .mention-item .mi-icon, .slash-item .mi-icon, .model-item .mi-icon, .effort-item .mi-icon {
    width: 22px; height: 22px; border-radius: 7px;
    display: inline-flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    color: color-mix(in srgb, var(--fg) 72%, var(--muted));
    flex-shrink: 0;
  }
  .mention-item.active .mi-icon, .slash-item.active .mi-icon, .model-item.active .mi-icon,
  .effort-item.active .mi-icon {
    color: var(--btn-fg);
    background: var(--btn-bg);
  }
  .mention-item:hover:not(.active) .mi-icon,
  .slash-item:hover:not(.active) .mi-icon,
  .model-item:hover:not(.active) .mi-icon,
  .effort-item:hover:not(.active) .mi-icon {
    color: var(--fg);
    background: color-mix(in srgb, var(--fg) 14%, transparent);
  }
  .mention-item .mi-body, .slash-item .mi-body, .model-item .mi-body, .effort-item .mi-body {
    min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px;
  }
  .mention-item .mi-label, .slash-item .mi-label, .model-item .mi-label, .effort-item .mi-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500;
  }
  .mention-item .mi-desc, .slash-item .mi-desc, .model-item .mi-desc, .effort-item .mi-desc {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; color: var(--muted);
  }
  .model-item.current .mi-label, .effort-item.current .mi-label { font-weight: 600; }
  #btn-model, #btn-effort {
    max-width: min(140px, 36%);
    border-radius: var(--radius-pill);
    padding: 7px 10px;
    font-weight: 500;
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
  #turn-status.busy .ts-process {
    color: var(--btn-bg);
  }
  #turn-status .ts-right {
    display: inline-flex; align-items: center; gap: 8px;
    flex-shrink: 0; font-variant-numeric: tabular-nums;
    opacity: 0.95;
  }
  #turn-status .ts-tokens {
    color: var(--fg);
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  #turn-status .ts-sep { opacity: 0.4; }
  #turn-status .ts-cost { color: var(--fg); opacity: 0.75; }
  #turn-status .ts-spin {
    display: none; width: 12px; height: 12px; flex-shrink: 0;
  }
  #turn-status.busy .ts-spin { display: inline-flex; }
  #turn-status .ts-spin .ti { font-size: 12px; }

  .composer-shell {
    display: flex; flex-direction: column; gap: 8px;
    background: var(--input-bg);
    border: none;
    border-radius: var(--radius-md);
    padding: 10px 10px 8px;
    box-shadow: var(--shadow-soft);
    transition: box-shadow var(--ease), background var(--ease);
  }
  .composer-shell:focus-within {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 40%, transparent), var(--shadow-soft);
  }
  #composer {
    width: 100%; min-height: 60px; max-height: 180px; resize: vertical;
    background: transparent; color: var(--input-fg);
    border: none; border-radius: 0; outline: none;
    padding: 2px 4px; font-family: inherit; font-size: inherit;
    line-height: 1.45;
  }
  #composer:focus { outline: none; }
  #composer::placeholder { color: var(--muted); opacity: 0.85; }
  .actions {
    display: flex; gap: 6px; align-items: center;
    padding-top: 2px;
  }
  /* mode | spacer | model · reasoning · send */
  .actions-right {
    margin-left: auto;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  /* Mode cycle — left of action row (Shift+Tab) */
  #btn-mode {
    font-size: 12px;
    padding: 6px 10px;
    min-height: 30px;
    gap: 5px;
    flex-shrink: 0;
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
    padding: 7px 16px;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--btn-bg) 35%, transparent);
  }
  #send:hover:not(:disabled) {
    box-shadow: 0 2px 6px color-mix(in srgb, var(--btn-bg) 40%, transparent);
  }
  .vspacer { flex-shrink: 0; width: 100%; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><i class="ti ti-message-chatbot"></i></span>
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
    <div class="hero-icon" aria-hidden="true"><i class="ti ti-message-chatbot"></i></div>
    <h2>Grok Build - Community</h2>
    <p>Ask about this workspace. Use / for commands, @ for files. The focused file can auto-attach (toggle on the chip).</p>
    <p id="empty-hint"></p>
    <div class="empty-actions">
      <button id="empty-start" type="button"><i class="ti ti-player-play"></i> Start agent</button>
      <button id="empty-login" class="secondary" type="button"><i class="ti ti-key"></i> Set API key</button>
    </div>
  </div>
  <footer>
    <div id="sticky"></div>
    <div class="composer-wrap">
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
        <textarea id="composer" placeholder="Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)" rows="3"></textarea>
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
const emptyHint = document.getElementById('empty-hint');
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
  if (!modelItems.length) {
    vscode.postMessage({ type: 'selectModel' });
    closeModelPopover();
  }
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

function fillTextBubble(b, text, html) {
  if (html) {
    b.innerHTML = html;
    attachCopyButtons(b);
  } else if (text) {
    b.textContent = text;
  } else {
    // No "…" placeholder — empty assistant waits silently; TUI uses turn-status
    // / Thinking… block instead of a fake message bubble.
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
  if (t && t.html) {
    body.innerHTML = t.html;
  } else {
    body.textContent = (t && t.text) || '';
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

/** Build timeline nodes (thoughts + text + tools) in stream order. */
function renderAssistantTimeline(m, openToolIds, openThoughtIds) {
  const timeline = document.createElement('div');
  timeline.className = 'assistant-timeline';
  const items = Array.isArray(m.items) ? m.items : null;

  if (items && items.length) {
    for (const item of items) {
      if (item.kind === 'text') {
        const text = item.text || '';
        const html = item.html || '';
        // Skip empty text segments — no "…" placeholder bubble (TUI-aligned).
        if (!text && !html) continue;
        const b = document.createElement('div');
        b.className = 'bubble md';
        fillTextBubble(b, text, html);
        timeline.appendChild(b);
      } else if (item.kind === 'tool' && item.tool) {
        const open = openToolIds && openToolIds.has(item.tool.id);
        timeline.appendChild(renderToolRow(item.tool, open));
      } else if (item.kind === 'thought' && item.thought) {
        const open =
          !!item.thought.running ||
          (openThoughtIds && openThoughtIds.has(item.thought.id));
        timeline.appendChild(renderThoughtRow(item.thought, open));
      }
    }
    return timeline;
  }

  // Legacy fallback (no items[]): single bubble + tools at end
  const hasTools = m.tools && m.tools.length;
  if (m.html || m.text) {
    const b = document.createElement('div');
    b.className = 'bubble md';
    fillTextBubble(b, m.text, m.html);
    timeline.appendChild(b);
  }
  if (hasTools) {
    for (const t of m.tools) {
      const open = openToolIds && openToolIds.has(t.id);
      timeline.appendChild(renderToolRow(t, open));
    }
  }
  return timeline;
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

function renderOneMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.type;
  wrap.dataset.msgId = m.id || '';
  if (m.type === 'user') {
    if (m.chips && m.chips.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.innerHTML = m.chips.map(c =>
        '<span class="chip">' + icon(chipIcon(c)) + esc(c) + '</span>'
      ).join('');
      wrap.appendChild(chips);
    }
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.text || '';
    wrap.appendChild(b);
  } else if (m.type === 'assistant') {
    // Thoughts live on the timeline with tools/text (TUI scrollback order).
    wrap.appendChild(renderAssistantTimeline(m, null, null));
  } else {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = icon('info-circle') + '<span></span>';
    b.querySelector('span').textContent = m.text || '';
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

  // Drop legacy top-level thought (pre-timeline); everything is in the timeline now.
  wrap.querySelectorAll(':scope > details.thought').forEach((el) => el.remove());

  const oldTimeline = wrap.querySelector(':scope > .assistant-timeline');
  const nextTimeline = renderAssistantTimeline(m, openToolIds, openThoughtIds);
  if (oldTimeline) oldTimeline.replaceWith(nextTimeline);
  else wrap.appendChild(nextTimeline);
  return true;
}

function renderMessages(messages) {
  const next = messages || [];
  const stick = shouldStickToBottom(
    messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight
  );

  // Streaming fast path: only the last assistant bubble changed — avoid wiping
  // the whole list (main source of UI jank / flicker while tokens arrive).
  if (
    allMessages.length > 0 &&
    isStreamingTailUpdate(allMessages, next) &&
    allMessages.length <= VIRT_THRESHOLD
  ) {
    allMessages = next;
    emptyEl.hidden = true;
    if (patchLastAssistant(next[next.length - 1])) {
      if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
  }

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
    messagesEl.appendChild(renderOneMessage(allMessages[i]));
  }

  if (allMessages.length > VIRT_THRESHOLD) {
    const bottom = document.createElement('div');
    bottom.className = 'vspacer';
    bottom.style.height = ((allMessages.length - end) * EST_ROW) + 'px';
    messagesEl.appendChild(bottom);
  }

  if (stick || allMessages.length <= VIRT_THRESHOLD) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
  busy = b;
  sendBtn.disabled = b;
  composer.disabled = false;
  if (b) setMeta('working…', true);
  else setMeta(meta.dataset.base || 'idle', false);
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
  const text = composer.value.trim();
  if (!text || busy) return;
  vscode.postMessage({ type: 'send', text });
  composer.value = '';
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
document.getElementById('empty-login').addEventListener('click', () =>
  vscode.postMessage({ type: 'login' }));
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

composer.addEventListener('input', () => syncComposerMenus());
composer.addEventListener('click', () => syncComposerMenus());
composer.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    syncComposerMenus();
  }
});

btnMode.addEventListener('click', () => {
  vscode.postMessage({ type: 'cycleMode' });
});

composer.addEventListener('keydown', (e) => {
  // TUI Shift+Tab: cycle Normal → Plan → Always-Approve (even with draft text).
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    vscode.postMessage({ type: 'cycleMode' });
    return;
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
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
  if (e.key === 'Escape' && busy) {
    vscode.postMessage({ type: 'cancel' });
  }
});

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
    const base = (msg.agentState || 'idle') +
      (msg.agentDetail ? ' · ' + String(msg.agentDetail).slice(0, 12) : '');
    meta.dataset.base = base;
    setBusy(!!msg.busy);
    if (msg.turnStatus) renderTurnStatus(msg.turnStatus);
    if (msg.context) renderContextBar(msg.context);
    emptyHint.textContent = msg.hasAuth
      ? 'CLI/auth detected. You can start chatting.'
      : 'No API key in SecretStorage — CLI ~/.grok auth may still work.';
    emptyEl.hidden = (msg.messages || []).length > 0;
  } else if (msg.type === 'messages') {
    renderMessages(msg.messages || []);
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
    }
    syncMentionFromComposer();
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
