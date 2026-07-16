import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { isExcluded, type ContextChip } from "./editorContext";
import { matcherQuery, type AtContext } from "./atContext";
import { fuzzyScore } from "./fuzzyScore";

export { fuzzyScore } from "./fuzzyScore";

export type SuggestionIcon = "file" | "folder" | "selection" | "search";

/** Item shown in the in-webview @ mention popover (aligned with grok-build sources). */
export interface ContextSuggestion {
  id: string;
  label: string;
  description?: string;
  icon: SuggestionIcon;
  chip: ContextChip;
  /** Simple rank — lower is better. */
  score: number;
}

/**
 * Multi-select QuickPick for sticky chat context (command palette / fallback).
 */
export async function pickContextChips(): Promise<ContextChip[]> {
  const items = await searchContextSuggestions("", 40);
  type Item = vscode.QuickPickItem & { chip?: ContextChip; action?: "browse" };

  const qpItems: Item[] = items.map((s) => ({
    label: s.label,
    description: s.description,
    chip: s.chip,
  }));
  qpItems.push({
    label: "$(search) Browse workspace files…",
    alwaysShow: true,
    action: "browse",
  });

  const pick = await vscode.window.showQuickPick(qpItems, {
    title: "Add context to Grok",
    matchOnDescription: true,
    canPickMany: true,
  });
  if (!pick?.length) {
    return [];
  }

  const chips: ContextChip[] = [];
  for (const p of pick) {
    if (p.chip) {
      chips.push(p.chip);
      continue;
    }
    if (p.action === "browse") {
      chips.push(...(await browseWorkspaceChips()));
    }
  }

  const settings = getSettings();
  return chips.filter((c) => !isExcluded(c.fsPath, settings.excludeGlob));
}

/**
 * Fuzzy-ish workspace + open-editor suggestions for the @ popover.
 * Mirrors grok-build file_search sources: open context first, then workspace files.
 */
export async function searchContextSuggestions(
  rawQuery: string,
  limit = 24,
): Promise<ContextSuggestion[]> {
  const settings = getSettings();
  const query = rawQuery.startsWith("!") ? rawQuery.slice(1) : rawQuery;
  const q = query.trim().toLowerCase();
  const dirOnly = query.endsWith("/");
  const results: ContextSuggestion[] = [];
  const seen = new Set<string>();

  const push = (s: ContextSuggestion): void => {
    if (seen.has(s.id) || isExcluded(s.chip.fsPath, settings.excludeGlob)) {
      return;
    }
    seen.add(s.id);
    results.push(s);
  };

  // 1) Current selection
  const ed = vscode.window.activeTextEditor;
  if (ed && !ed.selection.isEmpty && ed.document.uri.scheme === "file") {
    const start = ed.selection.start.line + 1;
    const end = ed.selection.end.line + 1;
    const fsPath = ed.document.uri.fsPath;
    const base = path.basename(fsPath);
    const label = `selection:${base}#L${start}-L${end}`;
    if (!q || fuzzyScore(label.toLowerCase(), q) < Infinity) {
      push({
        id: `sel:${fsPath}:${start}-${end}`,
        label,
        description: "Current selection",
        icon: "selection",
        score: 0,
        chip: {
          id: `sel:${fsPath}:${start}-${end}`,
          label,
          kind: "selection",
          fsPath,
          startLine: start,
          endLine: end,
          selectedText: ed.document.getText(ed.selection).slice(0, 50_000),
        },
      });
    }
  }

  // 2) Open editors
  const openSeen = new Set<string>();
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme !== "file" || d.isUntitled) {
      continue;
    }
    if (openSeen.has(d.uri.fsPath)) {
      continue;
    }
    openSeen.add(d.uri.fsPath);
    const rel = vscode.workspace.asRelativePath(d.uri);
    const score = q ? fuzzyScore(rel.toLowerCase(), q) : 1;
    if (score === Infinity) {
      continue;
    }
    if (dirOnly) {
      continue;
    }
    push({
      id: `file:${d.uri.fsPath}`,
      label: rel,
      description: "Open editor",
      icon: "file",
      score: score + 10,
      chip: {
        id: `file:${d.uri.fsPath}`,
        label: `file:${path.basename(d.uri.fsPath)}`,
        kind: "file",
        fsPath: d.uri.fsPath,
      },
    });
  }

  // 3) Workspace files via findFiles (only when there is a query — empty `@`
  //    mirrors grok-build by leaning on open editors / selection first).
  if (q) {
    try {
      const glob = buildFindGlob(query);
      const uris = await vscode.workspace.findFiles(
        glob,
        "**/node_modules/**,**/.git/**,**/dist/**,**/target/**,**/.codegraph/**",
        Math.min(200, limit * 8),
      );
      for (const u of uris) {
        if (u.scheme !== "file") {
          continue;
        }
        const rel = vscode.workspace.asRelativePath(u);
        const score = fuzzyScore(rel.toLowerCase(), q);
        if (score === Infinity) {
          continue;
        }
        if (dirOnly) {
          const prefix = query.replace(/\/$/, "").toLowerCase();
          if (
            !rel.toLowerCase().startsWith(prefix) &&
            !rel.toLowerCase().includes(`/${prefix}`)
          ) {
            continue;
          }
        }
        push({
          id: `file:${u.fsPath}`,
          label: rel,
          description: "Workspace",
          icon: "file",
          score: score + 20,
          chip: {
            id: `file:${u.fsPath}`,
            label: `file:${path.basename(u.fsPath)}`,
            kind: "file",
            fsPath: u.fsPath,
          },
        });
      }
    } catch {
      /* findFiles can fail without a workspace */
    }
  }

  // 4) Folder matches when query looks like a path prefix
  if (q && (dirOnly || q.includes("/"))) {
    const folderUris = await findFolderCandidates(query, limit);
    for (const u of folderUris) {
      const rel = vscode.workspace.asRelativePath(u);
      const score = fuzzyScore(rel.toLowerCase(), q.replace(/\/$/, ""));
      if (score === Infinity) {
        continue;
      }
      push({
        id: `folder:${u.fsPath}`,
        label: rel + "/",
        description: "Folder",
        icon: "folder",
        score: score + 5,
        chip: {
          id: `folder:${u.fsPath}`,
          label: `folder:${path.basename(u.fsPath)}`,
          kind: "folder",
          fsPath: u.fsPath,
        },
      });
    }
  }

  results.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  return results.slice(0, limit);
}

