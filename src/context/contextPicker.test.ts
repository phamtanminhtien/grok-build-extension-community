import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMentionInsertText } from "./atContext.ts";

describe("formatMentionInsertText", () => {
  it("files become @path with trailing space", () => {
    assert.equal(formatMentionInsertText("file", "src/a.ts"), "@src/a.ts ");
  });

  it("folders become @path/ with trailing space", () => {
    assert.equal(formatMentionInsertText("folder", "src"), "@src/ ");
    assert.equal(formatMentionInsertText("folder", "src/"), "@src/ ");
  });

  it("selections become @path:start-end", () => {
    assert.equal(
      formatMentionInsertText("selection", "src/a.ts", {
        startLine: 10,
        endLine: 20,
      }),
      "@src/a.ts:10-20 ",
    );
  });

  it("single-line selection uses @path:N", () => {
    assert.equal(
      formatMentionInsertText("selection", "a.ts", {
        startLine: 3,
        endLine: 3,
      }),
      "@a.ts:3 ",
    );
  });

  it("strips ./ and kind prefixes from display path", () => {
    assert.equal(formatMentionInsertText("file", "./src/x"), "@src/x ");
    assert.equal(formatMentionInsertText("file", "file:src/x"), "@src/x ");
  });
});
