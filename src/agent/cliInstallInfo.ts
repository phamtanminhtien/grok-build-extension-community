import * as os from "node:os";
import * as path from "node:path";

/** Official install docs (same as Grok Build README). */
export const GROK_CLI_DOCS_URL = "https://x.ai/cli";

export interface CliInstallInfo {
  /** Shell one-liner for the current platform. */
  command: string;
  /** Human-readable platform label. */
  platformLabel: string;
  docsUrl: string;
  typicalPath: string;
}

/**
 * Platform-specific install command (official Grok Build installer).
 */
export function getCliInstallInfo(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): CliInstallInfo {
  if (platform === "win32") {
    return {
      command: "irm https://x.ai/cli/install.ps1 | iex",
      platformLabel: "Windows (PowerShell)",
      docsUrl: GROK_CLI_DOCS_URL,
      typicalPath: path.join(home, ".grok", "bin", "grok.exe"),
    };
  }
  return {
    command: "curl -fsSL https://x.ai/cli/install.sh | bash",
    platformLabel:
      platform === "darwin" ? "macOS / Linux" : "Linux / macOS",
    docsUrl: GROK_CLI_DOCS_URL,
    typicalPath: path.join(home, ".grok", "bin", "grok"),
  };
}

export function installHint(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const info = getCliInstallInfo(platform, home);
  return [
    "",
    "Install the Grok Build CLI, then retry:",
    "",
    `  ${info.command}`,
    "",
    "Or:",
    "  • ensure `grok` is on your PATH, or",
    "  • set Settings → Grok Build: Binary Path to the absolute path.",
    "",
    `Docs: ${info.docsUrl}`,
    `Typical location: ${info.typicalPath}`,
  ].join("\n");
}

export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

export function isBinaryMissingError(err: unknown): boolean {
  if (err instanceof BinaryNotFoundError) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /binary|not find|ENOENT|Could not find the `grok`/i.test(msg);
}
