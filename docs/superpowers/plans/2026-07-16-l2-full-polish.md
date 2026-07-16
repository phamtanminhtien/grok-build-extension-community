# L2 Full Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship full-polish L2 features on the Grok Build Community VS Code extension: markdown + virtualized chat, `@` sticky context, model QuickPick, multi-file diff review, and session history/resume.

**Architecture:** Keep ACP agent process in Rust; extend the TypeScript host with focused services (`DiffReviewService`, `SessionHistoryStore`, `ContextPicker`, `ModelService`) and a richer chat webview. Optional ACP methods are capability-gated with local fallbacks.

**Tech Stack:** VS Code Extension API, `@agentclientprotocol/sdk`, TypeScript, esbuild, `marked` + `dompurify` (webview), Node built-in `node:test` for pure helpers.

**Spec:** [docs/superpowers/specs/2026-07-16-l2-full-polish-design.md](../specs/2026-07-16-l2-full-polish-design.md)

---

## File map

| Path | Role |
|------|------|
| `src/ui/markdown.ts` | Pure markdown → safe HTML (used by webview build or host pre-render) |
| `src/ui/messageVirtualList.ts` | Pure window-range helper for virtualization |
| `media/webview/` | Extracted webview CSS/JS assets (optional; may stay inline if smaller) |
| `src/context/editorContext.ts` | Extend to accept sticky chips |
| `src/context/contextPicker.ts` | `@` QuickPick sources |
| `src/config/modelService.ts` | Model list + QuickPick + settings write |
| `src/diff/snapshotStore.ts` | Path → old text cache with size cap |
| `src/diff/snapshotContentProvider.ts` | `TextDocumentContentProvider` for `grok-diff:` |
| `src/diff/diffReviewService.ts` | Review queue + open diffs |
| `src/session/sessionHistoryStore.ts` | Local session index in `Memento` |
| `src/agent/agentService.ts` | Caps, list/load session, restart after model |
| `src/agent/hostFs.ts` | Snapshot before write |
| `src/ui/chatViewProvider.ts` | Wire UI for all features |
| `src/extension.ts` | Register commands, providers, services |
| `package.json` | Commands, views, deps |
| `esbuild.mjs` | Bundle deps; copy webview assets if any |
| `src/**/*.test.ts` | Pure unit tests via `node:test` |
| `scripts/run-tests.mjs` | Compile/run pure tests without vscode |

---

### Task 1: Test harness for pure modules

**Files:**
- Create: `scripts/run-tests.mjs`
- Create: `src/ui/messageVirtualList.ts`
- Create: `src/ui/messageVirtualList.test.ts`
- Modify: `package.json` (script `test`)

- [ ] **Step 1: Add window-range helper**

```typescript
// src/ui/messageVirtualList.ts
export interface VirtualWindow {
  start: number;
  end: number; // exclusive
}

/**
 * Compute which message indices to mount given scroll metrics.
 * total: message count
 * scrollTop, viewportHeight, estimatedRowHeight: CSS pixels
 * overscan: extra rows above/below
 */
export function computeVirtualWindow(args: {
  total: number;
  scrollTop: number;
  viewportHeight: number;
  estimatedRowHeight: number;
  overscan?: number;
}): VirtualWindow {
  const { total, scrollTop, viewportHeight, estimatedRowHeight } = args;
  const overscan = args.overscan ?? 5;
  if (total <= 0 || estimatedRowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const first = Math.floor(scrollTop / estimatedRowHeight);
  const visible = Math.ceil(viewportHeight / estimatedRowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end };
}

export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
  thresholdPx = 48,
): boolean {
  return scrollTop + viewportHeight >= scrollHeight - thresholdPx;
}
```

- [ ] **Step 2: Write tests**

```typescript
// src/ui/messageVirtualList.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeVirtualWindow,
  shouldStickToBottom,
} from "./messageVirtualList.ts";

describe("computeVirtualWindow", () => {
  it("returns empty for zero total", () => {
    assert.deepEqual(
      computeVirtualWindow({
        total: 0,
        scrollTop: 0,
        viewportHeight: 400,
        estimatedRowHeight: 80,
      }),
      { start: 0, end: 0 },
    );
  });

  it("windows middle of long list", () => {
    const w = computeVirtualWindow({
      total: 100,
      scrollTop: 800,
      viewportHeight: 400,
      estimatedRowHeight: 80,
      overscan: 2,
    });
    // first visible ~10; start 8; visible 5; end 17
    assert.equal(w.start, 8);
    assert.equal(w.end, 17);
  });
});

describe("shouldStickToBottom", () => {
  it("true near bottom", () => {
    assert.equal(shouldStickToBottom(900, 1000, 100, 48), true);
  });
  it("false when scrolled up", () => {
    assert.equal(shouldStickToBottom(0, 1000, 100, 48), false);
  });
});
```

