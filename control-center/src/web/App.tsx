import { useEffect, useMemo, useState } from "react";

type EngineId = "opencode" | "claude";
type ClaudeProviderId = "apmix" | "anthropic" | "opencode-go";
type ModelTier = "economy" | "balanced" | "premium";
interface FavoriteModel { engine: EngineId; provider: string; modelId: string; tier: ModelTier; }
type PermissionProfile = "read-only" | "workspace-write" | "approval-required";

interface EngineStatus {
  id: EngineId;
  name: string;
  available: boolean;
  version: string | null;
}

interface Agent {
  id: string;
  description: string;
  mode: string;
  defaultModel: string;
}

interface ModelOption {
  id: string;
  label: string;
  source: "detected" | "alias";
}

interface ClaudeProviderStatus {
  selectedProvider: ClaudeProviderId;
  configured: boolean;
  endpointCompatible: boolean;
  baseUrl: string;
  model: string;
  credentialDetected: boolean;
}

interface McpServerInfo {
  name: string;
  transport: "Local" | "Remoto";
  enabled: boolean;
}

interface Assignment {
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: PermissionProfile;
  enabled: boolean;
}

interface TaskPlan {
  kind: "explanation" | "diagnosis" | "implementation" | "testing" | "architecture-review" | "general";
  complexity: "low" | "medium" | "high";
  depth: "quick" | "focused" | "deep";
  recommendedAgents: string[];
  reasons: string[];
  changesExpected: boolean;
}

interface ProjectAnalysis {
  name: string;
  path: string;
  stacks: string[];
  manifests: string[];
  instructions: string[];
  git: { isRepository: boolean; status: string[] };
  recommendations: string[];
  mode: "read-only";
  objective: string;
  complexity: { level: "low" | "medium" | "high" | "very-high"; score: number; reasons: string[]; fileCount: number; };
  taskPlan: TaskPlan;
  suggestedAssignments: Assignment[];
  recommendationReady: boolean;
  recommendationMessage: string;
}

