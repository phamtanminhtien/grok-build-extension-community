import * as path from "node:path";
import * as vscode from "vscode";
import type { HunkActionKind, HunkActionResult } from "./hunkTracker";
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

/** Agent-side accept/reject via x.ai/hunk-tracker/* (injected to avoid cycles). */
export interface HunkTrackerBridge {
  fileAction(path: string, action: HunkActionKind): Promise<HunkActionResult>;
  allAction(action: HunkActionKind): Promise<HunkActionResult>;
}

export class DiffReviewService implements vscode.Disposable {
  readonly store = new SnapshotStore();
  private readonly provider: SnapshotContentProvider;
  private entries: ReviewEntry[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<ReviewEntry[]>();
  readonly onDidChange = this._onDidChange.event;
  private readonly sub: vscode.Disposable;
  private tracker: HunkTrackerBridge | undefined;
  /** Skip recordEdit while restoring a reject (write would re-queue the file). */
  private suppressRecord = false;

  constructor() {
    this.provider = new SnapshotContentProvider(this.store);
    this.sub = vscode.workspace.registerTextDocumentContentProvider(
      GROK_DIFF_SCHEME,
      this.provider,
    );
  }

  /** Wire agent hunk-tracker actions (file / all accept-reject). */
  setHunkTracker(tracker: HunkTrackerBridge | undefined): void {
    this.tracker = tracker;
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
    if (this.suppressRecord) {
      return;
    }
    const key = this.store.normalizePath(entry.path);
    if (!this.entries.some((e) => this.store.normalizePath(e.path) === key)) {
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

  /** Drop one path from the review list + snapshot. */
  removeEntry(fsPath: string): void {
    const key = this.store.normalizePath(fsPath);
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => this.store.normalizePath(e.path) !== key,
    );
    this.store.delete(key);
    this.provider.refresh(key);
    if (this.entries.length !== before) {
      this._onDidChange.fire(this.entries);
    }
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

  /**
   * Accept all hunks for a path (agent baseline update) and dismiss review row.
   * Falls back to local dismiss if the agent reports no tracked hunks.
   */
  async acceptFile(fsPath: string): Promise<HunkActionResult> {
    const result = await this.runFileAction(fsPath, "accept");
    this.removeEntry(fsPath);
    return result;
  }

  /**
   * Reject all hunks for a path (agent reverts disk) and dismiss review row.
   * If the agent did not track the file, restore host snapshot when available.
   */
  async rejectFile(fsPath: string): Promise<HunkActionResult> {
    const result = await this.runFileAction(fsPath, "reject");
    const affected = result.affectedCount ?? 0;
    if (!result.success || affected === 0) {
      await this.restoreFromSnapshot(fsPath);
    } else {
      await this.syncOpenDocumentFromDisk(fsPath);
    }
    this.removeEntry(fsPath);
    return result;
  }

  /** Accept every file in the review list (session all-action + local dismiss). */
  async acceptAll(): Promise<HunkActionResult> {
    const result = await this.runAllAction("accept");
    this.clear();
    return result;
  }

  /** Reject every file in the review list. */
  async rejectAll(): Promise<HunkActionResult> {
    const paths = this.entries.map((e) => e.path);
    const result = await this.runAllAction("reject");
    const affected = result.affectedCount ?? 0;
    if (!result.success || affected === 0) {
      for (const p of paths) {
        await this.restoreFromSnapshot(p);
      }
    } else {
      for (const p of paths) {
        await this.syncOpenDocumentFromDisk(p);
      }
    }
    this.clear();
    return result;
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

    const acceptBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("check"),
      tooltip: "Accept file",
    };
    const rejectBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("discard"),
      tooltip: "Reject file",
    };

    type Item = vscode.QuickPickItem & {
      entry: ReviewEntry;
      buttons: vscode.QuickInputButton[];
    };

    const pick = vscode.window.createQuickPick<Item>();
    pick.title = "Review Grok edits";
    pick.placeholder = "Open diff · Accept/Reject via item buttons";
    pick.items = entries.map((e) => ({
      label: path.basename(e.path),
      description: e.path,
      entry: e,
      buttons: [acceptBtn, rejectBtn],
    }));
    pick.buttons = [
      {
        iconPath: new vscode.ThemeIcon("check-all"),
        tooltip: "Accept all",
      },
      {
        iconPath: new vscode.ThemeIcon("close-all"),
        tooltip: "Reject all",
      },
    ];

    const done = new Promise<void>((resolve) => {
      pick.onDidAccept(() => {
        const sel = pick.selectedItems[0];
        if (sel) {
          void this.openDiff(sel.entry.path);
        }
        pick.hide();
        resolve();
      });
      pick.onDidTriggerItemButton(async (e) => {
        const entry = e.item.entry;
        try {
          if (e.button === acceptBtn) {
            await this.acceptFile(entry.path);
            void vscode.window.showInformationMessage(
              `Accepted ${path.basename(entry.path)}`,
            );
          } else if (e.button === rejectBtn) {
            await this.rejectFile(entry.path);
            void vscode.window.showInformationMessage(
              `Rejected ${path.basename(entry.path)}`,
            );
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Hunk action failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const left = this.getEntries();
        if (left.length === 0) {
          pick.hide();
          resolve();
          return;
        }
        pick.items = left.map((ent) => ({
          label: path.basename(ent.path),
          description: ent.path,
          entry: ent,
          buttons: [acceptBtn, rejectBtn],
        }));
      });
      pick.onDidTriggerButton(async (btn) => {
        const tip = "tooltip" in btn ? String(btn.tooltip ?? "") : "";
        try {
          if (tip === "Accept all") {
            await this.acceptAll();
            void vscode.window.showInformationMessage(
              "Accepted all Grok edits",
            );
            pick.hide();
            resolve();
          } else if (tip === "Reject all") {
            const ok = await this.confirmRejectAll(entries.length);
            if (!ok) {
              return;
            }
            await this.rejectAll();
            void vscode.window.showInformationMessage(
              "Rejected all Grok edits",
            );
            pick.hide();
            resolve();
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Hunk action failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      pick.onDidHide(() => {
        pick.dispose();
        resolve();
      });
    });

    pick.show();
    await done;
  }

  private async confirmRejectAll(count: number): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Reject all ${count} Grok edit(s)? Disk files will be reverted.`,
      { modal: true },
      "Reject all",
    );
    return choice === "Reject all";
  }

  private async runFileAction(
    fsPath: string,
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    if (!this.tracker) {
      return {
        success: false,
        error: "Hunk tracker not connected",
        affectedCount: 0,
      };
    }
    try {
      return await this.tracker.fileAction(fsPath, action);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        affectedCount: 0,
      };
    }
  }

  private async runAllAction(
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    if (!this.tracker) {
      return {
        success: false,
        error: "Hunk tracker not connected",
        affectedCount: 0,
      };
    }
    try {
      return await this.tracker.allAction(action);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        affectedCount: 0,
      };
    }
  }

  /** Restore host pre-edit snapshot when agent did not apply a reject. */
  private async restoreFromSnapshot(fsPath: string): Promise<void> {
    const baseline = this.store.get(fsPath);
    if (baseline === undefined) {
      return;
    }
    this.suppressRecord = true;
    try {
      const uri = vscode.Uri.file(fsPath);
      const edit = new vscode.WorkspaceEdit();
      let doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri.fsPath,
      );
      if (!doc) {
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch {
          // File may have been created by agent — recreate from baseline.
        }
      }
      if (doc) {
        const full = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length),
        );
        edit.replace(uri, full, baseline);
      } else {
        edit.createFile(uri, { overwrite: true, ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), baseline);
      }
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.suppressRecord = false;
    }
  }

  /** After agent rewrote disk, pull content into open buffers. */
  private async syncOpenDocumentFromDisk(fsPath: string): Promise<void> {
    const uri = vscode.Uri.file(fsPath);
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === uri.fsPath,
    );
    if (!doc) {
      return;
    }
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(data).toString("utf8");
      if (doc.getText() === text) {
        return;
      }
      this.suppressRecord = true;
      try {
        const edit = new vscode.WorkspaceEdit();
        const full = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length),
        );
        edit.replace(uri, full, text);
        await vscode.workspace.applyEdit(edit);
      } finally {
        this.suppressRecord = false;
      }
    } catch {
      // Deleted or unreadable after reject — leave buffer alone.
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
