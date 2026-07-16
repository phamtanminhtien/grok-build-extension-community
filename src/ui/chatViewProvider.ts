import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentService } from "../agent/agentService";
import type { AuthService } from "../auth/authService";
import { promptAndStoreApiKey } from "../auth/authService";
import { BinaryNotFoundError } from "../agent/binaryResolver";
import { buildPromptBlocks } from "../context/editorContext";
import { getSettings } from "../config/settings";
import { logError } from "../log/output";

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

/**
 * Sidebar webview chat for Grok Build - Community (L1).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Primary Activity Bar (left) — always available. */
  public static readonly viewType = "grok.chatView";
  /** Secondary Side Bar (right) — tab strip next to Chat / Claude / Codex. */
  public static readonly secondaryViewType = "grok.chatView.secondary";

  /** Last resolved webview (either location). */
  private view?: vscode.WebviewView;
  private readonly views = new Map<string, vscode.WebviewView>();
  private supportsSecondarySidebar = true;
  private messages: UiMessage[] = [];
  private currentAssistantId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

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
              ? state.sessionId
              : state.kind === "error"
                ? state.message
                : "",
        }),
      ),
      this.agent.onTurnEnd(() => {
        this.currentAssistantId = undefined;
        this.post({ type: "busy", busy: false });
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
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
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

    // Re-hydrate UI when webview becomes visible again
    void this.pushFullState();
  }

  /**
   * Prefer secondary sidebar when available (agent tab strip), else activity bar.
   * Both locations stay registered; user can open either.
   */
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
        // Secondary not visible / not resolved yet — fall through to activity bar
      }
    }
    await vscode.commands.executeCommand(
      `${ChatViewProvider.viewType}.focus`,
    );
  }

  /** Open the classic left Activity Bar view explicitly. */
  async openActivityBarChat(): Promise<void> {
    await vscode.commands.executeCommand(
      `${ChatViewProvider.viewType}.focus`,
    );
  }

  async sendFromCommand(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    path?: string;
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
          const uri = vscode.Uri.file(msg.path);
          await vscode.window.showTextDocument(uri);
        }
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
      default:
        break;
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.pushSystem("Wait for the current turn or press Stop.");
      return;
    }

    const { blocks, chips } = buildPromptBlocks(text);
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
    this.post({ type: "messages", messages: this.messages });
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
      const id = await this.agent.newSession();
      this.messages = [];
      this.currentAssistantId = undefined;
      this.pushSystem(`New session ${id.slice(0, 8)}…`);
      this.post({ type: "messages", messages: this.messages });
    } catch (err) {
      this.pushSystem(errMessage(err));
    }
  }

  private handleSessionUpdate(n: SessionNotification): void {
    const update = n.update;
    const showThoughts = getSettings().showThoughts;

    if (!this.currentAssistantId) {
      // Create assistant bubble if stream arrives without local send (edge)
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

    switch (update.sessionUpdate) {
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
        break;
      }
      case "tool_call_update": {
        const t = msg.tools.find((x) => x.id === update.toolCallId);
        if (t) {
          if (update.status) {
            t.status = update.status;
          }
          if (update.title) {
            t.title = update.title;
          }
          if (update.locations?.length) {
            t.paths = update.locations.map((l) => l.path);
          }
        } else {
          msg.tools.push({
            id: update.toolCallId,
            title: update.title ?? update.toolCallId,
            status: update.status ?? "pending",
            kind: update.kind ?? undefined,
            paths: update.locations?.map((l) => l.path) ?? [],
          });
        }
        break;
      }
      default:
        break;
    }

    this.post({ type: "messages", messages: this.messages });
  }

  private pushSystem(text: string): void {
    this.messages.push({ type: "system", id: uid(), text });
    this.post({ type: "messages", messages: this.messages });
  }

  private async pushFullState(): Promise<void> {
    const hasAuth = await this.auth.hasAnyAuth();
    const state = this.agent.getState();
    this.post({
      type: "init",
      messages: this.messages,
      busy: this.agent.isBusy(),
      hasAuth,
      agentState: state.kind,
      agentDetail:
        state.kind === "ready"
          ? state.sessionId
          : state.kind === "error"
            ? state.message
            : "",
      model: getSettings().model || "default",
    });
  }

  private post(payload: unknown): void {
    // Broadcast to every live location (activity bar + secondary sidebar)
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
    --btn-sec: var(--vscode-button-secondaryBackground);
    --btn-sec-fg: var(--vscode-button-secondaryForeground);
    --bubble-user: var(--vscode-button-background);
    --bubble-user-fg: var(--vscode-button-foreground);
    --bubble-asst: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,0.15));
    --link: var(--vscode-textLink-foreground);
    --error: var(--vscode-errorForeground);
    --font: var(--vscode-font-family);
    --font-size: var(--vscode-font-size, 13px);
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font-family: var(--font); font-size: var(--font-size);
  }
  .ti { font-size: 1.05em; vertical-align: -0.1em; line-height: 1; }
  .ti-spin { display: inline-block; animation: ti-spin 1s linear infinite; }
  @keyframes ti-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .ti-spin { animation: none; }
  }
  #app {
    display: flex; flex-direction: column; height: 100%;
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  header .brand {
    display: flex; align-items: center; gap: 6px;
    font-weight: 600; flex: 1; min-width: 0;
  }
  header .brand .ti { font-size: 1.2em; flex-shrink: 0; }
  header .brand .title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  header .meta {
    color: var(--muted); font-size: 11px;
    display: flex; align-items: center; gap: 4px;
  }
  #messages {
    flex: 1; overflow-y: auto; padding: 10px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .msg { max-width: 100%; }
  .msg.user { align-self: flex-end; }
  .msg.assistant, .msg.system { align-self: stretch; }
  .bubble {
    padding: 8px 10px; border-radius: 8px;
    white-space: pre-wrap; word-break: break-word; line-height: 1.45;
  }
  .msg.user .bubble {
    background: var(--bubble-user); color: var(--bubble-user-fg);
  }
  .msg.assistant .bubble {
    background: var(--bubble-asst);
  }
  .msg.system .bubble {
    color: var(--muted); font-size: 12px; padding: 4px 0; background: transparent;
    display: flex; align-items: flex-start; gap: 6px;
  }
  .msg.system .bubble .ti { margin-top: 1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; justify-content: flex-end; }
  .chip {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted);
    display: inline-flex; align-items: center; gap: 4px;
  }
  .thought {
    margin-bottom: 6px; font-size: 12px; color: var(--muted);
  }
  .thought summary {
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; list-style: none;
  }
  .thought summary::-webkit-details-marker { display: none; }
  .thought pre {
    margin: 4px 0 0; white-space: pre-wrap; word-break: break-word;
    max-height: 160px; overflow: auto; opacity: 0.9;
  }
  .tools { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .tool {
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
    font-size: 12px;
  }
  .tool .row { display: flex; gap: 6px; align-items: center; }
  .tool .row .tool-icon { color: var(--muted); }
  .tool .status {
    color: var(--muted); margin-left: auto; text-transform: uppercase;
    font-size: 10px; display: inline-flex; align-items: center; gap: 4px;
  }
  .tool .paths a {
    color: var(--link); cursor: pointer; text-decoration: none;
    display: flex; align-items: center; gap: 4px; margin-top: 4px;
  }
  .tool .paths a:hover { text-decoration: underline; }
  #empty {
    margin: auto; text-align: center; color: var(--muted); padding: 24px 16px;
    max-width: 280px; line-height: 1.5;
  }
  #empty .hero-icon {
    font-size: 36px; margin-bottom: 8px; display: block; color: var(--fg);
  }
  #empty h2 { color: var(--fg); font-size: 14px; margin: 0 0 8px; }
  #empty .empty-actions {
    display: flex; flex-direction: column; gap: 8px; margin-top: 12px;
  }
  footer {
    border-top: 1px solid var(--border); padding: 8px; flex-shrink: 0;
    display: flex; flex-direction: column; gap: 6px;
  }
  #composer {
    width: 100%; min-height: 56px; max-height: 160px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 6px;
    padding: 8px; font-family: inherit; font-size: inherit;
  }
  #composer:focus { outline: 1px solid var(--vscode-focusBorder, var(--link)); }
  .actions { display: flex; gap: 6px; align-items: center; }
  button {
    border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer;
    background: var(--btn-bg); color: var(--btn-fg); font: inherit;
    display: inline-flex; align-items: center; gap: 5px;
  }
  button.secondary {
    background: var(--btn-sec); color: var(--btn-sec-fg);
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #send { margin-left: auto; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand">
      <i class="ti ti-message-chatbot" aria-hidden="true"></i>
      <span class="title">Grok Build</span>
    </div>
    <div class="meta" id="meta"><i class="ti ti-circle-dashed"></i><span>idle</span></div>
  </header>
  <div id="messages"></div>
  <div id="empty" hidden>
    <i class="ti ti-message-chatbot hero-icon" aria-hidden="true"></i>
    <h2>Grok Build - Community</h2>
    <p>Ask about this workspace. Active file and selection are attached when available.</p>
    <p id="empty-hint"></p>
    <div class="empty-actions">
      <button id="empty-start" type="button"><i class="ti ti-player-play"></i> Start agent</button>
      <button id="empty-login" class="secondary" type="button"><i class="ti ti-key"></i> Set API key</button>
    </div>
  </div>
  <footer>
    <textarea id="composer" placeholder="Message Grok… (Enter to send, Shift+Enter newline)" rows="3"></textarea>
    <div class="actions">
      <button id="stop" class="secondary" type="button" disabled title="Stop"><i class="ti ti-player-stop"></i> Stop</button>
      <button id="new" class="secondary" type="button" title="New session"><i class="ti ti-plus"></i> New</button>
      <button id="send" type="button" title="Send"><i class="ti ti-send"></i> Send</button>
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
let busy = false;

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
  if (String(label).startsWith('file:')) return 'file';
  return 'paperclip';
}

