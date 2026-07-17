import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextChip } from "./editorContext";
import {
  displayPathForUri,
  fileChipId,
  formatFixWithGrokPrompt,
  type FixWithGrokPayload,
} from "./fixWithGrok";

export const FIX_WITH_GROK_COMMAND = "grok.fixWithGrok";

function diagnosticCodeString(
  code:
    | string
    | number
    | { value: string | number; target: vscode.Uri }
    | undefined,
): string | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }
  if (typeof code === "object" && "value" in code) {
    return String(code.value);
  }
  return String(code);
}

export function diagnosticToPayload(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): FixWithGrokPayload {
  return {
    uri: document.uri.toString(),
    message: diagnostic.message,
    severity: diagnostic.severity as number,
    startLine: diagnostic.range.start.line,
    startCharacter: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line,
    endCharacter: diagnostic.range.end.character,
    source: diagnostic.source,
    code: diagnosticCodeString(diagnostic.code),
    languageId: document.languageId,
  };
}

function workspaceRelative(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
}

/** Resolve payload into composer text + optional sticky file chip. */
export async function resolveFixWithGrok(
  payload: FixWithGrokPayload,
): Promise<{ text: string; chips: ContextChip[] }> {
  let lines: string[] = [];
  let languageId = payload.languageId;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(payload.uri);
  } catch {
    uri = vscode.Uri.file(payload.uri);
  }

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    lines = doc.getText().split(/\r?\n/);
    languageId = languageId || doc.languageId;
  } catch {
    /* snippet empty if doc unavailable */
  }

  const displayPath = displayPathForUri(
    payload.uri,
    uri.scheme === "file" ? workspaceRelative(uri) : undefined,
  );

  const text = formatFixWithGrokPrompt(
    { ...payload, languageId },
    { displayPath, lines },
  );

  const chips: ContextChip[] = [];
  if (uri.scheme === "file") {
    const fsPath = uri.fsPath;
    chips.push({
      id: fileChipId(fsPath),
      label: `file:${path.basename(fsPath)}`,
      kind: "file",
      fsPath,
    });
  }

  return { text, chips };
}

function commandArgs(payload: FixWithGrokPayload): vscode.Command {
  return {
    command: FIX_WITH_GROK_COMMAND,
    title: "Fix with Grok",
    arguments: [payload],
  };
}

export class FixWithGrokCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const payload = diagnosticToPayload(document, diagnostic);
      const action = new vscode.CodeAction(
        "Fix with Grok",
        vscode.CodeActionKind.QuickFix,
      );
      // Do NOT set action.diagnostics — VS Code would also list this as a
      // Quick Fix link on the problem hover, duplicating HoverProvider.
      action.command = commandArgs(payload);
      action.isPreferred = false;
      actions.push(action);
    }
    return actions;
  }
}

export class FixWithGrokHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter((d) => d.range.contains(position));

    if (diagnostics.length === 0) {
      return undefined;
    }

    // One link only: most severe diagnostic at cursor (Error=0 … Hint=3).
    const diagnostic = diagnostics.reduce((best, d) =>
      d.severity < best.severity ? d : best,
    );
    const payload = diagnosticToPayload(document, diagnostic);
    const arg = encodeURIComponent(JSON.stringify([payload]));
    const href = `command:${FIX_WITH_GROK_COMMAND}?${arg}`;
    const md = new vscode.MarkdownString(`[Fix with Grok](${href})`);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    return new vscode.Hover(md, diagnostic.range);
  }
}

/** Register providers + return disposables (command registered by caller). */
export function registerFixWithGrokProviders(): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { scheme: "*" };
  return [
    vscode.languages.registerCodeActionsProvider(
      selector,
      new FixWithGrokCodeActionProvider(),
      {
        providedCodeActionKinds:
          FixWithGrokCodeActionProvider.providedCodeActionKinds,
      },
    ),
    vscode.languages.registerHoverProvider(
      selector,
      new FixWithGrokHoverProvider(),
    ),
  ];
}
