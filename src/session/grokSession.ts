/**
 * Shared session summary model aligned with Grok Build (`Summary` in shell).
 * Display rules match TUI / `grok sessions list` / `~/.grok/sessions` store.
 */

export interface GrokSession {
  sessionId: string;
  cwd: string;
  /** Prefer generated_title, else session_summary (Grok display_title). */
  title: string;
  createdAt: number;
  /** Sort key: last_active_at ?? updated_at (Grok list order). */
  updatedAt: number;
  messageCount: number;
  modelId?: string;
  agentName?: string;
  sessionKind?: string;
  /** short repo label from last 2 path components */
  repoName: string;
}

/** Same as Grok `session_picker::repo_name_from_cwd`. */
export function repoNameFromCwd(cwd: string): string {
  if (!cwd) {
    return "unknown";
  }
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return cwd;
  }
  const start = Math.max(0, parts.length - 2);
  return parts.slice(start).join("-");
}

/** Grok display_title: generated_title if non-empty, else session_summary. */
export function displayTitle(args: {
  generatedTitle?: string | null;
  sessionSummary?: string | null;
  sessionId: string;
}): string {
  const gen = (args.generatedTitle ?? "").trim();
  if (gen) {
    return gen;
  }
  const sum = (args.sessionSummary ?? "").trim();
  if (sum) {
    return sum;
  }
  return "(no summary)";
}

/**
 * Whether Grok hides this session from history listings.
 * Matches Summary::is_hidden — default hide when session_kind starts with "subagent".
 */
export function isHiddenSession(args: {
  hidden?: boolean | null;
  sessionKind?: string | null;
}): boolean {
  if (args.hidden === true) {
    return true;
  }
  if (args.hidden === false) {
    return false;
  }
  const kind = args.sessionKind ?? "";
  return kind.startsWith("subagent");
}

/** Relative time like TUI picker right_text (`format_time_ago`). */
export function formatTimeAgo(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0) {
    return "";
  }
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 30) {
    return `${day}d ago`;
  }
  const mo = Math.floor(day / 30);
  if (mo < 12) {
    return `${mo}mo ago`;
  }
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

export function sortSessionsNewestFirst(sessions: GrokSession[]): GrokSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** QuickPick label/description/detail mirroring TUI row + CLI columns. */
export function sessionPickLabels(s: GrokSession): {
  label: string;
  description: string;
  detail: string;
} {
  const when = formatTimeAgo(s.updatedAt);
  const model = s.modelId || "";
  return {
    label: s.title || "(no summary)",
    description: [when, model, "local"].filter(Boolean).join(" · "),
    detail: [
      s.sessionId,
      s.repoName,
      s.messageCount ? `${s.messageCount} msgs` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
