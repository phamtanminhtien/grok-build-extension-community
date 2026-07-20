/**
 * VS Code QuickPick UI for Grok worktrees (`x.ai/git/worktree/*`).
 * Mirrors CLI `grok worktree list|show|rm|gc` and apply-back-to-main.
 */

import * as vscode from "vscode";
import type { AgentService } from "./agentService";
import {
  formatGcReportMessage,
  formatWorktreeDescription,
  formatWorktreeDetail,
  formatWorktreeLabel,
  type ApplyMode,
  type WorktreeRecord,
} from "./worktree";

type TopAction = "refresh" | "create" | "gc" | "includeAll";

type ListItem = vscode.QuickPickItem & {
  record?: WorktreeRecord;
  action?: TopAction;
};

type DetailAction =
  | "openFolder"
  | "reveal"
  | "copyPath"
  | "apply"
  | "remove"
  | "showInfo"
  | "back";

/**
 * Interactive worktree manager (list → detail actions).
 */
export async function runWorktreePicker(
  agent: AgentService,
  options?: { cwd?: string },
): Promise<void> {
  await agent.ensureStarted();
  let includeAll = false;
  const cwd = options?.cwd;

  for (;;) {
    let records: WorktreeRecord[];
    try {
      records = await agent.listWorktrees({ includeAll });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Worktree list failed: ${errMessage(err)}`,
      );
      return;
    }

    const items: ListItem[] = [
      {
        label: "$(refresh) Refresh",
        description: includeAll ? "showing all (incl. dead)" : "alive only",
        alwaysShow: true,
        action: "refresh",
      },
      {
        label: "$(add) Create worktree…",
        description: "Isolated git worktree for current session",
        alwaysShow: true,
        action: "create",
      },
      {
        label: includeAll
          ? "$(filter) Show alive only"
          : "$(archive) Include dead worktrees",
        alwaysShow: true,
        action: "includeAll",
      },
      {
        label: "$(trash) Garbage collect…",
        description: "Remove orphaned / stale worktrees",
        alwaysShow: true,
        action: "gc",
      },
    ];

    if (records.length === 0) {
      items.push({
        label: "$(info) No worktrees found",
        description: "Create one or enable “include dead”",
        alwaysShow: true,
      });
    } else {
      for (const rec of records) {
        items.push({
          label: formatWorktreeLabel(rec),
          description: formatWorktreeDescription(rec),
          detail: formatWorktreeDetail(rec),
          record: rec,
        });
      }
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: "Grok Build — Worktrees",
      placeHolder: "Select a worktree or action",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }

    if (pick.action === "refresh") {
      continue;
    }
    if (pick.action === "includeAll") {
      includeAll = !includeAll;
      continue;
    }
    if (pick.action === "create") {
      await createWorktreeFlow(agent, cwd);
      continue;
    }
    if (pick.action === "gc") {
      await gcFlow(agent);
      continue;
    }
    if (pick.record) {
      const stay = await detailFlow(agent, pick.record);
      if (!stay) {
        return;
      }
      // stay in list after back / completed action
    }
  }
}

async function detailFlow(
  agent: AgentService,
  rec: WorktreeRecord,
): Promise<boolean> {
  type Item = vscode.QuickPickItem & { action: DetailAction };
  const items: Item[] = [
    {
      label: "$(folder-opened) Open folder",
      description: "Add / open worktree in VS Code",
      action: "openFolder",
    },
    {
      label: "$(file-directory) Reveal in OS",
      action: "reveal",
    },
    {
      label: "$(copy) Copy path",
      action: "copyPath",
    },
    {
      label: "$(git-merge) Apply to main…",
      description: "Merge worktree changes back (overwrite or merge)",
      action: "apply",
    },
    {
      label: "$(trash) Remove…",
      description: rec.status === "alive" ? "Delete worktree" : "Remove record",
      action: "remove",
    },
    {
      label: "$(info) Details",
      action: "showInfo",
    },
    {
      label: "$(arrow-left) Back",
      alwaysShow: true,
      action: "back",
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: `Worktree · ${rec.label || rec.id}`,
    placeHolder: rec.path,
  });
  if (!pick) {
    return false;
  }

  switch (pick.action) {
    case "back":
      return true;
    case "copyPath":
      await vscode.env.clipboard.writeText(rec.path);
      void vscode.window.showInformationMessage("Worktree path copied");
      return true;
    case "reveal": {
      try {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(rec.path),
        );
      } catch {
        void vscode.window.showWarningMessage(`Could not reveal: ${rec.path}`);
      }
      return true;
    }
    case "openFolder": {
      const uri = vscode.Uri.file(rec.path);
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "Open in new window",
            value: "new" as const,
          },
          {
            label: "Add to workspace",
            value: "add" as const,
          },
        ],
        { title: "Open worktree" },
      );
      if (!choice) {
        return true;
      }
      if (choice.value === "new") {
        await vscode.commands.executeCommand("vscode.openFolder", uri, true);
      } else {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri, name: rec.label || rec.id },
        );
        void vscode.window.showInformationMessage(
          `Added worktree folder: ${rec.path}`,
        );
      }
      return true;
    }
    case "showInfo": {
      const lines = [
        `ID: ${rec.id}`,
        `Path: ${rec.path}`,
        `Kind: ${rec.kind}`,
        `Repo: ${rec.repoName} (${rec.sourceRepo})`,
        `Branch: ${rec.gitRef ?? "(detached)"}`,
        `HEAD: ${rec.headCommit ?? "—"}`,
        `Session: ${rec.sessionId ?? "—"}`,
        `Status: ${rec.status}`,
        `Mode: ${rec.creationMode || "—"}`,
        rec.label ? `Label: ${rec.label}` : undefined,
      ].filter(Boolean);
      await vscode.window.showInformationMessage(lines.join("\n"), {
        modal: true,
      });
      return true;
    }
    case "apply":
      await applyFlow(agent, rec);
      return true;
    case "remove":
      await removeFlow(agent, rec);
      return true;
    default:
      return true;
  }
}

async function createWorktreeFlow(
  agent: AgentService,
  cwd?: string,
): Promise<void> {
  const sessionId = agent.getSessionId();
  if (!sessionId) {
    void vscode.window.showWarningMessage(
      "Start a Grok session before creating a worktree.",
    );
    return;
  }
  const sourcePath =
    cwd?.trim() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  if (!sourcePath) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder to use as the worktree source.",
    );
    return;
  }
  const label = await vscode.window.showInputBox({
    title: "Create worktree",
    prompt: "Optional label (directory name hint)",
    placeHolder: "feature-branch-work",
    ignoreFocusOut: true,
  });
  if (label === undefined) {
    return;
  }

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Grok worktree…",
        cancellable: false,
      },
      async () =>
        agent.createWorktree({
          sessionId,
          sourcePath,
          label: label.trim() || undefined,
        }),
    );
    if (!result) {
      void vscode.window.showWarningMessage(
        "Worktree create returned an unexpected response",
      );
      return;
    }
    if (result.status === "exists") {
      void vscode.window.showInformationMessage(
        `Worktree already exists: ${result.worktreePath ?? ""}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      result.worktreePath
        ? `Worktree creating: ${result.worktreePath} (progress in notifications)`
        : "Worktree creation started — watch status notifications",
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Create worktree failed: ${errMessage(err)}`,
    );
  }
}

async function applyFlow(
  agent: AgentService,
  rec: WorktreeRecord,
): Promise<void> {
  const sessionId = rec.sessionId || agent.getSessionId();
  if (!sessionId) {
    void vscode.window.showWarningMessage(
      "No session id on this worktree and no active session — cannot apply.",
    );
    return;
  }

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: "Overwrite",
        description: "Replace main files with worktree versions",
        mode: "overwrite" as ApplyMode,
      },
      {
        label: "Merge",
        description: "Merge changes; report conflicts",
        mode: "merge" as ApplyMode,
      },
    ],
    { title: "Apply worktree to main", placeHolder: "Apply mode" },
  );
  if (!modePick) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Apply worktree changes into the main working tree?\n\n${rec.path}\nMode: ${modePick.mode}`,
    { modal: true },
    "Apply",
  );
  if (confirm !== "Apply") {
    return;
  }

  try {
    const result = await agent.applyWorktree({
      sessionId,
      worktreePath: rec.path,
      mode: modePick.mode,
    });
    if (!result) {
      void vscode.window.showWarningMessage("Apply returned no result");
      return;
    }
    if (result.status === "conflicts") {
      const n = result.conflicts.length;
      void vscode.window.showWarningMessage(
        `Apply reported ${n} conflict(s). First: ${result.conflicts[0]?.path ?? "—"}`,
      );
      return;
    }
    const n = result.files.length;
    void vscode.window.showInformationMessage(
      n > 0
        ? `Applied ${n} file change(s) to ${result.gitRoot || "main"}`
        : `Apply succeeded (${result.gitRoot || "main"})`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Apply failed: ${errMessage(err)}`);
  }
}

async function removeFlow(
  agent: AgentService,
  rec: WorktreeRecord,
): Promise<void> {
  const forcePick = await vscode.window.showQuickPick(
    [
      {
        label: "Remove",
        description: "Normal remove",
        force: false,
      },
      {
        label: "Force remove",
        description: "Ignore locks / dirty state when possible",
        force: true,
      },
    ],
    { title: `Remove worktree ${rec.label || rec.id}` },
  );
  if (!forcePick) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree?\n\n${rec.path}`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") {
    return;
  }
  try {
    const result = await agent.removeWorktree({
      idOrPath: rec.id,
      force: forcePick.force,
    });
    if (result.removed) {
      void vscode.window.showInformationMessage(
        `Removed: ${result.resolvedPath ?? rec.path}`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `Worktree not removed: ${result.resolvedPath ?? rec.path}`,
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Remove failed: ${errMessage(err)}`);
  }
}

async function gcFlow(agent: AgentService): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Dry run",
        description: "Report only — no deletions",
        dryRun: true,
        force: false,
      },
      {
        label: "Run GC",
        description: "Remove dead / expired worktrees",
        dryRun: false,
        force: false,
      },
      {
        label: "Force GC",
        description: "Aggressive cleanup",
        dryRun: false,
        force: true,
      },
    ],
    { title: "Worktree garbage collect" },
  );
  if (!pick) {
    return;
  }
  if (!pick.dryRun) {
    const ok = await vscode.window.showWarningMessage(
      pick.force
        ? "Force garbage-collect stale Grok worktrees?"
        : "Garbage-collect dead / expired Grok worktrees?",
      { modal: true },
      "Continue",
    );
    if (ok !== "Continue") {
      return;
    }
  }
  try {
    const report = await agent.gcWorktrees({
      dryRun: pick.dryRun,
      force: pick.force,
    });
    void vscode.window.showInformationMessage(
      formatGcReportMessage(report, pick.dryRun),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`GC failed: ${errMessage(err)}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
