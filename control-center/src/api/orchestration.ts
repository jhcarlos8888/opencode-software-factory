import { createHash } from "node:crypto";

export type CoordinationEngine = "opencode" | "claude";
export type CoordinationAgentStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";

export type HandoffIdAuthor = "agent" | "orchestrator";

export interface HandoffOutputRecord {
  content: string;
  sha256: string;
  contentLength: number;
  sourceLength: number;
  contentByteLength?: number;
  sourceByteLength?: number;
  truncated: boolean;
  sourceIdentityVerified: boolean;
  idAuthor?: HandoffIdAuthor;
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
  contentByteLength?: number;
  sourceByteLength?: number;
  contentTruncated?: boolean;
  sourceIdentityVerified?: boolean;
  idAuthor?: HandoffIdAuthor;
  contentIntegrityVerified?: boolean;
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

export interface HandoffIntegritySummary {
  status: "verified" | "observations" | "not-assessed";
  expectedReports: number;
  reportsReceived: number;
  reportsVerified: number;
  missingReports: string[];
  truncatedReports: string[];
  invalidReports: string[];
  legacyReports: string[];
  orchestratorIdentifiedReports: string[];
}

export interface ApprovalAuditSummary {
  recordedDecisions: number;
  recordedApprovalEvents: number;
  pending: number;
  approved: number;
  rejected: number;
  answered: number;
  orphaned: number;
  automaticApprovals: number;
}

export interface ApprovalAuditDecision {
  id: string;
  agentId: string;
  engine: CoordinationEngine;
  kind: "permission" | "question";
  status: string;
  title: string;
  description: string;
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalAuditEvent {
  area: string;
  message: string;
  createdAt: string;
  agentRunId: string | null;
}

export interface ExecutionSummary {
  verdict: "completed" | "observations" | "failed";
  headline: string;
  overview: string;
  findings: string[];
  nextSteps: string[];
  integrity: HandoffIntegritySummary;
  approvals: ApprovalAuditSummary;
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

function isAutomaticApprovalEvent(event: ApprovalAuditEvent): boolean {
  return /autorización temporal aplicada automáticamente durante esta ejecución|autorización temporal reutilizada para la misma operación|autorización temporal reutilizada durante esta ejecución por el mismo agente/i
    .test(event.message);
}

function isApprovalAuditEvent(event: ApprovalAuditEvent): boolean {
  return isAutomaticApprovalEvent(event) ||
    /autorización limitada a esta ejecución|autorización limitada a la misma operación|solicitud atendida:|solicitud pendiente:|solicitud rechazada|rechazó las demás solicitudes/i
      .test(event.message);
}

export function buildApprovalAuditSummary(
  decisions: ApprovalAuditDecision[] = [],
  events: ApprovalAuditEvent[] = []
): ApprovalAuditSummary {
  const automaticApprovals = events.filter(isAutomaticApprovalEvent).length;
  const recordedApprovalEvents = events.filter(isApprovalAuditEvent).length;
  return {
    recordedDecisions: decisions.length,
    recordedApprovalEvents,
    pending: decisions.filter((decision) => decision.status === "pending").length,
    approved: decisions.filter((decision) => decision.status === "approved").length,
    rejected: decisions.filter((decision) => decision.status === "rejected").length,
    answered: decisions.filter((decision) => decision.status === "answered").length,
    orphaned: decisions.filter((decision) => decision.status === "orphaned").length,
    automaticApprovals
  };
}

export function formatApprovalAuditContext(
  decisions: ApprovalAuditDecision[] = [],
  events: ApprovalAuditEvent[] = []
): string {
  const approvalEvents = events.filter(isApprovalAuditEvent);
  const automaticEvents = approvalEvents.filter(isAutomaticApprovalEvent);
  const counts = buildApprovalAuditSummary(decisions, events);
  const lines = [
    "REGISTRO DE DECISIONES HUMANAS Y AUTORIZACIONES TEMPORALES — DATOS PERSISTIDOS DE ESTA EJECUCIÓN",
    "Solicitudes registradas: " + counts.recordedDecisions +
      " | aprobadas: " + counts.approved +
      " | rechazadas: " + counts.rejected +
      " | aclaraciones respondidas: " + counts.answered +
      " | pendientes: " + counts.pending +
      " | huérfanas: " + counts.orphaned +
      " | autorizaciones temporales aplicadas automáticamente: " + counts.automaticApprovals
  ];

  if (!decisions.length && !approvalEvents.length) {
    lines.push("No se registraron solicitudes de decisión ni reutilizaciones automáticas de autorizaciones en el ledger de esta ronda.");
    lines.push("No infieras aprobaciones de rondas anteriores ni confundas ausencia de solicitudes con aprobación global.");
    return lines.join("\n");
  }

  for (const decision of decisions) {
    lines.push([
      "DECISIÓN " + decision.id,
      "agente=" + decision.agentId,
      "motor=" + decision.engine,
      "tipo=" + decision.kind,
      "estado=" + decision.status,
      "creada=" + decision.createdAt,
      "resuelta=" + (decision.resolvedAt ?? "pendiente"),
      "título=" + decision.title.slice(0, 300),
      "alcance/solicitud=" + decision.description.slice(0, 600),
      "respuesta registrada=" + (decision.response ?? "sin respuesta").slice(0, 500)
    ].join(" | "));
  }
  for (const event of approvalEvents) {
    lines.push([
      isAutomaticApprovalEvent(event) ? "AUTORIZACIÓN TEMPORAL AUTOMÁTICA" : "EVENTO DE REVISIÓN / APROBACIÓN",
      "área=" + event.area,
      "agenteRun=" + (event.agentRunId ?? "no disponible"),
      "fecha=" + event.createdAt,
      event.message.slice(0, 600)
    ].join(" | "));
  }
  lines.push("Fuente de verdad: decisionHistory y eventos persistidos de la ejecución actual; no mezclar con otras rondas.");
  lines.push("Contrasta el resumen con cada DECISIÓN y AUTORIZACIÓN TEMPORAL AUTOMÁTICA enumerada. No afirmes que no hubo aprobaciones si estos registros contienen decisiones aprobadas.");
  lines.push("Distinción obligatoria: decisión humana explícita, autorización temporal reutilizada y ausencia de solicitudes son situaciones diferentes. Una autorización limitada a esta ejecución no es un permiso global ni persistente.");
  return lines.join("\n");
}

const EXPECTED_AGENTS = ["architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter"];

export function hasHandoffIdAtStart(output: string, handoffId: string): boolean {
  const firstLine = output.trimStart().split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine.trim().replace(/^#{1,6}\s*/, "").replace(/^\*\*/, "").trimStart();
  return normalized.startsWith(handoffId);
}

export function extractCanonicalOpenCodeAssistantText(payload: unknown): string | null {
  const messages = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const finalMessages: string[] = [];

  for (const candidate of messages) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    const info = message.info && typeof message.info === "object"
      ? message.info as Record<string, unknown>
      : {};
    const role = String(info.role ?? message.role ?? message.type ?? "");
    const finish = String(info.finish ?? message.finish ?? "");
    if (role !== "assistant" || finish !== "stop" || info.error || message.error) continue;

    const parts = Array.isArray(message.parts)
      ? message.parts as Array<Record<string, unknown>>
      : Array.isArray(message.content)
        ? message.content as Array<Record<string, unknown>>
        : [];
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim();
    if (text) finalMessages.push(text);
  }

  return finalMessages.at(-1) ?? null;
}

/** Claude SDK's result event is the canonical final text for a completed turn.
 * Assistant events are streamed content blocks and must only be used for activity logs. */
export function extractClaudeFinalText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const result = message as Record<string, unknown>;
  if (result.type !== "result" || result.subtype !== "success" || result.is_error === true) return null;
  return typeof result.result === "string" && result.result.trim()
    ? result.result.trim()
    : null;
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
    contentByteLength: Buffer.byteLength(content, "utf8"),
    sourceByteLength: Buffer.byteLength(envelope, "utf8"),
    truncated,
    sourceIdentityVerified,
    idAuthor: sourceIdentityVerified ? "agent" : "orchestrator"
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
  const characterLengthMatches = payload.contentLength === payload.content.length;
  const actualContentByteLength = Buffer.byteLength(payload.content, "utf8");
  const byteLengthMatches = typeof payload.contentByteLength === "number" &&
    payload.contentByteLength === actualContentByteLength;
  const sourceCharacterLengthMatches = payload.truncated
    ? payload.sourceLength > payload.contentLength
    : payload.sourceLength === payload.contentLength;
  const sourceByteLengthMatches = typeof payload.sourceByteLength === "number" &&
    payload.sourceByteLength >= payload.sourceLength &&
    (payload.truncated || payload.sourceByteLength === actualContentByteLength);
  const metadataComplete = byteLengthMatches && sourceByteLengthMatches &&
    (payload.idAuthor === "agent" || payload.idAuthor === "orchestrator");
  const contentIntegrityVerified = hashMatches && characterLengthMatches &&
    sourceCharacterLengthMatches && metadataComplete;
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
    contentIdVerified: hasHandoffIdAtStart(payload.content, result.handoffId) && contentIntegrityVerified,
    contentSha256: payload.sha256,
    contentLength: payload.contentLength,
    sourceLength: payload.sourceLength,
    contentByteLength: payload.contentByteLength,
    sourceByteLength: payload.sourceByteLength,
    contentTruncated: payload.truncated,
    sourceIdentityVerified: payload.sourceIdentityVerified,
    idAuthor: payload.idAuthor,
    contentIntegrityVerified,
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

function normalizeHeadingLine(line: string): string {
  return line.replace(/[*#_]/g, "").trim().replace(/:$/, "").trim();
}

function markdownHeading(line: string): { level: number; title: string } | null {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? { level: match[1]!.length, title: normalizeHeadingLine(match[2]!) } : null;
}

function extractSection(source: string, heading: RegExp): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(normalizeHeadingLine(line)));
  if (start < 0) return "";
  const startLevel = markdownHeading(lines[start] ?? "")?.level ?? 2;
  const collected: string[] = [];
  const plainSectionBoundary = /^\s*(?:VEREDICTO|RESUMEN EJECUTIVO|EXECUTIVE SUMMARY|HALLAZGOS(?: CLAVE)?|KEY FINDINGS|COMUNICACIÓN ENTRE MOTORES|CONCURRENCIA|INCIDENCIAS|PRÓXIMOS PASOS|PROXIMOS PASOS|SIGUIENTE ACCIÓN|NEXT STEPS|PRUEBAS QUE TODAVÍA FALTAN|PRUEBAS PENDIENTES)\s*:?[ \t]*$/i;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const nextHeading = markdownHeading(line);
    if (nextHeading && nextHeading.level <= startLevel) break;
    if (!nextHeading && plainSectionBoundary.test(normalizeHeadingLine(line))) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\\\|/g, "|")
    .replace(/\*\*/g, "")
    .replace(/__(.*?)__/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map(stripInlineMarkdown);
}

function extractFindings(section: string, limit = 8): string[] {
  const tableFindings: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const cells = markdownTableCells(line);
    if (!cells || cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (/^(?:#|n[úu]mero)$/i.test(cells[0] ?? "") || /hallazgo/i.test(cells[1] ?? "")) continue;
    const id = cells[0] ?? "";
    const title = cells[1] ?? "";
    if (!title || title.length < 8) continue;
    const evidence = cells[2] ?? "";
    const severity = cells.length >= 5 ? cells[4] ?? "" : "";
    const summary = [
      (id ? id + " — " : "") + title,
      severity ? "Severidad: " + severity : "",
      evidence ? "Evidencia: " + evidence.slice(0, 220) : ""
    ].filter(Boolean).join(" · ");
    tableFindings.push(summary);
  }
  if (tableFindings.length) return [...new Set(tableFindings)].slice(0, limit);

  const bulletFindings = section.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map(stripInlineMarkdown)
    .filter((line) => line.length > 12);
  return [...new Set(bulletFindings)].slice(0, limit);
}

function extractNextSteps(section: string, limit = 8): string[] {
  const items: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 12) items.push(stripInlineMarkdown(current));
    current = "";
  };

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) flush();
      continue;
    }
    if (/^\*\*P\d+\s*[—-]/i.test(line)) {
      flush();
      current = line;
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      flush();
      items.push(stripInlineMarkdown(line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "")));
      continue;
    }
    if (current) current += " " + line;
  }
  flush();
  if (!items.length) {
    return section.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\*\*P\d+\s*[—-]/i.test(line))
      .map(stripInlineMarkdown)
      .filter((line) => line.length > 12)
      .slice(0, limit);
  }
  return [...new Set(items)].slice(0, limit);
}

