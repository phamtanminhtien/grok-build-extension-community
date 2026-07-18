import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  billingUsageResponseShape,
  buildBillingUsageParts,
  buildContextBarParts,
  buildTurnStatusParts,
  formatContextBar,
  formatContextTokens,
  formatCost,
  formatElapsed,
  formatThoughtElapsed,
  formatThoughtHeader,
  formatTokensCompact,
  formatTokensContextBar,
  parseBillingUsageResponse,
  processLabelForSessionUpdate,
  resolveContextWindowSize,
} from "./turnStatusFormat.ts";

describe("formatElapsed", () => {
  it("formats sub-minute like TUI", () => {
    assert.equal(formatElapsed(500), "0.5s");
    assert.equal(formatElapsed(5200), "5.2s");
    assert.equal(formatElapsed(32_000), "32s");
    assert.equal(formatElapsed(59_000), "59s");
  });

  it("formats minutes and hours", () => {
    assert.equal(formatElapsed(60_000), "1m0s");
    assert.equal(formatElapsed(80_000), "1m20s");
    assert.equal(formatElapsed(3_600_000), "1h0m");
    assert.equal(formatElapsed(3_725_000), "1h2m");
  });
});

describe("formatTokensCompact", () => {
  it("formats tiers", () => {
    assert.equal(formatTokensCompact(500), "500");
    assert.equal(formatTokensCompact(1230), "1.23k");
    assert.equal(formatTokensCompact(10_100), "10.1k");
    assert.equal(formatTokensCompact(100_000), "100k");
    assert.equal(formatTokensCompact(1_230_000), "1.23m");
  });
});

describe("formatTokensContextBar / formatContextBar", () => {
  it("matches TUI-style K/M labels", () => {
    assert.equal(formatTokensContextBar(12), "12");
    assert.equal(formatTokensContextBar(1_200), "1.2K");
    assert.equal(formatTokensContextBar(12_000), "12K");
    assert.equal(formatTokensContextBar(1_200_000), "1.2M");
  });

  it("builds used / window with default 200K", () => {
    const bar = formatContextBar(12_300, undefined);
    assert.ok(bar);
    assert.equal(bar!.text, "12K / 200K");
    assert.ok(bar!.pct > 0 && bar!.pct < 100);
  });

  it("uses explicit window size", () => {
    assert.equal(formatContextBar(8_500, 256_000)?.text, "8.5K / 256K");
  });

  it("prefers agent model window 500K over default", () => {
    assert.equal(resolveContextWindowSize(undefined, 500_000), 500_000);
    assert.equal(resolveContextWindowSize(256_000, 500_000), 256_000);
    const c = buildContextBarParts({ used: 12_000 }, 500_000);
    assert.equal(c.visible, true);
    assert.equal(c.text, "12K / 500K");
  });
});

describe("formatContextTokens / formatCost", () => {
  it("joins used/size for legacy helper", () => {
    assert.equal(formatContextTokens(8500, 256_000), "8.5K / 256K");
    assert.equal(formatContextTokens(100, undefined), "100 / 200K");
  });

  it("formats money", () => {
    assert.equal(formatCost(0.02, "USD"), "$0.020");
    assert.equal(formatCost(1.2, "USD"), "$1.20");
    assert.equal(formatCost(0, "USD"), undefined);
    assert.equal(formatCost(undefined), undefined);
  });
});

