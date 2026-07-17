import * as vscode from "vscode";
import type { AgentService, AgentState } from "../agent/agentService";
import { getSettings } from "../config/settings";
import type { BackgroundWorkItem } from "../agent/tasksStore";

export class GrokStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private busy = false;
  private state: AgentState = { kind: "idle" };
  private runningTasks = 0;
  private taskLines: string[] = [];
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
      this.agent.onTasksChange((snap) => {
        this.runningTasks = snap.runningCount;
        this.taskLines = snap.items
          .filter((i) => i.status === "running" || i.status === "stopping")
          .slice(0, 8)
          .map((i) => formatTaskLine(i));
        this.render();
      }),
    );
  }

  private render(): void {
    const model = getSettings().model || "default";
    const badge =
      this.runningTasks > 0 ? ` · $(server-process) ${this.runningTasks}` : "";
    const taskTip =
      this.runningTasks > 0
        ? `\n\nBackground (${this.runningTasks} running):\n${this.taskLines.join("\n")}${
            this.runningTasks > this.taskLines.length ? "\n…" : ""
          }\n\nOpen chat to manage (Tasks panel above composer).`
        : "";

    if (this.busy) {
      this.item.text = `$(loading~spin) Grok working…${badge}`;
      this.item.tooltip =
        "Grok Build is running a turn — click to open chat" + taskTip;
      this.item.backgroundColor = undefined;
      return;
    }

    switch (this.state.kind) {
      case "ready":
        this.item.text = `$(comment-discussion) Grok Build${badge}`;
        this.item.tooltip = `Ready · model ${model}${taskTip}`;
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
        this.item.text = `$(comment-discussion) Grok Build${badge}`;
        this.item.tooltip = "Click to open Grok Build chat" + taskTip;
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

function formatTaskLine(i: BackgroundWorkItem): string {
  const st = i.status === "stopping" ? "stopping" : "running";
  return `  · [${st}] ${i.tag} ${i.label}`;
}
