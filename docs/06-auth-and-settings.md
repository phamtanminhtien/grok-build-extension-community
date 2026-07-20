# 06 — Auth & Settings

## Auth strategy

The agent process owns authentication with xAI backends. The extension
**orchestrates UX** and passes env / triggers ACP auth methods.

### Priority order (resolve at spawn / first prompt)

1. **SecretStorage API key** (via **Grok Build: Set API Key**)
2. **Environment** `XAI_API_KEY` when `grok.inheritEnvApiKey` is true
3. **Existing CLI auth** at `~/.grok/auth.json` (agent reads automatically)
4. **Interactive login** via browser (`x.ai/auth/*`)

### Secret storage

| Storage                    | Use                                   |
| -------------------------- | ------------------------------------- |
| `SecretStorage` API        | API keys entered in extension         |
| `settings.json` plain text | **Not used** for keys in current code |
| `~/.grok/auth.json`        | CLI OAuth tokens (agent-managed)      |

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
    → SecretStorage prompt
```

### Account / subscription

| Command / UI                                | ACP                                                |
| ------------------------------------------- | -------------------------------------------------- |
| Grok Build: Show Account Info               | `x.ai/auth/info` (+ optional `check_subscription`) |
| Grok Build: Check Subscription              | `x.ai/auth/check_subscription`                     |
| Empty-state “Check subscription” when gated | same                                               |
| Grok Build: Paste Auth Code                 | `x.ai/auth/submit_code`                            |
| Billing usage in chat UI                    | Agent / auth-related responses (parsed in host)    |

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
| Extension API key | VS Code `SecretStorage`                                                         |
| Env key           | `XAI_API_KEY` when `grok.inheritEnvApiKey` is true                              |

The extension watches `~/.grok/auth.json` so a terminal `grok login` /
`grok logout` updates the chat empty-state account line and Sign in / Log out
button without restarting VS Code.

## Configuration surface

All VS Code settings under namespace **`grok`** (from `package.json`).

### Host (VS Code settings)

| Key                                 | Type     | Default                | Description                                                   |
| ----------------------------------- | -------- | ---------------------- | ------------------------------------------------------------- |
| `grok.binaryPath`                   | string   | `""`                   | Absolute path to `grok`; empty = PATH then `~/.grok/bin/grok` |
| `grok.cwd`                          | string   | `""`                   | Override session cwd; empty = first workspace folder          |
| `grok.initializeTimeoutMs`          | number   | `30000`                | Spawn + `initialize` timeout                                  |
| `grok.permissionTimeoutMs`          | number   | `120000`               | Permission dialog auto-deny timeout                           |
| `grok.inheritEnvApiKey`             | boolean  | `true`                 | Pass host `XAI_API_KEY` if no SecretStorage key               |
| `grok.ui.showThoughts`              | boolean  | `true`                 | Show thinking chunks                                          |
| `grok.context.autoAttachActiveFile` | boolean  | `true`                 | Auto-attach active file                                       |
| `grok.context.autoAttachSelection`  | boolean  | `true`                 | Prefer selection when non-empty                               |
| `grok.context.excludeGlob`          | string[] | `.env` / secrets globs | Deny-list for auto-attach                                     |
| `grok.fs.preferOpenBuffers`         | boolean  | `true`                 | Host read prefers unsaved buffers                             |
| `grok.fs.autoSave`                  | boolean  | `true`                 | Save after host write                                         |
| `grok.fs.maxReadBytes`              | number   | `5000000`              | Cap for host reads                                            |

Default exclude:

```json
["**/.env", "**/.env.*", "**/secrets/**", "**/*credential*", "**/*.pem"]
```

### Shared with CLI (`~/.grok/config.toml`)

These are **not** VS Code settings; extension and TUI both read/write them:

| Config key                          | Description                                                                |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `[ui].permission_mode`              | Normal / Auto / Always Approve — mode button, Shift+Tab, `/always-approve` |
| `[models].default`                  | Default model id — model picker, `/model`                                  |
| `[models].default_reasoning_effort` | Default effort — effort UI, `/effort`                                      |

## Env passed to agent

| Variable              | When                            |
| --------------------- | ------------------------------- |
| `XAI_API_KEY`         | If secret / inherit provides it |
| `HOME` / user profile | Inherit                         |
| `PATH`                | Inherit (needed to find tools)  |

## Config files outside VS Code

| Path                     | Role                                          |
| ------------------------ | --------------------------------------------- |
| `~/.grok/config.toml`    | User config (mode, model, effort, …)          |
| `~/.grok/auth.json`      | Auth                                          |
| `~/.grok/sessions/`      | Sessions (resume picker)                      |
| project `AGENTS.md`      | Project rules                                 |
| skills / plugins / hooks | Discovered by agent; Extensions panel manages |

The extension reads/writes shared CLI state:

- **`~/.grok/auth.json`** — login status / empty-state account line.
- **`~/.grok/config.toml`** — permission mode, default model, reasoning effort.
- **`~/.grok/sessions/`** — local history for resume.

## Settings UX

- Contribute configuration in `package.json`.
- Model picker: curated list + free text; persist to config.toml / restart agent when needed.
- Mode / Always Approve: confirm modal before always-approve; write toml.

## Next

→ [07 — Binary Lifecycle](07-binary-lifecycle.md)
