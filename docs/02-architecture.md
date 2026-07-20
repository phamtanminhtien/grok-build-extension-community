# 02 — Architecture

## High-level diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code window                           │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Commands /     │  │ Chat Webview    │  │ Diff / Extensions│  │
│  │ Status bar     │  │ (UI)            │  │ / QuickPick      │  │
│  └───────┬────────┘  └────────┬────────┘  └────────┬─────────┘  │
│          │                    │                    │            │
│          └────────────────────┼────────────────────┘            │
│                               ▼                                 │
│                    ┌────────────────────┐                       │
│                    │  Extension Host    │                       │
│                    │  (Node / TS)       │                       │
│                    │                    │                       │
│                    │  AgentService      │                       │
│                    │  ProcessManager    │                       │
│                    │  Host FS / Perms   │                       │
│                    │  Session / Diff /  │                       │
│                    │  Tasks / Auth      │                       │
│                    └─────────┬──────────┘                       │
└──────────────────────────────┼──────────────────────────────────┘
                               │ stdin / stdout
                               │ newline-delimited JSON-RPC (ACP)
                               ▼
                    ┌────────────────────┐
                    │  grok agent stdio  │
                    │  (Rust binary)     │
                    │                    │
                    │  shell · tools ·   │
                    │  MCP · workspace · │
                    │  auth · sessions   │
                    └────────────────────┘
```

## Design principles

1. **Single long-lived agent process per workspace window** (default).  
   Multiple workspaces may each own a process. Multi-root: `grok.cwd` or first
   folder ([ADR-008](10-decisions.md)).

2. **Extension is a protocol client, not an agent.**  
   No tool execution in TS except **host capabilities** the protocol requires
   the client to implement (FS today; terminal deferred).

3. **UI is disposable; protocol state lives in the agent.**  
   Webview can reload; session id + agent process survive when possible.
   Local session index under `~/.grok/sessions` supplements resume UX.

4. **Fail closed on permissions.**  
   Timeout → deny ([ADR-007](10-decisions.md)).

5. **Share `~/.grok` with the CLI** for auth, config, skills, sessions.

## Extension module map (as implemented)

```
src/
  extension.ts                 # activate / deactivate, command registration
  agent/
    processManager.ts          # spawn, env, crash/restart
    binaryResolver.ts          # PATH / setting / ~/.grok/bin
    agentService.ts            # ACP lifecycle, session, prompt, caps
    clientCapabilities.ts      # initialize.clientCapabilities (+ _meta)
    hostFs.ts                  # fs/read_text_file, fs/write_text_file
    permissionBroker.ts        # tool permission UI bridge
    promptQueue.ts             # mid-turn queue (x.ai/queue/*)
    rewind.ts                  # x.ai/rewind/*
    sessionAdmin.ts            # compact / session admin
    tasksStore.ts              # background tasks / monitors
    subagentLiveStore.ts       # live subagent streams
    subagentTranscript.ts      # subagent transcript helpers
    exitPlanMode.ts            # plan approval / exit plan mode
    xaiSessionNotification.ts  # session_notification banners
    acpExtMethod.ts            # x.ai/* method helpers
    missingCliPrompt.ts        # CLI install empty-state
    cliInstallInfo.ts
  auth/
    authService.ts             # SecretStorage API key, auth.json watch
    authFlow.ts                # browser OAuth / submit_code
  config/
    settings.ts                # vscode.workspace.getConfiguration("grok")
    tomlConfig.ts              # ~/.grok/config.toml read/write
    modelService.ts            # model list + picker + restart
    modelsConfig.ts / modelCatalog.ts
    permissionMode.ts / alwaysApprove.ts
  context/
    editorContext.ts           # auto-attach file/selection + chips
    contextPicker.ts / atContext.ts
    promptImages.ts            # image blocks for prompts
    fixWithGrok.ts + provider  # diagnostics Quick Fix
    fuzzyScore.ts
  diff/
    snapshotStore.ts
    snapshotContentProvider.ts # grok-diff: scheme
    diffReviewService.ts
    hunkTracker.ts             # Accept/Reject
  session/
    grokSession.ts             # session helpers
    diskSessions.ts            # ~/.grok/sessions index
    sessionPicker.ts           # resume UI
  slash/
    registry.ts / dispatch.ts / hostCommands.ts / detect.ts
  extensions/
    extensionsPanel.ts         # hooks, plugins, skills, MCP UI
    actions.ts / rows.ts / tabs.ts / extensionsData.ts
  ui/
    chatViewProvider.ts        # primary webview host
    markdown.ts                # sanitize + render
    messageVirtualList.ts
    statusBar.ts
    interactivePrompt.ts
    sessionModeCycle.ts
    sessionMessageMerge.ts
    turnStatusFormat.ts
    sessionNotificationMeta.ts
  log/
    output.ts                  # Output channel "Grok Build"
