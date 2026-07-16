/**
 * Pure row mappers for the Extensions panel (unit-testable without vscode).
 */

import type {
  ExtensionRow,
  ExtensionsTabPayload,
} from "./extensionsTypes";

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

/** Normalize a tab payload into list rows for the webview. */
export function rowsForTab(payload: ExtensionsTabPayload): ExtensionRow[] {
  switch (payload.tab) {
    case "hooks":
      return payload.data.hooks.map((h) => ({
        title: h.name,
        subtitle: [
          h.event,
          h.disabled ? "disabled" : "enabled",
          h.matcher ? `matcher: ${h.matcher}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        detail: h.command || h.url || h.sourceDir || "",
        path: h.sourceDir || h.command || undefined,
        badges: h.disabled ? ["disabled"] : [],
      }));
    case "plugins":
      return payload.data.plugins.map((p) => ({
        title: p.name,
        subtitle: [
          p.scope,
          p.enabled === false ? "disabled" : "enabled",
          p.version ? `v${p.version}` : undefined,
          p.skillCount != null ? `${p.skillCount} skills` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        detail: p.description || p.root || "",
        path: p.root,
        badges: p.enabled === false ? ["disabled"] : [],
      }));
    case "marketplace": {
      const rows: ExtensionRow[] = [];
      for (const src of payload.data.sources) {
        rows.push({
          title: src.sourceName,
          subtitle: src.sourceKind || src.sourceUrlOrPath || "source",
          detail: src.error || `${src.plugins?.length ?? 0} plugins`,
          path: src.sourceUrlOrPath?.startsWith("/")
            ? src.sourceUrlOrPath
            : undefined,
          badges: src.error ? ["error"] : ["source"],
          isHeader: true,
        });
        for (const p of src.plugins ?? []) {
          rows.push({
            title: p.name,
            subtitle: [
              p.installStatus,
              p.version ? `v${p.version}` : undefined,
              p.skillCount != null ? `${p.skillCount} skills` : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
            detail: p.description || "",
            badges: p.installStatus ? [p.installStatus] : [],
          });
        }
      }
      return rows;
    }
    case "skills":
      return payload.data.skills.map((s) => ({
        title: s.displayName || s.name,
        subtitle: [
          s.scope,
          s.enabled === false ? "disabled" : "enabled",
          s.pluginName ? `plugin: ${s.pluginName}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        detail: s.shortDescription || s.description || s.path || "",
        path: s.path,
        badges: s.enabled === false ? ["disabled"] : [],
      }));
    case "mcp":
      return payload.data.servers.map((s) => {
        const toolCount =
          s.toolCount ??
          s.session?.toolCount ??
          s.tools?.length ??
          s.session?.tools?.length ??
          0;
        const status = s.status || s.session?.status;
        return {
          title: s.displayName || s.name,
          subtitle: [
            s.source || s.type,
            status,
            s.enabled === false ? "disabled" : "enabled",
            toolCount ? `${toolCount} tools` : undefined,
            s.sourceLabel || s.configSource,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: "",
          badges: s.enabled === false ? ["disabled"] : status ? [status] : [],
        };
      });
  }
}
