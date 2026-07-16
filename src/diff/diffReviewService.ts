import * as path from "node:path";
import * as vscode from "vscode";
import { SnapshotStore } from "./snapshotStore";
import {
  GROK_DIFF_SCHEME,
  SnapshotContentProvider,
  snapshotUri,
} from "./snapshotContentProvider";

export interface ReviewEntry {
  path: string;
  toolCallId?: string;
  title?: string;
}

export class DiffReviewService implements vscode.Disposable {
  readonly store = new SnapshotStore();
  private readonly provider: SnapshotContentProvider;
  private entries: ReviewEntry[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<ReviewEntry[]>();
  readonly onDidChange = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.provider = new SnapshotContentProvider(this.store);
    this.sub = vscode.workspace.registerTextDocumentContentProvider(
      GROK_DIFF_SCHEME,
      this.provider,
    );
  }

  async captureIfMissing(
    fsPath: string,
    reader: () => Promise<string>,
  ): Promise<void> {
    if (this.store.has(fsPath)) {
      return;
    }
    try {
      const text = await reader();
      this.store.capture(fsPath, text);
      this.provider.refresh(this.store.normalizePath(fsPath));
    } catch {
      // New file or unreadable — no baseline
    }
  }

  recordEdit(entry: ReviewEntry): void {
    const key = this.store.normalizePath(entry.path);
    if (
      !this.entries.some((e) => this.store.normalizePath(e.path) === key)
    ) {
      this.entries.push({ ...entry, path: key });
      this._onDidChange.fire(this.entries);
    }
  }

  getEntries(): ReviewEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.store.clear();
    this._onDidChange.fire(this.entries);
  }

  async openDiff(fsPath: string): Promise<void> {
    const normalized = this.store.normalizePath(fsPath);
    const right = vscode.Uri.file(fsPath);
    if (!this.store.has(normalized)) {
      await vscode.window.showTextDocument(right);
      return;
    }
    const left = snapshotUri(normalized);
    const title = `${path.basename(fsPath)} (Grok before → after)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  async openAll(): Promise<void> {
    for (const e of this.entries) {
      await this.openDiff(e.path);
    }
  }

  async pickAndOpen(): Promise<void> {
    const entries = this.getEntries();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage("No Grok edits to review yet");
      return;
    }
    if (entries.length === 1) {
      await this.openDiff(entries[0]!.path);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: path.basename(e.path),
        description: e.path,
        entry: e,
      })),
      { title: "Review Grok edits" },
    );
    if (pick) {
      await this.openDiff(pick.entry.path);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
