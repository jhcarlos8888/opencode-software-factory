import test from "node:test";
import { addAgentRunApprovals, buildRunApprovalPatterns, matchesAgentRunApproval } from "./permission-approvals.js";
import {
  createExecutionAdmissionGate, grantAgentRunApprovalKey, hasAgentRunApprovalKey
} from "./execution-guards.js";
import assert from "node:assert/strict";
import {
  buildApprovalAuditSummary, buildExecutionSummary, createHandoffDescriptor, createHandoffId,
  selectDeliverableHandoffSources,
  extractCanonicalOpenCodeAssistantText, extractClaudeFinalText, formatApprovalAuditContext,
  hasConcurrentCrossEngineRun, hasHandoffIdAtStart, prepareHandoffOutput, selectOpenCodeHandoffReport, type SummaryAgent
} from "./orchestration.js";

test("OpenCode handoff capture selects only the terminal assistant message", () => {
  const messages = {
    data: [
      {
        info: { id: "assistant-progress", role: "assistant", finish: "tool-calls" },
        parts: [
          { id: "p1", type: "text", text: "Estoy comprobando el proyecto." },
          { id: "t1", type: "tool", tool: "read" }
        ]
      },
      {
        info: { id: "assistant-progress-2", role: "assistant", finish: "tool-calls" },
        parts: [{ id: "p2", type: "text", text: "Ya casi termino." }]
      },
      {
        info: { id: "assistant-final", role: "assistant", finish: "stop" },
        parts: [{ id: "p3", type: "text", text: "HANDOFF-TESTER-12345678\n\nInforme final completo." }]
      }
    ]
  };
  assert.equal(
    extractCanonicalOpenCodeAssistantText(messages),
    "HANDOFF-TESTER-12345678\n\nInforme final completo."
  );
});

test("OpenCode does not promote an intermediate tool-calling message to a final handoff", () => {
  const messages = [{
    info: { id: "assistant-progress", role: "assistant", finish: "tool-calls" },
    parts: [{ type: "text", text: "Esto es solo progreso, no el informe final." }]
  }];
  assert.equal(extractCanonicalOpenCodeAssistantText(messages), null);
});

test("Claude handoff capture uses the SDK result text, not streamed assistant blocks", () => {
  const streamedAssistantBlock = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Estoy revisando los archivos." }] }
  };
  const finalResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "HANDOFF-ARCHITECT-12345678\n\nInforme final de Claude."
  };
  assert.equal(extractClaudeFinalText(streamedAssistantBlock), null);
  assert.equal(extractClaudeFinalText(finalResult), "HANDOFF-ARCHITECT-12345678\n\nInforme final de Claude.");
  assert.equal(extractClaudeFinalText({ ...finalResult, is_error: true }), null);
  assert.equal(extractClaudeFinalText({ ...finalResult, subtype: "error" }), null);
});

test("handoff metadata records exact UTF-8 byte lengths and structured ID authorship", () => {
  const id = "HANDOFF-TESTER-12345678";
  const source = id + "\nResultado verificado ✓ — información completa.";
  const prepared = prepareHandoffOutput(source, id);
  assert.equal(prepared.contentLength, source.length);
  assert.equal(prepared.contentByteLength, Buffer.byteLength(source, "utf8"));
  assert.equal(prepared.sourceByteLength, Buffer.byteLength(source, "utf8"));
  assert.equal(prepared.idAuthor, "agent");
  assert.equal(prepared.sourceIdentityVerified, true);
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
});

