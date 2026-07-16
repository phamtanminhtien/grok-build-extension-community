import * as vscode from "vscode";
import type { SnapshotStore } from "./snapshotStore";

export const GROK_DIFF_SCHEME = "grok-diff";

export class SnapshotContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: SnapshotStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.path) ?? "";
  }

  refresh(fsPath: string): void {
    this._onDidChange.fire(snapshotUri(fsPath));
  }
}

export function snapshotUri(fsPath: string): vscode.Uri {
  const normalized = fsPath.replace(/\\/g, "/");
  return vscode.Uri.from({
    scheme: GROK_DIFF_SCHEME,
    path: normalized.startsWith("/") ? normalized : `/${normalized}`,
    query: "before",
  });
}
