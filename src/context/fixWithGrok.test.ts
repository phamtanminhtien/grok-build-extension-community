import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayPathForUri,
  formatFixWithGrokPrompt,
  severityLabel,
  snippetAround,
  type FixWithGrokPayload,
} from "./fixWithGrok.ts";

describe("severityLabel", () => {
  it("maps DiagnosticSeverity-like numbers", () => {
    assert.equal(severityLabel(0), "Error");
    assert.equal(severityLabel(1), "Warning");
    assert.equal(severityLabel(2), "Info");
    assert.equal(severityLabel(3), "Hint");
    assert.equal(severityLabel(99), "Problem");
  });
});

describe("displayPathForUri", () => {
  it("prefers workspace-relative path when provided", () => {
    assert.equal(
      displayPathForUri("file:///Users/me/proj/src/a.ts", "src/a.ts"),
      "src/a.ts",
    );
  });

  it("falls back to fsPath-like string from file URI", () => {
    const p = displayPathForUri("file:///tmp/only.ts", undefined);
    assert.match(p, /only\.ts$/);
  });
});

describe("snippetAround", () => {
  const lines = ["a", "b", "c", "d", "e", "f", "g"];

  it("returns ±3 lines with 1-based line prefixes", () => {
    // center on 0-based line 3 ("d") → lines 1..7
    const s = snippetAround(lines, 3, 3, 3);
    assert.equal(
      s,
      ["1| a", "2| b", "3| c", "4| d", "5| e", "6| f", "7| g"].join("\n"),
    );
  });

  it("clamps at document start", () => {
    const s = snippetAround(lines, 0, 0, 3);
    assert.equal(s, ["1| a", "2| b", "3| c", "4| d"].join("\n"));
  });

  it("clamps at document end", () => {
    const s = snippetAround(lines, 6, 6, 3);
    assert.equal(s, ["4| d", "5| e", "6| f", "7| g"].join("\n"));
  });
});

describe("formatFixWithGrokPrompt", () => {
  const base: FixWithGrokPayload = {
    uri: "file:///Users/me/proj/src/foo.ts",
    message: "Cannot find name 'bar'.",
    severity: 0,
    startLine: 1,
    startCharacter: 0,
    endLine: 1,
    endCharacter: 3,
    languageId: "typescript",
  };

  it("includes severity, path, line, message, and snippet", () => {
    const text = formatFixWithGrokPrompt(base, {
      displayPath: "src/foo.ts",
      lines: ["const x = 1;", "console.log(bar);", "export {};"],
    });
    assert.match(text, /Fix this Error in `src\/foo\.ts` at line 2:/);
    assert.match(text, /Cannot find name 'bar'\./);
    assert.match(text, /```typescript/);
    assert.match(text, /2\| console\.log\(bar\);/);
  });

  it("truncates very long messages", () => {
    const long = "x".repeat(3000);
    const text = formatFixWithGrokPrompt(
      { ...base, message: long },
      { displayPath: "src/foo.ts", lines: ["a"] },
    );
    assert.ok(text.includes("…"));
    assert.ok(!text.includes("x".repeat(2500)));
  });
});
