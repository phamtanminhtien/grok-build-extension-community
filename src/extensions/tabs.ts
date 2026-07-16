/**
 * Extensions management panel tabs — parity with TUI ExtensionsModal.
 */

export type ExtensionsTab =
  | "hooks"
  | "plugins"
  | "marketplace"
  | "skills"
  | "mcp";

export const EXTENSIONS_TABS: readonly ExtensionsTab[] = [
  "hooks",
  "plugins",
  "marketplace",
  "skills",
  "mcp",
] as const;

export const EXTENSIONS_TAB_LABELS: Record<ExtensionsTab, string> = {
  hooks: "Hooks",
  plugins: "Plugins",
  marketplace: "Marketplace",
  skills: "Skills",
  mcp: "MCP Servers",
};

/** Map slash command name (no slash) → panel tab. */
export function tabFromSlashName(name: string): ExtensionsTab | undefined {
  const key = name.trim().toLowerCase().replace(/^\//, "");
  switch (key) {
    case "hooks":
      return "hooks";
    case "plugins":
    case "plugin":
      return "plugins";
    case "marketplace":
      return "marketplace";
    case "skills":
    case "skill":
      return "skills";
    case "mcps":
    case "mcp":
      return "mcp";
    default:
      return undefined;
  }
}

export function isExtensionsTab(value: unknown): value is ExtensionsTab {
  return (
    typeof value === "string" &&
    (EXTENSIONS_TABS as readonly string[]).includes(value)
  );
}
