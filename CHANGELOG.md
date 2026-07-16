# Changelog

All notable changes to **Grok Build - Community** are documented in this file.

## [0.3.1] — 2026-07-16

### Packaging / release readiness

- Marketplace metadata: MIT license, 128×128 icon, gallery banner, `qna`
- User-facing install notes in README (CLI prerequisite, auth, Remote-SSH)
- Security minimums: Workspace Trust gate, confirm when enabling `alwaysApprove`, explicit `shell: false` on agent spawn
- Fix TypeScript errors in interactive question option parsing
- Add `vsce` devDependency and `publish:vsce` script

### Auth UX

- Empty state shows **Log out** when signed in (not only Sign in)
- Login/logout share CLI session store (`~/.grok/auth.json`); UI watches the file so terminal `grok login` / `grok logout` stay in sync

## [0.3.0] — 2026-07-16

### Features

- L2 IDE polish: markdown chat, `@` context picker, model QuickPick, diff review, session resume/history
- Browser login/logout via ACP (aligned with CLI)
- Extensions panel (hooks / plugins / marketplace / skills / MCPs)
- Secondary Side Bar support (VS Code ≥ 1.106)
- Slash commands (host + agent pass-through)

### Known limitations

- Requires separate Grok Build CLI (`grok` on PATH or `grok.binaryPath`)
- Linux / Windows smoke incomplete vs macOS
- Binary not bundled in the VSIX
