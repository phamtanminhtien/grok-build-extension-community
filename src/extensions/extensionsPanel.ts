/**
 * Singleton editor-area webview panel for Hooks / Plugins / Marketplace /
 * Skills / MCP Servers (opens like a file tab).
 */

import * as vscode from "vscode";
import type { AgentService } from "../agent/agentService";
import { logError, logInfo, logWarn } from "../log/output";
import type { ExtensionAction } from "./actions";
import { tabToolbarActions } from "./actions";
import { fetchExtensionsTab, runExtensionAction } from "./extensionsData";
import { rowsForTab, type ExtensionRow } from "./rows";
import {
  EXTENSIONS_TAB_LABELS,
  EXTENSIONS_TABS,
  isExtensionsTab,
  type ExtensionsTab,
} from "./tabs";

export class ExtensionsPanel implements vscode.Disposable {
  public static readonly viewType = "grok.extensions";

  private static current: ExtensionsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private tab: ExtensionsTab;
  private cache = new Map<ExtensionsTab, ExtensionRow[]>();
  private loading = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    initialTab: ExtensionsTab,
  ) {
    this.panel = panel;
    this.tab = initialTab;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables,
    );
  }

  /**
   * Open or focus the panel on `tab` (default skills → hooks if omitted).
   */
  static show(
    extensionUri: vscode.Uri,
    agent: AgentService,
    tab: ExtensionsTab = "hooks",
  ): ExtensionsPanel {
    if (ExtensionsPanel.current) {
      ExtensionsPanel.current.reveal(tab);
      return ExtensionsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      ExtensionsPanel.viewType,
      "Grok Extensions",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "grok-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "grok-dark.svg"),
    };

    const inst = new ExtensionsPanel(panel, extensionUri, agent, tab);
    ExtensionsPanel.current = inst;
    void inst.loadTab(tab, true);
    return inst;
  }

  reveal(tab: ExtensionsTab): void {
    this.panel.reveal(vscode.ViewColumn.Active);
    void this.loadTab(tab, false);
  }

  dispose(): void {
    if (ExtensionsPanel.current === this) {
      ExtensionsPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    try {
      this.panel.dispose();
    } catch {
      /* already disposed */
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const m = msg as {
      type?: string;
      tab?: string;
      path?: string;
      action?: ExtensionAction;
    };

    switch (m.type) {
      case "ready":
        this.postState();
        void this.loadTab(this.tab, true);
        break;
      case "selectTab":
        if (isExtensionsTab(m.tab)) {
          void this.loadTab(m.tab, false);
        }
        break;
      case "refresh":
        void this.loadTab(this.tab, true);
        break;
      case "openPath":
        if (typeof m.path === "string" && m.path.trim()) {
          await openPathInEditor(m.path.trim());
        }
        break;
      case "runAction":
        if (m.action && typeof m.action === "object") {
          await this.handleAction(m.action);
        }
        break;
      default:
        break;
    }
  }

  private async handleAction(action: ExtensionAction): Promise<void> {
    this.loading = true;
    this.postState();
    try {
      await this.agent.ensureStarted();
      const outcome = await runExtensionAction(this.agent, action);
      logInfo(
        `extensions action ${action.kind}: ${outcome.message}` +
          (outcome.requiresRestart ? " (restart recommended)" : ""),
      );
      if (outcome.ok === false) {
        void vscode.window.showWarningMessage(outcome.message);
      } else {
        void vscode.window.setStatusBarMessage(
          `Grok: ${outcome.message}`,
          4000,
        );
        if (outcome.requiresRestart) {
          void vscode.window.showInformationMessage(
            `${outcome.message} — restart the agent for full effect.`,
          );
        }
      }
      // Always refresh current tab after an action attempt.
      this.cache.delete(this.tab);
      await this.loadTab(this.tab, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`extensions action failed: ${message}`);
      void vscode.window.showErrorMessage(`Grok Extensions: ${message}`);
      this.loading = false;
      this.postState();
    }
  }

  private async loadTab(tab: ExtensionsTab, force: boolean): Promise<void> {
    this.tab = tab;
    this.panel.title = `Grok Extensions — ${EXTENSIONS_TAB_LABELS[tab]}`;
    this.postState();

    if (!force && this.cache.has(tab)) {
      this.postRows(tab, this.cache.get(tab)!);
      return;
    }

    this.loading = true;
    this.postState();
    this.panel.webview.postMessage({ type: "loading", tab });

    try {
      await this.agent.ensureStarted();
      const payload = await fetchExtensionsTab(this.agent, tab);
      const rows = rowsForTab(payload);
      this.cache.set(tab, rows);
      this.postRows(tab, rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`extensions panel ${tab}: ${message}`);
      this.panel.webview.postMessage({
        type: "error",
        tab,
        message,
      });
    } finally {
      this.loading = false;
      this.postState();
    }
  }

  private postRows(tab: ExtensionsTab, rows: ExtensionRow[]): void {
    this.panel.webview.postMessage({ type: "data", tab, rows });
  }

  private postState(): void {
    this.panel.webview.postMessage({
      type: "state",
      tab: this.tab,
      loading: this.loading,
      agentReady: this.agent.getState().kind === "ready",
      toolbarActions: tabToolbarActions(this.tab),
    });
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

    const tabButtons = EXTENSIONS_TABS.map(
      (t) =>
        `<button type="button" class="tab" data-tab="${t}" id="tab-${t}">${EXTENSIONS_TAB_LABELS[t]}</button>`,
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Grok Extensions</title>
<link rel="stylesheet" href="${tablerCss}" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-editor-background);
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
    --list-hover: var(--vscode-list-hoverBackground);
    --list-active: var(--vscode-list-activeSelectionBackground);
    --badge: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --link: var(--vscode-textLink-foreground);
    --error: var(--vscode-errorForeground);
    --focus: var(--vscode-focusBorder);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
  }
  .shell {
    display: flex; flex-direction: column; height: 100%;
  }
  .toolbar {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 4px; flex: 1;
  }
  .tab {
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .tab:hover { background: var(--list-hover); color: var(--fg); }
  .tab.active {
    color: var(--fg);
    border-color: var(--focus);
    background: var(--list-active);
  }
  .actions { display: flex; gap: 6px; align-items: center; }
  input#filter {
    min-width: 140px;
    max-width: 240px;
    padding: 4px 8px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--input-fg);
    border-radius: 4px;
    font: inherit;
  }
  button.btn {
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    background: var(--btn-sec);
    color: var(--btn-sec-fg);
  }
  button.btn.primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
  }
  .status {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .status.error { color: var(--error); }
  .list {
    flex: 1; overflow: auto; padding: 8px 0;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    padding: 8px 14px;
    border-bottom: 1px solid transparent;
  }
  .row:hover { background: var(--list-hover); }
  .row.header {
    background: transparent;
    opacity: 0.95;
    margin-top: 6px;
  }
  .row.header .title {
    font-weight: 600;
    text-transform: none;
  }
  .title { font-weight: 500; word-break: break-word; }
  .subtitle { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .detail {
    color: var(--muted); font-size: 12px; margin-top: 2px;
    word-break: break-all; grid-column: 1 / -1;
  }
  .row-actions {
    display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
  }
  .row-btns {
    display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end;
  }
  button.act {
    border: none;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    background: var(--btn-sec);
    color: var(--btn-sec-fg);
  }
  button.act:hover { filter: brightness(1.08); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--badge);
    color: var(--badge-fg);
  }
  .empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--muted);
  }
  a.path {
    color: var(--link);
    cursor: pointer;
    text-decoration: none;
    font-size: 12px;
  }
  a.path:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="shell">
  <div class="toolbar">
    <div class="tabs">${tabButtons}</div>
    <div class="actions">
      <input id="filter" type="search" placeholder="Filter…" />
      <span id="toolbar-extra"></span>
      <button type="button" class="btn" id="refresh" title="Refresh list">
        <i class="ti ti-refresh"></i> Refresh
      </button>
    </div>
  </div>
  <div class="status" id="status">Loading…</div>
  <div class="list" id="list"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const tabs = ${JSON.stringify([...EXTENSIONS_TABS])};
