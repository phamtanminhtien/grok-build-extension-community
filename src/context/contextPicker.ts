import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { isExcluded, type ContextChip } from "./editorContext";
import {
  formatMentionInsertText,
  matcherQuery,
  type AtContext,
} from "./atContext";
import { fuzzyScore } from "./fuzzyScore";

export { fuzzyScore } from "./fuzzyScore";
export { formatMentionInsertText } from "./atContext";

export type SuggestionIcon = "file" | "folder" | "selection" | "search";

/** Item shown in the in-webview @ mention popover (aligned with grok-build sources). */
export interface ContextSuggestion {
  id: string;
  label: string;
  description?: string;
  icon: SuggestionIcon;
  chip: ContextChip;
  /**
   * Text inserted into the composer when accepting (TUI `@path` / `@path:N-M`).
   * Includes a trailing space so the user can keep typing.
   */
  insertText: string;
  /** Simple rank — lower is better. */
  score: number;
}

function chipInsertText(chip: ContextChip, displayPath: string): string {
  return formatMentionInsertText(
    chip.kind,
    displayPath,
    chip,
    path.basename(chip.fsPath),
  );
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
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const label = `selection:${base}#L${start}-L${end}`;
    if (!q || fuzzyScore(label.toLowerCase(), q) < Infinity) {
      const chip: ContextChip = {
        id: `sel:${fsPath}:${start}-${end}`,
        label,
        kind: "selection",
        fsPath,
        startLine: start,
        endLine: end,
        selectedText: ed.document.getText(ed.selection).slice(0, 50_000),
      };
      push({
        id: chip.id,
        label,
        description: "Current selection",
        icon: "selection",
        score: 0,
        chip,
        insertText: chipInsertText(chip, rel),
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
    const chip: ContextChip = {
      id: `file:${d.uri.fsPath}`,
      label: `file:${path.basename(d.uri.fsPath)}`,
      kind: "file",
      fsPath: d.uri.fsPath,
    };
    push({
      id: chip.id,
      label: rel,
      description: "Open editor",
      icon: "file",
      score: score + 10,
      chip,
      insertText: chipInsertText(chip, rel),
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
        const chip: ContextChip = {
          id: `file:${u.fsPath}`,
          label: `file:${path.basename(u.fsPath)}`,
          kind: "file",
          fsPath: u.fsPath,
        };
        push({
          id: chip.id,
          label: rel,
          description: "Workspace",
          icon: "file",
          score: score + 20,
          chip,
          insertText: chipInsertText(chip, rel),
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
      const chip: ContextChip = {
        id: `folder:${u.fsPath}`,
        label: `folder:${path.basename(u.fsPath)}`,
        kind: "folder",
        fsPath: u.fsPath,
      };
      push({
        id: chip.id,
        label: rel + "/",
        description: "Folder",
        icon: "folder",
        score: score + 5,
        chip,
        insertText: chipInsertText(chip, rel),
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
