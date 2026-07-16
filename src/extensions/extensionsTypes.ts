/**
 * Wire + UI types for the Extensions panel (no vscode / agent imports).
 */

import type { ExtensionsTab } from "./tabs";

export interface HookInfo {
  name: string;
  event?: string;
  handlerType?: string;
  matcher?: string | null;
  command?: string | null;
  url?: string | null;
  timeoutMs?: number;
  sourceDir?: string;
  disabled?: boolean;
}

export interface HooksListResponse {
  hooks: HookInfo[];
  projectTrusted?: boolean;
  loadErrors?: string[];
}

export interface PluginInfo {
  name: string;
  id?: string;
  root?: string;
  scope?: string;
  enabled?: boolean;
  version?: string | null;
  description?: string | null;
  skillCount?: number;
  hookCount?: number;
  mcpServerCount?: number;
  marketplaceSource?: string | null;
}

export interface PluginsListResponse {
  plugins: PluginInfo[];
}

export interface MarketplacePluginEntry {
  name: string;
  version?: string | null;
  description?: string | null;
  installStatus?: string;
  skillCount?: number;
  hasHooks?: boolean;
  hasMcp?: boolean;
  relativePath?: string;
}

export interface MarketplaceScanResult {
  sourceName: string;
  sourceKind?: string;
  sourceUrlOrPath?: string;
  plugins: MarketplacePluginEntry[];
  error?: string | null;
}

export interface MarketplaceListResponse {
  sources: MarketplaceScanResult[];
}

export interface SkillInfo {
  name: string;
  displayName?: string | null;
  description?: string;
  shortDescription?: string | null;
  path?: string;
  scope?: string;
  enabled?: boolean;
  pluginName?: string | null;
}

export interface SkillsListResponse {
  skills: SkillInfo[];
}

export interface McpToolInfo {
  name: string;
  description?: string | null;
}

export interface McpServerInfo {
  name: string;
  displayName?: string | null;
  source?: string;
  sourceLabel?: string | null;
  enabled?: boolean;
  status?: string | null;
  toolCount?: number;
  tools?: McpToolInfo[];
  configSource?: string | null;
  type?: string;
  session?: { status?: string; toolCount?: number; tools?: McpToolInfo[] };
}

export interface McpServersListResponse {
  servers: McpServerInfo[];
}

export type ExtensionsTabPayload =
  | { tab: "hooks"; data: HooksListResponse }
  | { tab: "plugins"; data: PluginsListResponse }
  | { tab: "marketplace"; data: MarketplaceListResponse }
  | { tab: "skills"; data: SkillsListResponse }
  | { tab: "mcp"; data: McpServersListResponse };

export interface ExtensionRow {
  title: string;
  subtitle: string;
  detail: string;
  path?: string;
  badges?: string[];
  isHeader?: boolean;
}

// re-export tab type for convenience
export type { ExtensionsTab };
