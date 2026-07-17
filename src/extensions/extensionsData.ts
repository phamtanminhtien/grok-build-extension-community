/**
 * ACP list + action wrappers for the Extensions panel.
 */

import type { AgentService } from "../agent/agentService";
import { resolveSessionCwd } from "../config/settings";
import {
  parseActionOutcome,
  toExtRequest,
  type ActionOutcome,
  type ExtensionAction,
} from "./actions.ts";
import type {
  ExtensionsTabPayload,
  HooksListResponse,
  MarketplaceListResponse,
  McpServersListResponse,
  PluginsListResponse,
  SkillsListResponse,
} from "./extensionsTypes.ts";
import type { ExtensionsTab } from "./tabs.ts";

export type {
  ExtensionRow,
  ExtensionsTabPayload,
  HookInfo,
  HooksListResponse,
  MarketplaceListResponse,
  MarketplacePluginEntry,
  MarketplaceScanResult,
  McpServerInfo,
  McpServersListResponse,
  McpToolInfo,
  PluginInfo,
  PluginsListResponse,
  SkillInfo,
  SkillsListResponse,
} from "./extensionsTypes.ts";

export { rowsForTab } from "./rows.ts";

function unwrapResult<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "result" in raw) {
    return (raw as { result: T }).result;
  }
  return raw as T;
}

export async function fetchExtensionsTab(
  agent: AgentService,
  tab: ExtensionsTab,
): Promise<ExtensionsTabPayload> {
  const sessionId = agent.getSessionId();
  const cwd = resolveSessionCwd();

  switch (tab) {
    case "hooks": {
      if (!sessionId) {
        throw new Error("No active session — start the agent first");
      }
      const data = unwrapResult<HooksListResponse>(
        await agent.requestExt("x.ai/hooks/list", { sessionId }),
      );
      return {
        tab,
        data: {
          ...data,
          hooks: data?.hooks ?? [],
        },
      };
    }
    case "plugins": {
      if (!sessionId) {
        throw new Error("No active session — start the agent first");
      }
      const data = unwrapResult<PluginsListResponse>(
        await agent.requestExt("x.ai/plugins/list", { sessionId }),
      );
      return {
        tab,
        data: {
          ...data,
          plugins: data?.plugins ?? [],
        },
      };
    }
    case "marketplace": {
      const data = unwrapResult<MarketplaceListResponse>(
        await agent.requestExt("x.ai/marketplace/list", {}),
      );
      return { tab, data: { sources: data?.sources ?? [] } };
    }
    case "skills": {
      const data = unwrapResult<SkillsListResponse>(
        await agent.requestExt("x.ai/skills/list", { cwd }),
      );
      return { tab, data: { skills: data?.skills ?? [] } };
    }
    case "mcp": {
      const data = unwrapResult<McpServersListResponse>(
        await agent.requestExt("x.ai/mcp/list", {
          sessionId: sessionId ?? undefined,
          cache: true,
        }),
      );
      return { tab, data: { servers: data?.servers ?? [] } };
    }
  }
}

/**
 * Run a management action and return a normalized outcome.
 * Caller should refresh the tab after success.
 */
export async function runExtensionAction(
  agent: AgentService,
  action: ExtensionAction,
): Promise<ActionOutcome> {
  const sessionId = agent.getSessionId() ?? undefined;
  const cwd = resolveSessionCwd();
  const req = toExtRequest(action, { sessionId, cwd });
  if (!req) {
    throw new Error("No active session — start the agent first");
  }
  await agent.ensureStarted();
  const raw = await agent.requestExt(req.method, req.params);
  return parseActionOutcome(raw);
}
