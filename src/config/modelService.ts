import * as vscode from "vscode";

export type { GrokEffortOption, GrokModelOption, ModelCatalogSnapshot } from "./modelCatalog";
export {
  contextWindowFromCatalog,
  effortDisplayLabel,
  fallbackModels,
  LEGACY_EFFORT_OPTIONS,
  modelDisplayLabel,
  parseContextWindowTokens,
  parseModelsFromSessionMeta,
  parseSessionModelState,
} from "./modelCatalog";

export async function setModelSetting(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("grok")
    .update("model", model, vscode.ConfigurationTarget.Global);
}

export function getModelSetting(): string {
  return (
    vscode.workspace.getConfiguration("grok").get<string>("model") ?? ""
  ).trim();
}
