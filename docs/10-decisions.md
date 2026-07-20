# 10 — Decisions (ADRs)

Record architectural decisions. Status: **Proposed** | **Accepted** | **Superseded** | **Open**.

Synced with implementation as of **v0.3.8** (2026-07-20).

---

## ADR-001: Client architecture = ACP + existing binary

|                  |                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                    |
| **Context**      | Need VS Code integration without forking agent logic                                        |
| **Decision**     | Extension is an ACP client; runtime is `grok agent stdio`                                   |
| **Consequences** | Full tool surface without TS rewrite; depends on binary distribution and protocol stability |

---

## ADR-002: Primary UI = custom webview chat (not Copilot Chat participant only)

|                  |                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                            |
| **Context**      | VS Code has Chat / Language Model APIs; ACP needs custom permission and tool streaming              |
| **Decision**     | Own a Side Bar / Secondary Side Bar webview for full control; optionally add Chat participant later |
| **Consequences** | More UI work; better protocol fidelity                                                              |

---

## ADR-003: One agent process per extension host workspace window

|                  |                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Status**       | Accepted                                                                                                                 |
| **Context**      | Multi-session vs multi-process tradeoffs                                                                                 |
| **Decision**     | Default one long-lived process; multiple sessions multiplexed if ACP allows, else sequential session ids on same process |
| **Consequences** | Simpler lifecycle; multi-window = multi-process                                                                          |

---

## ADR-004: Terminal capability strategy

|                  |                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | **Accepted** (2026-07)                                                                                                                              |
| **Context**      | VS Code Terminal API has weak PTY capture vs agent-owned shells                                                                                     |
| **Options**      | **A.** Declare `terminal: false`, agent-side tools only<br>**B.** Partial host terminal<br>**C.** Hybrid later                                      |
| **Decision**     | **A** — `initialize.clientCapabilities.terminal = false` (see `src/agent/clientCapabilities.ts`). Shell runs via agent tools; output in tool cards. |
| **Consequences** | Full shell fidelity; not VS Code integrated terminal. Hybrid “Reveal in Terminal” remains a future L2 residual option.                              |

---

## ADR-005: Binary distribution for MVP / current release

|                  |                                                                            |
| ---------------- | -------------------------------------------------------------------------- |
| **Status**       | Accepted (still current for 0.3.x)                                         |
| **Decision**     | PATH + `grok.binaryPath`; no bundled binary; no first-run download         |
| **Consequences** | Install friction; simplest security/review story. L3 may revisit bundling. |

---

## ADR-006: Host FS capabilities enabled in initialize

|                  |                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Status**       | **Accepted**                                                                                                            |
| **Decision**     | Advertise `fs.readTextFile` + `fs.writeTextFile` and implement via TextDocument / WorkspaceEdit (`src/agent/hostFs.ts`) |
| **Consequences** | Unsaved-buffer fidelity; size limits via `grok.fs.maxReadBytes`; `grok.fs.autoSave` defaults true                       |

---

## ADR-007: Permission default ask with timeout deny

|                  |                                                                                   |
| ---------------- | --------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                          |
| **Decision**     | Never silent-allow; timeout → deny (`grok.permissionTimeoutMs`, default **120s**) |
| **Consequences** | Safer; long-unattended agents may fail tools                                      |

---

## ADR-008: Multi-root workspace cwd

|                  |                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------ |
| **Status**       | **Accepted** (implemented)                                                           |
| **Decision**     | Use `grok.cwd` if set, else first `workspaceFolders[0]`, else process cwd            |
| **Consequences** | Simple; switching roots may require setting or restart. Per-root processes deferred. |

---

## ADR-009: Auto-attach editor context

|                  |                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                                         |
| **Decision**     | Default on for active file + non-empty selection; excludeGlob for secrets; sticky `@` chips for explicit context |
| **Consequences** | Better answers; privacy settings required                                                                        |

---

## ADR-010: Language / docs locale

|                  |                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                     |
| **Decision**     | Design docs and code comments in **English**; user-facing strings English first (i18n later) |
| **Consequences** | Matches Grok Build upstream docs                                                             |

---

## ADR-011: SDK vs hand-rolled JSON-RPC

|                  |                                                       |
| ---------------- | ----------------------------------------------------- |
| **Status**       | Accepted                                              |
| **Decision**     | Production uses `@agentclientprotocol/sdk`            |
| **Consequences** | Dependency on SDK version; better framing correctness |

---

## ADR-012: Shared CLI config for model / permission / effort

|                  |                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                                                        |
| **Context**      | Users run both TUI and extension                                                                                                |
| **Decision**     | Persist model, reasoning effort, and permission mode in `~/.grok/config.toml` (not only VS Code settings), aligned with CLI/TUI |
| **Consequences** | CLI and extension stay in sync; VS Code `settings.json` holds host-only knobs (binary, FS, context, timeouts)                   |

---

## ADR-013: Client capabilities meta (TUI-aligned)

|                  |                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                                                                    |
| **Decision**     | Advertise `_meta` flags matching TUI defaults: incremental bash output, hunk tracker (`agent_only`), bash output no color, git head changed |
| **Consequences** | Agent enables incremental shell streaming and hunk Accept/Reject paths the extension already wires                                          |

---

## ADR-014: Product identity (community)

|                  |                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **Status**       | Accepted                                                                                                    |
| **Decision**     | Publisher `tienpham`; package `grok-build-community-edition`; display name **Grok Build Community Edition** |
| **Consequences** | Marketplace/Open VSX listing under community branding                                                       |

---

## Open questions backlog

1. ~~Exact ACP permission method names / shapes~~ → Use SDK + live binary; stable enough for 0.3.x.
2. ~~Whether `session/load` supports listing~~ → Local `~/.grok/sessions` index + capability-gated load.
3. ~~Product name / publisher id~~ → ADR-014.
4. **Telemetry:** extension-side vs agent-only — still open (default: none in extension).
5. **Minimum `grok` version gate** for marketplace VSIX — still open (no hard gate yet).
6. Whether to support `grok agent serve` (WebSocket) for remote agent — no for 0.3.x.
7. **Terminal hybrid** (Reveal in Terminal) without full host PTY — optional L2 residual.
8. **Binary download / bundle** — product packaging decision for L3.

## Decision log process

When resolving an Open item:

1. Update status to Accepted/Rejected.
2. Note date and rationale.
3. If it changes roadmap, patch [09-roadmap](09-roadmap.md).

---

## Implementation entrypoint

Code lives under `grok-vscode-extension/src/`. Activate via `src/extension.ts`.
Build: `yarn build` · Test: `yarn test` · Package: `yarn package`.
