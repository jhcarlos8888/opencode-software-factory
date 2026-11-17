import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionSummary, createHandoffDescriptor, createHandoffId, extractCanonicalOpenCodeAssistantText,
  extractClaudeFinalText, hasConcurrentCrossEngineRun, hasHandoffIdAtStart, prepareHandoffOutput,
  type SummaryAgent
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
    contentSha256: "a".repeat(64), contentLength: 150, contentByteLength: 150,
    contentTruncated: false, sourceIdentityVerified: true, idAuthor: "agent", deliveredAt: "2026-01-01T10:01:00Z"
  } as const;
  const openCodeToClaude = {
    id: "HANDOFF-IMPLEMENTER-12345678",
    fromAgent: "implementer", fromAgentRunId: "agent-implementer", fromEngine: "opencode",
    fromModelId: "opencode-go/glm-5.3-flash", fromSessionId: "session-opencode",
    toAgent: "reviewer", toAgentRunId: "agent-reviewer", toEngine: "claude",
    toSessionId: "session-reviewer", contentIdVerified: true, contentIntegrityVerified: true,
    contentSha256: "b".repeat(64), contentLength: 170, contentByteLength: 170,
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
