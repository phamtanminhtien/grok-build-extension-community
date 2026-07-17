/**
 * Wire builders for Extensions panel actions (x.ai action / toggle methods).
 * Pure - no vscode / agent imports (unit-testable).
 */

import type { ExtensionsTab } from "./tabs.ts";

/** HooksAction wire body - tag type, snake_case variants. */
export type HooksActionBody =
  | { type: "reload" }
  | { type: "trust" }
  | { type: "untrust" }
  | { type: "enable"; hook_name: string }
  | { type: "disable"; hook_name: string }
  | { type: "add"; path: string }
  | { type: "remove"; path: string };

/** PluginsAction wire body. */
export type PluginsActionBody =
  | { type: "reload" }
  | { type: "enable"; plugin_id: string }
  | { type: "disable"; plugin_id: string }
  | { type: "install"; source: string }
  | { type: "uninstall"; plugin_id: string; confirmed?: boolean }
  | { type: "update"; plugin_id?: string | null }
  | { type: "add"; path: string }
  | { type: "remove"; path: string };

/** MarketplaceAction wire body. */
export type MarketplaceActionBody =
  | { type: "refresh"; source_url_or_path?: string | null }
  | {
      type: "install";
      source_url_or_path: string;
      plugin_relative_path: string;
    }
  | {
      type: "update";
      source_url_or_path: string;
      plugin_relative_path: string;
    }
  | {
      type: "uninstall";
      source_url_or_path: string;
      plugin_relative_path: string;
    }
  | { type: "add_source"; url: string }
  | { type: "remove_source"; source_url_or_path: string };

/**
 * Discriminated action the host can run against the agent.
 * Wire shapes match shell handlers.
 */
export type ExtensionAction =
  | { kind: "hooks_action"; action: HooksActionBody }
  | { kind: "plugins_action"; action: PluginsActionBody }
  | { kind: "marketplace_action"; action: MarketplaceActionBody }
  | { kind: "skills_toggle"; name: string; enabled: boolean }
  | { kind: "mcp_toggle"; serverName: string; enabled: boolean };

/** Button shown on a list row. */
export interface RowActionButton {
  id: string;
  label: string;
  /** Payload posted to host then agent. */
  action: ExtensionAction;
}

export interface ActionOutcome {
  status?: string;
  message: string;
  requiresReload?: boolean;
  requiresRestart?: boolean;
  ok?: boolean;
}

/** Map enable/disable toggle for a hook by name. */
export function hooksEnableDisable(
  hookName: string,
  currentlyDisabled: boolean,
): RowActionButton {
  if (currentlyDisabled) {
    return {
      id: "enable",
      label: "Enable",
      action: {
        kind: "hooks_action",
        action: { type: "enable", hook_name: hookName },
      },
    };
  }
  return {
    id: "disable",
    label: "Disable",
    action: {
      kind: "hooks_action",
      action: { type: "disable", hook_name: hookName },
    },
  };
}

/** Map enable/disable for a plugin by id. */
export function pluginsEnableDisable(
  pluginId: string,
  enabled: boolean,
): RowActionButton {
  if (enabled === false) {
    return {
      id: "enable",
      label: "Enable",
      action: {
        kind: "plugins_action",
        action: { type: "enable", plugin_id: pluginId },
      },
    };
  }
  return {
    id: "disable",
    label: "Disable",
    action: {
      kind: "plugins_action",
      action: { type: "disable", plugin_id: pluginId },
    },
  };
}

/** Skills toggle - target enabled state after click. */
export function skillsToggleButton(
  name: string,
  currentlyEnabled: boolean,
): RowActionButton {
  const next = currentlyEnabled === false;
  return {
    id: next ? "enable" : "disable",
    label: next ? "Enable" : "Disable",
    action: { kind: "skills_toggle", name, enabled: next },
  };
}

/** MCP server toggle. */
export function mcpToggleButton(
  serverName: string,
  currentlyEnabled: boolean,
): RowActionButton {
  const next = currentlyEnabled === false;
  return {
    id: next ? "enable" : "disable",
    label: next ? "Enable" : "Disable",
    action: {
      kind: "mcp_toggle",
      serverName,
      enabled: next,
    },
  };
}

/**
 * Marketplace install / update / uninstall from installStatus string.
 * Status values: not_installed | installed | update_available | ...
 */
