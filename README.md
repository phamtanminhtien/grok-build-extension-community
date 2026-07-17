# Grok Build Community Edition

Community VS Code host for **Grok Build**: a thin TypeScript client
that speaks **ACP** to `grok agent stdio`. The agent runtime stays in Rust.

| Phase                       | Status         |
| --------------------------- | -------------- |
| Design docs                 | Done (`docs/`) |
| L0 — Protocol wire-up       | Done           |
| L1 — MVP chat               | Done           |
| L2 — IDE-native polish      | Implemented    |
| L3 — Depth & productization | Not started    |

> Do not reimplement the agent. Spawn `grok agent stdio`, speak ACP, map VS Code primitives.

---

## Install (users)

| Store                              | Link                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **VS Code Marketplace**            | [tienpham.grok-build-community-edition](https://marketplace.visualstudio.com/items?itemName=tienpham.grok-build-community-edition) |
| **Open VSX** (Cursor, VSCodium, …) | [tienpham/grok-build-community-edition](https://open-vsx.org/extension/tienpham/grok-build-community-edition)                      |

Or in the editor: Extensions → search **“Grok Build Community Edition”** (publisher `tienpham`).

### Prerequisites

1. **VS Code** 1.93+ (Secondary Side Bar chat tab needs **≥ 1.106**)
2. **Grok Build CLI** (`grok`) on your `PATH`, **or** set `grok.binaryPath` to the absolute path
3. **Auth**: CLI login (`grok login` / `~/.grok`) **or** **Grok Build: Set API Key** / **Login** in the extension

The VSIX does **not** bundle the `grok` binary. Install the CLI first on the machine that runs the extension host (local, or the **remote** side of SSH/WSL).

### From VSIX (sideload)

```bash
# In this repo
cd grok-vscode-extension
yarn install
yarn package   # → grok-build-community-edition-0.3.1.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…** and pick the `.vsix`.

### First run

1. Open a **trusted** workspace (Workspace Trust is required to start the agent)
2. Open chat: **Grok Build: Open Chat** (or the activity bar / secondary sidebar icon)
3. If the agent is not running: **Grok Build: Start Agent**
4. Type a prompt and Send (active file / selection attach by default)

### Remote-SSH / WSL

The extension host runs **on the remote**. Install `grok` **on the remote**, not only on your local Mac/PC. Set `grok.binaryPath` to the remote path if needed.

### Troubleshooting

| Symptom               | What to try                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| Binary not found      | Install CLI; set `grok.binaryPath`; check Output → **Grok Build**       |
| Workspace not trusted | Command Palette → **Manage Workspace Trust**                            |
| Auth / 401            | **Grok Build: Login** or **Set API Key**; or `grok login` in a terminal |
| Stuck / hung agent    | **Grok Build: Restart Agent**                                           |

---

## Develop

```bash
cd grok-vscode-extension
yarn install
yarn build
yarn typecheck
yarn test
```

### Headless L0 smoke (no VS Code)

```bash
yarn smoke:cli   # requires `grok` on PATH
```

### Extension Development Host

1. Open this folder in VS Code / Cursor
2. Press **F5** (Run Extension)
3. **Activity Bar** (left) and/or **Secondary Side Bar** (right, VS Code ≥ 1.106)
4. Send a prompt

Full checklist: `docs/L0-manual-test.md`

### Package / publish

```bash
yarn package          # local .vsix (grok-build-community-edition-<version>.vsix)
# yarn publish:ovsx   # Open VSX first (needs OVSX_PAT)
# yarn publish:vsce   # VS Code Marketplace (needs VSCE_PAT / vsce login)
```

**Automated release ([release-please](https://github.com/googleapis/release-please)):**

Flow on every push to `main` (workflow **Release Please**):

1. Opens/updates a **Release PR** (version bump + `CHANGELOG.md`) from [conventional commits](https://www.conventionalcommits.org/)
2. You **merge** that PR
3. release-please creates tag `vX.Y.Z` + GitHub Release
4. Same workflow’s **Publish** job packages the VSIX, attaches it to the release, and (if secrets are set) publishes to:
   1. [Open VSX](https://open-vsx.org/) (`ovsx`) — first
   2. [VS Code Marketplace](https://marketplace.visualstudio.com/) (`vsce`)

Use commit prefixes: `feat:`, `fix:`, `feat!:` / `BREAKING CHANGE:`.  
`chore:` / `ci:` alone usually do **not** open a version bump.

**Secrets** (repo → Settings → Secrets → Actions):

| Secret     | Purpose                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `OVSX_PAT` | Token from [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens) (published first) |
| `VSCE_PAT` | Azure DevOps PAT with **Marketplace** (Acquire + Publish) for publisher `tienpham`                          |

---

## Commands

| Command                            | Action                                          |
| ---------------------------------- | ----------------------------------------------- |
| `Grok Build: Open Chat`            | Focus sidebar chat                              |
| `Grok Build: Open Output`          | Show Output channel `Grok Build`                |
| `Grok Build: Start Agent`          | Spawn → `initialize` → `session/new`            |
| `Grok Build: New Session`          | New ACP session + clear UI                      |
| `Grok Build: Cancel Turn`          | `session/cancel`                                |
| `Grok Build: Add Context…`         | `@` sticky context picker                       |
| `Grok Build: Select Model`         | QuickPick → `grok.model` + agent restart        |
| `Grok Build: Resume Session…`      | Session history + `session/load` when available |
| `Grok Build: Review Edits…`        | Multi-file diff review                          |
| `Grok Build: Login / Set API Key`  | Browser login or SecretStorage API key          |
| `Grok Build: Smoke Test (L0)`      | Headless-style prompt via agent                 |
| `Grok Build: Restart / Stop Agent` | Process lifecycle                               |

### Slash commands (chat composer)

Type `/` in the chat (same names as Grok Build TUI):

| Layer        | Examples                                                                                            | Behavior                                    |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Host**     | `/new`, `/resume`, `/model`, `/help`, `/settings`, `/copy`, `/export`, `/always-approve`, `/login`… | Run in the extension                        |
| **Agent**    | `/compact`, `/loop`, `/plan`, skills, hooks/plugins…                                                | Pass-through as prompt                      |
| **TUI-only** | `/vim-mode`, `/theme`, `/dashboard`, `/minimal`…                                                    | Listed for parity; not available in VS Code |

---

## Settings

| Setting                    | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `grok.binaryPath`          | Absolute path to `grok` (empty = PATH / `~/.grok/bin`) |
| `grok.model`               | Optional `--model`                                     |
| `grok.alwaysApprove`       | Pass `--always-approve` (dangerous; confirm on enable) |
| `grok.cwd`                 | Session cwd (empty = first workspace folder)           |
| `grok.initializeTimeoutMs` | Spawn/init timeout (default 30s)                       |

---

## Layout

```
src/
  extension.ts
  agent/          # process, ACP, host FS, permissions
  ui/             # chat webview + status bar
  auth/           # SecretStorage API key
  context/        # active file / selection → ACP blocks
  config/         # settings + alwaysApprove guard
  log/output.ts
media/grok.svg              # activity bar (monochrome Grok mark)
media/grok-light.svg        # panel tab icon (light theme)
media/grok-dark.svg         # panel tab icon (dark theme)
media/icon.png              # marketplace icon (256×256 from media/icon.svg)
media/icon.svg              # source for marketplace logo
media/tabler/               # webfont copied on build
scripts/smoke-cli.mjs
docs/
```

Chat UI uses **[@tabler/icons-webfont](https://tabler.io/icons)** (`yarn build` copies CSS/fonts into `media/tabler/`).

---

## Documentation

Start here: `docs/README.md` (design docs in the repo; not shipped inside the VSIX).

| Doc                          | Topic                       |
| ---------------------------- | --------------------------- |
| `docs/01-overview.md`        | Goals / non-goals           |
| `docs/02-architecture.md`    | Process model & modules     |
| `docs/03-acp-integration.md` | Protocol integration        |
| `docs/08-security.md`        | Trust, permissions, secrets |
| `docs/09-roadmap.md`         | L0–L3 phases                |
| `CHANGELOG.md`               | Release notes               |

## License

MIT — see `LICENSE`.
