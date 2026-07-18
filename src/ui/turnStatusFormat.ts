/**
 * Format helpers for the chat turn-status row above the composer.
 * Mirrors grok-build TUI turn_status / context_bar compact display.
 */

export interface SessionUsageSnapshot {
  /** Tokens currently in context (usage_update.used). */
  used?: number;
  /** Context window size (usage_update.size). */
  size?: number;
  /** Cumulative session cost amount. */
  costAmount?: number;
  /** ISO 4217 currency, default USD. */
  currency?: string;
  /** Last turn token totals from PromptResponse.usage. */
  turnTotalTokens?: number;
  turnInputTokens?: number;
  turnOutputTokens?: number;
}

export interface BillingUsageSnapshot {
  /** Included credit usage percentage (0-100), matching TUI billing summary. */
  usagePct: number;
  /** Usage period type, e.g. `USAGE_PERIOD_TYPE_WEEKLY`. */
  periodType?: string;
  /** RFC 3339 usage period start, when the billing response provides it. */
  periodStartIso?: string;
  /** RFC 3339 usage refresh/reset timestamp. */
  periodEndIso?: string;
}

export interface BillingUsageParts {
  visible: boolean;
  text: string;
  level: "ok" | "warn" | "critical";
  title: string;
  warning: string;
}

export interface TurnStatusView {
  busy: boolean;
  /** Human process label: Thinking / Responding / tool title. */
  process: string;
  /** Elapsed ms for the current turn (0 when idle). */
  elapsedMs: number;
  usage: SessionUsageSnapshot;
}

interface CentLike {
  val?: number;
}

interface BillingPeriodLike {
  type?: string;
  periodType?: string;
  period_type?: string;
  start?: string;
  end?: string;
}

interface BillingConfigLike {
  creditUsagePercent?: number;
  credit_usage_percent?: number;
  currentPeriod?: BillingPeriodLike;
  current_period?: BillingPeriodLike;
  monthlyLimit?: CentLike;
  monthly_limit?: CentLike;
  used?: CentLike;
  billingPeriodStart?: string;
  billing_period_start?: string;
  billingPeriodEnd?: string;
  billing_period_end?: string;
}

interface BillingResponseLike {
  result?: BillingResponseLike;
  config?: BillingConfigLike;
  raw?: unknown;
  value?: unknown;
  text?: unknown;
  content?: Array<{ text?: unknown }>;
}