- [ ] **Step 3: Add test runner script**

```javascript
// scripts/run-tests.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

const tests = walk("src");
if (tests.length === 0) {
  console.error("No tests found");
  process.exit(1);
}
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...tests],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
```

Add to `package.json` scripts:

```json
"test": "node scripts/run-tests.mjs"
```

- [ ] **Step 4: Run tests**

Run: `cd grok-vscode-extension && npm test`  
Expected: PASS (2 describe blocks)

- [ ] **Step 5: Commit**

```bash
git add src/ui/messageVirtualList.ts src/ui/messageVirtualList.test.ts scripts/run-tests.mjs package.json
git commit -m "test: add pure unit harness and virtual list helper"
```

---

### Task 2: Markdown sanitize helper + deps

**Files:**
- Create: `src/ui/markdown.ts`
- Create: `src/ui/markdown.test.ts`
- Modify: `package.json` (deps `marked`, `dompurify`, `@types/dompurify`)
- Modify: `esbuild.mjs` if needed for package resolution

- [ ] **Step 1: Install deps**

```bash
cd grok-vscode-extension
npm install marked dompurify
npm install -D @types/dompurify
```

- [ ] **Step 2: Implement markdown helper**

```typescript
// src/ui/markdown.ts
import { marked } from "marked";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom"; // ONLY if host-side; prefer pure config for webview

// Prefer a dual approach:
// - Webview: import marked + DOMPurify browser builds in webview bundle
// - Host tests: use isomorphic-dompurify OR test only marked output + a small allowlist sanitizer

/**
 * For Node tests without full DOM, use a minimal sanitizer that strips tags
 * not in the allowlist. Production webview uses DOMPurify.
 */
const ALLOWED = new Set([
  "a","p","br","strong","em","ul","ol","li","code","pre","blockquote",
  "h1","h2","h3","h4","h5","h6","table","thead","tbody","tr","th","td",
  "hr","span","div",
]);

export function renderMarkdownToSafeHtml(md: string): string {
  const raw = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeHtml(raw);
}

export function sanitizeHtml(html: string): string {
  // Strip script/style and on* attributes; drop unknown tags (keep text)
  let out = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g, (full, tag: string, attrs = "") => {
    const name = tag.toLowerCase();
    if (!ALLOWED.has(name)) return "";
    if (name === "a") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || "");
      const url = href?.[2] ?? href?.[3] ?? href?.[4] ?? "";
      if (!/^(https?:|vscode:|file:|#|mailto:)/i.test(url)) {
        return full.startsWith("</") ? "</a>" : "<a>";
      }
      return full.startsWith("</")
        ? "</a>"
        : `<a href="${url.replace(/"/g, "")}" rel="noreferrer">`;
    }
    return full.startsWith("</") ? `</${name}>` : `<${name}>`;
  });
  return out;
}
```

Note: Keep sanitizer **self-contained** (no jsdom) so Node tests work. In webview, call the same `sanitizeHtml` after `marked.parse`, or call DOMPurify as a second pass if bundled. Prefer **one shared `sanitizeHtml`** to avoid dual behavior.

- [ ] **Step 3: Tests**

```typescript
// src/ui/markdown.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToSafeHtml, sanitizeHtml } from "./markdown.ts";

