import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEngineActivity } from "../web/engine-activity.js";

const config = [
  { agentId: "architect", engine: "claude", modelId: "deepseek", enabled: true },
  { agentId: "reviewer", engine: "claude", modelId: "deepseek", enabled: true },
  { agentId: "cloud-arbiter", engine: "claude", modelId: "deepseek", enabled: true },
  { agentId: "build", engine: "opencode", modelId: "mimo", enabled: true },
];
const row = (id: string, agentId: string, engine: string, status: string, sessionId: string | null = null) =>
  ({ id, agentId, engine, status, sessionId, modelId: engine === "claude" ? "deepseek" : "mimo", permissionProfile: "read-only" });

test("security audit groups real instances, not placeholder rows, one chip per configured role", () => {
  const rows = [
    ...config.map(a => row("base-" + a.agentId, a.agentId, a.engine, "skipped")),
    row("sa-1", "architect", "claude", "succeeded", "session-1"),
    row("sa-2", "architect", "claude", "running", "session-2"),
    row("sa-3", "build", "opencode", "waiting", "session-3"),
    row("sa-4", "build", "opencode", "succeeded", "session-4"),
  ];
  const claude = projectEngineActivity("claude", rows, config, true, true);
  assert.equal(claude.roles.length, 3);
  assert.equal(claude.instances.length, 2);
  assert.equal(claude.roles[0]?.status, "running");
  assert.equal(claude.roles[0]?.succeeded, 1);
  assert.equal(claude.roles[1]?.status, "available");
  assert.equal(claude.roles[2]?.status, "available");
  const opencode = projectEngineActivity("opencode", rows, config, true, true);
  assert.equal(opencode.roles.length, 1);
  assert.equal(opencode.roles[0]?.status, "waiting");
  assert.equal(opencode.instances.length, 2);
});

test("finished audit distinguishes uninvoked configured roles from disabled roles", () => {
  const a = projectEngineActivity("claude", [], [
    ...config, { agentId: "other", engine: "claude", enabled: false, modelId: "deepseek" }
  ], true, false);
  assert.equal(a.roles.find(r => r.agentId === "reviewer")?.status, "not-invoked");
  assert.equal(a.roles.find(r => r.agentId === "other")?.status, "disabled");
  assert.equal(a.allSucceeded, false);
});

test("normal task retains plan-skipped and explicitly disabled roles without inflating totals", () => {
  const a = projectEngineActivity("claude", [
    row("a", "architect", "claude", "succeeded", "s"),
    row("b", "reviewer", "claude", "skipped"),
    row("c", "cloud-arbiter", "claude", "skipped"),
  ], config.map(x => x.agentId === "cloud-arbiter" ? { ...x, enabled: false } : x), false, false);
  assert.equal(a.instances.length, 1);
  assert.equal(a.succeeded, 1);
  assert.equal(a.roles.find(r => r.agentId === "reviewer")?.status, "not-selected");
  assert.equal(a.roles.find(r => r.agentId === "cloud-arbiter")?.status, "disabled");
});
