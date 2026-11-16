import { createHash } from "node:crypto";

export type CoordinationEngine = "opencode" | "claude";
export type CoordinationAgentStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";

export interface HandoffOutputRecord {
  content: string;
  sha256: string;
  contentLength: number;
  sourceLength: number;
  truncated: boolean;
  sourceIdentityVerified: boolean;
}

export type HandoffOutputMetadata = Omit<HandoffOutputRecord, "content">;

export interface HandoffDescriptor {
  id: string;
  fromAgent: string;
  fromAgentRunId: string;
  fromEngine: CoordinationEngine;
  fromModelId: string;
  fromSessionId: string | null;
  toAgent: string;
  toAgentRunId: string;
  toEngine: CoordinationEngine;
  toSessionId: string | null;
  contentIdVerified: boolean;
  contentSha256?: string;
  contentLength?: number;
  sourceLength?: number;
  contentTruncated?: boolean;
  sourceIdentityVerified?: boolean;
  deliveredAt: string;
}

export interface AgentResult {
  agentRunId: string;
  agentId: string;
  engine: CoordinationEngine;
  modelId: string;
  sessionId: string | null;
  status: CoordinationAgentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  handoffId: string;
  output: string;
  handoffOutput?: HandoffOutputRecord;
}

export interface SummaryAgent {
  agentId: string;
  engine: CoordinationEngine;
  status: CoordinationAgentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  handoffIn: HandoffDescriptor[];
}

export interface ExecutionSummary {
  verdict: "completed" | "observations" | "failed";
  headline: string;
  overview: string;
  findings: string[];
  nextSteps: string[];
  participants: {
    total: number;
    succeeded: number;
    skipped: string[];
    failed: string[];
  };
  collaboration: {
    handoffs: number;
    crossEngineHandoffs: number;
    verifiedCrossEngineHandoffs: number;
    crossEngineVerified: boolean;
    directions: { claudeToOpenCode: boolean; openCodeToClaude: boolean };
    concurrencyMode: "parallel" | "mixed" | "sequential" | "not-applicable";
    concurrentCrossEngineVerified: boolean;
  };
  generatedBy: "cloud-arbiter" | "orchestrator";
  generatedAt: string;
}

const EXPECTED_AGENTS = ["architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter"];

