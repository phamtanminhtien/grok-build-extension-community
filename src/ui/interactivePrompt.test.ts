import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAskUserQuestionRequest,
  permissionOptionLabel,
} from "./interactivePrompt.ts";

describe("parseAskUserQuestionRequest", () => {
  it("parses camelCase payload", () => {
    const p = parseAskUserQuestionRequest({
      sessionId: "s1",
      toolCallId: "tc1",
      mode: "plan",
      questions: [
        {
          question: "Which DB?",
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "Embedded", preview: "file.db" },
          ],
          multiSelect: true,
        },
      ],
    });
    assert.ok(p);
    assert.equal(p!.sessionId, "s1");
    assert.equal(p!.toolCallId, "tc1");
    assert.equal(p!.mode, "plan");
    assert.equal(p!.questions.length, 1);
    assert.equal(p!.questions[0]!.multiSelect, true);
    assert.equal(p!.questions[0]!.options[1]!.preview, "file.db");
  });

  it("parses snake_case multi_select", () => {
    const p = parseAskUserQuestionRequest({
      session_id: "s2",
      tool_call_id: "tc2",
      mode: "default",
      questions: [
        {
          question: "OK?",
          options: [{ label: "Yes", description: "y" }],
          multi_select: false,
        },
      ],
    });
    assert.ok(p);
    assert.equal(p!.mode, "default");
    assert.equal(p!.questions[0]!.multiSelect, false);
  });

  it("returns null without questions", () => {
    assert.equal(parseAskUserQuestionRequest({ sessionId: "x" }), null);
    assert.equal(parseAskUserQuestionRequest(null), null);
  });
});

describe("permissionOptionLabel", () => {
  it("falls back by kind", () => {
    assert.equal(permissionOptionLabel("allow_once", ""), "Allow once");
    assert.equal(permissionOptionLabel("reject_always", "No"), "No");
  });
});
