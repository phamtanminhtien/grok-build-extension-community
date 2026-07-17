import * as path from "node:path";
import * as vscode from "vscode";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { getSettings } from "../config/settings";
import { loadImageBlocksFromDisk, type AttachedImage } from "./promptImages";

export interface ContextChip {
  id: string;
  label: string;
  kind: "file" | "selection" | "folder";
  fsPath: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

/** Whether auto-attach of active editor/selection is enabled in settings. */
export function isAutoAttachEnabled(
  settings: ReturnType<typeof getSettings> = getSettings(),
): boolean {
  return settings.autoAttachActiveFile || settings.autoAttachSelection;
}

/**
 * Focused editor chip for UI preview (ignores auto-attach on/off).
 * Still respects exclude globs. Prefer selection label when selection exists.
 */
export function getActiveEditorChip(
  settings: ReturnType<typeof getSettings> = getSettings(),
): ContextChip | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return null;
  }

  const fsPath = editor.document.uri.fsPath;
  if (isExcluded(fsPath, settings.excludeGlob)) {
    return null;
  }

  const name = path.basename(fsPath);
  const selection = editor.selection;
  if (!selection.isEmpty) {
    const start = selection.start.line + 1;
    const end = selection.end.line + 1;
    return {
      id: `sel:${fsPath}:${start}-${end}`,
      label: `selection:${name}#L${start}-L${end}`,
      kind: "selection",
      fsPath,
      startLine: start,
      endLine: end,
      selectedText: editor.document.getText(selection).slice(0, 50_000),
    };
  }

  return {
    id: `file:${fsPath}`,
    label: `file:${name}`,
    kind: "file",
    fsPath,
  };
}

/**
 * Current active-editor context chip that would be auto-attached on send.
 * Returns null when disabled, no file editor, or path is excluded.
 */
export function getAutoAttachChip(
  settings: ReturnType<typeof getSettings> = getSettings(),
): ContextChip | null {
  if (!isAutoAttachEnabled(settings)) {
    return null;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return null;
  }

  const fsPath = editor.document.uri.fsPath;
  if (isExcluded(fsPath, settings.excludeGlob)) {
    return null;
  }

  const name = path.basename(fsPath);
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;

  if (settings.autoAttachSelection && hasSelection) {
    const start = selection.start.line + 1;
    const end = selection.end.line + 1;
    return {
      id: `sel:${fsPath}:${start}-${end}`,
      label: `selection:${name}#L${start}-L${end}`,
      kind: "selection",
      fsPath,
      startLine: start,
      endLine: end,
      selectedText: editor.document.getText(selection).slice(0, 50_000),
    };
  }

  if (settings.autoAttachActiveFile) {
    return {
      id: `file:${fsPath}`,
      label: `file:${name}`,
      kind: "file",
      fsPath,
    };
  }

  return null;
}

/**
 * Build ACP content blocks: user text + images + sticky chips + optional editor.
 * Order: text → image* → resource_link* (TUI text+images, then extension context).
 *
 * Extension UI shows image cards — do **not** inject TUI `[Image #N]` chips into
 * the text block or transcript. Images travel as dedicated content blocks only.
 */
export async function buildPromptBlocks(
  userText: string,
  options?: {
    includeEditorContext?: boolean;
    stickyChips?: ContextChip[];
    images?: AttachedImage[];
  },
): Promise<{
  blocks: ContentBlock[];
  chips: ContextChip[];
  text: string;
  images: AttachedImage[];
}> {
  const settings = getSettings();
  const images = options?.images ?? [];
  // Keep user text as typed (no `[Image #N]` placeholders).
  const text = userText;
  const blocks: ContentBlock[] = [{ type: "text", text }];
  if (images.length > 0) {
    blocks.push(...(await loadImageBlocksFromDisk(images)));
  }
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
    return { blocks, chips, text, images };
  }

  const auto = getAutoAttachChip(settings);
  if (auto) {
    addChip(auto);
  }

  return { blocks, chips, text, images };
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
