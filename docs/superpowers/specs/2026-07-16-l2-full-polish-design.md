# Design: L2 Full Polish (Features 1–5)

**Status:** Approved  
**Date:** 2026-07-16  
**Scope:** `grok-vscode-extension` only (TypeScript VS Code host)  
**Depth:** Full polish (option B)

## Summary

Ship five IDE-native capabilities on top of the L1 MVP chat host:

1. **Diff presentation** for multi-file edit review  
2. **Session resume / history** list  
3. **`@` context picker** with sticky chips  
4. **Model QuickPick** from header + command palette  
5. **Markdown render** plus **virtualized** message list  

The agent runtime remains in Rust (`grok agent stdio`). The extension stays a thin ACP client: do not reimplement agent tools, the TUI, or a parallel SCM.

## Goals

- Feel like a first-class VS Code agent, not a log viewer.  
- Meet L2 roadmap acceptance where feasible with current ACP capabilities.  
- Gracefully degrade when the agent does not advertise optional capabilities (`loadSession`, `session/list`, model enumeration).  
- Keep webview thin; keep FS, ACP, settings, and review logic in the extension host.

## Non-goals

- Browser OAuth / polished `x.ai/auth/*` login  
- Host terminal PTY fidelity  
- Worktree UI, plan mode surface, subagent visualization  
- Marketplace VSIX polish / telemetry  
- Reimplementing Grok tools in TypeScript  
- Custom SCM or force accept/reject patch engine  

## Architecture

```
extension.ts
  ├── AgentService           (+ caps, list/load session, model restart)
  ├── DiffReviewService      (snapshots + vscode.diff + multi-file review)
  ├── SessionHistoryStore    (local index + ACP list/load bridge)
  ├── ContextPickerService   (@ menu + sticky chips → ContentBlocks)
  ├── ModelService           (QuickPick + settings write + restart)
  └── ChatViewProvider       (markdown, virtualization, header, chips)
```

### Module responsibilities

| Module | Responsibility |
|--------|----------------|
| `AgentService` | Process lifecycle, initialize, session new/load/list/resume, prompt, cancel; expose negotiated agent capabilities |
| `DiffReviewService` | Pre-edit snapshots, review queue per turn/session, open single/multi diffs via VS Code APIs |
| `SessionHistoryStore` | Persist session metadata; merge with ACP `session/list` when available |
| `ContextPickerService` | `@` sources (files, open editors, selection, folders, recent); sticky chip model |
| `ModelService` | Model list (agent or fallback), QuickPick, write `grok.model`, trigger restart |
| `ChatViewProvider` | Webview shell, streaming UI, sanitized markdown, virtualized list, message bridge |

### Principles

1. **Capability-gated ACP** — call `session/list`, `session/load`, `session/resume`, model enumeration only when advertised in `initialize`.  
2. **Host-owned UX state** — chips, review queue, local history, virtualization window live in extension/webview; agent owns conversation truth when loaded.  
3. **No unsanitized HTML** — assistant markdown must pass a sanitize pipeline before `innerHTML`.  
4. **Vertical slices** — each feature leaves the extension buildable and typecheck-clean.

## Feature designs

### 5 — Markdown + virtualized message list

| Item | Decision |
|------|----------|
| Libraries | `marked` + `DOMPurify` (bundled; no remote CDN scripts) |
| Flavor | GFM: headings, lists, tables, fenced code, inline code, links |
| Code blocks | Copy button; path-like tokens may post `openFile` |
| Sanitize | Strip scripts/event handlers; allow safe tag set only |
| Streaming | Re-render assistant bubble on chunks with ~50ms throttle |
| Virtualization | Windowed DOM: ~40 message nodes around viewport; full message array in memory; auto-scroll when user is near bottom |
| User messages | Plain/escaped text (not full markdown), chips unchanged |
| CSP | Strict: `script-src` nonce only; local styles/fonts |

**Acceptance**

