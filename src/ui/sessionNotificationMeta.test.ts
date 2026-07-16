import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSessionNotificationMeta } from "./sessionNotificationMeta.ts";

describe("parseSessionNotificationMeta", () => {
  it("reads totalTokens from _meta (TUI wire shape)", () => {
    const meta = parseSessionNotificationMeta({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk" },
      _meta: {
        totalTokens: 12_300,
        eventId: "s1-7",
        turnStartMs: 1_700_000_000_000,
      },
    });
    assert.equal(meta.totalTokens, 12300);
    assert.equal(meta.eventId, "s1-7");
    assert.equal(meta.turnStartMs, 1_700_000_000_000);
  });

  it("accepts numeric strings and meta alias", () => {
    const meta = parseSessionNotificationMeta({
      meta: { totalTokens: "8500" },
    });
    assert.equal(meta.totalTokens, 8500);
  });

  it("returns empty for missing meta", () => {
    assert.deepEqual(parseSessionNotificationMeta({}), {});
    assert.deepEqual(parseSessionNotificationMeta(null), {});
  });
});
