import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo, logWarn } from "../log/output";
import { describeAuthPresence } from "./authFlow";

const SECRET_KEY = "grok.apiKey";

export interface AuthStatus {
  hasSecretKey: boolean;
  hasEnvKey: boolean;
  hasCliAuth: boolean;
  cliEmail?: string;
  /** True if any credential source looks present. */
  hasAny: boolean;
  summary: string;
}

/**
 * Extension auth orchestrator. OAuth lives in the CLI session file
 * (`~/.grok/auth.json`); API keys may also live in SecretStorage / env.
 * Login and logout both mutate the same CLI store so extension and `grok`
 * CLI stay aligned.
 */
export class AuthService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<AuthStatus>();
  /** Fires when SecretStorage, env inheritance, or CLI auth.json changes. */
  readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private cliWatcher: fs.FSWatcher | undefined;
  private cliWatchDebounce: ReturnType<typeof setTimeout> | undefined;
  private lastFingerprint = "";

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      this._onDidChange,
      this.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) {
          void this.emitIfChanged();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("grok.inheritEnvApiKey")) {
          void this.emitIfChanged();
        }
      }),
    );
    this.startCliAuthWatch();
    void this.emitIfChanged();
  }

  async getApiKey(): Promise<string | undefined> {
    const fromSecret = (await this.secrets.get(SECRET_KEY))?.trim();
    if (fromSecret) {
      return fromSecret;
    }
    const settings = getSettings();
    if (settings.inheritEnvApiKey) {
      const fromEnv = process.env.XAI_API_KEY?.trim();
      if (fromEnv) {
        return fromEnv;
      }
    }
    return undefined;
  }

  async hasSecretApiKey(): Promise<boolean> {
    const fromSecret = (await this.secrets.get(SECRET_KEY))?.trim();
    return !!fromSecret;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key.trim());
    logInfo("API key stored in SecretStorage");
    await this.emitIfChanged();
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    logInfo("API key cleared from SecretStorage");
    await this.emitIfChanged();
  }

  /** True if SecretStorage / env key or CLI auth file looks present. */
  async hasAnyAuth(): Promise<boolean> {
    const status = await this.getStatus();
    return status.hasAny;
  }

  async getStatus(): Promise<AuthStatus> {
    const hasSecretKey = !!(await this.secrets.get(SECRET_KEY))?.trim();
    const settings = getSettings();
    const hasEnvKey =
      settings.inheritEnvApiKey && !!process.env.XAI_API_KEY?.trim();
    const cli = readCliAuthSummary();
    const hasCliAuth = cli.present;
    const hasAny = hasSecretKey || hasEnvKey || hasCliAuth;
    return {
      hasSecretKey,
      hasEnvKey,
      hasCliAuth,
      cliEmail: cli.email,
      hasAny,
      summary: describeAuthPresence({
        hasSecretKey,
        hasEnvKey,
        hasCliAuth,
        cliEmail: cli.email,
      }),
    };
  }

  /**
   * Env vars to merge into agent process (never log values).
   */
  async buildAgentEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = await this.getApiKey();
    if (key) {
      env.XAI_API_KEY = key;
    }
    return env;
  }

  /**
   * Force a status re-read (e.g. after login/logout via agent when the
   * auth.json write might race the file watcher).
   */
  async refresh(): Promise<AuthStatus> {
    return this.emitIfChanged(true);
  }

  dispose(): void {
    if (this.cliWatchDebounce) {
      clearTimeout(this.cliWatchDebounce);
      this.cliWatchDebounce = undefined;
    }
    this.cliWatcher?.close();
    this.cliWatcher = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private startCliAuthWatch(): void {
    const grokDir = path.join(os.homedir(), ".grok");
    const authPath = path.join(grokDir, "auth.json");
    try {
      if (!fs.existsSync(grokDir)) {
        // Watch parent so a later `grok login` that creates ~/.grok is noticed.
        const home = os.homedir();
        this.cliWatcher = fs.watch(home, (_event, filename) => {
          const name = filenameToString(filename);
          if (name === ".grok" || name === "auth.json") {
            this.scheduleCliAuthCheck();
            // Once ~/.grok exists, rebind watcher to the more specific path.
            if (fs.existsSync(grokDir)) {
              this.cliWatcher?.close();
              this.cliWatcher = undefined;
              this.startCliAuthWatch();
            }
          }
        });
        return;
      }
      this.cliWatcher = fs.watch(grokDir, (_event, filename) => {
        const name = filenameToString(filename);
        if (!name || name === "auth.json") {
          this.scheduleCliAuthCheck();
        }
      });
      // Also touch-check the file itself when present (some platforms only
      // fire dir events for create/delete, not content rewrite).
      if (fs.existsSync(authPath)) {
        try {
          const fileWatcher = fs.watch(authPath, () => {
            this.scheduleCliAuthCheck();
          });
          this.disposables.push({
            dispose: () => fileWatcher.close(),
          });
        } catch {
          /* dir watcher is enough on most platforms */
        }
      }
    } catch (err) {
      logWarn(
        `Could not watch CLI auth file (${authPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleCliAuthCheck(): void {
    if (this.cliWatchDebounce) {
      clearTimeout(this.cliWatchDebounce);
    }
    this.cliWatchDebounce = setTimeout(() => {
      this.cliWatchDebounce = undefined;
      void this.emitIfChanged();
    }, 150);
  }

  private async emitIfChanged(force = false): Promise<AuthStatus> {
    const status = await this.getStatus();
    const fingerprint = [
      status.hasSecretKey ? "1" : "0",
      status.hasEnvKey ? "1" : "0",
      status.hasCliAuth ? "1" : "0",
      status.cliEmail ?? "",
      status.summary,
    ].join("|");
    if (force || fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = fingerprint;
      this._onDidChange.fire(status);
    }
    return status;
  }
}

function filenameToString(
  filename: string | Buffer | null | undefined,
): string {
  if (filename == null) {
    return "";
  }
  if (typeof filename === "string") {
    return filename;
  }
  return Buffer.isBuffer(filename) ? filename.toString("utf8") : "";
}

function readCliAuthSummary(): { present: boolean; email?: string } {
  try {
    const p = path.join(os.homedir(), ".grok", "auth.json");
    if (!fs.existsSync(p)) {
      return { present: false };
    }
    const raw = fs.readFileSync(p, "utf8");
    if (raw.trim().length <= 2) {
      return { present: false };
    }
    let email: string | undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const v of Object.values(parsed)) {
        if (v && typeof v === "object") {
          const e = (v as { email?: unknown }).email;
          if (typeof e === "string" && e.includes("@")) {
            email = e;
            break;
          }
        }
      }
    } catch {
      /* non-JSON or unexpected shape — still counts as present */
    }
    return { present: true, email };
  } catch {
    return { present: false };
  }
}

export async function promptAndStoreApiKey(
  auth: AuthService,
): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: "Grok Build — API Key",
    prompt: "Enter your xAI API key (stored in VS Code SecretStorage)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "xai-…",
  });
  if (!key?.trim()) {
    return false;
  }
  await auth.setApiKey(key);
  void vscode.window.showInformationMessage("Grok Build: API key saved");
  return true;
}

export type LoginChoice = "browser" | "apiKey" | undefined;

/**
 * QuickPick: browser OAuth (ACP) vs API key — same surfaces as TUI login.
 */
export async function pickLoginMethod(
  status?: AuthStatus,
): Promise<LoginChoice> {
  const items: Array<vscode.QuickPickItem & { id: "browser" | "apiKey" }> = [
    {
      id: "browser",
      label: "$(globe) Sign in with browser",
      description: "Grok account (OAuth via agent)",
      detail: "Opens auth.x.ai — same as `grok login`",
    },
    {
      id: "apiKey",
      label: "$(key) Set API key",
      description: "Store XAI_API_KEY in SecretStorage",
      detail: "For API-key-only setups",
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Grok Build — Login",
    placeHolder: status?.hasAny
      ? `${status.summary} — choose how to sign in`
      : "Choose how to sign in",
    ignoreFocusOut: true,
  });
  return picked?.id;
}
