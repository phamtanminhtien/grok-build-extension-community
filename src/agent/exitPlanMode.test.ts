import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exitPlanModeResponse,
  parseExitPlanModeRequest,
} from "./exitPlanMode.ts";

describe("parseExitPlanModeRequest", () => {
  it("parses camelCase request", () => {
    const r = parseExitPlanModeRequest({
      sessionId: "sess-1",
      toolCallId: "tc-1",
      planContent: "# Plan\n\nDo stuff",
    });
    assert.deepEqual(r, {
      sessionId: "sess-1",
      toolCallId: "tc-1",
      planContent: "# Plan\n\nDo stuff",
    });
  });

  it("unwraps nested ExtRequest params", () => {
    const r = parseExitPlanModeRequest({
      method: "x.ai/exit_plan_mode",
      params: {
        sessionId: "s",
        toolCallId: "t",
        planContent: null,
      },
    });
    assert.equal(r?.sessionId, "s");
    assert.equal(r?.toolCallId, "t");
    assert.equal(r?.planContent, undefined);
  });

  it("rejects missing ids", () => {
    assert.equal(parseExitPlanModeRequest({ sessionId: "only" }), null);
    assert.equal(parseExitPlanModeRequest(null), null);
  });
});

describe("exitPlanModeResponse", () => {
  it("includes feedback only for cancelled with text", () => {
    assert.deepEqual(exitPlanModeResponse("approved"), { outcome: "approved" });
    assert.deepEqual(exitPlanModeResponse("abandoned"), {
      outcome: "abandoned",
    });
    assert.deepEqual(exitPlanModeResponse("cancelled", "  fix tests  "), {
      outcome: "cancelled",
      feedback: "fix tests",
    });
    assert.deepEqual(exitPlanModeResponse("cancelled", "  "), {
      outcome: "cancelled",
    });
  });
});