export function hasHandoffIdAtStart(output: string, handoffId: string): boolean {
  const firstLine = output.trimStart().split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine.trim().replace(/^#{1,6}\s*/, "").replace(/^\*\*/, "").trimStart();
  return normalized.startsWith(handoffId);
}

export const MAX_HANDOFF_OUTPUT_CHARS = 48000;
const HANDOFF_TRUNCATION_MARKER =
  "\n\n...[FRAGMENTO INTERMEDIO OMITIDO: HANDOFF INCOMPLETO]...\n\n";

export function prepareHandoffOutput(
  output: string,
  handoffId: string,
  maxLength = MAX_HANDOFF_OUTPUT_CHARS
): HandoffOutputRecord {
  if (!Number.isInteger(maxLength) || maxLength < handoffId.length + HANDOFF_TRUNCATION_MARKER.length + 32) {
    throw new RangeError("El límite del handoff es demasiado pequeño para conservar su identidad y el marcador de integridad.");
  }
  const normalized = output.trimStart();
  const sourceIdentityVerified = hasHandoffIdAtStart(normalized, handoffId);
  const envelope = sourceIdentityVerified
    ? normalized
    : handoffId + "\n\n[Identificador añadido por el orquestador: la respuesta original no comenzó con el ID esperado.]\n\n" + normalized;
  let content = envelope;
  let truncated = false;
  if (envelope.length > maxLength) {
    truncated = true;
    const available = maxLength - HANDOFF_TRUNCATION_MARKER.length;
    const prefixLength = Math.ceil(available * 0.72);
    const suffixLength = available - prefixLength;
    content = envelope.slice(0, prefixLength) +
      HANDOFF_TRUNCATION_MARKER +
      (suffixLength > 0 ? envelope.slice(-suffixLength) : "");
  }
  return {
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    contentLength: content.length,
    sourceLength: envelope.length,
    truncated,
    sourceIdentityVerified
  };
}

/** Backwards-compatible helper with an explicit, reported safety limit. */
export function preserveHandoffIdentity(
  output: string,
  handoffId: string,
  maxLength = MAX_HANDOFF_OUTPUT_CHARS
): string {
  return prepareHandoffOutput(output, handoffId, maxLength).content;
}

export function createHandoffId(agentId: string, runId: string): string {
  const normalized = agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  return `HANDOFF-${normalized}-${runId.slice(0, 8).toUpperCase()}`;
}

export function createHandoffDescriptor(
  result: AgentResult,
  toAgent: string,
  toAgentRunId: string,
  toEngine: CoordinationEngine
): HandoffDescriptor {
  const payload = result.handoffOutput ?? prepareHandoffOutput(result.output, result.handoffId);
  const hashMatches = createHash("sha256").update(payload.content, "utf8").digest("hex") === payload.sha256;
  return {
    id: result.handoffId,
    fromAgent: result.agentId,
    fromAgentRunId: result.agentRunId,
    fromEngine: result.engine,
    fromModelId: result.modelId,
    fromSessionId: result.sessionId,
    toAgent,
    toAgentRunId,
    toEngine,
    toSessionId: null,
    contentIdVerified: hasHandoffIdAtStart(payload.content, result.handoffId) && hashMatches,
    contentSha256: payload.sha256,
    contentLength: payload.contentLength,
    sourceLength: payload.sourceLength,
    contentTruncated: payload.truncated,
    sourceIdentityVerified: payload.sourceIdentityVerified,
    deliveredAt: new Date().toISOString()
  };
}

export function hasConcurrentCrossEngineRun(agents: Array<Pick<SummaryAgent, "engine" | "startedAt" | "finishedAt" | "status">>): boolean {
  const completed = agents.filter((agent) => agent.startedAt && agent.finishedAt && agent.status === "succeeded");
  for (let i = 0; i < completed.length; i++) {
    const left = completed[i];
    if (!left?.startedAt || !left.finishedAt) continue;
    const leftStart = Date.parse(left.startedAt);
    const leftEnd = Date.parse(left.finishedAt);
    for (let j = i + 1; j < completed.length; j++) {
      const right = completed[j];
      if (!right?.startedAt || !right.finishedAt || right.engine === left.engine) continue;
      const rightStart = Date.parse(right.startedAt);
      const rightEnd = Date.parse(right.finishedAt);
      if ([leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite) && leftStart < rightEnd && rightStart < leftEnd) {
        return true;
      }
    }
  }
  return false;
}

function extractSection(source: string, heading: RegExp): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line.replace(/[*#_]/g, "").trim()));
  if (start < 0) return "";
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (
      /^\s{0,3}#{1,4}\s/.test(line) ||
      /^\s{0,3}\*\*[^*]{2,80}\*\*\s*$/.test(line) ||
      /^\s*(?:VEREDICTO|HALLAZGOS(?: CLAVE)?|COMUNICACIÓN ENTRE MOTORES|CONCURRENCIA|INCIDENCIAS|PRÓXIMOS PASOS|PROXIMOS PASOS|SIGUIENTE ACCIÓN)\s*:?[ \t]*$/i.test(line)
    ) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function extractBullets(section: string, limit = 6): string[] {
  return section.split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter((line) => line.length > 12)
    .slice(0, limit);
}

export function buildExecutionSummary(input: {
  instructions: string;
  agents: SummaryAgent[];
  cloudArbiterOutput?: string | null;
  results: AgentResult[];
  generatedAt?: string;
}): ExecutionSummary {
  const agents = input.agents;
  const succeeded = agents.filter((agent) => agent.status === "succeeded").length;
  const skipped = agents.filter((agent) => agent.status === "skipped").map((agent) => agent.agentId);
  const failed = agents.filter((agent) => agent.status === "failed").map((agent) => agent.agentId);
  const handoffs = agents.flatMap((agent) => agent.handoffIn ?? []);
  const crossEngineEdges = handoffs.filter((handoff) => handoff.fromEngine !== handoff.toEngine);
  const crossEngineHandoffs = crossEngineEdges.length;
  const hasCompleteVerifiedPayload = (handoff: HandoffDescriptor) =>
    handoff.contentIdVerified &&
    handoff.contentTruncated === false &&
    handoff.sourceIdentityVerified === true &&
    typeof handoff.contentSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(handoff.contentSha256) &&
    typeof handoff.contentLength === "number" &&
    handoff.contentLength > 0 &&
    Boolean(handoff.fromSessionId) &&
    Boolean(handoff.toSessionId);
  const verifiedCrossEngineHandoffs = crossEngineEdges.filter(hasCompleteVerifiedPayload).length;
  const claudeToOpenCode = crossEngineEdges.some((handoff) =>
    handoff.fromEngine === "claude" && handoff.toEngine === "opencode" &&
    hasCompleteVerifiedPayload(handoff)
  );
  const openCodeToClaude = crossEngineEdges.some((handoff) =>
    handoff.fromEngine === "opencode" && handoff.toEngine === "claude" &&
    hasCompleteVerifiedPayload(handoff)
  );
  const concurrentCrossEngineVerified = hasConcurrentCrossEngineRun(agents);
  const collaborationExpected = /colaboraci[oó]n|entre motores|ambos motores|multiagente|intercambio de contexto|compartir resultados/i.test(input.instructions);
  const requiresAllAgents = /(?:siete|7) agentes|participaci[oó]n obligatoria|todos los agentes/i.test(input.instructions);
  const missingExpected = EXPECTED_AGENTS.filter((agentId) => !agents.some((agent) => agent.agentId === agentId));
  const mandatoryUnavailable = requiresAllAgents && (skipped.length > 0 || missingExpected.length > 0);
  const collaborationVerified = claudeToOpenCode && openCodeToClaude;
  const anyOverlap = hasConcurrentCrossEngineRun(agents);
  const concurrencyMode: ExecutionSummary["collaboration"]["concurrencyMode"] =
    anyOverlap ? "mixed" :
      agents.filter((agent) => agent.status === "succeeded").length > 1 ? "sequential" : "not-applicable";
  const cloudOutput = input.cloudArbiterOutput ?? "";
  const executive = extractSection(cloudOutput, /^(?:RESUMEN EJECUTIVO|EXECUTIVE SUMMARY)\b/i);
  const findingsSection = extractSection(cloudOutput, /^(?:HALLAZGOS CLAVE|HALLAZGOS|KEY FINDINGS)\b/i);
  const nextStepsSection = extractSection(cloudOutput, /^(?:PRÓXIMOS PASOS|PROXIMOS PASOS|SIGUIENTE ACCIÓN|NEXT STEPS)\b/i);
  const findings = extractBullets(findingsSection);
  const nextSteps = extractBullets(nextStepsSection);
  const failedPipeline = failed.length > 0;
  const collaborationIncomplete = collaborationExpected && (!collaborationVerified || !concurrentCrossEngineVerified);
  const verdict: ExecutionSummary["verdict"] =
    failedPipeline || mandatoryUnavailable ? "failed" :
      skipped.length > 0 || collaborationIncomplete ? "observations" : "completed";
  const skippedText = skipped.length ? ` Agentes deshabilitados u omitidos: ${skipped.join(", ")}.` : "";
  const missingText = missingExpected.length ? ` No hay registro de: ${missingExpected.join(", ")}.` : "";
  const fallback = `Se completaron ${succeeded} de ${agents.length} agentes registrados. Se entregaron ${handoffs.length} handoffs, de los cuales ${verifiedCrossEngineHandoffs} cruces entre motores están verificados de extremo a extremo. ${concurrentCrossEngineVerified ? "Se verificó solapamiento temporal real entre Claude Code y OpenCode." : "No se verificó solapamiento temporal entre motores."}${skippedText}${missingText}`;
  const headline = verdict === "completed" ? "Ejecución completada" :
    verdict === "observations" ? "Ejecución completada con observaciones" : "Objetivo de integración no cumplido";
  return {
    verdict,
    headline,
    overview: executive || fallback,
    findings,
    nextSteps,
    participants: { total: agents.length, succeeded, skipped, failed },
    collaboration: {
      handoffs: handoffs.length,
      crossEngineHandoffs,
      verifiedCrossEngineHandoffs,
      crossEngineVerified: collaborationVerified,
      directions: { claudeToOpenCode, openCodeToClaude },
      concurrencyMode,
      concurrentCrossEngineVerified
    },
    generatedBy: executive ? "cloud-arbiter" : "orchestrator",
    generatedAt: input.generatedAt ?? new Date().toISOString()
  };
}
