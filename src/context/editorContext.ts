import * as path from "node:path";
import * as vscode from "vscode";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { getSettings } from "../config/settings";

export interface ContextChip {
  id: string;
  label: string;
  kind: "file" | "selection" | "folder";
  fsPath: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

/**
 * Build ACP content blocks: user text + sticky chips + optional active editor.
 */
export function buildPromptBlocks(
  userText: string,
  options?: {
    includeEditorContext?: boolean;
    stickyChips?: ContextChip[];
  },
): { blocks: ContentBlock[]; chips: ContextChip[] } {
  const settings = getSettings();
  const blocks: ContentBlock[] = [{ type: "text", text: userText }];
  const chips: ContextChip[] = [];
  const seen = new Set<string>();

  const addChip = (c: ContextChip): void => {
    if (seen.has(c.id)) {
      return;
    }
    if (isExcluded(c.fsPath, settings.excludeGlob)) {
      return;
    }
    seen.add(c.id);
    chips.push(c);
    blocks.push(chipToBlock(c));
  };

  for (const c of options?.stickyChips ?? []) {
    addChip(c);
  }

  if (options?.includeEditorContext === false) {
    return { blocks, chips };
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return { blocks, chips };
  }

  const fsPath = editor.document.uri.fsPath;
  if (isExcluded(fsPath, settings.excludeGlob)) {
    return { blocks, chips };
  }

  const name = path.basename(fsPath);
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;

  if (settings.autoAttachSelection && hasSelection) {
    const start = selection.start.line + 1;
    const end = selection.end.line + 1;
    const selected = editor.document.getText(selection);
    addChip({
      id: `sel:${fsPath}:${start}-${end}`,
      label: `selection:${name}#L${start}-L${end}`,
      kind: "selection",
      fsPath,
      startLine: start,
      endLine: end,
      selectedText: selected.slice(0, 50_000),
    });
  } else if (settings.autoAttachActiveFile) {
    addChip({
      id: `file:${fsPath}`,
      label: `file:${name}`,
      kind: "file",
      fsPath,
    });
  }

  return { blocks, chips };
}

export function chipToBlock(c: ContextChip): ContentBlock {
  const uri = vscode.Uri.file(c.fsPath).toString();
  const name = path.basename(c.fsPath);
  if (c.kind === "selection") {
    return {
      type: "resource_link",
      uri,
      name,
      description: `Selection L${c.startLine ?? 1}-L${c.endLine ?? 1}`,
      _meta: {
        editor: {
          selection: {
            startLine: c.startLine ?? 1,
            endLine: c.endLine ?? 1,
          },
          selectedText: (c.selectedText ?? "").slice(0, 50_000),
        },
      },
    };
  }
  return {
    type: "resource_link",
    uri,
    name,
    description: c.fsPath,
  };
}

export function isExcluded(fsPath: string, globs: string[]): boolean {
  const normalized = fsPath.replace(/\\/g, "/");
  for (const g of globs) {
    const bare = g
      .replace(/^\*\*\//, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "");
    if (bare && normalized.includes(bare.replace(/\/$/, ""))) {
      if (g.includes("*credential*") && /credential/i.test(normalized)) {
        return true;
      }
      if (g.includes(".env") && /(^|\/)\.env(\.|$|\/)/.test(normalized)) {
        return true;
      }
      if (g.includes("secrets") && /\/secrets\//i.test(normalized)) {
        return true;
      }
      if (g.endsWith(".pem") && normalized.endsWith(".pem")) {
        return true;
      }
    }
  }
  return false;
}
