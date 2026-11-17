export interface PermissionPattern {
  action: string;
  /** Exact resource from the permission request; never a provider-supplied glob. */
  resource: string;
}

export interface PermissionRequestLike {
  action?: unknown;
  permission?: unknown;
  patterns?: unknown;
  resources?: unknown;
  save?: unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 12000);
}

function normalizeResource(action: string, resource: string): string {
  // Filesystem paths may be reported with either separator. Shell commands are
  // compared byte-for-byte: backslashes can be meaningful shell escapes.
  if (["edit", "read", "write", "external_directory"].includes(action)) {
    return resource.replace(/\\/g, "/");
  }
  return resource;
}

/**
 * Build run-scoped grants from the concrete resources that triggered the
 * approval. OpenCode's save field is a suggested persistent pattern and can
 * contain broad values such as "*" even when the actual request targets one
 * file. It is deliberately never trusted as an authorization boundary.
 */
export function buildRunApprovalPatterns(request: PermissionRequestLike): PermissionPattern[] {
  const action = String(request.action ?? request.permission ?? "").trim();
  if (!action) return [];

  const resources = stringArray(request.resources)
    // A wildcard filesystem resource is not a concrete object to authorize.
    .filter((resource) => action === "shell" || !/[*?]/.test(resource));

  if (resources.length === 0) return [];
  return [...new Set(resources.map((resource) => normalizeResource(action, resource)))]
    .map((resource) => ({ action, resource }));
}

export function addAgentRunApprovals(
  approvalsByAgent: Map<string, PermissionPattern[]>,
  agentRunId: string,
  additions: PermissionPattern[]
): void {
  if (!agentRunId.trim() || additions.length === 0) return;
  const existing = approvalsByAgent.get(agentRunId) ?? [];
  const keys = new Set(existing.map((item) => JSON.stringify([item.action, item.resource])));
  const merged = [...existing];
  for (const item of additions) {
    const key = JSON.stringify([item.action, item.resource]);
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(item);
    }
  }
  approvalsByAgent.set(agentRunId, merged);
}

export function matchesAgentRunApproval(
  approvalsByAgent: ReadonlyMap<string, readonly PermissionPattern[]>,
  agentRunId: string,
  request: PermissionRequestLike
): boolean {
  const action = String(request.action ?? request.permission ?? "").trim();
  if (!agentRunId.trim() || !action) return false;

  // Only the engine's concrete resource list may be matched. Its patterns
  // field describes possible grants, not the resource being requested.
  const resources = stringArray(request.resources)
    .filter((resource) => action === "shell" || !/[*?]/.test(resource))
    .map((resource) => normalizeResource(action, resource));
  if (resources.length === 0) return false;

  const grants = approvalsByAgent.get(agentRunId) ?? [];
  return resources.every((resource) =>
    grants.some((grant) => grant.action === action && grant.resource === resource)
  );
}
