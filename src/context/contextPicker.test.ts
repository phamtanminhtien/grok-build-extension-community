import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMentionInsertText } from "./atContext.ts";
import { fuzzyMatchToSuggestion } from "./fuzzyMatchSuggest.ts";

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

describe("fuzzyMatchToSuggestion", () => {
  it("maps file match to attach-context suggestion", () => {
    const s = fuzzyMatchToSuggestion(
      {
        path: "/repo/src/chat.ts",
        name: "chat.ts",
        type: "file",
        score: 100,
        indices: [],
        isDir: false,
      },
      "src/chat.ts",
      "chat",
    );
    assert.ok(s);
    assert.equal(s!.chip.kind, "file");
    assert.equal(s!.chip.fsPath, "/repo/src/chat.ts");
    assert.equal(s!.label, "src/chat.ts");
    assert.equal(s!.description, "Grok index");
    assert.equal(s!.insertText, "@src/chat.ts ");
    assert.deepEqual(s!.highlightIndices, [4, 5, 6, 7]);
  });

  it("maps directory match with trailing slash", () => {
    const s = fuzzyMatchToSuggestion(
      {
        path: "/repo/src",
        name: "src",
        type: "directory",
        score: 50,
        indices: [],
        isDir: true,
      },
      "src",
    );
    assert.ok(s);
    assert.equal(s!.chip.kind, "folder");
    assert.equal(s!.icon, "folder");
    assert.equal(s!.label, "src/");
    assert.equal(s!.insertText, "@src/ ");
  });

  it("prefers higher agent scores (lower rank)", () => {
    const hi = fuzzyMatchToSuggestion({
      path: "/a",
      name: "a",
      type: "file",
      score: 400,
      indices: [],
      isDir: false,
    });
    const lo = fuzzyMatchToSuggestion({
      path: "/b",
      name: "b",
      type: "file",
      score: 10,
      indices: [],
      isDir: false,
    });
    assert.ok(hi && lo);
    assert.ok(hi!.score < lo!.score);
  });
});