media/
  chat/                        # chat.css, chat.js (webview assets)
```

## Process model

### Lifecycle

| Event                   | Behavior                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| Extension activate      | Lazy: do **not** spawn until first chat open or explicit command     |
| First use               | Resolve binary → spawn `grok agent stdio` → `initialize` → ready     |
| `session/new`           | On first prompt or panel open                                        |
| Agent crash             | Surface error; offer Restart; preserve last session id if reloadable |
| Workspace folder change | Prefer restart agent with new `cwd` (safer than mid-flight switch)   |
| Extension deactivate    | Cancel in-flight turns; dispose process (SIGTERM → SIGKILL grace)    |

### Stdio contract (critical)

From upstream `xai-acp-lib` stdin reader notes:

- Transport is **persistent bidirectional** newline-delimited JSON-RPC.
- Client **must keep stdin open** for the whole session.
- Do not use interactive prompts on the agent process stdio.
- Prefer the official `@agentclientprotocol/sdk` over hand-rolled framing.

### Concurrency

- Concurrent `session/prompt` while a turn is running (server-side prompt
  queue). UI shows the shared queue from `x.ai/queue/changed` with remove /
  reorder / clear / edit / send-now (`x.ai/queue/*`). Idle: one live turn;
  mid-turn Enter enqueues.
- Host capability handlers must be re-entrant-safe (agent may call FS while
  a tool is running).

## Data flow: one user turn

```
1. User submits text (+ optional editor context / images / sticky chips)
2. ChatViewProvider → AgentService.prompt(blocks)
3. ACP client → session/prompt
4. Agent streams session/update notifications:
     - agent_message_chunk / agent_thought_chunk
     - tool_call / tool_call_update
     - plan (optional)
5. Possibly: agent → client request permission / fs
6. Host handles request via VS Code APIs → responds on ACP
7. Turn completes → UI idle; session id remains
```

## State ownership

| State                               | Owner                                           |
| ----------------------------------- | ----------------------------------------------- |
| Conversation content / tool history | Agent session store                             |
| Open session id(s)                  | Extension `AgentService` (cache)                |
| Local session list                  | `diskSessions` + Memento as needed              |
| Webview scroll / draft input        | Extension UI (ephemeral)                        |
| Auth tokens                         | `~/.grok` / env (agent) + SecretStorage API key |
| Model / effort / permission mode    | `~/.grok/config.toml`                           |
| Host settings                       | VS Code `settings.json` (`grok.*`)              |
| In-memory permission “always allow” | Extension (session-scoped)                      |
| Diff review queue / snapshots       | `DiffReviewService`                             |
| Background tasks / subagents        | `tasksStore` / `subagentLiveStore`              |

## Multi-window / multi-workspace

| Scenario                               | Policy (default)                                  |
| -------------------------------------- | ------------------------------------------------- |
| Two VS Code windows, different folders | Two agent processes                               |
| Same folder two windows                | Two processes (simpler; accept dual sessions)     |
| Multi-root workspace                   | `cwd` = `grok.cwd` or first `workspaceFolders[0]` |

## Logging & diagnostics

- Extension output channel: **Grok Build**.
- Levels: info (lifecycle), debug (RPC method names, not full payloads by
  default), error (spawn failures, protocol errors).
- Redact secrets (API keys, auth headers) before logging.
- Agent may write its own logs under `~/.grok`; do not scrape by default.

## Dependencies (actual)

| Package                    | Use                                              |
| -------------------------- | ------------------------------------------------ |
| `@agentclientprotocol/sdk` | ACP client                                       |
| `marked`                   | Markdown → HTML (host-side sanitize for webview) |
| `zod`                      | Runtime validation where needed                  |
| `@tabler/icons-webfont`    | Chat icons                                       |
| `vscode`                   | Extension API (types only at compile)            |

Avoid bundling a second HTTP client to xAI APIs — the agent owns that.

## Next

→ [03 — ACP Integration](03-acp-integration.md)
