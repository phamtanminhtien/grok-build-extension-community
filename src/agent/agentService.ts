import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  ActiveSession,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  getSettings,
  resolveSessionCwd,
  type GrokSettings,
} from "../config/settings";
import {
  logError,
  logInfo,
  logSessionUpdate,
  logWarn,
  openOutput,
} from "../log/output";
import { BinaryNotFoundError } from "./binaryResolver";
import { spawnAgentProcess, type SpawnedAgent } from "./processManager";

export type AgentState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "ready";
      sessionId: string;
      protocolVersion: number;
      binary: string;
      version: string;
    }
  | { kind: "error"; message: string };

export class AgentService {
  private state: AgentState = { kind: "idle" };
  private spawned: SpawnedAgent | undefined;
  private connection: ClientConnection | undefined;
  private session: ActiveSession | undefined;
  private startPromise: Promise<void> | undefined;
  private disposed = false;

  getState(): AgentState {
    return this.state;
  }

  getSessionId(): string | undefined {
    return this.state.kind === "ready" ? this.state.sessionId : undefined;
  }

  /**
   * Ensure agent process is up, initialized, and has an active session.
   */
  async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("AgentService was disposed");
    }
    if (this.state.kind === "ready" && this.connection && this.session) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async restart(): Promise<void> {
    logInfo("Restarting agent…");
    await this.stopInternal();
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    await this.stopInternal();
    this.state = { kind: "idle" };
  }

  /**
   * L0 smoke: start, send a simple prompt, stream session/update to Output.
   */
  async smokeTest(prompt = "Reply with exactly: L0 OK"): Promise<void> {
    openOutput();
    logInfo("=== Grok L0 smoke test ===");
    await this.ensureStarted();

    if (!this.session) {
      throw new Error("No active session after start");
    }

    const sessionId = this.session.sessionId;
    logInfo(`Sending smoke prompt on session ${sessionId}: ${JSON.stringify(prompt)}`);

    // Session already pumps updates via background loop; also await completion.
    const response = await this.session.prompt(prompt);
    logInfo(`Prompt finished stopReason=${response.stopReason}`);
    logInfo("=== Smoke test complete ===");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopInternal();
  }

  private async startInternal(): Promise<void> {
    this.state = { kind: "starting" };
    const settings = getSettings();
    const timeoutMs = settings.initializeTimeoutMs;

    try {
      await withTimeout(this.connectAndInit(settings), timeoutMs, () => {
        void this.stopInternal();
        return new Error(
          `Timed out after ${timeoutMs}ms waiting for agent initialize. ` +
            "Check Output → Grok and that `grok agent stdio` works in a terminal.",
        );
      });
    } catch (err) {
      const message = formatUserError(err);
      this.state = { kind: "error", message };
      logError("Failed to start agent", err);
      throw err;
    }
  }

  private async connectAndInit(settings: GrokSettings): Promise<void> {
    const spawned = await spawnAgentProcess({
      settings,
      onExit: (code, signal) => {
        if (this.disposed) {
          return;
        }
        if (this.state.kind === "ready" || this.state.kind === "starting") {
          this.state = {
            kind: "error",
            message: `Agent process exited unexpectedly (code=${code}, signal=${signal})`,
          };
          logWarn(this.state.message);
        }
        this.teardownConnectionOnly();
      },
    });
    this.spawned = spawned;

    const input = Writable.toWeb(spawned.process.stdin);
    const output = Readable.toWeb(
      spawned.process.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = acp
      .client({ name: "grok-build-community" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        logInfo(`[fs/read_text_file] ${ctx.params.path}`);
        // L0: stub — real FS mapping in L1
        return { content: "" };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        logInfo(
          `[fs/write_text_file] ${ctx.params.path} (${ctx.params.content.length} chars) — ignored in L0`,
        );
        return {};
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.onSessionUpdate(ctx.params);
      })
      .connect(stream);

    this.connection = connection;

    logInfo("Sending initialize…");
    const initResult = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          // L1 proposal: terminal false until VS Code PTY story is solid
        },
      },
    );

    logInfo(`initialize ok protocolVersion=${initResult.protocolVersion}`);

    const cwd = resolveSessionCwd(settings);
    logInfo(`session/new cwd=${cwd}`);
    const session = await connection.agent.buildSession(cwd).start();
    this.session = session;
    logInfo(`session/new ok sessionId=${session.sessionId}`);

    this.state = {
      kind: "ready",
      sessionId: session.sessionId,
      protocolVersion: initResult.protocolVersion,
      binary: spawned.binary,
      version: spawned.version,
    };

    // Drain ActiveSession queue so prompt() stop messages don't back up.
    // UI logging also comes from onNotification(session/update).
    void this.pumpSessionUpdates(session);
  }

  private async pumpSessionUpdates(session: ActiveSession): Promise<void> {
    try {
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          logInfo(
            `[session stop] stopReason=${message.stopReason} sessionId=${session.sessionId}`,
          );
          // After a stop, continue waiting for the next prompt turn.
          continue;
        }
        // Notifications are also handled via onNotification; keep loop alive.
      }
    } catch (err) {
      if (!this.disposed && this.state.kind === "ready") {
        logWarn(`Session update pump ended: ${formatUserError(err)}`);
      }
    }
  }

  private onSessionUpdate(params: SessionNotification): void {
    const update = params.update;
    const kind = update.sessionUpdate;

    switch (kind) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          logSessionUpdate(update.content.text);
        } else {
          logSessionUpdate(`[agent_message_chunk:${update.content.type}]`);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          logSessionUpdate(`[thought] ${update.content.text}`);
        } else {
          logSessionUpdate(`[thought:${update.content.type}]`);
        }
        break;
      }
      case "tool_call": {
        logSessionUpdate(
          `[tool_call] ${update.title ?? update.toolCallId} status=${update.status ?? "?"}`,
        );
        break;
      }
      case "tool_call_update": {
        logSessionUpdate(
          `[tool_call_update] ${update.toolCallId} status=${update.status ?? "?"}`,
        );
        break;
      }
      case "user_message_chunk":
      case "plan":
      default: {
        logSessionUpdate(`[${kind}] ${summarizeUpdate(update)}`);
        break;
      }
    }
  }

  private async handlePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    logWarn(
      `[permission] ${params.toolCall?.title ?? "tool"} — L0 auto-deny (use grok.alwaysApprove for YOLO)`,
    );

    // Prefer an explicit reject/cancel option if the agent offered one.
    const options = params.options ?? [];
    const deny =
      options.find((o) => o.kind === "reject_once" || o.kind === "reject_always") ??
      options.find((o) => /deny|reject|cancel|no/i.test(o.name));

    if (deny) {
      return {
        outcome: { outcome: "selected", optionId: deny.optionId },
      };
    }

    return { outcome: { outcome: "cancelled" } };
  }

  private async stopInternal(): Promise<void> {
    this.teardownConnectionOnly();
    if (this.spawned) {
      const s = this.spawned;
      this.spawned = undefined;
      try {
        await s.dispose();
      } catch (err) {
        logError("Error disposing agent process", err);
      }
    }
  }

  private teardownConnectionOnly(): void {
    try {
      this.session?.dispose();
    } catch {
      // ignore
    }
    this.session = undefined;

    try {
      this.connection?.close();
    } catch {
      // ignore
    }
    this.connection = undefined;
  }
}

function summarizeUpdate(update: SessionNotification["update"]): string {
  try {
    return JSON.stringify(update).slice(0, 200);
  } catch {
    return "";
  }
}

function formatUserError(err: unknown): string {
  if (err instanceof BinaryNotFoundError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