describe("renderMarkdownToSafeHtml", () => {
  it("renders fenced code", () => {
    const html = renderMarkdownToSafeHtml("```ts\nconst x = 1\n```");
    assert.match(html, /<pre>/);
    assert.match(html, /const x = 1/);
  });

  it("strips script tags", () => {
    const html = sanitizeHtml(`<p>ok</p><script>alert(1)</script>`);
    assert.equal(html.includes("script"), false);
    assert.match(html, /ok/);
  });

  it("strips onerror handlers", () => {
    const html = sanitizeHtml(`<img src=x onerror="alert(1)"><p>x</p>`);
    assert.equal(html.includes("onerror"), false);
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/ui/markdown.ts src/ui/markdown.test.ts
git commit -m "feat: add sanitized markdown renderer for chat"
```

---

### Task 3: Wire markdown + virtualization into chat webview

**Files:**
- Modify: `src/ui/chatViewProvider.ts` (HTML/JS `renderMessages`, styles)
- Modify: `esbuild.mjs` only if extracting a separate webview entry (prefer inline first to match L1)

- [ ] **Step 1: Bundle strategy for webview**

Keep single-file HTML in `getHtml` for L1 compatibility. Embed a compact marked+sanitize by:

**Option A (recommended for plan):** Pre-render markdown on the **extension host** when posting messages:

```typescript
// In ChatViewProvider before post({ type: "messages" })
function serializeMessages(messages: UiMessage[]) {
  return messages.map((m) => {
    if (m.type === "assistant") {
      return {
        ...m,
        html: renderMarkdownToSafeHtml(m.text || ""),
        thoughtHtml: m.thought ? renderMarkdownToSafeHtml(m.thought) : "",
      };
    }
    return m;
  });
}
```

Webview sets `b.innerHTML = m.html || esc(m.text)` for assistant only.

This avoids bundling marked into CSP-restricted webview and reuses Task 2 tests.

- [ ] **Step 2: Update webview render for assistant HTML + code copy**

In webview `renderMessages` for assistant:

```javascript
const b = document.createElement('div');
b.className = 'bubble md';
b.innerHTML = m.html || esc(m.text || (m.tools && m.tools.length ? '' : '…'));
// Code copy buttons
b.querySelectorAll('pre').forEach((pre) => {
  const btn = document.createElement('button');
  btn.className = 'copy-code';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(pre.innerText);
  });
  pre.prepend(btn);
});
```

Add CSS for `.bubble.md pre`, `.copy-code`, tables.

- [ ] **Step 3: Virtualization in webview**

Port `computeVirtualWindow` / `shouldStickToBottom` as duplicated small functions in the webview script (or inject constants). On `messages` update:

1. Store `allMessages` array  
2. On scroll, recompute window and re-render only that slice with spacer divs for total height  

```javascript
let allMessages = [];
const EST_ROW = 96;
function renderVirtual() {
  const total = allMessages.length;
  const stick = shouldStickToBottom(messagesEl.scrollTop, messagesEl.scrollHeight, messagesEl.clientHeight);
  const { start, end } = computeVirtualWindow({
    total,
    scrollTop: messagesEl.scrollTop,
    viewportHeight: messagesEl.clientHeight,
    estimatedRowHeight: EST_ROW,
    overscan: 6,
  });
  // top spacer, slice start..end, bottom spacer
  // if stick: after render set scrollTop = scrollHeight
}
```

For ≤ 40 messages, render all (skip virtualization overhead).

- [ ] **Step 4: Throttle host posts while streaming**

In `handleSessionUpdate`, debounce `post({ type: "messages" })` to 50ms:

```typescript
private messagesFlushTimer: ReturnType<typeof setTimeout> | undefined;
private scheduleMessagesPost(): void {
  if (this.messagesFlushTimer) return;
  this.messagesFlushTimer = setTimeout(() => {
    this.messagesFlushTimer = undefined;
    this.post({ type: "messages", messages: this.serializeMessages(this.messages) });
  }, 50);
}
```

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck && npm run build
```

Manual F5: ask for a markdown list + code fence; confirm render + copy.

- [ ] **Step 6: Commit**

```bash
git add src/ui/chatViewProvider.ts
git commit -m "feat(chat): render sanitized markdown and virtualize long threads"
```

---

### Task 4: Sticky context chips + `@` picker

**Files:**
- Modify: `src/context/editorContext.ts`
- Create: `src/context/contextPicker.ts`
- Create: `src/context/editorContext.test.ts` (pure path helpers if extracted)
- Modify: `src/ui/chatViewProvider.ts`
- Modify: `src/extension.ts`
- Modify: `package.json` (command `grok.addContext`)

- [ ] **Step 1: Extend chip model and block builder**

```typescript
// editorContext.ts — extend ContextChip
export interface ContextChip {
  id: string;
  label: string;
  kind: "file" | "selection" | "folder";
  fsPath: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

export function buildPromptBlocks(
  userText: string,
  options?: {
    includeEditorContext?: boolean;
    stickyChips?: ContextChip[];
  },
): { blocks: ContentBlock[]; chips: ContextChip[] } {
  const blocks: ContentBlock[] = [{ type: "text", text: userText }];
  const chips: ContextChip[] = [];
  const settings = getSettings();
  const seen = new Set<string>();

  const addChip = (c: ContextChip, block: ContentBlock) => {
    if (seen.has(c.id)) return;
    if (isExcluded(c.fsPath, settings.excludeGlob)) return;
    seen.add(c.id);
    chips.push(c);
    blocks.push(block);
  };

  for (const c of options?.stickyChips ?? []) {
    addChip(c, chipToBlock(c));
  }

  // existing auto-attach logic, skip if already in seen
  // ...
  return { blocks, chips };
}

function chipToBlock(c: ContextChip): ContentBlock {
  const uri = vscode.Uri.file(c.fsPath).toString();
  if (c.kind === "selection" && c.selectedText) {
    return {
      type: "resource_link",
      uri,
      name: path.basename(c.fsPath),
      description: `Selection L${c.startLine}-${c.endLine}`,
      _meta: {
        editor: {
          selection: { startLine: c.startLine, endLine: c.endLine },
          selectedText: c.selectedText.slice(0, 50_000),
        },
      },
    };
  }
  return {
    type: "resource_link",
    uri,
    name: path.basename(c.fsPath),
    description: c.fsPath,
  };
}
```

- [ ] **Step 2: Implement context picker**

```typescript
// src/context/contextPicker.ts
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextChip } from "./editorContext";
import { getSettings } from "../config/settings";

export async function pickContextChips(): Promise<ContextChip[]> {
  const settings = getSettings();
  type Item = vscode.QuickPickItem & { chip?: ContextChip };
  const items: Item[] = [];

  // Current selection
  const ed = vscode.window.activeTextEditor;
  if (ed && !ed.selection.isEmpty && ed.document.uri.scheme === "file") {
    const start = ed.selection.start.line + 1;
    const end = ed.selection.end.line + 1;
    const fsPath = ed.document.uri.fsPath;
    items.push({
      label: `$(selection) Selection ${path.basename(fsPath)}#L${start}-L${end}`,
      chip: {
        id: `sel:${fsPath}:${start}-${end}`,
        label: `selection:${path.basename(fsPath)}#L${start}-L${end}`,
        kind: "selection",
        fsPath,
        startLine: start,
        endLine: end,
        selectedText: ed.document.getText(ed.selection),
      },
    });
  }

  // Open editors
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme !== "file" || d.isUntitled) continue;
    items.push({
      label: `$(file) ${vscode.workspace.asRelativePath(d.uri)}`,
      description: "Open editor",
      chip: {
        id: `file:${d.uri.fsPath}`,
        label: `file:${path.basename(d.uri.fsPath)}`,
        kind: "file",
        fsPath: d.uri.fsPath,
      },
    });
  }

  // Workspace file search
  items.push({
    label: "$(search) Search workspace files…",
    alwaysShow: true,
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Add context to Grok",
    matchOnDescription: true,
    canPickMany: true,
  });
  if (!pick?.length) return [];

  const chips: ContextChip[] = [];
  for (const p of pick) {
    if (p.chip) {
      chips.push(p.chip);
      continue;
    }
    if (p.label.includes("Search workspace")) {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: "Add to Grok",
      });
      for (const u of uris ?? []) {
        if (u.scheme !== "file") continue;
        const stat = await vscode.workspace.fs.stat(u);
        const isDir = !!(stat.type & vscode.FileType.Directory);
        chips.push({
          id: `${isDir ? "folder" : "file"}:${u.fsPath}`,
          label: `${isDir ? "folder" : "file"}:${path.basename(u.fsPath)}`,
          kind: isDir ? "folder" : "file",
          fsPath: u.fsPath,
        });
      }
    }
  }
  return chips.filter((c) => !isExcludedPath(c.fsPath, settings.excludeGlob));
}

