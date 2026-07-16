import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextBarParts,
  buildTurnStatusParts,
  formatContextBar,
  formatContextTokens,
  formatCost,
  formatElapsed,
  formatTokensCompact,
  formatTokensContextBar,
  processLabelForSessionUpdate,
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
