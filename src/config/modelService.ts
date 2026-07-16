import * as vscode from "vscode";
import {
  effortDisplayLabel,
  fallbackModels,
  modelDisplayLabel,
  type GrokEffortOption,
  type GrokModelOption,
} from "./modelCatalog";

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

/**
 * QuickPick using the agent catalog (same list as TUI). Falls back to bundled
 * defaults when the catalog is empty.
 */
export async function selectModelQuickPick(
  catalog: readonly GrokModelOption[] = [],
  currentId = "",
): Promise<string | undefined> {
  const current =
    currentId.trim() ||
    vscode.workspace.getConfiguration("grok").get<string>("model") ||
    "";
  const source = catalog.length > 0 ? catalog : fallbackModels();
  const seen = new Set<string>();
  const items: Array<vscode.QuickPickItem & { modelId: string }> = [];

  for (const m of source) {
    if (seen.has(m.id)) {
      continue;
    }
    seen.add(m.id);
    items.push({
      label: m.label,
      description: m.id === current ? "current" : m.id,
      detail: m.description,
      picked: m.id === current,
      modelId: m.id,
    });
  }
  items.push({
    label: "Other…",
    alwaysShow: true,
    modelId: "__other__",
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Select model",
    placeHolder: modelDisplayLabel(source, current) || "model",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) {
    return undefined;
  }
  if (pick.modelId === "__other__") {
    return vscode.window.showInputBox({
      title: "Model id",
      value: current,
      placeHolder: "e.g. grok-build",
      prompt: "Must match a model id from the agent catalog",
    });
  }
  return pick.modelId;
}

export async function selectEffortQuickPick(
  efforts: readonly GrokEffortOption[],
  currentId = "",
): Promise<string | undefined> {
  if (efforts.length === 0) {
    void vscode.window.showInformationMessage(
      "Current model does not support reasoning effort levels.",
    );
    return undefined;
  }
  const items = efforts.map((e) => ({
    label: e.label,
    description: e.id === currentId ? "current" : e.id,
    detail: e.description,
    picked: e.id === currentId,
    effortId: e.id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: "Reasoning effort",
    placeHolder: effortDisplayLabel(efforts, currentId) || "effort",
  });
  return pick?.effortId;
}

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