function isExcludedPath(fsPath: string, globs: string[]): boolean {
  // reuse same heuristics as editorContext or export isExcluded
  return false; // call shared export
}
```

Export `isExcluded` from `editorContext.ts` instead of duplicating.

- [ ] **Step 3: ChatViewProvider sticky state**

```typescript
private stickyChips: ContextChip[] = [];

// onMessage:
case "addContext": {
  const picked = await pickContextChips();
  for (const c of picked) {
    if (!this.stickyChips.some((x) => x.id === c.id)) this.stickyChips.push(c);
  }
  this.post({ type: "stickyChips", chips: this.stickyChips });
  break;
}
case "removeChip": {
  if (msg.id) {
    this.stickyChips = this.stickyChips.filter((c) => c.id !== msg.id);
    this.post({ type: "stickyChips", chips: this.stickyChips });
  }
  break;
}

// handleSend:
const { blocks, chips } = buildPromptBlocks(text, {
  stickyChips: this.stickyChips,
});
```

Composer UI: row of removable chips + `@` button posting `addContext`.

Webview: detect `@` at start of token → post `addContext` (simple: button + command; advanced: listen for `@` key).

- [ ] **Step 4: Register command**

```typescript
vscode.commands.registerCommand("grok.addContext", async () => {
  await chat.addContextFromPicker();
}),
```

`package.json` contributes command title `Grok Build: Add Context…`.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run build
```