- [ ] Fenced code, lists, and links render correctly  
- [ ] XSS-style payload from assistant text is stripped  
- [ ] 50 messages: scroll remains responsive; DOM message node count stays bounded (~50)  

### 3 — `@` context picker

| Item | Decision |
|------|----------|
| Triggers | Type `@` in composer; toolbar `@` button; existing add-file/selection commands |
| Sources | Workspace files (fuzzy), open editors, current selection, folder resource links, recent chips |
| Sticky chips | Shown above composer; removable via ×; survive across prompts until cleared |
| Send path | `buildPromptBlocks(text, { stickyChips, autoAttach? })` merges sticky chips + optional auto-attach settings |
| Keyboard | `@` opens popup; filter fuzzy; Enter/Tab select; Esc close; multi-add supported |
| Exclusions | Honor `grok.context.excludeGlob` |

**Files (planned)**

- `src/context/contextPicker.ts`  
- Extend `src/context/editorContext.ts`  
- Composer chip state in `ChatViewProvider`  

**Acceptance**

- [ ] User can attach two files + one selection, remove one chip, send  
- [ ] Prompt content blocks include matching `resource_link` entries  
- [ ] Excluded globs are not attachable via picker  

### 4 — Model QuickPick

| Item | Decision |
|------|----------|
| Command | `grok.selectModel` (palette + clickable header model) |
| List source | Prefer agent-advertised models when available; else curated fallback + free-text “Other…” |
| Persist | Update `grok.model` (Global configuration) |
| Apply | Restart agent process so spawn args include `--model` (existing ProcessManager path) |
| Busy guard | If a turn is in progress, confirm cancel/restart before applying |
| Surfaces | Chat header `model ▾`, status bar model label |

**Files (planned)**

- `src/config/modelService.ts`  
- Wire in `extension.ts`, header in webview  

**Acceptance**

- [ ] Selecting a model updates `grok.model`  
- [ ] Agent restarts and subsequent sessions use the new model arg  
- [ ] Header and status bar show the selected model  

### 1 — Diff presentation (multi-file review)

| Item | Decision |
|------|----------|
| Snapshot timing | Before host `fs/write_text_file`; best-effort on edit-like `tool_call` start (path list) |
| Storage | In-memory map path → old text (size-capped); optional weak session scoping |
| Diff open | `vscode.diff` with left = snapshot virtual document (`grok-diff:` content provider), right = workspace file/buffer |
| Tool cards | “Open Diff” per path; “Open All Diffs” when multiple |
| Multi-file UI | Review section in chat and/or TreeView `grok.editReview`; click opens diff |
| Agent-side disk tools | If no pre-content: fall back to open file only (no fake empty diff) |
| Non-goal | Custom SCM, accept/reject patch engine |

**Files (planned)**

- `src/diff/diffReviewService.ts`  
- `src/diff/snapshotContentProvider.ts`  
- Hook `hostFs.writeTextFileHost` / tool updates  

**Acceptance**

- [ ] After a host-mediated edit, Open Diff shows before/after  
- [ ] Multi-file turn populates review list; each entry opens a diff  
- [ ] Missing baseline does not crash; falls back cleanly  

### 2 — Session resume / history

| Item | Decision |
|------|----------|
| Local index | Workspace/global state entries: `sessionId`, `cwd`, `title`, `updatedAt`, `preview`, `messageCount` |
| When written | On `session/new`, turn end, successful load, title/preview updates |
| List UI | Command `grok.resumeSession`; header History; webview history drawer with search |
| Merge | If agent has `sessionCapabilities.list`, merge ACP list with local index (prefer richer metadata) |
| Load order | (1) `session/load` if `loadSession` (2) else `session/resume` if advertised (3) else best-effort by id with clear warning |
| After load | Clear current UI; replay history via session updates into message model; virtualization handles length |
| New session | Persist current entry before clearing UI and calling `session/new` |
| Delete | Remove local entry; call `session/delete` when capability exists |

