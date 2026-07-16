/**
 * ACP list wrappers for the Extensions panel (thin browse UI).
 */

import type { AgentService } from "../agent/agentService";
import { resolveSessionCwd } from "../config/settings";
import type {
  ExtensionsTabPayload,
  HooksListResponse,
  MarketplaceListResponse,
  McpServersListResponse,
  PluginsListResponse,
  SkillsListResponse,
} from "./extensionsTypes";
import type { ExtensionsTab } from "./tabs";

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
} from "./extensionsTypes";

export { rowsForTab } from "./rows";

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
