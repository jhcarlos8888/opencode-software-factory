import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const isolatedStateDir = mkdtempSync(join(tmpdir(), "factory-control-center-db-test-"));
const previousStateDir = process.env.FACTORY_STATE_DIR;
process.env.FACTORY_STATE_DIR = isolatedStateDir;

// Import only after selecting an isolated state directory: this test must never
// read or mutate the user's real factory database.
const database = await import("./database.js");

test("SQLite state storage is private to the current user", () => {
  const privateStateDir = join(isolatedStateDir, "control-center");
  const stateRootMode = statSync(isolatedStateDir).mode & 0o777;
  const directoryMode = statSync(privateStateDir).mode & 0o777;
  const databaseMode = statSync(join(privateStateDir, "control-center.sqlite")).mode & 0o777;
  assert.equal(stateRootMode, 0o700);
  assert.equal(directoryMode, 0o700);
  assert.equal(databaseMode, 0o600);
});

after(() => {
  if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  else process.env.FACTORY_STATE_DIR = previousStateDir;
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

test("SQLite retains every approval event beyond the UI event window and recovers unfinished work", () => {
  const runId = "database-integration-run";
  const threadId = "database-integration-thread";
  const agentRunId = "database-integration-agent";
  const startedAt = new Date().toISOString();

  database.createWorkThread({
    id: threadId,
    projectPath: isolatedStateDir,
    objective: "Comprobar persistencia y recuperación."
  });
  database.createExecutionRecords({
    id: runId,
    threadId,
    roundNumber: 1,
    configurationSnapshot: null,
    continuityContext: "",
    projectPath: isolatedStateDir,
    instructions: "Comprobar persistencia y recuperación.",
    status: "running",
    startedAt
  }, [{
    id: agentRunId,
    agentId: "architect",
    engine: "claude",
    modelId: "test-model",
    permissionProfile: "approval-required",
    status: "running"
  }]);

  const approvalCount = 350;
  for (let index = 0; index < approvalCount; index++) {
    database.addExecutionEvent(
      runId,
      "HUMAN-REVIEW",
      "success",
      `Autorización limitada a la misma operación durante esta ejecución: operación-${index}.`,
      agentRunId
    );
  }
  // Push old approvals outside the latest-300 general event window.
  for (let index = 0; index < 320; index++) {
    database.addExecutionEvent(runId, "TEST", "info", `INFO-EVENT-${index}`, null);
  }
  database.createExecutionDecision({
    id: "database-integration-pending-decision",
    runId,
    agentRunId,
    engine: "claude",
    engineSessionId: "claude-session",
    engineRequestId: "request-1",
    kind: "permission",
    title: "Autorizar herramienta",
    description: "Aprobación pendiente para la prueba.",
    details: { toolName: "Bash" }
  });

  const approvalEvents = database.getExecutionApprovalEvents(runId);
  assert.equal(approvalEvents.length, approvalCount);
  assert.match(approvalEvents[0]!.message, /operación-0/);
  assert.match(approvalEvents.at(-1)!.message, /operación-349/);

  assert.equal(database.claimExecutionDecision("database-integration-pending-decision"), true);
  assert.equal(database.claimExecutionDecision("database-integration-pending-decision"), false);

  const beforeRecovery = database.getExecutionSnapshot(runId);
  assert.ok(beforeRecovery);
  assert.equal(
    beforeRecovery.events.filter((event) => event.message.includes("Autorización limitada a la misma operación")).length,
    approvalCount
  );
  assert.ok(beforeRecovery.events.some((event) => event.message === "INFO-EVENT-319"));
  assert.equal(beforeRecovery.decisionHistory[0]!.status, "responding");
  assert.equal(beforeRecovery.decisions[0]!.status, "responding");

  database.markUnfinishedExecutionsInterrupted();
  const afterRecovery = database.getExecutionSnapshot(runId);
  assert.ok(afterRecovery);
  assert.equal(afterRecovery.run.status, "interrupted");
  assert.ok(afterRecovery.run.finishedAt);
  const recoveredThread = database.getWorkThreadSnapshot(threadId);
  assert.ok(recoveredThread);
  assert.equal(recoveredThread.thread.status, "failed");
  assert.ok(recoveredThread.messages.some((message) =>
    message.kind === "execution-interrupted" && message.runId === runId
  ));
  assert.equal(afterRecovery.agents[0]!.status, "interrupted");
  assert.ok(afterRecovery.agents[0]!.finishedAt);
  assert.equal(afterRecovery.decisionHistory[0]!.status, "orphaned");
  assert.ok(afterRecovery.decisionHistory[0]!.resolvedAt);
  assert.match(afterRecovery.decisionHistory[0]!.response ?? "", /servicio se reinició/);

  // A second SQLite connection verifies that the results are committed on disk.
  const disk = new DatabaseSync(join(isolatedStateDir, "control-center", "control-center.sqlite"));
  try {
    const run = disk.prepare("SELECT status, finished_at AS finishedAt FROM execution_runs WHERE id = ?")
      .get(runId) as { status: string; finishedAt: string | null };
    const thread = disk.prepare("SELECT status FROM work_threads WHERE id = ?")
      .get(threadId) as { status: string };
    const recoveryMessage = disk.prepare(
      "SELECT kind, run_id AS runId FROM work_messages WHERE thread_id = ? AND kind = 'execution-interrupted'"
    ).get(threadId) as { kind: string; runId: string };
    const agent = disk.prepare("SELECT status, finished_at AS finishedAt FROM execution_agents WHERE id = ?")
      .get(agentRunId) as { status: string; finishedAt: string | null };
    const decision = disk.prepare("SELECT status, resolved_at AS resolvedAt, response FROM execution_decisions WHERE id = ?")
      .get("database-integration-pending-decision") as { status: string; resolvedAt: string | null; response: string | null };
    const persistedApprovals = disk.prepare(
      "SELECT COUNT(*) AS count FROM execution_events WHERE run_id = ? AND message LIKE '%Autorización limitada a la misma operación%'"
    ).get(runId) as { count: number };
    assert.equal(run.status, "interrupted");
    assert.ok(run.finishedAt);
    assert.equal(thread.status, "failed");
    assert.equal(recoveryMessage.kind, "execution-interrupted");
    assert.equal(recoveryMessage.runId, runId);
    assert.equal(agent.status, "interrupted");
    assert.ok(agent.finishedAt);
    assert.equal(decision.status, "orphaned");
    assert.ok(decision.resolvedAt);
    assert.match(decision.response ?? "", /servicio se reinició/);
    assert.equal(persistedApprovals.count, approvalCount);
  } finally {
    disk.close();
  }
});


test("shell execution receipts are queried independently of the latest event window", () => {
  const runId = "shell-receipt-ledger-run";
  const threadId = "shell-receipt-ledger-thread";
  const agentRunId = "shell-receipt-ledger-agent";
  database.createWorkThread({
    id: threadId,
    projectPath: isolatedStateDir,
    objective: "Probar recibos de shell persistidos."
  });
  database.createExecutionRecords({
    id: runId,
    threadId,
    roundNumber: 1,
    configurationSnapshot: null,
    continuityContext: "",
    projectPath: isolatedStateDir,
    instructions: "Probar recibos de shell persistidos.",
    status: "running",
    startedAt: new Date().toISOString()
  }, [{
    id: agentRunId,
    agentId: "tester",
    engine: "opencode",
    modelId: "test-model",
    permissionProfile: "approval-required",
    status: "running"
  }]);

  database.addExecutionEvent(runId, "TESTER", "info",
    "TOOL shell · running · {\"command\":\"./run-tests.sh\",\"workdir\":\"/sandbox\"} · resultado-shell={\"exitCode\":null}", agentRunId);
  database.addExecutionEvent(runId, "TESTER", "info",
    "TOOL shell · completed · {\"command\":\"./run-tests.sh\",\"workdir\":\"/sandbox\"} · resultado-shell={\"exitCode\":1,\"output\":\"CONTRACT FAILURES: 3\"}", agentRunId);
  for (let index = 0; index < 350; index++) {
    database.addExecutionEvent(runId, "TEST", "info", "EVENT-" + index, null);
  }

  const receipts = database.getExecutionShellToolEvents(runId);
  assert.equal(receipts.length, 2);
  assert.match(receipts[0]!.message, /TOOL shell · running/);
  assert.match(receipts[1]!.message, /TOOL shell · completed/);
  assert.match(receipts[1]!.message, /"exitCode":1/);
  assert.match(receipts[1]!.message, /CONTRACT FAILURES: 3/);
});

test("decision claims are atomic, can be released once, and cannot be resolved twice", () => {
  const runId = "decision-claim-run";
  const threadId = "decision-claim-thread";
  const agentRunId = "decision-claim-agent";
  const decisionId = "decision-claim-record";
  database.createWorkThread({ id: threadId, projectPath: isolatedStateDir, objective: "Probar reserva de decisiones." });
  database.createExecutionRecords({
    id: runId, threadId, roundNumber: 1, configurationSnapshot: null, continuityContext: "",
    projectPath: isolatedStateDir, instructions: "Probar reserva de decisiones.",
    status: "running", startedAt: new Date().toISOString()
  }, [{
    id: agentRunId, agentId: "tester", engine: "opencode", modelId: "test-model",
    permissionProfile: "approval-required", status: "running"
  }]);
  database.createExecutionDecision({
    id: decisionId, runId, agentRunId, engine: "opencode", engineSessionId: "session",
    engineRequestId: "request", kind: "permission", title: "Autorizar lectura",
    description: "Decisión de prueba.", details: { action: "read" }
  });

  assert.equal(database.claimExecutionDecision(decisionId), true);
  assert.equal(database.claimExecutionDecision(decisionId), false);
  assert.equal(database.getExecutionSnapshot(runId)?.decisions[0]?.status, "responding");
  assert.equal(database.releaseExecutionDecisionClaim(decisionId), true);
  assert.equal(database.releaseExecutionDecisionClaim(decisionId), false);
  assert.equal(database.claimExecutionDecision(decisionId), true);
  assert.equal(database.resolveExecutionDecision(decisionId, "approved", "Aprobado una vez."), true);
  assert.equal(database.resolveExecutionDecision(decisionId, "rejected", "No."), false);
  assert.equal(database.releaseExecutionDecisionClaim(decisionId), false);
  assert.equal(database.getExecutionSnapshot(runId)?.decisionHistory[0]?.status, "approved");
});

test("project preflight requires a matching decision and saved team snapshot, then is single-use", () => {
  const projectPath = join(isolatedStateDir, "ROUND4-SANDBOX");
  const instructions = "Corregir el defecto deliberadamente introducido.\n";
  const analysis = { name: "ROUND4-SANDBOX", recommendationReady: true, taskPlan: { depth: "focused" } };

  database.recordProjectPreflight(projectPath, instructions, analysis);
  assert.equal(database.getProjectPreflight(projectPath, instructions)?.decision, null);
  assert.equal(database.getProjectPreflight(projectPath, instructions)?.teamSaved, false);
  assert.equal(database.getProjectPreflight(projectPath, instructions + "Cambio"), null);
  assert.equal(database.decideProjectPreflight(projectPath, instructions + "Cambio", "manual"), false);
  assert.match(database.consumeProjectPreflight(projectPath, instructions).reason ?? "", /preconsulta/);

  assert.equal(database.decideProjectPreflight(projectPath, instructions, "manual"), true);
  const afterDecision = database.getProjectPreflight(projectPath, instructions);
  assert.equal(afterDecision?.decision, "manual");
  assert.equal(afterDecision?.teamSaved, false);
  assert.match(database.consumeProjectPreflight(projectPath, instructions).reason ?? "", /Guarda el equipo/);

  const assignments = [
    { agentId: "architect", engine: "claude" as const, modelId: "favorite-claude", permissionProfile: "read-only" as const, enabled: true },
    { agentId: "implementer", engine: "opencode" as const, modelId: "favorite-opencode", permissionProfile: "approval-required" as const, enabled: true }
  ];
  database.saveAssignments(assignments);
  assert.equal(database.getProjectPreflight(projectPath, instructions)?.teamSaved, true);

  assert.deepEqual(database.consumeProjectPreflight(projectPath, instructions), { consumed: true });
  const consumed = database.getProjectPreflight(projectPath, instructions);
  assert.equal(consumed?.consumed, true);
  assert.match(database.consumeProjectPreflight(projectPath, instructions).reason ?? "", /ya fue utilizada/);

  // A fresh preconsultation invalidates both the decision and its one-time token.
  database.recordProjectPreflight(projectPath, instructions, { ...analysis, name: "ROUND4-SANDBOX-REFRESHED" });
  const refreshed = database.getProjectPreflight(projectPath, instructions);
  assert.equal(refreshed?.decision, null);
  assert.equal(refreshed?.teamSaved, false);
  assert.equal(refreshed?.consumed, false);
});
