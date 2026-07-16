import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  displayTitle,
  isEmptyHistorySession,
  isHiddenSession,
  repoNameFromCwd,
  sortSessionsNewestFirst,
  type GrokSession,
} from "./grokSession";

export type { GrokSession };
/** @deprecated use GrokSession */
export type DiskSession = GrokSession;

/**
 * Resolve Grok home directory (`GROK_HOME` or `~/.grok`).
 */
export function grokHome(): string {
  const env = process.env.GROK_HOME?.trim();
  if (env) {
    return path.resolve(env);
  }
  return path.join(os.homedir(), ".grok");
}

/**
 * URL-encode a cwd the same way Grok names session group folders.
 */
export function encodeSessionCwd(cwd: string): string {
  const normalized = path.resolve(cwd);
  return encodeURIComponent(normalized);
}

/**
 * List sessions by scanning `~/.grok/sessions` (fallback when agent ext methods fail).
 * Logic mirrors Grok `list_summaries` / Summary::is_hidden / display_title / last_active sort.
 */
export function listDiskSessions(options?: {
  cwd?: string;
  limit?: number;
  allWorkspaces?: boolean;
}): GrokSession[] {
  const sessionsRoot = path.join(grokHome(), "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return [];
  }

  const limit = options?.limit ?? 50;
  const all = options?.allWorkspaces ?? !options?.cwd;
  const cwdKeys = options?.cwd ? cwdFolderKeys(options.cwd) : [];

  const found: GrokSession[] = [];

  let groupDirs: string[];
  try {
    groupDirs = fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(sessionsRoot, d.name));
  } catch {
    return [];
  }

  for (const groupDir of groupDirs) {
    const groupName = path.basename(groupDir);
    if (!all && cwdKeys.length > 0 && !cwdKeys.includes(groupName)) {
      if (!groupMatchesCwd(groupDir, options?.cwd)) {
        continue;
      }
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      // Session ids are UUIDs; skip non-session dirs (e.g. index files)
      const sessionDir = path.join(groupDir, ent.name);
      const summaryPath = path.join(sessionDir, "summary.json");
      if (!fs.existsSync(summaryPath)) {
        continue;
      }
      const parsed = readSummary(summaryPath, ent.name);
      if (parsed) {
        found.push(parsed);
      }
    }
  }

  return sortSessionsNewestFirst(found).slice(0, limit);
}

function cwdFolderKeys(cwd: string): string[] {
  const keys = new Set<string>();
  const abs = path.resolve(cwd);
  keys.add(encodeURIComponent(abs));
  keys.add(encodeURIComponent(abs + path.sep));
  try {
    const real = fs.realpathSync(abs);
    keys.add(encodeURIComponent(real));
    keys.add(encodeURIComponent(real + path.sep));
  } catch {
    /* ignore */
  }
  return [...keys];
}

function groupMatchesCwd(groupDir: string, cwd?: string): boolean {
  if (!cwd) {
    return true;
  }
  const cwdFile = path.join(groupDir, ".cwd");
  try {
    if (fs.existsSync(cwdFile)) {
      const recorded = fs.readFileSync(cwdFile, "utf8").trim();
      if (
        path.resolve(recorded) === path.resolve(cwd) ||
        fs.realpathSync(recorded) === fs.realpathSync(cwd)
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

interface SummaryJson {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string | null;
  updated_at?: string;
  created_at?: string;
  last_active_at?: string | null;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
  agent_name?: string;
  session_kind?: string | null;
  hidden?: boolean | null;
}

function readSummary(
  summaryPath: string,
  fallbackId: string,
): GrokSession | undefined {
  try {
    const raw = fs.readFileSync(summaryPath, "utf8");
    const data = JSON.parse(raw) as SummaryJson;
    if (
      isHiddenSession({
        hidden: data.hidden,
        sessionKind: data.session_kind,
      })
    ) {
      return undefined;
    }
    const sessionId = data.info?.id || fallbackId;
    const cwd = data.info?.cwd || "";
    const title = displayTitle({
      generatedTitle: data.generated_title,
      sessionSummary: data.session_summary,
      sessionId,
    });
    const messageCount = data.num_chat_messages ?? data.num_messages ?? 0;
    if (isEmptyHistorySession({ title, messageCount })) {
      return undefined;
    }
    // Grok sort: last_active_at else updated_at
    const sortIso =
      data.last_active_at || data.updated_at || data.created_at || "";
    const updatedAt = sortIso ? Date.parse(sortIso) || 0 : 0;
    const createdAt = data.created_at ? Date.parse(data.created_at) || 0 : 0;
    return {
      sessionId,
      cwd,
      title,
      createdAt,
      updatedAt,
      messageCount,
      modelId: data.current_model_id,
      agentName: data.agent_name,
      sessionKind: data.session_kind ?? undefined,
      repoName: repoNameFromCwd(cwd),
    };
  } catch {
    return undefined;
  }
}
