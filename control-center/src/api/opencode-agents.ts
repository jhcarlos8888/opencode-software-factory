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
