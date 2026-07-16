import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo, logWarn } from "../log/output";

let beforeWrite: ((filePath: string) => Promise<void>) | undefined;

/** Hook run before host fs/write_text_file (e.g. snapshot for diffs). */
export function setBeforeWriteHook(
  hook?: (filePath: string) => Promise<void>,
): void {
  beforeWrite = hook;
}

export async function readTextFileHost(filePath: string): Promise<{
  content: string;
}> {
  const settings = getSettings();
  const uri = toFileUri(filePath);

  if (settings.preferOpenBuffers) {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === uri.fsPath || d.uri.toString() === uri.toString(),
    );
    if (open) {
      const text = open.getText();
      if (Buffer.byteLength(text, "utf8") > settings.maxReadBytes) {
        throw new Error(
          `Open buffer exceeds maxReadBytes (${settings.maxReadBytes})`,
        );
      }
      logInfo(`[fs/read] buffer ${uri.fsPath} (${text.length} chars)`);
      return { content: text };
    }
  }

  const data = await vscode.workspace.fs.readFile(uri);
  if (data.byteLength > settings.maxReadBytes) {
    throw new Error(`File exceeds maxReadBytes (${settings.maxReadBytes})`);
  }
  const content = Buffer.from(data).toString("utf8");
  logInfo(`[fs/read] disk ${uri.fsPath} (${content.length} chars)`);
  return { content };
}

export async function writeTextFileHost(
  filePath: string,
  content: string,
): Promise<Record<string, never>> {
  if (beforeWrite) {
    await beforeWrite(filePath);
  }
  const settings = getSettings();
  const uri = toFileUri(filePath);
  const edit = new vscode.WorkspaceEdit();

  let doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === uri.fsPath,
  );

  try {
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        // File may not exist yet
      }
    }

    if (doc) {
      const full = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      edit.replace(uri, full, content);
    } else {
      edit.createFile(uri, { overwrite: true, ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error(`WorkspaceEdit failed for ${uri.fsPath}`);
    }

    if (settings.autoSave) {
      const saved = await vscode.workspace.openTextDocument(uri);
      await saved.save();
    }

    logInfo(`[fs/write] ${uri.fsPath} (${content.length} chars)`);
    return {};
  } catch (err) {
    logWarn(`[fs/write] failed ${uri.fsPath}: ${String(err)}`);
    throw err;
  }
}

function toFileUri(filePath: string): vscode.Uri {
  if (filePath.startsWith("file:")) {
    return vscode.Uri.parse(filePath);
  }
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    return vscode.Uri.file(path.join(root, filePath));
  }
  return vscode.Uri.file(path.resolve(filePath));
}
