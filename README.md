# Grok VS Code Extension

VS Code host for [Grok Build](../grok-build/): a thin TypeScript client that
speaks **ACP** to `grok agent stdio`. The agent runtime stays in Rust.

## Status

**Design only.** Implementation has not started.

## Documentation

Start here: **[docs/README.md](docs/README.md)**

| Doc | Topic |
|-----|--------|
| [01 Overview](docs/01-overview.md) | Goals / non-goals |
| [02 Architecture](docs/02-architecture.md) | Process model & modules |
| [03 ACP](docs/03-acp-integration.md) | Protocol integration |
| [04 Host capabilities](docs/04-host-capabilities.md) | FS / terminal mapping |
| [05 UI/UX](docs/05-ui-ux.md) | Chat, permissions, commands |
| [06 Auth & settings](docs/06-auth-and-settings.md) | Config surface |
| [07 Binary lifecycle](docs/07-binary-lifecycle.md) | Spawn & versioning |
| [08 Security](docs/08-security.md) | Trust & threat model |
| [09 Roadmap](docs/09-roadmap.md) | L0–L3 phases |
| [10 Decisions](docs/10-decisions.md) | ADRs |

## Principle

> Do not reimplement the agent. Spawn `grok agent stdio`, speak ACP, map VS Code primitives.
