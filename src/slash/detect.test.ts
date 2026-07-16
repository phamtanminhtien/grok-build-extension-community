import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectSlashContext,
  parseInvocation,
  replaceSlashToken,
} from "./detect.ts";

describe("detectSlashContext", () => {
  it("detects bare slash", () => {
    const ctx = detectSlashContext("/", 1)!;
    assert.ok(ctx);
    assert.equal(ctx.query, "");
    assert.equal(ctx.inCommand, true);
    assert.deepEqual(ctx.range, { start: 0, end: 1 });
  });

  it("detects partial command", () => {
    const ctx = detectSlashContext("/mod", 4)!;
    assert.equal(ctx.query, "mod");
    assert.equal(ctx.inCommand, true);
  });

  it("allows leading whitespace", () => {
    const ctx = detectSlashContext("  /help", 7)!;
    assert.equal(ctx.query, "help");
    assert.equal(ctx.range.start, 2);
  });

  it("rejects non-slash lines", () => {
    assert.equal(detectSlashContext("hello", 5), null);
    assert.equal(detectSlashContext("a/b", 3), null);
  });

  it("args mode when cursor past name", () => {
    const text = "/compact keep auth";
    const ctx = detectSlashContext(text, text.length)!;
    assert.equal(ctx.inCommand, false);
    assert.equal(ctx.query, "compact");
    assert.equal(ctx.args, "keep auth");
  });
});

describe("parseInvocation", () => {
  it("parses command and args", () => {
    const inv = parseInvocation("/model grok-build high")!;
    assert.equal(inv.key, "model");
    assert.equal(inv.args, "grok-build high");
  });

  it("returns null for non-slash", () => {
    assert.equal(parseInvocation("hello"), null);
  });

  it("trims", () => {
    const inv = parseInvocation("  /new  ")!;
    assert.equal(inv.key, "new");
    assert.equal(inv.args, "");
  });
});

describe("replaceSlashToken", () => {
  it("replaces name and keeps args", () => {
    const ctx = detectSlashContext("/mo keep", 3)!;
    const { text, cursor } = replaceSlashToken("/mo keep", ctx, "/model ");
    assert.equal(text, "/model  keep");
    assert.equal(cursor, "/model ".length);
  });
});
