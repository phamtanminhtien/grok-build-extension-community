# Grok Build - Community

Community VS Code host for [Grok Build](../grok-build/): a thin TypeScript client
that speaks **ACP** to `grok agent stdio`. The agent runtime stays in Rust.

## Status

| Phase | Status |
|-------|--------|
| Design docs | Done (`docs/`) |
| **L0 — Protocol wire-up** | **Implemented** |
| L1 — MVP chat | Not started |
| L2 — IDE-native | Not started |

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
```

### Headless L0 smoke (no VS Code)

```bash
npm run smoke:cli
```

### Extension Development Host

1. Open this folder in VS Code / Cursor
2. Press **F5** (Run Extension)
3. Command Palette:
   - **Grok Build: Open Output**
   - **Grok Build: Start Agent**
   - **Grok Build: Smoke Test (L0)**
   - **Grok Build: Restart Agent** / **Grok Build: Stop Agent**

Full checklist: [docs/L0-manual-test.md](docs/L0-manual-test.md)

## Commands (L0)

| Command | Action |
|---------|--------|
| `Grok Build: Open Output` | Show Output channel `Grok Build` |
| `Grok Build: Start Agent` | Spawn → `initialize` → `session/new` |
| `Grok Build: Smoke Test (L0)` | Start + send test prompt; stream to Output |
| `Grok Build: Restart Agent` | Kill + re-init |
| `Grok Build: Stop Agent` | Graceful process shutdown |

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
  extension.ts              # activate / commands
  agent/
    binaryResolver.ts       # PATH + setting resolution
    processManager.ts       # spawn / kill grok agent stdio
    agentService.ts         # ACP client lifecycle
  config/settings.ts
  log/output.ts
scripts/smoke-cli.mjs       # headless acceptance
docs/                       # design + L0 manual test
```

## Documentation

Start here: **[docs/README.md](docs/README.md)**

| Doc | Topic |
|-----|--------|
| [01 Overview](docs/01-overview.md) | Goals / non-goals |
| [02 Architecture](docs/02-architecture.md) | Process model & modules |
| [03 ACP](docs/03-acp-integration.md) | Protocol integration |
| [09 Roadmap](docs/09-roadmap.md) | L0–L3 phases |
| [L0 Manual Test](docs/L0-manual-test.md) | Acceptance steps |
