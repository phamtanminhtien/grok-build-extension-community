import type { ContextChip } from "./editorContext";

export type SuggestionIcon = "file" | "folder" | "selection" | "search";

/** Item shown in the in-webview @ mention popover. */
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
  /**
   * Character indices in `label` to highlight (fuzzy query match).
   * Optional — host recomputes when missing.
   */
  highlightIndices?: number[];
}
