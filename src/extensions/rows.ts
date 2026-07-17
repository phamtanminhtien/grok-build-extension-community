/**
 * Pure row mappers for the Extensions panel (unit-testable without vscode).
 */

import {
  hooksEnableDisable,
  marketplacePluginButtons,
  mcpToggleButton,
  pluginsEnableDisable,
  skillsToggleButton,
} from "./actions.ts";
import type { ExtensionRow, ExtensionsTabPayload } from "./extensionsTypes.ts";

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
        actions: h.name
          ? [hooksEnableDisable(h.name, !!h.disabled)]
          : undefined,
      }));
    case "plugins":
      return payload.data.plugins.map((p) => {
        const id = p.id || p.name;
        const enabled = p.enabled !== false;
        return {
          title: p.name,
          subtitle: [
            p.scope,
            enabled ? "enabled" : "disabled",
            p.version ? `v${p.version}` : undefined,
            p.skillCount != null ? `${p.skillCount} skills` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: p.description || p.root || "",
          path: p.root,
          badges: enabled ? [] : ["disabled"],
          actions: id ? [pluginsEnableDisable(id, enabled)] : undefined,
        };
      });
    case "marketplace": {
      const rows: ExtensionRow[] = [];
      for (const src of payload.data.sources) {
        const sourceKey = src.sourceUrlOrPath || src.sourceName;
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
          const rel = p.relativePath ?? "";
          const actions =
            sourceKey && rel
              ? marketplacePluginButtons(sourceKey, rel, p.installStatus)
              : [];
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
            actions: actions.length ? actions : undefined,
          });
        }
      }
      return rows;
    }
    case "skills":
      return payload.data.skills.map((s) => {
        const enabled = s.enabled !== false;
        return {
          title: s.displayName || s.name,
          subtitle: [
            s.scope,
            enabled ? "enabled" : "disabled",
            s.pluginName ? `plugin: ${s.pluginName}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: s.shortDescription || s.description || s.path || "",
          path: s.path,
          badges: enabled ? [] : ["disabled"],
          actions: s.name ? [skillsToggleButton(s.name, enabled)] : undefined,
        };
      });
    case "mcp":
      return payload.data.servers.map((s) => {
        const toolCount =
          s.toolCount ??
          s.session?.toolCount ??
          s.tools?.length ??
          s.session?.tools?.length ??
          0;
        const status = s.status || s.session?.status;
        const enabled = s.enabled !== false;
        const name = s.name;
        return {
          title: s.displayName || s.name,
          subtitle: [
            s.source || s.type,
            status,
            enabled ? "enabled" : "disabled",
            toolCount ? `${toolCount} tools` : undefined,
            s.sourceLabel || s.configSource,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: "",
          badges: enabled ? (status ? [status] : []) : ["disabled"],
          actions: name ? [mcpToggleButton(name, enabled)] : undefined,
        };
      });
  }
}
