import * as path from "node:path";
import * as vscode from "vscode";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { getSettings } from "../config/settings";

export interface ContextChip {
  id: string;
  label: string;
  kind: "file" | "selection";
  fsPath: string;
}

/**
 * Build ACP content blocks: user text + optional active file / selection links.
 */
export function buildPromptBlocks(
  userText: string,
  options?: { includeEditorContext?: boolean },
): { blocks: ContentBlock[]; chips: ContextChip[] } {
  const settings = getSettings();
  const blocks: ContentBlock[] = [{ type: "text", text: userText }];
  const chips: ContextChip[] = [];

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

  const uri = editor.document.uri.toString();
  const name = path.basename(fsPath);
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;

  if (settings.autoAttachSelection && hasSelection) {
    const start = selection.start.line + 1;
    const end = selection.end.line + 1;
    const selected = editor.document.getText(selection);
    blocks.push({
      type: "resource_link",
      uri,
      name,
      description: `Selection L${start}-L${end}`,
      _meta: {
        editor: {
          selection: {
            startLine: start,
            endLine: end,
          },
          selectedText: selected.slice(0, 50_000),
        },
      },
    });
    chips.push({
      id: `sel:${fsPath}:${start}-${end}`,
      label: `selection:${name}#L${start}-L${end}`,
      kind: "selection",
      fsPath,
    });
  } else if (settings.autoAttachActiveFile) {
    blocks.push({
      type: "resource_link",
      uri,
      name,
      description: fsPath,
    });
    chips.push({
      id: `file:${fsPath}`,
      label: `file:${name}`,
      kind: "file",
      fsPath,
    });
  }

  return { blocks, chips };
}

function isExcluded(fsPath: string, globs: string[]): boolean {
  const normalized = fsPath.replace(/\\/g, "/");
  for (const g of globs) {
    // Simple substring / suffix heuristics for common secret globs
    const bare = g.replace(/^\*\*\//, "").replace(/\*\*/g, "").replace(/\*/g, "");
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