export function marketplacePluginButtons(
  sourceUrlOrPath: string,
  relativePath: string,
  installStatus: string | undefined,
): RowActionButton[] {
  const status = (installStatus ?? "not_installed").toLowerCase();
  const base = {
    source_url_or_path: sourceUrlOrPath,
    plugin_relative_path: relativePath,
  };
  const out: RowActionButton[] = [];
  if (status === "not_installed" || status === "available") {
    out.push({
      id: "install",
      label: "Install",
      action: {
        kind: "marketplace_action",
        action: { type: "install", ...base },
      },
    });
  } else if (status === "update_available") {
    out.push({
      id: "update",
      label: "Update",
      action: {
        kind: "marketplace_action",
        action: { type: "update", ...base },
      },
    });
    out.push({
      id: "uninstall",
      label: "Uninstall",
      action: {
        kind: "marketplace_action",
        action: { type: "uninstall", ...base },
      },
    });
  } else if (status === "installed") {
    out.push({
      id: "uninstall",
      label: "Uninstall",
      action: {
        kind: "marketplace_action",
        action: { type: "uninstall", ...base },
      },
    });
  }
  return out;
}

/** Tab-level toolbar actions (reload / refresh). */
export function tabToolbarActions(tab: ExtensionsTab): RowActionButton[] {
  switch (tab) {
    case "hooks":
      return [
        {
          id: "reload",
          label: "Reload",
          action: { kind: "hooks_action", action: { type: "reload" } },
        },
      ];
    case "plugins":
      return [
        {
          id: "reload",
          label: "Reload",
          action: { kind: "plugins_action", action: { type: "reload" } },
        },
      ];
    case "marketplace":
      return [
        {
          id: "refresh",
          label: "Rescan",
          action: {
            kind: "marketplace_action",
            action: { type: "refresh", source_url_or_path: null },
          },
        },
      ];
    case "skills":
    case "mcp":
      return [];
  }
}

/**
 * Build ACP ext method + params for an action.
 * Returns null if sessionId required but missing.
 */
export function toExtRequest(
  action: ExtensionAction,
  ctx: { sessionId?: string; cwd?: string },
): { method: string; params: Record<string, unknown> } | null {
  const sessionId = ctx.sessionId;
  switch (action.kind) {
    case "hooks_action": {
      if (!sessionId) {
        return null;
      }
      return {
        method: "x.ai/hooks/action",
        params: { sessionId, action: action.action },
      };
    }
    case "plugins_action": {
      if (!sessionId) {
        return null;
      }
      return {
        method: "x.ai/plugins/action",
        params: { sessionId, action: action.action },
      };
    }
    case "marketplace_action": {
      if (!sessionId) {
        return null;
      }
      return {
        method: "x.ai/marketplace/action",
        params: { sessionId, action: action.action },
      };
    }
    case "skills_toggle": {
      return {
        method: "x.ai/skills/toggle",
        params: {
          name: action.name,
          enabled: action.enabled,
          cwd: ctx.cwd,
        },
      };
    }
    case "mcp_toggle": {
      if (!sessionId) {
        return null;
      }
      // Shell McpToggleRequest is snake_case (no rename_all) - match TUI.
      return {
        method: "x.ai/mcp/toggle",
        params: {
          session_id: sessionId,
          server_name: action.serverName,
          enabled: action.enabled,
        },
      };
    }
  }
}

/** Normalize action response (ActionOutcome or { ok: true }). */
export function parseActionOutcome(raw: unknown): ActionOutcome {
  let v = raw;
  if (v && typeof v === "object" && "result" in v) {
    v = (v as { result: unknown }).result;
  }
  if (!v || typeof v !== "object") {
    return { message: "OK", ok: true };
  }
  const o = v as Record<string, unknown>;
  if (typeof o.error === "string" && o.error) {
    return { message: o.error, status: "error", ok: false };
  }
  if (o.error && typeof o.error === "object") {
    const err = o.error as Record<string, unknown>;
    const msg =
      typeof err.message === "string" ? err.message : JSON.stringify(o.error);
    return { message: msg, status: "error", ok: false };
  }
  const message =
    typeof o.message === "string" ? o.message : o.ok === true ? "OK" : "Done";
  return {
    status: typeof o.status === "string" ? o.status : undefined,
    message,
    requiresReload: o.requiresReload === true || o.requires_reload === true,
    requiresRestart: o.requiresRestart === true || o.requires_restart === true,
    ok: o.ok !== false,
  };
}
