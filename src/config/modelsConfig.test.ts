import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  loadModelsConfig,
  persistModelsConfig,
  resolveModelsConfigFromToml,
} from "./modelsConfig.ts";

describe("resolveModelsConfigFromToml", () => {
  it("reads default and default_reasoning_effort", () => {
    const text = `[models]
default = "grok-4.5"
default_reasoning_effort = "high"
`;
    assert.deepEqual(resolveModelsConfigFromToml(text), {
      defaultModel: "grok-4.5",
      defaultReasoningEffort: "high",
    });
  });

  it("returns empty when missing", () => {
    assert.deepEqual(resolveModelsConfigFromToml(""), {
      defaultModel: "",
      defaultReasoningEffort: "",
    });
    assert.deepEqual(resolveModelsConfigFromToml('[ui]\ntheme = "x"\n'), {
      defaultModel: "",
      defaultReasoningEffort: "",
    });
  });
});

describe("persistModelsConfig", () => {
  it("writes and updates both keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-models-"));
    const cfg = path.join(dir, "config.toml");
    try {
      fs.writeFileSync(cfg, `[ui]\ntheme = "t"\n`, "utf8");
      persistModelsConfig(
        { defaultModel: "grok-4.5", defaultReasoningEffort: "high" },
        cfg,
      );
      assert.deepEqual(loadModelsConfig(cfg), {
        defaultModel: "grok-4.5",
        defaultReasoningEffort: "high",
      });
      const text = fs.readFileSync(cfg, "utf8");
      assert.match(text, /\[models\]/);
      assert.match(text, /default = "grok-4.5"/);
      assert.match(text, /default_reasoning_effort = "high"/);
      assert.match(text, /theme = "t"/);

      persistModelsConfig({ defaultReasoningEffort: "low" }, cfg);
      assert.deepEqual(loadModelsConfig(cfg), {
        defaultModel: "grok-4.5",
        defaultReasoningEffort: "low",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