test("Arbiter summary parser preserves nested findings tables and bold priority steps", () => {
  const report = [
    "## RESUMEN EJECUTIVO",
    "La ronda terminó con cinco informes de especialistas recibidos y contrastados.",
    "## VEREDICTO",
    "Ejecución técnica completada con observaciones.",
    "## HALLAZGOS CLAVE",
    "### Defectos de la FÁBRICA",
    "| # | Hallazgo | Evidencia | Fuente | Severidad |",
    "|---|---|---|---|---|",
    "| **CF1** | **Informes duplicados** | El texto final se concatenó dos veces en el payload. | reviewer | **Mayor** |",
    "### Defectos del PROYECTO",
    "| **CP1** | **Credenciales versionadas** | Hay valores sensibles en archivos YAML versionados. | tester | **Bloqueante** |",
    "## DISCREPANCIAS RESUELTAS",
    "El árbitro contrastó las posiciones.",
    "## PRÓXIMOS PASOS",
    "**P0 — Capturar solo la respuesta final.** No concatenar bloques de progreso ni el evento final dos veces.",
    "",
    "**P1 — Entregar metadatos al receptor.** Incluir SHA-256, bytes UTF-8, truncamiento y autoría.",
    "## PRUEBAS QUE TODAVÍA FALTAN",
    "Pruebas de timeout."
  ].join("\n");

  const summary = buildExecutionSummary({
    instructions: "Revisión general del proyecto.",
    agents: [{ agentId: "cloud-arbiter", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:05:00Z", handoffIn: [] }],
    results: [],
    cloudArbiterOutput: report
  });

  assert.equal(summary.overview, "La ronda terminó con cinco informes de especialistas recibidos y contrastados.");
  assert.equal(summary.findings.length, 2);
  assert.match(summary.findings[0] ?? "", /CF1.*Informes duplicados/);
  assert.match(summary.findings[1] ?? "", /CP1.*Credenciales versionadas/);
  assert.equal(summary.nextSteps.length, 2);
  assert.match(summary.nextSteps[0] ?? "", /Capturar solo la respuesta final/);
  assert.match(summary.nextSteps[1] ?? "", /Entregar metadatos al receptor/);
});

test("summary integrity verifies hashes and reports IDs added by the orchestrator", () => {
  const id = "HANDOFF-ARCHITECT-12345678";
  const reviewerId = "HANDOFF-REVIEWER-12345678";
  const agentAuthored = prepareHandoffOutput(id + "\nInforme completo ✓.", id);
  const orchestratorAuthored = prepareHandoffOutput("Preambulo del agente.\nInforme completo.", reviewerId);
  const makeResult = (agentId: string, handoffId: string, output: ReturnType<typeof prepareHandoffOutput>) => ({
    agentRunId: agentId + "-run",
    agentId,
    engine: "claude" as const,
    modelId: "deepseek-v4.1-flash",
    sessionId: agentId + "-session",
    status: "succeeded" as const,
    startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z",
    handoffId,
    output: output.content,
    handoffOutput: output
  });
  const summary = buildExecutionSummary({
    instructions: "Analiza el proyecto.",
    agents: [
      { agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:01:00Z", handoffIn: [] },
      { agentId: "reviewer", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:02:00Z", handoffIn: [] }
    ],
    results: [
      makeResult("architect", id, agentAuthored),
      makeResult("reviewer", reviewerId, orchestratorAuthored)
    ]
  });

  assert.equal(summary.integrity.status, "observations");
  assert.equal(summary.integrity.expectedReports, 2);
  assert.equal(summary.integrity.reportsReceived, 2);
  assert.equal(summary.integrity.reportsVerified, 2);
  assert.deepEqual(summary.integrity.orchestratorIdentifiedReports, ["reviewer"]);
  assert.deepEqual(summary.integrity.missingReports, []);
  assert.equal(summary.verdict, "observations");
});

test("summary integrity distinguishes legacy metadata from corrupted reports", () => {
  const id = "HANDOFF-ARCHITECT-12345678";
  const output = id + "\nInforme histórico íntegro.";
  const current = prepareHandoffOutput(output, id);
  const legacy = {
    content: current.content,
    sha256: current.sha256,
    contentLength: current.contentLength,
    sourceLength: current.sourceLength,
    truncated: false,
    sourceIdentityVerified: true
  };
  const agent = {
    agentRunId: "architect-run", agentId: "architect", engine: "claude" as const,
    modelId: "deepseek-v4.1-flash", sessionId: "architect-session",
    status: "succeeded" as const, startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z", handoffId: id,
    output: legacy.content, handoffOutput: legacy
  };
  const summary = buildExecutionSummary({
    instructions: "Auditoría histórica.",
    agents: [{ agentId: "architect", engine: "claude", status: "succeeded", startedAt: agent.startedAt, finishedAt: agent.finishedAt, handoffIn: [] }],
    results: [agent]
  });
  assert.equal(summary.integrity.reportsReceived, 1);
  assert.equal(summary.integrity.reportsVerified, 0);
  assert.deepEqual(summary.integrity.legacyReports, ["architect"]);
  assert.deepEqual(summary.integrity.invalidReports, []);
  assert.equal(summary.integrity.status, "observations");
});

test("summary integrity marks missing, truncated and hash-mismatched reports", () => {
  const truncatedId = "HANDOFF-ARCHITECT-12345678";
  const truncated = prepareHandoffOutput(truncatedId + "\n" + "dato. ".repeat(1800), truncatedId, 5000);
  const tampered = prepareHandoffOutput("HANDOFF-BUILD-12345678\nBuild.", "HANDOFF-BUILD-12345678");
  const corrupted = { ...tampered, sha256: "0".repeat(64) };
  const invalidSourceLength = {
    ...prepareHandoffOutput("HANDOFF-REVIEWER-12345678\nReviewer.", "HANDOFF-REVIEWER-12345678"),
    sourceByteLength: 1
  };
  const baseResult = (agentId: string, handoffId: string, output: ReturnType<typeof prepareHandoffOutput>) => ({
    agentRunId: agentId + "-run", agentId, engine: "opencode" as const,
    modelId: "opencode-go/glm-5.3-flash", sessionId: agentId + "-session",
    status: "succeeded" as const, startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z", handoffId, output: output.content, handoffOutput: output
  });
  const summary = buildExecutionSummary({
    instructions: "Diagnóstico.",
    agents: ["architect", "build", "reviewer", "tester"].map((agentId) => ({
      agentId, engine: "opencode" as const, status: "succeeded" as const,
      startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:01:00Z", handoffIn: []
    })),
    results: [
      baseResult("architect", truncatedId, truncated),
      baseResult("build", "HANDOFF-BUILD-12345678", corrupted),
      baseResult("reviewer", "HANDOFF-REVIEWER-12345678", invalidSourceLength)
    ]
  });
  assert.deepEqual(summary.integrity.truncatedReports, ["architect"]);
  assert.deepEqual(summary.integrity.invalidReports, ["build", "reviewer"]);
  assert.deepEqual(summary.integrity.missingReports, ["tester"]);
  assert.equal(summary.integrity.status, "observations");
  assert.equal(summary.verdict, "observations");
});

test("approval audit summarizes human decisions and automatic run-scoped grants", () => {
  const decisions = [
    {
      id: "decision-approved", agentId: "tester", engine: "opencode" as const,
      kind: "permission" as const, status: "approved", title: "Autorizar acción: shell",
      description: "shell solicita grep y wc en el proyecto.",
      response: "Aprobado durante esta ejecución: shell: grep; wc",
      createdAt: "2026-11-16T20:00:00.000Z", resolvedAt: "2026-11-16T20:00:05.000Z"
    },
    {
      id: "decision-rejected", agentId: "build", engine: "opencode" as const,
      kind: "permission" as const, status: "rejected", title: "Autorizar acción: shell",
      description: "shell solicita una operación fuera del alcance.",
      response: "Rechazado.",
      createdAt: "2026-11-16T20:01:00.000Z", resolvedAt: "2026-11-16T20:01:03.000Z"
    },
    {
      id: "decision-question", agentId: "architect", engine: "claude" as const,
      kind: "question" as const, status: "answered", title: "Aclaración sobre el contrato",
      description: "El agente solicitó una precisión.",
      response: "Conserva el comportamiento actual.",
      createdAt: "2026-11-16T20:02:00.000Z", resolvedAt: "2026-11-16T20:02:10.000Z"
    }
  ];
  const events = [
    {
      area: "TESTER", message: "Autorización temporal aplicada automáticamente durante esta ejecución: shell · opencode --version.",
      createdAt: "2026-11-16T20:03:00.000Z", agentRunId: "tester-run"
    },
    {
      area: "HUMAN-REVIEW", message: "Autorización limitada a esta ejecución: Autorizar acción: shell.",
      createdAt: "2026-11-16T20:00:05.000Z", agentRunId: "tester-run"
    },
    {
      area: "TESTER", message: "Se leyó README.md.",
      createdAt: "2026-11-16T20:04:00.000Z", agentRunId: "tester-run"
    }
  ];
  const summary = buildApprovalAuditSummary(decisions, events);
  assert.deepEqual(summary, {
    recordedDecisions: 3, recordedApprovalEvents: 2, pending: 0, responding: 0, approved: 1, rejected: 1,
    answered: 1, orphaned: 0, automaticApprovals: 1
  });
  const context = formatApprovalAuditContext(decisions, events);
  assert.match(context, /Solicitudes registradas: 3/);
  const decisionLines = context.split("\n").filter((line) => line.startsWith("DECISIÓN_JSON "));
  assert.equal(decisionLines.length, 3);
  const approvedRecord = JSON.parse(decisionLines[0]!.slice("DECISIÓN_JSON ".length));
  assert.equal(approvedRecord.id, "decision-approved");
  assert.equal(approvedRecord.status, "approved");
  assert.match(context, /DECISIÓN_JSON/);
  assert.match(context, /AUTORIZACIÓN TEMPORAL AUTOMÁTICA/);
  assert.match(context, /opencode --version/);
  const executionSummary = buildExecutionSummary({
    instructions: "Consulta de solo lectura.",
    agents: [],
    results: [],
    decisions,
    approvalEvents: events
  });
  assert.deepEqual(executionSummary.approvals, summary);
});

test("approval audit JSON records preserve delimiters, quotes and newlines without corrupting fields", () => {
  const decision = {
    id: "decision-with-delimiters",
    agentId: "implementer",
    engine: "opencode" as const,
    kind: "permission" as const,
    status: "approved",
    title: "Editar un archivo | autorización humana",
    description: "Archivo: src/A.java\nContexto: contiene | y \"comillas\".",
    response: "Aprobado\nOperación exacta: edit | src/A.java",
    createdAt: "2026-11-17T12:00:00.000Z",
    resolvedAt: "2026-11-17T12:00:01.000Z"
  };
  const event = {
    area: "HUMAN-REVIEW",
    message: "Autorización limitada a esta ejecución: edit | src/A.java\nnota=\"solo una línea\".",
    createdAt: "2026-11-17T12:00:01.000Z",
    agentRunId: "implementer-run"
  };
  const context = formatApprovalAuditContext([decision], [event]);
  const decisionLine = context.split("\n").find((line) => line.startsWith("DECISIÓN_JSON "));
  const eventLine = context.split("\n").find((line) => line.startsWith("EVENTO_REVISIÓN_APROBACIÓN_JSON "));
  assert.ok(decisionLine);
  assert.ok(eventLine);
  assert.deepEqual(JSON.parse(decisionLine!.slice("DECISIÓN_JSON ".length)), decision);
  assert.deepEqual(JSON.parse(eventLine!.slice("EVENTO_REVISIÓN_APROBACIÓN_JSON ".length)), {
    area: event.area,
    agentRunId: event.agentRunId,
    createdAt: event.createdAt,
    message: event.message
  });
});

test("a decision being answered is counted separately and blocks a clean verdict", () => {
  const summary = buildExecutionSummary({
    instructions: "Revisión de permisos.",
    agents: [],
    results: [],
    decisions: [{
      id: "decision-responding", agentId: "tester", engine: "opencode",
      kind: "permission", status: "responding", title: "Autorizar herramienta",
      description: "El motor está recibiendo la decisión.", response: null,
      createdAt: "2026-11-17T12:00:00.000Z", resolvedAt: null
    }]
  });
  assert.equal(summary.approvals.pending, 0);
  assert.equal(summary.approvals.responding, 1);
  assert.equal(summary.verdict, "observations");
});

test("unresolved approval requests prevent a clean completed verdict", () => {
  const summary = buildExecutionSummary({
    instructions: "Revisión de arquitectura.",
    agents: [],
    results: [],
    decisions: [{
      id: "decision-pending", agentId: "tester", engine: "opencode",
      kind: "permission", status: "pending", title: "Autorizar una operación",
      description: "La operación sigue esperando aprobación.", response: null,
      createdAt: "2026-11-16T20:00:00.000Z", resolvedAt: null
    }]
  });
  assert.equal(summary.approvals.pending, 1);
  assert.equal(summary.verdict, "observations");
});

test("approval audit keeps review events visible when a decision row is missing", () => {
  const events = [{
    area: "HUMAN-REVIEW",
    message: "Autorización limitada a esta ejecución: Autorizar acción: shell.",
    createdAt: "2026-11-16T20:00:05.000Z",
    agentRunId: "tester-run"
  }];
  const summary = buildApprovalAuditSummary([], events);
  assert.equal(summary.recordedDecisions, 0);
  assert.equal(summary.recordedApprovalEvents, 1);
  assert.equal(summary.automaticApprovals, 0);
  const context = formatApprovalAuditContext([], events);
  assert.match(context, /EVENTO_REVISIÓN_APROBACIÓN_JSON/);
  const eventLine = context.split("\n").find((line) => line.startsWith("EVENTO_REVISIÓN_APROBACIÓN_JSON "));
  assert.ok(eventLine);
  assert.match(JSON.parse(eventLine!.slice("EVENTO_REVISIÓN_APROBACIÓN_JSON ".length)).message, /Autorización limitada a esta ejecución/);
  assert.doesNotMatch(context, /No se registraron solicitudes/);
});

test("approval audit explicitly states when the current round has no approval requests", () => {
  const context = formatApprovalAuditContext([], []);
  assert.match(context, /No se registraron solicitudes/);
  assert.match(context, /ni confundas ausencia de solicitudes con aprobación global/i);
  const summary = buildApprovalAuditSummary([], []);
  assert.deepEqual(summary, {
    recordedDecisions: 0, recordedApprovalEvents: 0, pending: 0, responding: 0, approved: 0, rejected: 0,
    answered: 0, orphaned: 0, automaticApprovals: 0
  });
});

test("OpenCode allow-run grants are exact and isolated to the agent run that received approval", () => {
  const approvals = new Map();
  const buildRequest = {
    action: "shell",
    resources: ["git status --porcelain", "git log -1"],
    // Provider suggestions are broader than the concrete commands approved.
    save: ["git status *", "git log *"]
  };
  const rules = buildRunApprovalPatterns(buildRequest);
  assert.deepEqual(rules, [
    { action: "shell", resource: "git status --porcelain" },
    { action: "shell", resource: "git log -1" }
  ]);
  addAgentRunApprovals(approvals, "build-run-id", rules);

  assert.equal(matchesAgentRunApproval(approvals, "build-run-id", {
    action: "shell", resources: ["git status --porcelain"]
  }), true);
  assert.equal(matchesAgentRunApproval(approvals, "tester-run-id", {
    action: "shell", resources: ["git status --porcelain"]
  }), false);
  assert.equal(matchesAgentRunApproval(approvals, "build-run-id", {
    action: "shell", resources: ["git status --porcelain", "git log -1"]
  }), true);
  assert.equal(matchesAgentRunApproval(approvals, "build-run-id", {
    action: "shell", resources: ["git status --short"]
  }), false);
  assert.equal(matchesAgentRunApproval(approvals, "build-run-id", {
    action: "write", resources: ["git status --porcelain"]
  }), false);
  assert.equal(matchesAgentRunApproval(approvals, "build-run-id", {
    action: "shell", patterns: ["git status *"]
  }), false);
});

test("OpenCode wildcard save suggestion cannot turn a one-file edit into edit-star", () => {
  const approvals = new Map();
  const rules = buildRunApprovalPatterns({
    action: "edit",
    resources: ["src/demo/DiscountCalculator.java"],
    save: ["*"]
  });
  assert.deepEqual(rules, [
    { action: "edit", resource: "src/demo/DiscountCalculator.java" }
  ]);
  addAgentRunApprovals(approvals, "implementer-run-id", rules);

  assert.equal(matchesAgentRunApproval(approvals, "implementer-run-id", {
    action: "edit", resources: ["src/demo/DiscountCalculator.java"]
  }), true);
  assert.equal(matchesAgentRunApproval(approvals, "implementer-run-id", {
    action: "edit", resources: ["src/demo/Other.java"]
  }), false);
  assert.equal(matchesAgentRunApproval(approvals, "reviewer-run-id", {
    action: "edit", resources: ["src/demo/DiscountCalculator.java"]
  }), false);
});

test("Claude allow-run grants are isolated to the agent run that received approval", () => {
  const approvals = new Map<string, Set<string>>();
  const identicalOperation = "sha256:identical-tool-input";

  grantAgentRunApprovalKey(approvals, "architect-run-id", identicalOperation);
  grantAgentRunApprovalKey(approvals, "architect-run-id", identicalOperation);

  assert.equal(hasAgentRunApprovalKey(approvals, "architect-run-id", identicalOperation), true);
  assert.equal(hasAgentRunApprovalKey(approvals, "reviewer-run-id", identicalOperation), false);
  assert.equal(hasAgentRunApprovalKey(approvals, "tester-run-id", identicalOperation), false);
  assert.equal(approvals.get("architect-run-id")?.size, 1);
});

test("Claude allow-run grants fail closed when agent identity or operation key is missing", () => {
  const approvals = new Map<string, Set<string>>();

  grantAgentRunApprovalKey(approvals, "", "operation-key");
  grantAgentRunApprovalKey(approvals, "architect-run-id", "");
  assert.equal(hasAgentRunApprovalKey(approvals, "", "operation-key"), false);
  assert.equal(hasAgentRunApprovalKey(approvals, "architect-run-id", ""), false);
  assert.equal(approvals.size, 0);
});

test("simultaneous execution starts cannot acquire the admission reservation twice", async () => {
  const gate = createExecutionAdmissionGate();
  const reservations = await Promise.all([
    Promise.resolve().then(() => gate.tryAcquire()),
    Promise.resolve().then(() => gate.tryAcquire())
  ]);
  const acquired = reservations.filter((release): release is () => void => release !== null);

  assert.equal(acquired.length, 1);
  assert.equal(gate.isReserved(), true);
  assert.equal(gate.tryAcquire(), null);

  acquired[0]!();
  assert.equal(gate.isReserved(), false);

  const nextReservation = gate.tryAcquire();
  assert.equal(typeof nextReservation, "function");
  nextReservation!();
  nextReservation!();
  assert.equal(gate.isReserved(), false);
});

test("agent-run exact approvals merge without duplicates and missing resources fail closed", () => {
  const approvals = new Map();
  const first = buildRunApprovalPatterns({
    action: "shell",
    resources: ["grep -n TODO src/main.ts", "wc -l README.md"],
    save: ["grep *", "wc *"]
  });
  addAgentRunApprovals(approvals, "tester-run-id", first);
  addAgentRunApprovals(approvals, "tester-run-id", first);
  assert.equal(approvals.get("tester-run-id").length, 2);
  assert.deepEqual(buildRunApprovalPatterns({ action: "shell", save: ["grep *"], resources: [] }), []);
  assert.deepEqual(buildRunApprovalPatterns({ action: "shell", patterns: ["grep *"], save: ["*"] }), []);
  assert.deepEqual(buildRunApprovalPatterns({ action: "edit", resources: ["src/**/*.java"], save: ["*"] }), []);
});

test("Claude operation-scoped allow-run decisions remain visible in the approval audit", () => {
  const events = [{
    area: "HUMAN-REVIEW",
    message: "Autorización limitada a la misma operación durante esta ejecución: Autorizar herramienta: Bash.",
    createdAt: "2026-11-17T12:00:00.000Z",
    agentRunId: "architect-run-id"
  }];
  const summary = buildApprovalAuditSummary([], events);
  assert.equal(summary.recordedApprovalEvents, 1);
  assert.equal(summary.automaticApprovals, 0);
  const context = formatApprovalAuditContext([], events);
  const eventLine = context.split("\n").find((line) => line.startsWith("EVENTO_REVISIÓN_APROBACIÓN_JSON "));
  assert.ok(eventLine);
  const recorded = JSON.parse(eventLine!.slice("EVENTO_REVISIÓN_APROBACIÓN_JSON ".length));
  assert.match(recorded.message, /Autorización limitada a la misma operación durante esta ejecución/);
  assert.equal(recorded.agentRunId, "architect-run-id");
});

test("approval audit context retains more than three hundred approval events", () => {
  const events = Array.from({ length: 375 }, (_, index) => ({
    area: "TESTER",
    message: `Autorización temporal reutilizada durante esta ejecución por el mismo agente: shell · cmd-${index}.`,
    createdAt: new Date(Date.UTC(2026, 10, 17, 12, 0, index)).toISOString(),
    agentRunId: "tester-run"
  }));
  const summary = buildApprovalAuditSummary([], events);
  assert.equal(summary.recordedApprovalEvents, 375);
  assert.equal(summary.automaticApprovals, 375);
  const context = formatApprovalAuditContext([], events);
  assert.match(context, /cmd-0/);
  assert.match(context, /cmd-374/);
});

test("handoff identifiers are deterministic, unique by agent and tied to the run", () => {
  assert.equal(createHandoffId("cloud-arbiter", "12345678-aaaa"), "HANDOFF-CLOUD-ARBITER-12345678");
  assert.notEqual(createHandoffId("architect", "12345678-aaaa"), createHandoffId("reviewer", "12345678-aaaa"));
});

test("cross-engine overlap requires real overlapping timestamps", () => {
  assert.equal(hasConcurrentCrossEngineRun([
    { engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00.000Z", finishedAt: "2026-01-01T10:05:00.000Z" },
    { engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:02:00.000Z", finishedAt: "2026-01-01T10:06:00.000Z" }
  ]), true);
  assert.equal(hasConcurrentCrossEngineRun([
    { engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00.000Z", finishedAt: "2026-01-01T10:02:00.000Z" },
    { engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:02:00.000Z", finishedAt: "2026-01-01T10:06:00.000Z" }
  ]), false);
});

test("an explicitly mandatory seven-agent audit fails when Reverse is disabled", () => {
  const agents: SummaryAgent[] = ["architect", "build", "implementer", "reviewer", "tester", "cloud-arbiter"].map((agentId) => ({
    agentId, engine: (agentId === "architect" || agentId === "reviewer" || agentId === "cloud-arbiter" ? "claude" : "opencode") as "claude" | "opencode",
    status: "succeeded" as const, startedAt: null, finishedAt: null, handoffIn: []
  }));
  agents.push({ agentId: "reverse", engine: "opencode", status: "skipped", startedAt: null, finishedAt: null, handoffIn: [] });
  const summary = buildExecutionSummary({
    instructions: "Participación obligatoria de los siete agentes. Auditoría de colaboración entre motores.",
    agents,
    results: []
  });
  assert.equal(summary.verdict, "failed");
  assert.ok(summary.participants.skipped.includes("reverse"));
});

test("an independent single-engine task can complete without cross-engine handoffs", () => {
  const summary = buildExecutionSummary({
    instructions: "Analiza el README del proyecto y resume sus objetivos.",
    agents: [{ agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:01:00Z", handoffIn: [] }],
    results: []
  });
  assert.equal(summary.verdict, "completed");
});

test("the executive summary uses the Arbiter's dedicated report section", () => {
  const summary = buildExecutionSummary({
    instructions: "Compara Claude y OpenCode.",
    agents: [
      { agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:02:00Z", handoffIn: [] },
      { agentId: "build", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] }
    ],
    results: [],
    cloudArbiterOutput: "RESUMEN EJECUTIVO:\nAmbos motores colaboraron con evidencia directa.\n\nHALLAZGOS CLAVE:\n- Se verificó el cruce de contexto entre motores.\n\nPRÓXIMOS PASOS:\n- Ejecutar una segunda prueba."
  });
  assert.equal(summary.overview, "Ambos motores colaboraron con evidencia directa.");
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.nextSteps.length, 1);
});

test("handoff descriptors identify both agent runs and validate the exact content ID", () => {
  const descriptor = createHandoffDescriptor({
    agentRunId: "source-run", agentId: "architect", engine: "claude", modelId: "deepseek-v4.1-flash",
    sessionId: "claude-session", status: "succeeded", startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z", handoffId: "HANDOFF-ARCHITECT-12345678",
    output: "HANDOFF-ARCHITECT-12345678\nHallazgos"
  }, "implementer", "target-run", "opencode");
  assert.equal(descriptor.fromAgentRunId, "source-run");
  assert.equal(descriptor.toAgentRunId, "target-run");
  assert.equal(descriptor.contentIdVerified, true);
  assert.equal(descriptor.contentTruncated, false);
  assert.equal(descriptor.contentLength, "HANDOFF-ARCHITECT-12345678\nHallazgos".length);
  assert.match(descriptor.contentSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(descriptor.sourceIdentityVerified, true);
  assert.equal(descriptor.idAuthor, "agent");
  assert.equal(descriptor.contentByteLength, Buffer.byteLength("HANDOFF-ARCHITECT-12345678\nHallazgos", "utf8"));
  assert.equal(descriptor.contentIntegrityVerified, true);
  assert.equal(descriptor.toSessionId, null);
});

test("cross-engine collaboration requires verified handoffs in both directions", () => {
  const claudeToOpenCode = {
    id: "HANDOFF-ARCHITECT-12345678",
    fromAgent: "architect", fromAgentRunId: "agent-architect", fromEngine: "claude",
    fromModelId: "deepseek-v4.1-flash", fromSessionId: "session-claude",
    toAgent: "implementer", toAgentRunId: "agent-implementer", toEngine: "opencode",
    toSessionId: "session-opencode", contentIdVerified: true, contentIntegrityVerified: true,
    contentSha256: "a".repeat(64), contentLength: 150, sourceLength: 150, contentByteLength: 150, sourceByteLength: 150,
    contentTruncated: false, sourceIdentityVerified: true, idAuthor: "agent", deliveredAt: "2026-01-01T10:01:00Z"
  } as const;
  const openCodeToClaude = {
    id: "HANDOFF-IMPLEMENTER-12345678",
    fromAgent: "implementer", fromAgentRunId: "agent-implementer", fromEngine: "opencode",
    fromModelId: "opencode-go/glm-5.3-flash", fromSessionId: "session-opencode",
    toAgent: "reviewer", toAgentRunId: "agent-reviewer", toEngine: "claude",
    toSessionId: "session-reviewer", contentIdVerified: true, contentIntegrityVerified: true,
    contentSha256: "b".repeat(64), contentLength: 170, sourceLength: 170, contentByteLength: 170, sourceByteLength: 170,
    contentTruncated: false, sourceIdentityVerified: true, idAuthor: "agent", deliveredAt: "2026-01-01T10:04:00Z"
  } as const;
  const summary = buildExecutionSummary({
    instructions: "Prueba de colaboración entre motores Claude y OpenCode.",
    agents: [
      { agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] },
      { agentId: "build", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] },
      { agentId: "implementer", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:03:00Z", finishedAt: "2026-01-01T10:04:00Z", handoffIn: [claudeToOpenCode] },
      { agentId: "reviewer", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:03:00Z", finishedAt: "2026-01-01T10:05:00Z", handoffIn: [openCodeToClaude] }
    ],
    results: []
  });
  assert.equal(summary.collaboration.verifiedCrossEngineHandoffs, 2);
  assert.equal(summary.collaboration.directions.claudeToOpenCode, true);
  assert.equal(summary.collaboration.directions.openCodeToClaude, true);
  assert.equal(summary.collaboration.crossEngineVerified, true);
  assert.equal(summary.collaboration.concurrentCrossEngineVerified, true);
  assert.equal(summary.verdict, "completed");
});

test("a one-way or unauthenticated relay is not full cross-engine collaboration", () => {
  const oneWay = {
    id: "HANDOFF-ARCHITECT-12345678",
    fromAgent: "architect", fromAgentRunId: "agent-architect", fromEngine: "claude",
    fromModelId: "deepseek-v4.1-flash", fromSessionId: "session-claude",
    toAgent: "implementer", toAgentRunId: "agent-implementer", toEngine: "opencode",
    toSessionId: null, contentIdVerified: false, deliveredAt: "2026-01-01T10:01:00Z"
  } as const;
  const summary = buildExecutionSummary({
    instructions: "Prueba de colaboración entre motores Claude y OpenCode.",
    agents: [
      { agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] },
      { agentId: "implementer", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:04:00Z", handoffIn: [oneWay] }
    ],
    results: []
  });
  assert.equal(summary.collaboration.verifiedCrossEngineHandoffs, 0);
  assert.equal(summary.collaboration.directions.claudeToOpenCode, false);
  assert.equal(summary.collaboration.directions.openCodeToClaude, false);
  assert.equal(summary.collaboration.crossEngineVerified, false);
  assert.equal(summary.verdict, "observations");
});

test("complete reports above the former 12k limit reach the next agent unchanged", () => {
  const id = "HANDOFF-ARCHITECT-12345678";
  const longOutput = id + "\n\nRESUMEN EJECUTIVO\nResultado importante.\n" + "detalle técnico. ".repeat(1100);
  const prepared = prepareHandoffOutput(longOutput, id);
  assert.equal(prepared.content, longOutput);
  assert.ok(prepared.content.length > 12000);
  assert.equal(prepared.truncated, false);
  assert.equal(prepared.sourceIdentityVerified, true);
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
});

test("a missing source ID is wrapped without dropping the original report", () => {
  const id = "HANDOFF-TESTER-12345678";
  const source = "Informe del agente\nHallazgo importante.\n" + "detalle. ".repeat(20);
  const prepared = prepareHandoffOutput(source, id);
  assert.ok(prepared.content.startsWith(id));
  assert.ok(prepared.content.includes(source));
  assert.equal(prepared.sourceIdentityVerified, false);
  assert.equal(prepared.truncated, false);
  const descriptor = createHandoffDescriptor({
    agentRunId: "source-run", agentId: "tester", engine: "opencode", modelId: "opencode-go/glm-5.3-flash",
    sessionId: "session-opencode", status: "succeeded", startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z", handoffId: id,
    output: prepared.content, handoffOutput: prepared
  }, "reviewer", "target-run", "claude");
  assert.equal(descriptor.contentIdVerified, true);
  assert.equal(descriptor.sourceIdentityVerified, false);
  assert.equal(descriptor.idAuthor, "orchestrator");
  assert.equal(descriptor.contentIntegrityVerified, true);
  const summary = buildExecutionSummary({
    instructions: "Prueba de colaboración entre motores Claude y OpenCode.",
    agents: [
      { agentId: "tester", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] },
      { agentId: "reviewer", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:04:00Z", handoffIn: [descriptor] }
    ],
    results: []
  });
  assert.equal(summary.collaboration.verifiedCrossEngineHandoffs, 0);
  assert.equal(summary.collaboration.directions.openCodeToClaude, false);
  assert.equal(summary.collaboration.crossEngineVerified, false);
});

test("oversized reports are explicitly marked incomplete and cannot verify collaboration", () => {
  const id = "HANDOFF-ARCHITECT-12345678";
  const prepared = prepareHandoffOutput(id + "\n" + "dato. ".repeat(10000), id, 5000);
  assert.equal(prepared.truncated, true);
  assert.ok(prepared.content.includes("HANDOFF INCOMPLETO"));
  assert.ok(prepared.content.length <= 5000);
  const descriptor = createHandoffDescriptor({
    agentRunId: "source-run", agentId: "architect", engine: "claude", modelId: "deepseek-v4.1-flash",
    sessionId: "session-claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z",
    finishedAt: "2026-01-01T10:01:00Z", handoffId: id,
    output: prepared.content, handoffOutput: prepared
  }, "implementer", "target-run", "opencode");
  assert.equal(descriptor.contentIdVerified, true);
  assert.equal(descriptor.contentTruncated, true);
  const summary = buildExecutionSummary({
    instructions: "Prueba de colaboración entre motores Claude y OpenCode.",
    agents: [
      { agentId: "architect", engine: "claude", status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T10:03:00Z", handoffIn: [] },
      { agentId: "implementer", engine: "opencode", status: "succeeded", startedAt: "2026-01-01T10:01:00Z", finishedAt: "2026-01-01T10:04:00Z", handoffIn: [descriptor] }
    ],
    results: []
  });
  assert.equal(summary.collaboration.verifiedCrossEngineHandoffs, 0);
  assert.equal(summary.collaboration.crossEngineVerified, false);
});

test("handoff identity accepts a markdown heading but rejects IDs buried in the body", () => {
  const id = "HANDOFF-TESTER-12345678";
  assert.equal(hasHandoffIdAtStart("# " + id + "\nReport", id), true);
  assert.equal(hasHandoffIdAtStart("**" + id + "**\nReport", id), true);
  assert.equal(hasHandoffIdAtStart("Informe del agente\n" + id, id), false);
});

test("checking configuration of all agents does not require running all seven", () => {
  const summary = buildExecutionSummary({
    instructions: "Verifiquemos que todos los agentes tengan bien configurados los modelos solicitados.",
    agents: [
      { agentId: "build", engine: "opencode", status: "succeeded", startedAt: "2026-11-19T16:12:00Z", finishedAt: "2026-11-19T16:13:00Z", handoffIn: [] },
      { agentId: "tester", engine: "opencode", status: "succeeded", startedAt: "2026-11-19T16:13:00Z", finishedAt: "2026-11-19T16:14:00Z", handoffIn: [] },
      ...["architect", "cloud-arbiter", "implementer", "reverse", "reviewer"].map((agentId) => ({
        agentId, engine: "claude" as const, status: "skipped" as const, startedAt: null, finishedAt: null, handoffIn: []
      }))
    ],
    results: []
  });
  assert.equal(summary.verdict, "observations");
  assert.equal(summary.headline, "Ejecución completada con observaciones");
  assert.match(summary.overview, /no solicitó colaboración entre motores/);
  assert.equal(summary.collaboration.concurrentCrossEngineVerified, false);
});

test("explicit execution of all seven agents still fails if some are skipped", () => {
  const summary = buildExecutionSummary({
    instructions: "Quiero que todos los agentes participen en esta ronda.",
    agents: [
      { agentId: "build", engine: "opencode", status: "succeeded", startedAt: null, finishedAt: null, handoffIn: [] },
      { agentId: "reviewer", engine: "claude", status: "skipped", startedAt: null, finishedAt: null, handoffIn: [] }
    ],
    results: []
  });
  assert.equal(summary.verdict, "failed");
});


test("failed phases cannot create synthetic handoffs for a subsequent agent", () => {
  const reportId = "HANDOFF-BUILD-12345678";
  const report = prepareHandoffOutput(reportId + "\nReal report", reportId);
  const source = (agentId: string, status: "succeeded" | "failed" | "cancelled", handoffOutput?: typeof report) => ({
    agentRunId: agentId + "-run", agentId, engine: "opencode" as const,
    modelId: "opencode-go/glm-5.3-flash", sessionId: agentId + "-session", status,
    startedAt: "2026-11-19T16:00:00Z", finishedAt: "2026-11-19T16:01:00Z",
    handoffId: reportId, output: status === "succeeded" ? report.content : "FASE FALLIDA: permission rejected",
    handoffOutput
  });
  const realReport = source("build", "succeeded", report);
  const failedWithError = source("implementer", "failed");
  const failedWithOldPayload = source("tester", "failed", report);
  const cancelled = source("reviewer", "cancelled", report);
  const successfulWithoutReport = source("architect", "succeeded");
  assert.deepEqual(
    selectDeliverableHandoffSources([realReport, failedWithError, failedWithOldPayload, cancelled, successfulWithoutReport]),
    [realReport]
  );
});

test("a second-round diagnosis without Arbiter consolidates actual reports and never invents implementation", () => {
  const runId = "12345678-test";
  const result = (agentId: string, body: string) => {
    const handoffId = createHandoffId(agentId, runId);
    const handoffOutput = prepareHandoffOutput(handoffId + "\n\n" + body, handoffId);
    return { agentRunId: agentId + "-run", agentId, engine: "claude" as const, modelId: "test-model",
      sessionId: agentId + "-session", status: "succeeded" as const, startedAt: null, finishedAt: null,
      handoffId, output: handoffOutput.content, handoffOutput };
  };
  const architect = result("architect", "**3. Resumen del proyecto y mapa de módulos**\n\nProyecto Java.\n\n**5. Hallazgos con evidencia concreta**\n- El contrato actual acepta null.\n\n**7. Recomendaciones y contexto para los siguientes agentes**\n1. Normalizar los campos.");
  const reviewer = result("reviewer", "## 0. Qué revisé frente a la instrucción de esta ronda\n\nEl árbol no implementa la instrucción. No edité archivos.\n\n## 1. Hallazgos\n### H1 — Defecto: entrega null\n\n- Evidencia: AsistenciasService.java:2276.\n\n## 3. Verificaciones ejecutadas\n- BUILD SUCCESSFUL; las pruebas validan el contrato anterior.\n\n## 4. Recomendaciones para el siguiente paso\n1. Corregir el servicio y las pruebas.\n\nBLOQUEADO — DEFECTO DEMOSTRADO");
  const results = [architect, reviewer];
  const summary = buildExecutionSummary({ instructions: "Diagnóstico", agents: [
    ...results.map(r => ({ ...r, handoffIn: [] })),
    { agentId: "cloud-arbiter", engine: "claude", status: "skipped", startedAt: null, finishedAt: null, handoffIn: [] }
  ], results });
  assert.equal(summary.generatedBy, "orchestrator");
  assert.match(summary.overview, /Revisor.*informe de esta ronda/);
  assert.match(summary.overview, /no implementa la instrucción/);
  assert.match(summary.overview, /BUILD SUCCESSFUL/);
  assert.match(summary.overview, /BLOQUEADO/);
  assert.match(summary.overview, /Proyecto Java/);
  assert.ok(summary.findings.some(x => x.includes("entrega null")));
  assert.ok(summary.nextSteps.some(x => x.includes("Corregir el servicio")));
  assert.equal(summary.verdict, "observations");
});

test("a single explanation agent returns actual answer even without structured headings", () => {
  const handoffId = createHandoffId("architect", "12345678-test");
  const handoffOutput = prepareHandoffOutput(handoffId + "\nEl proyecto gestiona pólizas y asistencias.", handoffId);
  const result = { agentRunId: "a", agentId: "architect", engine: "claude" as const, modelId: "test",
    sessionId: "s", status: "succeeded" as const, startedAt: null, finishedAt: null,
    handoffId, output: handoffOutput.content, handoffOutput };
  const summary = buildExecutionSummary({ instructions: "Explica el proyecto", agents: [{ ...result, handoffIn: [] }], results: [result] });
  assert.match(summary.overview, /gestiona pólizas y asistencias/);
  assert.equal(summary.generatedBy, "orchestrator");
  const corrupted = buildExecutionSummary({ instructions: "Explica", agents: [{ ...result, handoffIn: [] }], results: [{ ...result, handoffOutput: { ...handoffOutput, sha256: "0".repeat(64) } }] });
  assert.doesNotMatch(corrupted.overview, /gestiona pólizas/);
  assert.match(corrupted.overview, /No se dispone de un informe/);
});

test("OpenCode canonical report with progress before explicit handoff separator retains real authorship", () => {
  const identity = { handoffId: "HANDOFF-IMPLEMENTER-EE31FA64", agentId: "implementer",
    runId: "ee31fa64-ba02-4b11-8a34-a5252c88155e", agentRunId: "07c89f9f-e7c8-4081-9ccc-17f775ec08b1" };
  const preamble = "\x60assertNull\x60 ya no existe en el test. Trabajo terminado y verificado.";
  const report = identity.handoffId + "\n\n- **Agente:** implementer · **Motor:** opencode · **Modelo:** glm\n- **Ejecución:** " + identity.runId + " · **Registro:** " + identity.agentRunId + " · Ronda 3\n\n## RESUMEN EJECUTIVO\nCambios comprobados.";
  const output = preamble + "\n\n---\n\n" + report;
  const selected = selectOpenCodeHandoffReport(output, identity);
  assert.equal(selected.report, report);
  assert.equal(selected.preamble, preamble);
  assert.equal(prepareHandoffOutput(selected.report, identity.handoffId).idAuthor, "agent");
  for (const invalid of [
    output.replace("\n---\n", "\n"),
    output.replace(identity.agentRunId, "wrong-record"),
    output.replace(identity.runId, "wrong-run"),
    output.replace("**Agente:** implementer", "**Agente:** tester"),
    output.replace("**Motor:** opencode", "**Motor:** claude"),
    output.replace(identity.handoffId, identity.handoffId + "-FAKE"),
    "HANDOFF-TESTER-OTHER\n" + output,
    ">\x20cita\n" + output,
    output + "\n---\n" + report,
    "x".repeat(1201) + output
  ]) {
    assert.equal(selectOpenCodeHandoffReport(invalid, identity).report, invalid);
    assert.equal(selectOpenCodeHandoffReport(invalid, identity).preamble, null);
  }
  assert.equal(hasHandoffIdAtStart(identity.handoffId + "-FAKE", identity.handoffId), false);
  assert.equal(selectOpenCodeHandoffReport(report, identity).preamble, null);
});
