import * as vscode from "vscode";

const FALLBACK_MODELS: Array<{ id: string; label: string }> = [
  { id: "", label: "Agent default" },
  { id: "grok-build", label: "grok-build" },
  { id: "grok-3", label: "grok-3" },
  { id: "grok-4", label: "grok-4" },
];

/**
 * QuickPick for grok.model. Returns selected model id, or undefined if cancelled.
 */
export async function selectModelQuickPick(
  extraIds: string[] = [],
): Promise<string | undefined> {
  const current =
    vscode.workspace.getConfiguration("grok").get<string>("model") ?? "";
  const seen = new Set<string>();
  const items: vscode.QuickPickItem[] = [];

  for (const m of [
    ...FALLBACK_MODELS,
    ...extraIds.map((id) => ({ id, label: id })),
  ]) {
    if (seen.has(m.id)) {
      continue;
    }
    seen.add(m.id);
    items.push({
      label: m.label,
      description:
        m.id === current ? "current" : m.id || "(agent default)",
      picked: m.id === current,
    });
  }
  items.push({ label: "Other…", alwaysShow: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Select Grok model",
    placeHolder: current || "agent default",
  });
  if (!pick) {
    return undefined;
  }
  if (pick.label === "Other…") {
    return vscode.window.showInputBox({
      title: "Model id",
      value: current,
      placeHolder: "e.g. grok-build",
      prompt: "Empty string uses the agent default",
    });
  }
  const match = FALLBACK_MODELS.find((m) => m.label === pick.label);
  if (match) {
    return match.id;
  }
  return pick.label;
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
