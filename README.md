# Grok Build - Community

Community VS Code host for [Grok Build](../grok-build/): a thin TypeScript client
that speaks **ACP** to `grok agent stdio`. The agent runtime stays in Rust.

## Status

| Phase | Status |
|-------|--------|
| Design docs | Done (`docs/`) |
| L0 — Protocol wire-up | Done |
| L1 — MVP chat | Done |
| **L2 — IDE-native polish** | **Implemented** (markdown, `@` context, model pick, diffs, history; session/load capability-gated) |
| L3 — Depth & productization | Not started |

## Principle

> Do not reimplement the agent. Spawn `grok agent stdio`, speak ACP, map VS Code primitives.

## Prerequisites

- Node 20+
- [Grok Build CLI](../grok-build/) (`grok` on PATH or set `grok.binaryPath`)
- CLI auth already set up (`~/.grok`)

## Develop

```bash
cd grok-vscode-extension
npm install
npm run build
npm run typecheck
npm test
```

### Headless L0 smoke (no VS Code)

```bash
npm run smoke:cli
```

### Extension Development Host

1. Open this folder in VS Code / Cursor
2. Press **F5** (Run Extension)
3. **Both locations work:**
   - **Activity Bar** (left) — classic Grok Build icon (always)
   - **Secondary Side Bar** (right) — tab next to Chat / Claude Code / Codex (VS Code ≥ 1.106)
4. **Grok Build: Open Chat** prefers the secondary tab strip; **Open Chat (Activity Bar)** forces the left sidebar
5. Type a prompt and Send (active file / selection attach automatically)

Full checklist: [docs/L0-manual-test.md](docs/L0-manual-test.md)

## Commands

| Command | Action |
|---------|--------|
| `Grok Build: Open Chat` | Focus sidebar chat |
| `Grok Build: Open Output` | Show Output channel `Grok Build` |
| `Grok Build: Start Agent` | Spawn → `initialize` → `session/new` |
| `Grok Build: New Session` | New ACP session + clear UI |
| `Grok Build: Cancel Turn` | `session/cancel` |
| `Grok Build: Add Context…` | `@` sticky context picker |
| `Grok Build: Select Model` | QuickPick → `grok.model` + agent restart |
| `Grok Build: Resume Session…` | Same as TUI: `_x.ai/session_summaries/*` + FTS search; disk fallback; `session/load` |
| `Grok Build: Review Edits…` | Multi-file diff review |
| `Grok Build: Login / Set API Key` | SecretStorage API key |
| `Grok Build: Smoke Test (L0)` | Headless-style prompt via agent |
| `Grok Build: Restart / Stop Agent` | Process lifecycle |

## Settings

| Setting | Description |
|---------|-------------|
| `grok.binaryPath` | Absolute path to `grok` (empty = PATH / `~/.grok/bin`) |
| `grok.model` | Optional `--model` |
| `grok.alwaysApprove` | Pass `--always-approve` (dangerous) |
| `grok.cwd` | Session cwd (empty = first workspace folder) |
| `grok.initializeTimeoutMs` | Spawn/init timeout (default 30s) |

## Layout

```
src/
  extension.ts
  agent/          # process, ACP, host FS, permissions
  ui/             # chat webview + status bar
  auth/           # SecretStorage API key
  context/        # active file / selection → ACP blocks
  config/settings.ts
  log/output.ts
media/grok.svg              # activity bar (Tabler message-chatbot)
media/tabler/               # webfont copied on build for chat UI
scripts/smoke-cli.mjs
docs/
```

Chat UI uses **[@tabler/icons-webfont](https://tabler.io/icons)** (`npm run build` copies CSS/fonts into `media/tabler/`).


## Documentation

Start here: **[docs/README.md](docs/README.md)**

| Doc | Topic |
|-----|--------|
| [01 Overview](docs/01-overview.md) | Goals / non-goals |
| [02 Architecture](docs/02-architecture.md) | Process model & modules |
| [03 ACP](docs/03-acp-integration.md) | Protocol integration |
| [09 Roadmap](docs/09-roadmap.md) | L0–L3 phases |
| [L0 Manual Test](docs/L0-manual-test.md) | Acceptance steps |
