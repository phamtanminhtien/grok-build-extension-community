# 07 — Binary Lifecycle

## Responsibility

The extension must locate a compatible `grok` binary, spawn it as
`grok agent … stdio`, supervise it, and recover from failures.

## Resolution order

```
1. grok.binaryPath setting (if non-empty and executable)
2. Bundled binary for platform/arch (if packaging includes one)
3. PATH lookup: `grok` (and Windows `grok.exe`)
4. Common install locations (optional fallbacks):
   - ~/.grok/bin/grok
   - /usr/local/bin/grok
   - platform-specific install docs paths
```

On failure: show empty-state with install instructions (curl/irm from
upstream README) and a button to set `grok.binaryPath`.

## Version compatibility

| Check | When |
|-------|------|
| `grok --version` | Before first spawn (cache result) |
| Semver / minimum version | Compare to `engines.grok` in package.json or const |
| Protocol | `initialize` negotiation |

If binary too old:

- Block with message: upgrade via `grok update` or reinstall.
- Do not attempt unknown protocol dialects.

Document minimum Grok version in release notes when extension ships.

## Spawn specification

```ts
spawn(binary, args, {
  cwd: processCwd,          // often workspace root
  env: buildEnv(),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
})
```

### Args construction

```
[ "agent", ...optionalFlags, "stdio" ]
```

Examples:

```
grok agent stdio
grok agent --model grok-build stdio
grok agent --always-approve stdio
```

Validate `grok.agentExtraArgs`:

- Allow only safe flag patterns.
- Reject shell metacharacters / nested commands.
- Prefer structured settings over raw args when a first-class setting exists.

### Stderr

- Pipe stderr to Output channel (throttled).
- On non-zero exit, include last N lines in error toast.

### Stdin

- Keep open for process lifetime.
- Mutex write lines ending in `\n`.
- Never close stdin for “end of input” mid-session.

## Supervision

| Event | Action |
|-------|--------|
| Unexpected exit | State → errored; UI banner; offer Restart |
| Spawn error (ENOENT) | Binary missing flow |
| Hang (no initialize response) | Timeout (e.g. 30s) → kill → error |
| User Restart | SIGTERM → wait → SIGKILL → respawn → re-initialize |
| Extension deactivate | Graceful shutdown sequence |

### Shutdown sequence

```
1. Cancel active turn if possible
2. Close client cleanly if protocol supports
3. proc.kill("SIGTERM")  // Windows: taskkill / terminate
4. After grace (2–5s): force kill
5. Dispose listeners
```

## Packaging strategies

| Strategy | Pros | Cons | Phase |
|----------|------|------|-------|
| **PATH-only** | Simple | Friction for new users | MVP OK |
| **Document install script** | Official binaries | Extra step | MVP |
| **Bundle binary in VSIX** | One-click | Large VSIX; update matrix; licensing | L2 |
| **Download on first run** | Smaller VSIX | Network, trust, code sign | L2–L3 |

MVP recommendation: **PATH + `binaryPath` + install deep-link**.  
Bundling deferred until product packaging decision.

## Platform matrix

| Platform | Arch | Notes |
|----------|------|-------|
| macOS | arm64, x64 | Primary |
| Linux | x64, arm64 | Primary |
| Windows | x64 | Agent has Windows stdin hardening; test early |

Remote / WSL / SSH:

- Extension host runs **remotely** when using Remote-SSH/WSL.
- Binary must exist **on the remote** side.
- Document: install `grok` in the remote environment, not only local Mac.

## Auto-update

- Extension updates via VS Code marketplace / sideload.
- Binary updates via `grok update` or reinstall — extension may prompt when
  version gate fails.
- Do not silent-download binaries without user consent.

## Health check command

`Grok: Restart Agent` and optional `Grok: Doctor`:

1. Resolve binary
2. Print version
3. Spawn initialize round-trip
4. Report cwd, model, auth present (boolean only)

## Next

→ [08 — Security](08-security.md)
