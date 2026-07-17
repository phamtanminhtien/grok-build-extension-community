# 06 — Auth & Settings

## Auth strategy

The agent process owns authentication with xAI backends. The extension
**orchestrates UX** and passes env / triggers ACP auth methods.

### Priority order (resolve at spawn / first prompt)

1. **VS Code setting** `grok.apiKey` (secret storage preferred — see below)
2. **Environment** `XAI_API_KEY` inherited if user opts in
3. **Existing CLI auth** at `~/.grok/auth.json` (agent reads automatically)
4. **Interactive login** via browser / device code (`x.ai/auth/*` or agent flow)

### Secret storage

| Storage                    | Use                                     |
| -------------------------- | --------------------------------------- |
| `SecretStorage` API        | API keys entered in extension           |
| `settings.json` plain text | **Discouraged** for keys; if used, warn |
| `~/.grok/auth.json`        | CLI OAuth tokens (agent-managed)        |

Never log secret values. Never send keys to the webview via unsanitized
message posts without need.

### Login command flow

```
User: Grok Build: Login  (or /login, or empty-state Sign in)
  → QuickPick: browser OAuth | Set API key
  Browser path (ACP, pager-aligned):
    1. ensure agent started (initialize + session/new)
    2. authenticate(methodId=grok.com|oidc, _meta.force_interactive=true)
    3. concurrent x.ai/auth/get_url → vscode.env.openExternal(https only)
    4. if mode is loopback (or unknown): InputBox paste → x.ai/auth/submit_code
       (also: command “Paste Auth Code” if the box was dismissed)
    5. wait for authenticate; x.ai/auth/info + check_subscription
    6. toast + empty-state profile / gate banner
  API key path:
    → SecretStorage prompt (existing)
```

### Account / subscription

| Command / UI                                | ACP                                                |
| ------------------------------------------- | -------------------------------------------------- |
| Grok Build: Show Account Info               | `x.ai/auth/info` (+ optional `check_subscription`) |
| Grok Build: Check Subscription              | `x.ai/auth/check_subscription`                     |
| Empty-state “Check subscription” when gated | same                                               |
| Grok Build: Paste Auth Code                 | `x.ai/auth/submit_code`                            |

### Logout

```
User: Grok Build: Logout  (or empty-state Log out, or /logout)
  → confirm modal (explains CLI session + SecretStorage clear)
  → x.ai/auth/logout when agent reachable (clears ~/.grok/auth.json)
  → clear SecretStorage API key
  → stop agent process
  → toast (email if known; warn if XAI_API_KEY env still set)
  → empty-state CTA flips back to Sign in
```

Do not delete `~/.grok` recursively from the extension.

### Sync with CLI

Extension and CLI share one account store:

| Source            | Path / store                                                                    |
| ----------------- | ------------------------------------------------------------------------------- |
| OAuth session     | `~/.grok/auth.json` (agent `x.ai/auth/*`, same as `grok login` / `grok logout`) |
| Extension API key | VS Code `SecretStorage` (`grok.apiKey`)                                         |
| Env key           | `XAI_API_KEY` when `grok.inheritEnvApiKey` is true                              |

The extension watches `~/.grok/auth.json` so a terminal `grok login` /
`grok logout` updates the chat empty-state account line and Sign in / Log out
button without restarting VS Code.

## Configuration surface

All settings under namespace **`grok`**.

### Core

| Key                   | Type     | Default | Description                                  |
| --------------------- | -------- | ------- | -------------------------------------------- |
| `grok.binaryPath`     | string   | `""`    | Absolute path to `grok`; empty = PATH lookup |
| `grok.cwd`            | string   | `""`    | Override workspace cwd; empty = folder root  |
| `grok.agentExtraArgs` | string[] | `[]`    | Extra args before `stdio` (validated)        |

These live in `~/.grok/config.toml` (shared with CLI/TUI), **not** VS Code settings:

