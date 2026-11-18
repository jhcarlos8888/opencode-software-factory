import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectFactoryFilesystemMcp,
  inspectOpenCodeAgentRegistry,
  REQUIRED_OPENCODE_AGENT_MODES
} from "./opencode-agents.js";

const completeAgents = Object.entries(REQUIRED_OPENCODE_AGENT_MODES).map(([id, mode]) => ({
  id,
  mode,
  description: "Factory " + id
}));

test("an empty OpenCode response is not considered a ready agent registry", () => {
  const result = inspectOpenCodeAgentRegistry({ data: [] });
  assert.equal(result.ready, false);
  assert.equal(result.loadedCount, 0);
  assert.deepEqual(result.missing, Object.keys(REQUIRED_OPENCODE_AGENT_MODES));
  assert.deepEqual(result.wrongModes, []);
});

test("the registry becomes ready only after all seven agents and modes are loaded", () => {
  const firstResponse = inspectOpenCodeAgentRegistry({ data: completeAgents.slice(0, 2) });
  assert.equal(firstResponse.ready, false);
  assert.equal(firstResponse.missing.length, 5);

  const completeResponse = inspectOpenCodeAgentRegistry({ data: [
    ...completeAgents,
    { id: "general", mode: "subagent" },
    { id: "explore", mode: "subagent" }
  ] });
  assert.equal(completeResponse.ready, true);
  assert.equal(completeResponse.loadedCount, 9);
  assert.deepEqual(completeResponse.missing, []);
  assert.deepEqual(completeResponse.wrongModes, []);
});

test("a registered agent with an unexpected mode blocks execution startup", () => {
  const agents = completeAgents.map((agent) =>
    agent.id === "cloud-arbiter" ? { ...agent, mode: "all" } : agent
  );
  const result = inspectOpenCodeAgentRegistry(agents);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.wrongModes, [{
    id: "cloud-arbiter",
    expected: "subagent",
    actual: "all"
  }]);
});

test("invalid API payloads fail closed instead of being treated as an empty successful list", () => {
  for (const payload of [null, undefined, {}, { data: null }, { data: "agents" }]) {
    assert.equal(inspectOpenCodeAgentRegistry(payload).ready, false);
  }
});


test("factory filesystem MCP is not ready while absent, pending or failed", () => {
  assert.equal(inspectFactoryFilesystemMcp({ data: [] }).ready, false);
  assert.equal(inspectFactoryFilesystemMcp({ data: [
    { name: "factory_filesystem", status: { status: "pending" } }
  ] }).ready, false);
  assert.equal(inspectFactoryFilesystemMcp({ data: [
    { name: "factory_filesystem", status: { status: "failed", error: "MODULE_NOT_FOUND" } }
  ] }).ready, false);
});

test("factory filesystem MCP is ready only when the project-scoped server is connected", () => {
  const result = inspectFactoryFilesystemMcp({ data: [
    { name: "context7", status: { status: "connected" } },
    { name: "factory_filesystem", status: { status: "connected" } }
  ] });
  assert.deepEqual(result, { ready: true, status: "connected", error: null });
});

test("the runtime registry contract matches the seven checked-in factory agent modes", () => {
  assert.deepEqual(REQUIRED_OPENCODE_AGENT_MODES, {
    build: "primary",
    architect: "all",
    implementer: "all",
    reviewer: "all",
    tester: "all",
    "cloud-arbiter": "subagent",
    reverse: "all"
  });
});
