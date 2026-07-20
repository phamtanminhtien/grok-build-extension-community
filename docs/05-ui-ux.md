# 05 — UI & UX

## Design intent

VS Code-native, not a terminal emulator inside a webview.

- Familiar chat sidebar.
- Tool activity as structured cards, not raw JSON.
- Permissions as blocking but clear modals.
- Diffs via VS Code editors when possible.

## Surfaces

### 1. Activity Bar + Side Panel (primary)

- Icon: `media/grok.svg` (activity bar + secondary sidebar container).
- View containers: `grok` (activity bar), `grok-secondary` (secondary sidebar when supported).
- Default view: **Chat** (`grok.chatView` / `grok.chatView.secondary`).

### 2. Chat webview

Layout (top → bottom):

```
┌─────────────────────────────────────┐
│ Session · Model · ··· menu          │  header
├─────────────────────────────────────┤
│                                     │
│  message list (windowed / virtualized)│
│  - user bubbles                     │
│  - assistant markdown (sanitized)   │
│  - thought (collapsed)              │
│  - tool cards / timeline            │
│  - plan / errors / banners          │
│                                     │
├─────────────────────────────────────┤
│ [ tasks: N running (when any)   ] │  bg tasks / subagents / loops
│ [ queue pane: #1 … #N  (when any) ] │  follow-ups (TUI-like)
│ [ textarea                      ⏎ ] │  composer (Enter queues while busy)
│ [ Mode | ctx window | @chips … ⏎ ] │  action row: usage + sticky context
└─────────────────────────────────────┘
```

### Background tasks panel (extension-native)

Shows **running** (and briefly **finished**) background work above the
composer — IDE list, not a port of the TUI `Ctrl+B` pane:

| Kind           | Source                                               | Actions             |
| -------------- | ---------------------------------------------------- | ------------------- |
| Subagent       | `subagent_*` session notifications + `list_running`  | View summary, Kill  |
| Task / Monitor | `task_backgrounded` / `task_completed` + `task/list` | View log file, Kill |
| Loop           | `scheduled_task_created` + scheduler delete          | Kill                |

Finished rows are hidden immediately from the list (TUI default `show_done=false`). Refresh re-lists running work from the agent.

| Entry                    | Behavior                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status bar               | When any work is running: `Grok Build · N` with tooltip listing rows                                                                                                                                                                 |
| `/tasks`                 | Host command: refresh lists, open chat, print a grouped report in chat                                                                                                                                                               |
| View on **subagent**     | Opens an **in-chat subagent panel**. While running: **live** child `session/update` stream (thinking / tools / text — same timeline as main chat). When done: snapshot fallback via `x.ai/subagent/get`. Refresh · Stop · Esc close. |
| View on **task/monitor** | Opens `output_file` or a log preview                                                                                                                                                                                                 |

### Prompt queue (TUI parity)

While a turn is running, Enter **queues** a follow-up via `session/prompt`
(server-authoritative). The panel above the composer lists held rows from
`x.ai/queue/changed` and supports:

| Action             | Wire                   |
| ------------------ | ---------------------- |
| Remove             | `x.ai/queue/remove`    |
| Reorder (↑/↓)      | `x.ai/queue/reorder`   |
| Clear              | `x.ai/queue/clear`     |
| Edit               | `x.ai/queue/edit`      |
| Send now (per row) | `x.ai/queue/interject` |

Primary composer button modes only:

| State        | Button    |
| ------------ | --------- |
| Idle + text  | **Send**  |
| Busy + empty | **Stop**  |
| Busy + text  | **Queue** |

Inject / send-now is **not** on that button — use the bolt control on a queue row.

### 3. Editor title (top-right)

- Icon: Grok mark (`media/grok-light.svg` / `media/grok-dark.svg`).
- Command: `grok.openChat` — opens the chat panel from any text editor.
- Menu: `editor/title` group `navigation`.

### 4. Status bar item

- Idle: `Grok` / model short name.
- Running: spinner + “Grok working…”.
- Error: alert icon; click opens Output / panel.

### 5. Commands (Command Palette)

Titles use the **Grok Build:** prefix in `package.json`. Core set:

| Command id                                                 | Title (short)            | Notes                    |
| ---------------------------------------------------------- | ------------------------ | ------------------------ |
| `grok.openChat`                                            | Open Chat                | Also editor title icon   |
| `grok.openChatActivityBar`                                 | Open Chat (Activity Bar) |                          |
| `grok.newSession`                                          | New Session              | View title               |
| `grok.cancel`                                              | Cancel Turn              |                          |
| `grok.startAgent` / `restartAgent` / `stopAgent`           | Agent lifecycle          |                          |
| `grok.openOutput`                                          | Open Output              | Channel **Grok Build**   |
| `grok.selectModel`                                         | Select Model             |                          |
| `grok.login` / `logout` / `pasteAuthCode`                  | Auth                     |                          |
| `grok.setApiKey` / `clearApiKey`                           | API key                  | SecretStorage            |
| `grok.checkSubscription` / `accountInfo`                   | Account                  |                          |
| `grok.addSelectionToChat` / `addFileToChat` / `addContext` | Context                  |                          |
| `grok.attachImage`                                         | Attach Image…            |                          |
| `grok.fixWithGrok`                                         | Fix with Grok            | Diagnostics              |
| `grok.resumeSession`                                       | Resume Session…          |                          |
| `grok.reviewEdits` / `acceptAllEdits` / `rejectAllEdits`   | Diff review              |                          |
| `grok.rewind`                                              | Rewind…                  |                          |
| `grok.openExtensions`                                      | Extensions…              | Hooks/plugins/skills/MCP |
| `grok.smokeTest`                                           | Smoke Test (L0)          | Dev                      |