/** Build suggestions using matcher query from an AtContext. */
export async function searchFromAtContext(
  ctx: AtContext,
  limit = 24,
): Promise<ContextSuggestion[]> {
  return searchContextSuggestions(matcherQuery(ctx), limit);
}

async function browseWorkspaceChips(): Promise<ContextChip[]> {
  const chips: ContextChip[] = [];
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: true,
    openLabel: "Add to Grok",
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  for (const u of uris ?? []) {
    if (u.scheme !== "file") {
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(u);
      const isDir = !!(stat.type & vscode.FileType.Directory);
      chips.push({
        id: `${isDir ? "folder" : "file"}:${u.fsPath}`,
        label: `${isDir ? "folder" : "file"}:${path.basename(u.fsPath)}`,
        kind: isDir ? "folder" : "file",
        fsPath: u.fsPath,
      });
    } catch {
      chips.push({
        id: `file:${u.fsPath}`,
        label: `file:${path.basename(u.fsPath)}`,
        kind: "file",
        fsPath: u.fsPath,
      });
    }
  }
  return chips;
}

function buildFindGlob(query: string): string {
  const q = query.replace(/^!/, "").replace(/\/$/, "").trim();
  if (!q) {
    return "**/*";
  }
  // Escape glob specials except path separators we intentionally use.
  const safe = q.replace(/([*?[\]{}])/g, "\\$1");
  if (safe.includes("/") || safe.includes("\\")) {
    return `**/${safe}*`;
  }
  return `**/*${safe}*`;
}

async function findFolderCandidates(
  query: string,
  limit: number,
): Promise<vscode.Uri[]> {
  const prefix = query.replace(/^!/, "").replace(/\/$/, "").trim();
  if (!prefix) {
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: vscode.Uri[] = [];
  for (const folder of folders) {
    // Walk one level deep + try path join for typed prefixes.
    const parts = prefix.split(/[/\\]/).filter(Boolean);
    let base = folder.uri;
    for (const part of parts) {
      base = vscode.Uri.joinPath(base, part);
    }
    try {
      const st = await vscode.workspace.fs.stat(base);
      if (st.type & vscode.FileType.Directory) {
        out.push(base);
      }
    } catch {
      /* not a full path yet */
    }
    // Also list siblings under parent of last segment.
    try {
      const parent =
        parts.length > 1
          ? vscode.Uri.joinPath(folder.uri, ...parts.slice(0, -1))
          : folder.uri;
      const last = (parts[parts.length - 1] ?? "").toLowerCase();
      const entries = await vscode.workspace.fs.readDirectory(parent);
      for (const [name, type] of entries) {
        if (!(type & vscode.FileType.Directory)) {
          continue;
        }
        if (last && !name.toLowerCase().includes(last)) {
          continue;
        }
        out.push(vscode.Uri.joinPath(parent, name));
        if (out.length >= limit) {
          return out;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}
