# 08 — Security

## Threat model (summary)

| Threat | Mitigation |
|--------|------------|
| Malicious workspace tricks agent into harmful commands | Permission prompts; sandbox (agent); workspace trust |
| Extension auto-allows tools | Default `alwaysApprove=false`; clear UX warnings |
| Secret exfiltration via prompt context | excludeGlob; no auto-attach `.env` |
| Secret leakage in logs / webview | Redaction; SecretStorage; minimal RPC body logging |
| Arg injection via settings | Validate `agentExtraArgs`; no shell interpolation |
| Supply chain (deps / binary) | Lockfiles; checksums if bundling; official install only |
| Prompt injection in webview HTML | Markdown sanitize; no raw HTML from model |

## Workspace Trust

- Honor VS Code **Workspace Trust**.
- In restricted mode: disable agent spawn or force read-only profile if
  agent supports it; otherwise refuse to start with explanation.

## Permissions

Default posture: **ask**.

| Mode | Behavior |
|------|----------|
| Ask (default) | Modal for tool permission requests |
| Session always | Remember allow rules until restart |
| Always approve | Setting or `--always-approve`; confirm on enable |

### Timeout

If user ignores a permission dialog for `T` seconds (default 300):

- Respond **deny**.
- Toast: “Grok tool request timed out and was denied.”

### YOLO confirmation

Enabling `grok.alwaysApprove` requires a modal:

> This allows Grok to run tools and edit files without asking. Continue?

## Path safety

- Normalize paths; reject null bytes.
- For host writes outside workspace: extra confirm (setting
  `grok.fs.allowWriteOutsideWorkspace` default false).
- Symlink surprise: rely on VS Code FS API + agent sandbox where enabled.

## Webview security

- `localResourceRoots` limited to extension media.
- No `unsafe-inline` beyond what VS Code webview requires; prefer nonce CSP.
- `postMessage` protocol: typed commands only; validate direction
  (webview → host allowlist).
- Do not expose Node `fs` or arbitrary command execution to webview scripts.

## Secrets

| Do | Don't |
|----|-------|
| Store API keys in SecretStorage | Commit keys; put in plain settings without warning |
| Redact `xai-` / bearer tokens in logs | Log full RPC bodies by default |
| Pass key via env to child only | Echo key into chat history |

## Child process

- Spawn without shell (`shell: false`).
- Args as array.
- Do not run `eval` on agent output.
- Agent tools that execute shell are **inside agent policy**, still gated by
  permissions when not in yolo mode.

## Network

- Extension should not open arbitrary network connections for agent work.
- Browser login uses `env.openExternal` to known auth URLs only when
  possible; if agent returns URL, validate scheme `https:`.

## Telemetry & feedback

- Default: follow product policy (likely opt-in or agent-side only).
- If extension adds telemetry, document events and provide disable switch.
- Feedback via agent `x.ai` methods must not include secrets.

## Security checklist before release

- [ ] Workspace Trust honored
- [ ] alwaysApprove defaults false + confirm
- [ ] Permission timeout deny
- [ ] SecretStorage for keys
- [ ] CSP on webview
- [ ] spawn without shell
- [ ] binary path cannot execute through `sh -c`
- [ ] no full RPC body logging by default
- [ ] remote/WSL documented (binary on remote)

## Next

→ [09 — Roadmap](09-roadmap.md)