Manual: add 2 files via `@`, remove one, send; Output shows resource links / agent sees files.

- [ ] **Step 6: Commit**

```bash
git add src/context/editorContext.ts src/context/contextPicker.ts src/ui/chatViewProvider.ts src/extension.ts package.json
git commit -m "feat(context): sticky chips and @ context picker"
```

---

### Task 5: Model QuickPick

**Files:**
- Create: `src/config/modelService.ts`
- Modify: `src/extension.ts`
- Modify: `src/ui/chatViewProvider.ts` (header click)
- Modify: `src/ui/statusBar.ts` (optional refresh)
- Modify: `package.json` (`grok.selectModel`)

- [ ] **Step 1: Model service**

```typescript
// src/config/modelService.ts
import * as vscode from "vscode";

const FALLBACK_MODELS = [
  { id: "", label: "Agent default" },
  { id: "grok-build", label: "grok-build" },
  { id: "grok-3", label: "grok-3" },
  { id: "grok-4", label: "grok-4" },
];

export async function selectModelQuickPick(
  extraIds: string[] = [],
): Promise<string | undefined> {
  const current = vscode.workspace.getConfiguration("grok").get<string>("model") ?? "";
  const seen = new Set<string>();
  const items: vscode.QuickPickItem[] = [];

  for (const m of [
    ...FALLBACK_MODELS,
    ...extraIds.map((id) => ({ id, label: id })),
  ]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    items.push({
      label: m.label,
      description: m.id === current ? "current" : m.id || "default",
    });
  }
  items.push({ label: "Other…", alwaysShow: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Select Grok model",
  });
  if (!pick) return undefined;
  if (pick.label === "Other…") {
    return vscode.window.showInputBox({
      title: "Model id",
      value: current,
      placeHolder: "e.g. grok-build",
    });
  }
  const match = FALLBACK_MODELS.find((m) => m.label === pick.label);
  if (match) return match.id;
  return pick.label;
}

export async function setModelSetting(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("grok")
    .update("model", model, vscode.ConfigurationTarget.Global);
}
```

- [ ] **Step 2: Wire command with restart**

```typescript
vscode.commands.registerCommand("grok.selectModel", async () => {
  const model = await selectModelQuickPick();
  if (model === undefined) return;
  if (agentService!.isBusy()) {
    const ok = await vscode.window.showWarningMessage(
      "A turn is in progress. Cancel and restart agent with new model?",
      "Restart",
      "Cancel",
    );
    if (ok !== "Restart") return;
    await agentService!.cancelTurn();
  }
  await setModelSetting(model);
  await agentService!.restart();
  void vscode.window.showInformationMessage(
    `Grok model set to ${model || "default"}`,
  );
  await chat.refreshState(); // post init with new model
}),
```

- [ ] **Step 3: Header model click**

Webview meta/model area:

```javascript
// post { type: 'selectModel' }
```

Host handles via `vscode.commands.executeCommand("grok.selectModel")`.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run build
```

Manual: command palette → select model → check settings + agent restart logs `--model`.

- [ ] **Step 5: Commit**

```bash
git add src/config/modelService.ts src/extension.ts src/ui/chatViewProvider.ts package.json
git commit -m "feat: model QuickPick with settings persist and agent restart"
```

---

### Task 6: Snapshot store + content provider

**Files:**
- Create: `src/diff/snapshotStore.ts`
- Create: `src/diff/snapshotStore.test.ts`
- Create: `src/diff/snapshotContentProvider.ts`

- [ ] **Step 1: Snapshot store**

```typescript
// src/diff/snapshotStore.ts
export class SnapshotStore {
  private readonly map = new Map<string, string>();
  constructor(private readonly maxCharsPerFile = 500_000) {}

  normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
  }

  capture(path: string, content: string): void {
    const key = this.normalizePath(path);
    if (content.length > this.maxCharsPerFile) {
      this.map.set(key, content.slice(0, this.maxCharsPerFile));
      return;
    }
    this.map.set(key, content);
  }

  get(path: string): string | undefined {
    return this.map.get(this.normalizePath(path));
  }

  has(path: string): boolean {
    return this.map.has(this.normalizePath(path));
  }

  clear(): void {
    this.map.clear();
  }

  paths(): string[] {
    return [...this.map.keys()];
  }
}
```

- [ ] **Step 2: Tests**

```typescript
// src/diff/snapshotStore.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore } from "./snapshotStore.ts";

