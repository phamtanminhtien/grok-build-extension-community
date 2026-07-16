import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo } from "../log/output";

const SECRET_KEY = "grok.apiKey";

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
    if (await this.getApiKey()) {
      return true;
    }
    return hasCliAuthFile();
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

function hasCliAuthFile(): boolean {
  try {
    const p = path.join(os.homedir(), ".grok", "auth.json");
    if (!fs.existsSync(p)) {
      return false;
    }
    const raw = fs.readFileSync(p, "utf8");
    return raw.trim().length > 2;
  } catch {
    return false;
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
