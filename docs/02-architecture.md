# 02 — Architecture

## High-level diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code window                           │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Commands /     │  │ Chat Webview    │  │ Diff / Terminal  │  │
│  │ Status bar     │  │ (UI)            │  │ / QuickPick      │  │
│  └───────┬────────┘  └────────┬────────┘  └────────┬─────────┘  │
│          │                    │                    │            │
│          └────────────────────┼────────────────────┘            │
│                               ▼                                 │
│                    ┌────────────────────┐                       │
│                    │  Extension Host    │                       │
│                    │  (Node / TS)       │                       │
│                    │                    │                       │
│                    │  AgentProcess      │                       │
│                    │  AcpClient         │                       │
│                    │  HostCapabilities  │                       │
│                    │  SessionStore      │                       │
│                    │  PermissionBroker  │                       │
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

1. **Single long-lived agent process per workspace** (default).  
   Multiple workspaces may each own a process. Multi-root: use primary folder
   or prompt once (see open questions in [10-decisions](10-decisions.md)).

2. **Extension is a protocol client, not an agent.**  
   No tool execution in TS except **host capabilities** the protocol requires
   the client to implement (FS/terminal callbacks).

3. **UI is disposable; protocol state lives in the agent.**  
   Webview can reload; session id + agent process survive when possible.

4. **Fail closed on permissions.**  
   If the user does not answer a permission request, the agent path should
   cancel/deny rather than hang forever (timeout policy in security doc).

5. **Share `~/.grok` with the CLI** for auth, config, skills, sessions.

## Extension module map (target)

```
src/
  extension.ts              # activate / deactivate, command registration
  agent/
    processManager.ts       # spawn, env, crash/restart, version check
    acpClient.ts            # JSON-RPC request/response + notifications
    sessionManager.ts       # session/new, load, resume, cancel
    capabilities/
      fs.ts                 # fs/read_text_file, fs/write_text_file
      terminal.ts           # terminal create/output/kill (ACP client side)
  ui/
    chatPanel.ts            # webview provider
    messageRenderer.ts      # map session/update → UI model
    permissionUi.ts         # modal / quickpick for tool approval
    diffPresenter.ts        # show agent edits
    statusBar.ts
  context/
    editorContext.ts        # active file, selection → ContentBlock / ResourceLink
    workspaceContext.ts     # cwd, multi-root
  config/
    settings.ts             # vscode.workspace.getConfiguration("grok")
    binaryResolver.ts       # PATH / setting / bundled
  auth/
    authService.ts          # detect existing auth, API key, open browser
  telemetry/                # optional; pass-through or none in MVP
```

## Process model

### Lifecycle

| Event | Behavior |
|-------|----------|
| Extension activate | Lazy: do **not** spawn until first chat open or explicit command |
| First use | Resolve binary → spawn `grok agent stdio` → `initialize` → ready |
| `session/new` | On first prompt or panel open (configurable) |
| Agent crash | Surface error; offer Restart; preserve last session id if reloadable |
| Workspace folder change | Prefer restart agent with new `cwd` (safer than mid-flight switch) |
| Extension deactivate | Cancel in-flight turns; dispose process (SIGTERM → SIGKILL grace) |

### Stdio contract (critical)

From upstream `xai-acp-lib` stdin reader notes:

- Transport is **persistent bidirectional** newline-delimited JSON-RPC.
- Client **must keep stdin open** for the whole session.
- Do not use interactive prompts on the agent process stdio.
- Prefer the official `@agentclientprotocol/sdk` over hand-rolled framing
  (framing edge cases: large messages, escape normalization).

### Concurrency

- Concurrent `session/prompt` while a turn is running (Grok server-side prompt
  queue). UI shows the shared queue from `x.ai/queue/changed` with remove /
  reorder / clear / edit / send-now (`x.ai/queue/*`). Idle: one live turn at a
  time; mid-turn Enter enqueues (MVP previously disabled send while
  turn in progress, or call cancel then send).
- Host capability handlers must be re-entrant-safe (agent may call FS while
  a tool is running).

## Data flow: one user turn

```
1. User submits text (+ optional editor context)
2. ChatPanel → SessionManager.prompt(blocks)
3. AcpClient → session/prompt
4. Agent streams session/update notifications:
     - agent_message_chunk / agent_thought_chunk
     - tool_call / tool_call_update
     - plan (optional)
5. Possibly: agent → client request permission / fs / terminal
6. Host handles request via VS Code APIs → responds on ACP
7. Turn completes → UI idle; session id remains
```

## State ownership

| State | Owner |
|-------|-------|
| Conversation content / tool history | Agent session store |
| Open session id(s) | Extension `SessionManager` (cache) |
| Webview scroll / draft input | Extension UI (ephemeral) |
| Auth tokens | `~/.grok` / env (agent) |
| User settings | VS Code `settings.json` + optional `~/.grok` |
| In-memory permission “always allow” | Extension (session-scoped) |

## Multi-window / multi-workspace

| Scenario | Policy (default) |
|----------|------------------|
| Two VS Code windows, different folders | Two agent processes |
| Same folder two windows | Two processes (simpler; accept dual sessions) |
| Multi-root workspace | `cwd` = first folder or `grok.cwd` setting |

## Logging & diagnostics

- Extension output channel: `Grok`.
- Levels: info (lifecycle), debug (RPC method names, not full payloads by
  default), error (spawn failures, protocol errors).
- Optional: redact secrets (API keys, auth headers) before logging.
- Agent may write its own logs under `~/.grok`; do not scrape by default.

## Dependencies (planned)

| Package | Use |
|---------|-----|
| `@agentclientprotocol/sdk` | ACP client |
| `vscode` | Extension API |
| (optional) `zod` | Runtime validation of settings / messages |

Avoid bundling a second HTTP client to xAI APIs — the agent owns that.

## Next

→ [03 — ACP Integration](03-acp-integration.md)
