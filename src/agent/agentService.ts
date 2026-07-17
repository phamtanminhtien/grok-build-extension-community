import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  ActiveSession,
  SessionNotification,
  ContentBlock,
  PromptResponse,
  AvailableCommand,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import type { AuthService } from "../auth/authService";
import {
  extractUserCode,
  formatAuthInfoSummary,
  formatGateBanner,
  isAccessGated,
  isSafeAuthUrl,
  needsManualAuthCodePaste,
  parseAuthInfoResponse,
  parseAuthUrlResponse,
  parseCheckSubscriptionResponse,
  parseLogoutResponse,
  pickInteractiveAuthMethodId,
  type AuthInfo,
  type AuthMeta,
  type AuthMethodLike,
  type CheckSubscriptionResult,
  type GateInfo,
  type LogoutResult,
} from "../auth/authFlow";
import {
  getSettings,
  resolveSessionCwd,
  type GrokSettings,
} from "../config/settings";
import {
  loadPermissionMode,
  permissionModeToCycleMode,
  persistPermissionModeFromCycle,
} from "../config/permissionMode";
import {
  effortDisplayLabel,
  modelDisplayLabel,
  parseModelsFromSessionMeta,
  parseSessionModelState,
  setModelAndEffortSetting,
  type GrokEffortOption,
  type GrokModelOption,
} from "../config/modelService";
import {
  cycleMode,
  cycleModeFromAgent,
  modeLabel,
  modeToAcpModeId,
  modeToPermissionCanonical,
  modeWantsAuto,
  modeWantsYolo,
  type CycleModeId,
} from "../ui/sessionModeCycle";
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
import {
  HUNK_TRACKER_METHODS,
  allActionParams,
  fileActionParams,
  getFilesParams,
  getHunksParams,
  hunkActionParams,
  parseGetFilesResponse,
  parseHunkActionResponse,
  turnActionParams,
  type HunkActionKind,
  type HunkActionResult,
  type HunkFileSummary,
} from "../diff/hunkTracker";
import { toAcpExtWireMethod } from "./acpExtMethod";
import { buildInitializeClientCapabilities } from "./clientCapabilities";
import { BinaryNotFoundError } from "./binaryResolver";
import { readTextFileHost, writeTextFileHost } from "./hostFs";
import {
  PermissionBroker,
  type PermissionPromptHandler,
} from "./permissionBroker";
import { spawnAgentProcess, type SpawnedAgent } from "./processManager";
import {
  emptyQueueSnapshot,
  makeOptimisticEntry,
  newPromptId,
  parseQueueChanged,
  reconcileQueue,
  type PromptQueueSnapshot,
  type QueueEntryWire,
} from "./promptQueue";
import {
  parseAskUserQuestionRequest,
  type AskUserQuestionResponse,
  type QuestionPromptPayload,
} from "../ui/interactivePrompt";
import {
  exitPlanModeResponse,
  parseExitPlanModeRequest,
  type ExitPlanModePromptPayload,
  type ExitPlanModeResponse,
} from "./exitPlanMode";
import {
  buildCompactParams,
  buildForkParams,
  compactRequestBody,
  forkRequestBody,
  parseForkResponse,
  parseRenameArgs,
  parseSuccessFlag,
  renameRequestBody,
  type ForkResult,
} from "./sessionAdmin";
import {
  SubagentLiveStore,
  type LiveSubagentStream,
} from "./subagentLiveStore";
import {
  TasksStore,
  serializeTasksForWebview,
  unwrapExtResult,
  unwrapTaskNotificationParams,
  type TasksSnapshot,
  type WorkKind,
} from "./tasksStore";
import {
  buildSubagentPanelModel,
  parseSubagentGetResponse,
  type SubagentPanelModel,
  type SubagentSnapshotWire,
} from "./subagentTranscript";
import {
  bannerTextForEvent,
  parseXaiSessionNotification,
  type ParsedXaiSessionNotification,
} from "./xaiSessionNotification";

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
  /** Number of in-flight `session/prompt` RPCs (running + queued). */
  private inFlightPrompts = 0;
  private busy = false;
  /** Server-authoritative prompt queue (TUI `shared_prompt_queues`). */
  private queue: PromptQueueSnapshot = emptyQueueSnapshot();
  /** Client-minted promptId → plain text (for adoption into chat when drain starts). */
  private readonly knownPromptTexts = new Map<string, string>();
  private readonly permissions = new PermissionBroker();
  /** In-webview ask_user_question popover (TUI question view). */
  private questionUi:
    | ((payload: QuestionPromptPayload) => Promise<AskUserQuestionResponse>)
    | undefined;
  private nextQuestionPromptId = 1;
  /** Plan approval UI for reverse-request `x.ai/exit_plan_mode`. */
  private planApprovalUi:
    | ((payload: ExitPlanModePromptPayload) => Promise<ExitPlanModeResponse>)
    | undefined;
  private nextPlanPromptId = 1;
  /**
   * Host banner events from `x.ai/session_notification` (retry, compact,
   * subagent, …). Chat listens and pushes system lines.
   */
  private readonly _onXaiSessionEvent =
    new vscode.EventEmitter<ParsedXaiSessionNotification>();
  readonly onXaiSessionEvent = this._onXaiSessionEvent.event;
  /** Background tasks / subagents / loops (extension Tasks panel). */
  private readonly tasksStore = new TasksStore();
  private readonly _onTasksChange = new vscode.EventEmitter<TasksSnapshot>();
  readonly onTasksChange = this._onTasksChange.event;
  private tasksPruneTimer: ReturnType<typeof setInterval> | undefined;
  /** Live child-session transcripts (TUI subagent_views equivalent). */
  private readonly liveSubagents = new SubagentLiveStore();
  private readonly _onLiveSubagentChange =
    new vscode.EventEmitter<LiveSubagentStream>();
  readonly onLiveSubagentChange = this._onLiveSubagentChange.event;
  private auth: AuthService | undefined;
  private caps: AgentCaps = {
    loadSession: false,
    listSessions: false,
    resumeSession: false,
  };
  /** Auth methods from last `initialize` (for browser login method pick). */
  private authMethods: AuthMethodLike[] = [];
  /** Prevent concurrent interactive login flows. */
  private loginInFlight: Promise<void> | undefined;
  /** True while `authenticate` is in-flight (allows concurrent submit_code). */
  private authAuthenticateActive = false;
  /** Latest profile from `x.ai/auth/info` (cleared on logout/stop). */
  private authInfo: AuthInfo | undefined;
  /** Latest AuthMeta (from check_subscription / login refresh). */
  private authMeta: AuthMeta | undefined;
  private readonly _onAuthProfileChange = new vscode.EventEmitter<{
    info?: AuthInfo;
    meta?: AuthMeta;
  }>();
  /** Fires when auth/info or subscription gate meta updates. */
  readonly onAuthProfileChange = this._onAuthProfileChange.event;

  private readonly _onStateChange = new vscode.EventEmitter<AgentState>();
  readonly onStateChange = this._onStateChange.event;

  private readonly _onSessionUpdate =
    new vscode.EventEmitter<SessionNotification>();
  readonly onSessionUpdate = this._onSessionUpdate.event;

  private readonly _onBusyChange = new vscode.EventEmitter<boolean>();
  readonly onBusyChange = this._onBusyChange.event;

  private readonly _onTurnEnd = new vscode.EventEmitter<PromptResponse>();
  readonly onTurnEnd = this._onTurnEnd.event;

  private readonly _onQueueChange =
    new vscode.EventEmitter<PromptQueueSnapshot>();
  readonly onQueueChange = this._onQueueChange.event;

  /** ACP-advertised slash commands (skills + shell builtins). */
  private availableCommands: AvailableCommand[] = [];
  private readonly _onAvailableCommands = new vscode.EventEmitter<
    AvailableCommand[]
  >();
  readonly onAvailableCommands = this._onAvailableCommands.event;

  /**
   * Live model catalog from the agent (same source as TUI `/model` dropdown:
   * `ModelsManager.available()` via session `_meta` + live `x.ai/models/update`).
   */
  private models: GrokModelOption[] = [];
  private currentModelId = "";
  private efforts: GrokEffortOption[] = [];
  private currentEffortId = "";
  private readonly _onModelsChange = new vscode.EventEmitter<{
    models: GrokModelOption[];
    currentModelId: string;
    currentLabel: string;
    efforts: GrokEffortOption[];
    currentEffortId: string;
    currentEffortLabel: string;
  }>();
  readonly onModelsChange = this._onModelsChange.event;

  /**
   * Shift+Tab cycle mode (TUI: Normal → Plan → Auto → Always-Approve).
   * Plan = ACP session mode; Auto/Always-Approve = permission via
   * `x.ai/yolo_mode_changed` (Always-Approve also auto-allows host dialogs).
   */
  private cycleModeId: CycleModeId = "normal";
  private acpModeId = "default";
  /** Session auto classifier (TUI `session.auto_mode`). */
  private autoMode = false;
  private availableModes: Array<{
    id: string;
    name: string;
    description?: string;
  }> = [];
  private readonly _onModeChange = new vscode.EventEmitter<{
    mode: CycleModeId;
    label: string;
    acpModeId: string;
  }>();
  readonly onModeChange = this._onModeChange.event;

  setAuthService(auth: AuthService): void {
    this.auth = auth;
  }

  /**
   * Wire chat webview for permission popovers.
   */
  setPermissionPromptUi(handler: PermissionPromptHandler | undefined): void {
    this.permissions.setPromptUi(handler);
  }

  /**
   * Wire chat webview for `x.ai/ask_user_question` popovers.
   */
  setQuestionPromptUi(
    handler:
      | ((payload: QuestionPromptPayload) => Promise<AskUserQuestionResponse>)
      | undefined,
  ): void {
    this.questionUi = handler;
  }

  /**
   * Wire host UI for `x.ai/exit_plan_mode` (plan approval).
   */
  setPlanApprovalUi(
    handler:
      | ((payload: ExitPlanModePromptPayload) => Promise<ExitPlanModeResponse>)
      | undefined,
  ): void {
    this.planApprovalUi = handler;
  }

  getAvailableCommands(): AvailableCommand[] {
    return this.availableCommands.slice();
  }

  /** Current agent model catalog + reasoning efforts (TUI-aligned). */
  getModels(): {
    models: GrokModelOption[];
    currentModelId: string;
    currentLabel: string;
    efforts: GrokEffortOption[];
    currentEffortId: string;
    currentEffortLabel: string;
  } {
    return {
      models: this.models.map((m) => ({ ...m })),
      currentModelId: this.currentModelId,
      currentLabel: modelDisplayLabel(this.models, this.currentModelId),
      efforts: this.efforts.map((e) => ({ ...e })),
      currentEffortId: this.currentEffortId,
      currentEffortLabel: effortDisplayLabel(
        this.efforts,
        this.currentEffortId,
      ),
    };
  }

  getState(): AgentState {
    return this.state;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Current shared prompt queue (queued follow-ups behind the running turn). */
  getQueue(): PromptQueueSnapshot {
    return {
      sessionId: this.queue.sessionId,
      runningPromptId: this.queue.runningPromptId,
      entries: this.queue.entries.map((e) => ({ ...e })),
    };
  }

  /** Background work snapshot for the Tasks webview panel. */
  getTasks(): TasksSnapshot {
    return this.tasksStore.snapshot();
  }

  /** Lookup one background work row (including finished within TTL). */
  getTask(id: string): import("./tasksStore").BackgroundWorkItem | undefined {
    return this.tasksStore.get(id);
  }

  /** Webview-ready tasks payload (elapsed labels, etc.). */
  getTasksForWebview(): ReturnType<typeof serializeTasksForWebview> {
    return serializeTasksForWebview(this.tasksStore.snapshot());
  }

  /**
   * Fetch a subagent snapshot (`x.ai/subagent/get`).
   * Does not block the agent turn; optional `block` waits for completion.
   */
  async getSubagentSnapshot(
    subagentId: string,
    options?: { block?: boolean; timeoutMs?: number },
  ): Promise<SubagentSnapshotWire | null> {
    const id = subagentId.trim();
    if (!id) {
      return null;
    }
    const raw = await this.requestExt<unknown>("x.ai/subagent/get", {
      subagentId: id,
      block: options?.block === true,
      timeoutMs: options?.timeoutMs,
    });
    return parseSubagentGetResponse(raw);
  }

  /**
   * Fetch + shape a subagent panel model for the chat webview
   * (same chrome language as the plan panel — not a separate editor tab).
   */
  async getSubagentPanelModel(subagentId: string): Promise<SubagentPanelModel> {
    const snap = await this.getSubagentSnapshot(subagentId);
    if (!snap) {
      throw new Error(`Subagent not found: ${subagentId}`);
    }
    const model = buildSubagentPanelModel(snap);
    logInfo(
      `subagent panel model id=${model.subagentId} status=${model.status}`,
    );
    return model;
  }

  /** True when sessionId is a known live subagent child session. */
  isSubagentChildSession(sessionId: string): boolean {
    return this.liveSubagents.isChildSession(sessionId);
  }

  getLiveSubagent(id: string): LiveSubagentStream | undefined {
    return this.liveSubagents.resolve(id);
  }

  /**
   * Apply a child `session/update` into the live store. Returns true when
   * consumed (caller must not merge into the parent chat).
   */
  applySubagentSessionUpdate(n: SessionNotification): boolean {
    const applied = this.liveSubagents.applySessionUpdate(n);
    if (!applied) {
      return false;
    }
    const sid =
      typeof n.sessionId === "string" ? n.sessionId : String(n.sessionId ?? "");
    const stream = this.liveSubagents.resolve(sid);
    if (stream) {
      // Mirror live activity onto the Tasks pane row.
      this.tasksStore.upsert({
        id: stream.subagentId,
        kind: "subagent",
        tag: stream.typeLabel,
        label: stream.description,
        status:
          stream.status === "stopping"
            ? "stopping"
            : stream.status === "running"
              ? "running"
              : stream.status === "failed"
                ? "failed"
                : stream.status === "cancelled"
                  ? "cancelled"
                  : "done",
        detail: stream.activity,
        startedAtMs: stream.startedAtMs,
        childSessionId: stream.childSessionId,
        subagentId: stream.subagentId,
        canKill: stream.status === "running" || stream.status === "stopping",
        canView: true,
      });
      this.fireTasksChange();
      this._onLiveSubagentChange.fire(stream);
    }
    return true;
  }

  /** Plain text for a prompt id we submitted (or last known from queue wire). */
  getKnownPromptText(promptId: string): string | undefined {
    return this.knownPromptTexts.get(promptId);
  }

  getSessionId(): string | undefined {
    return this.state.kind === "ready" ? this.state.sessionId : undefined;
  }

  getCapabilities(): AgentCaps {
    return { ...this.caps };
  }

  /** Current Shift+Tab cycle mode for the composer button. */
  getModeState(): {
    mode: CycleModeId;
    label: string;
    acpModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  } {
    return {
      mode: this.cycleModeId,
      label: modeLabel(this.cycleModeId),
      acpModeId: this.acpModeId,
      availableModes: this.availableModes.map((m) => ({ ...m })),
    };
  }

  /**
   * Cycle mode like TUI Shift+Tab:
   * Normal → Plan → Auto → Always-Approve → Normal.
   */
  async cycleSessionMode(): Promise<CycleModeId> {
    const next = cycleMode(this.cycleModeId);
    await this.applyCycleMode(next);
    return next;
  }

  /**
   * After plan Approve/Abandon the agent calls `leave_plan_mode_to_default`.
   * Update host cycle UI only (no second `session/set_mode` / toast) when still
   * showing Plan — `current_mode_update` may arrive later.
   */
  adoptDefaultModeAfterPlanExit(): void {
    if (this.cycleModeId !== "plan") {
      return;
    }
    this.cycleModeId = "normal";
    this.acpModeId = "default";
    this.autoMode = false;
    this.permissions.setAlwaysApproveOverride(undefined);
    this.fireModeChange();
    logInfo("cycle mode → normal (plan exit)");
  }

  /**
   * Apply a cycle mode arm (optimistic UI, then ACP + permission notify).
   * Persists non-plan arms to `~/.grok/config.toml` like TUI
   * `Effect::PersistPermissionMode`.
   */
  async applyCycleMode(mode: CycleModeId): Promise<void> {
    const prev = this.cycleModeId;
    this.cycleModeId = mode;
    this.autoMode = modeWantsAuto(mode);
    // Always-Approve → host auto-allow; Plan/Auto/Normal → no host yolo.
    this.permissions.setAlwaysApproveOverride(
      modeWantsYolo(mode)
        ? true
        : mode === "plan" || mode === "auto"
          ? false
          : undefined,
    );
    this.fireModeChange();

    try {
      const targetAcp = modeToAcpModeId(mode);
      if (targetAcp !== this.acpModeId || mode === "plan" || prev === "plan") {
        await this.setSessionMode(targetAcp, { preserveCycle: true });
      }
      // Permission arms always notify (TUI PersistPermissionMode).
      if (mode !== "plan" || prev === "plan") {
        await this.notifyPermissionMode(mode);
      }
      // Shared with CLI — write disk after agent accepted the mode.
      if (mode !== "plan") {
        try {
          const written = persistPermissionModeFromCycle(mode);
          if (written) {
            logInfo(`persisted [ui].permission_mode=${written}`);
          }
        } catch (err) {
          logWarn(`Could not save permission_mode: ${formatUserError(err)}`);
        }
      }
      // Re-assert cycle after wire (setSessionMode may not re-derive when preserve).
      this.cycleModeId = mode;
      this.autoMode = modeWantsAuto(mode);
      this.fireModeChange();
    } catch (err) {
      logWarn(`applyCycleMode failed: ${formatUserError(err)}`);
      this.cycleModeId = prev;
      this.autoMode = modeWantsAuto(prev);
      this.permissions.setAlwaysApproveOverride(
        modeWantsYolo(prev)
          ? true
          : prev === "plan" || prev === "auto"
            ? false
            : undefined,
      );
      this.fireModeChange();
      throw err;
    }
  }

  /**
   * Seed cycle/permission UI from `~/.grok/config.toml` (same as TUI launch)
   * and notify the agent so runtime matches disk.
   */
  private async applyPermissionModeFromDisk(): Promise<void> {
    const resolved = loadPermissionMode();
    const mode = permissionModeToCycleMode(resolved);
    this.cycleModeId = mode;
    this.autoMode = modeWantsAuto(mode);
    this.permissions.setAlwaysApproveOverride(
      modeWantsYolo(mode) ? true : mode === "auto" ? false : undefined,
    );
    this.fireModeChange();
    try {
      await this.notifyPermissionMode(mode);
      logInfo(`permission mode from config.toml: ${resolved} → cycle=${mode}`);
    } catch (err) {
      logWarn(`notifyPermissionMode from disk failed: ${formatUserError(err)}`);
    }
  }

  /**
   * ACP `session/set_mode` (plan / default).
   * @param preserveCycle when true (Shift+Tab path), do not re-derive
   *   cycleModeId from ACP alone (permission flags applied by caller).
   */
  async setSessionMode(
    modeId: string,
    opts?: { preserveCycle?: boolean },
  ): Promise<void> {
    const id = modeId.trim();
    if (!id) {
      throw new Error("Mode id is empty");
    }
    await this.ensureStarted();
    if (!this.connection || !this.session) {
      throw new Error("No active session");
    }
    const sessionId = this.session.sessionId;
    logInfo(`session/set_mode sessionId=${sessionId} modeId=${id}`);
    const camel = { sessionId, modeId: id };
    try {
      await this.connection.agent.request<unknown, typeof camel>(
        "session/set_mode",
        camel,
      );
    } catch (err) {
      const snake = { session_id: sessionId, mode_id: id };
      try {
        await this.connection.agent.request<unknown, typeof snake>(
          "session/set_mode",
          snake,
        );
      } catch {
        throw err;
      }
    }
    this.acpModeId = id;
    if (!opts?.preserveCycle) {
      this.cycleModeId = cycleModeFromAgent(id, {
        yolo: this.permissions.isAlwaysApprove(),
        auto: this.autoMode,
      });
    }
    this.fireModeChange();
    logInfo(`session/set_mode ok modeId=${id}`);
  }

  /**
   * Notify agent of permission mode (TUI `x.ai/yolo_mode_changed`).
   * Agent maps yolo_mode → SetYoloMode, auto_mode/permission_mode → auto classifier.
   */
  private async notifyPermissionMode(mode: CycleModeId): Promise<void> {
    if (!this.connection || !this.session) {
      return;
    }
    const permission_mode = modeToPermissionCanonical(mode);
    const yolo_mode = modeWantsYolo(mode);
    const auto_mode = modeWantsAuto(mode);
    const params = {
      yolo_mode,
      auto_mode,
      permission_mode,
      sessionId: this.session.sessionId,
    };
    logInfo(
      `x.ai/yolo_mode_changed yolo=${yolo_mode} auto=${auto_mode} perm=${permission_mode}`,
    );
    // Prefer underscore-prefixed wire (ACP ext routing); fall back to bare.
    try {
      await this.connection.agent.notify("_x.ai/yolo_mode_changed", params);
    } catch {
      try {
        await this.connection.agent.notify("x.ai/yolo_mode_changed", params);
      } catch (err) {
        logWarn(`yolo_mode_changed notify failed: ${formatUserError(err)}`);
      }
    }
  }

  private fireModeChange(): void {
    this._onModeChange.fire({
      mode: this.cycleModeId,
      label: modeLabel(this.cycleModeId),
      acpModeId: this.acpModeId,
    });
  }

  private ingestSessionModes(
    session: ActiveSession,
    extra?: { modes?: unknown },
  ): void {
    const modes =
      (session.modes as
        | {
            currentModeId?: string;
            availableModes?: Array<{
              id: string;
              name: string;
              description?: string | null;
            }>;
          }
        | null
        | undefined) ??
      (extra?.modes as
        | {
            currentModeId?: string;
            availableModes?: Array<{
              id: string;
              name: string;
              description?: string | null;
            }>;
          }
        | null
        | undefined);
    if (!modes) {
      return;
    }
    if (Array.isArray(modes.availableModes)) {
      this.availableModes = modes.availableModes.map((m) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        description: m.description ? String(m.description) : undefined,
      }));
    }
    if (modes.currentModeId) {
      this.acpModeId = String(modes.currentModeId);
      if (this.acpModeId === "plan") {
        this.cycleModeId = "plan";
        this.autoMode = false;
        this.permissions.setAlwaysApproveOverride(false);
      } else if (this.cycleModeId === "plan") {
        this.cycleModeId = cycleModeFromAgent(this.acpModeId, {
          yolo: this.permissions.isAlwaysApprove(),
          auto: this.autoMode,
        });
      }
      this.fireModeChange();
    }
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
   *
   * Concurrent calls are allowed while a turn is running: the agent queues the
   * prompt server-side (same as Grok TUI) and each RPC completes when *that*
   * prompt finishes. Pass `promptId` in options so optimistic queue rows match
   * `x.ai/queue/changed` / `runningPromptId`.
   */
  async sendPrompt(
    content: string | ContentBlock[],
    options?: { promptId?: string; queueText?: string },
  ): Promise<PromptResponse> {
    await this.ensureStarted();
    if (!this.session || !this.connection) {
      throw new Error("No active session");
    }

    const promptId = options?.promptId?.trim() || newPromptId();
    const blocks = normalizePromptBlocks(content);
    const queueText =
      options?.queueText ??
      blocks
        .filter(
          (b): b is Extract<ContentBlock, { type: "text" }> =>
            b.type === "text",
        )
        .map((b) => b.text)
        .join("\n\n");
    if (queueText) {
      this.knownPromptTexts.set(promptId, queueText);
    }

    this.inFlightPrompts += 1;
    this.setBusy(true);
    try {
      // Use raw request so we can stamp `_meta.promptId` like the TUI.
      const response = await this.connection.agent.request<
        PromptResponse,
        {
          sessionId: string;
          prompt: ContentBlock[];
          _meta?: { promptId: string };
        }
      >(acp.methods.agent.session.prompt, {
        sessionId: this.session.sessionId,
        prompt: blocks,
        _meta: { promptId },
      });
      this._onTurnEnd.fire(response);
      logInfo(
        `Prompt finished stopReason=${response.stopReason} promptId=${promptId}`,
      );
      return response;
    } finally {
      this.inFlightPrompts = Math.max(0, this.inFlightPrompts - 1);
      if (this.inFlightPrompts === 0) {
        this.setBusy(false);
      }
    }
  }

  /**
   * Optimistically show a queue row before the confirming `x.ai/queue/changed`.
   */
  pushOptimisticQueueEntry(
    promptId: string,
    text: string,
    kind = "prompt",
  ): void {
    const sid = this.getSessionId() ?? this.queue.sessionId;
    const entry = makeOptimisticEntry(
      promptId,
      text,
      kind,
      this.queue.entries.length,
    );
    this.knownPromptTexts.set(promptId, text);
    this.queue = {
      sessionId: sid,
      runningPromptId: this.queue.runningPromptId,
      entries: [...this.queue.entries, entry],
    };
    this._onQueueChange.fire(this.getQueue());
  }

  /** Remove a queued prompt (`x.ai/queue/remove`). */
  async queueRemove(id: string, expectedVersion = 0): Promise<void> {
    const sessionId = this.requireSessionId();
    // Optimistic local drop
    this.queue = {
      ...this.queue,
      entries: this.queue.entries
        .filter((e) => e.id !== id)
        .map((e, i) => ({ ...e, position: i })),
    };
    this._onQueueChange.fire(this.getQueue());
    await this.notifyQueue("x.ai/queue/remove", {
      sessionId,
      id,
      expectedVersion,
    });
  }

  /** Reorder the held queue (`x.ai/queue/reorder`). */
  async queueReorder(orderedIds: string[]): Promise<void> {
    const sessionId = this.requireSessionId();
    const byId = new Map(this.queue.entries.map((e) => [e.id, e]));
    const next: QueueEntryWire[] = [];
    for (const id of orderedIds) {
      const e = byId.get(id);
      if (e) {
        next.push({ ...e, position: next.length });
        byId.delete(id);
      }
    }
    for (const e of byId.values()) {
      next.push({ ...e, position: next.length });
    }
    this.queue = { ...this.queue, entries: next };
    this._onQueueChange.fire(this.getQueue());
    await this.notifyQueue("x.ai/queue/reorder", {
      sessionId,
      orderedIds,
    });
  }

  /** Clear all held queue entries (`x.ai/queue/clear`). */
  async queueClear(): Promise<void> {
    const sessionId = this.requireSessionId();
    this.queue = {
      sessionId,
      entries: [],
      runningPromptId: this.queue.runningPromptId,
    };
    this._onQueueChange.fire(this.getQueue());
    await this.notifyQueue("x.ai/queue/clear", { sessionId });
  }

  /** Edit queued prompt text (`x.ai/queue/edit`). */
  async queueEdit(id: string, newText: string): Promise<void> {
    const sessionId = this.requireSessionId();
    const text = newText.trim();
    if (!text) {
      throw new Error("Queue edit text is empty");
    }
    this.queue = {
      ...this.queue,
      entries: this.queue.entries.map((e) =>
        e.id === id
          ? { ...e, text, version: e.version + 1, lastEditor: "grok-vscode" }
          : e,
      ),
    };
    this.knownPromptTexts.set(id, text);
    this._onQueueChange.fire(this.getQueue());
    await this.notifyQueue("x.ai/queue/edit", {
      sessionId,
      id,
      newText: text,
    });
  }

  /**
   * Force-send a queued prompt now (`x.ai/queue/interject`) — cancel-and-run
   * next (TUI send-now), optionally with replacement text.
   */
  async queueInterject(
    id: string,
    expectedVersion = 0,
    newText?: string,
  ): Promise<void> {
    const sessionId = this.requireSessionId();
    const params: Record<string, unknown> = {
      sessionId,
      id,
      expectedVersion,
    };
    if (newText != null && newText.trim()) {
      params.newText = newText.trim();
      this.knownPromptTexts.set(id, newText.trim());
    }
    await this.notifyQueue("x.ai/queue/interject", params);
  }

  /** Send-now the top held queue row (TUI empty-Enter force-send). */
  async queueSendNowTop(): Promise<boolean> {
    const top = this.queue.entries[0];
    if (!top) {
      return false;
    }
    await this.queueInterject(top.id, top.version);
    return true;
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
    this.availableCommands = [];
    this._onAvailableCommands.fire([]);
    this.inFlightPrompts = 0;
    this.setBusy(false);

    const cwd = resolveSessionCwd();
    logInfo(`session/new cwd=${cwd}`);
    const session = await this.connection.agent.buildSession(cwd).start();
    this.session = session;
    this.resetQueueState(session.sessionId);
    this.resetTasksState(session.sessionId);
    this.ingestSessionModels(session);
    this.ingestSessionModes(session);
    void this.pumpSessionUpdates(session);
    void this.refreshTasks().catch(() => undefined);

    if (this.state.kind === "ready") {
      this.setState({ ...this.state, sessionId: session.sessionId });
    }
    logInfo(`session/new ok sessionId=${session.sessionId}`);
    return session.sessionId;
  }

  /**
   * Switch model on the active session via ACP `session/set_model`
   * (same path as TUI `/model`). Persists to
   * `~/.grok/config.toml` `[models].default` (+ optional effort).
   */
  async setSessionModel(
    modelId: string,
    options?: { effortId?: string },
  ): Promise<void> {
    const id = modelId.trim();
    if (!id) {
      throw new Error("Model id is empty");
    }
    await this.ensureStarted();
    if (!this.connection || !this.session) {
      throw new Error("No active session");
    }
    if (this.busy) {
      throw new Error("Cannot switch model while a turn is in progress");
    }

    const sessionId = this.session.sessionId;
    const effortId = options?.effortId?.trim();
    logInfo(
      `session/set_model sessionId=${sessionId} modelId=${id}` +
        (effortId ? ` effort=${effortId}` : ""),
    );
    const meta =
      effortId != null && effortId !== ""
        ? { reasoningEffort: effortId }
        : undefined;
    await this.requestSetSessionModel(sessionId, id, meta);

    try {
      await setModelAndEffortSetting(id, effortId);
      logInfo(
        `persisted [models].default=${id}` +
          (effortId ? ` default_reasoning_effort=${effortId}` : ""),
      );
    } catch (err) {
      logWarn(`Could not save models config: ${formatUserError(err)}`);
    }
    this.currentModelId = id;
    for (const m of this.models) {
      m.selected = m.id === id;
    }
    if (!this.models.some((m) => m.id === id)) {
      this.models.push({ id, label: id, selected: true });
    }
    // Refresh effort menu for the newly selected model.
    this.syncEffortsFromCurrentModel(effortId);
    this.fireModelsChange();
    logInfo(`session/set_model ok modelId=${id}`);
  }

  /**
   * Set reasoning effort for the current model (TUI `/effort`).
   * Uses `session/set_model` with same model id + `_meta.reasoningEffort`.
   * Persists `~/.grok/config.toml` `[models].default_reasoning_effort`.
   */
  async setReasoningEffort(effortId: string): Promise<void> {
    const id = effortId.trim();
    if (!id) {
      throw new Error("Effort id is empty");
    }
    const modelId = this.currentModelId || getSettings().model;
    if (!modelId) {
      throw new Error("No current model to apply effort to");
    }
    // setSessionModel persists both model + effort to config.toml.
    await this.setSessionModel(modelId, { effortId: id });
    this.currentEffortId = id;
    for (const e of this.efforts) {
      e.selected = e.id === id;
    }
    this.fireModelsChange();
  }

  private async requestSetSessionModel(
    sessionId: string,
    modelId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("No connection");
    }
    const camel = {
      sessionId,
      modelId,
      ...(meta ? { _meta: meta } : {}),
    };
    try {
      await this.connection.agent.request<unknown, typeof camel>(
        "session/set_model",
        camel,
      );
      return;
    } catch (err) {
      const snake = {
        session_id: sessionId,
        model_id: modelId,
        ...(meta ? { _meta: meta } : {}),
      };
      try {
        await this.connection.agent.request<unknown, typeof snake>(
          "session/set_model",
          snake,
        );
      } catch {
        throw err;
      }
    }
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
      const arr = Array.isArray(res) ? res : (res.session_summaries ?? []);
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
      attachSession: (
        r: { sessionId: string } & typeof loadRes,
      ) => ActiveSession;
    };
    const agentCtx = this.connection.agent as unknown as Attachable;
    const session = agentCtx.attachSession({
      sessionId,
      ...loadRes,
    });
    this.session = session;
    this.resetTasksState(session.sessionId);
    // load response may carry config in result; merge meta when present.
    this.ingestSessionModels(
      session,
      loadRes as { _meta?: unknown; models?: unknown },
    );
    this.ingestSessionModes(session, loadRes as { modes?: unknown });
    void this.pumpSessionUpdates(session);
    void this.refreshTasks().catch(() => undefined);

    if (this.state.kind === "ready") {
      this.setState({ ...this.state, sessionId: session.sessionId });
    }
    logInfo(`session/load ok sessionId=${session.sessionId}`);
    return session.sessionId;
  }

  /**
   * On-demand compact — `x.ai/compact_conversation` (TUI `/compact`).
   * Optional `userContext` preserves specific details during summarization.
   */
  async compactConversation(userContext?: string): Promise<void> {
    const sessionId = this.requireSessionId();
    const params = buildCompactParams(sessionId, userContext ?? "");
    logInfo(
      `compact_conversation session=${sessionId} context=${params.userContext ? "yes" : "no"}`,
    );
    const raw = await this.requestExt(
      "x.ai/compact_conversation",
      compactRequestBody(params),
    );
    if (!parseSuccessFlag(raw)) {
      throw new Error("Compaction failed");
    }
  }

  /**
   * Rename session title — `x.ai/session/rename` (TUI `/rename` / `/title`).
   */
  async renameSession(title: string): Promise<void> {
    const trimmed = parseRenameArgs(title);
    if (!trimmed) {
      throw new Error("Title must not be blank");
    }
    const sessionId = this.requireSessionId();
    const cwd = resolveSessionCwd();
    logInfo(`session/rename session=${sessionId} title=${trimmed}`);
    const raw = await this.requestExt(
      "x.ai/session/rename",
      renameRequestBody({ sessionId, title: trimmed, cwd }),
    );
    if (!parseSuccessFlag(raw)) {
      throw new Error("Rename failed");
    }
  }

  /**
   * Fork current session into a new peer — `x.ai/session/fork`.
   * Does **not** load the new session; callers should `loadSession` after
   * preparing UI history replay (same as resume).
   */
  async forkSession(args = ""): Promise<ForkResult> {
    const sourceSessionId = this.requireSessionId();
    const cwd = resolveSessionCwd();
    const params = buildForkParams(sourceSessionId, cwd, args);
    logInfo(
      `session/fork source=${sourceSessionId} cwd=${cwd}` +
        (params.directive ? ` directive=${params.directive}` : ""),
    );
    if (this.busy) {
      await this.cancelTurn();
    }
    const raw = await this.requestExt(
      "x.ai/session/fork",
      forkRequestBody(params),
    );
    const result = parseForkResponse(raw);
    if (!result) {
      throw new Error("Fork failed: invalid agent response");
    }
    return result;
  }

  // ── Hunk tracker (x.ai/hunk-tracker/*) ─────────────────────────────

  /** List tracked files with hunk counts (`get-files`). */
  async hunkTrackerGetFiles(): Promise<HunkFileSummary[]> {
    const sessionId = this.requireSessionId();
    const raw = await this.requestExt(
      HUNK_TRACKER_METHODS.getFiles,
      getFilesParams(sessionId),
    );
    return parseGetFilesResponse(raw);
  }

  /** Hunks for the session or a single path (`get-hunks`). */
  async hunkTrackerGetHunks(opts?: {
    path?: string;
    source?: "agent" | "external" | "all";
  }): Promise<unknown> {
    const sessionId = this.requireSessionId();
    return this.requestExt(
      HUNK_TRACKER_METHODS.getHunks,
      getHunksParams(sessionId, opts),
    );
  }

  /** Accept or reject one hunk by id. */
  async hunkTrackerHunkAction(
    hunkId: string,
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    const sessionId = this.requireSessionId();
    logInfo(`hunk-tracker/hunk-action id=${hunkId} action=${action}`);
    const raw = await this.requestExt(
      HUNK_TRACKER_METHODS.hunkAction,
      hunkActionParams(sessionId, hunkId, action),
    );
    return parseHunkActionResponse(raw);
  }

  /** Accept or reject all hunks for a file path. */
  async hunkTrackerFileAction(
    path: string,
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    const sessionId = this.requireSessionId();
    logInfo(`hunk-tracker/file-action path=${path} action=${action}`);
    const raw = await this.requestExt(
      HUNK_TRACKER_METHODS.fileAction,
      fileActionParams(sessionId, path, action),
    );
    return parseHunkActionResponse(raw);
  }

  /** Accept or reject all hunks for a prompt turn. */
  async hunkTrackerTurnAction(
    promptIndex: number,
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    const sessionId = this.requireSessionId();
    logInfo(
      `hunk-tracker/turn-action promptIndex=${promptIndex} action=${action}`,
    );
    const raw = await this.requestExt(
      HUNK_TRACKER_METHODS.turnAction,
      turnActionParams(sessionId, promptIndex, action),
    );
    return parseHunkActionResponse(raw);
  }

  /** Accept or reject every tracked hunk in the session. */
  async hunkTrackerAllAction(
    action: HunkActionKind,
  ): Promise<HunkActionResult> {
    const sessionId = this.requireSessionId();
    logInfo(`hunk-tracker/all-action action=${action}`);
    const raw = await this.requestExt(
      HUNK_TRACKER_METHODS.allAction,
      allActionParams(sessionId, action),
    );
    return parseHunkActionResponse(raw);
  }

  /**
   * Call an agent extension method (`x.ai/*`).
   *
   * ACP's JSON-RPC decoder only routes custom methods to `ext_method` when
   * the **wire** method is `_`-prefixed (`_x.ai/...`). Bare `x.ai/...` is
   * rejected with method_not_found (-32601). Callers may pass either form.
   */
  async requestExt<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new Error("No agent connection");
    }
    return this.requestExtOnConnection<T>(method, params);
  }

  /**
   * Interactive browser login (pager `/login` parity).
   *
   * Runs ACP `authenticate` with `force_interactive` + concurrent
   * `x.ai/auth/get_url` poll; opens a safe `https:` URL via `openExternal`.
   * Loopback mode also prompts for a paste token → `x.ai/auth/submit_code`.
   */
  async interactiveBrowserLogin(): Promise<void> {
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    this.loginInFlight = this.runInteractiveBrowserLogin().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  /**
   * Paste auth token during an in-flight login (`x.ai/auth/submit_code`).
   * Also usable via command palette if the auto InputBox was dismissed.
   */
  async pasteAuthCode(): Promise<boolean> {
    const code = await vscode.window.showInputBox({
      title: "Grok Build — Paste auth token",
      prompt:
        "Paste the token / code from the browser (loopback sign-in). Same as TUI auth paste.",
      ignoreFocusOut: true,
      placeHolder: "token or code",
      password: false,
    });
    if (!code?.trim()) {
      return false;
    }
    await this.submitAuthCode(code.trim());
    void vscode.window.showInformationMessage(
      "Grok Build: auth token submitted — finish approval if still waiting",
    );
    return true;
  }

  /**
   * Submit a pasted auth code to the agent (`x.ai/auth/submit_code`).
   * Must run while `authenticate` is pending (agent holds the oneshot).
   */
  async submitAuthCode(code: string): Promise<void> {
    if (!this.connection) {
      throw new Error("No agent connection — start login first");
    }
    const trimmed = code.trim();
    if (!trimmed) {
      throw new Error("Auth code is empty");
    }
    logInfo("x.ai/auth/submit_code");
    await this.requestExtOnConnection("x.ai/auth/submit_code", {
      code: trimmed,
    });
  }

  /**
   * Fetch profile via `x.ai/auth/info` and cache for empty-state / status.
   */
  async refreshAuthInfo(): Promise<AuthInfo | undefined> {
    if (!this.connection) {
      return this.authInfo;
    }
    try {
      const raw = await this.requestExtOnConnection("x.ai/auth/info", {});
      this.authInfo = parseAuthInfoResponse(raw);
      logInfo(
        `x.ai/auth/info email=${this.authInfo.email ?? ""} method=${this.authInfo.methodId ?? ""}`,
      );
      this._onAuthProfileChange.fire({
        info: this.authInfo,
        meta: this.authMeta,
      });
      return this.authInfo;
    } catch (err) {
      logWarn(`x.ai/auth/info failed: ${formatUserError(err)}`);
      return this.authInfo;
    }
  }

  /**
   * Re-check subscription / paywall gate (`x.ai/auth/check_subscription`).
   */
  async checkSubscription(): Promise<CheckSubscriptionResult> {
    if (!this.connection) {
      await this.ensureStarted();
    }
    if (!this.connection) {
      throw new Error("No agent connection");
    }
    logInfo("x.ai/auth/check_subscription");
    const raw = await this.requestExtOnConnection(
      "x.ai/auth/check_subscription",
      {},
    );
    const result = parseCheckSubscriptionResponse(raw);
    if (result.meta) {
      this.authMeta = result.meta;
    } else if (!result.authenticated) {
      this.authMeta = undefined;
    }
    this._onAuthProfileChange.fire({
      info: this.authInfo,
      meta: this.authMeta,
    });
    const gate = this.authMeta?.gate;
    logInfo(
      `check_subscription authenticated=${result.authenticated} gated=${isAccessGated(this.authMeta)}` +
        (gate?.message ? ` gate="${gate.message.slice(0, 80)}"` : ""),
    );
    return result;
  }

  getAuthInfo(): AuthInfo | undefined {
    return this.authInfo;
  }

  getAuthMeta(): AuthMeta | undefined {
    return this.authMeta;
  }

  getAccessGate(): GateInfo | undefined {
    return this.authMeta?.gate;
  }

  /**
   * Best summary for empty-state: auth/info + gate > AuthService presence.
   */
  formatAuthProfileSummary(fallbackPresence: string): string {
    const rich = formatAuthInfoSummary(this.authInfo, {
      gate: this.authMeta?.gate,
      subscriptionTier: this.authMeta?.subscriptionTier,
    });
    if (rich) {
      return rich;
    }
    const gateOnly = formatGateBanner(this.authMeta?.gate);
    if (gateOnly && fallbackPresence !== "Not signed in") {
      return `${fallbackPresence} · ${gateOnly}`;
    }
    return fallbackPresence;
  }

  /**
   * Logout: clear agent OAuth session (`x.ai/auth/logout`) when connected,
   * clear extension SecretStorage API key, stop agent so next start is clean.
   */
  async logout(): Promise<{
    logout: LogoutResult;
    clearedSecretKey: boolean;
  }> {
    let logout: LogoutResult = {
      ok: true,
      wasLoggedIn: false,
      apiKeyStillSet: false,
    };

    // Prefer live agent logout (clears auth.json + in-memory) when connected.
    if (this.connection && this.state.kind === "ready") {
      try {
        const raw = await this.requestExtOnConnection("x.ai/auth/logout", {});
        logout = parseLogoutResponse(raw);
        logInfo(
          `x.ai/auth/logout was_logged_in=${logout.wasLoggedIn} email=${logout.email ?? ""}`,
        );
      } catch (err) {
        logWarn(`x.ai/auth/logout failed: ${formatUserError(err)}`);
      }
    } else {
      // Best-effort: start briefly just to logout, if binary is available.
      try {
        await this.ensureStarted();
        if (this.connection) {
          const raw = await this.requestExtOnConnection("x.ai/auth/logout", {});
          logout = parseLogoutResponse(raw);
          logInfo(
            `x.ai/auth/logout was_logged_in=${logout.wasLoggedIn} email=${logout.email ?? ""}`,
          );
        }
      } catch (err) {
        logWarn(
          `logout could not reach agent (CLI auth may remain): ${formatUserError(err)}`,
        );
      }
    }

    let clearedSecretKey = false;
    if (this.auth && (await this.auth.hasSecretApiKey())) {
      await this.auth.clearApiKey();
      clearedSecretKey = true;
    }

    this.clearAuthProfileCache();

    try {
      await this.stop();
    } catch (err) {
      logWarn(`stop after logout: ${formatUserError(err)}`);
    }

    return { logout, clearedSecretKey };
  }

  getAuthMethods(): AuthMethodLike[] {
    return this.authMethods.slice();
  }

  private clearAuthProfileCache(): void {
    this.authInfo = undefined;
    this.authMeta = undefined;
    this._onAuthProfileChange.fire({});
  }

  private async runInteractiveBrowserLogin(): Promise<void> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new Error("No agent connection");
    }

    const methodId =
      pickInteractiveAuthMethodId(this.authMethods) ?? "grok.com";
    logInfo(`interactive login methodId=${methodId}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Grok Build: Sign in",
        cancellable: true,
      },
      async (progress, cancelToken) => {
        progress.report({ message: "Starting browser sign-in…" });

        // Concurrent with authenticate (pager PollAuthUrl + Authenticate +
        // optional submit_code for loopback paste).
        this.authAuthenticateActive = true;
        const urlPromise = this.pollOpenUrlAndMaybeSubmitCode(
          progress,
          cancelToken,
        ).catch((err) => {
          logWarn(`auth URL / submit_code path: ${formatUserError(err)}`);
        });

        try {
          if (cancelToken.isCancellationRequested) {
            throw new Error("Sign-in cancelled");
          }
          await this.connection!.agent.request(acp.methods.agent.authenticate, {
            methodId,
            _meta: {
              force_interactive: true,
              use_oauth: true,
            },
          });
        } catch (err) {
          const msg = formatUserError(err);
          logError("interactive login failed", err);
          throw new Error(msg || "Sign-in failed");
        } finally {
          this.authAuthenticateActive = false;
          // Auth finished (success or fail); don't hang on a stuck get_url.
          await Promise.race([urlPromise, sleep(1_500)]);
        }
      },
    );

    logInfo("interactive login completed");
    // Profile + gate for empty-state (parity with pager apply_auth_meta).
    await this.refreshAuthInfo();
    try {
      await this.checkSubscription();
    } catch (err) {
      logWarn(`post-login check_subscription: ${formatUserError(err)}`);
    }
  }

  /**
   * Poll `get_url`, open browser, and for loopback prompt paste → submit_code.
   */
  private async pollOpenUrlAndMaybeSubmitCode(
    progress: vscode.Progress<{ message?: string }>,
    cancelToken: vscode.CancellationToken,
  ): Promise<void> {
    // Match pager: poll until URL channel is ready.
    for (let i = 0; i < 120; i++) {
      if (cancelToken.isCancellationRequested) {
        return;
      }
      if (!this.authAuthenticateActive) {
        return;
      }
      if (i > 0) {
        await sleep(100);
      }
      if (!this.connection) {
        return;
      }
      let raw: unknown;
      try {
        raw = await this.requestExtOnConnection("x.ai/auth/get_url", {});
      } catch (err) {
        // Method may not exist on older agents — stop polling.
        logWarn(`x.ai/auth/get_url: ${formatUserError(err)}`);
        return;
      }
      const info = parseAuthUrlResponse(raw);
      if (!info.authUrl) {
        continue;
      }
      if (info.externalProvider || info.mode === "command") {
        progress.report({
          message: "External sign-in provider opened a browser…",
        });
        return;
      }
      if (!isSafeAuthUrl(info.authUrl)) {
        logWarn(`Rejected non-https auth URL: ${info.authUrl.slice(0, 32)}…`);
        return;
      }
      const deviceCode = extractUserCode(info.authUrl);
      progress.report({
        message: deviceCode
          ? `Open browser and enter code ${deviceCode}…`
          : "Opening browser for approval…",
      });
      logInfo(`Opening auth URL (mode=${info.mode ?? "?"})`);
      await vscode.env.openExternal(vscode.Uri.parse(info.authUrl));

      if (
        needsManualAuthCodePaste(info.mode, info.externalProvider) &&
        this.authAuthenticateActive
      ) {
        progress.report({
          message:
            "If the browser shows a token to paste, use the input box (or command Paste Auth Code)…",
        });
        await this.promptSubmitAuthCodeWhileLogin(progress);
      } else {
        progress.report({ message: "Waiting for approval in browser…" });
      }
      return;
    }
    progress.report({
      message: "Waiting for sign-in (check browser or Paste Auth Code)…",
    });
  }

  private async promptSubmitAuthCodeWhileLogin(
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    if (!this.authAuthenticateActive) {
      return;
    }
    const code = await vscode.window.showInputBox({
      title: "Grok Build — Auth token (loopback)",
      prompt:
        "Paste the token from the browser if shown. Leave empty to wait for automatic browser completion. You can also run “Grok Build: Paste Auth Code” later.",
      ignoreFocusOut: true,
      placeHolder: "Paste token / leave empty to skip",
    });
    if (!code?.trim()) {
      progress.report({
        message:
          "Waiting for browser… (Paste Auth Code from Command Palette if needed)",
      });
      return;
    }
    if (!this.authAuthenticateActive) {
      // Authenticate already finished — ignore late paste.
      return;
    }
    try {
      await this.submitAuthCode(code.trim());
      progress.report({ message: "Token submitted — finishing sign-in…" });
    } catch (err) {
      logWarn(`submit_code failed: ${formatUserError(err)}`);
      progress.report({
        message: `Could not submit token: ${formatUserError(err)}`,
      });
    }
  }

  private async requestExtOnConnection<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.connection) {
      throw new Error("No agent connection");
    }
    const wire = toAcpExtWireMethod(method);
    logInfo(`ext ${wire}`);
    return this.connection.agent.request<T, Record<string, unknown>>(
      wire,
      params,
    );
  }

  private requireSessionId(): string {
    const sid = this.getSessionId() ?? this.session?.sessionId;
    if (!sid) {
      throw new Error("No active session");
    }
    return sid;
  }

  /** Fire-and-forget queue mutation (TUI uses ExtNotification). */
  private async notifyQueue(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("No agent connection");
    }
    const wire = toAcpExtWireMethod(method);
    logInfo(`queue notify ${wire}`);
    try {
      await this.connection.agent.notify(wire, params);
    } catch (err) {
      // Some agents register the bare method name.
      if (wire !== method) {
        logWarn(
          `queue notify ${wire} failed, retry bare: ${formatUserError(err)}`,
        );
        await this.connection.agent.notify(method, params);
        return;
      }
      throw err;
    }
  }

  private handleQueueChangedNotification(raw: unknown): void {
    const changed = parseQueueChanged(unwrapExtParams(raw));
    if (!changed) {
      logWarn("x.ai/queue/changed: invalid payload");
      return;
    }
    // Ignore broadcasts for other sessions (multi-session future-proofing).
    const active = this.getSessionId();
    if (active && changed.sessionId && changed.sessionId !== active) {
      return;
    }
    for (const e of changed.entries) {
      if (e.text) {
        this.knownPromptTexts.set(e.id, e.text);
      }
    }
    this.queue = reconcileQueue(this.queue, changed);
    logInfo(
      `queue/changed session=${changed.sessionId} entries=${changed.entries.length} running=${changed.runningPromptId ?? "-"}`,
    );
    this._onQueueChange.fire(this.getQueue());
  }

  private resetQueueState(sessionId = ""): void {
    this.queue = emptyQueueSnapshot(sessionId);
    this.knownPromptTexts.clear();
    this._onQueueChange.fire(this.getQueue());
  }

  private fireTasksChange(): void {
    this._onTasksChange.fire(this.tasksStore.snapshot());
  }

  private resetTasksState(sessionId = ""): void {
    this.tasksStore.reset(sessionId);
    this.liveSubagents.clear();
    this.fireTasksChange();
  }

  private ensureTasksPruneTimer(): void {
    if (this.tasksPruneTimer) {
      return;
    }
    this.tasksPruneTimer = setInterval(() => {
      if (this.tasksStore.pruneFinished()) {
        this.fireTasksChange();
      }
      if (
        this.tasksStore.snapshot().items.length === 0 &&
        this.tasksPruneTimer
      ) {
        clearInterval(this.tasksPruneTimer);
        this.tasksPruneTimer = undefined;
      }
    }, 5_000);
  }

  /**
   * Refresh task + subagent lists from the agent (best-effort; old binaries may 404).
   */
  async refreshTasks(): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId || !this.connection) {
      return;
    }
    this.tasksStore.setSessionId(sessionId);
    try {
      const raw = await this.requestExtOnConnection<unknown>("x.ai/task/list", {
        sessionId,
      });
      const body = unwrapExtResult<{ tasks?: unknown[] }>(raw);
      const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
      this.tasksStore.mergeTaskList(tasks, true);
    } catch (err) {
      logWarn(`x.ai/task/list: ${formatUserError(err)}`);
    }
    try {
      const raw = await this.requestExtOnConnection<unknown>(
        "x.ai/subagent/list_running",
        { sessionId },
      );
      const body = unwrapExtResult<{ subagents?: unknown[] }>(raw);
      const subs = Array.isArray(body?.subagents) ? body.subagents : [];
      this.tasksStore.mergeSubagentList(subs);
    } catch (err) {
      logWarn(`x.ai/subagent/list_running: ${formatUserError(err)}`);
    }
    this.ensureTasksPruneTimer();
    this.fireTasksChange();
  }

  /**
   * Kill a background task, cancel a subagent, or delete a scheduled loop.
   */
  async killBackgroundWork(id: string, kind: WorkKind): Promise<void> {
    const sessionId = this.requireSessionId();
    this.tasksStore.markStopping(id);
    if (kind === "subagent") {
      this.liveSubagents.markStopping(id);
      const live = this.liveSubagents.resolve(id);
      if (live) {
        this._onLiveSubagentChange.fire(live);
      }
    }
    this.fireTasksChange();
    try {
      if (kind === "subagent") {
        const item = this.tasksStore.get(id);
        const subagentId = item?.subagentId ?? id;
        await this.requestExt("x.ai/subagent/cancel", { subagentId });
      } else if (kind === "loop") {
        await this.requestExt("x.ai/scheduler/delete", {
          sessionId,
          taskId: id,
        });
        this.tasksStore.remove(id);
      } else {
        await this.requestExt("x.ai/task/kill", {
          sessionId,
          taskId: id,
        });
      }
    } catch (err) {
      // Revert stopping state on hard failure
      const item = this.tasksStore.get(id);
      if (item?.status === "stopping") {
        this.tasksStore.upsert({
          ...item,
          status: "running",
          detail: undefined,
        });
      }
      throw err;
    } finally {
      this.fireTasksChange();
      // Reconcile with agent after a short delay (completion notify may lag).
      void this.refreshTasks().catch(() => undefined);
    }
  }

  private handleTaskExtNotification(raw: unknown): void {
    const parsed = unwrapTaskNotificationParams(raw);
    if (!parsed) {
      logWarn("task notification: invalid payload");
      return;
    }
    const active = this.getSessionId();
    if (active && parsed.sessionId && parsed.sessionId !== active) {
      return;
    }
    const changed = this.tasksStore.applyTaskNotification(
      parsed.sessionId || active || "",
      parsed.update,
    );
    if (changed) {
      this.ensureTasksPruneTimer();
      this.fireTasksChange();
    }
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
    if (this.tasksPruneTimer) {
      clearInterval(this.tasksPruneTimer);
      this.tasksPruneTimer = undefined;
    }
    await this.stopInternal();
    this.setBusy(false);
    this._onStateChange.dispose();
    this._onSessionUpdate.dispose();
    this._onBusyChange.dispose();
    this._onTurnEnd.dispose();
    this._onQueueChange.dispose();
    this._onTasksChange.dispose();
    this._onLiveSubagentChange.dispose();
    this._onAvailableCommands.dispose();
    this._onModelsChange.dispose();
    this._onModeChange.dispose();
    this._onXaiSessionEvent.dispose();
    this.authInfo = undefined;
    this.authMeta = undefined;
    this._onAuthProfileChange.dispose();
  }

  /**
   * Read model catalog from session meta (TUI source of truth at session open).
   * Full remote catalog usually arrives later via `x.ai/models/update`.
   */
  private ingestSessionModels(
    session: ActiveSession,
    extra?: { _meta?: unknown; models?: unknown; meta?: unknown },
  ): void {
    const meta = {
      ...((session.meta as Record<string, unknown> | null | undefined) ?? {}),
      ...((extra?._meta as Record<string, unknown> | null | undefined) ?? {}),
      ...((extra?.meta as Record<string, unknown> | null | undefined) ?? {}),
    };
    const nsr = session.newSessionResponse as {
      models?: unknown;
      _meta?: unknown;
    };
    // ACP TS SDK zod schema strips top-level `models` from NewSessionResponse;
    // prefer `_meta` sessionConfig, then raw models if the client keeps them.
    const legacyModels =
      extra?.models ??
      nsr?.models ??
      (nsr as { modelState?: unknown } | undefined)?.modelState;
    const parsed = parseModelsFromSessionMeta(
      Object.keys(meta).length ? meta : undefined,
      legacyModels,
    );
    this.applyCatalogSnapshot(parsed, { preferLarger: true });
  }

  /**
   * Initialize response `_meta.modelState` is the earliest catalog snapshot
   * (same field the agent puts in InitializeResponse meta).
   */
  private ingestInitializeModelState(initResult: unknown): void {
    const r = initResult as {
      _meta?: Record<string, unknown> | null;
      meta?: Record<string, unknown> | null;
    };
    const meta = r._meta ?? r.meta;
    if (!meta || typeof meta !== "object") {
      return;
    }
    const modelState = meta.modelState ?? meta.model_state;
    if (modelState) {
      const parsed = parseSessionModelState(modelState);
      this.applyCatalogSnapshot(parsed, { preferLarger: true });
      return;
    }
    // Some builds only put sessionConfig-shaped options on initialize.
    const parsed = parseModelsFromSessionMeta(meta as Record<string, unknown>);
    this.applyCatalogSnapshot(parsed, { preferLarger: true });
  }

  /**
   * Handle live catalog push from the agent (after remote /v1/models fetch).
   * Wire: `_x.ai/models/update` / `x.ai/models/update` with SessionModelState.
   */
  private handleModelsUpdateNotification(params: unknown): void {
    const parsed = parseSessionModelState(params);
    if (parsed.models.length === 0 && !parsed.currentModelId) {
      logWarn("x.ai/models/update: empty catalog payload");
      return;
    }
    // Preserve the user's current model when still available in the new catalog.
    if (
      this.currentModelId &&
      parsed.models.some((m) => m.id === this.currentModelId)
    ) {
      parsed.currentModelId = this.currentModelId;
      for (const m of parsed.models) {
        m.selected = m.id === this.currentModelId;
      }
      const cur = parsed.models.find((m) => m.id === this.currentModelId);
      if (cur?.reasoningEfforts?.length) {
        // Keep session effort if still valid; else catalog default.
        const keep =
          this.currentEffortId &&
          cur.reasoningEfforts.some((e) => e.id === this.currentEffortId)
            ? this.currentEffortId
            : cur.reasoningEffort || "";
        parsed.currentEffortId = keep;
        parsed.efforts = cur.reasoningEfforts.map((e) => ({
          ...e,
          selected: e.id === keep,
        }));
      }
    }
    this.applyCatalogSnapshot(parsed, { preferLarger: true });
    logInfo(
      `x.ai/models/update size=${this.models.length} current=${this.currentModelId}`,
    );
  }

  private applyCatalogSnapshot(
    parsed: {
      models: GrokModelOption[];
      currentModelId: string;
      efforts: GrokEffortOption[];
      currentEffortId: string;
    },
    opts?: { preferLarger?: boolean },
  ): void {
    if (parsed.models.length === 0 && !parsed.currentModelId) {
      if (this.models.length === 0) {
        const setting = getSettings().model;
        if (setting) {
          this.currentModelId = setting;
          this.models = [{ id: setting, label: setting, selected: true }];
          this.fireModelsChange();
        }
      }
      return;
    }

    // Don't shrink a richer live catalog with a stale smaller snapshot
    // (session/new often has only the default before remote fetch completes).
    if (
      opts?.preferLarger &&
      this.models.length > parsed.models.length &&
      parsed.models.length > 0 &&
      parsed.models.every((m) => this.models.some((x) => x.id === m.id))
    ) {
      // Enrich kept models with agent meta (e.g. totalContextTokens) from the
      // smaller-but-richer snapshot so the context bar does not stay at 200K.
      for (const incoming of parsed.models) {
        const existing = this.models.find((x) => x.id === incoming.id);
        if (!existing) {
          continue;
        }
        if (incoming.contextWindow != null && incoming.contextWindow > 0) {
          existing.contextWindow = incoming.contextWindow;
        }
        if (incoming.reasoningEfforts?.length) {
          existing.reasoningEfforts = incoming.reasoningEfforts;
        }
        if (incoming.supportsReasoningEffort != null) {
          existing.supportsReasoningEffort = incoming.supportsReasoningEffort;
        }
        if (incoming.reasoningEffort) {
          existing.reasoningEffort = incoming.reasoningEffort;
        }
        if (incoming.label && incoming.label !== incoming.id) {
          existing.label = incoming.label;
        }
      }
      // Still update current + efforts if provided.
      if (parsed.currentModelId) {
        this.currentModelId = parsed.currentModelId;
        for (const m of this.models) {
          m.selected = m.id === this.currentModelId;
        }
      }
      if (parsed.efforts.length > 0) {
        this.efforts = parsed.efforts;
        this.currentEffortId = parsed.currentEffortId;
      } else {
        this.syncEffortsFromCurrentModel();
      }
      this.fireModelsChange();
      return;
    }

    this.models = parsed.models;
    this.currentModelId =
      parsed.currentModelId || this.currentModelId || getSettings().model;
    for (const m of this.models) {
      m.selected = m.id === this.currentModelId;
    }
    if (parsed.efforts.length > 0) {
      this.efforts = parsed.efforts;
      this.currentEffortId = parsed.currentEffortId;
    } else {
      this.syncEffortsFromCurrentModel(parsed.currentEffortId);
    }
    this.fireModelsChange();
    logInfo(
      `models catalog size=${this.models.length} current=${this.currentModelId || "(none)"} efforts=${this.efforts.length}`,
    );
  }

  private syncEffortsFromCurrentModel(preferredEffort?: string): void {
    const cur = this.models.find((m) => m.id === this.currentModelId);
    if (!cur) {
      this.efforts = [];
      this.currentEffortId = "";
      return;
    }
    const list = cur.reasoningEfforts ?? [];
    const effortId =
      preferredEffort ||
      this.currentEffortId ||
      cur.reasoningEffort ||
      list.find((e) => e.selected)?.id ||
      "";
    this.efforts = list.map((e) => ({
      ...e,
      selected: e.id === effortId,
    }));
    this.currentEffortId = effortId;
  }

  private fireModelsChange(): void {
    this._onModelsChange.fire(this.getModels());
  }

  private setState(state: AgentState): void {
    this.state = state;
    this._onStateChange.fire(state);
  }

  private setBusy(busy: boolean): void {
    if (!busy) {
      // Never clear busy while any prompt RPC is still open.
      if (this.inFlightPrompts > 0) {
        busy = true;
      }
    }
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    this._onBusyChange.fire(busy);
  }

  private async startInternal(): Promise<void> {
    // Honor VS Code Workspace Trust — refuse to spawn the agent in restricted mode.
    if (!vscode.workspace.isTrusted) {
      const message =
        "Grok Build requires a trusted workspace to start the agent. " +
        "Use “Manage Workspace Trust” and trust this folder, then try again.";
      this.setState({ kind: "error", message });
      throw new Error(message);
    }

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

    const identity = <T>(p: T): T => p;
    const connection = acp
      .client({ name: "grok-build-community-edition" })
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
      // TUI question overlay — agent reverse-request (ExtMethod / custom method).
      .onRequest("_x.ai/ask_user_question", identity, (ctx) =>
        this.handleAskUserQuestion(ctx.params),
      )
      .onRequest("x.ai/ask_user_question", identity, (ctx) =>
        this.handleAskUserQuestion(ctx.params),
      )
      // Plan approval reverse-request (TUI plan preview overlay).
      .onRequest("_x.ai/exit_plan_mode", identity, (ctx) =>
        this.handleExitPlanMode(ctx.params),
      )
      .onRequest("x.ai/exit_plan_mode", identity, (ctx) =>
        this.handleExitPlanMode(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.onSessionUpdateNotify(ctx.params);
      })
      // Live catalog refresh after remote /v1/models fetch (TUI listens too).
      // Wire methods arrive `_`-prefixed from the leader; bare form also seen.
      .onNotification(
        "_x.ai/models/update",
        (p: unknown) => p,
        (ctx) => {
          this.handleModelsUpdateNotification(ctx.params);
        },
      )
      .onNotification(
        "x.ai/models/update",
        (p: unknown) => p,
        (ctx) => {
          this.handleModelsUpdateNotification(ctx.params);
        },
      )
      // Server-authoritative prompt queue (TUI shared queue).
      .onNotification(
        "_x.ai/queue/changed",
        (p: unknown) => p,
        (ctx) => {
          this.handleQueueChangedNotification(ctx.params);
        },
      )
      .onNotification(
        "x.ai/queue/changed",
        (p: unknown) => p,
        (ctx) => {
          this.handleQueueChangedNotification(ctx.params);
        },
      )
      // xAI session events: retry banners, compact, subagent, interactions.
      .onNotification(
        "_x.ai/session_notification",
        (p: unknown) => p,
        (ctx) => {
          this.handleXaiSessionNotification(ctx.params);
        },
      )
      .onNotification(
        "x.ai/session_notification",
        (p: unknown) => p,
        (ctx) => {
          this.handleXaiSessionNotification(ctx.params);
        },
      )
      // Background task lifecycle (Tasks panel).
      .onNotification(
        "_x.ai/task_backgrounded",
        (p: unknown) => p,
        (ctx) => {
          this.handleTaskExtNotification(ctx.params);
        },
      )
      .onNotification(
        "x.ai/task_backgrounded",
        (p: unknown) => p,
        (ctx) => {
          this.handleTaskExtNotification(ctx.params);
        },
      )
      .onNotification(
        "_x.ai/task_completed",
        (p: unknown) => p,
        (ctx) => {
          this.handleTaskExtNotification(ctx.params);
        },
      )
      .onNotification(
        "x.ai/task_completed",
        (p: unknown) => p,
        (ctx) => {
          this.handleTaskExtNotification(ctx.params);
        },
      )
      .connect(stream);

    this.connection = connection;

    logInfo("Sending initialize…");
    const clientCapabilities = buildInitializeClientCapabilities();
    logInfo(
      `clientCapabilities terminal=${clientCapabilities.terminal} meta=${JSON.stringify(clientCapabilities._meta)}`,
    );
    const initResult = await connection.agent.request<acp.InitializeResponse>(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
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
    this.authMethods = normalizeAuthMethods(initResult.authMethods);
    logInfo(
      `agent caps loadSession=${this.caps.loadSession} list=${this.caps.listSessions} resume=${this.caps.resumeSession} authMethods=${this.authMethods.map((m) => m.id).join(",") || "(none)"}`,
    );

    // Seed catalog from initialize `_meta.modelState` (TUI does the same)
    // so the model picker is not empty while session/new is in flight.
    this.ingestInitializeModelState(initResult);

    const cwd = resolveSessionCwd(settings);
    logInfo(`session/new cwd=${cwd}`);
    const session = await connection.agent.buildSession(cwd).start();
    this.session = session;
    this.permissions.resetSessionMemory();
    this.resetQueueState(session.sessionId);
    this.resetTasksState(session.sessionId);
    this.inFlightPrompts = 0;
    this.ingestSessionModels(session);
    logInfo(`session/new ok sessionId=${session.sessionId}`);

    this.setState({
      kind: "ready",
      sessionId: session.sessionId,
      protocolVersion: initResult.protocolVersion,
      binary: spawned.binary,
      version: spawned.version,
    });

    // Align host UI + agent runtime with CLI config (TUI load_permission_mode).
    await this.applyPermissionModeFromDisk();
    this.ingestSessionModes(session);

    // Profile + subscription gate for empty-state (best-effort; non-blocking).
    void this.refreshAuthInfo()
      .then(() => this.checkSubscription())
      .catch((err) => logWarn(`startup auth profile: ${formatUserError(err)}`));

    // Seed Tasks panel from live registries (best-effort).
    void this.refreshTasks().catch((err) =>
      logWarn(`startup tasks refresh: ${formatUserError(err)}`),
    );

    void this.pumpSessionUpdates(session);
  }

  /**
   * Handle agent `x.ai/ask_user_question` (TUI question view).
   * Params may be the typed payload or wrapped ExtRequest `{ method, params }`.
   */
  private async handleAskUserQuestion(
    raw: unknown,
  ): Promise<AskUserQuestionResponse> {
    const unwrapped = unwrapExtParams(raw);
    const parsed = parseAskUserQuestionRequest(unwrapped);
    if (!parsed) {
      logWarn("ask_user_question: invalid params → cancelled");
      return { outcome: "cancelled" };
    }
    logInfo(
      `[question] tool=${parsed.toolCallId || "?"} mode=${parsed.mode} n=${parsed.questions.length}`,
    );

    const promptId = this.nextQuestionPromptId++;
    const timeoutMs = getSettings().permissionTimeoutMs;
    if (this.questionUi) {
      try {
        return await this.questionUi({
          promptId,
          toolCallId: parsed.toolCallId,
          mode: parsed.mode,
          questions: parsed.questions,
          timeoutMs,
        });
      } catch (err) {
        logWarn(`ask_user_question webview failed: ${formatUserError(err)}`);
      }
    } else {
      logWarn("ask_user_question: chat popover UI not registered");
    }
    void vscode.window.showWarningMessage(
      "Grok Build: open the chat panel to answer the agent question",
    );
    return { outcome: "cancelled" };
  }

  /**
   * Handle agent `x.ai/exit_plan_mode` — user must approve, request changes,
   * or abandon (TUI plan approval overlay). Never auto-approve (even yolo).
   */
  private async handleExitPlanMode(
    raw: unknown,
  ): Promise<ExitPlanModeResponse> {
    const parsed = parseExitPlanModeRequest(raw);
    if (!parsed) {
      logWarn("exit_plan_mode: invalid params → abandoned");
      return exitPlanModeResponse("abandoned");
    }
    const planContent = parsed.planContent?.trim() ?? "";
    const hasPlan = planContent.length > 0;
    logInfo(
      `[exit_plan_mode] tool=${parsed.toolCallId} hasPlan=${hasPlan} session=${parsed.sessionId}`,
    );

    // Only answer for the active session; park silently otherwise (TUI parity).
    const active = this.getSessionId();
    if (active && parsed.sessionId && parsed.sessionId !== active) {
      logInfo(
        `exit_plan_mode for background session ${parsed.sessionId}; leaving unanswered for leader replay`,
      );
      // Leaving the reverse-request hanging is not possible with the TS SDK
      // (we must return). Abandon so the tool does not hang forever.
      return exitPlanModeResponse("abandoned");
    }

    const promptId = this.nextPlanPromptId++;
    const timeoutMs = Math.max(getSettings().permissionTimeoutMs, 120_000);
    if (this.planApprovalUi) {
      try {
        return await this.planApprovalUi({
          promptId,
          sessionId: parsed.sessionId,
          toolCallId: parsed.toolCallId,
          planContent: planContent || EMPTY_PLAN_PLACEHOLDER,
          hasPlan,
          timeoutMs,
        });
      } catch (err) {
        logWarn(`exit_plan_mode UI failed: ${formatUserError(err)}`);
      }
    } else {
      logWarn("exit_plan_mode: plan approval UI not registered");
    }
    // Fallback QuickPick if chat UI missing.
    return this.fallbackExitPlanModePick(
      hasPlan,
      planContent || EMPTY_PLAN_PLACEHOLDER,
    );
  }

  private async fallbackExitPlanModePick(
    hasPlan: boolean,
    planContent: string,
  ): Promise<ExitPlanModeResponse> {
    const preview = planContent.slice(0, 400);
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(check) Approve",
          description: "Leave plan mode and implement",
          outcome: "approved" as const,
        },
        {
          label: "$(edit) Request changes",
          description: "Send feedback and stay in plan mode",
          outcome: "cancelled" as const,
        },
        {
          label: "$(x) Abandon",
          description: "Discard plan and exit plan mode",
          outcome: "abandoned" as const,
        },
      ],
      {
        title: hasPlan
          ? "Plan ready — approve to implement"
          : "No plan written — approve or request changes",
        placeHolder: preview.split("\n")[0] || "Plan approval",
        ignoreFocusOut: true,
      },
    );
    if (!pick) {
      return exitPlanModeResponse("abandoned");
    }
    if (pick.outcome === "cancelled") {
      const feedback = await vscode.window.showInputBox({
        title: "Request plan changes",
        prompt: "What should the agent change in the plan?",
        ignoreFocusOut: true,
      });
      if (feedback === undefined) {
        return exitPlanModeResponse("abandoned");
      }
      return exitPlanModeResponse("cancelled", feedback);
    }
    return exitPlanModeResponse(pick.outcome);
  }

  private handleXaiSessionNotification(raw: unknown): void {
    const parsed = parseXaiSessionNotification(raw);
    if (!parsed) {
      // Some task/schedule updates may only arrive as session_notification.
      this.handleTaskExtNotification(raw);
      logWarn("x.ai/session_notification: invalid payload");
      return;
    }
    const active = this.getSessionId();
    if (active && parsed.sessionId && parsed.sessionId !== active) {
      // Still log; child/other sessions may matter later.
      logInfo(
        `session_notification other session=${parsed.sessionId} (active=${active})`,
      );
    }
    let tasksChanged = false;
    for (const ev of parsed.events) {
      const banner = bannerTextForEvent(ev);
      if (banner) {
        logInfo(
          `[session_notification] ${ev.kind}/${"phase" in ev ? ev.phase : "?"} ${banner}`,
        );
      } else if (ev.kind !== "unknown") {
        logInfo(
          `[session_notification] ${ev.kind}/${"phase" in ev ? ev.phase : "?"}`,
        );
      }
      if (ev.kind === "subagent") {
        if (this.tasksStore.applySubagentEvent(ev)) {
          tasksChanged = true;
        }
        // Register / finish live child streams (TUI subagent_views).
        if (ev.phase === "spawned") {
          const child = ev.childSessionId || ev.subagentId || "";
          const sub = ev.subagentId || child;
          if (child) {
            const stream = this.liveSubagents.register({
              subagentId: sub,
              childSessionId: child,
              subagentType: ev.subagentType,
              description: ev.description,
            });
            this.liveSubagents.ensureStarted(child);
            this._onLiveSubagentChange.fire(stream);
          }
        } else if (ev.phase === "progress") {
          const stream = this.liveSubagents.resolve(
            ev.subagentId || ev.childSessionId || "",
          );
          if (stream && ev.message) {
            // Keep progress text as soft activity when no tool is active.
            if (
              !stream.activity ||
              stream.activity === "Thinking…" ||
              stream.activity === "Responding…" ||
              stream.activity.startsWith("Subagent")
            ) {
              stream.activity = ev.message;
              stream.generation += 1;
              this._onLiveSubagentChange.fire(stream);
            }
          }
        } else if (ev.phase === "finished") {
          const st = (ev.status ?? "completed").toLowerCase();
          const status =
            st === "failed"
              ? ("failed" as const)
              : st === "cancelled"
                ? ("cancelled" as const)
                : ("done" as const);
          const stream = this.liveSubagents.finish(
            ev.subagentId || ev.childSessionId || "",
            status,
            ev.message,
          );
          if (stream) {
            this._onLiveSubagentChange.fire(stream);
          }
        }
      }
    }
    // scheduled_task_* may be parsed as unknown — try task store on raw update.
    const taskParsed = unwrapTaskNotificationParams(raw);
    if (taskParsed) {
      if (
        this.tasksStore.applyTaskNotification(
          taskParsed.sessionId || parsed.sessionId,
          taskParsed.update,
        )
      ) {
        tasksChanged = true;
      }
    }
    if (tasksChanged) {
      this.ensureTasksPruneTimer();
      this.fireTasksChange();
    }
    this._onXaiSessionEvent.fire(parsed);
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
    this.captureAvailableCommands(params);
    this.captureConfigOptionUpdate(params);
    // Child subagent streams: merge here so ChatView never pollutes parent chat.
    const sid =
      typeof params.sessionId === "string"
        ? params.sessionId
        : String(params.sessionId ?? "");
    const parent = this.getSessionId();
    if (
      sid &&
      parent &&
      sid !== parent &&
      this.liveSubagents.isChildSession(sid)
    ) {
      this.applySubagentSessionUpdate(params);
      this.logUpdate(params);
      return;
    }
    // Race: child updates can arrive slightly before subagent_spawned is applied.
    // If session is unknown and not parent, try soft-register from nothing — skip.
    if (sid && parent && sid !== parent) {
      // Tentatively hold as live if we know the id from tasks store.
      const task = this.tasksStore.get(sid);
      if (task?.kind === "subagent") {
        this.liveSubagents.register({
          subagentId: task.subagentId || sid,
          childSessionId: task.childSessionId || sid,
          subagentType: task.tag,
          description: task.label,
        });
        this.applySubagentSessionUpdate(params);
        this.logUpdate(params);
        return;
      }
      logInfo(
        `session/update for non-parent session=${sid} (ignored for chat)`,
      );
      this.logUpdate(params);
      return;
    }
    this._onSessionUpdate.fire(params);
    this.logUpdate(params);
  }

  private captureAvailableCommands(params: SessionNotification): void {
    const update = params.update as {
      sessionUpdate?: string;
      availableCommands?: AvailableCommand[];
    };
    if (update.sessionUpdate !== "available_commands_update") {
      return;
    }
    const list = update.availableCommands ?? [];
    this.availableCommands = list;
    this._onAvailableCommands.fire(list);
    logInfo(`available_commands_update count=${list.length}`);
  }

  /** ACP standard config_option_update (if agent sends it). */
  private captureConfigOptionUpdate(params: SessionNotification): void {
    const update = params.update as {
      sessionUpdate?: string;
      configOptions?: Array<{
        id?: string;
        category?: string;
        name?: string;
        type?: string;
        currentValue?: string | boolean;
        options?: unknown;
      }>;
    };
    if (update.sessionUpdate !== "config_option_update") {
      return;
    }
    // Grok primarily uses custom sessionConfig shape; best-effort map.
    const opts = update.configOptions ?? [];
    const asSessionConfig = {
      options: opts.flatMap((o) => {
        if (o.category === "model" && o.type === "select") {
          const select = o as {
            currentValue?: string;
            options?: Array<
              | { value?: string; name?: string }
              | {
                  group?: string;
                  options?: Array<{ value?: string; name?: string }>;
                }
            >;
          };
          const rows: Array<{
            id: string;
            category: string;
            label: string;
            selected: boolean;
          }> = [];
          const pushOpt = (value?: string, name?: string) => {
            if (!value) {
              return;
            }
            rows.push({
              id: value,
              category: "model",
              label: name || value,
              selected: value === select.currentValue,
            });
          };
          for (const item of select.options ?? []) {
            if ("group" in item && item.options) {
              for (const sub of item.options) {
                pushOpt(sub.value, sub.name);
              }
            } else if ("value" in item) {
              pushOpt(item.value, item.name);
            }
          }
          return rows;
        }
        return [];
      }),
    };
    if (asSessionConfig.options.length === 0) {
      return;
    }
    const parsed = parseModelsFromSessionMeta({
      "x.ai/sessionConfig": asSessionConfig,
    });
    this.applyCatalogSnapshot(parsed, { preferLarger: true });
  }

  private logUpdate(params: SessionNotification): void {
    const update = params.update;
    const kind = update.sessionUpdate;
    const meta = params._meta as
      | { totalTokens?: number | string }
      | null
      | undefined;
    const tok = meta?.totalTokens != null ? ` tokens=${meta.totalTokens}` : "";

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
          `[tool_call] ${update.title ?? update.toolCallId} status=${update.status ?? "?"}${tok}`,
        );
        break;
      }
      case "tool_call_update": {
        logSessionUpdate(
          `[tool_call_update] ${update.toolCallId} status=${update.status ?? "?"}${tok}`,
        );
        break;
      }
      case "available_commands_update": {
        const u = update as { availableCommands?: AvailableCommand[] };
        logSessionUpdate(
          `[available_commands_update] ${(u.availableCommands ?? []).length} commands`,
        );
        break;
      }
      case "usage_update": {
        logSessionUpdate(
          `[usage_update] used=${(update as { used?: number }).used} size=${(update as { size?: number }).size}${tok}`,
        );
        break;
      }
      case "current_mode_update": {
        const u = update as { currentModeId?: string };
        const mid = u.currentModeId ? String(u.currentModeId) : "";
        logSessionUpdate(`[current_mode_update] modeId=${mid}`);
        if (mid) {
          this.acpModeId = mid;
          if (mid === "plan") {
            this.cycleModeId = "plan";
            this.autoMode = false;
            this.permissions.setAlwaysApproveOverride(false);
          } else if (
            this.cycleModeId === "always-approve" ||
            this.cycleModeId === "auto"
          ) {
            // Permission arms keep ACP on "default"; don't clobber UI.
          } else {
            this.cycleModeId = cycleModeFromAgent(mid, {
              yolo: this.permissions.isAlwaysApprove(),
              auto: this.autoMode,
            });
          }
          this.fireModeChange();
        }
        break;
      }
      default:
        if (tok) {
          logSessionUpdate(`[${kind}]${tok}`);
        }
        break;
    }
  }

  private async stopInternal(): Promise<void> {
    this.authMethods = [];
    // Drop live profile; next ensureStarted re-fetches. Do not fire UI events
    // here if already disposing — logout path clears explicitly with fire.
    if (!this.disposed) {
      this.clearAuthProfileCache();
    } else {
      this.authInfo = undefined;
      this.authMeta = undefined;
    }
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

function summaryWireToGrokSession(s: GrokSummaryWire): GrokSession | undefined {
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

/**
 * Ext methods may arrive as the typed payload or nested
 * `{ method, params }` / `{ request: { params } }` depending on SDK path.
 */
function unwrapExtParams(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  const o = raw as Record<string, unknown>;
  // Already a question payload
  if (o.questions != null || o.sessionId != null || o.session_id != null) {
    return raw;
  }
  if (o.params != null && typeof o.params === "object") {
    return o.params;
  }
  if (o.request != null && typeof o.request === "object") {
    const req = o.request as Record<string, unknown>;
    if (req.params != null) {
      return req.params;
    }
    return req;
  }
  return raw;
}

function normalizePromptBlocks(
  content: string | ContentBlock[],
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
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

/** Placeholder when agent exits plan mode with empty plan.md (TUI parity). */
const EMPTY_PLAN_PLACEHOLDER = `# No plan written yet

The agent exited plan mode without writing a plan.

- **Approve** — leave plan mode and start implementing
- **Request changes** — send the agent back to planning
- **Abandon** — turn plan mode off
`;

function normalizeAuthMethods(raw: unknown): AuthMethodLike[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AuthMethodLike[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : undefined;
    if (!id) {
      continue;
    }
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : undefined,
      description:
        typeof o.description === "string" ? o.description : undefined,
      type: typeof o.type === "string" ? o.type : undefined,
      _meta:
        o._meta && typeof o._meta === "object"
          ? (o._meta as AuthMethodLike["_meta"])
          : undefined,
    });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
