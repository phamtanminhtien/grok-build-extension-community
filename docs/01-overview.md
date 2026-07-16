# 01 — Overview

## What this is

**Grok for VS Code** is an extension that embeds Grok Build as an IDE-native
coding agent. Users chat, approve tools, review diffs, and manage sessions
inside VS Code while the **same Rust agent binary** powers the TUI and CLI.

```
User ↔ VS Code Extension (TypeScript) ↔ grok agent stdio (Rust) ↔ models / tools / MCP
```

## Why it exists

1. Developers already live in VS Code; forcing a separate TUI is friction.
2. Grok Build already exposes a stable **Agent Client Protocol (ACP)** server
   (`grok agent stdio`) used by Zed, Neovim, Emacs, and others.
3. A thin host reuses months of agent work (tools, sessions, sandbox, plugins)
   without rewriting them in TypeScript.

## Goals

| Goal | Description |
|------|-------------|
| **G1** | First-class chat + tool stream inside VS Code |
| **G2** | Host-aware FS (read/write open buffers, not only disk) |
| **G3** | Interactive tool permission UX (approve / deny / always) |
| **G4** | Context from IDE (active file, selection, workspace root) |
| **G5** | Session create / resume aligned with Grok session store |
| **G6** | Zero agent logic fork — one binary, one protocol |

## Non-goals

| Non-goal | Rationale |
|----------|-----------|
| Port the TUI (ratatui pager) into VS Code | Wrong stack; poor UX fit |
| Rewrite tools / MCP / subagents in TS | Duplicates `xai-grok-shell` + `xai-grok-tools` |
| Full parity with every TUI shortcut/theme | Extension has its own interaction model |
| Replace VS Code Copilot Chat API as the only UI | We own the webview/panel for full ACP control |
| Bundle a second model runtime | Agent talks to xAI / configured endpoints |

## Relationship to Grok Build

| Component | Location | Role in extension |
|-----------|----------|-------------------|
| `xai-grok-pager` | Grok Build | **Not used** (TUI only) |
| `xai-grok-shell` | Grok Build | Agent runtime (spawned) |
| `xai-acp-lib` | Grok Build | Server-side ACP transport |
| `xai-grok-tools` | Grok Build | Tool implementations (spawned) |
| Config `~/.grok/` | User machine | Shared auth, config, sessions, skills |

The extension **reads/writes** shared Grok user state where appropriate
(e.g. credentials already present from CLI login) but never reimplements
agent policy.

## User-facing value (MVP)

- Open a **Grok** side panel, type a prompt, see streamed answer + tool calls.
- Approve or deny file edits / shell commands when the agent asks.
- Click tool paths to open files; see basic edit summaries.
- Use workspace folder as `cwd`; attach active editor / selection as context.
- Configure binary path, model, and API key / rely on existing CLI auth.

## Success metrics (qualitative)

- Time-to-first-response from a clean install under 2 minutes (with binary ready).
- No feature requires forking or patching the Grok agent source for basic chat.
- Crashes of the agent process are recoverable without reloading the window.
- Users who already use `grok` CLI feel settings/auth continuity.

## Glossary

| Term | Meaning |
|------|---------|
| **ACP** | Agent Client Protocol — JSON-RPC between IDE client and agent |
| **Agent** | `grok agent stdio` child process |
| **Host** | This VS Code extension (client) |
| **Client capability** | Host feature the agent may call (e.g. `fs/read_text_file`) |
| **Extension method** | SpaceXAI-specific RPC under `x.ai/*` |
| **Session** | Persistent conversation id managed by the agent |
| **Turn** | One user prompt + agent response cycle |

## Next

→ [02 — Architecture](02-architecture.md)
