import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectAtContext,
  isDirMode,
  isHiddenMode,
  matcherQuery,
  pathRange,
  replaceAtToken,
} from "./atContext.ts";

describe("detectAtContext", () => {
  it("basic @ token", () => {
    const ctx = detectAtContext("@foo", 4)!;
    assert.ok(ctx);
    assert.deepEqual(ctx.range, { start: 0, end: 4 });
    assert.equal(ctx.query, "foo");
    assert.equal(isDirMode(ctx), false);
    assert.equal(isHiddenMode(ctx), false);
  });

  it("at with prefix text", () => {
    const ctx = detectAtContext("hello @bar/baz", 14)!;
    assert.deepEqual(ctx.range, { start: 6, end: 14 });
    assert.equal(ctx.query, "bar/baz");
  });

  it("cursor mid token dir mode", () => {
    const ctx = detectAtContext("@foo/bar", 5)!;
    assert.deepEqual(ctx.range, { start: 0, end: 8 });
    assert.equal(ctx.query, "foo/");
    assert.equal(isDirMode(ctx), true);
  });

  it("cursor at sign only", () => {
    const ctx = detectAtContext("@", 1)!;
    assert.deepEqual(ctx.range, { start: 0, end: 1 });
    assert.equal(ctx.query, "");
  });

  it("rejects email-like", () => {
    assert.equal(detectAtContext("user@example", 12), null);
    assert.equal(detectAtContext("test_@foo", 9), null);
  });

  it("cursor past token", () => {
    assert.equal(detectAtContext("@foo bar", 5), null);
    assert.equal(detectAtContext("@foo bar", 8), null);
  });

  it("hidden mode", () => {
    const ctx = detectAtContext("@!foo", 5)!;
    assert.equal(isHiddenMode(ctx), true);
    assert.equal(matcherQuery(ctx), "foo");
  });

  it("dir mode", () => {
    const ctx = detectAtContext("@src/", 5)!;
    assert.equal(isDirMode(ctx), true);
    assert.equal(ctx.query, "src/");
    assert.equal(matcherQuery(ctx), "src/");
  });

  it("multiple at picks rightmost", () => {
    const ctx = detectAtContext("@first @second", 14)!;
    assert.equal(ctx.query, "second");
    assert.deepEqual(ctx.range, { start: 7, end: 14 });
  });

  it("at after special chars", () => {
    assert.ok(detectAtContext("(@foo", 5));
    assert.ok(detectAtContext(" @foo", 5));
    assert.ok(detectAtContext(",@foo", 5));
  });

  it("empty text / cursor at zero", () => {
    assert.equal(detectAtContext("", 0), null);
    assert.equal(detectAtContext("@foo", 0), null);
  });

  it("token delimited by comma / semicolon", () => {
    const a = detectAtContext("@foo,@bar", 4)!;
    assert.deepEqual(a.range, { start: 0, end: 4 });
    assert.equal(a.query, "foo");
    const b = detectAtContext("@foo;rest", 4)!;
    assert.deepEqual(b.range, { start: 0, end: 4 });
    assert.equal(b.query, "foo");
  });
});

describe("pathRange / replaceAtToken", () => {
  it("path range skips @ and !", () => {
    const ctx = detectAtContext("@!src/a", 7)!;
    assert.deepEqual(pathRange(ctx), { start: 2, end: 7 });
  });

  it("replace strips token", () => {
    const ctx = detectAtContext("see @file.ts please", 12)!;
    const r = replaceAtToken("see @file.ts please", ctx, "");
    assert.equal(r.text, "see  please");
    assert.equal(r.cursor, 4);
  });
});