describe("billing usage", () => {
  it("prefers creditUsagePercent over legacy cents", () => {
    const usage = parseBillingUsageResponse({
      config: {
        creditUsagePercent: 42.5,
        monthlyLimit: { val: 1000 },
        used: { val: 990 },
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-01T00:00:00Z",
          end: "2026-08-01T00:00:00Z",
        },
      },
    });
    assert.equal(usage?.usagePct, 42.5);
    assert.equal(usage?.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
    assert.equal(usage?.periodEndIso, "2026-08-01T00:00:00Z");
  });

  it("falls back to used divided by monthlyLimit", () => {
    const usage = parseBillingUsageResponse({
      result: {
        config: {
          monthlyLimit: { val: 4000 },
          used: { val: 1000 },
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      },
    });
    assert.equal(usage?.usagePct, 25);
    assert.equal(usage?.periodEndIso, "2026-08-01T00:00:00Z");
  });

  it("matches TUI fallback to 0% when config has no usage fields", () => {
    const usage = parseBillingUsageResponse({
      config: {},
      subscription_tier: "SuperGrok",
    });
    assert.equal(usage?.usagePct, 0);
    assert.equal(buildBillingUsageParts(usage).text, "Usage 0%");
  });

  it("accepts nested envelopes and snake_case fields", () => {
    const usage = parseBillingUsageResponse({
      result: {
        result: {
          config: {
            credit_usage_percent: 33.4,
            current_period: {
              start: "2026-07-01T00:00:00Z",
              end: "2026-07-08T00:00:00Z",
            },
          },
        },
      },
    });
    assert.equal(usage?.usagePct, 33.4);
    assert.equal(usage?.periodStartIso, "2026-07-01T00:00:00Z");
    assert.equal(usage?.periodEndIso, "2026-07-08T00:00:00Z");
  });

  it("accepts raw JSON strings and content text blocks", () => {
    const json = JSON.stringify({
      config: {
        creditUsagePercent: 12,
        currentPeriod: { end: "2026-08-01T00:00:00Z" },
      },
    });
    assert.equal(parseBillingUsageResponse(json)?.usagePct, 12);
    assert.equal(
      parseBillingUsageResponse({ content: [{ type: "text", text: json }] })
        ?.periodEndIso,
      "2026-08-01T00:00:00Z",
    );
  });

  it("summarizes empty response shapes without dumping values", () => {
    assert.equal(
      billingUsageResponseShape({ result: { value: "{\"config\":null}" } }),
      "object keys=result -> object keys=value -> string-json -> object keys=config",
    );
  });

  it("warns when usage is ahead of linear pace to reset", () => {
    const parts = buildBillingUsageParts(
      {
        usagePct: 50,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodStartIso: "2026-07-01T00:00:00Z",
        periodEndIso: "2026-07-11T00:00:00Z",
      },
      Date.parse("2026-07-03T00:00:00Z"),
    );
    assert.equal(parts.visible, true);
    assert.equal(parts.text, "Usage 50% !");
    assert.equal(parts.level, "critical");
    assert.match(parts.title, /^Weekly limit: 50%\nNext reset: /);
    assert.match(parts.warning, /faster than linear allowance/);
  });

  it("uses monthly label in billing tooltip", () => {
    const parts = buildBillingUsageParts({
      usagePct: 10,
      periodType: "USAGE_PERIOD_TYPE_MONTHLY",
      periodEndIso: "2026-08-01T00:00:00Z",
    });
    assert.match(parts.title, /^Monthly limit: 10%\nNext reset: /);
  });
});

describe("buildContextBarParts / buildTurnStatusParts", () => {
  it("header context bar shows used / window top-right style", () => {
    const c = buildContextBarParts({ used: 12_000, size: 256_000 });
    assert.equal(c.visible, true);
    assert.equal(c.text, "12K / 256K");
    assert.equal(c.level, "ok");
  });

  it("busy shows process + time; context separate", () => {
    const p = buildTurnStatusParts({
      busy: true,
      process: "Thinking",
      elapsedMs: 3200,
      usage: { used: 12_000, size: 256_000, costAmount: 0.05, currency: "USD" },
    });
    assert.equal(p.visible, true);
    assert.equal(p.spinning, true);
    assert.equal(p.process, "Thinking");
    assert.equal(p.time, "3.2s");
    assert.ok(p.tokens.startsWith("↓"));
    assert.ok(p.cost.startsWith("$"));
    assert.equal(p.context.text, "12K / 256K");
  });

  it("idle hides process row when only context (no cost)", () => {
    const p = buildTurnStatusParts({
      busy: false,
      process: "",
      elapsedMs: 0,
      usage: { used: 1000, size: 128_000 },
    });
    assert.equal(p.visible, false);
    assert.equal(p.context.visible, true);
    assert.equal(p.context.text, "1.0K / 128K");
  });

  it("idle hides everything when no usage", () => {
    const p = buildTurnStatusParts({
      busy: false,
      process: "",
      elapsedMs: 0,
      usage: {},
    });
    assert.equal(p.visible, false);
    assert.equal(p.context.visible, false);
  });
});

describe("processLabelForSessionUpdate", () => {
  it("maps stream kinds", () => {
    assert.equal(processLabelForSessionUpdate("agent_thought_chunk"), "Thinking");
    assert.equal(processLabelForSessionUpdate("agent_message_chunk"), "Responding");
    assert.equal(
      processLabelForSessionUpdate("tool_call", "Read package.json"),
      "Read package.json",
    );
  });
});

describe("formatThoughtElapsed / formatThoughtHeader", () => {
  it("matches TUI thinking time format", () => {
    assert.equal(formatThoughtElapsed(1200), "1.2s");
    assert.equal(formatThoughtElapsed(500), "0.5s");
    assert.equal(formatThoughtElapsed(65_000), "1m5s");
    assert.equal(formatThoughtElapsed(125_400), "2m5s");
  });

  it("matches TUI thinking headers", () => {
    assert.equal(formatThoughtHeader({ running: true }), "Thinking…");
    assert.equal(
      formatThoughtHeader({ running: false, elapsedMs: 1200 }),
      "Thought for 1.2s",
    );
    assert.equal(formatThoughtHeader({ running: false }), "Thought");
    assert.equal(
      formatThoughtHeader({ running: false, elapsedMs: 0 }),
      "Thought",
    );
  });
});