### 6. Keybindings (proposed defaults)

| Key                     | Command                    | When                          |
| ----------------------- | -------------------------- | ----------------------------- |
| (none global mandatory) | —                          | Avoid fighting Copilot        |
| `Enter` in composer     | Send / Queue               | Idle send; busy + text queues |
| `Shift+Enter`           | Newline                    | Webview only                  |
| `Shift+Tab`             | Mode cycle                 | Permission mode like TUI      |
| `Escape`                | Cancel turn / close panels | Webview focus                 |

Users may bind `grok.openChat` themselves.

## Message rendering

| Stream event          | Render                                           |
| --------------------- | ------------------------------------------------ |
| User text             | Right/secondary bubble                           |
| `agent_message_chunk` | Streaming markdown (sanitize HTML)               |
| `agent_thought_chunk` | Collapsible “Thinking”                           |
| `tool_call`           | Card: icon by kind, title, status badge          |
| `tool_call_update`    | Progress / completed / failed + truncated output |
| Plan                  | Ordered checklist + approval UI                  |
| Permission pending    | Inline banner + modal                            |
| Session notification  | Banner (diff review, compact, retry, …)          |

### Markdown rules

- Render with a sanitizing markdown pipeline in webview.
- Fenced code: copy button; “Open as file” optional.
- File paths: clickable → `vscode.open`.
- Never `innerHTML` unsanitized agent HTML.

### Tool card kinds (heuristic)

| Kind / title contains   | Icon suggestion |
| ----------------------- | --------------- |
| read / grep / search    | search          |
| edit / write / patch    | edit            |
| terminal / bash / shell | terminal        |
| web                     | globe           |
| task / subagent         | organization    |
| default                 | tools           |

## Permission UX

Blocking modal (or modal + webview banner):

```
Grok wants to run:

  run_terminal_command
  rm -rf build && npm test

[Allow once]  [Always this session]  [Deny]
```

Rules:

- Show **tool name + human summary + risk hint**.
- Destructive patterns (git push --force, rm -rf, chmod) emphasize warning.
- Escape / focus loss: **do not** auto-allow; after timeout deny
  (see security doc).
- Queue: only one permission dialog at a time; FIFO.

## Diffs & edits

**Shipped (L2):**

- Pre-write snapshots (`SnapshotStore` + `grok-diff:` content provider).
- Multi-file review via `vscode.diff` (`DiffReviewService`).
- Hunk-tracker Accept / Reject (and Accept/Reject all commands).
- Tool cards list paths; click opens file.

Do not invent a parallel SCM system.

## Context chips

Composer shows sticky chips (in-composer row):

- `file:…` / `selection:…` / `folder:…`
- Auto-attach chip for focused file (toggle)
- Inline `@mentions` with picker popover

Removal: click ×. Adding: `@` menu, commands, or Attach Image.

## Empty states

| State                 | Message                              | CTA                                                             |
| --------------------- | ------------------------------------ | --------------------------------------------------------------- |
| No binary             | “Grok CLI not found”                 | Install guide / set path                                        |
| Not logged in         | “Not signed in — use Sign in…”       | **Sign in** (browser OAuth / API key)                           |
| Signed in (CLI / API) | “Signed in via CLI session (email)…” | **Log out** (clears `~/.grok/auth.json`, same as `grok logout`) |
| No workspace folder   | “Open a folder to start”             | Open folder                                                     |
| Ready                 | Short tips / example prompts         | —                                                               |

Auth CTAs must stay in sync with the CLI session: login/logout write the same
`~/.grok/auth.json` the `grok` CLI uses, and the empty-state button flips
between Sign in and Log out from that shared status.

## Accessibility

- Keyboard navigable composer and message list.
- Respect `prefers-reduced-motion`.
- Contrast aligned with VS Code theme CSS variables
  (`var(--vscode-editor-background)`, etc.).
- Screen reader: live region for new assistant text (best-effort).

## Theming

- Use VS Code webview toolkit CSS variables exclusively.
- No hard-coded dark theme.
- Optional product accent only for brand mark.

## Performance budgets (targets)

| Metric              | Target                                                            |
| ------------------- | ----------------------------------------------------------------- |
| Webview first paint | < 300 ms after open                                               |
| Stream chunk apply  | Throttled host posts; windowed DOM for long threads               |
| History length      | Soft-trim UI at N messages; full history remains in agent session |

## Next

→ [06 — Auth & Settings](06-auth-and-settings.md)
