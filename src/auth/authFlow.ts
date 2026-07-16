/**
 * Pure helpers for ACP browser login / logout (mirrors Grok pager auth dispatch).
 */

export const INTERACTIVE_AUTH_METHOD_IDS = ["grok.com", "oidc"] as const;

export interface AuthMethodLike {
  id?: string;
  name?: string;
  description?: string | null;
  type?: string;
  _meta?: { external_provider?: boolean; [key: string]: unknown } | null;
}

export interface AuthUrlInfo {
  authUrl: string | undefined;
  mode: string | undefined;
  externalProvider: boolean;
}

export interface LogoutResult {
  ok: boolean;
  wasLoggedIn: boolean;
  email?: string;
  apiKeyStillSet: boolean;
}

/**
 * Prefer interactive methods (`grok.com`, `oidc`) for browser sign-in.
 * Falls back to first advertised method that is not api_key / cached_token.
 */
export function pickInteractiveAuthMethodId(
  methods: AuthMethodLike[] | undefined | null,
): string | undefined {
  if (!methods?.length) {
    return undefined;
  }
  for (const id of INTERACTIVE_AUTH_METHOD_IDS) {
    const hit = methods.find((m) => methodIdOf(m) === id);
    if (hit) {
      return methodIdOf(hit);
    }
  }
  for (const m of methods) {
    const id = methodIdOf(m);
    if (!id) {
      continue;
    }
    if (id === "xai.api_key" || id === "cached_token") {
      continue;
    }
    return id;
  }
  return undefined;
}

export function methodIdOf(m: AuthMethodLike): string | undefined {
  const id = m.id?.trim();
  return id || undefined;
}

/**
 * Only allow https:// URLs for openExternal (security: no file:/javascript:).
 */
export function isSafeAuthUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse device-flow `user_code` from a verification URL (parity with pager).
 */
export function extractUserCode(url: string): string | undefined {
  try {
    const u = new URL(url);
    const code = u.searchParams.get("user_code")?.trim();
    if (
      code &&
      code.length > 0 &&
      [...code].every((c) => /[A-Za-z0-9-]/.test(c))
    ) {
      return code;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Normalize `x.ai/auth/get_url` response (raw or `{ result: … }`).
 */
export function parseAuthUrlResponse(raw: unknown): AuthUrlInfo {
  const body = unwrapExtBody(raw);
  if (!body || typeof body !== "object") {
    return { authUrl: undefined, mode: undefined, externalProvider: false };
  }
  const o = body as Record<string, unknown>;
  const authUrl =
    typeof o.auth_url === "string" && o.auth_url.trim()
      ? o.auth_url.trim()
      : undefined;
  const mode =
    typeof o.mode === "string" && o.mode.trim() ? o.mode.trim() : undefined;
  const externalProvider = o.external_provider === true;
  return { authUrl, mode, externalProvider };
}

/**
 * Normalize `x.ai/auth/logout` response.
 */
export function parseLogoutResponse(raw: unknown): LogoutResult {
  const body = unwrapExtBody(raw);
  if (!body || typeof body !== "object") {
    return { ok: true, wasLoggedIn: false, apiKeyStillSet: false };
  }
  const o = body as Record<string, unknown>;
  return {
    ok: o.ok !== false,
    wasLoggedIn: o.was_logged_in === true,
    email: typeof o.email === "string" ? o.email : undefined,
    apiKeyStillSet: o.api_key_still_set === true,
  };
}

export function formatLogoutMessage(
  result: LogoutResult,
  clearedSecretKey: boolean,
): string {
  const parts: string[] = [];
  if (result.wasLoggedIn) {
    parts.push(
      result.email
        ? `Logged out (was signed in as ${result.email})`
        : "Logged out of Grok account",
    );
  } else {
    parts.push("No cached Grok session to log out of");
  }
  if (clearedSecretKey) {
    parts.push("API key cleared from SecretStorage");
  }
  if (result.apiKeyStillSet) {
    parts.push("XAI_API_KEY env is still set and may authenticate the agent");
  }
  return parts.join(". ") + ".";
}

/**
 * Human-readable auth source summary for UI hints (no secrets).
 */
export function describeAuthPresence(args: {
  hasSecretKey: boolean;
  hasEnvKey: boolean;
  hasCliAuth: boolean;
  cliEmail?: string;
}): string {
  const sources: string[] = [];
  if (args.hasSecretKey) {
    sources.push("SecretStorage API key");
  }
  if (args.hasEnvKey) {
    sources.push("XAI_API_KEY env");
  }
  if (args.hasCliAuth) {
    sources.push(
      args.cliEmail ? `CLI session (${args.cliEmail})` : "CLI ~/.grok/auth.json",
    );
  }
  if (sources.length === 0) {
    return "Not signed in";
  }
  return `Signed in via ${sources.join(" · ")}`;
}

function unwrapExtBody(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  const o = raw as Record<string, unknown>;
  if ("result" in o && o.result != null && typeof o.result === "object") {
    return o.result;
  }
  return raw;
}
