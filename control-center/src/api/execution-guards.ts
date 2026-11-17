/**
 * Small, deterministic guards shared by the execution runtime and its tests.
 * They constrain coordination state only; they do not remove engine tools or
 * reduce the capabilities available under an agent's configured permission profile.
 */

export type AgentRunApprovalLedger = Map<string, Set<string>>;

export function grantAgentRunApprovalKey(
  ledger: AgentRunApprovalLedger,
  agentRunId: string,
  approvalKey: string
): void {
  if (!agentRunId.trim() || !approvalKey.trim()) return;
  const keys = ledger.get(agentRunId) ?? new Set<string>();
  keys.add(approvalKey);
  ledger.set(agentRunId, keys);
}

export function hasAgentRunApprovalKey(
  ledger: ReadonlyMap<string, ReadonlySet<string>>,
  agentRunId: string,
  approvalKey: string
): boolean {
  if (!agentRunId.trim() || !approvalKey.trim()) return false;
  return ledger.get(agentRunId)?.has(approvalKey) ?? false;
}

export function createExecutionAdmissionGate() {
  let reserved = false;

  return {
    tryAcquire(): (() => void) | null {
      if (reserved) return null;
      reserved = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reserved = false;
      };
    },
    isReserved(): boolean {
      return reserved;
    }
  };
}
