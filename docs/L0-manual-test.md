# L0 Manual Test

## Prerequisites

- Node 20+
- `grok` on PATH (or set `grok.binaryPath`)
- Authenticated CLI (`grok` login / existing `~/.grok` credentials)

## Build

```bash
cd grok-vscode-extension
npm install
npm run build
npm run typecheck
```

## Headless smoke (no VS Code)

```bash
npm run smoke:cli
```

Expect: `initialize` + `sessionId` + streamed text + `PASS`.

## Extension Development Host

1. Open this folder in VS Code / Cursor.
2. `F5` (or Run and Debug → **Run Extension**).
3. In the new window: **Command Palette** → run:
   - `Grok Build: Open Output`
   - `Grok Build: Start Agent` — expect session id toast + logs
   - `Grok Build: Smoke Test (L0)` — expect streamed reply in Output
   - `Grok Build: Stop Agent` — process should exit
4. Reload window / close Extension Host — process must not linger (`pgrep -fl 'grok agent'`).

## Acceptance checklist

- [ ] With `grok` on PATH, activate and complete `initialize`
- [ ] `session/new` returns `sessionId` for open workspace
- [ ] Smoke prompt streams `session/update` lines to Output
- [ ] Deactivate kills the process
- [ ] Missing binary shows actionable error (rename binary or set bad `grok.binaryPath`)
