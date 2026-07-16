import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo } from "../log/output";
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

export class AuthService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

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
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    logInfo("API key cleared from SecretStorage");
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