describe("SnapshotStore", () => {
  it("captures and returns content", () => {
    const s = new SnapshotStore();
    s.capture("/a/b.ts", "hello");
    assert.equal(s.get("/a/b.ts"), "hello");
  });
  it("normalizes slashes", () => {
    const s = new SnapshotStore();
    s.capture("C:\\x\\y.ts", "z");
    assert.equal(s.get("C:/x/y.ts"), "z");
  });
});
```

- [ ] **Step 3: Content provider**

```typescript
// src/diff/snapshotContentProvider.ts
import * as vscode from "vscode";
import type { SnapshotStore } from "./snapshotStore";

export const GROK_DIFF_SCHEME = "grok-diff";

export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: SnapshotStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    // uri.path is fs path; query may include label
    const fsPath = uri.path;
    return this.store.get(fsPath) ?? "";
  }

  refresh(fsPath: string): void {
    this._onDidChange.fire(vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: fsPath }));
  }
}

export function snapshotUri(fsPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: fsPath, query: "before" });
}
```

- [ ] **Step 4: Run tests + commit**

```bash
npm test
git add src/diff/
git commit -m "feat(diff): snapshot store and grok-diff content provider"
```

---

### Task 7: Diff review service + host FS hook

**Files:**
- Create: `src/diff/diffReviewService.ts`
- Modify: `src/agent/hostFs.ts`
- Modify: `src/agent/agentService.ts` (pass snapshot on write / tool paths)
- Modify: `src/ui/chatViewProvider.ts` (Open Diff actions)
- Modify: `src/extension.ts`
- Modify: `package.json` (`grok.reviewEdits`)

- [ ] **Step 1: DiffReviewService**

```typescript
// src/diff/diffReviewService.ts
import * as path from "node:path";
import * as vscode from "vscode";
import { SnapshotStore } from "./snapshotStore";
import {
  SnapshotContentProvider,
  snapshotUri,
  GROK_DIFF_SCHEME,
} from "./snapshotContentProvider";

export interface ReviewEntry {
  path: string;
  toolCallId?: string;
  title?: string;
}

export class DiffReviewService implements vscode.Disposable {
  readonly store = new SnapshotStore();
  private readonly provider: SnapshotContentProvider;
  private entries: ReviewEntry[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<ReviewEntry[]>();
  readonly onDidChange = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.provider = new SnapshotContentProvider(this.store);
    this.sub = vscode.workspace.registerTextDocumentContentProvider(
      GROK_DIFF_SCHEME,
      this.provider,
    );
  }

  async captureIfMissing(fsPath: string, reader: () => Promise<string>): Promise<void> {
    if (this.store.has(fsPath)) return;
    try {
      const text = await reader();
      this.store.capture(fsPath, text);
      this.provider.refresh(fsPath);
    } catch {
      // new file — no baseline
    }
  }

  recordEdit(entry: ReviewEntry): void {
    const key = this.store.normalizePath(entry.path);
    if (!this.entries.some((e) => this.store.normalizePath(e.path) === key)) {
      this.entries.push({ ...entry, path: key });
      this._onDidChange.fire(this.entries);
    }
  }

