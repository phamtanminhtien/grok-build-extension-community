import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Grok Build", { log: true });
  }
  return channel;
}

export function logInfo(message: string): void {
  getOutputChannel().appendLine(`[info] ${message}`);
}

export function logWarn(message: string): void {
  getOutputChannel().appendLine(`[warn] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = formatError(err);
  getOutputChannel().appendLine(
    detail ? `[error] ${message}: ${detail}` : `[error] ${message}`,
  );
}

export function logSessionUpdate(line: string): void {
  getOutputChannel().appendLine(line);
}

export function openOutput(): void {
  getOutputChannel().show(true);
}

export function disposeOutput(): void {
  channel?.dispose();
  channel = undefined;
}

function formatError(err: unknown): string {
  if (err == null) {
    return "";
  }
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
