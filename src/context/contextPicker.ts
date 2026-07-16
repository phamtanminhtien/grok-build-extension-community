import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { isExcluded, type ContextChip } from "./editorContext";

/**
 * Multi-select QuickPick for sticky chat context (@ menu).
 */
export async function pickContextChips(): Promise<ContextChip[]> {
  const settings = getSettings();
  type Item = vscode.QuickPickItem & { chip?: ContextChip; action?: "search" };

  const items: Item[] = [];

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

  const openSeen = new Set<string>();
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme !== "file" || d.isUntitled) {
      continue;
    }
    if (openSeen.has(d.uri.fsPath)) {
      continue;
    }
    openSeen.add(d.uri.fsPath);
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

  items.push({
    label: "$(search) Browse workspace files…",
    alwaysShow: true,
    action: "search",
  });

  const pick = await vscode.window.showQuickPick(items, {
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
    if (p.action === "search") {
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
    }
  }

  return chips.filter((c) => !isExcluded(c.fsPath, settings.excludeGlob));
}
