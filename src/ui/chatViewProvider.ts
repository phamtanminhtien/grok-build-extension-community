import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { promptAndStoreApiKey } from "../auth/authService";
import { BinaryNotFoundError } from "../agent/binaryResolver";
import {
  buildPromptBlocks,
  type ContextChip,
} from "../context/editorContext";
import { pickContextChips } from "../context/contextPicker";
import { getSettings } from "../config/settings";
import { logError } from "../log/output";
import { renderMarkdownToSafeHtml } from "./markdown";
import type { DiffReviewService } from "../diff/diffReviewService";
import { readTextFileHost } from "../agent/hostFs";

type UiMessage =
  | { type: "user"; id: string; text: string; chips?: string[] }
  | {
      type: "assistant";
      id: string;
      text: string;
      thought: string;
      tools: ToolCard[];
    }
  | { type: "system"; id: string; text: string };

interface ToolCard {
  id: string;
  title: string;
  status: string;
  kind?: string;
  paths: string[];
}

interface SerializedMessage {
  type: string;
  id: string;
  text?: string;
  html?: string;
  thought?: string;
  thoughtHtml?: string;
  chips?: string[];
  tools?: ToolCard[];
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly auth: AuthService,
    options?: { supportsSecondarySidebar?: boolean },
  ) {
    this.supportsSecondarySidebar = options?.supportsSecondarySidebar ?? true;
    this.disposables.push(
      this.agent.onSessionUpdate((n) => this.handleSessionUpdate(n)),
      this.agent.onBusyChange((busy) => this.post({ type: "busy", busy })),
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
      this.agent.onTurnEnd(() => {
        this.currentAssistantId = undefined;
        this.post({ type: "busy", busy: false });
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

    void this.pushFullState();
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
    const picked = await pickContextChips();
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
    this.diffs?.clear();
    const label = title?.trim() || "session";
    this.pushSystem(`Loading ${label}…`);
    this.post({ type: "busy", busy: true });
  }

  endHistoryLoad(): void {
    this.loadingHistory = false;
    this.currentAssistantId = undefined;
    this.currentUserId = undefined;
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
  }

  async refreshState(): Promise<void> {
    await this.pushFullState();
  }

  dispose(): void {
    if (this.messagesFlushTimer) {
      clearTimeout(this.messagesFlushTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    path?: string;
    id?: string;
  }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushFullState();
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
        await this.addContextFromPicker();
        break;
      case "removeChip":
        if (msg.id) {
          this.stickyChips = this.stickyChips.filter((c) => c.id !== msg.id);
          this.postSticky();
        }
        break;
      case "selectModel":
        await vscode.commands.executeCommand("grok.selectModel");
        break;
      case "resumeSession":
        await vscode.commands.executeCommand("grok.resumeSession");
        break;
      default:
        break;
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.pushSystem("Wait for the current turn or press Stop.");
      return;
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
    this.messages.push({
      type: "assistant",
      id: asstId,
      text: "",
      thought: "",
      tools: [],
    });
    this.scheduleMessagesPost(true);
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
      this.diffs?.clear();
      this.pushSystem("New session");
      this.scheduleMessagesPost(true);
    } catch (err) {
      this.pushSystem(errMessage(err));
    }
  }

  private handleSessionUpdate(n: SessionNotification): void {
    const update = n.update;
    const showThoughts = getSettings().showThoughts;
    const kind = update.sessionUpdate;

    // History replay + live: user turns close the current assistant bubble
    if (kind === "user_message_chunk") {
      this.currentAssistantId = undefined;
      if (!this.currentUserId) {
        const id = uid();
        this.currentUserId = id;
        this.messages.push({ type: "user", id, text: "", chips: [] });
      }
      const user = this.messages.find(
        (m) => m.type === "user" && m.id === this.currentUserId,
      );
      if (user && user.type === "user" && update.content.type === "text") {
        user.text += update.content.text;
      }
      this.scheduleMessagesPost();
      return;
    }

    // End of a turn (seen on session/load replay; may be extension-specific)
    if ((kind as string) === "turn_completed") {
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

    // Starting assistant output ends user chunk accumulation
    this.currentUserId = undefined;

    if (!this.currentAssistantId) {
      const asstId = uid();
      this.currentAssistantId = asstId;
      this.messages.push({
        type: "assistant",
        id: asstId,
        text: "",
        thought: "",
        tools: [],
      });
    }

    const msg = this.messages.find(
      (m) => m.type === "assistant" && m.id === this.currentAssistantId,
    );
    if (!msg || msg.type !== "assistant") {
      return;
    }

    switch (kind) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          msg.text += update.content.text;
        }
        break;
      case "agent_thought_chunk":
        if (showThoughts && update.content.type === "text") {
          msg.thought += update.content.text;
        }
        break;
      case "tool_call": {
        const paths =
          update.locations?.map((l) => l.path).filter(Boolean) ?? [];
        msg.tools.push({
          id: update.toolCallId,
          title: update.title ?? update.toolCallId,
          status: update.status ?? "pending",
          kind: update.kind ?? undefined,
          paths,
        });
        if (!this.loadingHistory) {
          void this.maybeSnapshotToolPaths(
            update.toolCallId,
            update.title ?? "",
            update.kind,
            paths,
          );
        }
        break;
      }
      case "tool_call_update": {
        const t = msg.tools.find((x) => x.id === update.toolCallId);
        const paths =
          update.locations?.map((l) => l.path).filter(Boolean) ?? [];
        if (t) {
          if (update.status) {
            t.status = update.status;
          }
          if (update.title) {
            t.title = update.title;
          }
          if (paths.length) {
            t.paths = paths;
          }
        } else {
          msg.tools.push({
            id: update.toolCallId,
            title: update.title ?? update.toolCallId,
            status: update.status ?? "pending",
            kind: update.kind ?? undefined,
            paths,
          });
        }
        if (paths.length && !this.loadingHistory) {
          void this.maybeSnapshotToolPaths(
            update.toolCallId,
            update.title ?? t?.title ?? "",
            update.kind ?? t?.kind,
            paths,
          );
        }
        break;
      }
      default:
        break;
    }

    this.scheduleMessagesPost();
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

  private serializeMessages(messages: UiMessage[]): SerializedMessage[] {
    return messages.map((m) => {
      if (m.type === "assistant") {
        return {
          type: m.type,
          id: m.id,
          text: m.text,
          html: renderMarkdownToSafeHtml(m.text || ""),
          thought: m.thought,
          thoughtHtml: m.thought
            ? renderMarkdownToSafeHtml(m.thought)
            : "",
          tools: m.tools,
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
  }

  private async pushFullState(): Promise<void> {
    const hasAuth = await this.auth.hasAnyAuth();
    const state = this.agent.getState();
    this.post({
      type: "init",
      messages: this.serializeMessages(this.messages),
      busy: this.agent.isBusy(),
      hasAuth,
      agentState: state.kind,
      agentDetail:
        state.kind === "ready"
          ? "ready"
          : state.kind === "error"
            ? state.message
            : "",
      model: getSettings().model || "default",
      stickyChips: this.stickyChips.map((c) => ({
        id: c.id,
        label: c.label,
      })),
      reviewCount: this.diffs?.getEntries().length ?? 0,
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
    font-size: 11px; padding: 4px 10px; border-radius: var(--radius-pill);
    border: none;
    color: var(--muted);
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    display: inline-flex; align-items: center; gap: 5px;
    max-width: 100%; line-height: 1.3;
    transition: background var(--ease), color var(--ease);
  }
  .chip:hover {
    color: var(--fg);
    background: var(--list-hover);
  }
  .chip button {
    background: transparent; border: none; color: inherit;
    cursor: pointer; padding: 0; width: 16px; height: 16px;
    border-radius: var(--radius-pill); font-size: 13px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    opacity: 0.7; transition: opacity var(--ease), background var(--ease);
  }
  .chip button:hover {
    opacity: 1; background: color-mix(in srgb, var(--fg) 12%, transparent);
  }

  /* ── Thoughts & tools ── */
  .thought {
    margin-bottom: 8px; font-size: 12px; color: var(--muted);
    border: none;
    border-radius: var(--radius-sm); padding: 8px 10px;
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .thought summary {
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; list-style: none;
    font-weight: 500;
  }
  .thought summary::-webkit-details-marker { display: none; }
  .thought .thought-body {
    margin: 8px 0 0; max-height: 160px; overflow: auto; opacity: 0.9;
    padding-top: 6px;
  }
  .tools { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .tool {
    border: none;
    border-radius: var(--radius-sm); padding: 8px 10px;
    font-size: 12px;
    background: color-mix(in srgb, var(--fg) 6%, var(--input-bg));
    transition: background var(--ease);
  }
  .tool:hover {
    background: color-mix(in srgb, var(--list-hover) 70%, transparent);
  }
  .tool .row { display: flex; gap: 8px; align-items: center; }
  .tool .tool-icon {
    width: 22px; height: 22px; border-radius: 7px;
    display: inline-flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    flex-shrink: 0;
  }
  .tool .status {
    color: var(--muted); margin-left: auto; text-transform: uppercase;
    font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .tool .paths a, .tool .paths button.link {
    color: var(--link); cursor: pointer; text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px; margin-top: 6px;
    margin-right: 10px; background: none; border: none; padding: 2px 0;
    font: inherit; border-radius: 4px;
  }
  .tool .paths a:hover, .tool .paths button.link:hover { text-decoration: underline; }

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
    margin-left: auto;
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
    <button type="button" class="linkish" id="btn-model" title="Select model">model ▾</button>
    <button type="button" class="linkish" id="btn-history" title="Session history">History</button>
    <div class="meta" id="meta"><i class="ti ti-circle-dashed"></i><span>idle</span></div>
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
    <p>Ask about this workspace. Use @ to attach files. Active selection attaches automatically.</p>
    <p id="empty-hint"></p>
    <div class="empty-actions">
      <button id="empty-start" type="button"><i class="ti ti-player-play"></i> Start agent</button>
      <button id="empty-login" class="secondary" type="button"><i class="ti ti-key"></i> Set API key</button>
    </div>
  </div>
  <footer>
    <div id="sticky"></div>
    <div class="composer-shell">
      <textarea id="composer" placeholder="Message Grok… (@ context, Enter send, Shift+Enter newline)" rows="3"></textarea>
      <div class="actions">
        <button id="at" class="secondary icon-btn" type="button" title="Add context" aria-label="Add context"><i class="ti ti-at"></i></button>
        <button id="stop" class="secondary" type="button" disabled title="Stop"><i class="ti ti-player-stop"></i> Stop</button>
        <button id="new" class="secondary" type="button" title="New session"><i class="ti ti-plus"></i> New</button>
        <button id="send" type="button" title="Send"><i class="ti ti-send"></i> Send</button>
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
const stopBtn = document.getElementById('stop');
const newBtn = document.getElementById('new');
const stickyEl = document.getElementById('sticky');
const reviewBar = document.getElementById('review-bar');
const reviewLabel = document.getElementById('review-label');
const btnModel = document.getElementById('btn-model');
let busy = false;
let allMessages = [];
let stickyChips = [];
const EST_ROW = 96;
const VIRT_THRESHOLD = 40;

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

function renderOneMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.type;
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
    if (m.thought) {
      const d = document.createElement('details');
      d.className = 'thought';
      d.open = false;
      const summary = document.createElement('summary');
      summary.innerHTML = icon('brain') + ' Thinking';
      d.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'thought-body';
      if (m.thoughtHtml) body.innerHTML = m.thoughtHtml;
      else body.textContent = m.thought;
      d.appendChild(body);
      wrap.appendChild(d);
    }
    const b = document.createElement('div');
    b.className = 'bubble md';
    if (m.html) {
      b.innerHTML = m.html || (m.tools && m.tools.length ? '' : '…');
      b.querySelectorAll('pre').forEach((pre) => {
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
    } else {
      b.textContent = m.text || (m.tools && m.tools.length ? '' : '…');
    }
    wrap.appendChild(b);
    if (m.tools && m.tools.length) {
      const tools = document.createElement('div');
      tools.className = 'tools';
      for (const t of m.tools) {
        const card = document.createElement('div');
        card.className = 'tool';
        let paths = '';
        if (t.paths && t.paths.length) {
          paths = '<div class="paths">' + t.paths.map(p => {
            const isEdit = /edit|write|patch|replace|create.?file|search_replace|apply/i.test(
              (t.kind || '') + ' ' + (t.title || '')
            );
            return '<a data-path="' + esc(p) + '" href="#">' + icon('file') + esc(p) + '</a>' +
              (isEdit
                ? '<button type="button" class="link" data-diff="' + esc(p) + '">' + icon('file-diff') + ' Diff</button>'
                : '');
          }).join('') + '</div>';
        }
        card.innerHTML =
          '<div class="row">' +
            '<span class="tool-icon">' + icon(toolIconName(t)) + '</span>' +
            '<span>' + esc(t.title) + '</span>' +
            '<span class="status">' + statusIcon(t.status) + esc(t.status) + '</span>' +
          '</div>' + paths;
        tools.appendChild(card);
      }
      wrap.appendChild(tools);
    }
  } else {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = icon('info-circle') + '<span></span>';
    b.querySelector('span').textContent = m.text || '';
    wrap.appendChild(b);
  }
  return wrap;
}

function renderMessages(messages) {
  allMessages = messages || [];
  const stick = shouldStickToBottom(
    messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight
  );
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
  stickyEl.innerHTML = stickyChips.map(c =>
    '<span class="chip">' + icon(chipIcon(c.label)) + esc(c.label) +
    '<button type="button" data-chip-id="' + esc(c.id) + '" title="Remove">×</button></span>'
  ).join('');
}

function setMeta(text, spinning) {
  meta.innerHTML = (spinning ? icon('loader', 'ti-spin') : icon('circle-dashed')) +
    '<span>' + esc(text) + '</span>';
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.disabled = !b;
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
  const btn = e.target.closest('[data-chip-id]');
  if (btn) {
    vscode.postMessage({ type: 'removeChip', id: btn.getAttribute('data-chip-id') });
  }
});

sendBtn.addEventListener('click', () => {
  const text = composer.value.trim();
  if (!text || busy) return;
  vscode.postMessage({ type: 'send', text });
  composer.value = '';
});

stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
document.getElementById('at').addEventListener('click', () =>
  vscode.postMessage({ type: 'addContext' }));
document.getElementById('empty-start').addEventListener('click', () =>
  vscode.postMessage({ type: 'startAgent' }));
document.getElementById('empty-login').addEventListener('click', () =>
  vscode.postMessage({ type: 'login' }));
btnModel.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
document.getElementById('btn-history').addEventListener('click', () =>
  vscode.postMessage({ type: 'resumeSession' }));
document.getElementById('btn-review').addEventListener('click', () =>
  vscode.postMessage({ type: 'reviewEdits' }));

composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
  if (e.key === 'Escape' && busy) {
    vscode.postMessage({ type: 'cancel' });
  }
  if (e.key === '@') {
    // Open picker after the character is inserted
    setTimeout(() => {
      const v = composer.value;
      const pos = composer.selectionStart || 0;
      const before = v.slice(0, pos);
      if (/(^|[\\s])@$/.test(before)) {
        vscode.postMessage({ type: 'addContext' });
      }
    }, 0);
  }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'init') {
    renderMessages(msg.messages || []);
    stickyChips = msg.stickyChips || [];
    renderSticky();
    setReview(msg.reviewCount || 0);
    const model = msg.model || 'default';
    btnModel.textContent = model + ' ▾';
    const base = (msg.agentState || 'idle') +
      (msg.agentDetail ? ' · ' + String(msg.agentDetail).slice(0, 12) : '');
    meta.dataset.base = base;
    setBusy(!!msg.busy);
    emptyHint.textContent = msg.hasAuth
      ? 'CLI/auth detected. You can start chatting.'
      : 'No API key in SecretStorage — CLI ~/.grok auth may still work.';
    emptyEl.hidden = (msg.messages || []).length > 0;
  } else if (msg.type === 'messages') {
    renderMessages(msg.messages || []);
  } else if (msg.type === 'busy') {
    setBusy(!!msg.busy);
  } else if (msg.type === 'agentState') {
    const base = (msg.state || 'idle') +
      (msg.detail ? ' · ' + String(msg.detail).slice(0, 12) : '');
    meta.dataset.base = base;
    if (msg.model) btnModel.textContent = msg.model + ' ▾';
    if (!busy) setMeta(base, false);
  } else if (msg.type === 'stickyChips') {
    stickyChips = msg.chips || [];
    renderSticky();
  } else if (msg.type === 'review') {
    setReview(msg.count || 0);
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
