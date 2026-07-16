import * as vscode from "vscode";
import type { AgentService, AgentState } from "../agent/agentService";
import { getSettings } from "../config/settings";

export class GrokStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private busy = false;
  private state: AgentState = { kind: "idle" };
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly agent: AgentService) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.command = "grok.openChat";
    this.item.show();
    this.render();

    this.subs.push(
      this.agent.onStateChange((s) => {
        this.state = s;
        this.render();
      }),
      this.agent.onBusyChange((b) => {
        this.busy = b;
        this.render();
      }),
    );
  }

  private render(): void {
    const model = getSettings().model || "default";

    if (this.busy) {
      this.item.text = "$(loading~spin) Grok working…";
      this.item.tooltip = "Grok Build is running a turn — click to open chat";
      this.item.backgroundColor = undefined;
      return;
    }

    switch (this.state.kind) {
      case "ready":
        this.item.text = `$(comment-discussion) Grok Build`;
        this.item.tooltip = `Ready · session ${this.state.sessionId.slice(0, 8)}… · model ${model}`;
        this.item.backgroundColor = undefined;
        break;
      case "starting":
        this.item.text = "$(loading~spin) Grok starting…";
        this.item.tooltip = "Starting Grok agent";
        this.item.backgroundColor = undefined;
        break;
      case "error":
        this.item.text = "$(error) Grok Build";
        this.item.tooltip = this.state.message;
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      default:
        this.item.text = "$(comment-discussion) Grok Build";
        this.item.tooltip = "Click to open Grok Build chat";
        this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.item.dispose();
  }
}
