# 09 — Roadmap

Phased delivery. Each phase has **entry criteria**, **scope**, and
**acceptance checks**.

**As of post-0.3.8 (2026-07-20):** L0–L2 core complete; L3 mostly shipped
(Tasks, plan UI, Extensions, rewind, billing, **worktree UI**, min CLI gate,
Remote-SSH/WSL docs). Remaining: terminal hybrid residual, binary packaging,
CI mock-ACP, a11y/security formal sign-off.

## Phase L0 — Protocol wire-up

**Goal:** Prove ACP child process works from a VS Code extension host.

### Scope

- Extension scaffold (`package.json`, tsconfig, esbuild/webpack)
- `ProcessManager` spawn `grok agent stdio`
- `initialize` + `session/new`
- Output channel logging of session updates
- Commands: Open Output, Restart Agent

### Non-scope

- Polished chat UI
- Permissions UI
- Marketplace packaging polish

### Acceptance

- [x] With `grok` on PATH, activate extension and complete `initialize`
- [x] `session/new` returns `sessionId` for open workspace
- [x] A hardcoded test prompt streams `session/update` lines to Output
- [x] Deactivate kills the process
- [x] Missing binary shows actionable error

### Exit artifacts

- [x] Runnable extension in Extension Development Host (`F5`)
- [x] Smoke test script (`npm run smoke:cli` / `yarn smoke:cli`) + [L0 manual test](L0-manual-test.md)

Verified headless 2026-07-16: `initialize` + `session/new` + prompt → `L0 OK` / `PASS`.

---

## Phase L1 — MVP usable chat

**Goal:** Daily-driver minimum for internal dogfood.

### Scope

- Chat webview (send, stream message/thought/tool cards)
- Permission modal (allow / deny / always session)
- Cancel turn
- Context: active file + selection
- Settings: binaryPath, apiKey (SecretStorage); model/effort/permission via config.toml
- Login empty-state + API key path
- Status bar busy indicator
- Host FS read/write capabilities **or** explicit deferral documented if
  terminal/FS negotiation incomplete

### Acceptance

- [x] User can ask “what does this repo do?” and get a streamed answer
- [x] Tool calls appear as cards; file paths open on click
- [x] Permission prompt works end-to-end for a shell tool
- [x] Deny stops the tool path cleanly
- [x] New session clears UI and creates new ACP session
- [x] Restart recovers after killing the binary externally
- [ ] Works on macOS; smoke on Linux and Windows _(macOS verified; Win/Linux TBD)_

### Exit artifacts

- [x] Runnable extension in Extension Development Host (`F5`) + sidebar chat
- [x] Internal VSIX packaging polish (icon, MIT, CHANGELOG, `yarn package`)
- Known limitations: terminal host capability deferred ([ADR-004](10-decisions.md)); binary not bundled; Win/Linux smoke TBD

---

## Phase L2 — IDE-native

**Goal:** Feel like a first-class VS Code agent, not a log viewer.

### Scope

- [x] Diff presentation for edits (snapshots + `vscode.diff` + hunk Accept/Reject)
- [x] Session resume / history list (`~/.grok/sessions` + ACP `session/load`)
- [x] Richer `@` context picker (sticky chips, inline mentions)
- [x] Model QuickPick / popover (settings + config.toml + effort)
- [ ] Better terminal story (per [04](04-host-capabilities.md) / [ADR-004](10-decisions.md))
- [x] `x.ai/auth/*` polished browser login (`get_url`, `submit_code`, `info`, `check_subscription`, `logout`)
- [x] Select `x.ai/session` ops: compact, rewind
- [x] Virtualized message list / performance (windowed DOM + host markdown throttle)
- [x] Remote-SSH/WSL documentation + fixes _(README install matrix; deeper live QA still welcome)_

### Acceptance

