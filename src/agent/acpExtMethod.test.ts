import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toAcpExtWireMethod } from "./acpExtMethod.ts";

describe("toAcpExtWireMethod", () => {
  it("prefixes bare x.ai methods", () => {
    assert.equal(toAcpExtWireMethod("x.ai/skills/list"), "_x.ai/skills/list");
    assert.equal(toAcpExtWireMethod("x.ai/hooks/list"), "_x.ai/hooks/list");
    assert.equal(toAcpExtWireMethod("x.ai/mcp/list"), "_x.ai/mcp/list");
  });

  it("leaves already-prefixed methods alone", () => {
    assert.equal(
      toAcpExtWireMethod("_x.ai/session_summaries/session_list"),
      "_x.ai/session_summaries/session_list",
    );
  });

  it("trims whitespace", () => {
    assert.equal(
      toAcpExtWireMethod("  x.ai/plugins/list  "),
      "_x.ai/plugins/list",
    );
  });
});
