export interface ActivityAssignment {
  agentId: string; engine: string; modelId: string; enabled: boolean;
}
export interface ActivityInstance {
  id: string; agentId: string; engine: string; status: string; modelId: string;
  permissionProfile: string; sessionId: string | null;
}
export function projectEngineActivity<T extends ActivityInstance>(
  engine: string, rows: readonly T[], assignments: readonly ActivityAssignment[],
  audit: boolean, active: boolean,
) {
  const instances = rows.filter(row => row.engine === engine &&
    !(audit && row.status === "skipped" && !row.sessionId));
  const groups = new Map<string, { assignment?: ActivityAssignment; instances: T[] }>();
  for (const assignment of assignments.filter(a => a.engine === engine)) {
    groups.set(assignment.agentId, { assignment, instances: [] });
  }
  for (const instance of instances) {
    const group = groups.get(instance.agentId) ?? { instances: [] };
    group.instances.push(instance); groups.set(instance.agentId, group);
  }
  const roles = [...groups.entries()].map(([agentId, group]) => {
    const actual = group.instances.filter(i => i.status !== "skipped");
    const skipped = group.instances.length > 0 && actual.length === 0;
    const status = ["waiting", "running", "queued", "failed", "interrupted", "cancelled"].find(
      status => actual.some(i => i.status === status))
      ?? (actual.length ? "succeeded" : group.assignment?.enabled === false ? "disabled" :
        audit ? (active ? "available" : "not-invoked") : skipped ? "not-selected" : "available");
    return { agentId, status, modelId: actual.at(-1)?.modelId ?? group.assignment?.modelId ?? "",
      instances: actual, succeeded: actual.filter(i => i.status === "succeeded").length };
  });
  const real = instances.filter(i => i.status !== "skipped");
  return { roles, instances: real, configuredCount: roles.length,
    active: real.some(i => ["queued", "running", "waiting"].includes(i.status)),
    waiting: real.some(i => i.status === "waiting"),
    allSucceeded: real.length > 0 && real.every(i => i.status === "succeeded"),
    succeeded: real.filter(i => i.status === "succeeded").length };
}
