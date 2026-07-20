# 03 — ACP Integration

## Protocol

- Spec: [Agent Client Protocol](https://agentclientprotocol.com)
- Transport: **stdio**, newline-delimited JSON-RPC 2.0
- Agent command:

```bash
grok agent [global-options] stdio
```

Common global options (before `stdio`):

| Flag                          | Purpose                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `-m, --model <MODEL>`         | Model id (e.g. `grok-build`)                                                   |
| `--always-approve` / `--yolo` | Auto-approve tools (from config.toml `permission_mode`, not a VS Code setting) |
| `--reauth`                    | Force auth before start                                                        |
| `--agent-profile <PATH>`      | Load profile file                                                              |

Extension should prefer **settings-driven** args built by `ProcessManager`,
not free-form user shell strings (injection risk).

## Official SDK

Use TypeScript SDK:

```text
@agentclientprotocol/sdk
```

Hand-rolled clients are acceptable only for prototypes; production path uses
the SDK for framing, typed methods, and request correlation.

## Session lifecycle

```
┌──────────┐   initialize    ┌──────────┐
│  Spawn   │ ──────────────► │  Ready   │
└──────────┘                 └────┬─────┘
                                  │ session/new  (or session/load)
                                  ▼
                            ┌──────────┐
                            │ Session  │◄── session/prompt (many)
                            │  Active  │─── session/update (stream)
                            └────┬─────┘
                                  │ session/cancel (optional)
                                  │ process exit / deactivate
                                  ▼
                            ┌──────────┐
                            │ Stopped  │
                            └──────────┘
```

### 1. `initialize`

Client sends protocol version and **clientCapabilities**.

As implemented (`src/agent/clientCapabilities.ts`):

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": {
      "readTextFile": true,
      "writeTextFile": true
    },
    "terminal": false,
    "_meta": {
      "x.ai/incrementalBashOutput": true,
      "x.ai/hunkTracker": { "mode": "agent_only" },
      "x.ai/bashOutputNoColor": true,
      "x.ai/gitHeadChanged": true
    }
  }
}
```

`terminal: false` is intentional ([ADR-004](10-decisions.md)): agent-owned
shell tools; no host PTY.

Agent responds with server capabilities, auth methods, and available
extension methods (discover; do not hard-code an exhaustive list).

### 2. `session/new`

```json
{
  "cwd": "/absolute/path/to/workspace",
  "mcpServers": []
}
```

Optional `_meta` (from upstream docs):

| Field                  | Use in extension                                         |
| ---------------------- | -------------------------------------------------------- |
| `rules`                | Append workspace/user rules if not already via AGENTS.md |
| `systemPromptOverride` | Generally **avoid** in product UI                        |
| `agentProfile`         | Power-user setting                                       |

**cwd rules:**

- Prefer single-folder workspace root.
- Absolute path required.
- Multi-root: see [10-decisions](10-decisions.md).

### 3. `session/prompt`

Prompt is an array of **content blocks**:

| Block type      | Extension use                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `text`          | User message                                                                                             |
| `resource_link` | File paths, with optional editor `_meta` (selection, etc.)                                               |
| `resource`      | Embedded resource content when needed                                                                    |
| `image`         | Pasted / dropped / Attach Image… (base64 + mimeType + optional uri + `_meta.xai.dev/imageDisplayNumber`) |

Active editor context (recommended MVP shape):

1. User text as `text` block.
2. Optional `resource_link` for active file URI.
3. Optional selection meta if the agent/parser supports editor meta
   (upstream `prompt_parser` already interprets editor meta on links).

### 4. `session/update` (notifications)

| `sessionUpdate`       | UI mapping                                    |
| --------------------- | --------------------------------------------- |
| `agent_message_chunk` | Append assistant markdown                     |
| `agent_thought_chunk` | Collapsible “Thinking” region                 |
| `tool_call`           | Tool card: title, kind, status, input summary |
| `tool_call_update`    | Update status / result / output tail          |
| `plan`                | Plan checklist / approval UI                  |

UI must tolerate unknown update types (forward-compatible).

### 5. Cancel

When user clicks Stop:

- Call ACP cancel for the current turn if supported.
- If not supported by negotiated capabilities, document fallback
  (restart process as last resort — avoid unless necessary).

## Permission requests

When the agent needs approval for a tool:

1. Agent sends a permission request (ACP permission API).
2. Extension shows UI ([05-ui-ux](05-ui-ux.md)).
3. Client responds allow / deny (and optional always-for-session).

MVP maps:

| User choice                 | Response                                                |
| --------------------------- | ------------------------------------------------------- |
| Allow once                  | allow                                                   |
| Deny                        | deny                                                    |
| Always allow (session)      | allow + remember matcher in extension memory            |
| Always allow (setting yolo) | spawn with `--always-approve` **or** auto-respond allow |

Prefer **in-protocol** auto-respond over `--yolo` when possible so the UI can
still show what ran.

## SpaceXAI extension methods (`x.ai/*`)

Upstream documents categories (non-exhaustive):

| Prefix                        | Examples                     | Status in extension (0.3.8)                      |
| ----------------------------- | ---------------------------- | ------------------------------------------------ |
| `x.ai/fs/*`                   | list, exists, read, write    | Prefer client FS caps; agent may still use tools |
| `x.ai/git/*`                  | status, stage, commit, diffs | Agent tools; no dedicated host UI yet            |
| `x.ai/git/worktree/*`         | create, apply, list          | **Not wired** (L3 remaining)                     |
| `x.ai/search/*`               | fuzzy open/change, content   | **Not wired** as ACP bridge                      |
| `x.ai/terminal/*`             | create, kill, output         | **Off** — `terminal: false` (ADR-004)            |
| `x.ai/session/*`              | admin, compact-related       | Partial (session admin / compact)                |
| `x.ai/auth/*`                 | get_url, submit_code, info…  | **Shipped**                                      |
| `x.ai/rewind/*`               | points, execute              | **Shipped**                                      |
| `x.ai/queue/*`                | changed, remove, reorder…    | **Shipped**                                      |
| `x.ai/hunkTracker` / git head | via client `_meta`           | **Shipped** (Accept/Reject on diffs)             |
| task / subagent methods       | list, kill, get transcript   | **Shipped** (Tasks panel)                        |
| feedback / telemetry          | optional                     | Not used by extension                            |

**Rule:** Core chat must work with **base ACP only**. Extension methods are
progressive enhancement after capability discovery from `initialize`.

### Notifications agent → client

| Notification                | Host action                              |
| --------------------------- | ---------------------------------------- |
| `x.ai/fs_notify`            | Optional refresh explorer / diagnostics  |
| `x.ai/fs/index` / `delta`   | Optional fuzzy index (L2)                |
| `x.ai/git/worktree/status`  | Progress UI (L3)                         |
| `x.ai/session_notification` | Diff review, retry, auto-compact banners |
| `session/update`            | Primary chat stream                      |

Unknown notifications: log at debug, ignore.

## Error handling

| Failure              | User-visible                           | Recovery                            |
| -------------------- | -------------------------------------- | ----------------------------------- |
| Binary not found     | Error + link to install docs / setting | Open settings                       |
| `initialize` fail    | Show agent stderr tail                 | Restart                             |
| Auth required        | Prompt API key or “Login in browser”   | `x.ai/auth/*` or CLI                |
| Protocol parse error | “Agent communication error”            | Restart process                     |
| Mid-turn crash       | Mark turn failed                       | New process + optional session/load |
| Permission timeout   | Deny + toast                           | User retries                        |

## Correlation & threading

- Every request has a JSON-RPC `id`.
- Notifications have no response.
- Do not block the extension host event loop on long agent work; all I/O async.
- Serialize writes to agent stdin (mutex/queue) to avoid interleaved lines.

## Testing strategy (protocol)

| Layer       | Approach                                                        |
| ----------- | --------------------------------------------------------------- |
| Unit        | Mock transport: scripted responses for initialize/prompt/update |
| Integration | Spawn real `grok agent stdio` when binary available (opt-in CI) |
| Fixture     | Recorded JSON-RPC transcripts from CLI ACP sessions             |

## Reference pseudo-code

```ts
const proc = spawn(binary, ["agent", ...args, "stdio"], {
  cwd: workspaceRoot,
  env: sanitizedEnv,
  stdio: ["pipe", "pipe", "pipe"], // keep stdin open
});

const client = createAcpClient(proc);

await client.initialize({
  protocolVersion: 1,
  clientCapabilities: buildInitializeClientCapabilities(),
  // terminal: false; FS true; TUI-aligned _meta (hunk tracker, etc.)
});

const { sessionId } = await client.sessionNew({
  cwd: workspaceRoot,
  mcpServers: [],
});

client.onSessionUpdate((update) => chatPanel.apply(update));

await client.sessionPrompt({
  sessionId,
  prompt: [{ type: "text", text: userInput }],
});
```

## Next

→ [04 — Host Capabilities](04-host-capabilities.md)
