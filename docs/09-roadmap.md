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

- [ ] With `grok` on PATH, activate extension and complete `initialize`
- [ ] `session/new` returns `sessionId` for open workspace
- [ ] A hardcoded test prompt streams `session/update` lines to Output
- [ ] Deactivate kills the process
- [ ] Missing binary shows actionable error

### Exit artifacts

- Runnable extension in Extension Development Host
- Smoke test script or manual test doc

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

- [ ] User can ask “what does this repo do?” and get a streamed answer
- [ ] Tool calls appear as cards; file paths open on click
- [ ] Permission prompt works end-to-end for a shell tool
- [ ] Deny stops the tool path cleanly
- [ ] New session clears UI and creates new ACP session
- [ ] Restart recovers after killing the binary externally
- [ ] Works on macOS; smoke on Linux and Windows

### Exit artifacts

- Internal VSIX or `F5` dogfood guide
- Known limitations list

---

## Phase L2 — IDE-native

**Goal:** Feel like a first-class VS Code agent, not a log viewer.

### Scope

- Diff presentation for edits
- Session resume / history list
- Richer `@` context picker
- Model QuickPick from agent
- Better terminal story (per [04](04-host-capabilities.md) decision)
- `x.ai/auth/*` polished browser login
- Select `x.ai/session` ops: compact, rewind (if stable)
- Virtualized message list / performance
- Remote-SSH/WSL documentation + fixes

### Acceptance

- [ ] Multi-file edit review via diffs
- [ ] Resume previous session from picker
- [ ] Browser login works without pre-existing CLI auth
- [ ] No major jank on 30+ message threads

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
