export const REQUIRED_OPENCODE_AGENT_MODES = {
  build: "primary",
  architect: "all",
  implementer: "all",
  reviewer: "all",
  tester: "all",
  "cloud-arbiter": "subagent",
  reverse: "all"
} as const;

export type RequiredOpenCodeAgentId = keyof typeof REQUIRED_OPENCODE_AGENT_MODES;

export interface OpenCodeAgentRegistryStatus {
  ready: boolean;
  loadedCount: number;
  missing: RequiredOpenCodeAgentId[];
  wrongModes: Array<{
    id: RequiredOpenCodeAgentId;
    expected: string;
    actual: string | null;
  }>;
}

interface OpenCodeAgentSummary {
  id?: unknown;
  mode?: unknown;
}

/**
 * Inspect the public OpenCode /api/agent response. An empty response is not
 * "ready": the V2 server can answer /api/info before its agent registry has
 * finished loading the configured Markdown agents.
 */
export function inspectOpenCodeAgentRegistry(payload: unknown): OpenCodeAgentRegistryStatus {
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];

  const byId = new Map<string, OpenCodeAgentSummary>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const agent = entry as OpenCodeAgentSummary;
    if (typeof agent.id === "string" && agent.id.trim()) byId.set(agent.id, agent);
  }

  const required = Object.entries(REQUIRED_OPENCODE_AGENT_MODES) as Array<
    [RequiredOpenCodeAgentId, (typeof REQUIRED_OPENCODE_AGENT_MODES)[RequiredOpenCodeAgentId]]
  >;
  const missing = required
    .filter(([id]) => !byId.has(id))
    .map(([id]) => id);
  const wrongModes = required.flatMap(([id, expected]) => {
    const agent = byId.get(id);
    if (!agent) return [];
    const actual = agent.mode;
    if (typeof actual === "string" && actual === expected) return [];
    return [{ id, expected, actual: typeof actual === "string" ? actual : null }];
  });

  return {
    ready: missing.length === 0 && wrongModes.length === 0,
    loadedCount: byId.size,
    missing,
    wrongModes
  };
}


export interface OpenCodeMcpRegistryStatus {
  ready: boolean;
  status: string | null;
  error: string | null;
}

/** The secure filesystem MCP must be connected before any agent prompt starts. */
export function inspectFactoryFilesystemMcp(payload: unknown): OpenCodeMcpRegistryStatus {
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const entry = entries.find((item) =>
    Boolean(item) && typeof item === "object" &&
    (item as { name?: unknown }).name === "factory_filesystem"
  ) as { status?: unknown } | undefined;
  const statusObject = entry?.status && typeof entry.status === "object"
    ? entry.status as { status?: unknown; error?: unknown }
    : null;
  const status = typeof statusObject?.status === "string" ? statusObject.status : null;
  const error = typeof statusObject?.error === "string" ? statusObject.error : null;
  return { ready: status === "connected", status, error };
}

/**
 * OpenCode V2 ignores enabled:false on server entries. Omit the external
 * entries altogether, using a private runtime root. A controlled argv
 * argument anchors the internal MCP to the real project independently of
 * the engine session's private location (never load target-local agents/MCP).
 */
export function sourceOnlyOpenCodeConfig(config: Record<string, unknown>, projectPath: string, focusedPaths?: readonly string[]): Record<string, unknown> {
  const mcp = config.mcp as { servers?: Record<string, Record<string, unknown>> } | undefined;
  if (!mcp?.servers?.factory_filesystem) throw new Error("Falta el MCP interno de lectura");
  return { ...config, mcp: { servers: { factory_filesystem: {
    ...mcp.servers.factory_filesystem,
    command: ["node", "-e",
      'const p=require("node:path"),u=require("node:url");const e=p.resolve(process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT);process.chdir(process.argv[1]);import(u.pathToFileURL(e).href).catch(err=>{console.error("[factory-filesystem] "+String(err.message));process.exit(1)});',
      projectPath, ...(focusedPaths === undefined ? [] : ["--focused-paths-json", JSON.stringify(focusedPaths)])],
    enabled: true,
    // Source-only sessions deny `execute`, so with codemode:true these MCP
    // tools would only be reachable through execute and stay unreachable.
    // With codemode:false the server exposes its 4 read-only tools directly,
    // which the source-only allowlist already authorizes by name.
    codemode: false,
  } } } };
}

export function unexpectedAuditMcpServers(payload: unknown): string[] {
  const entries = Array.isArray(payload) ? payload :
    (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data : []);
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== "object") return ["<unknown>"];
    const value = entry as { name?: unknown; status?: { status?: unknown } };
    if (value.name === "factory_filesystem" || value.status?.status === "disabled") return [];
    return [typeof value.name === "string" ? value.name : "<unknown>"];
  });
}
