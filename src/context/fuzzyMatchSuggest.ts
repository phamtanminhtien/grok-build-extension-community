/**
 * Pure mapping: agent FuzzyMatch → @ mention suggestion.
 * No vscode dependency (unit-testable).
 */

import * as path from "node:path";
import type { FuzzyMatch } from "../agent/fuzzySearch.ts";
import type { ContextChip } from "./editorContext.ts";
import { formatMentionInsertText } from "./atContext.ts";
import type { ContextSuggestion } from "./contextPickerTypes.ts";
import { highlightIndicesForLabel } from "./fuzzyScore.ts";

function chipInsertText(chip: ContextChip, displayPath: string): string {
  return formatMentionInsertText(
    chip.kind,
    displayPath,
    chip,
    path.basename(chip.fsPath),
  );
}

/**
 * Map agent fuzzy match → @ suggestion (attach context, not open-in-editor).
 * `displayPath` should be workspace-relative when possible.
 */
export function fuzzyMatchToSuggestion(
  m: FuzzyMatch,
  displayPath?: string,
  query?: string,
): ContextSuggestion | null {
  const fsPath = m.path;
  if (!fsPath) {
    return null;
  }
  const rel = (displayPath ?? fsPath).replace(/\\/g, "/");
  const isDir = m.isDir;
  const kind = isDir ? "folder" : "file";
  const chip: ContextChip = {
    id: `${kind}:${fsPath}`,
    label: `${kind}:${path.basename(fsPath)}`,
    kind,
    fsPath,
  };
  // Agent score: higher is better → invert into lower-is-better rank.
  const rank = 18 + Math.max(0, 500 - Math.min(m.score, 500));
  const label = isDir ? (rel.endsWith("/") ? rel : `${rel}/`) : rel;
  const highlightIndices = query
    ? highlightIndicesForLabel(label, query, m.path, m.indices)
    : undefined;
  return {
    id: chip.id,
    label,
    description: "Grok index",
    icon: isDir ? "folder" : "file",
    score: rank,
    chip,
    insertText: chipInsertText(chip, rel),
    highlightIndices:
      highlightIndices && highlightIndices.length > 0
        ? highlightIndices
        : undefined,
  };
}
