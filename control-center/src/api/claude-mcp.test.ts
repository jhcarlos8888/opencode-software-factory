import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeFactoryMcpConfig, isAllowedFactoryFilesystemMcpTool, isFactoryFilesystemToolName } from "./claude-mcp.js";

test("Claude receives only the project-rooted factory filesystem MCP", () => {
  const config = createClaudeFactoryMcpConfig("/opt/factory", "/usr/bin/node");
  assert.deepEqual(config, {
    factory_filesystem: {
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/factory/.opencode/mcp/factory-filesystem.mjs"],
      alwaysLoad: true,
      timeout: 30000
    }
  });
});

test("only named read-only factory filesystem MCP tools are allowed", () => {
  for (const tool of ["list_files", "read_file", "search_text"]) {
    assert.equal(isAllowedFactoryFilesystemMcpTool(`mcp__factory_filesystem__${tool}`, "factory_filesystem"), true);
    assert.equal(isFactoryFilesystemToolName(`mcp__factory_filesystem__${tool}`), true);
  }
  assert.equal(isAllowedFactoryFilesystemMcpTool("mcp__factory_filesystem__write_file", "factory_filesystem"), false);
  assert.equal(isAllowedFactoryFilesystemMcpTool("mcp__other_server__read_file", "other_server"), false);
  assert.equal(isAllowedFactoryFilesystemMcpTool("mcp__factory_filesystem__read_file", "other_server"), false);
  assert.equal(isFactoryFilesystemToolName("mcp__factory_filesystem__write_file"), false);
});
