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

/** Gate from AuthMeta (`grok_build_access_gate` / paywall). */
export interface GateInfo {
  message: string;
  url?: string;
  label?: string;
}

/**
 * Profile from `x.ai/auth/info` (camelCase wire).
 * Fields map 1:1 with shell `AuthInfoResponse`.
 */
export interface AuthInfo {
  methodId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  profileImageUrl?: string;
  teamId?: string;
  teamName?: string;
  teamRole?: string;
  organizationId?: string;
  organizationName?: string;
  organizationRole?: string;
  principalType?: string;
  principalId?: string;
  userBlockedReason?: string;
  teamBlockedReasons: string[];
  codingDataRetentionOptOut: boolean;
}

/** AuthMeta from authenticate / check_subscription (snake_case shell wire). */
export interface AuthMeta {
  email?: string;
  authMode?: string;
  teamId?: string;
  teamName?: string;
  teamRole?: string;
  isZdr?: boolean;
  codingDataRetentionOptOut?: boolean;
  subscriptionTier?: string;
  gate?: GateInfo;
}

export interface CheckSubscriptionResult {
  authenticated: boolean;
  meta?: AuthMeta;
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
      args.cliEmail
        ? `CLI session (${args.cliEmail})`
        : "CLI ~/.grok/auth.json",
    );
  }
  if (sources.length === 0) {
    return "Not signed in";
  }
  return `Signed in via ${sources.join(" · ")}`;
}

/**
 * Whether the client should prompt for a pasted auth token and call
 * `x.ai/auth/submit_code` (TUI loopback paste box).
 *
 * - `device`: code is entered on the website, not in the client
 * - `command` / external_provider: external browser handles it
 * - `loopback` or unknown: show paste UI (pager default)
 */
export function needsManualAuthCodePaste(
  mode: string | undefined,
  externalProvider: boolean,
): boolean {
  if (externalProvider) {
    return false;
  }
  const m = mode?.trim().toLowerCase();
  if (m === "device" || m === "command") {
    return false;
  }
  return true;
}

/**
 * Normalize `x.ai/auth/info` response (camelCase or snake_case fields).
 */
export function parseAuthInfoResponse(raw: unknown): AuthInfo {
  const body = unwrapExtBody(raw);
  if (!body || typeof body !== "object") {
    return { teamBlockedReasons: [], codingDataRetentionOptOut: false };
  }
  const o = body as Record<string, unknown>;
  const teamBlocked =
    asStringArray(o.teamBlockedReasons) ??
    asStringArray(o.team_blocked_reasons) ??
    [];
  return {
    methodId: asOptString(o.methodId ?? o.method_id),
    email: asOptString(o.email),
    firstName: asOptString(o.firstName ?? o.first_name),
    lastName: asOptString(o.lastName ?? o.last_name),
    profileImageUrl: asOptString(o.profileImageUrl ?? o.profile_image_url),
    teamId: asOptString(o.teamId ?? o.team_id),
    teamName: asOptString(o.teamName ?? o.team_name),
    teamRole: asOptString(o.teamRole ?? o.team_role),
    organizationId: asOptString(o.organizationId ?? o.organization_id),
    organizationName: asOptString(o.organizationName ?? o.organization_name),
    organizationRole: asOptString(o.organizationRole ?? o.organization_role),
    principalType: asOptString(o.principalType ?? o.principal_type),
    principalId: asOptString(o.principalId ?? o.principal_id),
    userBlockedReason: asOptString(
      o.userBlockedReason ?? o.user_blocked_reason,
    ),
    teamBlockedReasons: teamBlocked,
    codingDataRetentionOptOut:
      o.codingDataRetentionOptOut === true ||
      o.coding_data_retention_opt_out === true,
  };
}

/**
 * Normalize `x.ai/auth/check_subscription` → `{ authenticated, meta }`.
 */
export function parseCheckSubscriptionResponse(
  raw: unknown,
): CheckSubscriptionResult {
  const body = unwrapExtBody(raw);
  if (!body || typeof body !== "object") {
    return { authenticated: false };
  }
  const o = body as Record<string, unknown>;
  const authenticated = o.authenticated === true;
  const metaRaw = o.meta;
  if (!metaRaw || typeof metaRaw !== "object") {
    return { authenticated };
  }
  return { authenticated, meta: parseAuthMeta(metaRaw) };
}

/** Parse AuthMeta (snake_case shell wire + camelCase tolerance). */
export function parseAuthMeta(raw: unknown): AuthMeta | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const gateRaw = o.gate;
  let gate: GateInfo | undefined;
  if (gateRaw && typeof gateRaw === "object") {
    const g = gateRaw as Record<string, unknown>;
    const message = asOptString(g.message);
    if (message) {
      gate = {
        message,
        url: asOptString(g.url),
        label: asOptString(g.label),
      };
    }
  }
  return {
    email: asOptString(o.email),
    authMode: asOptString(o.auth_mode ?? o.authMode),
    teamId: asOptString(o.team_id ?? o.teamId),
    teamName: asOptString(o.team_name ?? o.teamName),
    teamRole: asOptString(o.team_role ?? o.teamRole),
    isZdr: o.is_zdr === true || o.isZdr === true,
    codingDataRetentionOptOut:
      o.coding_data_retention_opt_out === true ||
      o.codingDataRetentionOptOut === true,
    subscriptionTier: asOptString(o.subscription_tier ?? o.subscriptionTier),
    gate,
  };
}

/** True when AuthMeta carries an access gate (paywall / block). */
export function isAccessGated(meta: AuthMeta | undefined | null): boolean {
  return !!meta?.gate?.message?.trim();
}

/**
 * Richer empty-state / status line from `auth/info` (+ optional gate).
 */
export function formatAuthInfoSummary(
  info: AuthInfo | undefined | null,
  opts?: { gate?: GateInfo; subscriptionTier?: string },
): string | undefined {
  if (!info) {
    return undefined;
  }
  const parts: string[] = [];
  const name = [info.firstName, info.lastName].filter(Boolean).join(" ").trim();
  if (info.email) {
    parts.push(name ? `${name} <${info.email}>` : info.email);
  } else if (name) {
    parts.push(name);
  }
  if (info.teamName) {
    parts.push(
      info.teamRole
        ? `team ${info.teamName} (${info.teamRole})`
        : `team ${info.teamName}`,
    );
  } else if (info.organizationName) {
    parts.push(`org ${info.organizationName}`);
  }
  if (opts?.subscriptionTier?.trim()) {
    parts.push(opts.subscriptionTier.trim());
  }
  if (info.methodId) {
    parts.push(`via ${info.methodId}`);
  }
  if (info.userBlockedReason?.trim()) {
    parts.push(`blocked: ${info.userBlockedReason.trim()}`);
  } else if (info.teamBlockedReasons.length > 0) {
    parts.push(`team blocked: ${info.teamBlockedReasons.join(", ")}`);
  }
  if (opts?.gate?.message?.trim()) {
    parts.push(`gate: ${opts.gate.message.trim()}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" · ");
}

export function formatGateBanner(
  gate: GateInfo | undefined | null,
): string | undefined {
  const msg = gate?.message?.trim();
  if (!msg) {
    return undefined;
  }
  if (gate?.url?.trim()) {
    return `${msg} (${gate.label?.trim() || "details"}: ${gate.url.trim()})`;
  }
  return msg;
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

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}
