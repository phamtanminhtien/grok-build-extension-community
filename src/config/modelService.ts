/**
 * Model selection helpers. Default model / reasoning effort are stored in
 * `~/.grok/config.toml` `[models]` (same as CLI/TUI), not VS Code settings.
 */

export type {
  GrokEffortOption,
  GrokModelOption,
  ModelCatalogSnapshot,
} from "./modelCatalog.ts";
export {
  contextWindowFromCatalog,
  effortDisplayLabel,
  fallbackModels,
  LEGACY_EFFORT_OPTIONS,
  modelDisplayLabel,
  parseContextWindowTokens,
  parseModelsFromSessionMeta,
  parseSessionModelState,
} from "./modelCatalog.ts";

import {
  loadModelsConfig,
  persistDefaultModel,
  persistDefaultReasoningEffort,
  persistModelsConfig,
} from "./modelsConfig.ts";

/** Read `[models].default` from config.toml. */
export function getModelSetting(): string {
  return loadModelsConfig().defaultModel;
}

/** Write `[models].default` (shared with CLI). */
export async function setModelSetting(model: string): Promise<void> {
  persistDefaultModel(model.trim());
}

/** Read `[models].default_reasoning_effort` from config.toml. */
export function getReasoningEffortSetting(): string {
  return loadModelsConfig().defaultReasoningEffort;
}

/** Write `[models].default_reasoning_effort` (shared with CLI). */
export async function setReasoningEffortSetting(effort: string): Promise<void> {
  persistDefaultReasoningEffort(effort.trim());
}

/** Persist both model and optional effort in one write. */
export async function setModelAndEffortSetting(
  model: string,
  effort?: string,
): Promise<void> {
  const patch: {
    defaultModel: string;
    defaultReasoningEffort?: string;
  } = { defaultModel: model.trim() };
  if (effort !== undefined) {
    patch.defaultReasoningEffort = effort.trim();
  }
  persistModelsConfig(patch);
}
