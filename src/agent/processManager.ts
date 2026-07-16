import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getSettings, type GrokSettings } from "../config/settings";
import { logError, logInfo, logWarn } from "../log/output";
import { getGrokVersion, resolveGrokBinary } from "./binaryResolver";

export interface SpawnedAgent {
  binary: string;
  version: string;
  args: string[];
  process: ChildProcessWithoutNullStreams;
  /** Kill process with SIGTERM → grace → SIGKILL. */
  dispose: () => Promise<void>;
}

export type ProcessExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/**
 * Spawn `grok agent [flags] stdio` with piped stdio.
 * Keeps stdin open for the process lifetime.
 */
export async function spawnAgentProcess(options?: {
  settings?: GrokSettings;
  env?: NodeJS.ProcessEnv;
  onExit?: ProcessExitHandler;
  onStderrLine?: (line: string) => void;
}): Promise<SpawnedAgent> {
  const settings = options?.settings ?? getSettings();
  const binary = await resolveGrokBinary(settings.binaryPath);
  const version = await getGrokVersion(binary);
  const args = buildAgentArgs(settings);

  logInfo(`Spawning: ${binary} ${args.join(" ")}`);
  logInfo(`Binary version: ${version}`);

  const child = spawn(binary, args, {
    cwd: process.cwd(),
    env: options?.env ?? { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error("Failed to open stdio pipes for grok agent process");
  }

  let disposed = false;
  let stderrBuf = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        logWarn(`[agent stderr] ${line}`);
        options?.onStderrLine?.(line);
      }
    }
  });

  child.on("error", (err) => {
    logError("Agent process error", err);
  });

  child.on("exit", (code, signal) => {
    if (stderrBuf.trim()) {
      logWarn(`[agent stderr] ${stderrBuf.trim()}`);
      stderrBuf = "";
    }
    logInfo(
      `Agent process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    if (!disposed) {
      options?.onExit?.(code, signal);
    }
  });

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    await killProcessTree(child);
  };

  return {
    binary,
    version,
    args,
    process: child as ChildProcessWithoutNullStreams,
    dispose,
  };
}

function buildAgentArgs(settings: GrokSettings): string[] {
  const args = ["agent"];
  if (settings.model) {
    args.push("--model", settings.model);
  }
  if (settings.alwaysApprove) {
    args.push("--always-approve");
  }
  args.push("stdio");
  return args;
}

async function killProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const graceMs = 3000;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    child.once("exit", () => done());

    try {
      child.kill("SIGTERM");
    } catch {
      done();
      return;
    }

    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      setTimeout(done, 500);
    }, graceMs);
  });
}