- [x] Multi-file edit review via diffs (host FS snapshots + tool-path best effort)
- [x] Resume previous session from picker (capability-gated full load; local history always)
- [x] Browser login works without pre-existing CLI auth (loopback paste via `submit_code` + openExternal)
- [x] No major jank on 30+ message threads (windowed DOM + host markdown throttle)

Spec: [superpowers/specs/2026-07-16-l2-full-polish-design.md](superpowers/specs/2026-07-16-l2-full-polish-design.md)

---

## Phase L3 — Depth & productization

**Goal:** Parity with advanced Grok workflows where IDE UX helps.

### Scope

| Item                                              | Status (v0.3.8)                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Worktree UI (`x.ai/git/worktree/*`)               | **Shipped** — QuickPick + `/worktrees` + status notifications                   |
| Plan mode surface                                 | **Partial** — plan approval UI, `exitPlanMode`, session_notification banners    |
| Subagent / background task visualization          | **Shipped** — Tasks panel, status bar badge, `/tasks`, live subagent transcript |
| Fuzzy open bridge (`x.ai/search/*` → QuickOpen)   | **Not started** as agent bridge; in-chat `@` fuzzy file pick exists             |
| Plugin/skills management UI                       | **Partial** — Extensions panel (hooks, plugins, skills, MCP)                    |
| Binary bundling or first-run download             | **Not started** — PATH + `grok.binaryPath` only                                 |
| Marketplace listing, icons, telemetry policy      | **Partial** — Marketplace/Open VSX live; telemetry policy TBD                   |
| Automated integration tests in CI with mocked ACP | **Partial** — pure unit tests via `yarn test`; no mock-ACP CI yet               |
| Prompt queue (mid-turn follow-ups)                | **Shipped** — TUI-like queue UI + `x.ai/queue/*`                                |
| Images in prompt                                  | **Shipped** — paste, drop, Attach Image…                                        |
| Fix with Grok (diagnostics)                       | **Shipped** — hover / Quick Fix                                                 |
| Billing usage display                             | **Shipped**                                                                     |
| Hunk-tracker Accept/Reject                        | **Shipped**                                                                     |
| Min CLI version gate                              | **Shipped** — `grok.minCliVersion` (default `0.1.0`) + upgrade prompt           |

### Acceptance

- [ ] Product checklist signed off
- [ ] Security productization residual complete ([08](08-security.md) residual list)
- [x] Version gate + upgrade prompts reliable
- [ ] Accessibility pass on chat + permissions

---

## Parallel tracks (any phase)

| Track          | Notes                                                   |
| -------------- | ------------------------------------------------------- |
| Design assets  | Icons, empty-state illustrations                        |
| Docs for users | Install, Remote-SSH, FAQ (root README + this set)       |
| Upstream fixes | File issues against Grok Build if ACP gaps found        |
| Doc sync       | After each release: patch roadmap + ADRs + UI/auth docs |

## Explicitly deferred forever (unless goals change)

- Reimplementing Grok tools in TypeScript
- Embedding the ratatui TUI
- Full clone of TUI keybindings / theme engine

## Suggested next work (priority)

1. **L2 residual** — optional terminal hybrid “Reveal in Terminal” (ADR-004); live Remote-SSH/WSL QA on Win/Linux.
2. **L3 remaining** — fuzzy-open ACP bridge; security/a11y formal sign-off.
3. **CI** — mock ACP integration tests; Win/Linux smoke.
4. **Packaging** — first-run download or bundled binary if install friction dominates.

## Suggested timeline (indicative only)

| Phase | Calendar (1–2 eng) | Reality                  |
| ----- | ------------------ | ------------------------ |
| L0    | 2–4 days           | Done 2026-07-16          |
| L1    | 2–3 weeks          | Done ~0.3.x              |
| L2    | 4–6 weeks          | Core done; residual open |
| L3    | ongoing            | Partial from 0.3.5+      |

## Next

→ [10 — Decisions](10-decisions.md)