**Files (planned)**

- `src/session/sessionHistoryStore.ts`  
- `AgentService.listSessions` / `loadSession` / capability storage  

**Acceptance**

- [ ] History shows previous sessions after dogfood turns  
- [ ] Resume/load restores transcript when ACP supports load  
- [ ] Without load capability, UI explains limitation and offers best-effort path  

## UI shell

```
┌ Session ▾ · Model ▾ · History · ··· ┐
│ [virtualized message list]            │
│  markdown · thoughts · tool cards     │
│  [Review edits: N files]              │
├───────────────────────────────────────┤
│ [chip ×] [chip ×]                     │
│ [@] [textarea …]                      │
│ Stop · New · Send                     │
└───────────────────────────────────────┘
```

### New / extended commands

| Command | Purpose |
|---------|---------|
| `grok.selectModel` | Model QuickPick |
| `grok.resumeSession` | Session history picker |
| `grok.reviewEdits` | Focus multi-file edit review |
| `grok.addContext` | Open `@` context picker |

Existing commands (`newSession`, `cancel`, add file/selection, etc.) remain.

## Data flow

```
User @file → sticky chips → send → ContentBlock[] → session/prompt
                                                    ↓
                                            session/update stream
                                                    ↓
                          ChatView (md + tools) + DiffReview (paths/snapshots)

User History → SessionHistoryStore ± ACP list → load/resume → replay → UI
User Model   → settings(grok.model) → AgentService.restart → new process args
```

## Implementation order

1. Markdown + virtualization  
2. `@` context picker  
3. Model QuickPick  
4. Diff review  
5. Session history / resume  
6. Docs/README roadmap status updates  

Each slice must leave `npm run typecheck` and `npm run build` green.

## Testing strategy

| Layer | Approach |
|-------|----------|
| Typecheck / build | Required after every slice |
| Manual F5 | Primary UX verification in Extension Development Host |
| Smoke CLI | Existing `npm run smoke:cli` for agent wire-up regressions |
| Unit (optional follow-up) | Pure helpers: sanitize fixtures, history merge, snapshot cap |

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent lacks `loadSession` / `list` | Resume incomplete | Local history + clear UX; capability gating |
| Agent writes files without host FS | No reliable before-text | Snapshot on tool_call when path known; else open-only |
| Markdown libs + CSP | Bundle size / CSP breaks | Bundle into extension; no remote script; nonce CSP |
| Virtualization bugs | Missing messages / jumpiness | Keep full model in memory; only window DOM; tests with 50 msgs |
| Model list unavailable | Empty picker | Curated fallback + free text |
| Large snapshots | Memory pressure | Per-file size cap; drop oldest snapshots |

## Open decisions (resolved for this pass)

| Topic | Choice |
|-------|--------|
| Depth | Full polish (B) |
| Markdown stack | `marked` + `DOMPurify` |
| Diff left side | Virtual `grok-diff:` documents from snapshots |
| History storage | VS Code `workspaceState` / `globalState` index + ACP when available |
| Model apply | Restart agent process |

## Success criteria (aggregate)

- [ ] Multi-file edit review via diffs works for host-mediated writes  
- [ ] Resume previous session from picker when agent supports load; history always lists local dogfood sessions  
- [ ] `@` context picker + sticky chips enrich prompts correctly  
- [ ] Browser-like model selection without hand-editing settings JSON  
- [ ] Markdown chat + no major jank on 30+ message threads  
- [ ] Roadmap L2 items 1–5 reflected in README/docs as implemented (with noted capability caveats)

## References

- [09 — Roadmap](../../09-roadmap.md)  
- [05 — UI & UX](../../05-ui-ux.md)  
- [03 — ACP Integration](../../03-acp-integration.md)  
- [04 — Host Capabilities](../../04-host-capabilities.md)  
- [06 — Auth and Settings](../../06-auth-and-settings.md)  
