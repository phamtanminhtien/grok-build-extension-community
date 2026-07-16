import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHistoryEntry } from "./sessionHistoryStore";

export interface DiskSession extends SessionHistoryEntry {
  /** local disk under ~/.grok/sessions */
  source: "disk";
  modelId?: string;
  status?: string;
}

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
 * List sessions from `~/.grok/sessions`, same store the TUI / CLI use.
 *
 * When `cwd` is set, prefer that workspace's folder; also match realpath variants.
 * Results are newest-first.
 */
export function listDiskSessions(options?: {
  cwd?: string;
  limit?: number;
  allWorkspaces?: boolean;
}): DiskSession[] {
  const sessionsRoot = path.join(grokHome(), "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return [];
  }

  const limit = options?.limit ?? 50;
  const all = options?.allWorkspaces ?? !options?.cwd;
  const cwdKeys = options?.cwd ? cwdFolderKeys(options.cwd) : [];

  const found: DiskSession[] = [];

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
      // Also allow scanning when .cwd file matches
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

  found.sort((a, b) => b.updatedAt - a.updatedAt);
  return found.slice(0, limit);
}

function cwdFolderKeys(cwd: string): string[] {
  const keys = new Set<string>();
  const abs = path.resolve(cwd);
  keys.add(encodeURIComponent(abs));
  // Trailing slash variants
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
  generated_title?: string;
  updated_at?: string;
  created_at?: string;
  last_active_at?: string;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
}

function readSummary(
  summaryPath: string,
  fallbackId: string,
): DiskSession | undefined {
  try {
    const raw = fs.readFileSync(summaryPath, "utf8");
    const data = JSON.parse(raw) as SummaryJson;
    const sessionId = data.info?.id || fallbackId;
    const cwd = data.info?.cwd || "";
    const title =
      (data.generated_title || data.session_summary || "").trim() ||
      `Session ${sessionId.slice(0, 8)}`;
    const updatedIso =
      data.updated_at || data.last_active_at || data.created_at || "";
    const updatedAt = updatedIso ? Date.parse(updatedIso) || 0 : 0;
    return {
      sessionId,
      cwd,
      title,
      updatedAt,
      preview: (data.session_summary || title).slice(0, 200),
      messageCount: data.num_chat_messages ?? data.num_messages ?? 0,
      source: "disk",
      modelId: data.current_model_id,
    };
  } catch {
    return undefined;
  }
}
