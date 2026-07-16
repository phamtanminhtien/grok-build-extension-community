# 09 — Roadmap

Phased delivery. Each phase has **entry criteria**, **scope**, and
**acceptance checks**. Do not start phase *N+1* features until phase *N*
acceptance passes unless explicitly parallelized.

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
- [x] Smoke test script (`npm run smoke:cli`) + [L0 manual test](L0-manual-test.md)

Verified headless 2026-07-16: `initialize` + `session/new` + prompt → `L0 OK` / `PASS`.

---

## Phase L1 — MVP usable chat

**Goal:** Daily-driver minimum for internal dogfood.

### Scope

- Chat webview (send, stream message/thought/tool cards)
- Permission modal (allow / deny / always session)
- Cancel turn
- Context: active file + selection
- Settings: binaryPath, model, alwaysApprove, apiKey (SecretStorage)
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
- [ ] Works on macOS; smoke on Linux and Windows *(macOS verified; Win/Linux TBD)*

### Exit artifacts

- [x] Runnable extension in Extension Development Host (`F5`) + sidebar chat
- [ ] Internal VSIX packaging polish
- Known limitations: no browser OAuth UI yet (API key + CLI auth), terminal host capability deferred

---

## Phase L2 — IDE-native

**Goal:** Feel like a first-class VS Code agent, not a log viewer.

### Scope

- [x] Diff presentation for edits
- [x] Session resume / history list (`~/.grok/sessions` like TUI + ACP `session/load`)
- [x] Richer `@` context picker
- [x] Model QuickPick (settings + restart; curated list + free text)
- [ ] Better terminal story (per [04](04-host-capabilities.md) decision)
- [ ] `x.ai/auth/*` polished browser login
- [ ] Select `x.ai/session` ops: compact, rewind (if stable)
- [x] Virtualized message list / performance
- [ ] Remote-SSH/WSL documentation + fixes

### Acceptance

- [x] Multi-file edit review via diffs (host FS snapshots + tool-path best effort)
- [x] Resume previous session from picker (capability-gated full load; local history always)
- [ ] Browser login works without pre-existing CLI auth
- [x] No major jank on 30+ message threads (windowed DOM + host markdown throttle)

Spec: [superpowers/specs/2026-07-16-l2-full-polish-design.md](superpowers/specs/2026-07-16-l2-full-polish-design.md)

---

## Phase L3 — Depth & productization

**Goal:** Parity with advanced Grok workflows where IDE UX helps.

### Scope

- Worktree UI (`x.ai/git/worktree/*`)
- Plan mode surface
- Subagent / background task visualization
- Fuzzy open bridge
- Plugin/skills management UI (thin)
- Binary bundling or first-run download
- Marketplace listing, icons, telemetry policy
- Automated integration tests in CI with mocked ACP

### Acceptance

- [ ] Product checklist signed off
- [ ] Security checklist complete ([08](08-security.md))
- [ ] Version gate + upgrade prompts reliable
- [ ] Accessibility pass on chat + permissions

---

## Parallel tracks (any phase)

| Track | Notes |
|-------|-------|
| Design assets | Icons, empty-state illustrations |
| Docs for users | Install, Remote-SSH, FAQ (separate from this design set) |
| Upstream fixes | File issues against Grok Build if ACP gaps found |

## Explicitly deferred forever (unless goals change)

- Reimplementing Grok tools in TypeScript
- Embedding the ratatui TUI
- Full clone of TUI keybindings / theme engine

## Suggested timeline (indicative only)

| Phase | Calendar (1–2 eng) |
|-------|--------------------|
| L0 | 2–4 days |
| L1 | 2–3 weeks |
| L2 | 4–6 weeks |
| L3 | ongoing |

## Next

→ [10 — Decisions](10-decisions.md)