function renderMessages(messages) {
  messagesEl.innerHTML = '';
  emptyEl.hidden = messages.length > 0;
  for (const m of messages) {
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
      b.textContent = m.text;
      wrap.appendChild(b);
    } else if (m.type === 'assistant') {
      if (m.thought) {
        const d = document.createElement('details');
        d.className = 'thought';
        d.open = false;
        d.innerHTML = '<summary>' + icon('brain') + ' Thinking</summary><pre></pre>';
        d.querySelector('pre').textContent = m.thought;
        wrap.appendChild(d);
      }
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = m.text || (m.tools && m.tools.length ? '' : '…');
      wrap.appendChild(b);
      if (m.tools && m.tools.length) {
        const tools = document.createElement('div');
        tools.className = 'tools';
        for (const t of m.tools) {
          const card = document.createElement('div');
          card.className = 'tool';
          let paths = '';
          if (t.paths && t.paths.length) {
            paths = '<div class="paths">' + t.paths.map(p =>
              '<a data-path="' + esc(p) + '" href="#">' + icon('file') + esc(p) + '</a>'
            ).join('') + '</div>';
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
      b.querySelector('span').textContent = m.text;
      wrap.appendChild(b);
    }
    messagesEl.appendChild(wrap);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  if (b) {
    setMeta('working…', true);
  } else {
    setMeta(meta.dataset.base || 'idle', false);
  }
}

messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-path]');
  if (a) {
    e.preventDefault();
    vscode.postMessage({ type: 'openFile', path: a.getAttribute('data-path') });
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
document.getElementById('empty-start').addEventListener('click', () =>
  vscode.postMessage({ type: 'startAgent' }));
document.getElementById('empty-login').addEventListener('click', () =>
  vscode.postMessage({ type: 'login' }));

composer.addEventListener('keydown', (e) => {
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
    const base = (msg.agentState || 'idle') +
      (msg.agentDetail ? ' · ' + String(msg.agentDetail).slice(0, 12) : '') +
      ' · ' + (msg.model || '');
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
    if (!busy) setMeta(base, false);
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