function assessHandoffIntegrity(
  agents: SummaryAgent[],
  results: AgentResult[]
): HandoffIntegritySummary {
  const successfulAgents = agents.filter((agent) => agent.status === "succeeded");
  const summary: HandoffIntegritySummary = {
    status: results.length ? "verified" : "not-assessed",
    expectedReports: successfulAgents.length,
    reportsReceived: 0,
    reportsVerified: 0,
    missingReports: [],
    truncatedReports: [],
    invalidReports: [],
    legacyReports: [],
    orchestratorIdentifiedReports: []
  };
  if (!results.length) return summary;

  const resultsByAgent = new Map(results.map((result) => [result.agentId, result]));
  for (const agent of successfulAgents) {
    const result = resultsByAgent.get(agent.agentId);
    const report = result?.handoffOutput;
    if (!result || result.status !== "succeeded" || !report) {
      summary.missingReports.push(agent.agentId);
      continue;
    }
    summary.reportsReceived++;

    const hashMatches = createHash("sha256").update(report.content, "utf8").digest("hex") === report.sha256;
    const characterLengthMatches = report.contentLength === report.content.length;
    const actualContentByteLength = Buffer.byteLength(report.content, "utf8");
    const byteLengthAvailable = typeof report.contentByteLength === "number";
    const byteLengthMatches = !byteLengthAvailable || report.contentByteLength === actualContentByteLength;
    const sourceCharacterLengthMatches = report.truncated
      ? report.sourceLength > report.contentLength
      : report.sourceLength === report.contentLength;
    const sourceByteLengthMatches = typeof report.sourceByteLength !== "number" ||
      (report.sourceByteLength >= report.sourceLength &&
        (report.truncated || report.sourceByteLength === actualContentByteLength));
    const sourceByteLengthAvailable = typeof report.sourceByteLength === "number";
    const idAuthorAvailable = report.idAuthor === "agent" || report.idAuthor === "orchestrator";
    const metadataIsLegacy = !byteLengthAvailable || !sourceByteLengthAvailable || !idAuthorAvailable;
    const idMatches = hasHandoffIdAtStart(report.content, result.handoffId);
    const contentValid = hashMatches && characterLengthMatches && byteLengthMatches &&
      sourceCharacterLengthMatches && sourceByteLengthMatches && idMatches;

    if (report.truncated) summary.truncatedReports.push(agent.agentId);
    if (!contentValid) summary.invalidReports.push(agent.agentId);
    if (metadataIsLegacy) summary.legacyReports.push(agent.agentId);
    if (report.sourceIdentityVerified === false || report.idAuthor === "orchestrator") {
      summary.orchestratorIdentifiedReports.push(agent.agentId);
    }
    if (contentValid && !report.truncated && !metadataIsLegacy) summary.reportsVerified++;
  }

  const hasIntegrityObservations =
    summary.missingReports.length > 0 ||
    summary.truncatedReports.length > 0 ||
    summary.invalidReports.length > 0 ||
    summary.legacyReports.length > 0 ||
    summary.orchestratorIdentifiedReports.length > 0;
  summary.status = hasIntegrityObservations ? "observations" : "verified";
  return summary;
}