/** Format elapsed like TUI: `0.5s`, `5.2s`, `32s`, `1m20s`, `1h2m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  const totalSec = ms / 1000;
  if (totalSec < 10) {
    return `${(Math.round(totalSec * 10) / 10).toFixed(1)}s`;
  }
  if (totalSec < 60) {
    return `${Math.floor(totalSec)}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = Math.floor(totalSec % 60);
    return `${totalMin}m${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h${min}m`;
}

/**
 * Compact token count for turn-status arrow form:
 * - &lt;1k: raw
 * - 1k–9.9k: 1.23k
 * - 10k–99.9k: 10.1k
 * - 100k–999k: 100k
 * - ≥1m: 1.23m / 10.1m
 */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  const n = Math.floor(tokens);
  if (n < 1000) {
    return String(n);
  }
  if (n < 10_000) {
    return `${(n / 1000).toFixed(2)}k`;
  }
  if (n < 100_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  if (n < 1_000_000) {
    return `${Math.floor(n / 1000)}k`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(2)}m`;
  }
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * TUI context_bar `fmt_tokens` (≤4 chars style):
 * `0`, `12`, `999`, `1.2K`, `10.0K`, `12K`, `123K`, `1.2M`
 */
export function formatTokensContextBar(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  const n = Math.floor(tokens);
  if (n < 1_000) {
    return String(n);
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1_000)}K`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * Last-resort denominator only when neither ACP `usage_update.size` nor agent
 * model meta `totalContextTokens` is available. Prefer
 * {@link resolveContextWindowSize} with the live catalog.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Resolve context window size (TUI priority):
 * 1. Live usage size (`usage_update.size` / context_state.total)
 * 2. Current model meta from agent (`totalContextTokens`)
 * 3. {@link DEFAULT_CONTEXT_WINDOW} only if `allowDefault`
 */
export function resolveContextWindowSize(
  usageSize: number | undefined,
  modelContextWindow: number | undefined,
  allowDefault = true,
): number | undefined {
  if (usageSize != null && Number.isFinite(usageSize) && usageSize > 0) {
    return Math.floor(usageSize);
  }
  if (
    modelContextWindow != null &&
    Number.isFinite(modelContextWindow) &&
    modelContextWindow > 0
  ) {
    return Math.floor(modelContextWindow);
  }
  return allowDefault ? DEFAULT_CONTEXT_WINDOW : undefined;
}

/**
 * Header / status-bar context display: `8.5K / 500K`.
 * Requires used > 0; uses `size` or {@link DEFAULT_CONTEXT_WINDOW}.
 * Callers should pass agent model window via `size` when known.
 */
export function formatContextBar(
  used?: number,
  size?: number,
): { text: string; pct: number } | undefined {
  if (used == null || !Number.isFinite(used) || used <= 0) {
    return undefined;
  }
  const total =
    size != null && Number.isFinite(size) && size > 0
      ? size
      : DEFAULT_CONTEXT_WINDOW;
  const pct = Math.min(100, (used / total) * 100);
  return {
    text: `${formatTokensContextBar(used)} / ${formatTokensContextBar(total)}`,
    pct,
  };
}

/**
 * Token display for the turn-status row (compact arrow form when no window).
 */
export function formatContextTokens(
  used?: number,
  size?: number,
): string | undefined {
  // TUI hides the token chip until usage is non-zero.
  if (used == null || !Number.isFinite(used) || used <= 0) {
    return undefined;
  }
  const bar = formatContextBar(used, size);
  if (bar) {
    return bar.text;
  }
  return `↓${formatTokensCompact(used)}`;
}

/** Urgency level for context bar color (mirrors TUI breakpoints). */
export function contextUsageLevel(
  pct: number,
): "ok" | "warn" | "critical" {
  if (pct >= 85) {
    return "critical";
  }
  if (pct >= 65) {
    return "warn";
  }
  return "ok";
}

function finiteNumber(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function parseJsonString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function asBillingObject(raw: unknown): BillingResponseLike | undefined {
  if (typeof raw === "string") {
    const parsed = parseJsonString(raw);
    return parsed !== raw ? asBillingObject(parsed) : undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as BillingResponseLike;
}

function unwrapBillingResponse(raw: unknown): BillingResponseLike | undefined {
  let current: unknown = raw;
  for (let i = 0; i < 8; i += 1) {
    const obj = asBillingObject(current);
    if (!obj) {
      return undefined;
    }
    if (obj.config && typeof obj.config === "object") {
      return obj;
    }
    current =
      obj.result ??
      obj.raw ??
      obj.value ??
      obj.text ??
      obj.content?.find((block) => typeof block?.text === "string")?.text;
  }
  return undefined;
}

export function billingUsageResponseShape(raw: unknown): string {
  const parts: string[] = [];
  let current: unknown = raw;
  for (let i = 0; i < 4; i += 1) {
    if (typeof current === "string") {
      const parsed = parseJsonString(current);
      parts.push(parsed === current ? "string" : "string-json");
      current = parsed === current ? undefined : parsed;
      continue;
    }
    if (!current || typeof current !== "object") {
      parts.push(current == null ? "nullish" : typeof current);
      break;
    }
    const obj = current as BillingResponseLike;
    const keys = Object.keys(obj).slice(0, 8).join(",");
    parts.push(`object keys=${keys}`);
    if (obj.config) {
      break;
    }
    current =
      obj.result ??
      obj.raw ??
      obj.value ??
      obj.text ??
      obj.content?.find((block) => typeof block?.text === "string")?.text;
  }
  return parts.join(" -> ");
}

/**
 * TUI billing parity: prefer `creditUsagePercent`, fallback to `used/monthlyLimit`.
 */
export function parseBillingUsageResponse(
  raw: unknown,
): BillingUsageSnapshot | undefined {
  const wrapper = unwrapBillingResponse(raw);
  const config = wrapper?.config;
  if (!config) {
    return undefined;
  }

  const explicitPct = finiteNumber(
    config.creditUsagePercent ?? config.credit_usage_percent,
  );
  const limit = finiteNumber(
    (config.monthlyLimit ?? config.monthly_limit)?.val,
  ) ?? 0;
  const used = finiteNumber(config.used?.val) ?? 0;
  const usagePct =
    explicitPct != null
      ? clampPct(explicitPct)
      : limit > 0
        ? clampPct((used / limit) * 100)
        : 0;

  const currentPeriod = config.currentPeriod ?? config.current_period;
  const periodType =
    currentPeriod?.type ?? currentPeriod?.periodType ?? currentPeriod?.period_type;
  const periodStartIso =
    currentPeriod?.start ?? config.billingPeriodStart ?? config.billing_period_start;
  const periodEndIso =
    currentPeriod?.end ?? config.billingPeriodEnd ?? config.billing_period_end;
  return {
    usagePct,
    periodType,
    periodStartIso,
    periodEndIso,
  };
}

function billingPaceWarning(
  usage: BillingUsageSnapshot,
  nowMs: number,
): string {
  if (!usage.periodStartIso || !usage.periodEndIso || usage.usagePct <= 0) {
    return "";
  }
  const startMs = Date.parse(usage.periodStartIso);
  const endMs = Date.parse(usage.periodEndIso);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    nowMs <= startMs
  ) {
    return "";
  }

  const expectedPct = clampPct(((nowMs - startMs) / (endMs - startMs)) * 100);
  if (expectedPct <= 0 || usage.usagePct <= expectedPct + 5) {
    return "";
  }
  const paceRatio = usage.usagePct / expectedPct;
  if (paceRatio < 1.2) {
    return "";
  }
  const faster = Math.round((paceRatio - 1) * 100);
  return `Usage pace is ${faster}% faster than linear allowance to reset.`;
}

function formatResetTitle(periodEndIso?: string): string {
  if (!periodEndIso) {
    return "";
  }
  const dt = new Date(periodEndIso);
  if (!Number.isFinite(dt.getTime())) {
    return "";
  }
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function billingUsageLabel(periodType?: string): string {
  if (periodType?.includes("WEEKLY")) {
    return "Weekly limit";
  }
  if (periodType?.includes("MONTHLY")) {
    return "Monthly limit";
  }
  return "Usage";
}

export function buildBillingUsageParts(
  usage: BillingUsageSnapshot | undefined,
  nowMs = Date.now(),
): BillingUsageParts {
  if (!usage || !Number.isFinite(usage.usagePct)) {
    return {
      visible: false,
      text: "",
      level: "ok",
      title: "",
      warning: "",
    };
  }
  const usagePct = clampPct(usage.usagePct);
  const warning = billingPaceWarning({ ...usage, usagePct }, nowMs);
  const level =
    usagePct >= 95 || warning
      ? "critical"
      : usagePct >= 90
        ? "warn"
        : "ok";
  const label = billingUsageLabel(usage.periodType);
  const reset = formatResetTitle(usage.periodEndIso);
  const title = [
    `${label}: ${Math.floor(usagePct)}%`,
    reset ? `Next reset: ${reset}` : "",
    warning,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    visible: true,
    text: `Usage ${Math.floor(usagePct)}%${warning ? " !" : ""}`,
    level,
    title,
    warning,
  };
}

/** Cost display: `$0.020`, `$1.20`, `€0.50` — omit free/zero. */
export function formatCost(
  amount?: number,
  currency?: string,
): string | undefined {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const cur = (currency || "USD").toUpperCase();
  const fixed =
    amount < 0.01
      ? amount.toFixed(4)
      : amount < 1
        ? amount.toFixed(3)
        : amount.toFixed(2);
  const symbol =
    cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : `${cur} `;
  return `${symbol}${fixed}`;
}

/**
 * Build left/right strings for the turn-status row (TUI-like).
 * Left: process (+ short phase not required). Right: time · tokens · cost.
 */
export function resolveUsedTokens(usage: SessionUsageSnapshot): number | undefined {
  if (usage.used != null && usage.used > 0) {
    return usage.used;
  }
  if (usage.turnTotalTokens != null && usage.turnTotalTokens > 0) {
    return usage.turnTotalTokens;
  }
  return undefined;
}

/** Header top-right context chip (TUI status-bar style). */
export function buildContextBarParts(
  usage: SessionUsageSnapshot,
  /** Agent model meta window when usage.size is absent (TUI model_window). */
  modelContextWindow?: number,
): {
  visible: boolean;
  text: string;
  pct: number;
  level: "ok" | "warn" | "critical";
  title: string;
} {
  const used = resolveUsedTokens(usage);
  const total = resolveContextWindowSize(usage.size, modelContextWindow);
  const bar = formatContextBar(used, total);
  if (!bar || total == null) {
    return {
      visible: false,
      text: "",
      pct: 0,
      level: "ok",
      title: "",
    };
  }
  return {
    visible: true,
    text: bar.text,
    pct: bar.pct,
    level: contextUsageLevel(bar.pct),
    title: `Context ${Math.round(bar.pct * 10) / 10}% · ${used?.toLocaleString()} / ${total.toLocaleString()} tokens`,
  };
}

export function buildTurnStatusParts(
  view: TurnStatusView,
  /** Agent catalog context window for the current model. */
  modelContextWindow?: number,
): {
  visible: boolean;
  process: string;
  time: string;
  tokens: string;
  cost: string;
  spinning: boolean;
  /** Top-right header context bar (used / window). */
  context: ReturnType<typeof buildContextBarParts>;
} {
  const { busy, process, elapsedMs, usage } = view;
  const used = resolveUsedTokens(usage);
  // Turn row keeps compact arrow form only; full used/window is in the header.
  const tokens =
    used != null
      ? `↓${formatTokensCompact(used)}`
      : "";
  const cost = formatCost(usage.costAmount, usage.currency) ?? "";
  const context = buildContextBarParts(usage, modelContextWindow);

  if (busy) {
    return {
      visible: true,
      process: process || "Working…",
      time: formatElapsed(elapsedMs),
      tokens,
      cost,
      spinning: true,
      context,
    };
  }

  // Idle: process row only if cost remains; context bar lives in the header.
  const hasRow = !!cost;
  return {
    visible: hasRow,
    process: hasRow ? "ready" : "",
    time: "",
    tokens: "",
    cost,
    spinning: false,
    context,
  };
}

/** Map stream events to a process label (TUI activity-ish). */
export function processLabelForSessionUpdate(
  kind: string,
  toolTitle?: string,
): string | undefined {
  switch (kind) {
    case "agent_thought_chunk":
      return "Thinking";
    case "agent_message_chunk":
      return "Responding";
    case "tool_call":
    case "tool_call_update":
      return toolTitle?.trim() || "Tool";
    default:
      return undefined;
  }
}

/**
 * TUI `ThinkingBlock::format_time`: `1.2s` under 60s, else `2m5s`.
 * Used in the collapsed thought header ("Thought for …").
 */
export function formatThoughtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0.0s";
  }
  const secs = ms / 1000;
  if (secs < 60) {
    return `${secs.toFixed(1)}s`;
  }
  const mins = Math.floor(secs / 60);
  const remaining = secs - mins * 60;
  return `${mins}m${remaining.toFixed(0)}s`;
}

/**
 * TUI thinking header labels:
 * - running → `Thinking…`
 * - done with elapsed → `Thought for 1.2s`
 * - done without elapsed → `Thought`
 */
export function formatThoughtHeader(opts: {
  running: boolean;
  elapsedMs?: number;
}): string {
  if (opts.running) {
    return "Thinking…";
  }
  if (
    opts.elapsedMs != null &&
    Number.isFinite(opts.elapsedMs) &&
    opts.elapsedMs > 0
  ) {
    return `Thought for ${formatThoughtElapsed(opts.elapsedMs)}`;
  }
  return "Thought";
}
