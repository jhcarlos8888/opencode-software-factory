import { join, resolve } from "node:path";

export const FACTORY_FILESYSTEM_SERVER_NAME = "factory_filesystem";

const FACTORY_FILESYSTEM_TOOLS = new Set(["list_files", "read_file", "search_text", "summarize_junit"]);

/**
 * A per-session, project-rooted stdio MCP configuration for Claude Code.
 * The CLI inherits cwd=projectPath, while the executable path is absolute
 * under the installed factory runtime.
 */
export function createClaudeFactoryMcpConfig(factoryRoot: string, nodeExecutable = process.execPath) {
  const entryPoint = resolve(join(factoryRoot, ".opencode", "mcp", "factory-filesystem.mjs"));
  return {
    [FACTORY_FILESYSTEM_SERVER_NAME]: {
      type: "stdio" as const,
      command: nodeExecutable,
      args: [entryPoint],
      alwaysLoad: true,
      timeout: 30000
    }
  };
}

/**
 * Only the named read-only tools from our private MCP may bypass the general
 * MCP deny rule. The server itself exposes no write/shell/network methods.
 */
export function isAllowedFactoryFilesystemMcpTool(toolName: string, serverName?: string): boolean {
  if (serverName !== FACTORY_FILESYSTEM_SERVER_NAME) return false;
  const separator = toolName.lastIndexOf("__");
  const candidate = separator >= 0 ? toolName.slice(separator + 2) : toolName;
  if (FACTORY_FILESYSTEM_TOOLS.has(candidate)) return true;
  return [...FACTORY_FILESYSTEM_TOOLS].some((name) =>
    toolName === `mcp__${FACTORY_FILESYSTEM_SERVER_NAME}_${name}`
  );
}

export function isFactoryFilesystemToolName(toolName: string): boolean {
  return [...FACTORY_FILESYSTEM_TOOLS].some((name) =>
    toolName === `mcp__${FACTORY_FILESYSTEM_SERVER_NAME}__${name}` ||
    toolName === `mcp__${FACTORY_FILESYSTEM_SERVER_NAME}_${name}`
  );
}
