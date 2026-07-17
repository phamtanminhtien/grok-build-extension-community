/**
 * ACP `initialize.clientCapabilities` — match TUI pager defaults so the agent
 * enables incremental bash, hunk tracking, and git-head notifications.
 *
 * See xai-grok-pager `client_capabilities_meta` / `canonical_hunk_tracker_mode`.
 */

import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export type HunkTrackerMode = "agent_only" | "off" | string;

/**
 * Canonicalize hunk-tracker mode for the agent (never empty → AllDirty).
 * Blank / absent → `agent_only` (TUI default).
 */
export function canonicalHunkTrackerMode(raw?: string | null): HunkTrackerMode {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) {
    return "agent_only";
  }
  if (s === "off" || s === "disabled") {
    return "off";
  }
  if (s === "agent_only" || s === "agent-only") {
    return "agent_only";
  }
  return s;
}

/** `clientCapabilities._meta` keys the agent reads (x.ai/*). */
export function buildClientCapabilitiesMeta(opts?: {
  hunkTrackerMode?: string | null;
}): Record<string, unknown> {
  return {
    "x.ai/incrementalBashOutput": true,
    "x.ai/hunkTracker": {
      mode: canonicalHunkTrackerMode(opts?.hunkTrackerMode),
    },
    "x.ai/bashOutputNoColor": true,
    "x.ai/gitHeadChanged": true,
  };
}

/**
 * Full clientCapabilities object for `initialize`.
 * Terminal stays false (ADR-004) until host PTY is implemented.
 */
export function buildInitializeClientCapabilities(opts?: {
  hunkTrackerMode?: string | null;
}): ClientCapabilities {
  return {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    terminal: false,
    _meta: buildClientCapabilitiesMeta(opts),
  };
}
