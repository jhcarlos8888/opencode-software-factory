export interface PermissionPattern {
  action: string;
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function patternMatches(action: string, pattern: string, resource: string): boolean {
  const normalize = (value: string) => value.split(String.fromCharCode(92)).join("/");
  const normalizedPattern = normalize(pattern);
  const normalizedResource = normalize(resource);
  if (
    action === "shell" &&
    normalizedPattern.endsWith(" *") &&
    normalizedResource === normalizedPattern.slice(0, -2)
  ) {
    return true;
  }
  const expression = normalizedPattern.split("").map((character) => {
    if (character === "*") return "[\\s\\S]*";
    if (character === "?") return "[\\s\\S]";
    return "|\\{}()[]^$+?.".includes(character) ? "\\" + character : character;
  }).join("");
  return new RegExp(`^${expression}$`).test(normalizedResource);
}

export function buildRunApprovalPatterns(request: PermissionRequestLike): PermissionPattern[] {
  const action = String(request.action ?? request.permission ?? "").trim();
  if (!action) return [];
  const proposed = stringArray(request.save);
  const resources = stringArray(request.resources).length
    ? stringArray(request.resources)
    : stringArray(request.patterns);
  const candidates = proposed.length ? proposed : resources;
  return [...new Set(candidates)].map((resource) => ({ action, resource }));
}

export function addAgentRunApprovals(
  approvalsByAgent: Map<string, PermissionPattern[]>,
  agentRunId: string,
  additions: PermissionPattern[]
): void {
  if (!agentRunId || additions.length === 0) return;
  const existing = approvalsByAgent.get(agentRunId) ?? [];
  const keys = new Set(existing.map((item) => `${item.action}\0${item.resource}`));
  const merged = [...existing];
  for (const item of additions) {
    const key = `${item.action}\0${item.resource}`;
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
  const resources = stringArray(request.resources).length
    ? stringArray(request.resources)
    : stringArray(request.patterns);
  if (!agentRunId || !action || resources.length === 0) return false;
  const grants = approvalsByAgent.get(agentRunId) ?? [];
  return resources.every((resource) =>
    grants.some((grant) => grant.action === action && patternMatches(action, grant.resource, resource))
  );
}
