# Grok Build Community Edition

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/tienpham.grok-build-community-edition?label=VS%20Marketplace&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=tienpham.grok-build-community-edition)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/tienpham.grok-build-community-edition?label=installs)](https://marketplace.visualstudio.com/items?itemName=tienpham.grok-build-community-edition)
[![Open VSX](https://img.shields.io/open-vsx/v/tienpham/grok-build-community-edition?label=Open%20VSX)](https://open-vsx.org/extension/tienpham/grok-build-community-edition)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Community VS Code / Cursor host for **Grok Build** — chat, tools, diffs, and sessions in the editor while the agent runs as `grok agent stdio` (Rust).

![Grok Build Community Edition demo](https://raw.githubusercontent.com/phamtanminhtien/grok-build-extension-community/main/media/demo.gif)

## Install

| Store                              | Link                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **VS Code Marketplace**            | [tienpham.grok-build-community-edition](https://marketplace.visualstudio.com/items?itemName=tienpham.grok-build-community-edition) |
| **Open VSX** (Cursor, VSCodium, …) | [tienpham/grok-build-community-edition](https://open-vsx.org/extension/tienpham/grok-build-community-edition)                      |

Or search **“Grok Build Community Edition”** in Extensions (publisher `tienpham`).

### Prerequisites

1. **VS Code** 1.93+ (Secondary Side Bar chat needs **≥ 1.106**)
2. **Grok Build CLI** (`grok`) on `PATH`, or set `grok.binaryPath`
3. **Auth**: `grok login` / `~/.grok`, or **Grok Build: Login** / **Set API Key**

The VSIX does **not** bundle the `grok` binary. Install the CLI on the machine that runs the extension host (local, or the **remote** side of SSH/WSL).

### First run

1. Open a **trusted** workspace
2. **Grok Build: Open Chat** (activity bar or secondary sidebar)
3. Sign in if needed, then send a prompt (active file / selection attach by default)

### Remote-SSH / WSL

The extension host runs **on the remote** when you use Remote-SSH or WSL. The
CLI must be installed **there**, not only on your laptop.

1. Open the remote window (SSH host or WSL distro).
2. In a **remote** terminal, install Grok Build CLI:
   - macOS/Linux remote: `curl -fsSL https://x.ai/cli/install.sh | bash`
   - Ensure `~/.grok/bin` is on the remote `PATH` (or set `grok.binaryPath` to
     the absolute remote path, e.g. `/home/you/.grok/bin/grok`).
3. Sign in on the remote: `grok login`, or use **Grok Build: Login** / **Set API Key**
   in the remote VS Code window (credentials land in remote `~/.grok/`).
4. Confirm: remote terminal `grok --version` and **Grok Build: Start Agent**.

**Notes**

| Topic             | Detail                                                                         |
| ----------------- | ------------------------------------------------------------------------------ |
| Binary location   | Local macOS/Homebrew `grok` is **invisible** to a Linux remote host            |
| Sessions / config | `~/.grok/sessions`, `config.toml`, worktrees are **remote** home               |
| Worktrees         | Created under remote `~/.grok/worktrees/…` — open those paths on the remote    |
| Min version       | Extension enforces `grok.minCliVersion` (default `0.1.0`) against remote CLI   |
| Auth              | Browser login still works via `openExternal`; paste token if loopback needs it |

### Troubleshooting

| Symptom                  | What to try                                                   |
| ------------------------ | ------------------------------------------------------------- |
| Binary not found         | Install CLI · set `grok.binaryPath` · Output → **Grok Build** |
| CLI too old              | Upgrade CLI · or adjust `grok.minCliVersion`                  |
| Works locally, fails SSH | Install `grok` **on the remote**; check remote PATH           |
| Workspace not trusted    | **Manage Workspace Trust**                                    |
| Auth / 401               | **Login** / **Set API Key**, or `grok login`                  |
| Stuck agent              | **Grok Build: Restart Agent**                                 |

---

## Features

### Chat & agent

- **Streaming chat** in the Activity Bar and Secondary Side Bar (Secondary Side Bar needs VS Code ≥ 1.106)
- Assistant **markdown** (sanitized) with **code copy**, collapsible **thinking**, tool cards / **tool groups** (e.g. “Read N files”), live **shimmer** on the latest running tool
- **Message actions** — copy / edit user messages back into the composer
- **Permission popovers** — Allow once / Always allow (session) / Deny / Always deny (when offered); auto-deny after `grok.permissionTimeoutMs` (default 120s)
- **Agent questions** — multi-question UI for `x.ai/ask_user_question` (options, multi-select, skip / chat-about-this)
- **Plan mode** — Shift+Tab **Plan** arm + plan checklist / **exitPlanMode** approval when the agent proposes a plan
- **Prompt queue** — mid-turn Enter queues follow-ups; pane: remove, reorder, edit, clear, send-now (`x.ai/queue/*`)
- **Session notification banners** — compact, retry, subagent, interaction hints (`x.ai/session_notification`)
- **Turn status bar** — elapsed time, context tokens / window, cost when available
- **Virtualized message list** — windowed DOM for long threads
- **Welcome / empty state** — sign-in CTAs, tips; **CLI missing** install guidance blocks agent use until `grok` is available
- **Status bar** — idle / spinning “working…” + badge + tooltip when background work is running

### Subagents & background work

- **Tasks panel** (above composer, `/tasks`) — running **subagents**, background **tasks/monitors**, scheduled **loops**
- **In-chat subagent panel** (View on a subagent row):
  - **Live stream** while running — child `session/update` timeline (thinking / tools / text), same visual language as main chat
  - **Snapshot** when done — `x.ai/subagent/get` transcript (tools used, tokens, worktree path, failure/cancel reason)
  - **Kill** (`x.ai/subagent/cancel`) · **Refresh** · Esc / Done to close
- List bootstrap via `x.ai/subagent/list_running` + `x.ai/task/list`; finished rows drop off the list (TUI `show_done=false` parity)
- Subagent sessions are **hidden** from the resume picker by default (`session_kind` starting with `subagent`)

### Context & editor

- **Auto-attach** active file and/or selection (`grok.context.autoAttach*`); composer chip toggle; skip secrets via `grok.context.excludeGlob`
- **`@` context** — sticky chips (file / folder / selection) + inline `@` mentions in the composer
- **Images** — paste, drop (Shift+drop if VS Code steals the event), or **Attach Image…**
- **Fix with Grok** — diagnostics **Hover** + **Quick Fix** → composer with error + file snippet
- **Editor title** Grok icon → **Open Chat**; context menu **Add Selection to Chat**

### Edits & review

- **Multi-file diff review** — pre-write snapshots (`grok-diff:`), open with `vscode.diff`
- **Accept / Reject** via agent hunk-tracker (`x.ai/hunk-tracker/*`) — per file or accept/reject all
- Host **FS capabilities**: read prefers open buffers; write via WorkspaceEdit; optional auto-save (`grok.fs.*`)

### Sessions & history

- **New session** · **Home** welcome screen · **Resume** from `~/.grok/sessions` via ACP `session/load` when advertised
- **Rewind** (`x.ai/rewind/*`, dry-run preview then execute) · **`/compact`** host action with loading feedback
- **`/fork`** branch session (`x.ai/session/fork`) · **`/rename`** session title · **`/context`** / **`/session-info`**
- **Worktrees** — **Grok Build: Worktrees…** / `/worktrees` list · create · open folder · apply to main · remove · GC (`x.ai/git/worktree/*`)
- **Slash registry** — host commands, ACP passthrough (skills / agent builtins), TUI-only names listed as unsupported

### Extensions

- **Extensions panel** — hooks, plugins, skills, MCP (enable/disable, install/uninstall where the agent supports it)
- Host slash shortcuts: `/hooks`, `/plugins`, `/skills`, `/mcps`, `/marketplace` open the same panel

### Auth, model & config

- **Browser OAuth** / logout via `x.ai/auth/*`, shared with CLI `~/.grok/auth.json` (file watcher keeps empty-state in sync)
- **API key** in SecretStorage · optional `XAI_API_KEY` when `grok.inheritEnvApiKey` is true
- **Account / subscription** commands · **billing usage** in the context bar from `x.ai/billing` (usage %, effective %, auto-topup when present)
- **Model + reasoning effort** in the chat model popover (in-session `setModel` / effort — no full agent restart for switches)
- **Mode cycle** Shift+Tab: **Normal → Plan → Auto → Always Approve** (permission mode shared with CLI via `~/.grok/config.toml`)
- **Workspace Trust** required to start the agent

### Requires

- Grok Build CLI (`grok`) on the machine that runs the extension host — **not** bundled in the VSIX
- Shell tools run **agent-side** (`clientCapabilities.terminal: false`; incremental bash / hunk-tracker / git-head via client `_meta`)

---

## Settings

| Setting                                                     | Description                                           |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `grok.binaryPath`                                           | Path to `grok` (empty = PATH then `~/.grok/bin/grok`) |
| `grok.cwd`                                                  | Session cwd (empty = first workspace folder)          |
| `grok.initializeTimeoutMs`                                  | Spawn + `initialize` timeout (default 30s)            |
| `grok.permissionTimeoutMs`                                  | Permission dialog auto-deny (default 120s)            |
| `grok.inheritEnvApiKey`                                     | Pass host `XAI_API_KEY` if no SecretStorage key       |
| `grok.ui.showThoughts`                                      | Show thinking chunks in chat                          |
| `grok.context.autoAttachActiveFile` / `autoAttachSelection` | Auto context on send                                  |
| `grok.context.excludeGlob`                                  | Never auto-attach matching paths                      |
| `grok.fs.preferOpenBuffers` / `autoSave` / `maxReadBytes`   | Host FS behavior                                      |

Shared with CLI/TUI via `~/.grok/config.toml` (not VS Code settings): `[ui].permission_mode`, `[models].default`, `[models].default_reasoning_effort`.

---

## Commands

| Command                                                         | Action                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `Grok Build: Open Chat`                                         | Focus chat (activity bar or secondary sidebar)             |
| `Grok Build: Open Chat (Activity Bar)`                          | Force activity-bar chat view                               |
| `Grok Build: Open Output`                                       | Show Output channel **Grok Build**                         |
| `Grok Build: Start Agent`                                       | Spawn → `initialize` → `session/new`                       |
| `Grok Build: Restart Agent` / `Stop Agent`                      | Process lifecycle                                          |
| `Grok Build: New Session`                                       | New ACP session + clear UI                                 |
| `Grok Build: Cancel Turn`                                       | Cancel in-flight turn                                      |
| `Grok Build: Add Context…`                                      | Sticky `@` context picker                                  |
| `Grok Build: Add Selection to Chat` / `Add Active File to Chat` | Pin editor context chips                                   |
| `Grok Build: Fix with Grok`                                     | Hover / Quick Fix → composer with diagnostic + snippet     |
| `Grok Build: Select Model`                                      | Open in-chat model + effort popover                        |
| `Grok Build: Resume Session…`                                   | Pick from `~/.grok/sessions` · `session/load` if supported |
| `Grok Build: Review Edits…`                                     | Multi-file diff review + per-file Accept/Reject            |
| `Grok Build: Accept All Edits` / `Reject All Edits`             | Hunk-tracker bulk actions                                  |
| `Grok Build: Rewind…`                                           | Rewind checkpoints (`x.ai/rewind/*`)                       |
| `Grok Build: Extensions…`                                       | Hooks, plugins, skills, MCP panel                          |
| `Grok Build: Login` / `Logout` / `Paste Auth Code`              | Browser OAuth or finish loopback code                      |
| `Grok Build: Set API Key` / `Clear API Key`                     | SecretStorage API key                                      |
| `Grok Build: Check Subscription` / `Show Account Info`          | `x.ai/auth/*`                                              |
| `Grok Build: Attach Image…`                                     | File dialog → image blocks on next prompt                  |
| `Grok Build: Smoke Test (L0)`                                   | Dev prompt round-trip via agent                            |

### Slash commands (chat composer)

Type `/` in chat. Registry: **host** wins on name collision, then ACP-advertised commands (`src/slash/`).

| Layer                      | Examples                                                                                                                                                                                                    | Behavior                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Host**                   | `/new`, `/home`, `/resume`, `/compact`, `/rewind`, `/fork`, `/rename`, `/model`, `/always-approve`, `/tasks`, `/review`, `/hooks`…`/mcps`, `/copy`, `/export`, `/login`, `/logout`, `/help`, `/settings`, … | Handled in the extension                   |
| **Passthrough**            | `/plan`, `/loop`, `/effort`, `/btw`, `/goal`, `/share`, `/recap`, `/usage`, skills, hooks-add, …                                                                                                            | Sent as the user prompt for the agent      |
| **Unsupported (TUI-only)** | `/vim-mode`, `/theme`, `/dashboard`, `/minimal`, `/find`, `/jump`, `/voice`, …                                                                                                                              | Listed for parity; not executed in VS Code |

---

## Develop

```bash
yarn install
yarn build
yarn typecheck
yarn test
yarn smoke:cli    # needs grok on PATH
yarn package      # → .vsix
```

**F5** → Extension Development Host → open chat and send a prompt.

Design docs: [`docs/README.md`](./docs/README.md) · releases: [`CHANGELOG.md`](./CHANGELOG.md)

## License

MIT — see [`LICENSE`](./LICENSE).
