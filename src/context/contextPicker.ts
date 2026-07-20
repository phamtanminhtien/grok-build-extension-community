import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentService } from "../agent/agentService";
import { searchAgentMentions } from "../agent/fuzzyMentionSearch";
import type { FuzzyMatch } from "../agent/fuzzySearch";
import { getSettings } from "../config/settings";
import { isExcluded, type ContextChip } from "./editorContext";
import {
  formatMentionInsertText,
  matcherQuery,
  type AtContext,
} from "./atContext";
import { fuzzyMatchIndices, fuzzyScore } from "./fuzzyScore";
import { fuzzyMatchToSuggestion } from "./fuzzyMatchSuggest";
import type { ContextSuggestion } from "./contextPickerTypes";

export { fuzzyScore } from "./fuzzyScore";
export { formatMentionInsertText } from "./atContext";
export { fuzzyMatchToSuggestion } from "./fuzzyMatchSuggest";
export type { ContextSuggestion, SuggestionIcon } from "./contextPickerTypes";

export interface SearchContextOptions {
  /** When set and agent is ready, prefer agent fuzzy index for workspace hits. */
  agent?: AgentService;
  cwd?: string;
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
 *
 * Order:
 * 1. Current selection
 * 2. Open editors
 * 3. Agent fuzzy index (`x.ai/search/fuzzy/*`) when agent ready + query
 * 4. Host `findFiles` fallback (and when agent offline / empty)
 * 5. Host folder candidates when path-like query
 */
export async function searchContextSuggestions(
  rawQuery: string,
  limit = 24,
  options?: SearchContextOptions,
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
    // Ensure label highlight for query (agent may already set indices).
    if (q && (!s.highlightIndices || s.highlightIndices.length === 0)) {
      const hi = fuzzyMatchIndices(s.label, query);
      if (hi.length > 0) {
        s = { ...s, highlightIndices: hi };
      }
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

  // 3) Agent fuzzy index (primary workspace search when ready).
  let usedAgent = false;
  if (q && options?.agent) {
    const agentMatches = await searchAgentMentions(options.agent, query, {
      cwd: options.cwd,
      dirsOnly: dirOnly,
      limit: Math.min(200, limit * 4),
    });
    if (agentMatches.length > 0) {
      usedAgent = true;
      for (const m of agentMatches) {
        const sug = agentMatchToSuggestion(m, query);
        if (sug) {
          push(sug);
        }
      }
    }
  }

  // 4) Host findFiles — empty `@` leans on open editors; also fallback if agent empty.
  if (q && !usedAgent) {
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

  // 5) Folder matches when query looks like a path prefix (host; agent may already
  //    have returned directories via type=directory).
  if (q && (dirOnly || q.includes("/")) && !usedAgent) {
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

function agentMatchToSuggestion(
  m: FuzzyMatch,
  query: string,
): ContextSuggestion | null {
  let display: string | undefined;
  try {
    display = vscode.workspace.asRelativePath(vscode.Uri.file(m.path));
  } catch {
    display = undefined;
  }
  return fuzzyMatchToSuggestion(m, display, query);
}

/** Build suggestions using matcher query from an AtContext. */
export async function searchFromAtContext(
  ctx: AtContext,
  limit = 24,
  options?: SearchContextOptions,
): Promise<ContextSuggestion[]> {
  return searchContextSuggestions(matcherQuery(ctx), limit, options);
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
