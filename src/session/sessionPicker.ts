import * as vscode from "vscode";
import type { AgentService } from "../agent/agentService";
import { listDiskSessions } from "./diskSessions";
import {
  sessionPickLabels,
  type GrokSession,
} from "./grokSession";

/**
 * Load sessions the same way Grok Build TUI does:
 * 1) Prefer agent ext methods (`_x.ai/session_summaries/*`)
 * 2) Fall back to scanning `~/.grok/sessions`
 */
export async function loadGrokSessions(
  agent: AgentService,
  options: { cwd: string; allWorkspaces?: boolean; limit?: number },
): Promise<{ sessions: GrokSession[]; source: "agent" | "disk" }> {
  const limit = options.limit ?? 40;
  try {
    await agent.ensureStarted();
    if (options.allWorkspaces) {
      const recent = await agent.listGrokRecentSessions(limit);
      if (recent.length > 0) {
        return { sessions: recent, source: "agent" };
      }
    } else {
      const workspace = await agent.listGrokWorkspaceSessions(options.cwd);
      if (workspace.length > 0) {
        return { sessions: workspace.slice(0, limit), source: "agent" };
      }
    }
  } catch {
    /* fall through to disk */
  }

  const disk = listDiskSessions({
    cwd: options.allWorkspaces ? undefined : options.cwd,
    allWorkspaces: options.allWorkspaces,
    limit,
  });
  return { sessions: disk, source: "disk" };
}

/**
 * Interactive resume picker aligned with TUI `/resume` + CLI `grok sessions list`.
 */
export async function pickGrokSessionToResume(
  agent: AgentService,
  workspaceCwd: string,
): Promise<GrokSession | undefined> {
  let allWorkspaces = false;
  let { sessions, source } = await loadGrokSessions(agent, {
    cwd: workspaceCwd,
    allWorkspaces: false,
    limit: 40,
  });

  if (sessions.length === 0) {
    ({ sessions, source } = await loadGrokSessions(agent, {
      cwd: workspaceCwd,
      allWorkspaces: true,
      limit: 40,
    }));
    allWorkspaces = true;
  }

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      "No Grok sessions found (same store as TUI: ~/.grok/sessions).",
    );
    return undefined;
  }

  for (;;) {
    type Item = vscode.QuickPickItem & {
      session?: GrokSession;
      action?: "all" | "search";
    };

    const items: Item[] = [];
    if (!allWorkspaces) {
      const latest = sessionPickLabels(sessions[0]!);
      items.push({
        label: "$(history) Continue latest (this workspace)",
        description: latest.label,
        detail: latest.description,
        session: sessions[0],
      });
      items.push({
        label: "$(folder) All workspaces…",
        description: "Like TUI grouped by repo",
        alwaysShow: true,
        action: "all",
      });
    }
    items.push({
      label: "$(search) Search session content…",
      description: "x.ai/session/search (same as TUI filter)",
      alwaysShow: true,
      action: "search",
    });

    for (const s of sessions) {
      const labels = sessionPickLabels(s);
      items.push({
        label: labels.label,
        description: labels.description,
        detail: labels.detail,
        session: s,
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: allWorkspaces
        ? `Resume Grok session · all workspaces (${source})`
        : `Resume Grok session · this workspace (${source})`,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder:
        "Same history as Grok Build TUI / grok sessions list · type to filter titles",
    });
    if (!pick) {
      return undefined;
    }
    if (pick.action === "all") {
      ({ sessions, source } = await loadGrokSessions(agent, {
        cwd: workspaceCwd,
        allWorkspaces: true,
        limit: 60,
      }));
      allWorkspaces = true;
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage("No sessions across workspaces.");
        return undefined;
      }
      continue;
    }
    if (pick.action === "search") {
      const query = await vscode.window.showInputBox({
        title: "Search Grok sessions",
        placeHolder: "Keyword (title + content, same as TUI)",
      });
      if (!query?.trim()) {
        continue;
      }
      const hits = await agent.searchGrokSessions(query.trim(), {
        cwd: allWorkspaces ? undefined : workspaceCwd,
        limit: 30,
      });
      if (hits.length === 0) {
        // Disk fallback: filter by title
        const pool = listDiskSessions({
          allWorkspaces: true,
          limit: 200,
        });
        const q = query.trim().toLowerCase();
        sessions = pool.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.sessionId.includes(q) ||
            s.cwd.toLowerCase().includes(q),
        );
        source = "disk";
      } else {
        sessions = hits;
        source = "agent";
      }
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(`No sessions match “${query}”.`);
        continue;
      }
      allWorkspaces = true;
      continue;
    }
    return pick.session;
  }
}
