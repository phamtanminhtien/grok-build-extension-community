# 07 — Binary Lifecycle

## Responsibility

The extension must locate a compatible `grok` binary, spawn it as
`grok agent … stdio`, supervise it, and recover from failures.

## Resolution order

```
1. grok.binaryPath setting (if non-empty and executable)
2. PATH lookup: `grok` (and Windows `grok.exe`)
3. Fallback: ~/.grok/bin/grok
```

Bundled binary / first-run download: **not implemented** (see [ADR-005](10-decisions.md)).

On failure: show empty-state with install instructions and a path to set
`grok.binaryPath` (blocks agent use until CLI is available).

## Version compatibility

| Check          | When                     |
| -------------- | ------------------------ |
| Binary resolve | Before spawn             |
| Protocol       | `initialize` negotiation |

**Hard minimum-version gate:** enforced via `grok.minCliVersion` (default
`0.1.0`). On spawn, `grok --version` is parsed for the first `MAJOR.MINOR.PATCH`
and compared to the floor. Below-min blocks with upgrade prompt (copy install
command / docs / open setting). Empty / `off` / `0` disables the gate.
Unparseable version strings are allowed (warn only) so a hung/unknown probe
does not brick the host.

## Spawn specification

```ts
spawn(binary, args, {
  cwd: processCwd, // often workspace root
  env: buildEnv(),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
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

Flags are built from structured settings / config.toml (model, permission
mode), not free-form shell strings.

### Stderr

- Pipe stderr to Output channel (throttled).
- On non-zero exit, include last N lines in error toast.

### Stdin

- Keep open for process lifetime.
- Mutex write lines ending in `\n`.
- Never close stdin for “end of input” mid-session.

## Supervision

| Event                         | Action                                             |
| ----------------------------- | -------------------------------------------------- |
| Unexpected exit               | State → errored; UI banner; offer Restart          |
| Spawn error (ENOENT)          | Binary missing flow                                |
| Hang (no initialize response) | Timeout (e.g. 30s) → kill → error                  |
| User Restart                  | SIGTERM → wait → SIGKILL → respawn → re-initialize |
| Extension deactivate          | Graceful shutdown sequence                         |

### Shutdown sequence

```
1. Cancel active turn if possible
2. Close client cleanly if protocol supports
3. proc.kill("SIGTERM")  // Windows: taskkill / terminate
4. After grace (2–5s): force kill
5. Dispose listeners
```

## Packaging strategies

| Strategy                        | Pros                  | Cons                      | Phase         |
| ------------------------------- | --------------------- | ------------------------- | ------------- |
| **PATH + binaryPath** (current) | Simple security story | Install friction          | **0.3.x**     |
| **Document install**            | Official binaries     | Extra step                | Done (README) |
| **Bundle binary in VSIX**       | One-click             | Large VSIX; update matrix | L3 open       |
| **Download on first run**       | Smaller VSIX          | Network, trust, code sign | L3 open       |

Current recommendation remains **PATH + `binaryPath`**.

## Platform matrix

| Platform | Arch       | Notes                                         |
| -------- | ---------- | --------------------------------------------- |
| macOS    | arm64, x64 | Primary                                       |
| Linux    | x64, arm64 | Primary                                       |
| Windows  | x64        | Agent has Windows stdin hardening; test early |

Remote / WSL / SSH:

- Extension host runs **remotely** when using Remote-SSH/WSL.
- Binary must exist **on the remote** side.
- Document: install `grok` in the remote environment, not only local Mac.

## Auto-update

- Extension updates via VS Code marketplace / sideload.
- Binary updates via `grok update` or reinstall — extension may prompt when
  version gate fails.
- Do not silent-download binaries without user consent.

## Health / recovery commands

| Command                       | Role                              |
| ----------------------------- | --------------------------------- |
| `Grok Build: Start Agent`     | Explicit spawn                    |
| `Grok Build: Restart Agent`   | SIGTERM → respawn → re-initialize |
| `Grok Build: Stop Agent`      | Tear down process                 |
| `Grok Build: Open Output`     | Diagnostics channel               |
| `Grok Build: Smoke Test (L0)` | Dev round-trip                    |

Optional **Doctor** (version + cwd + auth boolean report) is not shipped yet.

## Next

→ [08 — Security](08-security.md)
