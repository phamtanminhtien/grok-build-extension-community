# Grok Build Community Edition — Documentation

Design docs for the **Grok Build Community Edition** VS Code extension: a thin
IDE host that drives the existing `grok agent stdio` ACP server. The agent
runtime stays in Rust; this extension is the client UI and host integration
layer.

**Current release:** `0.3.8` (see root [CHANGELOG.md](../CHANGELOG.md)).

## Status (synced 2026-07-20)

| Item                      | Status                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Design docs               | Live — keep in sync with `src/` + CHANGELOG                                                                                          |
| Extension scaffold        | Done (`src/`, esbuild, yarn)                                                                                                         |
| L0 protocol wire-up       | **Done** — [L0 manual test](L0-manual-test.md) + `yarn smoke:cli`                                                                    |
| L1 MVP chat               | **Done** — sidebar webview, permissions, host FS, status bar                                                                         |
| L2 IDE-native polish      | **Done** (except optional terminal hybrid; Remote docs shipped)                                                                      |
| L3 depth & productization | **In progress** — Tasks, plan, Extensions, rewind, billing, worktree UI, min CLI gate shipped; binary bundle / CI mock ACP remaining |

## Reading order

| #   | Document                                     | Audience      | Description                                  |
| --- | -------------------------------------------- | ------------- | -------------------------------------------- |
| 1   | [Overview](01-overview.md)                   | Everyone      | Goals, non-goals, relationship to Grok Build |
| 2   | [Architecture](02-architecture.md)           | Engineers     | Process model, layers, data flow             |
| 3   | [ACP Integration](03-acp-integration.md)     | Engineers     | Protocol lifecycle, methods, streaming       |
| 4   | [Host Capabilities](04-host-capabilities.md) | Engineers     | FS, terminal, and VS Code API mapping        |
| 5   | [UI & UX](05-ui-ux.md)                       | Product + eng | Chat panel, permissions, diffs, commands     |
| 6   | [Auth & Settings](06-auth-and-settings.md)   | Engineers     | Auth flows, configuration surface            |
| 7   | [Binary Lifecycle](07-binary-lifecycle.md)   | Engineers     | Discover, spawn, version, update             |
| 8   | [Security](08-security.md)                   | Engineers     | Trust, permissions, secrets                  |
| 9   | [Roadmap](09-roadmap.md)                     | Product + eng | Phases L0–L3 and acceptance criteria         |
| 10  | [Decisions](10-decisions.md)                 | Engineers     | ADRs — locked choices and open questions     |

### Specs & plans

| Path                                     | Notes                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| [superpowers/specs/](superpowers/specs/) | Feature design specs (L2 polish, Fix with Grok, images)   |
| [superpowers/plans/](superpowers/plans/) | Implementation plans (historical; code may have diverged) |

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

- Full implementation walkthrough of every file under `src/`
- Publishing / marketplace marketing copy (see root README)
- JetBrains or other IDE ports (same architecture, separate repos)

## Doc maintenance

When shipping a user-visible feature:

1. Update [09-roadmap](09-roadmap.md) checkboxes if a phase item closes.
2. Record durable choices in [10-decisions](10-decisions.md).
3. Patch the relevant design doc (UI, auth, ACP, …) if behavior changed.
4. Keep root [CHANGELOG.md](../CHANGELOG.md) as the release history of record.
