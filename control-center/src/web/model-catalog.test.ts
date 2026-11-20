import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogProviderOptions, modelsForOpenCodeProvider, openCodeModelProvider, preferredOpenCodeProvider
} from "./model-catalog.js";

const models = [
  { id: "lmstudio/qwen/coder", label: "LM Studio" },
  { id: "nvidia/deepseek", label: "NVIDIA" },
  { id: "opencode-go/deepseek-v4.1-flash", label: "Go Flash" },
  { id: "opencode-go/gemini-4-argon", label: "Go Argon" },
  { id: "opencode/beam-free", label: "OpenCode Free" }
];
test("displays OpenCode Go as an explicit first provider, while keeping others accessible", () => {
  const options = catalogProviderOptions(models);
  assert.equal(options[0]?.id, "opencode-go");
  assert.equal(options[0]?.label, "OpenCode Go");
  assert.equal(options[0]?.count, 2);
  assert.deepEqual(options.map(({ id }) => id).sort(), ["lmstudio", "nvidia", "opencode", "opencode-go"]);
  assert.equal(openCodeModelProvider("opencode-go/gemini-4-argon"), "opencode-go");
  assert.equal(openCodeModelProvider("kimi-k3.1-pro"), "");
});
test("provider selection filters without modifying favorite IDs or catalog input", () => {
  const original = JSON.stringify(models);
  assert.deepEqual(modelsForOpenCodeProvider(models, "opencode-go").map((m) => m.id),
    ["opencode-go/deepseek-v4.1-flash", "opencode-go/gemini-4-argon"]);
  assert.equal(modelsForOpenCodeProvider(models, "all").length, 5);
  assert.equal(modelsForOpenCodeProvider(models, "nvidia").length, 1);
  assert.equal(modelsForOpenCodeProvider(models, "missing").length, 0);
  assert.equal(JSON.stringify(models), original);
});
test("favors Go by default, but never hides other providers if Go is unavailable", () => {
  assert.equal(preferredOpenCodeProvider(models), "opencode-go");
  assert.equal(preferredOpenCodeProvider(models.filter((m) => !m.id.startsWith("opencode-go/"))), "all");
});
