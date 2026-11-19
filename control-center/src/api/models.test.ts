import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeConnectorModelCatalog,
  type ModelOption
} from "./models.js";

const catalog: ModelOption[] = [
  { id: "opencode-go/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", source: "detected" },
  { id: "opencode-go/glm-5.3-flash", label: "glm-5.3-flash", source: "detected" },
  { id: "opencode-go/mimo-v2.6-flash", label: "mimo-v2.6-flash", source: "detected" },
  { id: "nvidia/z-ai/glm-5.3-flash", label: "glm on Nvidia", source: "detected" },
  { id: "opencode/deepseek-v4.1-flash-free", label: "free model", source: "detected" }
];

test("Claude Code receives only models from its automatically detected OpenCode Go connector", () => {
  const models = buildClaudeConnectorModelCatalog("opencode-go", catalog, "deepseek-v4.1-flash");
  const detected = models.filter((model) => model.source === "detected");

  assert.deepEqual(detected.map((model) => model.id), [
    "deepseek-v4.1-flash",
    "glm-5.3-flash",
    "mimo-v2.6-flash"
  ]);
  assert.ok(models.some((model) => model.id === "sonnet" && model.source === "alias"));
  assert.ok(models.some((model) => model.id === "opus" && model.source === "alias"));
  assert.ok(models.some((model) => model.id === "haiku" && model.source === "alias"));
  assert.ok(models.every((model) => !model.id.startsWith("opencode-go/")));
});

test("Claude Code deduplicates a configured model already present in the connector catalog", () => {
  const models = buildClaudeConnectorModelCatalog("opencode-go", catalog, "opencode-go/deepseek-v4.1-flash");
  assert.equal(models.filter((model) => model.id === "deepseek-v4.1-flash").length, 1);
  assert.match(models[0]?.label ?? "", /configurado en settings.json/);
});

test("Claude Code keeps its configured model and aliases when the connector catalog has no matching provider", () => {
  const models = buildClaudeConnectorModelCatalog("opencode-go", [
    { id: "nvidia/z-ai/glm-5.3-flash", label: "unrelated", source: "detected" }
  ], "deepseek-v4.1-flash");
  assert.deepEqual(models.map((model) => model.id), [
    "deepseek-v4.1-flash", "sonnet", "opus", "haiku"
  ]);
});

test("Claude Code does not mix models from an unrelated connector when APMix is detected", () => {
  const models = buildClaudeConnectorModelCatalog("apmix", catalog, "apmix/claude-sonnet");
  assert.deepEqual(models.map((model) => model.id), [
    "claude-sonnet", "sonnet", "opus", "haiku"
  ]);
});