| Config key                          | Description                                                     |
| ----------------------------------- | --------------------------------------------------------------- |
| `[ui].permission_mode`              | Normal / Auto / Always Approve — mode button, `/always-approve` |
| `[models].default`                  | Default model id — model picker, `/model`                       |
| `[models].default_reasoning_effort` | Default effort — effort picker, `/effort`                       |

### Auth

| Key                     | Type    | Default | Description                               |
| ----------------------- | ------- | ------- | ----------------------------------------- |
| `grok.apiKey`           | string  | `""`    | Prefer SecretStorage UI over this         |
| `grok.inheritEnvApiKey` | boolean | `true`  | Pass `XAI_API_KEY` from parent env if set |

### FS host

| Key                         | Type    | Default   | Description             |
| --------------------------- | ------- | --------- | ----------------------- |
| `grok.fs.preferOpenBuffers` | boolean | `true`    | Read open editors first |
| `grok.fs.autoSave`          | boolean | `true`    | Save after host write   |
| `grok.fs.maxReadBytes`      | number  | `5000000` | Cap for host reads      |

### UI

| Key                                 | Type           | Default   | Description                     |
| ----------------------------------- | -------------- | --------- | ------------------------------- |
| `grok.ui.showThoughts`              | boolean        | `true`    | Show thinking chunks            |
| `grok.ui.fontSize`                  | number \| null | `null`    | Override webview font           |
| `grok.context.autoAttachActiveFile` | boolean        | `true`    | Attach active file to prompts   |
| `grok.context.autoAttachSelection`  | boolean        | `true`    | Attach selection when non-empty |
| `grok.context.excludeGlob`          | string[]       | see below | Deny-list globs                 |

Default exclude suggestions:

```json
["**/.env", "**/.env.*", "**/secrets/**", "**/*credential*", "**/*.pem"]
```

### Diagnostics

| Key                         | Type    | Default | Description                        |
| --------------------------- | ------- | ------- | ---------------------------------- |
| `grok.logging.logRpc`       | boolean | `false` | Log method names (not full bodies) |
| `grok.logging.logRpcBodies` | boolean | `false` | Verbose; redaction required        |

## Env passed to agent

| Variable              | When                                    |
| --------------------- | --------------------------------------- |
| `XAI_API_KEY`         | If secret/setting/inherit provides it   |
| `HOME` / user profile | Inherit                                 |
| `PATH`                | Inherit (needed to find tools)          |
| `GROK_*`              | Inherit selectively; document allowlist |

Strip known noisy or dangerous overrides only when necessary. Do not pass
the entire unsanitized env if product security review requires a allowlist
(decision TBD).

## Config files outside VS Code

The agent continues to honor Grok config:

| Path                  | Role                |
| --------------------- | ------------------- |
| `~/.grok/config.toml` | User config         |
| `~/.grok/auth.json`   | Auth                |
| `~/.grok/sessions/`   | Sessions            |
| project `AGENTS.md`   | Project rules       |
| skills / plugins      | Discovered by agent |

The extension reads/writes these for shared CLI state:

- **`~/.grok/auth.json`** — login status / empty-state account line.
- **`~/.grok/config.toml` `[ui].permission_mode`** — permission mode (Normal / Auto / Always Approve), same keys and precedence as the TUI (`permission_mode` > legacy `approval_mode` > legacy `yolo`). Shift+Tab and `/always-approve` persist here so CLI and extension stay aligned.
- **`~/.grok/config.toml` `[models].default` / `default_reasoning_effort`** — default model and reasoning effort; model/effort UI and `/model` persist here like the TUI.

Other exceptions:

- Optional “open config folder” command.
- Version / login detection heuristics.

## Settings UX

- Contribute configuration in `package.json`.
- Provide a thin **Grok: Open Settings** command filtering `@ext:…`.
- Model picker: QuickPick fed by agent model list when available; else free
  text setting.

## Next

→ [07 — Binary Lifecycle](07-binary-lifecycle.md)
