# 04 — Host Capabilities

The agent can execute tools itself **or** ask the client to perform host
operations. Declaring client capabilities in `initialize` improves IDE
fidelity (unsaved buffers, integrated terminals, encoding).

## Capability matrix

| Capability        | ACP surface                         | Status (0.3.8) | Notes                                          |
| ----------------- | ----------------------------------- | -------------- | ---------------------------------------------- |
| Read text file    | `fs/read_text_file` (client method) | **Yes**        | Prefer open document text                      |
| Write text file   | `fs/write_text_file`                | **Yes**        | Apply via WorkspaceEdit; snapshot for diffs    |
| Terminal          | client terminal methods             | **No**         | `terminal: false` ([ADR-004](10-decisions.md)) |
| Fs notify / index | `x.ai/*` notifications              | Partial        | Best-effort refresh / not a full index UI      |
| Git               | `x.ai/git/*`                        | Agent-side     | No dedicated host git UI                       |
| Hunk tracker      | client `_meta` + agent              | **Yes**        | Accept/Reject on diff review                   |
| Fuzzy open        | `x.ai/search/*`                     | **No**         | In-chat `@` picker only (not ACP bridge)       |
| Worktree          | `x.ai/git/worktree/*`               | **Yes**        | QuickPick UI + status notifications            |

## Filesystem capability

### Goals

1. When a file is open in the editor, **reads see buffer content** (including
   dirty/unsaved state).
2. Writes from the host path should update the buffer and mark dirty (or save
   per policy).
3. Paths outside the workspace still allowed only if VS Code / user trust
   permits (see [08-security](08-security.md)).

### Read algorithm

```
function readTextFile(path or uri):
  uri = normalizeToUri(path)
  doc = workspace.textDocuments.find(d => d.uri ≈ uri)
  if doc:
    return doc.getText()   // unsaved-aware
  else:
    return workspace.fs.readFile(uri) decoded as utf-8
```

Edge cases:

| Case               | Behavior                                                       |
| ------------------ | -------------------------------------------------------------- |
| Binary / huge file | Cap size; return error if over limit (align with agent limits) |
| Non-UTF8           | Try utf-8; on failure return structured error                  |
| File not found     | ACP error `invalid_params` / not found                         |
| Untitled buffer    | Only if URI scheme supported                                   |

### Write algorithm

```
function writeTextFile(path, content):
  uri = normalizeToUri(path)
  doc = open or showTextDocument optional
  edit = WorkspaceEdit replacing full range or create file
  await workspace.applyEdit(edit)
  // save when grok.fs.autoSave is true (default)
```

Policies (settings):

| Setting                     | Default        | Meaning                          |
| --------------------------- | -------------- | -------------------------------- |
| `grok.fs.preferOpenBuffers` | `true`         | Read from TextDocument when open |
| `grok.fs.autoSave`          | `true`         | Save after host write            |
| `grok.fs.maxReadBytes`      | e.g. 5_000_000 | Hard cap                         |

### Interaction with agent-side tools

The agent also has its own `read_file` / `search_replace` tools that may hit
the real filesystem. Host FS capabilities matter when:

- ACP client capability path is used by the agent implementation, or
- Extension methods delegate to client.

Even when the agent writes to disk directly, the extension should:

- Listen for file watchers / agent notifications and **refresh** dirty
  conflict UI.
- On `tool_call_update` that edits files, offer **Open diff** (L1–L2).

## Terminal capability

### Goals

- Agent-created terminals appear as VS Code terminals when using host
  capability path.
- Output streaming available for the agent to wait on.

### Mapping

| ACP intent      | VS Code API                                               |
| --------------- | --------------------------------------------------------- |
| Create terminal | `window.createTerminal({ name, cwd })`                    |
| Write to stdin  | `terminal.sendText(cmd, true)` (approximation)            |
| Read output     | Limited — VS Code does not expose full PTY capture easily |
| Kill            | `terminal.dispose()`                                      |

### Limitation (important)

VS Code’s public Terminal API **does not** give full bidirectional PTY
capture comparable to a raw PTY. Practical approaches:

| Approach                                          | Pros                                                | Cons                         |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| **A. Let agent own PTY** (agent-side shell tools) | Full fidelity                                       | Terminals outside VS Code UI |
| **B. Host terminal sendText only**                | Visible in IDE                                      | Weak output capture          |
| **C. Hybrid**                                     | Shell tools agent-side; optional “show in terminal” | Best MVP compromise          |

**Decision (Accepted):** `terminal: false` — agent owns PTY/shell tools;
output appears in tool cards. Optional “Reveal in Terminal” hybrid remains a
future residual (see [ADR-004](10-decisions.md)).

## Editor context (outbound, not a capability)

Not an ACP client capability — the client **enriches prompts**:

| Context               | Content block                                  |
| --------------------- | ---------------------------------------------- |
| Active file           | `resource_link` with `file://` URI             |
| Selection             | Meta on link or fenced text excerpt            |
| Workspace root        | `session/new.cwd`                              |
| Sticky chips / `@`    | Explicit file / folder / selection             |
| Images                | `image` content blocks (paste / drop / attach) |
| Diagnostics           | Fix with Grok + optional text summary          |
| Open tabs (optional)  | Multiple resource_links (cap count)            |
| Git status (optional) | Agent tools primarily                          |

### Privacy

Do not auto-attach secrets files (`.env`, credentials) without user action.
Optional deny-list setting: `grok.context.excludeGlob`.

## Git / search host bridges

| Bridge                               | Status                                          |
| ------------------------------------ | ----------------------------------------------- |
| `x.ai/search/fuzzy/open` → QuickOpen | **Not implemented** (L3)                        |
| In-chat `@` file fuzzy pick          | **Shipped** (host-only, not ACP search methods) |
| `x.ai/git/*` dedicated UI            | **Not implemented** — agent tools only          |
| `x.ai/git/worktree/*` UI             | **Shipped** — list/create/open/apply/remove/GC  |

When implementing fuzzy open: use `vscode.workspace.findFiles` / QuickPick and
return selected URI to the agent. Do not fight VS Code SCM ownership for git.

## Capability negotiation checklist

On every `initialize` response:

1. Log agent protocol version.
2. Store `agentCapabilities` / auth methods / ext methods.
3. Enable UI affordances only if supported.
4. If agent requires a capability we did not offer, surface a clear error.

## Next

→ [05 — UI & UX](05-ui-ux.md)
