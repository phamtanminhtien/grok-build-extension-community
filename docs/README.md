# Grok VS Code Extension — Documentation

Design docs for the **Grok Build** VS Code extension: a thin IDE host that
drives the existing `grok agent stdio` ACP server. The agent runtime stays in
Rust; this extension is the client UI and host integration layer.

## Status

| Item | Status |
|------|--------|
| Design docs | In progress (this folder) |
| Extension scaffold | Not started |
| Implementation | Blocked on doc review |

## Reading order

| # | Document | Audience | Description |
|---|----------|----------|-------------|
| 1 | [Overview](01-overview.md) | Everyone | Goals, non-goals, relationship to Grok Build |
| 2 | [Architecture](02-architecture.md) | Engineers | Process model, layers, data flow |
| 3 | [ACP Integration](03-acp-integration.md) | Engineers | Protocol lifecycle, methods, streaming |
| 4 | [Host Capabilities](04-host-capabilities.md) | Engineers | FS, terminal, and VS Code API mapping |
| 5 | [UI & UX](05-ui-ux.md) | Product + eng | Chat panel, permissions, diffs, commands |
| 6 | [Auth & Settings](06-auth-and-settings.md) | Engineers | Auth flows, configuration surface |
| 7 | [Binary Lifecycle](07-binary-lifecycle.md) | Engineers | Discover, spawn, version, update |
| 8 | [Security](08-security.md) | Engineers | Trust, permissions, secrets |
| 9 | [Roadmap](09-roadmap.md) | Product + eng | Phases L0–L3 and acceptance criteria |
| 10 | [Decisions](10-decisions.md) | Engineers | ADRs — locked choices and open questions |

## Source of truth (upstream)

Grok Build (sibling tree `../grok-build/`):

- [Agent Mode / ACP](../grok-build/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)
- [Headless mode](../grok-build/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)
- [Permissions](../grok-build/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)
- [Sessions](../grok-build/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)
- Protocol: [agentclientprotocol.com](https://agentclientprotocol.com)
- TS SDK: [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)

## Guiding principle

> **Do not reimplement the agent.**  
> Spawn `grok agent stdio`, speak ACP, map host primitives (editor, FS,
> terminal, UI) to client capabilities and extension methods.

## Out of scope for this docs set

- Implementation code (lives under `src/` once scaffolded)
- Publishing / marketplace marketing copy
- JetBrains or other IDE ports (same architecture, separate repos)
