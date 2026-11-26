import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE,
  selectPrimaryIncompleteReason,
  sortSecurityAuditIncompleteReasons,
} from "./security-audit-orchestrator.js";
import {
  SECURITY_AUDIT_INCOMPLETE_REASONS,
  isSecurityAuditIncompleteReason,
  type SecurityAuditIncompleteReason,
} from "./security-audit-contracts.js";

test("the catch-all never wins when a specific reason is present", () => {
  const reasons: SecurityAuditIncompleteReason[] = [
    "orchestrator_failed",
    "validation_budget_exhausted",
  ];
  assert.equal(selectPrimaryIncompleteReason(reasons), "validation_budget_exhausted");

  const reversed: SecurityAuditIncompleteReason[] = [
    "validation_budget_exhausted",
    "orchestrator_failed",
  ];
  assert.equal(selectPrimaryIncompleteReason(reversed), "validation_budget_exhausted");
});

test("precedence is deterministic and independent of insertion order", () => {
  const ordered: SecurityAuditIncompleteReason[] = [
    "orchestrator_failed",
    "critic_budget_exhausted",
    "validator_failed",
    "provider_unavailable",
  ];
  const shuffled: SecurityAuditIncompleteReason[] = [
    "provider_unavailable",
    "orchestrator_failed",
    "validator_failed",
    "critic_budget_exhausted",
  ];
  assert.equal(selectPrimaryIncompleteReason(ordered), "provider_unavailable");
  assert.equal(selectPrimaryIncompleteReason(shuffled), "provider_unavailable");
  assert.deepEqual(sortSecurityAuditIncompleteReasons(shuffled), [
    "provider_unavailable",
    "validator_failed",
    "critic_budget_exhausted",
    "orchestrator_failed",
  ]);
  // Mismo conjunto en distinto orden → misma lista ordenada.
  assert.deepEqual(
    sortSecurityAuditIncompleteReasons(ordered),
    sortSecurityAuditIncompleteReasons(shuffled),
  );
});

test("deadline beats budget reasons and the budget order matches the official precedence", () => {
  assert.equal(
    selectPrimaryIncompleteReason([
      "validation_budget_exhausted",
      "deadline_exceeded",
    ]),
    "deadline_exceeded",
  );
  assert.equal(
    selectPrimaryIncompleteReason([
      "budget_cannot_fund_reconnaissance_and_reserves",
      "critic_budget_exhausted",
      "budget_cannot_reserve_critics_and_validation",
      "validation_budget_exhausted",
    ]),
    "validation_budget_exhausted",
  );
});

test("empty lists return null and a lone catch-all is preserved", () => {
  assert.equal(selectPrimaryIncompleteReason([]), null);
  assert.equal(selectPrimaryIncompleteReason(["orchestrator_failed"]), "orchestrator_failed");
  assert.deepEqual(sortSecurityAuditIncompleteReasons([]), []);
});

test("every official reason participates in the precedence exactly once", () => {
  assert.deepEqual(
    [...SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE].sort(),
    [...SECURITY_AUDIT_INCOMPLETE_REASONS].sort(),
  );
  assert.equal(new Set(SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE).size, SECURITY_AUDIT_INCOMPLETE_REASONS.length);
  // El catch-all cierra la precedencia: solo gana sin competidores.
  assert.equal(
    SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE[SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE.length - 1],
    "orchestrator_failed",
  );
  for (const reason of SECURITY_AUDIT_INCOMPLETE_REASON_PRECEDENCE) {
    assert.ok(isSecurityAuditIncompleteReason(reason), `motivo oficial: ${reason}`);
  }
});