  getEntries(): ReviewEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.store.clear();
    this._onDidChange.fire(this.entries);
  }

  async openDiff(fsPath: string): Promise<void> {
    const left = snapshotUri(fsPath);
    const right = vscode.Uri.file(fsPath);
    const title = `${path.basename(fsPath)} (Grok)`;
    if (!this.store.has(fsPath)) {
      await vscode.window.showTextDocument(right);
      return;
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  async openAll(): Promise<void> {
    for (const e of this.entries) {
      await this.openDiff(e.path);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
```

- [ ] **Step 2: Hook host write**

Change `writeTextFileHost` to accept optional pre-hook, or inject DiffReviewService:

```typescript
// hostFs.ts
let beforeWrite: ((path: string) => Promise<void>) | undefined;

export function setBeforeWriteHook(hook?: (path: string) => Promise<void>): void {
  beforeWrite = hook;
}

export async function writeTextFileHost(filePath: string, content: string) {
  if (beforeWrite) await beforeWrite(filePath);
  // existing write...
}
```

In `extension.ts` / agent setup:

```typescript
setBeforeWriteHook(async (p) => {
  await diffs.captureIfMissing(p, async () => (await readTextFileHost(p)).content);
  diffs.recordEdit({ path: p });
});
```

- [ ] **Step 3: Tool card Open Diff**

On `tool_call` / `tool_call_update` with paths and edit-like kind/title, `captureIfMissing` best-effort + `recordEdit`.

Tool card UI: buttons `data-diff-path` → post `{ type: 'openDiff', path }`.

Review banner: `Review edits (N)` → `openAll` or `grok.reviewEdits` QuickPick of entries.

- [ ] **Step 4: Verify**

```bash
npm test && npm run typecheck && npm run build
```

Manual: agent edits file via host FS → Open Diff shows before/after.

- [ ] **Step 5: Commit**

```bash
git add src/diff/ src/agent/hostFs.ts src/agent/agentService.ts src/ui/chatViewProvider.ts src/extension.ts package.json
git commit -m "feat(diff): multi-file edit review with vscode.diff"
```

---

### Task 8: Session history store

**Files:**
- Create: `src/session/sessionHistoryStore.ts`
- Create: `src/session/sessionHistoryStore.test.ts`

- [ ] **Step 1: Implement store**

```typescript
// src/session/sessionHistoryStore.ts
export interface SessionHistoryEntry {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  preview: string;
  messageCount: number;
}

const KEY = "grok.sessionHistory.v1";
const MAX = 50;

export class SessionHistoryStore {
  constructor(private readonly memento: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Thenable<void> }) {}

  list(): SessionHistoryEntry[] {
    const all = this.memento.get<SessionHistoryEntry[]>(KEY) ?? [];
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(entry: SessionHistoryEntry): Promise<void> {
    const all = this.list().filter((e) => e.sessionId !== entry.sessionId);
    all.unshift(entry);
    await this.memento.update(KEY, all.slice(0, MAX));
  }

  async remove(sessionId: string): Promise<void> {
    await this.memento.update(
      KEY,
      this.list().filter((e) => e.sessionId !== sessionId),
    );
  }
}

export function deriveTitle(preview: string, sessionId: string): string {
  const line = preview.trim().split("\n")[0] ?? "";
  if (line.length > 0) return line.slice(0, 80);
  return `Session ${sessionId.slice(0, 8)}`;
}
```

- [ ] **Step 2: Tests with in-memory memento**

```typescript
// src/session/sessionHistoryStore.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionHistoryStore, deriveTitle } from "./sessionHistoryStore.ts";

function mem() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
  };
}

describe("SessionHistoryStore", () => {
  it("upserts and lists newest first", async () => {
    const s = new SessionHistoryStore(mem());
    await s.upsert({
      sessionId: "a",
      cwd: "/w",
      title: "A",
      updatedAt: 1,
      preview: "hi",
      messageCount: 1,
    });
    await s.upsert({
      sessionId: "b",
      cwd: "/w",
      title: "B",
      updatedAt: 2,
      preview: "yo",
      messageCount: 2,
    });
    assert.equal(s.list()[0]?.sessionId, "b");
  });
});

describe("deriveTitle", () => {
  it("uses first line", () => {
    assert.equal(deriveTitle("Hello\nWorld", "xyz"), "Hello");
  });
});
```

- [ ] **Step 3: Commit**

```bash
npm test
git add src/session/
git commit -m "feat(session): local session history store"
```

---

### Task 9: AgentService session list/load + history UI

**Files:**
- Modify: `src/agent/agentService.ts`
- Modify: `src/ui/chatViewProvider.ts`
- Modify: `src/extension.ts`
- Modify: `package.json` (`grok.resumeSession`)

- [ ] **Step 1: Store agent capabilities after initialize**

```typescript
private agentCapabilities: {
  loadSession?: boolean;
  listSessions?: boolean;
  resumeSession?: boolean;
} = {};

// after initialize:
this.agentCapabilities = {
  loadSession: !!initResult.agentCapabilities?.loadSession,
  listSessions: !!(initResult.agentCapabilities as any)?.sessionCapabilities?.list
    || !!(initResult.agentCapabilities as any)?.listSessions,
  // inspect actual SDK shape from InitializeResponse and map precisely
};
```

Inspect `InitializeResponse` in SDK schema and map fields exactly (do not invent).

- [ ] **Step 2: listSessions / loadSession methods**

```typescript
async listRemoteSessions(): Promise<Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: number }>> {
  await this.ensureStarted();
  if (!this.agentCapabilities.listSessions || !this.connection) return [];
  try {
    const res = await this.connection.agent.listSessions({});
    return res.sessions ?? [];
  } catch (err) {
    logWarn(`session/list failed: ${formatUserError(err)}`);
    return [];
  }
}

async loadSession(sessionId: string, cwd?: string): Promise<void> {
  await this.ensureStarted();
  if (!this.connection) throw new Error("No connection");
  if (this.busy) await this.cancelTurn();
  this.session?.dispose();
  this.session = undefined;
  this.messagesClearRequested = true; // signal chat

  if (this.agentCapabilities.loadSession) {
    // Use SDK loadSession API — check exact method on connection.agent
    const session = await this.connection.agent.loadSession({
      sessionId,
      cwd: cwd ?? resolveSessionCwd(),
      mcpServers: [],
    });
    // Depending on SDK, may return ActiveSession or void + updates
    // Wire ActiveSession if returned; else session/new is wrong — use documented load
  } else {
    throw new Error(
      "Agent does not support session/load. History is local-only for this binary.",
    );
  }
}
```

**Implementation note:** Read `@agentclientprotocol/sdk` `ClientSideConnection` / `Agent` methods for the exact `loadSession` signature and how to obtain `ActiveSession`. Prefer SDK helpers over raw JSON-RPC.

- [ ] **Step 3: History upsert from chat**

On turn end / new session:

```typescript
await history.upsert({
  sessionId: agent.getSessionId()!,
  cwd: resolveSessionCwd(),
  title: deriveTitle(firstUserText, sessionId),
  updatedAt: Date.now(),
  preview: firstUserText.slice(0, 200),
  messageCount: this.messages.length,
});
```

- [ ] **Step 4: resumeSession command + webview History**

```typescript
async function resumeSessionCommand() {
  const local = history.list();
  const remote = await agentService!.listRemoteSessions();
  // merge by sessionId
  const pick = await vscode.window.showQuickPick(
    merged.map((e) => ({
      label: e.title,
      description: e.sessionId.slice(0, 8),
      detail: new Date(e.updatedAt).toLocaleString(),
      entry: e,
    })),
    { title: "Resume Grok session" },
  );
  if (!pick) return;
  try {
    chat.clearMessages();
    await agentService!.loadSession(pick.entry.sessionId, pick.entry.cwd);
    // session updates replay into chat via onSessionUpdate
  } catch (err) {
    void vscode.window.showErrorMessage(String(err));
  }
}
```

Header History button → same command.

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck && npm run build
```

Manual: new session, send message, History shows entry; load if agent supports.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agentService.ts src/session/ src/ui/chatViewProvider.ts src/extension.ts package.json
git commit -m "feat(session): history list and ACP session load/resume"
```

---

### Task 10: Docs + roadmap status

**Files:**
- Modify: `README.md`
- Modify: `docs/09-roadmap.md`
- Modify: `docs/05-ui-ux.md` (if commands table outdated)

- [ ] **Step 1: Update README status table**

Mark L2 items for features 1–5 as implemented with caveats (capability-gated resume, etc.).

- [ ] **Step 2: Check roadmap acceptance boxes** that are met; leave Win/Linux smoke unchecked if still TBD.

- [ ] **Step 3: Final verification**

```bash
npm test && npm run typecheck && npm run build
# optional:
npm run smoke:cli
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/
git commit -m "docs: mark L2 polish features in roadmap and README"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Markdown GFM + sanitize | 2, 3 |
| Virtualized 30+ messages | 1, 3 |
| Sticky `@` context chips | 4 |
| Model QuickPick + restart | 5 |
| Diff snapshots + vscode.diff | 6, 7 |
| Multi-file review list | 7 |
| Local session history | 8 |
| ACP list/load capability-gated | 9 |
| Commands + header UX | 3–5, 7, 9 |
| Docs/roadmap | 10 |

## Placeholder / consistency review

- Snapshot scheme name: always `grok-diff`  
- Chip type: always `ContextChip` from `editorContext.ts`  
- History memento key: `grok.sessionHistory.v1`  
- Commands: `grok.selectModel`, `grok.resumeSession`, `grok.reviewEdits`, `grok.addContext`  
- Host markdown render (not webview marked) to satisfy CSP  

## Execution notes

- Work in `grok-vscode-extension/`  
- Prefer small commits per task  
- After each task: `npm test && npm run typecheck && npm run build`  
- When SDK types differ from pseudo-code, trust installed `@agentclientprotocol/sdk` types  
