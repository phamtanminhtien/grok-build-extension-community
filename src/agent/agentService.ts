import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  ActiveSession,
  SessionNotification,
  ContentBlock,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import type { AuthService } from "../auth/authService";
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
import {
  displayTitle,
  isEmptyHistorySession,
  isHiddenSession,
  repoNameFromCwd,
  sortSessionsNewestFirst,
  type GrokSession,
} from "../session/grokSession";
import { BinaryNotFoundError } from "./binaryResolver";
import { readTextFileHost, writeTextFileHost } from "./hostFs";
import { PermissionBroker } from "./permissionBroker";
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

export interface AgentCaps {
  loadSession: boolean;
  listSessions: boolean;
  resumeSession: boolean;
}

export interface RemoteSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: number;
}

/** Wire shape of Grok `Summary` from `_x.ai/session_summaries/*`. */
interface GrokSummaryWire {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string | null;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string | null;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
  agent_name?: string;
  session_kind?: string | null;
  hidden?: boolean | null;
}

export class AgentService implements vscode.Disposable {
  private state: AgentState = { kind: "idle" };
  private spawned: SpawnedAgent | undefined;
  private connection: ClientConnection | undefined;
  private session: ActiveSession | undefined;
  private startPromise: Promise<void> | undefined;
  private disposed = false;
  private busy = false;
  private readonly permissions = new PermissionBroker();
  private auth: AuthService | undefined;
  private caps: AgentCaps = {
    loadSession: false,
    listSessions: false,
    resumeSession: false,
  };

  private readonly _onStateChange = new vscode.EventEmitter<AgentState>();
  readonly onStateChange = this._onStateChange.event;

  private readonly _onSessionUpdate =
    new vscode.EventEmitter<SessionNotification>();
  readonly onSessionUpdate = this._onSessionUpdate.event;

  private readonly _onBusyChange = new vscode.EventEmitter<boolean>();
  readonly onBusyChange = this._onBusyChange.event;

  private readonly _onTurnEnd = new vscode.EventEmitter<PromptResponse>();
  readonly onTurnEnd = this._onTurnEnd.event;

  setAuthService(auth: AuthService): void {
    this.auth = auth;
  }

  getState(): AgentState {
    return this.state;
  }

  isBusy(): boolean {
    return this.busy;
  }

  getSessionId(): string | undefined {
    return this.state.kind === "ready" ? this.state.sessionId : undefined;
  }

  getCapabilities(): AgentCaps {
    return { ...this.caps };
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
    this.setState({ kind: "idle" });
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    await this.stopInternal();
    this.setBusy(false);
    this.setState({ kind: "idle" });
  }

  /**
   * Send a prompt turn. Streams via onSessionUpdate; resolves on stop.
   */
  async sendPrompt(
    content: string | ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureStarted();
    if (!this.session) {
      throw new Error("No active session");
    }
    if (this.busy) {
      throw new Error("A turn is already in progress — cancel or wait");
    }

    this.setBusy(true);
    try {
      const response = await this.session.prompt(content);
      this._onTurnEnd.fire(response);
      logInfo(`Prompt finished stopReason=${response.stopReason}`);
      return response;
    } finally {
      this.setBusy(false);
    }
  }

