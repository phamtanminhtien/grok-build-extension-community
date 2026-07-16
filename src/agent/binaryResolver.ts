import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSettings } from "../config/settings";

const execFileAsync = promisify(execFile);

export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

/**
 * Resolve path to `grok` binary.
 * Order: setting → PATH → ~/.grok/bin/grok → /usr/local/bin/grok
 */
export async function resolveGrokBinary(
  binaryPathSetting?: string,
): Promise<string> {
  const configured =
    binaryPathSetting !== undefined
      ? binaryPathSetting.trim()
      : getSettings().binaryPath;

  if (configured) {
    if (await isExecutable(configured)) {
      return path.resolve(configured);
    }
    throw new BinaryNotFoundError(
      `Configured grok.binaryPath is not executable: ${configured}\n` +
        installHint(),
    );
  }

  const fromPath = await findOnPath("grok");
  if (fromPath) {
    return fromPath;
  }

  const fallbacks = [
    path.join(os.homedir(), ".grok", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  if (process.platform === "win32") {
    fallbacks.push(path.join(os.homedir(), ".grok", "bin", "grok.exe"));
  }

  for (const candidate of fallbacks) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new BinaryNotFoundError(
    "Could not find the `grok` binary.\n" + installHint(),
  );
}

export async function getGrokVersion(binary: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    return (stdout || stderr).trim().split("\n")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function installHint(): string {
  return [
    "",
    "Install Grok Build CLI, then either:",
    "  • ensure `grok` is on your PATH, or",
    "  • set Settings → Grok: Binary Path to the absolute path.",
    "",
    "Typical install location: ~/.grok/bin/grok",
  ].join("\n");
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findOnPath(command: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const ext =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const e of ext) {
      const candidate = path.join(dir, command + e.toLowerCase());
      // Windows: also try original case extension
      const candidates =
        process.platform === "win32"
          ? [path.join(dir, command + e), candidate]
          : [candidate];
      for (const c of candidates) {
        if (await isExecutable(c)) {
          return c;
        }
      }
    }
  }
  return undefined;
}
