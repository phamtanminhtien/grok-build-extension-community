# 10 — Decisions (ADRs)

Record architectural decisions. Status: **Proposed** | **Accepted** | **Superseded** | **Open**.

---

## ADR-001: Client architecture = ACP + existing binary

| | |
|--|--|
| **Status** | Accepted |
| **Context** | Need VS Code integration without forking agent logic |
| **Decision** | Extension is an ACP client; runtime is `grok agent stdio` |
| **Consequences** | Full tool surface without TS rewrite; depends on binary distribution and protocol stability |

---

## ADR-002: Primary UI = custom webview chat (not Copilot Chat participant only)

| | |
|--|--|
| **Status** | Accepted (MVP) |
| **Context** | VS Code has Chat / Language Model APIs; ACP needs custom permission and tool streaming |
| **Decision** | Own a Side Bar webview for full control; optionally add Chat participant later |
| **Consequences** | More UI work; better protocol fidelity |

---

## ADR-003: One agent process per extension host workspace window

| | |
|--|--|
| **Status** | Accepted |
| **Context** | Multi-session vs multi-process tradeoffs |
| **Decision** | Default one long-lived process; multiple sessions multiplexed if ACP allows, else sequential session ids on same process |
| **Consequences** | Simpler lifecycle; multi-window = multi-process |

---

## ADR-004: Terminal capability strategy

| | |
|--|--|
| **Status** | Open |
| **Context** | VS Code Terminal API has weak PTY capture vs agent-owned shells |
| **Options** | **A.** Declare `terminal: false`, agent-side tools only<br>**B.** Partial host terminal<br>**C.** Hybrid later |
| **Proposal for L1** | **A** until we validate ACP terminal client contract against VS Code APIs |
| **Consequences** | Shell output stays in tool cards; less IDE-native terminal until L2 |

---

## ADR-005: Binary distribution for MVP

| | |
|--|--|
| **Status** | Accepted |
| **Decision** | PATH + `grok.binaryPath`; no bundled binary in L0/L1 |
| **Consequences** | Install friction; simplest security/review story |

---

## ADR-006: Host FS capabilities enabled in initialize

| | |
|--|--|
| **Status** | Proposed (lean Accept) |
| **Decision** | Advertise `fs.readTextFile` + `fs.writeTextFile` and implement via TextDocument / WorkspaceEdit |
| **Consequences** | Better unsaved-buffer fidelity; must handle size limits and outside-workspace writes |

---

## ADR-007: Permission default ask with timeout deny

| | |
|--|--|
| **Status** | Accepted |
| **Decision** | Never silent-allow; timeout → deny |
| **Consequences** | Safer; long-unattended agents may fail tools |

---

## ADR-008: Multi-root workspace cwd

| | |
|--|--|
| **Status** | Open |
| **Options** | First folder · pick on start · `grok.cwd` only · one process per root |
| **Proposal** | Use `grok.cwd` if set, else first `workspaceFolders[0]`; command to switch |
| **Need before** | L1 acceptance |

---

## ADR-009: Auto-attach editor context

| | |
|--|--|
| **Status** | Accepted |
| **Decision** | Default on for active file + non-empty selection; excludeGlob for secrets |
| **Consequences** | Better answers; privacy settings required |

---

## ADR-010: Language / docs locale

| | |
|--|--|
| **Status** | Accepted |
| **Decision** | Design docs and code comments in **English**; user-facing strings English first (i18n later) |
| **Consequences** | Matches Grok Build upstream docs |

---

## ADR-011: SDK vs hand-rolled JSON-RPC

| | |
|--|--|
| **Status** | Accepted |
| **Decision** | Production uses `@agentclientprotocol/sdk` |
| **Consequences** | Dependency on SDK version; better framing correctness |

---

## Open questions backlog

1. Exact ACP permission method names / shapes as implemented by current
   `agent-client-protocol` crate version used by Grok — verify against
   running binary before coding UI.
2. Whether `session/load` supports listing sessions or only load-by-id
   (affects L2 picker).
3. ~~Product name / publisher id for `package.json`~~ → **Accepted:** publisher `tienpham` (community).
4. Telemetry: extension-side vs agent-only.
5. Minimum `grok` version gate number for first public VSIX.
6. Whether to support `grok agent serve` (WebSocket) for remote agent
   (probably no for MVP).

## Decision log process

When resolving an Open item:

1. Update status to Accepted/Rejected.
2. Note date and rationale.
3. If it changes roadmap, patch [09-roadmap](09-roadmap.md).

---

## Doc set complete — implementation entrypoint

When docs are reviewed:

1. Scaffold extension under `grok-vscode-extension/` (not only `docs/`).
2. Implement **L0** only until acceptance checks pass.
3. Keep this folder updated when ADRs flip.