let currentTab = ${JSON.stringify(this.tab)};
let rows = [];
let loading = false;
let errorMsg = '';
let toolbarActions = [];

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const filterEl = document.getElementById('filter');
const toolbarExtra = document.getElementById('toolbar-extra');

function setActiveTab(tab) {
  currentTab = tab;
  for (const t of tabs) {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  }
}

function renderToolbar() {
  toolbarExtra.innerHTML = '';
  for (const a of toolbarActions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = a.label || a.id;
    btn.disabled = loading;
    btn.addEventListener('click', () => {
      if (a.action) vscode.postMessage({ type: 'runAction', action: a.action });
    });
    toolbarExtra.appendChild(btn);
  }
}

function render() {
  renderToolbar();
  const q = (filterEl.value || '').toLowerCase().trim();
  const filtered = !q
    ? rows
    : rows.filter(r =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.subtitle || '').toLowerCase().includes(q) ||
        (r.detail || '').toLowerCase().includes(q) ||
        (r.path || '').toLowerCase().includes(q)
      );

  if (errorMsg) {
    statusEl.textContent = errorMsg;
    statusEl.className = 'status error';
  } else if (loading) {
    statusEl.textContent = 'Loading ' + currentTab + '…';
    statusEl.className = 'status';
  } else {
    statusEl.textContent = filtered.length + ' item(s)' + (q ? ' (filtered)' : '');
    statusEl.className = 'status';
  }

  if (!filtered.length && !loading) {
    listEl.innerHTML = '<div class="empty">' +
      (errorMsg ? escapeHtml(errorMsg) : 'No items. Start the agent and refresh.') +
      '</div>';
    return;
  }

  listEl.innerHTML = filtered.map((r, i) => {
    const badges = (r.badges || []).map(b =>
      '<span class="badge">' + escapeHtml(b) + '</span>').join('');
    const open = r.path
      ? '<a class="path" data-path="' + escapeAttr(r.path) + '" href="#">Open</a>'
      : '';
    const acts = (r.actions || []).map((a, j) =>
      '<button type="button" class="act" data-row="' + i + '" data-act="' + j + '"' +
      (loading ? ' disabled' : '') + '>' + escapeHtml(a.label || a.id) + '</button>'
    ).join('');
    return '<div class="row' + (r.isHeader ? ' header' : '') + '" data-i="' + i + '">' +
      '<div>' +
        '<div class="title">' + escapeHtml(r.title || '') + '</div>' +
        (r.subtitle ? '<div class="subtitle">' + escapeHtml(r.subtitle) + '</div>' : '') +
        (r.detail ? '<div class="detail">' + escapeHtml(r.detail) + '</div>' : '') +
      '</div>' +
      '<div class="row-actions">' +
        '<div class="badges">' + badges + '</div>' +
        '<div class="row-btns">' + acts + open + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('a.path').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const path = a.getAttribute('data-path');
      if (path) vscode.postMessage({ type: 'openPath', path });
    });
  });
  listEl.querySelectorAll('button.act').forEach(btn => {
    btn.addEventListener('click', () => {
      const ri = Number(btn.getAttribute('data-row'));
      const aj = Number(btn.getAttribute('data-act'));
      const row = filtered[ri];
      const action = row && row.actions && row.actions[aj] && row.actions[aj].action;
      if (action) vscode.postMessage({ type: 'runAction', action });
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

for (const t of tabs) {
  const el = document.getElementById('tab-' + t);
  if (el) {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectTab', tab: t });
    });
  }
}
document.getElementById('refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});
filterEl.addEventListener('input', () => render());

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'state') {
    if (msg.tab) setActiveTab(msg.tab);
    loading = !!msg.loading;
    if (Array.isArray(msg.toolbarActions)) toolbarActions = msg.toolbarActions;
    render();
  } else if (msg.type === 'loading') {
    if (msg.tab) setActiveTab(msg.tab);
    loading = true;
    errorMsg = '';
    render();
  } else if (msg.type === 'data') {
    if (msg.tab) setActiveTab(msg.tab);
    rows = Array.isArray(msg.rows) ? msg.rows : [];
    loading = false;
    errorMsg = '';
    render();
  } else if (msg.type === 'error') {
    if (msg.tab) setActiveTab(msg.tab);
    loading = false;
    errorMsg = msg.message || 'Failed to load';
    rows = [];
    render();
  }
});

setActiveTab(currentTab);
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

async function openPathInEditor(path: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(path);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      // Open folder in explorer / first file if possible
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    logError(`openPath ${path}`, err);
    void vscode.window.showWarningMessage(`Could not open path: ${path}`);
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
