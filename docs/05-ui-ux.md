# 05 — UI & UX

## Design intent

VS Code-native, not a terminal emulator inside a webview.

- Familiar chat sidebar.
- Tool activity as structured cards, not raw JSON.
- Permissions as blocking but clear modals.
- Diffs via VS Code editors when possible.

## Surfaces

### 1. Activity Bar + Side Panel (primary)

- Icon: Grok / SpaceXAI mark (product assets TBD).
- View container id: `grok`.
- Default view: **Chat**.

### 2. Chat webview

Layout (top → bottom):

```
┌─────────────────────────────────────┐
│ Session · Model · ··· menu          │  header
├─────────────────────────────────────┤
│                                     │
│  message list (virtualized later)   │
│  - user bubbles                     │
│  - assistant markdown               │
│  - thought (collapsed)              │
│  - tool cards                       │
│  - errors                           │
│                                     │
├─────────────────────────────────────┤
│ [@ context chips]                   │
│ [ queue pane: #1 … #N  (when any) ] │  follow-ups (TUI-like)
│ [ textarea                      ⏎ ] │  composer (Enter queues while busy)
│ [ Send / Stop / Queue ]             │  primary button (no inject here)
└─────────────────────────────────────┘
```

### Prompt queue (TUI parity)

While a turn is running, Enter **queues** a follow-up via `session/prompt`
(server-authoritative). The panel above the composer lists held rows from
`x.ai/queue/changed` and supports:

| Action | Wire |
|--------|------|
| Remove | `x.ai/queue/remove` |
| Reorder (↑/↓) | `x.ai/queue/reorder` |
| Clear | `x.ai/queue/clear` |
| Edit | `x.ai/queue/edit` |
| Send now (per row) | `x.ai/queue/interject` |

Primary composer button modes only:

| State | Button |
|-------|--------|
| Idle + text | **Send** |
| Busy + empty | **Stop** |
| Busy + text | **Queue** |

Inject / send-now is **not** on that button — use the bolt control on a queue row.

### 3. Status bar item

- Idle: `Grok` / model short name.
- Running: spinner + “Grok working…”.
- Error: alert icon; click opens Output / panel.

### 4. Commands (Command Palette)

| Command id | Title | MVP |
|------------|-------|-----|
| `grok.openChat` | Grok: Open Chat | Yes |
| `grok.newSession` | Grok: New Session | Yes |
| `grok.cancel` | Grok: Cancel Turn | Yes |
| `grok.restartAgent` | Grok: Restart Agent | Yes |
| `grok.selectModel` | Grok: Select Model | Yes |
| `grok.login` | Grok: Login | Yes |
| `grok.addSelectionToChat` | Grok: Add Selection to Chat | Yes |
| `grok.addFileToChat` | Grok: Add Active File to Chat | Yes |
| `grok.showOutput` | Grok: Show Output Channel | Yes |
| `grok.resumeSession` | Grok: Resume Session… | L2 |

### 5. Keybindings (proposed defaults)

| Key | Command | When |
|-----|---------|------|
| (none global mandatory) | — | Avoid fighting Copilot |
| `Enter` in composer | Send | Webview only |
| `Shift+Enter` | Newline | Webview only |
| `Escape` | Cancel turn | When running (webview focus) |

Users may bind `grok.openChat` themselves.

## Message rendering

| Stream event | Render |
|--------------|--------|
| User text | Right/secondary bubble |
| `agent_message_chunk` | Streaming markdown (sanitize HTML) |
| `agent_thought_chunk` | Collapsible “Thinking” |
| `tool_call` | Card: icon by kind, title, status badge |
| `tool_call_update` | Progress / completed / failed + truncated output |
| Plan | Ordered checklist (L2) |
| Permission pending | Inline banner + modal |

### Markdown rules

- Render with a sanitizing markdown pipeline in webview.
- Fenced code: copy button; “Open as file” optional.
- File paths: clickable → `vscode.open`.
- Never `innerHTML` unsanitized agent HTML.

### Tool card kinds (heuristic)

| Kind / title contains | Icon suggestion |
|----------------------|-----------------|
| read / grep / search | search |
| edit / write / patch | edit |
| terminal / bash / shell | terminal |
| web | globe |
| task / subagent | organization |
| default | tools |

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

### MVP

- Tool card for edits lists file paths.
- Click path → open file.
- If on-disk change detected, show “File changed on disk” via VS Code.

### L2

- On edit tool completion, offer **Compare with previous** using
  `vscode.diff` and content from agent update or local snapshot.
- Multi-file review list in panel.

Do not invent a parallel SCM system.

## Context chips

Composer can show chips:

- `file:src/a.ts`
- `selection:src/a.ts#L10-L40`
- `workspace:my-app`

Removal: click ×. Adding: commands / drag file (L2) / `@` menu (L2).

## Empty states

| State | Message | CTA |
|-------|---------|-----|
| No binary | “Grok CLI not found” | Install guide / set path |
| Not logged in | “Not signed in — use Sign in…” | **Sign in** (browser OAuth / API key) |
| Signed in (CLI / API) | “Signed in via CLI session (email)…” | **Log out** (clears `~/.grok/auth.json`, same as `grok logout`) |
| No workspace folder | “Open a folder to start” | Open folder |
| Ready | Short tips / example prompts | — |

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

| Metric | Target |
|--------|--------|
| Webview first paint | < 300 ms after open |
| Stream chunk apply | No full re-render of entire history each chunk (L1 may simple; L2 virtualize) |
| History length | Soft-trim UI at N messages; full history remains in agent session |

## Next

→ [06 — Auth & Settings](06-auth-and-settings.md)