  async cancelTurn(): Promise<void> {
    if (!this.connection || !this.session) {
      return;
    }
    const sessionId = this.session.sessionId;
    logInfo(`Cancel turn sessionId=${sessionId}`);
    try {
      await this.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId,
      });
    } catch (err) {
      logWarn(`session/cancel failed: ${formatUserError(err)}`);
    }
  }

  /**
   * Create a new ACP session on the same agent process (or start process).
   */
  async newSession(): Promise<string> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new Error("No connection");
    }

    if (this.busy) {
      await this.cancelTurn();
    }

    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = undefined;
    this.permissions.resetSessionMemory();

    const cwd = resolveSessionCwd();
    logInfo(`session/new cwd=${cwd}`);
    const session = await this.connection.agent.buildSession(cwd).start();
    this.session = session;
    void this.pumpSessionUpdates(session);

    if (this.state.kind === "ready") {
      this.setState({ ...this.state, sessionId: session.sessionId });
    }
    logInfo(`session/new ok sessionId=${session.sessionId}`);
    return session.sessionId;
  }

  /**
   * List sessions for a workspace via Grok ext method
   * `_x.ai/session_summaries/session_list` (same source as TUI `/resume`).
   */
  async listGrokWorkspaceSessions(cwd: string): Promise<GrokSession[]> {
    await this.ensureStarted();
    if (!this.connection) {
      return [];
    }
    try {
      const res = await this.connection.agent.request<
        { session_summaries?: GrokSummaryWire[] },
        { workspace_directory: string }
      >("_x.ai/session_summaries/session_list", {
        workspace_directory: cwd,
      });
      return sortSessionsNewestFirst(
        (res.session_summaries ?? [])
          .map(summaryWireToGrokSession)
          .filter((s): s is GrokSession => s != null),
      );
    } catch (err) {
      logWarn(
        `x.ai/session_summaries/session_list failed: ${formatUserError(err)}`,
      );
      return [];
    }
  }

  /**
   * Recent sessions across workspaces — `_x.ai/session_summaries/workspace_list_recent`.
   */
  async listGrokRecentSessions(limit = 40): Promise<GrokSession[]> {
    await this.ensureStarted();
    if (!this.connection) {
      return [];
    }
    try {
      const res = await this.connection.agent.request<
        GrokSummaryWire[] | { session_summaries?: GrokSummaryWire[] },
        { limit: number }
      >("_x.ai/session_summaries/workspace_list_recent", {
        limit: Math.min(limit, 10_000),
      });
      const arr = Array.isArray(res)
        ? res
        : (res.session_summaries ?? []);
      return sortSessionsNewestFirst(
        arr
          .map(summaryWireToGrokSession)
          .filter((s): s is GrokSession => s != null),
      ).slice(0, limit);
    } catch (err) {
      logWarn(
        `x.ai/session_summaries/workspace_list_recent failed: ${formatUserError(err)}`,
      );
      return [];
    }
  }

  /**
   * Full-text session search — `_x.ai/session/search` (TUI content search).
   */
  async searchGrokSessions(
    query: string,
    options?: { cwd?: string; limit?: number },
  ): Promise<GrokSession[]> {
    await this.ensureStarted();
    if (!this.connection || !query.trim()) {
      return [];
    }
    try {
      const res = await this.connection.agent.request<
        {
          result?: {
            results?: Array<{
              sessionId?: string;
              session_id?: string;
              cwd?: string;
              summary?: string;
              updatedAt?: string;
              updated_at?: string;
            }>;
          };
          results?: Array<{
            sessionId?: string;
            session_id?: string;
            cwd?: string;
            summary?: string;
            updatedAt?: string;
            updated_at?: string;
          }>;
        },
        {
          query: string;
          cwd?: string;
          limit: number;
          include_content: boolean;
        }
      >("_x.ai/session/search", {
        query: query.trim(),
        cwd: options?.cwd,
        limit: options?.limit ?? 20,
        include_content: false,
      });
      const hits = res.result?.results ?? res.results ?? [];
      return hits
        .map((h) => {
          const sessionId = h.sessionId || h.session_id || "";
          if (!sessionId) {
            return undefined;
          }
          const cwd = h.cwd || "";
          const updatedIso = h.updatedAt || h.updated_at || "";
          return {
            sessionId,
            cwd,
            title: (h.summary || "").trim() || "(no summary)",
            createdAt: 0,
            updatedAt: updatedIso ? Date.parse(updatedIso) || 0 : 0,
            messageCount: 0,
            repoName: repoNameFromCwd(cwd),
          } satisfies GrokSession;
        })
        .filter((s): s is GrokSession => s != null);
    } catch (err) {
      logWarn(`x.ai/session/search failed: ${formatUserError(err)}`);
      return [];
    }
  }

  /**
   * Load an existing session (requires agent loadSession capability).
   * History is replayed via session/update notifications.
   */
  async loadSession(sessionId: string, cwd?: string): Promise<string> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new Error("No connection");
    }
    if (!this.caps.loadSession) {
      throw new Error(
        "Agent does not support session/load. History is local-only for this binary.",
      );
    }

    if (this.busy) {
      await this.cancelTurn();
    }

    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = undefined;
    this.permissions.resetSessionMemory();

    const sessionCwd = cwd || resolveSessionCwd();
    logInfo(`session/load sessionId=${sessionId} cwd=${sessionCwd}`);
    const loadRes = await this.connection.agent.request(
      acp.methods.agent.session.load,
      {
        sessionId,
        cwd: sessionCwd,
        mcpServers: [],
      },
    );

    // SDK attachSession is internal; load response has no sessionId field.
    type Attachable = {
      attachSession: (r: { sessionId: string } & typeof loadRes) => ActiveSession;
    };
    const agentCtx = this.connection.agent as unknown as Attachable;
    const session = agentCtx.attachSession({
      sessionId,
      ...loadRes,
    });
    this.session = session;
    void this.pumpSessionUpdates(session);

    if (this.state.kind === "ready") {
      this.setState({ ...this.state, sessionId: session.sessionId });
    }
    logInfo(`session/load ok sessionId=${session.sessionId}`);
    return session.sessionId;
  }

  /**
   * L0 smoke: start, send a simple prompt, stream session/update to Output.
   */
  async smokeTest(prompt = "Reply with exactly: L0 OK"): Promise<void> {
    openOutput();
    logInfo("=== Grok L0 smoke test ===");
    await this.ensureStarted();
    const response = await this.sendPrompt(prompt);
    logInfo(`Prompt finished stopReason=${response.stopReason}`);
    logInfo("=== Smoke test complete ===");
  }

  dispose(): void {
    void this.disposeAsync();
  }

  async disposeAsync(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.stopInternal();
    this.setBusy(false);
    this._onStateChange.dispose();
    this._onSessionUpdate.dispose();
    this._onBusyChange.dispose();
    this._onTurnEnd.dispose();
  }

  private setState(state: AgentState): void {
    this.state = state;
    this._onStateChange.fire(state);
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    this._onBusyChange.fire(busy);
  }

  private async startInternal(): Promise<void> {
    this.setState({ kind: "starting" });
    const settings = getSettings();
    const timeoutMs = settings.initializeTimeoutMs;

    try {
      await withTimeout(this.connectAndInit(settings), timeoutMs, () => {
        void this.stopInternal();
        return new Error(
          `Timed out after ${timeoutMs}ms waiting for agent initialize. ` +
            "Check Output → Grok Build and that `grok agent stdio` works in a terminal.",
        );
      });
    } catch (err) {
      const message = formatUserError(err);
      this.setState({ kind: "error", message });
      logError("Failed to start agent", err);
      throw err;
    }
  }

  private async connectAndInit(settings: GrokSettings): Promise<void> {
    const env = this.auth
      ? await this.auth.buildAgentEnv()
      : { ...process.env };

    const spawned = await spawnAgentProcess({
      settings,
      env,
      onExit: (code, signal) => {
        if (this.disposed) {
          return;
        }
        if (this.state.kind === "ready" || this.state.kind === "starting") {
          const message = `Agent process exited unexpectedly (code=${code}, signal=${signal})`;
          this.setState({ kind: "error", message });
          logWarn(message);
        }
        this.setBusy(false);
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
        this.permissions.handle(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        try {
          return await readTextFileHost(ctx.params.path);
        } catch (err) {
          logWarn(`fs/read_text_file error: ${formatUserError(err)}`);
          throw err;
        }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        try {
          return await writeTextFileHost(ctx.params.path, ctx.params.content);
        } catch (err) {
          logWarn(`fs/write_text_file error: ${formatUserError(err)}`);
          throw err;
        }
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.onSessionUpdateNotify(ctx.params);
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
        },
      },
    );

    logInfo(`initialize ok protocolVersion=${initResult.protocolVersion}`);
    const agentCaps = initResult.agentCapabilities;
    const sessionCaps = agentCaps?.sessionCapabilities;
    this.caps = {
      loadSession: !!agentCaps?.loadSession,
      listSessions: sessionCaps?.list != null,
      resumeSession: sessionCaps?.resume != null,
    };
    logInfo(
      `agent caps loadSession=${this.caps.loadSession} list=${this.caps.listSessions} resume=${this.caps.resumeSession}`,
    );

    const cwd = resolveSessionCwd(settings);
    logInfo(`session/new cwd=${cwd}`);
    const session = await connection.agent.buildSession(cwd).start();
    this.session = session;
    this.permissions.resetSessionMemory();
    logInfo(`session/new ok sessionId=${session.sessionId}`);

    this.setState({
      kind: "ready",
      sessionId: session.sessionId,
      protocolVersion: initResult.protocolVersion,
      binary: spawned.binary,
      version: spawned.version,
    });

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
          continue;
        }
      }
    } catch (err) {
      if (!this.disposed && this.state.kind === "ready") {
        logWarn(`Session update pump ended: ${formatUserError(err)}`);
      }
    }
  }

  private onSessionUpdateNotify(params: SessionNotification): void {
    this._onSessionUpdate.fire(params);
    this.logUpdate(params);
  }

  private logUpdate(params: SessionNotification): void {
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
      default:
        break;
    }
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

function summaryWireToGrokSession(
  s: GrokSummaryWire,
): GrokSession | undefined {
  if (
    isHiddenSession({
      hidden: s.hidden,
      sessionKind: s.session_kind,
    })
  ) {
    return undefined;
  }
  const sessionId = s.info?.id;
  if (!sessionId) {
    return undefined;
  }
  const cwd = s.info?.cwd || "";
  const title = displayTitle({
    generatedTitle: s.generated_title,
    sessionSummary: s.session_summary,
    sessionId,
  });
  const messageCount = s.num_chat_messages ?? s.num_messages ?? 0;
  // Match TUI /resume: drop empty summaries / never-used shells
  if (isEmptyHistorySession({ title, messageCount })) {
    return undefined;
  }
  const sortIso = s.last_active_at || s.updated_at || s.created_at || "";
  return {
    sessionId,
    cwd,
    title,
    createdAt: s.created_at ? Date.parse(s.created_at) || 0 : 0,
    updatedAt: sortIso ? Date.parse(sortIso) || 0 : 0,
    messageCount,
    modelId: s.current_model_id,
    agentName: s.agent_name,
    sessionKind: s.session_kind ?? undefined,
    repoName: repoNameFromCwd(cwd),
  };
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