type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
interface HandoffDescriptor {
  id: string; fromAgent: string; fromAgentRunId: string; fromEngine: EngineId;
  fromModelId: string; fromSessionId: string | null;
  toAgent: string; toAgentRunId: string; toEngine: EngineId; toSessionId: string | null;
  contentIdVerified: boolean; deliveredAt: string;
  contentSha256?: string; contentLength?: number; sourceLength?: number;
  contentByteLength?: number; sourceByteLength?: number;
  contentTruncated?: boolean; sourceIdentityVerified?: boolean;
  idAuthor?: "agent" | "orchestrator"; contentIntegrityVerified?: boolean;
}
interface HandoffOutputMetadata {
  sha256: string; contentLength: number; sourceLength: number;
  contentByteLength?: number; sourceByteLength?: number; idAuthor?: "agent" | "orchestrator";
  truncated: boolean; sourceIdentityVerified: boolean;
}
interface HandoffOutputRecord extends HandoffOutputMetadata {
  content: string;
}
interface ExecutionSummary {
  verdict: "completed" | "observations" | "failed";
  headline: string; overview: string; findings: string[]; nextSteps: string[];
  integrity?: {
    status: "verified" | "observations" | "not-assessed";
    expectedReports: number; reportsReceived: number; reportsVerified: number;
    missingReports: string[]; truncatedReports: string[]; invalidReports: string[];
    legacyReports: string[]; orchestratorIdentifiedReports: string[];
  };
  participants: { total: number; succeeded: number; skipped: string[]; failed: string[] };
  collaboration: {
    handoffs: number; crossEngineHandoffs: number; verifiedCrossEngineHandoffs: number;
    crossEngineVerified: boolean; directions: { claudeToOpenCode: boolean; openCodeToClaude: boolean };
    concurrencyMode: "parallel" | "mixed" | "sequential" | "not-applicable";
    concurrentCrossEngineVerified: boolean;
  };
  generatedBy: "cloud-arbiter" | "orchestrator"; generatedAt: string;
}
interface ExecutionConfigurationSnapshot {
  capturedAt: string;
  claudeProvider: ClaudeProviderId;
  favorites: FavoriteModel[];
  assignments: Assignment[];
  roleInstructionDigests: Record<string, string>;
  roleInstructions: Record<string, string>;
  workflowSkillDigest: string | null;
  workflowSkillContent: string;
}
interface WorkMessage {
  id: string; threadId: string; runId: string | null; roundNumber: number;
  role: "user" | "assistant" | "system"; kind: string; content: string; createdAt: string;
}
interface ExecutionData {
  run: {
    id: string; threadId: string | null; roundNumber: number;
    configurationSnapshot: ExecutionConfigurationSnapshot | null; continuityContext: string;
    projectPath: string; instructions: string; status: RunStatus; startedAt: string;
    updatedAt: string; finishedAt: string | null; summary: ExecutionSummary | null
  };
  agents: Array<{
    id: string; agentId: string; engine: EngineId; modelId: string; permissionProfile: PermissionProfile;
    status: RunStatus | "skipped"; sessionId: string | null; error: string | null;
    startedAt: string | null; finishedAt: string | null;
    handoffIn: HandoffDescriptor[]; handoffOut: HandoffDescriptor[];
    handoffOutput: HandoffOutputMetadata | null;
  }>;
  events: Array<{ id: number; createdAt: string; area: string; kind: string; message: string; agentRunId: string | null }>;
  decisions: Array<{ id: string; agentRunId: string; engine: EngineId; engineSessionId: string | null; engineRequestId: string | null; kind: "permission" | "question"; title: string; description: string; details: unknown; status: string; createdAt: string }>;
  decisionHistory: Array<{
    id: string; agentRunId: string; engine: EngineId; engineSessionId: string | null;
    engineRequestId: string | null; kind: "permission" | "question"; title: string;
    description: string; details: unknown; status: string; response: string | null;
    createdAt: string; resolvedAt: string | null
  }>;
}
interface WorkThreadSnapshot {
  thread: { id: string; projectPath: string; objective: string; status: "active" | "completed" | "failed"; createdAt: string; updatedAt: string };
  messages: WorkMessage[];
  rounds: ExecutionData[];
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Do not label a body-less GET/POST as JSON: Fastify rejects an empty
  // application/json payload before the route handler can run.
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Error HTTP ${response.status}`);
  }
  return payload;
}

const roleNames: Record<string, string> = {
  build: "Build / Construcción",
  architect: "Arquitecto",
  implementer: "Implementador",
  reviewer: "Revisor",
  tester: "QA / Tester",
  "cloud-arbiter": "Árbitro técnico",
  reverse: "Ingeniería inversa"
};

function canApproveDuringRun(decision: ExecutionData["decisions"][number]): boolean {
  if (decision.kind !== "permission" || !decision.details || typeof decision.details !== "object") return false;
  const details = decision.details as Record<string, unknown>;
  if (decision.engine === "claude") return typeof details.approvalKey === "string" && details.approvalKey.length > 0;
  const action = details.action ?? details.permission;
  const proposed = Array.isArray(details.save) && details.save.length > 0
    ? details.save
    : Array.isArray(details.resources) ? details.resources
      : Array.isArray(details.patterns) ? details.patterns : [];
  return typeof action === "string" && action.length > 0 && proposed.some((item) => typeof item === "string" && item.length > 0);
}

const permissionNames: Record<PermissionProfile, string> = {
  "read-only": "Solo lectura",
  "workspace-write": "Escritura en workspace",
  "approval-required": "Requiere aprobación"
};

export default function App() {
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpConfigFound, setMcpConfigFound] = useState(false);
  const [models, setModels] = useState<Record<EngineId, ModelOption[]>>({
    opencode: [],
    claude: []
  });
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [projectPath, setProjectPath] = useState("");
  const [folderPicking, setFolderPicking] = useState(false);
  const [projectInstructions, setProjectInstructions] = useState("");
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [favoriteEngine, setFavoriteEngine] = useState<EngineId>("opencode");
  const [favoriteModelId, setFavoriteModelId] = useState("");
  const [favoriteTier, setFavoriteTier] = useState<ModelTier>("balanced");
  const [favoritesSaving, setFavoritesSaving] = useState(false);
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [pendingAssignments, setPendingAssignments] = useState<Assignment[] | null>(null);
  const [recommendationStatus, setRecommendationStatus] = useState<"pending" | "accepted" | "manual" | null>(null);
  const [activityLogs, setActivityLogs] = useState<Array<{ time: string; area: string; message: string; kind: "info" | "success" | "warning" }>>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [apiReady, setApiReady] = useState(false);
  const [claudeProvider, setClaudeProvider] = useState<ClaudeProviderId>("apmix");
  const [claudeProviderStatus, setClaudeProviderStatus] = useState<ClaudeProviderStatus | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [teamSaved, setTeamSaved] = useState(false);
  const [execution, setExecution] = useState<ExecutionData | null>(null);
  const [workThread, setWorkThread] = useState<WorkThreadSnapshot | null>(null);
  const [handoffOutputContents, setHandoffOutputContents] = useState<Record<string, HandoffOutputRecord>>({});
  const [handoffOutputLoading, setHandoffOutputLoading] = useState<Record<string, boolean>>({});
  const [handoffOutputErrors, setHandoffOutputErrors] = useState<Record<string, string>>({});
  const [continuationText, setContinuationText] = useState("");
  const [continuationBusy, setContinuationBusy] = useState(false);
  const [executionStarting, setExecutionStarting] = useState(false);
  const [executionCancelling, setExecutionCancelling] = useState(false);
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({});
  const [decisionBusyId, setDecisionBusyId] = useState<string | null>(null);

  const availableEngines = useMemo(
    () => new Set(engines.filter((engine) => engine.available).map((engine) => engine.id)),
    [engines]
  );

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!execution || !["queued", "running", "waiting"].includes(execution.run.status)) return;
    const runId = execution.run.id;
    const threadId = execution.run.threadId;
    const timer = window.setInterval(() => {
      void api<{ execution: ExecutionData }>(`/api/executions/${runId}`)
        .then((result) => setExecution(result.execution))
        .catch(() => undefined);
      if (threadId) {
        void api<{ workflow: WorkThreadSnapshot }>(`/api/work-threads/${threadId}`)
          .then((result) => setWorkThread(result.workflow))
          .catch(() => undefined);
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [execution?.run.id, execution?.run.status, execution?.run.threadId]);

  async function loadHandoffOutput(runId: string, agentRunId: string) {
    const key = runId + ":" + agentRunId;
    if (handoffOutputContents[key] || handoffOutputLoading[key]) return;
    setHandoffOutputLoading((current) => ({ ...current, [key]: true }));
    setHandoffOutputErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const result = await api<{ handoffOutput: HandoffOutputRecord }>(
        `/api/executions/${runId}/agents/${agentRunId}/handoff-output`
      );
      setHandoffOutputContents((current) => ({ ...current, [key]: result.handoffOutput }));
    } catch (cause) {
      setHandoffOutputErrors((current) => ({
        ...current,
        [key]: cause instanceof Error ? cause.message : String(cause)
      }));
    } finally {
      setHandoffOutputLoading((current) => ({ ...current, [key]: false }));
    }
  }

  async function loadInitialData() {
    setBusy(true);
    setError("");
    try {
      // Synchronize the current local APMix model before loading saved assignments
      // so model changes in ~/.claude/settings.json are reflected automatically.
      await api<{ synchronized: boolean }>("/api/providers/claude/synchronize-model", { method: "POST" });
      const [engineResponse, mcpResponse, assetResponse, assignmentResponse, openCodeModels, claudeModels, providerResponse, favoriteResponse, projectPreferences, latestExecution] = await Promise.all([
        api<{ engines: EngineStatus[] }>("/api/engines"),
        api<{ configFound: boolean; servers: McpServerInfo[] }>("/api/mcps"),
        api<{ agents: Agent[]; skills: string[] }>("/api/factory/assets"),
        api<{ assignments: Assignment[]; saved: boolean }>("/api/assignments"),
        api<{ models: ModelOption[] }>("/api/models/opencode"),
        api<{ models: ModelOption[] }>("/api/models/claude"),
        api<ClaudeProviderStatus>("/api/providers/claude"),
        api<{ favorites: FavoriteModel[] }>("/api/favorites"),
        api<{ path: string; instructions: string }>("/api/project-preferences"),
        api<{ execution: ExecutionData | null }>("/api/executions/latest")
      ]);

      setEngines(engineResponse.engines);
      setMcpServers(mcpResponse.servers);
      setMcpConfigFound(mcpResponse.configFound);
      setAgents(assetResponse.agents);
      setSkills(assetResponse.skills);
      setModels({ opencode: openCodeModels.models, claude: claudeModels.models });
      setClaudeProvider(providerResponse.selectedProvider);
      setClaudeProviderStatus(providerResponse);
      setFavorites(favoriteResponse.favorites);
      setProjectPath(projectPreferences.path);
      setProjectInstructions(projectPreferences.instructions);
      setFavoriteModelId(openCodeModels.models[0]?.id ?? "");
      setAssignments(Object.fromEntries(assignmentResponse.assignments.map((item) => [item.agentId, item])));
      setTeamSaved(assignmentResponse.saved);
      setExecution(latestExecution.execution);
      if (latestExecution.execution?.run.threadId) {
        const workflowResponse = await api<{ workflow: WorkThreadSnapshot }>(
          `/api/work-threads/${latestExecution.execution.run.threadId}`
        );
        setWorkThread(workflowResponse.workflow);
      }
      setApiReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setApiReady(false);
    } finally {
      setBusy(false);
    }
  }

  function recordActivity(area: string, message: string, kind: "info" | "success" | "warning" = "info") {
    const time = new Date().toLocaleTimeString("es-CO", { hour12: false });
    setActivityLogs((current) => [...current.slice(-79), { time, area, message, kind }]);
  }

  function updateAssignment(agentId: string, patch: Partial<Assignment>) {
    setTeamSaved(false);
    setAssignments((current) => ({
      ...current,
      [agentId]: { ...current[agentId], ...patch } as Assignment
    }));
  }

  function favoriteModelsFor(engine: EngineId) {
    const provider = engine === "claude" ? claudeProvider : "opencode";
    const favoriteIds = new Set(
      favorites
        .filter((item) => item.engine === engine && item.provider === provider)
        .map((item) => item.modelId)
    );
    return models[engine].filter((model) => favoriteIds.has(model.id));
  }

  function changeEngine(agentId: string, engine: EngineId) {
    const firstFavorite = favoriteModelsFor(engine)[0]?.id ?? "";
    if (!firstFavorite) {
      setError(`No tienes modelos favoritos de ${engine === "claude" ? "Claude Code" : "OpenCode"}. Añade y guarda al menos uno antes de asignar ese motor.`);
      return;
    }
    setError("");
    updateAssignment(agentId, { engine, modelId: firstFavorite });
  }

  async function saveClaudeProvider(provider: ClaudeProviderId) {
    setProviderSaving(true);
    setNotice("");
    setError("");
    try {
      const result = await api<{ selectedProvider: ClaudeProviderId; message: string }>("/api/providers/claude", {
        method: "PUT",
        body: JSON.stringify({ provider })
      });
      setClaudeProvider(result.selectedProvider);
      setNotice(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProviderSaving(false);
    }
  }

  async function saveFavorites() {
    setFavoritesSaving(true);
    setNotice("");
    setError("");
    try {
      const result = await api<{ saved: number }>("/api/favorites", {
        method: "PUT",
        body: JSON.stringify({ favorites })
      });
      setNotice(`Modelos favoritos guardados: ${result.saved}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFavoritesSaving(false);
    }
  }

  function changeFavoriteEngine(engine: EngineId) {
    setFavoriteEngine(engine);
    setFavoriteModelId(models[engine][0]?.id ?? "");
  }

  function addFavorite() {
    if (!favoriteModelId) return;
    const provider = favoriteEngine === "claude" ? claudeProvider : "opencode";
    setFavorites((current) => {
      const next = current.filter((item) => !(item.engine === favoriteEngine && item.provider === provider && item.modelId === favoriteModelId));
      return [...next, { engine: favoriteEngine, provider, modelId: favoriteModelId, tier: favoriteTier }];
    });
  }

  function removeFavorite(item: FavoriteModel) {
    setFavorites((current) => current.filter((candidate) =>
      !(candidate.engine === item.engine && candidate.provider === item.provider && candidate.modelId === item.modelId)
    ));
  }

  async function saveTeam() {
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const payload = agents.map((agent) => assignments[agent.id]).filter(Boolean);
      const result = await api<{ saved: number }>("/api/assignments", {
        method: "PUT",
        body: JSON.stringify({ assignments: payload })
      });
      setNotice(`Configuración guardada: ${result.saved} agentes.`);
      setTeamSaved(true);
      recordActivity("CONFIG", `Configuración guardada para ${result.saved} agentes.`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function acceptRecommendation() {
    if (!pendingAssignments) return;
    setAssignments(Object.fromEntries(pendingAssignments.map((item) => [item.agentId, item])));
    setTeamSaved(false);
    setPendingAssignments(null);
    setRecommendationStatus("accepted");
    setNotice("Propuesta aplicada a las tarjetas de agentes. Pulsa «Guardar equipo» para conservarla.");
    recordActivity("ROUTER", "Propuesta de motores y modelos aceptada por el usuario.", "success");
  }

  function chooseManualConfiguration() {
    setTeamSaved(false);
    setPendingAssignments(null);
    setRecommendationStatus("manual");
    setNotice("Propuesta descartada. Puedes configurar cada agente manualmente en Equipo de agentes.");
    recordActivity("ROUTER", "El usuario eligió configurar manualmente el equipo.", "info");
  }

  async function selectProjectDirectory() {
    setFolderPicking(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ path: string | null; cancelled: boolean }>("/api/projects/select-directory", {
        method: "POST",
        body: JSON.stringify({ currentPath: projectPath })
      });
      if (!result.cancelled && result.path) {
        setProjectPath(result.path);
        setAnalysis(null);
        setPendingAssignments(null);
        setRecommendationStatus(null);
        setNotice("Carpeta seleccionada. Revisa la ruta y pulsa «Analizar proyecto» cuando estés listo.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderPicking(false);
    }
  }

  async function startInstructions() {
    if (!analysis || !["accepted", "manual"].includes(recommendationStatus ?? "")) {
      setError("Primero termina la preconsulta y acepta la propuesta o elige la configuración manual.");
      return;
    }
    if (!teamSaved) {
      setError("Guarda el equipo de agentes después de aceptar o modificar sus asignaciones.");
      return;
    }
    if (!projectPath.trim() || !projectInstructions.trim()) {
      setError("Selecciona el proyecto y escribe las instrucciones de trabajo.");
      return;
    }
    if (!configuredCount) {
      setError("Activa al menos un agente para comenzar.");
      return;
    }
    setExecutionStarting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{
        started: boolean; runId: string; threadId: string;
        execution: ExecutionData | null; workflow: WorkThreadSnapshot
      }>("/api/executions", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, instructions: projectInstructions, taskDepth: analysis.taskPlan.depth })
      });
      setExecution(result.execution);
      setWorkThread(result.workflow);
      setContinuationText("");
      setNotice(`Proceso ${result.threadId.slice(0, 8)} iniciado. El historial y las siguientes rondas quedarán agrupados en este proceso.`);
      recordActivity("ORCHESTRATOR", `Ejecución real iniciada: ${result.runId}.`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecutionStarting(false);
    }
  }

  async function continueWork(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workThread || !continuationText.trim()) return;
    if (activeExecution || continuationBusy) {
      setError("Espera a que termine la ronda actual antes de enviar otra instrucción.");
      return;
    }
    setContinuationBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{
        started: boolean; runId: string; threadId: string;
        execution: ExecutionData | null; workflow: WorkThreadSnapshot
      }>(`/api/work-threads/${workThread.thread.id}/continue`, {
        method: "POST",
        body: JSON.stringify({ instructions: continuationText.trim() })
      });
      setExecution(result.execution);
      setWorkThread(result.workflow);
      setContinuationText("");
      setNotice(`Ronda ${result.execution?.run.roundNumber ?? "nueva"} iniciada. Se recuperó el objetivo original, el historial y la evidencia de rondas anteriores.`);
      recordActivity("WORKFLOW", `Continuación de proceso ${result.threadId}; ejecución ${result.runId}.`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContinuationBusy(false);
    }
  }

  async function cancelCurrentExecution() {
    if (!execution) return;
    setExecutionCancelling(true);
    setError("");
    try {
      const result = await api<{ cancelled: boolean; execution: ExecutionData }>(`/api/executions/${execution.run.id}/cancel`, { method: "POST" });
      setExecution(result.execution);
      setNotice("Se solicitó la cancelación de la ejecución.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecutionCancelling(false);
    }
  }

  async function respondToDecision(decisionId: string, action: "allow" | "allow-run" | "deny" | "answer") {
    if (!execution) return;
    const answer = decisionAnswers[decisionId] ?? "";
    if (action === "answer" && !answer.trim()) {
      setError("Escribe la respuesta antes de enviarla.");
      return;
    }
    setDecisionBusyId(decisionId);
    setError("");
    try {
      const result = await api<{ responded: boolean; execution: ExecutionData }>(
        `/api/executions/${execution.run.id}/decisions/${decisionId}/respond`,
        { method: "POST", body: JSON.stringify({ action, answer }) }
      );
      setExecution(result.execution);
      setDecisionAnswers((current) => ({ ...current, [decisionId]: "" }));
      setNotice(action === "allow-run"
        ? "Aprobación temporal guardada. Se aplicará solo durante esta ejecución y se eliminará al finalizar."
        : "Respuesta enviada al agente. La ejecución continuará según la decisión.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // Refresh the run even on a 404/409: the engine may already have consumed
      // the permission request, in which case the backend removes the stale card.
      void api<{ execution: ExecutionData }>(`/api/executions/${execution.run.id}`)
        .then((result) => setExecution(result.execution))
        .catch(() => undefined);
    } finally {
      setDecisionBusyId(null);
    }
  }

  async function analyzeProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    setAnalysis(null);
    setPendingAssignments(null);
    setRecommendationStatus(null);
    recordActivity("PRECHECK", "Preconsulta iniciada; exploración estructural en modo de solo lectura.");
    try {
      const result = await api<ProjectAnalysis>("/api/projects/analyze", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, instructions: projectInstructions })
      });
      setAnalysis(result);
      if (result.recommendationReady) {
        setPendingAssignments(result.suggestedAssignments);
        setRecommendationStatus("pending");
        setNotice(`Preconsulta ${result.complexity.level}: hay una propuesta preparada. Revísala y decide si aceptarla o configurar manualmente.`);
        recordActivity("ROUTER", `Plan ${result.taskPlan.depth}: ${result.taskPlan.recommendedAgents.length} agentes seleccionados usando únicamente favoritos.`, "success");
      } else {
        setPendingAssignments(null);
        setRecommendationStatus(null);
        setNotice(`Preconsulta ${result.complexity.level} completada. ${result.recommendationMessage}`);
        recordActivity("ROUTER", "No hay modelos favoritos suficientes; no se inventaron asignaciones.", "warning");
      }
      recordActivity("PRECHECK", `Exploración terminada: ${result.complexity.level}; ${result.complexity.fileCount} archivos revisados. Ningún motor fue ejecutado.`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const openCode = engines.find((item) => item.id === "opencode");
  const claude = engines.find((item) => item.id === "claude");
  const configuredCount = Object.values(assignments).filter((item) => item?.enabled).length;
  const activeExecution = Boolean(execution && ["queued", "running", "waiting"].includes(execution.run.status));
  const canStartExecution = Boolean(
    apiReady && analysis && ["accepted", "manual"].includes(recommendationStatus ?? "") &&
    teamSaved && projectPath.trim() && projectInstructions.trim() && configuredCount > 0 &&
    !activeExecution && !executionStarting
  );
  const statusLabels: Record<string, string> = {
    queued: "En cola", running: "Trabajando", waiting: "Esperando tu decisión",
    succeeded: "Completado", failed: "Falló", cancelled: "Cancelado",
    interrupted: "Interrumpido", skipped: "Deshabilitado / omitido"
  };
  const statusClasses: Record<string, string> = {
    queued: "status-queued", running: "status-running", waiting: "status-waiting",
    succeeded: "status-success", failed: "status-failed", cancelled: "status-cancelled",
    interrupted: "status-failed", skipped: "status-skipped"
  };
  const terminalEvents = execution?.events ?? [];

  const executionMonitoringPanels = (
    <>
          <section className="section-block decision-section" id="decisions">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">HUMAN IN THE LOOP / APPROVAL QUEUE</div>
                <h2>Centro de decisiones</h2>
                <p>Las sesiones se pausan cuando un agente necesita autorización o una aclaración. Tu respuesta se envía a la sesión que generó la solicitud.</p>
              </div>
              <span className={execution?.decisions.length ? "pending-tag decision-count" : "read-only-tag"}>
                {execution?.decisions.length ?? 0} PENDIENTES
              </span>
            </div>
            {(!execution || execution.decisions.length === 0) && (
              <div className="decision-empty">
                <strong>No hay solicitudes pendientes.</strong>
                <span>Cuando OpenCode o Claude necesiten tu intervención, aparecerá aquí la solicitud con el agente, la acción y su contexto.</span>
              </div>
            )}
            <div className="decision-list">
              {execution?.decisions.map((item) => (
                <article className="decision-card" key={item.id}>
                  <div className="decision-card-head">
                    <div>
                      <span className="terminal-kicker">{item.engine === "claude" ? "CLAUDE CODE" : "OPENCODE"} · {item.kind === "permission" ? "AUTORIZACIÓN" : "ACLARACIÓN"}</span>
                      <h3>{item.title}</h3>
                    </div>
                    <span className="pending-tag">{roleNames[execution.agents.find((runAgent) => runAgent.id === item.agentRunId)?.agentId ?? ""] ?? "Agente"}</span>
                  </div>
                  <p>{item.description}</p>
                  <details className="decision-details">
                    <summary>Ver contexto técnico</summary>
                    <pre>{JSON.stringify(item.details, null, 2)}</pre>
                  </details>
                  {item.kind === "permission" ? (
                    <>
                    <div className="decision-actions">
                      <button className="primary-button" type="button" disabled={decisionBusyId === item.id} onClick={() => void respondToDecision(item.id, "allow")}>
                        {decisionBusyId === item.id ? "Enviando..." : "Aprobar una vez"}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={decisionBusyId === item.id || !canApproveDuringRun(item)}
                        title={canApproveDuringRun(item)
                          ? "Recordar únicamente los recursos o argumentos propuestos por el motor durante esta ejecución"
                          : "El motor no proporcionó un patrón o una operación exacta que pueda recordarse de forma segura"}
                        onClick={() => void respondToDecision(item.id, "allow-run")}
                      >
                        Aprobar durante esta ejecución
                      </button>
                      <button className="secondary-button" type="button" disabled={decisionBusyId === item.id} onClick={() => void respondToDecision(item.id, "deny")}>Rechazar</button>
                    </div>
                    <span className="decision-scope-note">
                      {item.engine === "opencode"
                        ? "La aprobación temporal no modifica permisos globales ni se conserva para futuros análisis. Solo cubre los patrones concretos propuestos por OpenCode."
                        : "La aprobación temporal no modifica permisos globales ni se conserva para futuros análisis. Solo permite repetir exactamente esta misma operación de Claude."}
                    </span>
                    </>
                  ) : (
                    <div className="decision-answer">
                      <textarea value={decisionAnswers[item.id] ?? ""} onChange={(event) => setDecisionAnswers((current) => ({ ...current, [item.id]: event.target.value }))} rows={3} placeholder="Escribe la aclaración para el agente. Para formularios de varios campos de OpenCode, envía un objeto JSON con las claves del formulario." />
                      <button className="primary-button" type="button" disabled={decisionBusyId === item.id || !(decisionAnswers[item.id] ?? "").trim()} onClick={() => void respondToDecision(item.id, "answer")}>
                        {decisionBusyId === item.id ? "Enviando..." : "Enviar respuesta"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>          <section className="section-block activity-section" id="activity">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">SYSTEM TRACE / LIVE ENGINE STREAMS</div>
                <h2>Consola de actividad</h2>
                <p>Eventos reales de las sesiones: inicio de agentes, herramientas ejecutadas, fragmentos de respuesta y resultado de cada fase. Las credenciales se filtran antes de guardar los registros.</p>
              </div>
              <span className="terminal-status"><span /> {activeExecution ? "LIVE EXECUTION" : "LOCAL JOURNAL"}</span>
            </div>
            <div className="terminal-window" role="log" aria-live="polite" aria-label="Registro de actividad de motores y agentes">
              <div className="terminal-bar"><span /><span /><span /><small>factory://engine-streams/{execution?.run.id.slice(0, 8) ?? "idle"}</small></div>
              <div className="terminal-lines">
                {terminalEvents.length === 0 && activityLogs.length === 0 && (
                  <div className="terminal-empty">
                    <span>FACTORY CONTROL CENTER :: MONITOR READY</span>
                    <span>Esperando el comienzo de una ejecución...</span>
                    <span className="terminal-dim">ENGINE STREAMS: STANDBY</span>
                  </div>
                )}
                {terminalEvents.length > 0 ? terminalEvents.map((item) => (
                  <div className={`terminal-line terminal-${item.kind === "success" ? "success" : item.kind === "warning" ? "warning" : "info"}`} key={item.id}>
                    <time>{new Date(item.createdAt).toLocaleTimeString("es-CO", { hour12: false })}</time>
                    <b>[{item.area}]</b><span>{item.message}</span>
                  </div>
                )) : activityLogs.map((item, index) => (
                  <div className={`terminal-line terminal-${item.kind}`} key={`${item.time}-${index}`}>
                    <time>{item.time}</time><b>[{item.area}]</b><span>{item.message}</span>
                  </div>
                ))}
              </div>
              <div className="terminal-footer">
                <span>{execution ? `RUN ${execution.run.id.slice(0, 8)} · ${statusLabels[execution.run.status] ?? execution.run.status}` : "LOCAL EVENT JOURNAL"}</span>
                <span>{terminalEvents.length || activityLogs.length} EVENTOS</span>
              </div>
            </div>
            <div className="terminal-disclaimer">La consola conserva eventos y actividad de herramientas; no muestra cadenas de pensamiento privadas ni credenciales.</div>
          </section>


    </>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <div className="brand-title">SOFTWARE FACTORY</div>
            <div className="brand-subtitle">CONTROL CENTER</div>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <a className="nav-item active" href="#overview"><span>◫</span> Centro de operaciones</a>
          <a className="nav-item" href="#project"><span>⌘</span> Proyectos</a>
          <a className="nav-item" href="#team"><span>◇</span> Equipo de agentes</a>
          <a className="nav-item" href="#skills"><span>▤</span> Skills</a>
          <a className="nav-item" href="#decisions"><span>⚑</span> Centro de decisiones</a>
          <a className="nav-item" href="#activity"><span>▣</span> Consola de actividad</a>
          <a className="nav-item" href="#roadmap"><span>⌁</span> Orquestación</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="local-chip"><span className="pulse-dot" /> LOCALHOST · PRIVADO</div>
          <div className="sidebar-foot">OpenCode Software Factory<br />Multi-engine preview 0.1.0</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Fábrica <span>/</span> Centro de operaciones</div>
          <div className="topbar-right">
            <span className={apiReady ? "system-state online" : "system-state"}>
              <span className="state-dot" /> {apiReady ? "API conectada" : "API sin conexión"}
            </span>
            <button className="icon-button" type="button" onClick={() => void loadInitialData()} title="Actualizar datos">↻</button>
            <div className="avatar">JC</div>
          </div>
        </header>

        <div className="page-wrap" id="overview">
          <section className="page-heading">
            <div>
              <div className="eyebrow">MULTI-AGENT ENGINEERING PLATFORM</div>
              <h1>Centro de operaciones</h1>
              <p className="page-lead">Configura OpenCode y Claude Code dentro de una sola fábrica. Define el motor, modelo y permisos de cada especialista.</p>
            </div>
            <div className="version-tag"><span className="pulse-dot" /> PROTOTIPO LOCAL</div>
          </section>

          {error && <div className="notice error-notice"><strong>Atención</strong><span>{error}</span></div>}
          {notice && <div className="notice success-notice"><strong>Listo</strong><span>{notice}</span></div>}

          <section className="engine-grid">
            <EngineCard engine={openCode} description="Agentes, MCP y herramientas de la fábrica actual." modelCount={models.opencode.length} />
            <EngineCard engine={claude} description="Subagentes y modelos independientes de Claude Code." modelCount={models.claude.length} />
            <div className="metric-card mcp-card">
              <div className="mcp-card-metric">
                <div className="metric-icon">◇</div>
                <div>
                  <div className="metric-label">AGENTES CONFIGURADOS</div>
                  <div className="metric-value">{configuredCount}<small> / {agents.length}</small></div>
                </div>
              </div>
              <div className="mcp-section">
                <div className="mcp-section-heading">
                  <div className="metric-label">MCP DEL PROYECTO</div>
                  <span>{mcpServers.length} CONFIGURADOS</span>
                </div>
                {mcpServers.length > 0 ? (
                  <div className="mcp-list">
                    {mcpServers.map((server) => (
                      <div className={server.enabled ? "mcp-item" : "mcp-item mcp-disabled"} key={server.name}>
                        <span className="mcp-item-dot" />
                        <strong>{server.name}</strong>
                        <small>{server.transport}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mcp-empty">
                    {mcpConfigFound ? "No hay servidores MCP definidos." : "No se encontró la configuración opencode.json."}
                  </div>
                )}
                <div className="mcp-source-note">Lectura de opencode.json · Estado de conexión no verificado</div>
              </div>
            </div>
          </section>

          <section className="section-block provider-block" id="claude-provider">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">CLAUDE CODE / PROVIDER ROUTING</div>
                <h2>Proveedor de Claude Code</h2>
                <p>La fábrica detecta automáticamente el proveedor, endpoint y modelo definidos en ~/.claude/settings.json.</p>
              </div>
              <span className="pending-tag">CONFIGURACIÓN LOCAL / API ANTHROPIC</span>
            </div>
            <div className="provider-choice-grid">
              <label className={claudeProvider === "apmix" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="claude-provider" value="apmix" checked={claudeProvider === "apmix"} disabled={providerSaving}
                  onChange={() => void saveClaudeProvider("apmix")} />
                <span className="provider-choice-content">
                  <strong>APMix</strong>
                  <small>https://api.apmix.ai</small>
                  <em>API compatible con Anthropic · Usa el plan y modelos de tu cuenta APMix.</em>
                </span>
                <span className="provider-check">{claudeProvider === "apmix" ? "✓" : ""}</span>
              </label>
              <label className={claudeProvider === "opencode-go" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="claude-provider" value="opencode-go" checked={claudeProvider === "opencode-go"} disabled={providerSaving}
                  onChange={() => void saveClaudeProvider("opencode-go")} />
                <span className="provider-choice-content">
                  <strong>OpenCode Go</strong>
                  <small>https://opencode.ai/inference/go/anthropic</small>
                  <em>Usa la API Anthropic de OpenCode Go. La fábrica verifica endpoint, credencial y modelo antes de ejecutar.</em>
                </span>
                <span className="provider-check">{claudeProvider === "opencode-go" ? "✓" : ""}</span>
              </label>
              <label className={claudeProvider === "anthropic" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="claude-provider" value="anthropic" checked={claudeProvider === "anthropic"} disabled={providerSaving}
                  onChange={() => void saveClaudeProvider("anthropic")} />
                <span className="provider-choice-content">
                  <strong>Anthropic oficial</strong>
                  <small>https://api.anthropic.com</small>
                  <em>Autenticación oficial de Claude Code, si está disponible en el equipo.</em>
                </span>
                <span className="provider-check">{claudeProvider === "anthropic" ? "✓" : ""}</span>
              </label>
            </div>
            <div className="provider-safety-note">
              <strong>Configuración detectada automáticamente.</strong> La fábrica lee el endpoint, modelo y presencia de credenciales desde ~/.claude/settings.json; pasa las variables al proceso de Claude Code sin mostrarlas ni registrarlas. No modifica el archivo ni el token.
              <div className="provider-config-readout">
                <span>Endpoint: <code>{claudeProviderStatus?.baseUrl || "No detectado"}</code></span>
                <span>Modelo: <code>{claudeProviderStatus?.model || "No detectado"}</code></span>
                <span>Credencial: <strong>{claudeProviderStatus?.credentialDetected ? "Detectada" : "No detectada"}</strong></span>
                <span>API Anthropic compatible: <strong>{claudeProviderStatus?.endpointCompatible ? "Sí" : "No"}</strong></span>
                <span>Configuración lista: <strong>{claudeProviderStatus?.configured ? "Sí" : "Pendiente de corregir"}</strong></span>
              </div>
            </div>
          </section>

          <section className="section-block favorites-block" id="favorites">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">MODEL PREFERENCES / SMART ROUTING</div>
                <h2>Modelos favoritos</h2>
                <p>La asignación automática solo utilizará modelos que marques aquí. Clasifica cada favorito según el nivel de capacidad/costo que quieras reservarle.</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void saveFavorites()} disabled={favoritesSaving}>
                {favoritesSaving ? "Guardando..." : "Guardar favoritos"} <span>↗</span>
              </button>
            </div>
            <div className="favorite-add-row">
              <div className="select-field">
                <label htmlFor="favorite-engine">MOTOR</label>
                <select id="favorite-engine" value={favoriteEngine} onChange={(event) => changeFavoriteEngine(event.target.value as EngineId)}>
                  <option value="opencode">OpenCode</option><option value="claude">Claude Code · {claudeProvider === "apmix" ? "APMix" : claudeProvider === "opencode-go" ? "OpenCode Go" : "Anthropic"}</option>
                </select>
              </div>
              <div className="select-field favorite-model-select">
                <label htmlFor="favorite-model">MODELO DISPONIBLE</label>
                <select id="favorite-model" value={favoriteModelId} onChange={(event) => setFavoriteModelId(event.target.value)}>
                  {models[favoriteEngine].map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
                </select>
              </div>
              <div className="select-field">
                <label htmlFor="favorite-tier">NIVEL</label>
                <select id="favorite-tier" value={favoriteTier} onChange={(event) => setFavoriteTier(event.target.value as ModelTier)}>
                  <option value="economy">Económico</option><option value="balanced">Equilibrado</option><option value="premium">Premium</option>
                </select>
              </div>
              <button className="primary-button" type="button" onClick={addFavorite} disabled={!favoriteModelId}>Añadir favorito <span>+</span></button>
            </div>
            <div className="favorite-list">
              {favorites.length === 0 && <div className="empty-favorites">Todavía no tienes favoritos. Añade modelos de OpenCode y Claude Code para habilitar la asignación automática.</div>}
              {favorites.map((item) => (
                <div className="favorite-row" key={`${item.engine}:${item.provider}:${item.modelId}`}>
                  <div className="favorite-star">★</div>
                  <div className="favorite-model-name"><strong>{item.modelId}</strong><small>{item.engine === "claude" ? `Claude Code · ${item.provider}` : "OpenCode"}</small></div>
                  <span className={`tier-pill tier-${item.tier}`}>{({ economy: "Económico", balanced: "Equilibrado", premium: "Premium" })[item.tier]}</span>
                  <button className="remove-favorite" type="button" onClick={() => removeFavorite(item)} aria-label={`Quitar ${item.modelId}`}>×</button>
                </div>
              ))}
            </div>
            <div className="helper-banner"><span className="helper-icon">i</span><div><strong>Cómo se usan los niveles.</strong> En proyectos de dificultad baja se priorizan modelos económicos; en proyectos medios, equilibrados; y en proyectos altos o muy altos, premium. Si no existe un favorito de ese nivel, se usa el nivel más cercano. El rol del agente desempata entre motores.</div></div>
          </section>

          <section className="section-block" id="project">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">01 / PROJECT DISCOVERY</div>
                <h2>Proyecto de trabajo</h2>
                <p>Indica el repositorio y describe el objetivo. La fábrica analizará la dificultad y preparará una propuesta de equipo.</p>
              </div>
              <span className="read-only-tag">PRECONSULTA · SOLO LECTURA</span>
            </div>

            <form className="project-form" onSubmit={analyzeProject}>
              <label htmlFor="project-path">Ruta local del proyecto</label>
              <div className="path-input-row">
                <input
                  id="project-path"
                  value={projectPath}
                  onChange={(event) => {
                    setProjectPath(event.target.value);
                    setAnalysis(null);
                    setPendingAssignments(null);
                    setRecommendationStatus(null);
                  }}
                  placeholder="/home/usuario/proyectos/mi-aplicacion"
                  required
                />
                <button
                  className="secondary-button folder-button"
                  type="button"
                  onClick={() => void selectProjectDirectory()}
                  disabled={busy || folderPicking}
                >
                  {folderPicking ? "Abriendo..." : "Elegir carpeta"}
                  <span>▰</span>
                </button>
                <button className="primary-button" type="submit" disabled={busy || folderPicking}>
                  {busy ? "Consultando..." : "Preconsulta del proyecto"}
                  <span>↗</span>
                </button>
              </div>
              <label htmlFor="project-instructions" className="project-instructions-label">Objetivo e instrucciones para la fábrica</label>
              <textarea
                id="project-instructions"
                className="project-instructions"
                value={projectInstructions}
                onChange={(event) => {
                  setProjectInstructions(event.target.value);
                  setAnalysis(null);
                  setPendingAssignments(null);
                  setRecommendationStatus(null);
                }}
                rows={5}
                maxLength={12000}
                placeholder="Describe qué necesitas lograr, qué funcionalidades implementar, errores que investigar, criterios de aceptación, restricciones técnicas y qué no debe modificarse..."
              />
              <div className="field-hint">Estas instrucciones se guardan localmente y acompañan el análisis. La ruta identifica el repositorio; este campo define el trabajo que quieres realizar.</div>
            </form>

            {analysis && (
              <div className="analysis-panel">
                <div className="analysis-header">
                  <div>
                    <span className="analysis-kicker">DISCOVERY COMPLETADO</span>
                    <h3>{analysis.name}</h3>
                    <code>{analysis.path}</code>
                  </div>
                  <span className="read-only-tag">SIN MODIFICACIONES</span>
                </div>
                <div className="complexity-panel">
                  <div><span className="mini-label">COMPLEJIDAD DEL PROYECTO</span><strong className={`complexity-${analysis.complexity.level}`}>{({ low: "Baja", medium: "Media", high: "Alta", "very-high": "Muy alta" })[analysis.complexity.level]}</strong></div>
                  <div><span className="mini-label">PUNTUACIÓN HEURÍSTICA</span><strong>{analysis.complexity.score} puntos</strong></div>
                  <div><span className="mini-label">ARCHIVOS REVISADOS</span><strong>{analysis.complexity.fileCount}{analysis.complexity.fileCount >= 5000 ? "+" : ""}</strong></div>
                  <div className="complexity-reasons">{analysis.complexity.reasons.map((reason) => <span key={reason}>• {reason}</span>)}</div>
                </div>
                <div className="complexity-panel task-plan-panel">
                  <div><span className="mini-label">COMPLEJIDAD DE LA TAREA</span><strong>{({ low: "Baja", medium: "Media", high: "Alta" })[analysis.taskPlan.complexity]}</strong></div>
                  <div className="select-field">
                    <label htmlFor="task-depth">PROFUNDIDAD DE INVESTIGACIÓN</label>
                    <select id="task-depth" value={analysis.taskPlan.depth} onChange={(event) => {
                      const depth = event.target.value as TaskPlan["depth"];
                      setAnalysis((current) => current ? { ...current, taskPlan: { ...current.taskPlan, depth } } : current);
                    }}>
                      <option value="quick">Rápida · exploración acotada</option>
                      <option value="focused">Focalizada · módulo y dependencias</option>
                      <option value="deep">Profunda · análisis amplio</option>
                    </select>
                  </div>
                  <div><span className="mini-label">TIPO DE TRABAJO</span><strong>{({ explanation: "Explicación", diagnosis: "Diagnóstico", implementation: "Implementación", testing: "Pruebas", "architecture-review": "Revisión arquitectónica", general: "General" })[analysis.taskPlan.kind]}</strong></div>
                  <div><span className="mini-label">EQUIPO PROPUESTO</span><strong>{analysis.taskPlan.recommendedAgents.length} agente(s)</strong></div>
                  <div className="complexity-reasons">
                    {analysis.taskPlan.reasons.map((reason) => <span key={reason}>• {reason}</span>)}
                    <span>• Sin límite de duración. La profundidad solo orienta el alcance de la investigación.</span>
                    <span>• {analysis.taskPlan.changesExpected ? "La tarea solicita cambios." : "Tarea de solo lectura: no se esperan modificaciones."}</span>
                  </div>
                </div>
                {analysis.recommendationReady && pendingAssignments && (
                  <div className="recommendation-review">
                    <div className="recommendation-review-head">
                      <div>
                        <span className="terminal-kicker">ROUTING / PREVIEW</span>
                        <strong>Equipo recomendado: {pendingAssignments.filter((item) => item.enabled).length} de {pendingAssignments.length} agentes</strong>
                        <p>Puedes activar o desactivar especialistas y ajustar la profundidad antes de aceptar. Los modelos siguen limitados a tus favoritos.</p>
                        <p>La fábrica eligió exclusivamente entre tus modelos favoritos. Todavía no se ha aplicado ni guardado ningún cambio.</p>
                      </div>
                      <span className="pending-tag">PENDIENTE DE TU DECISIÓN</span>
                    </div>
                    <div className="suggestion-table">
                      {pendingAssignments.map((item) => (
                        <div className="suggestion-row" key={item.agentId}>
                          <label className="toggle">
                            <input type="checkbox" checked={item.enabled} onChange={(event) => setPendingAssignments((current) => current?.map((row) => row.agentId === item.agentId ? { ...row, enabled: event.target.checked } : row) ?? null)} />
                            <span />
                          </label>
                          <strong>{roleNames[item.agentId] ?? item.agentId}</strong>
                          <span>{item.engine === "claude" ? "Claude Code · " + (claudeProvider === "apmix" ? "APMix" : claudeProvider === "opencode-go" ? "OpenCode Go" : "Anthropic") : "OpenCode"}</span>
                          <code>★ {item.modelId}</code>
                        </div>
                      ))}
                    </div>
                    <div className="recommendation-actions">
                      <button className="primary-button" type="button" onClick={acceptRecommendation}>Aceptar propuesta <span>✓</span></button>
                      <button className="secondary-button" type="button" onClick={chooseManualConfiguration}>Descartar y configurar manualmente</button>
                    </div>
                  </div>
                )}
                {!analysis.recommendationReady && recommendationStatus === null && (
                  <div className="recommendation-ready manual-choice">
                    <strong>No hay favoritos configurados para generar una propuesta.</strong>
                    <p>Puedes continuar configurando manualmente el motor, modelo y permisos de cada agente.</p>
                    <button className="secondary-button" type="button" onClick={chooseManualConfiguration}>Configurar equipo manualmente</button>
                  </div>
                )}
                {recommendationStatus === "accepted" && (
                  <div className="recommendation-ready"><strong>Propuesta aceptada.</strong> Ya está aplicada a las tarjetas de agentes, pero debes pulsar «Guardar equipo» para persistirla.</div>
                )}
                {recommendationStatus === "manual" && (
                  <div className="recommendation-ready"><strong>Configuración manual.</strong> La propuesta automática fue descartada; ajusta los motores y modelos en las tarjetas del equipo.</div>
                )}
                <div className="analysis-columns">
                  <div>
                    <div className="mini-label">STACK DETECTADO</div>
                    <div className="tag-list">{analysis.stacks.map((stack) => <span className="soft-tag" key={stack}>{stack}</span>)}</div>
                  </div>
                  <div>
                    <div className="mini-label">MANIFIESTOS</div>
                    <div className="tag-list">{analysis.manifests.map((item) => <span className="soft-tag" key={item}>{item}</span>)}</div>
                  </div>
                  <div>
                    <div className="mini-label">INSTRUCCIONES</div>
                    <div className="tag-list">{analysis.instructions.map((item) => <span className="soft-tag" key={item}>{item}</span>)}</div>
                  </div>
                </div>
                <div className="git-status">
                  <div className="mini-label">GIT · {analysis.git.isRepository ? "REPOSITORIO DETECTADO" : "SIN REPOSITORIO CONFIRMADO"}</div>
                  {analysis.git.status.map((line, index) => <code key={index}>{line}</code>)}
                </div>
                <div className="recommendation-list">
                  <div className="mini-label">SIGUIENTES PASOS SUGERIDOS</div>
                  {analysis.recommendations.map((item) => <div className="recommendation" key={item}><span>✓</span>{item}</div>)}
                </div>
              </div>
            )}
          </section>

          {!execution && executionMonitoringPanels}

          <section className="section-block" id="team">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">02 / TEAM CONFIGURATION</div>
                <h2>Equipo de agentes</h2>
                <p>Configura cada agente únicamente con modelos que hayas marcado como favoritos. Los modelos del catálogo general no se pueden asignar al equipo.</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void saveTeam()} disabled={saving || !agents.length}>
                {saving ? "Guardando..." : "Guardar equipo"} <span>↗</span>
              </button>
            </div>

            <div className="agent-grid">
              {agents.map((agent) => {
                const assignment = assignments[agent.id];
                if (!assignment) return null;
                const favoriteChoices = favoriteModelsFor(assignment.engine);
                const currentModelIsFavorite = favoriteChoices.some((model) => model.id === assignment.modelId);
                const engineAvailable = availableEngines.has(assignment.engine);
                return (
                  <article className="agent-card" key={agent.id}>
                    <div className="agent-card-top">
                      <div className="agent-glyph">{agent.id.slice(0, 1).toUpperCase()}</div>
                      <div className="agent-heading">
                        <div className="agent-title">{roleNames[agent.id] ?? agent.id}</div>
                        <div className="agent-id">{agent.id} · {agent.mode}</div>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={assignment.enabled}
                          onChange={(event) => updateAssignment(agent.id, { enabled: event.target.checked })}
                        />
                        <span />
                      </label>
                    </div>
                    <p className="agent-description">{agent.description}</p>
                    <div className="select-field">
                      <label htmlFor={`engine-${agent.id}`}>MOTOR</label>
                      <select
                        id={`engine-${agent.id}`}
                        value={assignment.engine}
                        onChange={(event) => changeEngine(agent.id, event.target.value as EngineId)}
                      >
                        <option value="opencode">OpenCode</option>
                        <option value="claude">Claude Code</option>
                      </select>
                    </div>
                    <div className="select-field">
                      <label htmlFor={`model-${agent.id}`}>MODELO FAVORITO</label>
                      <select
                        id={`model-${agent.id}`}
                        value={assignment.modelId}
                        onChange={(event) => updateAssignment(agent.id, { modelId: event.target.value })}
                        disabled={favoriteChoices.length === 0}
                      >
                        {assignment.modelId && !currentModelIsFavorite && (
                          <option value={assignment.modelId}>{assignment.modelId} · NO ES FAVORITO</option>
                        )}
                        {favoriteChoices.map((model) => (
                          <option value={model.id} key={model.id}>{model.label}</option>
                        ))}
                        {favoriteChoices.length === 0 && <option value="">No hay favoritos para este motor</option>}
                      </select>
                      {!currentModelIsFavorite && <span className="field-hint warning-text">Este agente debe tener asignado un modelo marcado como favorito antes de guardar el equipo.</span>}
                      {favoriteChoices.length === 0 && <span className="field-hint warning-text">Añade y guarda al menos un favorito para este motor.</span>}
                      {!engineAvailable && <span className="field-hint warning-text">El motor no aparece instalado en este equipo.</span>}
                    </div>
                    <div className="select-field">
                      <label htmlFor={`permission-${agent.id}`}>PERMISOS</label>
                      <select
                        id={`permission-${agent.id}`}
                        value={assignment.permissionProfile}
                        onChange={(event) => updateAssignment(agent.id, { permissionProfile: event.target.value as PermissionProfile })}
                      >
                        <option value="read-only">{permissionNames["read-only"]}</option>
                        <option value="approval-required">{permissionNames["approval-required"]}</option>
                        <option value="workspace-write">{permissionNames["workspace-write"]}</option>
                      </select>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="helper-banner">
              <span className="helper-icon">i</span>
              <div><strong>Permisos aplicados por sesión.</strong> Solo lectura impide escribir; Escritura en workspace permite cambios de archivos dentro del proyecto; Requiere aprobación pausa el agente antes de operaciones protegidas. Las credenciales y los archivos sensibles quedan bloqueados.</div>
            </div>
          </section>

          <section className="section-block execution-launch-block" id="execution">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">03 / ORCHESTRATED EXECUTION</div>
                <h2>Comenzar instrucciones</h2>
                <p>Una vez validado el proyecto, aceptado el equipo y guardadas las asignaciones, inicia el trabajo real de los agentes.</p>
              </div>
              <span className={activeExecution ? "terminal-status" : "read-only-tag"}>
                {activeExecution ? statusLabels[execution?.run.status ?? "running"] : teamSaved ? "EQUIPO GUARDADO" : "CONFIGURACIÓN PENDIENTE"}
              </span>
            </div>
            <div className="execution-launch-panel">
              <div className="execution-launch-copy">
                <span className="terminal-kicker">FACTORY ORCHESTRATOR</span>
                <strong>¿Todo listo para iniciar?</strong>
                <p>La fábrica creará una ejecución, abrirá sesiones independientes por agente y distribuirá el objetivo. El trabajo se supervisará desde este panel.</p>
                <div className="execution-checks">
                  <span className={analysis ? "check-ok" : "check-pending"}>{analysis ? "✓" : "○"} Preconsulta del proyecto</span>
                  <span className={["accepted", "manual"].includes(recommendationStatus ?? "") ? "check-ok" : "check-pending"}>{["accepted", "manual"].includes(recommendationStatus ?? "") ? "✓" : "○"} Propuesta aceptada o configuración manual</span>
                  <span className={teamSaved ? "check-ok" : "check-pending"}>{teamSaved ? "✓" : "○"} Equipo guardado</span>
                  <span className={projectPath.trim() && projectInstructions.trim() ? "check-ok" : "check-pending"}>{projectPath.trim() && projectInstructions.trim() ? "✓" : "○"} Proyecto e instrucciones definidos</span>
                  <span className={configuredCount > 0 ? "check-ok" : "check-pending"}>{configuredCount > 0 ? "✓" : "○"} {configuredCount} agentes habilitados</span>
                </div>
              </div>
              <div className="execution-launch-action">
                {activeExecution ? (
                  <button className="danger-button" type="button" onClick={() => void cancelCurrentExecution()} disabled={executionCancelling}>
                    {executionCancelling ? "Cancelando..." : "Detener ejecución"} <span>■</span>
                  </button>
                ) : (
                  <button className="execution-start-button" type="button" onClick={() => void startInstructions()} disabled={!canStartExecution}>
                    <span className="execution-play-icon">▶</span>
                    <span>{executionStarting ? "Preparando..." : "COMENZAR INSTRUCCIONES"}</span>
                  </button>
                )}
                <small>{canStartExecution ? "Listo para iniciar una ejecución real." : activeExecution ? "La ejecución está en curso." : "Completa los pasos pendientes para habilitar el inicio."}</small>
              </div>
            </div>

            {execution && (
              <div className="execution-status-panel">
                <div className="execution-status-heading">
                  <div>
                    <span className="terminal-kicker">EXECUTION ID · {execution.run.id}</span>
                    <h3>{execution.run.projectPath}</h3>
                  </div>
                  <span className={`run-status-pill ${statusClasses[execution.run.status] ?? ""}`}>{statusLabels[execution.run.status] ?? execution.run.status}</span>
                </div>
                <div className="execution-agent-list">
                  {execution.agents.map((agentRun) => (
                    <div className="execution-agent-row" key={agentRun.id}>
                      <div className="execution-agent-identity">
                        <strong>{roleNames[agentRun.agentId] ?? agentRun.agentId}</strong>
                        <span>{agentRun.engine === "claude" ? "Claude Code" : "OpenCode"} · {agentRun.modelId}</span>
                        {agentRun.sessionId && <code>SESSION {agentRun.sessionId}</code>}
                      </div>
                      <span className={`run-status-pill ${statusClasses[agentRun.status] ?? ""}`}>{statusLabels[agentRun.status] ?? agentRun.status}</span>
                      {(agentRun.handoffIn.length > 0 || agentRun.handoffOut.length > 0) && (
                        <small className="agent-handoff-meta">
                          {agentRun.handoffIn.length} entregas recibidas · {agentRun.handoffOut.length} entregas distribuidas
                          {agentRun.handoffOut[0] ? " · " + agentRun.handoffOut[0].id : ""}
                        </small>
                      )}
                      {agentRun.error && <p className="execution-agent-error">{agentRun.error}</p>}
                    </div>
                  ))}
                </div>
                {executionMonitoringPanels}
                {execution.run.summary ? (
                  <div className="execution-summary">
                    <div className="execution-summary-heading">
                      <div>
                        <span className="terminal-kicker">RESUMEN EJECUTIVO</span>
                        <h4>{execution.run.summary.headline}</h4>
                      </div>
                      <span className={`summary-verdict summary-${execution.run.summary.verdict}`}>
                        {execution.run.summary.verdict === "completed" ? "OBJETIVO COMPLETADO" :
                          execution.run.summary.verdict === "observations" ? "CON OBSERVACIONES" : "OBJETIVO NO CUMPLIDO"}
                      </span>
                    </div>
                    <p className="execution-summary-overview">{execution.run.summary.overview}</p>
                    <div className="summary-metrics">
                      <span><strong>{execution.run.summary.participants.succeeded}/{execution.run.summary.participants.total}</strong> agentes completados</span>
                      <span><strong>{execution.run.summary.collaboration.verifiedCrossEngineHandoffs}/{execution.run.summary.collaboration.crossEngineHandoffs}</strong> handoffs entre motores verificados</span>
                      <span><strong>{execution.run.summary.collaboration.concurrentCrossEngineVerified ? "Sí" : "No"}</strong> concurrencia real</span>
                    </div>
                    {execution.run.summary.integrity && execution.run.summary.integrity.status !== "not-assessed" && (
                      <div className="summary-integrity">
                        <div className="summary-integrity-heading">
                          <strong>Integridad de informes</strong>
                          <span>{execution.run.summary.integrity.status === "verified" ? "VERIFICADA" : "CON OBSERVACIONES"}</span>
                        </div>
                        <div className="summary-integrity-metrics">
                          <span>{execution.run.summary.integrity.reportsReceived}/{execution.run.summary.integrity.expectedReports} informes recibidos</span>
                          <span>{execution.run.summary.integrity.reportsVerified}/{execution.run.summary.integrity.expectedReports} con hash, longitud e ID comprobados</span>
                        </div>
                        {execution.run.summary.integrity.truncatedReports.length > 0 && (
                          <p><strong>Truncados:</strong> {execution.run.summary.integrity.truncatedReports.join(", ")}</p>
                        )}
                        {execution.run.summary.integrity.missingReports.length > 0 && (
                          <p><strong>Sin informe:</strong> {execution.run.summary.integrity.missingReports.join(", ")}</p>
                        )}
                        {execution.run.summary.integrity.invalidReports.length > 0 && (
                          <p><strong>Integridad no válida:</strong> {execution.run.summary.integrity.invalidReports.join(", ")}</p>
                        )}
                        {execution.run.summary.integrity.legacyReports.length > 0 && (
                          <p><strong>Metadatos históricos incompletos:</strong> {execution.run.summary.integrity.legacyReports.join(", ")}. Estos informes son anteriores al registro de bytes UTF-8 y autoría estructurada; no se consideran corruptos por esa ausencia.</p>
                        )}
                        {execution.run.summary.integrity.orchestratorIdentifiedReports.length > 0 && (
                          <p><strong>ID incorporado por el orquestador:</strong> {execution.run.summary.integrity.orchestratorIdentifiedReports.join(", ")}</p>
                        )}
                      </div>
                    )}
                    <div className="summary-directions">
                      <span className={execution.run.summary.collaboration.directions.claudeToOpenCode ? "direction-verified" : "direction-missing"}>
                        Claude Code → OpenCode: {execution.run.summary.collaboration.directions.claudeToOpenCode ? "verificado" : "sin evidencia completa"}
                      </span>
                      <span className={execution.run.summary.collaboration.directions.openCodeToClaude ? "direction-verified" : "direction-missing"}>
                        OpenCode → Claude Code: {execution.run.summary.collaboration.directions.openCodeToClaude ? "verificado" : "sin evidencia completa"}
                      </span>
                    </div>
                    <div className="summary-columns">
                      <div>
                        <strong>Hallazgos principales</strong>
                        {execution.run.summary.findings.length ? (
                          <ul>{execution.run.summary.findings.map((item, index) => <li key={index}>{item}</li>)}</ul>
                        ) : <p className="summary-muted">El árbitro no separó hallazgos en una lista; consulta su informe completo en la consola.</p>}
                      </div>
                      <div>
                        <strong>Próximos pasos</strong>
                        {execution.run.summary.nextSteps.length ? (
                          <ul>{execution.run.summary.nextSteps.map((item, index) => <li key={index}>{item}</li>)}</ul>
                        ) : <p className="summary-muted">No se registraron pasos adicionales.</p>}
                      </div>
                    </div>
                    {(execution.run.summary.participants.skipped.length > 0 || execution.run.summary.participants.failed.length > 0) && (
                      <div className="summary-limitations">
                        {execution.run.summary.participants.skipped.length > 0 && <span>No ejecutados: {execution.run.summary.participants.skipped.join(", ")}</span>}
                        {execution.run.summary.participants.failed.length > 0 && <span>Fallidos: {execution.run.summary.participants.failed.join(", ")}</span>}
                      </div>
                    )}
                    <small className="summary-source">Consolidado por {execution.run.summary.generatedBy === "cloud-arbiter" ? "Cloud Arbiter" : "el orquestador"} · {new Date(execution.run.summary.generatedAt).toLocaleString("es-CO")}</small>
                  </div>
                ) : (
                  <div className="execution-summary-pending">
                    <strong>{activeExecution ? "Resumen ejecutivo en preparación" : "No se generó un resumen ejecutivo"}</strong>
                    <span>{activeExecution
                      ? "Se publicará cuando terminen las olas de especialistas y el árbitro consolide los handoffs."
                      : "Consulta los eventos de la consola para conocer el detalle disponible."}</span>
                  </div>
                )}
                {workThread && execution.run.threadId === workThread.thread.id && (
                  <section className="work-continuation-panel" aria-labelledby="continue-work-title">
                    <div className="work-continuation-heading">
                      <div>
                        <span className="terminal-kicker">PROCESO PERSISTENTE · {workThread.thread.id.slice(0, 12)}</span>
                        <h4 id="continue-work-title">Continuar trabajo</h4>
                        <p>El objetivo original, los resultados y las instrucciones anteriores permanecen vinculados a este proceso.</p>
                      </div>
                      <span className={activeExecution ? "workflow-live-pill" : "workflow-ready-pill"}>
                        {activeExecution ? "RONDA EN CURSO" : `${workThread.rounds.length} RONDA(S) REGISTRADA(S)`}
                      </span>
                    </div>
                    <div className="work-history-list" aria-live="polite">
                      {workThread.messages.map((message) => {
                        const matchingRound = workThread.rounds.find((round) =>
                          message.runId ? round.run.id === message.runId : round.run.roundNumber === message.roundNumber
                        );
                        return (
                          <article className={`work-message work-message-${message.role}`} key={message.id}>
                            <div className="work-message-meta">
                              <strong>{message.role === "user" ? "TÚ" : message.role === "assistant" ? "FÁBRICA · RESULTADO DE RONDA" : "SISTEMA"}</strong>
                              <span>RONDA {message.roundNumber} · {new Date(message.createdAt).toLocaleString("es-CO")}</span>
                            </div>
                            <p>{message.content}</p>
                            {message.role === "assistant" && matchingRound && (
                              <details className="work-round-evidence">
                                <summary>Ver evidencia de la ronda · {matchingRound.agents.length} agentes · {matchingRound.events.length} eventos recientes</summary>
                                <div className="work-round-agents">
                                  {matchingRound.agents.map((agentRun) => (
                                    <section key={agentRun.id}>
                                      <strong>{roleNames[agentRun.agentId] ?? agentRun.agentId}</strong>
                                      <span>{agentRun.engine === "claude" ? "Claude Code" : "OpenCode"} · {agentRun.modelId} · {statusLabels[agentRun.status] ?? agentRun.status}</span>
                                      {agentRun.sessionId && <code>SESSION {agentRun.sessionId}</code>}
                                      {agentRun.handoffIn.map((handoff) => <code key={handoff.id}>IN ← {handoff.id} · {handoff.fromEngine} → {handoff.toEngine}</code>)}
                                      {agentRun.handoffOut.map((handoff) => <code key={handoff.id}>OUT → {handoff.id} · {handoff.fromEngine} → {handoff.toEngine}</code>)}
                                      {agentRun.handoffOutput && (
                                        <details
                                          className="work-agent-output"
                                          onToggle={(event) => {
                                            if (event.currentTarget.open) void loadHandoffOutput(matchingRound.run.id, agentRun.id);
                                          }}
                                        >
                                          <summary>
                                            Ver informe persistido · {agentRun.handoffOutput.contentLength.toLocaleString("es-CO")} caracteres
                                            {agentRun.handoffOutput.truncated ? " · INCOMPLETO" : " · ÍNTEGRO"}
                                          </summary>
                                          {handoffOutputLoading[matchingRound.run.id + ":" + agentRun.id] && (
                                            <small>Descargando informe completo…</small>
                                          )}
                                          {handoffOutputErrors[matchingRound.run.id + ":" + agentRun.id] && (
                                            <small role="alert">{handoffOutputErrors[matchingRound.run.id + ":" + agentRun.id]}</small>
                                          )}
                                          {handoffOutputContents[matchingRound.run.id + ":" + agentRun.id] && (
                                            <>
                                              <small>
                                                SHA-256 {handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.sha256} ·
                                                UTF-8 {handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.contentByteLength?.toLocaleString("es-CO") ?? "no disponible"} bytes ·
                                                ID: {handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.idAuthor === "agent"
                                                  ? "emitido por el agente"
                                                  : handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.idAuthor === "orchestrator"
                                                    ? "incorporado por el orquestador"
                                                    : handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.sourceIdentityVerified
                                                      ? "identidad del agente verificada (formato histórico)"
                                                      : "autoría no disponible (formato histórico)"}
                                              </small>
                                              <pre>{handoffOutputContents[matchingRound.run.id + ":" + agentRun.id]?.content}</pre>
                                            </>
                                          )}
                                          {!handoffOutputLoading[matchingRound.run.id + ":" + agentRun.id] &&
                                            !handoffOutputErrors[matchingRound.run.id + ":" + agentRun.id] &&
                                            !handoffOutputContents[matchingRound.run.id + ":" + agentRun.id] && (
                                              <small>El contenido completo se descarga al abrir este apartado.</small>
                                            )}
                                        </details>
                                      )}
                                    </section>
                                  ))}
                                </div>
                                {matchingRound.decisionHistory.length > 0 && (
                                  <div className="work-round-decisions">
                                    <strong>Decisiones y aprobaciones humanas</strong>
                                    {matchingRound.decisionHistory.map((decision) => (
                                      <article key={decision.id}>
                                        <span>{decision.engine === "claude" ? "Claude Code" : "OpenCode"} · {decision.kind} · {decision.status} · {new Date(decision.createdAt).toLocaleString("es-CO")}</span>
                                        <p>{decision.title}: {decision.description}</p>
                                        {decision.response && <p>Respuesta del usuario: {decision.response}</p>}
                                      </article>
                                    ))}
                                  </div>
                                )}
                                <div className="work-round-events">
                                  {matchingRound.events.map((item) => (
                                    <article key={item.id}>
                                      <span>{item.area} · {new Date(item.createdAt).toLocaleTimeString("es-CO", { hour12: false })} · {item.kind}</span>
                                      <p>{item.message}</p>
                                    </article>
                                  ))}
                                </div>
                              </details>
                            )}
                            {message.role === "assistant" && matchingRound && !matchingRound.run.configurationSnapshot && (
                              <div className="work-legacy-note">
                                Esta ejecución es anterior a la captura detallada de configuración. Se conservaron el objetivo, agentes, motores, modelos registrados, eventos, handoffs y resumen originales; las instrucciones de agente y la Skill de aquella fecha no pueden reconstruirse retroactivamente.
                              </div>
                            )}
                            {message.role === "assistant" && matchingRound?.run.configurationSnapshot && (
                              <details className="work-config-snapshot">
                                <summary>Configuración utilizada en esta ronda</summary>
                                <div>
                                  {matchingRound.run.configurationSnapshot.assignments.map((assignment) => (
                                    <span key={assignment.agentId}>
                                      <strong>{roleNames[assignment.agentId] ?? assignment.agentId}</strong>
                                      {assignment.enabled ? " · " : " · OMITIDO · "}
                                      {assignment.engine === "claude" ? "Claude Code" : "OpenCode"} · {assignment.modelId}
                                      {" · "}{assignment.permissionProfile}
                                    </span>
                                  ))}
                                  <small>
                                    Instrucciones de {Object.keys(matchingRound.run.configurationSnapshot.roleInstructionDigests).length} agentes guardadas completas y verificadas mediante SHA-256.
                                    Skill compartida: {matchingRound.run.configurationSnapshot.workflowSkillDigest
                                      ? matchingRound.run.configurationSnapshot.workflowSkillDigest.slice(0, 16) + "…"
                                      : "no disponible"}
                                  </small>
                                  <details className="work-config-instructions">
                                    <summary>Consultar instrucciones históricas exactas</summary>
                                    {Object.entries(matchingRound.run.configurationSnapshot.roleInstructions).map(([agentId, content]) => (
                                      <section key={agentId}>
                                        <strong>{roleNames[agentId] ?? agentId}</strong>
                                        <pre>{content}</pre>
                                        <code>SHA-256 · {matchingRound.run.configurationSnapshot!.roleInstructionDigests[agentId]}</code>
                                      </section>
                                    ))}
                                    {matchingRound.run.configurationSnapshot.workflowSkillContent && (
                                      <section>
                                        <strong>Skill continuous-workflow</strong>
                                        <pre>{matchingRound.run.configurationSnapshot.workflowSkillContent}</pre>
                                      </section>
                                    )}
                                  </details>
                                </div>
                              </details>
                            )}
                          </article>
                        );
                      })}
                      {activeExecution && (
                        <div className="work-live-indicator">
                          <span className="pulse-dot" />
                          Los agentes están trabajando en la ronda {execution.run.roundNumber}. La respuesta se añadirá aquí al finalizar.
                        </div>
                      )}
                    </div>
                    <form className="work-continuation-composer" onSubmit={(event) => void continueWork(event)}>
                      <label htmlFor="continuation-instructions">Nueva instrucción para continuar el mismo proceso</label>
                      <textarea
                        id="continuation-instructions"
                        value={continuationText}
                        onChange={(event) => setContinuationText(event.target.value)}
                        placeholder="Ej.: Revisemos ahora el hallazgo número 2, contrastemos las alternativas y propongamos una solución..."
                        rows={4}
                        maxLength={12000}
                        disabled={activeExecution || continuationBusy}
                      />
                      <div className="work-composer-footer">
                        <span>La siguiente ronda vuelve a leer las instrucciones y Skills vigentes, y usa agentes, modelos favoritos y permisos guardados. Las rondas anteriores no cambian.</span>
                        <button className="primary-button" type="submit" disabled={!continuationText.trim() || activeExecution || continuationBusy}>
                          {continuationBusy ? "Preparando ronda..." : "Continuar proceso"}
                          <span>↗</span>
                        </button>
                      </div>
                    </form>
                  </section>
                )}
                <div className="execution-run-meta">
                  <span>Inicio: {new Date(execution.run.startedAt).toLocaleString("es-CO")}</span>
                  <span>Última actualización: {new Date(execution.run.updatedAt).toLocaleString("es-CO")}</span>
                </div>
              </div>
            )}
            {!canStartExecution && !activeExecution && (
              <div className="execution-guidance">
                <strong>Antes de comenzar:</strong> realiza la preconsulta, elige o acepta la propuesta, revisa los permisos de cada agente y guarda el equipo. Para que el Implementador pueda modificar código, asigna Escritura en workspace o Requiere aprobación según el nivel de supervisión que prefieras.
              </div>
            )}
          </section>

          <section className="bottom-grid">
            <div className="section-block compact-block" id="skills">
              <div className="eyebrow">03 / SHARED KNOWLEDGE</div>
              <h2>Skills de la fábrica</h2>
              <p>Se conservan las Skills existentes. Antes de habilitarlas en Claude, se validará su portabilidad y las instrucciones específicas de cada motor.</p>
              <div className="skill-cloud">{skills.map((skill) => <span className="skill-chip" key={skill}>{skill}</span>)}</div>
              <div className="skill-foot">{skills.length} Skills propias detectadas · La Skill externa REA se conserva por separado.</div>
            </div>

            <div className="section-block compact-block" id="roadmap">
              <div className="eyebrow">04 / ORCHESTRATION</div>
              <h2>Colaboración entre motores</h2>
              <div className="next-step">
                <div className="next-step-icon">⇄</div>
                <div><strong>Coordinación por handoffs</strong><p>Claude Code y OpenCode reciben el mismo objetivo, trabajan en olas paralelas cuando los permisos lo permiten, intercambian entregas identificadas y terminan con una consolidación del Cloud Arbiter.</p></div>
              </div>
              <div className="next-step-status"><span className="status-integrated" /> Integración implementada · sesiones, handoffs, aprobaciones y resumen ejecutivo</div>
            </div>
          </section>

          <footer className="footer">
            <span>OpenCode Software Factory · Factory Control Center 0.1.0</span>
            <span>API local · Discovery en modo de solo lectura</span>
          </footer>
        </div>
      </main>
      {busy && <div className="busy-shade"><div className="spinner" /><span>Consultando los motores y los activos de la fábrica…</span></div>}
    </div>
  );
}

function EngineCard({ engine, description, modelCount }: {
  engine?: EngineStatus;
  description: string;
  modelCount: number;
}) {
  const available = engine?.available ?? false;
  return (
    <div className="engine-card">
      <div className="engine-card-top">
        <div className={`engine-logo ${engine?.id === "claude" ? "claude-logo" : "opencode-logo"}`}>
          {engine?.id === "claude" ? "C" : "O"}
        </div>
        <span className={available ? "engine-badge available" : "engine-badge unavailable"}>
          <span /> {available ? "CLI DETECTADO" : "NO DETECTADO"}
        </span>
      </div>
      <div className="engine-name">{engine?.name ?? "Motor"}</div>
      <div className="engine-version">{engine?.version ?? "CLI no detectado"}</div>
      <p>{description} El proveedor se configura por separado y se validará antes de ejecutar.</p>
      <div className="engine-meta"><span>{modelCount} modelos / alias</span><span>Catálogo del motor</span></div>
    </div>
  );
}
