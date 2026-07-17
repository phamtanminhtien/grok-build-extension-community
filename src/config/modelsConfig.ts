/**
 * Default model + reasoning effort — shared with CLI/TUI via
 * `~/.grok/config.toml` `[models]`:
 *
 *   default = "grok-4.5"
 *   default_reasoning_effort = "high"
 */

import {
  extractTomlSection,
  grokConfigPath,
  matchStringKey,
  readGrokConfigText,
  upsertTomlSectionString,
  writeGrokConfigText,
} from "./tomlConfig.ts";

export interface ModelsConfig {
  /** `[models].default` — empty when unset. */
  defaultModel: string;
  /** `[models].default_reasoning_effort` — empty when unset. */
  defaultReasoningEffort: string;
}

export function resolveModelsConfigFromToml(text: string): ModelsConfig {
  const section = extractTomlSection(text, "models") ?? "";
  return {
    defaultModel: (matchStringKey(section, "default") ?? "").trim(),
    defaultReasoningEffort: (
      matchStringKey(section, "default_reasoning_effort") ?? ""
    ).trim(),
  };
}

export function loadModelsConfig(
  configPath: string = grokConfigPath(),
): ModelsConfig {
  return resolveModelsConfigFromToml(readGrokConfigText(configPath));
}

/**
 * Persist model and/or reasoning effort to `[models]`.
 * Pass `undefined` to leave a field unchanged; `""` to clear it.
 */
export function persistModelsConfig(
  patch: {
    defaultModel?: string;
    defaultReasoningEffort?: string;
  },
  configPath: string = grokConfigPath(),
): ModelsConfig {
  let text = readGrokConfigText(configPath);
  if (patch.defaultModel !== undefined) {
    text = upsertTomlSectionString(
      text,
      "models",
      "default",
      patch.defaultModel.trim(),
    );
  }
  if (patch.defaultReasoningEffort !== undefined) {
    text = upsertTomlSectionString(
      text,
      "models",
      "default_reasoning_effort",
      patch.defaultReasoningEffort.trim(),
    );
  }
  writeGrokConfigText(text, configPath);
  return resolveModelsConfigFromToml(text);
}

export function persistDefaultModel(
  model: string,
  configPath: string = grokConfigPath(),
): void {
  persistModelsConfig({ defaultModel: model }, configPath);
}

export function persistDefaultReasoningEffort(
  effort: string,
  configPath: string = grokConfigPath(),
): void {
  persistModelsConfig({ defaultReasoningEffort: effort }, configPath);
}
