/**
 * Agent fuzzy search session for the in-chat `@` mention popover.
 * Reuses one `x.ai/search/fuzzy/*` session per cwd; returns [] when the
 * agent is offline so host `findFiles` can take over.
 */

import type { AgentService } from "./agentService";
import type { FuzzyMatch, FuzzyStatusUpdate } from "./fuzzySearch";

const DEFAULT_TIMEOUT_MS = 450;
const DEFAULT_LIMIT = 40;

interface ActiveSession {
  searchId: string;
  cwdKey: string;
}

let active: ActiveSession | undefined;
/** Bump to cancel in-flight waiters when a newer query is issued. */
let searchEpoch = 0;

export function resetFuzzyMentionSession(): void {
  searchEpoch += 1;
  active = undefined;
}

/**
 * Close the open fuzzy session (best-effort). Call on agent stop / dispose.
 */
export async function closeFuzzyMentionSession(
  agent: AgentService,
): Promise<void> {
  const id = active?.searchId;
  resetFuzzyMentionSession();
  if (!id) {
    return;
  }
  try {
    await agent.fuzzyClose(id);
  } catch {
    /* ignore */
  }
}

/**
 * Query the agent file index. Returns [] if agent not ready or search fails.
 */
export async function searchAgentMentions(
  agent: AgentService,
  query: string,
  options?: {
    cwd?: string;
    sessionId?: string;
    dirsOnly?: boolean;
    limit?: number;
    timeoutMs?: number;
  },
): Promise<FuzzyMatch[]> {
  const state = agent.getState();
  if (state.kind !== "ready") {
    return [];
  }

  const rootCwd = options?.cwd?.trim() || undefined;
  const cwdKey = rootCwd ?? "";
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dirsOnly = options?.dirsOnly === true;
  const sessionId = options?.sessionId ?? agent.getSessionId() ?? undefined;

  try {
    if (!active || active.cwdKey !== cwdKey) {
      if (active?.searchId) {
        void agent.fuzzyClose(active.searchId).catch(() => undefined);
      }
      const opened = await agent.fuzzyOpen({
        sessionId,
        cwd: rootCwd,
      });
      if (!opened?.searchId) {
        return [];
      }
      active = {
        searchId: opened.searchId,
        cwdKey,
      };
    }

    const epoch = ++searchEpoch;
    return await waitForMatches(agent, {
      searchId: active.searchId,
      query,
      dirsOnly,
      limit,
      timeoutMs,
      epoch,
    });
  } catch {
    // Session may be stale after agent restart.
    active = undefined;
    return [];
  }
}

function waitForMatches(
  agent: AgentService,
  opts: {
    searchId: string;
    query: string;
    dirsOnly: boolean;
    limit: number;
    timeoutMs: number;
    epoch: number;
  },
): Promise<FuzzyMatch[]> {
  return new Promise((resolve) => {
    let latest: FuzzyMatch[] = [];
    let settled = false;

    const finish = (result: FuzzyMatch[]) => {
      if (settled) {
        return;
      }
      settled = true;
      sub.dispose();
      clearTimeout(timer);
      resolve(result);
    };

    const onStatus = (update: FuzzyStatusUpdate) => {
      if (opts.epoch !== searchEpoch) {
        finish([]);
        return;
      }
      if (update.searchId !== opts.searchId) {
        return;
      }
      latest = update.matches.slice(0, opts.limit);
      if (update.done) {
        finish(latest);
      }
    };

    const sub = agent.onFuzzyStatus(onStatus);
    const timer = setTimeout(() => {
      finish(latest);
    }, opts.timeoutMs);

    void agent
      .fuzzyChange({
        searchId: opts.searchId,
        query: opts.query,
        dirsOnly: opts.dirsOnly,
        limit: opts.limit,
      })
      .catch(() => {
        finish([]);
      });
  });
}