export function buildExecutionSummary(input: {
  instructions: string;
  agents: SummaryAgent[];
  cloudArbiterOutput?: string | null;
  results: AgentResult[];
  decisions?: ApprovalAuditDecision[];
  approvalEvents?: ApprovalAuditEvent[];
  generatedAt?: string;
}): ExecutionSummary {
  const agents = input.agents;
  const integrity = assessHandoffIntegrity(agents, input.results);
  const approvals = buildApprovalAuditSummary(input.decisions, input.approvalEvents);
  const succeeded = agents.filter((agent) => agent.status === "succeeded").length;
  const skipped = agents.filter((agent) => agent.status === "skipped").map((agent) => agent.agentId);
  const failed = agents.filter((agent) => agent.status === "failed").map((agent) => agent.agentId);
  const handoffs = agents.flatMap((agent) => agent.handoffIn ?? []);
  const crossEngineEdges = handoffs.filter((handoff) => handoff.fromEngine !== handoff.toEngine);
  const crossEngineHandoffs = crossEngineEdges.length;
  const hasCompleteVerifiedPayload = (handoff: HandoffDescriptor) =>
    handoff.contentIdVerified &&
    handoff.contentIntegrityVerified === true &&
    handoff.contentTruncated === false &&
    handoff.sourceIdentityVerified === true &&
    typeof handoff.contentSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(handoff.contentSha256) &&
    typeof handoff.contentLength === "number" &&
    handoff.contentLength > 0 &&
    typeof handoff.contentByteLength === "number" &&
    handoff.contentByteLength > 0 &&
    typeof handoff.sourceByteLength === "number" &&
    handoff.sourceLength === handoff.contentLength &&
    handoff.sourceByteLength === handoff.contentByteLength &&
    (handoff.idAuthor === "agent" || handoff.idAuthor === "orchestrator") &&
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
  const findings = extractFindings(findingsSection);
  const nextSteps = extractNextSteps(nextStepsSection);
  const failedPipeline = failed.length > 0;
  const collaborationIncomplete = collaborationExpected && (!collaborationVerified || !concurrentCrossEngineVerified);
  const approvalAuditIncomplete = approvals.pending > 0 || approvals.orphaned > 0;
  const verdict: ExecutionSummary["verdict"] =
    failedPipeline || mandatoryUnavailable ? "failed" :
      skipped.length > 0 || collaborationIncomplete || integrity.status === "observations" || approvalAuditIncomplete ? "observations" : "completed";
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
    integrity,
    approvals,
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
