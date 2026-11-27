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


test("audit runtime disables extra MCP servers without altering the provider configuration", async () => {
  const { sourceOnlyOpenCodeConfig, unexpectedAuditMcpServers } = await import("./opencode-agents.js");
  const original = { model: "opencode-go/deepseek", mcp: { servers: {
    factory_filesystem: { type: "local", enabled: true, codemode: true },
    playwright: { type: "local" }, context7: { type: "remote", enabled: true }
  }}};
  const output = sourceOnlyOpenCodeConfig(original, "/test/project with spaces") as typeof original;
  assert.equal(output.model, original.model);
  assert.equal(output.mcp.servers.factory_filesystem.codemode, false);
  assert.deepEqual(Object.keys(output.mcp.servers), ["factory_filesystem"]);
  assert.equal((output.mcp.servers.factory_filesystem as unknown as {command:string[]}).command.at(-1), "/test/project with spaces");
  assert.equal(original.mcp.servers.context7.enabled, true);
  assert.deepEqual(unexpectedAuditMcpServers({data:[
    {name:"factory_filesystem",status:{status:"connected"}},
    {name:"playwright",status:{status:"disabled"}}
  ]}),[]);
  assert.deepEqual(unexpectedAuditMcpServers({data:[
    {name:"factory_filesystem",status:{status:"connected"}},
    {name:"unknown",status:{status:"connected"}}
  ]}),["unknown"]);
  assert.throws(() => sourceOnlyOpenCodeConfig({}, "/test"), /MCP interno/);
});

test("source-only runtime forces codemode:false without mutating the provider configuration", async () => {
  const { sourceOnlyOpenCodeConfig } = await import("./opencode-agents.js");
  const original = { model: "opencode-go/glm", mcp: { servers: {
    factory_filesystem: {
      type: "local", enabled: true, codemode: true, timeout: 5000,
      environment: { FACTORY_FILESYSTEM_MCP_ENTRYPOINT: "/tmp/mcp/entrypoint.js" }
    },
    playwright: { type: "local", enabled: true }
  }}};
  const output = sourceOnlyOpenCodeConfig(original, "/test/project with spaces") as typeof original;
  assert.deepEqual(Object.keys(output.mcp.servers), ["factory_filesystem"]);
  assert.equal(output.mcp.servers.factory_filesystem.codemode, false);
  assert.equal(original.mcp.servers.factory_filesystem.codemode, true);
  assert.deepEqual(Object.keys(original.mcp.servers), ["factory_filesystem", "playwright"]);
  const command = (output.mcp.servers.factory_filesystem as unknown as {command:string[]}).command;
  assert.equal(command.length, 4);
  assert.equal(command[0], "node");
  assert.equal(command[1], "-e");
  assert.match(command[2] ?? "", /FACTORY_FILESYSTEM_MCP_ENTRYPOINT/);
  assert.equal(command.at(-1), "/test/project with spaces");
  assert.equal(output.mcp.servers.factory_filesystem.type, "local");
  assert.equal(output.mcp.servers.factory_filesystem.enabled, true);
  assert.equal(output.mcp.servers.factory_filesystem.timeout, 5000);
  assert.deepEqual(
    output.mcp.servers.factory_filesystem.environment,
    { FACTORY_FILESYSTEM_MCP_ENTRYPOINT: "/tmp/mcp/entrypoint.js" }
  );
});

test("focused OpenCode MCP keeps external servers omitted and passes a closed file list via argv",async()=>{
  const {sourceOnlyOpenCodeConfig}=await import("./opencode-agents.js");
  const config=sourceOnlyOpenCodeConfig({mcp:{servers:{factory_filesystem:{enabled:true},external:{enabled:true}}}},"/project",["src/one.ts"]) as {mcp:{servers:Record<string,{command:string[]}>}};
  assert.deepEqual(Object.keys(config.mcp.servers),["factory_filesystem"]);
  assert.deepEqual(config.mcp.servers.factory_filesystem!.command.slice(-3),["/project","--focused-paths-json",'["src/one.ts"]']);
});
