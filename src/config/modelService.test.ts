import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contextWindowFromCatalog,
  modelDisplayLabel,
  parseModelsFromSessionMeta,
  parseSessionModelState,
} from "./modelCatalog.ts";

describe("parseModelsFromSessionMeta", () => {
  it("reads TUI-shaped x.ai/sessionConfig model options", () => {
    const { models, currentModelId, efforts, currentEffortId } =
      parseModelsFromSessionMeta({
        "x.ai/sessionConfig": {
          options: [
            {
              id: "grok-build",
              category: "model",
              label: "Grok Build",
              selected: true,
            },
            {
              id: "grok-4.5",
              category: "model",
              label: "Grok 4.5",
              selected: false,
            },
            {
              id: "high",
              category: "mode",
              label: "High",
              selected: true,
            },
            {
              id: "low",
              category: "mode",
              label: "Low",
              selected: false,
            },
          ],
        },
        "x.ai/sessionDetail": {
          currentModelId: "grok-build",
        },
      });
    assert.equal(models.length, 2);
    assert.equal(models[0]?.id, "grok-build");
    assert.equal(models[0]?.label, "Grok Build");
    assert.equal(models[0]?.selected, true);
    assert.equal(models[1]?.id, "grok-4.5");
    assert.equal(currentModelId, "grok-build");
    assert.equal(efforts.length, 2);
    assert.equal(currentEffortId, "high");
    assert.equal(efforts[0]?.label, "High");
  });

  it("accepts legacy availableModels wire shape", () => {
    const { models, currentModelId } = parseModelsFromSessionMeta(undefined, {
      currentModelId: "grok-3",
      availableModels: [
        { modelId: "grok-3", name: "Grok 3" },
        { modelId: "grok-3-fast", name: "Grok 3 Fast" },
      ],
    });
    assert.equal(models.length, 2);
    assert.equal(currentModelId, "grok-3");
    assert.equal(models[0]?.selected, true);
    assert.equal(models[1]?.label, "Grok 3 Fast");
  });
});

describe("parseSessionModelState (x.ai/models/update)", () => {
  it("parses full catalog with reasoning efforts", () => {
    const snap = parseSessionModelState({
      currentModelId: "reason-model",
      availableModels: [
        {
          modelId: "reason-model",
          name: "Reasoner",
          meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "low", value: "low", label: "Low" },
              { id: "high", value: "high", label: "High" },
            ],
          },
        },
        { modelId: "grok-build", name: "Grok Build" },
      ],
    });
    assert.equal(snap.models.length, 2);
    assert.equal(snap.currentModelId, "reason-model");
    assert.equal(snap.efforts.length, 2);
    assert.equal(snap.currentEffortId, "high");
    assert.equal(snap.efforts.find((e) => e.id === "high")?.selected, true);
  });

  it("reads totalContextTokens from agent model meta (TUI source)", () => {
    const snap = parseSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          meta: { totalContextTokens: 500_000 },
        },
        {
          modelId: "grok-build",
          name: "Grok Build",
          meta: { totalContextTokens: 500_000 },
        },
      ],
    });
    assert.equal(snap.models[0]?.contextWindow, 500_000);
    assert.equal(
      contextWindowFromCatalog(snap.models, "grok-4.5"),
      500_000,
    );
  });

  it("uses legacy effort menu when supports but list empty", () => {
    const snap = parseSessionModelState({
      currentModelId: "m1",
      availableModels: [
        {
          modelId: "m1",
          name: "M1",
          meta: { supportsReasoningEffort: true, reasoningEffort: "medium" },
        },
      ],
    });
    assert.ok(snap.efforts.length >= 3);
    assert.equal(snap.currentEffortId, "medium");
  });
});

describe("modelDisplayLabel", () => {
  it("prefers catalog name", () => {
    assert.equal(
      modelDisplayLabel(
        [{ id: "grok-build", label: "Grok Build" }],
        "grok-build",
      ),
      "Grok Build",
    );
    assert.equal(modelDisplayLabel([], "x"), "x");
  });
});
