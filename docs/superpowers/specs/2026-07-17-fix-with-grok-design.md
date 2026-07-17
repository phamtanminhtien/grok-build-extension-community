# Design: Fix with Grok (diagnostic → composer)

**Status:** Approved  
**Date:** 2026-07-17  
**Scope:** `grok-vscode-extension` only  
**Depth:** Vertical slice

## Summary

When the user hovers a problem squiggle (or opens Quick Fix / lightbulb / `⌘.`),
offer **Fix with Grok**. Activating it opens the Grok chat panel and **fills the
composer** with the diagnostic message, file path, line, and a short code
snippet — plus a sticky file chip when the URI is a workspace file. Does **not**
auto-send.

## Goals

- IDE-native entry point from any diagnostic (Error, Warning, Info, Hint).
- Surface: **CodeAction Quick Fix** (lightbulb, `⌘.`, and the link VS Code already shows on diagnostic hover).
- Composer draft only; user reviews and sends.
- Reuse existing chat sticky-chip + open-chat paths.

## Non-goals

- Auto-send the prompt.
- In-place AI edits without chat.
- Replacing language-server Quick Fixes.
- Custom Problems panel UI.

## Decisions

| Topic             | Choice                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Composer behavior | Overwrite current draft with fix prompt                                                    |
| Severities        | All (`Error` / `Warning` / `Info` / `Hint`)                                                |
| Surfaces          | HoverProvider + CodeAction (CodeAction without `diagnostics` so hover shows one link only) |
| Snippet           | ±3 lines around diagnostic range                                                           |
| File context      | Sticky chip `file:{path}` for `file:` URIs                                                 |
| Preferred action  | Not preferred (do not steal LSP preferred fix)                                             |

## Architecture

```
extension.ts
  ├── registerCodeActionsProvider('*', FixWithGrokCodeActionProvider)
  ├── registerHoverProvider('*', FixWithGrokHoverProvider)
  ├── command grok.fixWithGrok
  └── ChatViewProvider.fillComposer(text, chips?)
        └── post { type: "setComposer", text }
              └── chat.js → textarea value + focus + autosize
```

### Modules

| Module                               | Responsibility                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `src/context/fixWithGrok.ts`         | Pure helpers: severity label, path display, snippet, prompt format, payload type |
| `src/context/fixWithGrokProvider.ts` | Hover + CodeAction providers; build command args                                 |
| `ChatViewProvider.fillComposer`      | Open chat, wait webview, sticky chips, post `setComposer`                        |
| `media/chat/chat.js`                 | Apply `setComposer` message                                                      |
| `package.json`                       | Contribute `grok.fixWithGrok`                                                    |

### Command payload (JSON-serializable)

```ts
interface FixWithGrokPayload {
  uri: string; // document URI toString()
  message: string;
  severity: number; // vscode.DiagnosticSeverity
  startLine: number; // 0-based
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  source?: string;
  code?: string; // string form of diagnostic.code
  languageId?: string;
}
```

Hover command links and CodeActions both pass this payload so the command
handler can reopen the document and rebuild the snippet if needed, or use a
preformatted text field.

### Prompt template

```
Fix this {Severity} in `{displayPath}` at line {1-based line}:

```

{message}

````

Surrounding code:
```{languageId}
{n}| {line text}
...
````

```

- Message capped at ~2000 characters.
- Display path: workspace-relative when possible, else `fsPath` / URI string.
- Snippet lines prefixed with 1-based line numbers.

## Data flow

1. User hovers diagnostic or opens Quick Fix on a range with diagnostics.
2. Provider emits action/link with `grok.fixWithGrok` + payload.
3. Command handler:
   - Formats prompt via `formatFixWithGrokPrompt`.
   - Builds optional `ContextChip` for file URI.
   - Calls `chat.fillComposer(prompt, chips)`.
4. `fillComposer` focuses chat, waits for webview, adds chips, posts `setComposer`.
5. Webview overwrites composer, focuses caret at end.

## Edge cases

| Case | Behavior |
|------|----------|
| Webview not ready | Warning: open chat panel |
| Composer non-empty | Overwrite |
| `untitled:` / non-file | Fill text only; no sticky chip |
| Multiple diagnostics | One action/link per diagnostic |
| Empty message | Still show path + snippet |

## Testing

- Unit tests for `formatFixWithGrokPrompt`, severity labels, snippet window, path display.
- Manual: hover Error → link; lightbulb Warning; Info/Hint; untitled buffer; Send after fill.

## Acceptance

- [x] Hover shows one **Fix with Grok** link (HoverProvider; CodeAction not bound to diagnostics).
- [x] Click opens Grok chat and fills composer with message + path + line + snippet.
- [x] File URI also adds a sticky file chip.
- [x] Composer is not auto-sent.
- [x] Unit tests for prompt formatting pass.
```
