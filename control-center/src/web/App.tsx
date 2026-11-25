import { useEffect, useMemo, useState } from "react";
import { OpenCodeQuestionForm, type OpenCodeFormField } from "./OpenCodeQuestionForm";
import { InstructionTxtPicker, type SelectedInstructionFile, type InstructionFileMetadata } from "./InstructionTxtPicker";
import { catalogProviderOptions, modelsForOpenCodeProvider, preferredOpenCodeProvider } from "./model-catalog";
import { MAX_WORK_INSTRUCTION_CHARS } from "../api/work-instruction-limit";

type EngineId = "opencode" | "claude";
type ClaudeProviderId = "apmix" | "anthropic" | "opencode-go";
type ModelTier = "economy" | "balanced" | "premium";
interface FavoriteModel { engine: EngineId; provider: string; modelId: string; tier: ModelTier; }
type PermissionProfile = "read-only" | "workspace-write" | "approval-required";
type PermissionMode = "automatic" | "manual";

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

interface ClaudeConnectorStatus {
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
  permissionMode: PermissionMode;
  permissionProfile: PermissionProfile;
  enabled: boolean;
}

type ResearchDepth = "quick" | "focused" | "deep";

function getOpenCodeFormFields(details: unknown): OpenCodeFormField[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const outer = details as Record<string, unknown>;
  const metadata = outer.metadata && typeof outer.metadata === "object" && !Array.isArray(outer.metadata)
    ? outer.metadata as Record<string, unknown>
    : outer;
  const nestedMetadata = metadata.metadata && typeof metadata.metadata === "object" && !Array.isArray(metadata.metadata)
    ? metadata.metadata as Record<string, unknown>
    : null;
  const fieldContainer = [outer, metadata, nestedMetadata].find((candidate) => candidate && Array.isArray(candidate.fields));
  if (!fieldContainer || !Array.isArray(fieldContainer.fields)) return [];
  return fieldContainer.fields
    .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === "object" && !Array.isArray(field))
    .map((field) => ({
      key: String(field.key ?? ""),
      title: typeof field.title === "string" ? field.title : undefined,
      description: typeof field.description === "string" ? field.description : undefined,
      type: String(field.type ?? "string"),
      url: typeof field.url === "string" ? field.url : undefined,
      options: Array.isArray(field.options)
        ? field.options
            .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object" && !Array.isArray(option))
            .map((option) => ({
              value: String(option.value ?? option.label ?? ""),
              label: typeof option.label === "string" ? option.label : undefined,
              description: typeof option.description === "string" ? option.description : undefined
            }))
        : undefined,
      required: typeof field.required === "boolean" ? field.required : undefined,
      default: field.default,
      defaultValue: field.defaultValue,
      minItems: typeof field.minItems === "number" ? field.minItems : undefined,
      maxItems: typeof field.maxItems === "number" ? field.maxItems : undefined,
      minLength: typeof field.minLength === "number" ? field.minLength : undefined,
      maxLength: typeof field.maxLength === "number" ? field.maxLength : undefined,
      minimum: typeof field.minimum === "number" ? field.minimum : undefined,
      maximum: typeof field.maximum === "number" ? field.maximum : undefined,
      multiple: typeof field.multiple === "boolean" ? field.multiple : undefined,
      custom: typeof field.custom === "boolean" ? field.custom : undefined,
      when: field.when,
      hidden: typeof field.hidden === "boolean" ? field.hidden : undefined,
      format: typeof field.format === "string" ? field.format : undefined,
      pattern: typeof field.pattern === "string" ? field.pattern : undefined,
      placeholder: typeof field.placeholder === "string" ? field.placeholder : undefined
    }))
    .filter((field) => Boolean(field.key));
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
  projectStructure: {
    topLevelDirectories: string[];
    modules: string[];
    nestedManifests: string[];
    depthLimit: number;
    fileLimit: number;
    fileCountLimited: boolean;
  };
  complexity: { level: "low" | "medium" | "high" | "very-high"; score: number; reasons: string[]; fileCount: number; };
  projectPlan: { depth: ResearchDepth; recommendedAgents: string[]; reasons: string[] };
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
  approvals?: {
    recordedDecisions: number; recordedApprovalEvents: number;
    pending: number; responding: number; approved: number; rejected: number;
    answered: number; orphaned: number; automaticApprovals: number;
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
  permissionResolution?: Array<{
    agentId: string;
    configuredMode: PermissionMode;
    effectiveProfile: PermissionProfile;
    reason: string;
  }>;
  roleInstructionDigests: Record<string, string>;
  roleInstructions: Record<string, string>;
  instructionFiles?: Array<{ id: string; name: string; sha256: string; byteLength: number }>;
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
  decisions: Array<{ id: string; agentRunId: string; engine: EngineId; engineSessionId: string | null; engineRequestId: string | null; kind: "permission" | "question"; title: string; description: string; details: unknown; status: "pending" | "responding"; createdAt: string }>;
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
  instructionFiles: InstructionFileMetadata[];
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

function isCriticalAuditorDecision(decision: ExecutionData["decisions"][number]): boolean {
  const details = decision.details && typeof decision.details === "object"
    ? decision.details as Record<string, unknown> : {};
  const audit = details.auditor && typeof details.auditor === "object"
    ? details.auditor as Record<string, unknown> : {};
  return audit.verdict === "block";
}

function canApproveDuringRun(decision: ExecutionData["decisions"][number]): boolean {
  if (decision.kind !== "permission" || !decision.details || typeof decision.details !== "object") return false;
  if (isCriticalAuditorDecision(decision)) return false;
  const details = decision.details as Record<string, unknown>;
  if (decision.engine === "claude") return typeof details.approvalKey === "string" && details.approvalKey.length > 0;
  const action = details.action ?? details.permission;
  // Use the same concrete resources as the backend. Provider save suggestions are advisory.
  const resources = Array.isArray(details.resources) ? details.resources : [];
  if (typeof action !== "string" || !action.trim()) return false;
  return resources.some((item) =>
    typeof item === "string" && item.trim().length > 0 &&
    (action === "shell" || !/[*?]/.test(item))
  );
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
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [favoriteEngine, setFavoriteEngine] = useState<EngineId>("opencode");
  const [favoriteCatalogProvider, setFavoriteCatalogProvider] = useState("opencode-go");
  const [favoriteModelId, setFavoriteModelId] = useState("");
  const [favoriteTier, setFavoriteTier] = useState<ModelTier>("balanced");
  const [favoritesSaving, setFavoritesSaving] = useState(false);
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>("focused");
  const [pendingAssignments, setPendingAssignments] = useState<Assignment[] | null>(null);
  const [recommendationStatus, setRecommendationStatus] = useState<"pending" | "accepted" | "manual" | null>(null);
  const [activityLogs, setActivityLogs] = useState<Array<{ time: string; area: string; message: string; kind: "info" | "success" | "warning" }>>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [apiReady, setApiReady] = useState(false);
  const [runtimeBuildWarning, setRuntimeBuildWarning] = useState("");
  const [claudeProviderStatus, setClaudeProviderStatus] = useState<ClaudeConnectorStatus | null>(null);
  const [teamSaved, setTeamSaved] = useState(false);
  const [preflightConsumed, setPreflightConsumed] = useState(false);
  const [execution, setExecution] = useState<ExecutionData | null>(null);
  const [workThread, setWorkThread] = useState<WorkThreadSnapshot | null>(null);
  const [handoffOutputContents, setHandoffOutputContents] = useState<Record<string, HandoffOutputRecord>>({});
  const [handoffOutputLoading, setHandoffOutputLoading] = useState<Record<string, boolean>>({});
  const [handoffOutputErrors, setHandoffOutputErrors] = useState<Record<string, string>>({});
  const [continuationText, setContinuationText] = useState("");
  const [selectedInstructionFile, setSelectedInstructionFile] = useState<SelectedInstructionFile | null>(null);
  const [reuseInstructionFileId, setReuseInstructionFileId] = useState("");
  const [instructionFileBusy, setInstructionFileBusy] = useState(false);
  const [continuationBusy, setContinuationBusy] = useState(false);
  const [executionStarting, setExecutionStarting] = useState(false);
  const [executionCancelling, setExecutionCancelling] = useState(false);
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({});
  const [decisionBusyId, setDecisionBusyId] = useState<string | null>(null);
  const [showTechnicalLogs, setShowTechnicalLogs] = useState(false);

  const availableEngines = useMemo(
    () => new Set(engines.filter((engine) => engine.available).map((engine) => engine.id)),
    [engines]
  );

  const detectedClaudeProvider = claudeProviderStatus?.selectedProvider ?? "apmix";
  const detectedClaudeProviderName = detectedClaudeProvider === "opencode-go" ? "OpenCode Go"
    : detectedClaudeProvider === "apmix" ? "APMix" : "Anthropic";
  const claudeDetectedModelCount = models.claude.filter((model) => model.source === "detected").length;
  const openCodeProviders = useMemo(() => catalogProviderOptions(models.opencode), [models.opencode]);
  const currentFavoriteProvider = preferredOpenCodeProvider(models.opencode, favoriteCatalogProvider);
  const visibleFavoriteCatalog = favoriteEngine === "opencode"
    ? modelsForOpenCodeProvider(models.opencode, currentFavoriteProvider)
    : models.claude;

  useEffect(() => {
    void loadInitialData();
  }, []);

  // An attachment belongs only to the selected project and conversation.
  // Never carry a pending TXT over when the user switches workspace/thread.
  useEffect(() => {
    setSelectedInstructionFile(null);
    setReuseInstructionFileId("");
  }, [projectPath, workThread?.thread.id]);

  useEffect(() => {
    const checkRuntimeBuild = () => {
      void api<{
        build?: { runtimeMatchesDisk: boolean | null; runtimeBuildId: string | null; artifactBuildId: string | null; verification: string };
      }>("/api/health")
        .then((health) => {
          const build = health.build;
          if (!build) {
            setRuntimeBuildWarning("Esta instancia no informa la versión cargada en memoria. Reinicia el Control Center con npm run deploy para verificar el runtime.");
          } else if (build.runtimeMatchesDisk === false) {
            setRuntimeBuildWarning(
              `El Control Center está ejecutando un build diferente al artefacto en disco (runtime: ${build.runtimeBuildId ?? "desconocido"}; disco: ${build.artifactBuildId ?? "desconocido"}). Ejecuta npm run deploy.`
            );
          } else {
            setRuntimeBuildWarning("");
          }
        })
        .catch(() => setRuntimeBuildWarning("No se pudo verificar la versión activa del Control Center."));
    };
    checkRuntimeBuild();
    const timer = window.setInterval(checkRuntimeBuild, 30000);
    return () => window.clearInterval(timer);
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
      const [engineResponse, mcpResponse, assetResponse, assignmentResponse, openCodeModels, claudeModels, providerResponse, favoriteResponse, projectPreferences, latestExecution, preflightResponse] = await Promise.all([
        api<{ engines: EngineStatus[] }>("/api/engines"),
        api<{ configFound: boolean; servers: McpServerInfo[] }>("/api/mcps"),
        api<{ agents: Agent[]; skills: string[] }>("/api/factory/assets"),
        api<{ assignments: Assignment[]; saved: boolean }>("/api/assignments"),
        api<{ models: ModelOption[] }>("/api/models/opencode"),
        api<{ models: ModelOption[] }>("/api/models/claude"),
        api<ClaudeConnectorStatus>("/api/providers/claude"),
        api<{ favorites: FavoriteModel[] }>("/api/favorites"),
        api<{ path: string; instructions: string }>("/api/project-preferences"),
        api<{ execution: ExecutionData | null }>("/api/executions/latest"),
        api<{ preflight: { analysis: ProjectAnalysis; decision: "accepted" | "manual" | null; teamSaved: boolean; consumed: boolean } | null }>("/api/projects/preflight")
      ]);

      setEngines(engineResponse.engines);
      setMcpServers(mcpResponse.servers);
      setMcpConfigFound(mcpResponse.configFound);
      setAgents(assetResponse.agents);
      setSkills(assetResponse.skills);
      setModels({ opencode: openCodeModels.models, claude: claudeModels.models });
      setClaudeProviderStatus(providerResponse);
      setFavorites(favoriteResponse.favorites);
      setProjectPath(projectPreferences.path);
      setFavoriteModelId(
        modelsForOpenCodeProvider(
          openCodeModels.models,
          preferredOpenCodeProvider(openCodeModels.models)
        )[0]?.id ?? ""
      );
      setAssignments(Object.fromEntries(assignmentResponse.assignments.map((item) => [item.agentId, item])));
      const preflight = preflightResponse.preflight;
      setAnalysis(preflight?.analysis ?? null);
      setResearchDepth(preflight?.analysis.projectPlan?.depth ?? "focused");
      setRecommendationStatus(preflight?.decision ?? (preflight?.analysis.recommendationReady ? "pending" : null));
      setPendingAssignments(
        preflight && !preflight.decision && preflight.analysis.recommendationReady
          ? preflight.analysis.suggestedAssignments
          : null
      );
      setTeamSaved(preflight ? preflight.teamSaved : assignmentResponse.saved);
      setPreflightConsumed(preflight?.consumed ?? false);
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
    const provider = engine === "claude" ? detectedClaudeProvider : "opencode";
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
    const options = engine === "opencode"
      ? modelsForOpenCodeProvider(models.opencode, currentFavoriteProvider)
      : models.claude;
    setFavoriteModelId(options[0]?.id ?? "");
  }

  function changeFavoriteCatalogProvider(provider: string) {
    setFavoriteCatalogProvider(provider);
    setFavoriteModelId(modelsForOpenCodeProvider(models.opencode, provider)[0]?.id ?? "");
  }

  function addFavorite() {
    const modelId = visibleFavoriteCatalog.some((model) => model.id === favoriteModelId)
      ? favoriteModelId : (visibleFavoriteCatalog[0]?.id ?? "");
    if (!modelId) return;
    const provider = favoriteEngine === "claude" ? detectedClaudeProvider : "opencode";
    setFavorites((current) => {
      const next = current.filter((item) => !(item.engine === favoriteEngine && item.provider === provider && item.modelId === modelId));
      return [...next, { engine: favoriteEngine, provider, modelId, tier: favoriteTier }];
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

  async function acceptRecommendation() {
    if (!pendingAssignments) return;
    setError("");
    try {
      await api<{ saved: boolean; decision: "accepted" }>("/api/projects/preflight/decision", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, depth: researchDepth, decision: "accepted" })
      });
      setAssignments(Object.fromEntries(pendingAssignments.map((item) => [item.agentId, item])));
      setTeamSaved(false);
      setPendingAssignments(null);
      setRecommendationStatus("accepted");
      setNotice("Propuesta aceptada y registrada. Pulsa «Guardar equipo» para conservar las asignaciones.");
      recordActivity("ROUTER", "Propuesta de motores y modelos aceptada por el usuario.", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function chooseManualConfiguration() {
    setError("");
    try {
      await api<{ saved: boolean; decision: "manual" }>("/api/projects/preflight/decision", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, depth: researchDepth, decision: "manual" })
      });
      setTeamSaved(false);
      setPendingAssignments(null);
      setRecommendationStatus("manual");
      setNotice("Configuración manual registrada. Conserva o ajusta los siete agentes y pulsa «Guardar equipo».");
      recordActivity("ROUTER", "El usuario eligió configurar manualmente el equipo.", "info");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
        setTeamSaved(false);
        setPreflightConsumed(false);
        setNotice("Carpeta seleccionada. Elige la profundidad de preconsulta y revisa la estructura del proyecto.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderPicking(false);
    }
  }

  async function submitWorkInstruction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instructions = continuationText.trim();
    if (!instructions && !selectedInstructionFile && !reuseInstructionFileId) return;
    if (instructionFileBusy) {
      setError("Espera a que termine de cargar el archivo TXT.");
      return;
    }
    if (activeExecution || continuationBusy || executionStarting) {
      setError("Espera a que termine la ronda actual antes de enviar otra instrucción.");
      return;
    }

    setError("");
    setNotice("");

    // Once the one-time project preflight has been consumed, continue the
    // existing conversation and evidence thread.
    if (preflightConsumed && workThread && execution && execution.run.threadId === workThread.thread.id) {
      setContinuationBusy(true);
      try {
        const result = await api<{
          started: boolean; runId: string; threadId: string;
          execution: ExecutionData | null; workflow: WorkThreadSnapshot
        }>("/api/work-threads/" + workThread.thread.id + "/continue", {
          method: "POST",
          body: JSON.stringify({
            instructions,
            ...(selectedInstructionFile
              ? { instructionFile: { name: selectedInstructionFile.name, content: selectedInstructionFile.content } }
              : {}),
            ...(reuseInstructionFileId ? { reuseInstructionFileId } : {})
          })
        });
        setExecution(result.execution);
        setWorkThread(result.workflow);
        setContinuationText("");
        setSelectedInstructionFile(null);
        setReuseInstructionFileId("");
        setNotice("Ronda " + (result.execution?.run.roundNumber ?? "nueva") + " iniciada. Se conservan el historial, los resultados y la evidencia anteriores.");
        recordActivity("WORKFLOW", "Continuación de proceso " + result.threadId + "; ejecución " + result.runId + ".", "success");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setContinuationBusy(false);
      }
      return;
    }

    // The preflight contains project evidence only. The first user task enters
    // here, after the proposed team has been accepted and saved.
    if (!analysis || !["accepted", "manual"].includes(recommendationStatus ?? "")) {
      setError("Primero termina la preconsulta y acepta la propuesta o elige la configuración manual.");
      return;
    }
    if (!teamSaved) {
      setError("Guarda el equipo de agentes después de aceptar o modificar sus asignaciones.");
      return;
    }
    if (!projectPath.trim() || !configuredCount) {
      setError("Selecciona el proyecto y habilita al menos un agente para comenzar.");
      return;
    }

    setExecutionStarting(true);
    try {
      const result = await api<{
        started: boolean; runId: string; threadId: string;
        execution: ExecutionData | null; workflow: WorkThreadSnapshot
      }>("/api/executions", {
        method: "POST",
        body: JSON.stringify({
          path: projectPath,
          instructions,
          ...(selectedInstructionFile
            ? { instructionFile: { name: selectedInstructionFile.name, content: selectedInstructionFile.content } }
            : {}),
          preflightDepth: researchDepth
        })
      });
      setExecution(result.execution);
      setWorkThread(result.workflow);
      setContinuationText("");
      setSelectedInstructionFile(null);
      setReuseInstructionFileId("");
      setPreflightConsumed(true);
      setNotice("Proceso " + result.threadId.slice(0, 8) + " iniciado. Esta es la primera instrucción de la conversación; las siguientes continuarán aquí.");
      recordActivity("ORCHESTRATOR", "Ejecución real iniciada: " + result.runId + ".", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecutionStarting(false);
    }
  }

  function changeResearchDepth(depth: ResearchDepth) {
    if (depth === researchDepth) return;
    setResearchDepth(depth);
    setAnalysis(null);
    setPendingAssignments(null);
    setRecommendationStatus(null);
    setTeamSaved(false);
    setPreflightConsumed(false);
    setNotice("Profundidad actualizada. Ejecuta otra vez la preconsulta para generar una recomendación con este alcance.");
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

  async function respondToDecision(
    decisionId: string,
    action: "allow" | "allow-run" | "deny" | "answer",
    structuredAnswer?: Record<string, unknown>
  ) {
    if (!execution) return;
    const answer = structuredAnswer ? JSON.stringify(structuredAnswer) : decisionAnswers[decisionId] ?? "";
    if (action === "answer" && !answer.trim()) {
      setError("Escribe la respuesta antes de enviarla.");
      return;
    }
    const selectedDecision = execution.decisions.find((item) => item.id === decisionId);
    if ((action === "allow" || action === "allow-run") &&
        selectedDecision && isCriticalAuditorDecision(selectedDecision) &&
        !window.confirm("AUDITOR · RIESGO ALTO. Esta operación podría detener servicios, borrar datos o afectar recursos fuera del proyecto. ¿Has inspeccionado el comando EXACTO y autorizado conscientemente ejecutarlo una sola vez?")) {
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
    setTeamSaved(false);
    setPreflightConsumed(false);
    recordActivity("PRECHECK", "Preconsulta iniciada; exploración estructural en modo de solo lectura.");
    try {
      const result = await api<ProjectAnalysis>("/api/projects/analyze", {
        method: "POST",
        body: JSON.stringify({ path: projectPath, depth: researchDepth })
      });
      setAnalysis(result);
      // Keep the visible selection aligned with the backend's canonical real path.
      setProjectPath(result.path);
      if (result.recommendationReady) {
        setPendingAssignments(result.suggestedAssignments);
        setRecommendationStatus("pending");
        setNotice(`Preconsulta ${result.complexity.level}: hay una propuesta preparada. Revísala y decide si aceptarla o configurar manualmente.`);
        recordActivity("ROUTER", "Preconsulta " + result.projectPlan.depth + ": " + result.projectPlan.recommendedAgents.length + " agentes recomendados por estructura y volumen, usando únicamente favoritos.", "success");
      } else {
        setPendingAssignments(null);
        setRecommendationStatus(null);
        setNotice(`Preconsulta ${result.complexity.level} completada. ${result.recommendationMessage}`);
        recordActivity("ROUTER", "No hay modelos favoritos suficientes; no se inventaron asignaciones.", "warning");
      }
      setResearchDepth(result.projectPlan.depth);
      recordActivity("PRECHECK", "Exploración " + result.projectPlan.depth + " terminada: " + result.complexity.level + "; " + result.complexity.fileCount + " archivos revisados. Ningún motor fue ejecutado.", "success");
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
    teamSaved && projectPath.trim() && configuredCount > 0 &&
    !activeExecution && !executionStarting && !preflightConsumed
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
  const isLowSignalOpenCodeLog = (item: ExecutionData["events"][number]) => {
    if (item.area !== "OPENCODE-SERVER" || !/\blevel=INFO\b/i.test(item.message)) return false;
    const status = item.message.match(/\bhttp\.status=(\d{3})\b/i)?.[1];
    // Preserve HTTP failures in the normal view; collapse only successful/noisy transport chatter.
    if (status && Number(status) >= 400) return false;
    return /(?:\bhttp\.(?:method|url|status)=|message="(?:watcher (?:started|stopped)|location services evicted|Sent HTTP response)"|event\.type=(?:model|provider)\.updated\b|\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+\/)/i.test(item.message);
  };
  const technicalEventCount = terminalEvents.filter(isLowSignalOpenCodeLog).length;
  const visibleTerminalEvents = showTechnicalLogs
    ? terminalEvents
    : terminalEvents.filter((item) => !isLowSignalOpenCodeLog(item));

  const auditorEvents = execution?.events.filter((event) => event.area === "AUDITOR") ?? [];
  const auditorAutoCount = auditorEvents.filter((event) => event.message.startsWith("Permiso aprobado automáticamente")).length;
  const auditorEscalationCount = auditorEvents.filter((event) => /revisión humana|alto riesgo|incidente operativo/i.test(event.message)).length;
  const decisionMonitoringPanel = (
<section className="section-block decision-section" id="decisions">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">HUMAN IN THE LOOP / APPROVAL QUEUE</div>
                <h2>Centro de decisiones</h2>
                <p>El Auditor del sistema aprueba automáticamente solicitudes verificadas como seguras. Solo se muestran para tu decisión las preguntas y las operaciones desconocidas, sensibles o de alto riesgo.</p>
              </div>
              <span className={execution?.decisions.length ? "pending-tag decision-count" : "read-only-tag"}>
                {execution?.decisions.length ?? 0} PENDIENTES
              </span>
            </div>
            <div className="auditor-status-panel" aria-label="Estado del agente Auditor">
              <div className="auditor-status-heading">
                <strong>◈ AGENTE AUDITOR · SEGURIDAD OPERATIVA</strong>
                <span>{execution ? "ACTIVO EN LA RONDA" : "LISTO"}</span>
              </div>
              <p>Política verificable y conservadora: aprueba lecturas, pruebas y diagnósticos permitidos, con registro de cada decisión. No usa un modelo generativo para conceder permisos.</p>
              <div className="auditor-status-details">
                <span><strong>{auditorAutoCount}</strong> autoaprobaciones visibles</span>
                <span><strong>{auditorEscalationCount}</strong> alertas/escalamientos visibles</span>
                <span><strong>AUTOREPARACIÓN DESACTIVADA</strong></span>
              </div>
            </div>
            {(!execution || execution.decisions.length === 0) && (
              <div className="decision-empty">
                <strong>No hay solicitudes pendientes.</strong>
                <span>Cuando OpenCode o Claude necesiten tu intervención, aparecerá aquí la solicitud con el agente, la acción y su contexto.</span>
              </div>
            )}
            <div className="decision-list">
              {execution?.decisions.map((item) => (
                <article className={isCriticalAuditorDecision(item) ? "decision-card auditor-critical-decision" : "decision-card"} key={item.id}>
                  <div className="decision-card-head">
                    <div>
                      <span className="terminal-kicker">{item.engine === "claude" ? "CLAUDE CODE" : "OPENCODE"} · {item.kind === "permission" ? "AUTORIZACIÓN" : "ACLARACIÓN"}</span>
                      <h3>{item.title}</h3>
                    </div>
                    <span className="pending-tag">
                      {roleNames[execution.agents.find((runAgent) => runAgent.id === item.agentRunId)?.agentId ?? ""] ?? "Agente"}
                      {item.status === "responding" ? " · ENVIANDO RESPUESTA" : ""}
                    </span>
                  </div>
                  <p>{item.description}</p>
                  {isCriticalAuditorDecision(item) && (
                    <div className="auditor-danger-warning" role="alert">
                      RIESGO ALTO: el Auditor bloqueó la aprobación automática. Revisa el comando exacto y sus consecuencias antes de aprobar una sola vez; nunca actives permisos permanentes para esta acción.
                    </div>
                  )}
                  <details className="decision-details">
                    <summary>Ver contexto técnico</summary>
                    <pre>{JSON.stringify(item.details, null, 2)}</pre>
                  </details>
                  {item.kind === "permission" ? (
                    <>
                    <div className="decision-actions">
                      <button className="primary-button" type="button" disabled={decisionBusyId === item.id || item.status === "responding"} onClick={() => void respondToDecision(item.id, "allow")}>
                        {decisionBusyId === item.id ? "Enviando..." : "Aprobar una vez"}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={decisionBusyId === item.id || item.status === "responding" || !canApproveDuringRun(item)}
                        title={canApproveDuringRun(item)
                          ? "Recordar únicamente los recursos o argumentos propuestos por el motor durante esta ejecución"
                          : "El motor no proporcionó un patrón o una operación exacta que pueda recordarse de forma segura"}
                        onClick={() => void respondToDecision(item.id, "allow-run")}
                      >
                        Aprobar durante esta ejecución
                      </button>
                      <button className="secondary-button" type="button" disabled={decisionBusyId === item.id || item.status === "responding"} onClick={() => void respondToDecision(item.id, "deny")}>Rechazar</button>
                    </div>
                    <span className="decision-scope-note">
                      {item.engine === "opencode"
                        ? "La aprobación temporal no modifica permisos globales ni se conserva para futuros análisis. Solo cubre los patrones concretos propuestos por OpenCode."
                        : "La aprobación temporal no modifica permisos globales ni se conserva para futuros análisis. Solo permite repetir exactamente esta misma operación de Claude."}
                    </span>
                    </>
                  ) : item.engine === "opencode" && getOpenCodeFormFields(item.details).length > 0 ? (
                    <OpenCodeQuestionForm
                      fields={getOpenCodeFormFields(item.details)}
                      busy={decisionBusyId === item.id || item.status === "responding"}
                      onSubmit={(answers) => void respondToDecision(item.id, "answer", answers)}
                    />
                  ) : (
                    <div className="decision-answer">
                      <textarea
                        disabled={decisionBusyId === item.id || item.status === "responding"}
                        value={decisionAnswers[item.id] ?? ""}
                        onChange={(event) => setDecisionAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                        rows={3}
                        placeholder="Escribe la aclaración para el agente."
                      />
                      <button className="primary-button" type="button" disabled={decisionBusyId === item.id || item.status === "responding" || !(decisionAnswers[item.id] ?? "").trim()} onClick={() => void respondToDecision(item.id, "answer")}>
                        {decisionBusyId === item.id ? "Enviando..." : "Enviar respuesta"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
  );

  const activityMonitoringPanel = (
<section className="section-block activity-section" id="activity">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">SYSTEM TRACE / LIVE ENGINE STREAMS</div>
                <h2>Consola de actividad</h2>
                <p>Eventos reales de las sesiones: inicio de agentes, herramientas ejecutadas, fragmentos de respuesta y resultado de cada fase. Las credenciales se filtran antes de guardar los registros.</p>
              </div>
              <span className="terminal-status"><span /> {activeExecution ? "LIVE EXECUTION" : "LOCAL JOURNAL"}</span>
            </div>
            {technicalEventCount > 0 && (
              <button className="secondary-button terminal-details-toggle" type="button" onClick={() => setShowTechnicalLogs((visible) => !visible)}>
                {showTechnicalLogs ? "Ocultar detalles técnicos" : "Mostrar " + technicalEventCount + " eventos técnicos filtrados"}
              </button>
            )}
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
                {visibleTerminalEvents.length > 0 ? visibleTerminalEvents.map((item) => (
                  <div className={`terminal-line terminal-${item.kind === "success" ? "success" : item.kind === "warning" ? "warning" : "info"}`} key={item.id}>
                    <time>{new Date(item.createdAt).toLocaleTimeString("es-CO", { hour12: false })}</time>
                    <b>[{item.area}]</b><span>{item.message}</span>
                  </div>
                )) : terminalEvents.length > 0 ? (
                  <div className="terminal-empty">
                    <span>ACTIVIDAD PRINCIPAL COMPLETADA</span>
                    <span>Los eventos de bajo nivel están disponibles en los detalles técnicos.</span>
                  </div>
                ) : activityLogs.map((item, index) => (
                  <div className={`terminal-line terminal-${item.kind}`} key={`${item.time}-${index}`}>
                    <time>{item.time}</time><b>[{item.area}]</b><span>{item.message}</span>
                  </div>
                ))}
              </div>
              <div className="terminal-footer">
                <span>{execution ? `RUN ${execution.run.id.slice(0, 8)} · ${statusLabels[execution.run.status] ?? execution.run.status}` : "LOCAL EVENT JOURNAL"}</span>
                <span>{terminalEvents.length > 0 ? visibleTerminalEvents.length : activityLogs.length} / {terminalEvents.length > 0 ? terminalEvents.length : activityLogs.length} EVENTOS VISIBLES</span>
              </div>
            </div>
            <div className="terminal-disclaimer">La consola conserva eventos y actividad de herramientas; no muestra cadenas de pensamiento privadas ni credenciales.</div>
          </section>
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
            <div className="version-tag"><span className="pulse-dot" /> CONTROL CENTER LOCAL</div>
          </section>

          {runtimeBuildWarning && <div className="notice error-notice"><strong>Integridad del runtime</strong><span>{runtimeBuildWarning}</span></div>}
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

          <section className="section-block favorites-block" id="favorites">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">MODEL PREFERENCES / SMART ROUTING</div>
                <h2>Modelos favoritos</h2>
                <p>Los modelos se detectan automáticamente según los motores y conectores disponibles. Marca aquí los que la fábrica podrá asignar y clasifícalos por capacidad/costo.</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => void saveFavorites()} disabled={favoritesSaving}>
                {favoritesSaving ? "Guardando..." : "Guardar favoritos"} <span>↗</span>
              </button>
            </div>
            <div className="model-catalog-status">
              <span><strong>OpenCode</strong> · {models.opencode.length} modelos detectados en sus conectores</span>
              <span><strong>Claude Code</strong> · {detectedClaudeProviderName} detectado · {claudeDetectedModelCount} modelos del conector</span>
              <span>OpenCode Go: {openCodeProviders.find((option) => option.id === "opencode-go")?.count ?? 0} modelos visibles en su proveedor</span>
              <span className={claudeProviderStatus?.configured ? "catalog-status-ready" : "catalog-status-review"}>
                {claudeProviderStatus?.configured ? "Configuración local detectada" : "Revisar configuración local de Claude Code"}
              </span>
            </div>
            <div className="favorite-add-row">
              <div className="select-field">
                <label htmlFor="favorite-engine">MOTOR</label>
                <select id="favorite-engine" value={favoriteEngine} onChange={(event) => changeFavoriteEngine(event.target.value as EngineId)}>
                  <option value="opencode">OpenCode · {models.opencode.length} modelos</option>
                  <option value="claude">Claude Code · {detectedClaudeProviderName}</option>
                </select>
              </div>
              {favoriteEngine === "opencode" && (
                <div className="select-field favorite-provider-select">
                  <label htmlFor="favorite-provider">PROVEEDOR / CONECTOR</label>
                  <select
                    id="favorite-provider"
                    value={currentFavoriteProvider}
                    onChange={(event) => changeFavoriteCatalogProvider(event.target.value)}
                  >
                    <option value="all">Todos los proveedores · {models.opencode.length} modelos</option>
                    {openCodeProviders.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} · {option.count} modelos
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="select-field favorite-model-select">
                <label htmlFor="favorite-model">MODELO DISPONIBLE</label>
                <select
                  id="favorite-model"
                  value={visibleFavoriteCatalog.some((model) => model.id === favoriteModelId) ? favoriteModelId : (visibleFavoriteCatalog[0]?.id ?? "")}
                  onChange={(event) => setFavoriteModelId(event.target.value)}
                  disabled={visibleFavoriteCatalog.length === 0}
                >
                  {visibleFavoriteCatalog.length === 0
                    ? <option value="">No se detectaron modelos para este proveedor</option>
                    : visibleFavoriteCatalog.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
                </select>
              </div>
              <div className="select-field">
                <label htmlFor="favorite-tier">NIVEL</label>
                <select id="favorite-tier" value={favoriteTier} onChange={(event) => setFavoriteTier(event.target.value as ModelTier)}>
                  <option value="economy">Económico</option><option value="balanced">Equilibrado</option><option value="premium">Premium</option>
                </select>
              </div>
              <button className="primary-button" type="button" onClick={addFavorite} disabled={visibleFavoriteCatalog.length === 0}>Añadir favorito <span>+</span></button>
            </div>
            <p className="favorite-provider-hint">Elige <strong>OpenCode → OpenCode Go</strong> para ver solo sus modelos. En Claude Code se muestran sin el prefijo <code>opencode-go/</code>, porque así los identifica ese motor.</p>
            <div className="favorite-list">
              {favorites.length === 0 && <div className="empty-favorites">Todavía no tienes favoritos. Añade modelos de OpenCode y Claude Code para habilitar la asignación automática.</div>}
              {favorites.map((item) => (
                <div className="favorite-row" key={`${item.engine}:${item.provider}:${item.modelId}`}>
                  <div className="favorite-star">★</div>
                  <div className="favorite-model-name"><strong>{item.modelId}</strong><small>{item.engine === "claude" ? "Claude Code · " + detectedClaudeProviderName : "OpenCode"}</small></div>
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
                <p>Indica el repositorio. La fábrica revisará su arquitectura, sus módulos y el volumen de información para recomendar el equipo de agentes, sin necesitar todavía una instrucción de trabajo.</p>
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
                    setTeamSaved(false);
                    setPreflightConsumed(false);
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
              <div className="research-depth-control">
                <div className="research-depth-heading">
                  <label>PROFUNDIDAD DE PRECONSULTA</label>
                  <span>Elige cuánto debe recorrer la fábrica antes de recomendar el equipo.</span>
                </div>
                <div className="research-depth-options" role="group" aria-label="Profundidad de preconsulta">
                  <button type="button" className={researchDepth === "quick" ? "selected" : ""} aria-pressed={researchDepth === "quick"} onClick={() => changeResearchDepth("quick")} disabled={busy}>
                    <strong>Rápida</strong><small>Vista general</small>
                  </button>
                  <button type="button" className={researchDepth === "focused" ? "selected" : ""} aria-pressed={researchDepth === "focused"} onClick={() => changeResearchDepth("focused")} disabled={busy}>
                    <strong>Focalizada</strong><small>Arquitectura y módulos</small>
                  </button>
                  <button type="button" className={researchDepth === "deep" ? "selected" : ""} aria-pressed={researchDepth === "deep"} onClick={() => changeResearchDepth("deep")} disabled={busy}>
                    <strong>Profunda</strong><small>Recorrido ampliado</small>
                  </button>
                </div>
                <div className="field-hint">La profundidad modifica el alcance del análisis de solo lectura. No determina qué trabajo realizarán después los agentes.</div>
              </div>
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
                <div className="complexity-panel project-plan-panel">
                  <div><span className="mini-label">PROFUNDIDAD UTILIZADA</span><strong>{({ quick: "Rápida", focused: "Focalizada", deep: "Profunda" })[analysis.projectPlan.depth]}</strong></div>
                  <div><span className="mini-label">MÓDULOS DETECTADOS</span><strong>{analysis.projectStructure.modules.length}</strong></div>
                  <div><span className="mini-label">EQUIPO RECOMENDADO</span><strong>{analysis.projectPlan.recommendedAgents.length} agente(s)</strong></div>
                  <div className="complexity-reasons">
                    {analysis.projectPlan.reasons.map((reason) => <span key={reason}>• {reason}</span>)}
                    <span>• La recomendación se basa en la estructura y volumen del proyecto, no en una tarea todavía no definida.</span>
                    <span>• El tipo de trabajo y los especialistas necesarios podrán ajustarse cuando envíes tu primera instrucción en el chat.</span>
                  </div>
                </div>
                {analysis.recommendationReady && pendingAssignments && (
                  <div className="recommendation-review">
                    <div className="recommendation-review-head">
                      <div>
                        <span className="terminal-kicker">ROUTING / PREVIEW</span>
                        <strong>Equipo recomendado: {pendingAssignments.filter((item) => item.enabled).length} de {pendingAssignments.length} agentes</strong>
                        <p>Puedes activar o desactivar especialistas antes de aceptar. La profundidad ya se eligió en Proyecto de trabajo. Los modelos siguen limitados a tus favoritos.</p>
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
                          <span>{item.engine === "claude" ? "Claude Code · " + detectedClaudeProviderName : "OpenCode"}</span>
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
                    <strong>No hay favoritos configurados para generar una propuesta automática.</strong>
                    <p>La preconsulta ya detectó la estructura del proyecto. Añade modelos favoritos y vuelve a consultar, o configura manualmente el equipo.</p>
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
                    <div className="mini-label">DIRECTORIOS PRINCIPALES</div>
                    <div className="tag-list">{analysis.projectStructure.topLevelDirectories.map((item) => <span className="soft-tag" key={item}>{item}/</span>)}</div>
                  </div>
                  <div>
                    <div className="mini-label">MÓDULOS / MANIFIESTOS INTERNOS</div>
                    <div className="tag-list">
                      {analysis.projectStructure.modules.map((item) => <span className="soft-tag" key={item}>{item}</span>)}
                      {analysis.projectStructure.modules.length === 0 && <span className="field-hint">No se detectaron submódulos con manifiestos propios.</span>}
                    </div>
                  </div>
                  <div>
                    <div className="mini-label">ARCHIVOS DE CONTEXTO</div>
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
                      <label htmlFor={`permission-${agent.id}`}>POLÍTICA DE PERMISOS</label>
                      <select
                        id={`permission-${agent.id}`}
                        value={assignment.permissionMode === "automatic" ? "automatic" : assignment.permissionProfile}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "automatic") {
                            updateAssignment(agent.id, { permissionMode: "automatic" });
                          } else {
                            updateAssignment(agent.id, {
                              permissionMode: "manual",
                              permissionProfile: value as PermissionProfile
                            });
                          }
                        }}
                      >
                        <option value="automatic">Automático según la tarea</option>
                        <option value="read-only">Manual · {permissionNames["read-only"]}</option>
                        <option value="approval-required">Manual · {permissionNames["approval-required"]}</option>
                        <option value="workspace-write">Manual · {permissionNames["workspace-write"]}</option>
                      </select>
                      <span className="field-hint">
                        {assignment.permissionMode === "automatic"
                          ? agent.id === "implementer"
                            ? "Recibirá escritura solo cuando el planificador detecte una tarea de implementación."
                            : agent.id === "tester"
                              ? "Conservará aprobación humana para ejecutar pruebas y comandos."
                              : "Permanecerá en solo lectura para analizar o revisar sin alterar el proyecto."
                          : "Se respetará este perfil fijo aunque la tarea requiera otro nivel de acceso."}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="helper-banner">
              <span className="helper-icon">i</span>
              <div><strong>Permisos automáticos y temporales.</strong> El planificador adapta los permisos a cada tarea: solo el Implementer recibe escritura en el workspace cuando se solicitan cambios; Tester conserva la aprobación humana para comandos; los demás especialistas permanecen en lectura. Puedes fijar un perfil manual para bloquear la automatización en un agente. Los cambios nunca amplían el acceso a credenciales, archivos sensibles ni rutas externas.</div>
            </div>
          </section>

          <section className="section-block execution-launch-block" id="execution">
            <div className="section-title-row">
              <div>
                <div className="eyebrow">03 / ORCHESTRATED EXECUTION</div>
                <h2>{execution && (activeExecution || preflightConsumed) ? "Trabajo en conversación" : canStartExecution ? "Tu espacio de trabajo" : "Comenzar instrucciones"}</h2>
                <p>{execution && (activeExecution || preflightConsumed)
                  ? "Sigue la actividad de los motores, consulta los resultados y continúa el mismo proceso cuando quieras."
                  : canStartExecution
                    ? "El proyecto ya está analizado y el equipo está listo. Escribe tu primera instrucción en el chat para comenzar."
                    : "La preconsulta analiza el proyecto sin instrucciones. Después de aceptar la propuesta y guardar el equipo, podrás iniciar el trabajo desde el chat."}</p>
              </div>
              <span className={activeExecution ? "terminal-status" : "read-only-tag"}>
                {activeExecution ? statusLabels[execution?.run.status ?? "running"] : teamSaved ? "EQUIPO GUARDADO" : "CONFIGURACIÓN PENDIENTE"}
              </span>
            </div>
            {(!canStartExecution && !preflightConsumed && !activeExecution || activeExecution) && (
              <div className="execution-launch-panel">
                <div className="execution-launch-copy">
                  <span className="terminal-kicker">FACTORY ORCHESTRATOR</span>
                  <strong>{activeExecution ? "Ejecución en curso" : "Preparación del trabajo"}</strong>
                  <p>{activeExecution
                    ? "Los motores están trabajando. Puedes detener la ejecución desde aquí."
                    : "Completa la preconsulta, acepta la recomendación o configura el equipo manualmente y guarda las asignaciones. La primera tarea se escribirá en el chat."}</p>
                  <div className="execution-checks">
                    <span className={analysis ? "check-ok" : "check-pending"}>{analysis ? "✓" : "○"} Preconsulta del proyecto</span>
                    <span className={["accepted", "manual"].includes(recommendationStatus ?? "") ? "check-ok" : "check-pending"}>{["accepted", "manual"].includes(recommendationStatus ?? "") ? "✓" : "○"} Propuesta aceptada o configuración manual</span>
                    <span className={teamSaved ? "check-ok" : "check-pending"}>{teamSaved ? "✓" : "○"} Equipo guardado</span>
                    <span className={configuredCount > 0 ? "check-ok" : "check-pending"}>{configuredCount > 0 ? "✓" : "○"} {configuredCount} agentes habilitados</span>
                  </div>
                </div>
                <div className="execution-launch-action">
                  {activeExecution && (
                    <button className="danger-button" type="button" onClick={() => void cancelCurrentExecution()} disabled={executionCancelling}>
                      {executionCancelling ? "Cancelando..." : "Detener ejecución"} <span>■</span>
                    </button>
                  )}
                  <small>{activeExecution
                    ? "La ejecución está en curso."
                    : "Cuando el equipo esté guardado, la entrada de chat aparecerá aquí."}</small>
                </div>
              </div>
            )}


            {canStartExecution && !activeExecution && (
              <section className="factory-conversation factory-conversation-ready" aria-label="Primera instrucción de trabajo">
                <div className="factory-conversation-heading">
                  <div>
                    <span className="conversation-kicker">PROYECTO PRECONSULTADO · EQUIPO GUARDADO</span>
                    <h3>¿Qué necesitas que hagamos en este proyecto?</h3>
                    <p>Cuéntale a la fábrica qué quieres conseguir. OpenCode y Claude Code se coordinarán con el equipo que acabas de validar.</p>
                  </div>
                  <span className="conversation-state is-done"><span />LISTO PARA COMENZAR</span>
                </div>
                <form className="conversation-composer" onSubmit={(event) => void submitWorkInstruction(event)}>
                  <label htmlFor="continuation-instructions">Tu primera instrucción</label>
                  <textarea
                    id="continuation-instructions"
                    value={continuationText}
                    onChange={(event) => setContinuationText(event.target.value)}
                    placeholder="Describe qué necesitas: implementar una funcionalidad, investigar un error, crear pruebas, revisar un módulo o cualquier otra tarea..."
                    rows={4}
                    maxLength={MAX_WORK_INSTRUCTION_CHARS}
                    disabled={executionStarting || continuationBusy}
                  />
                  <InstructionTxtPicker
                    id="initial-instruction-txt"
                    disabled={executionStarting || continuationBusy}
                    selected={selectedInstructionFile}
                    reusableFiles={[]}
                    reuseFileId=""
                    onSelected={setSelectedInstructionFile}
                    onReuseChange={setReuseInstructionFileId}
                    onBusyChange={setInstructionFileBusy}
                    onError={setError}
                  />
                  <div className="conversation-composer-footer">
                    <span>La preconsulta ya terminó. Esta instrucción iniciará el proceso y quedará guardada como el primer mensaje de la conversación. ({continuationText.length.toLocaleString("es-CO")} / {MAX_WORK_INSTRUCTION_CHARS.toLocaleString("es-CO")} caracteres)</span>
                    <button className="primary-button" type="submit" disabled={(!continuationText.trim() && !selectedInstructionFile) || executionStarting || continuationBusy || instructionFileBusy}>
                      {executionStarting ? "Iniciando..." : "Comenzar trabajo"} <span>↗</span>
                    </button>
                  </div>
                </form>
              </section>
            )}


            {execution && (activeExecution || preflightConsumed) && (
              <>
                <section className="factory-conversation" aria-label="Conversación de trabajo de la fábrica">
                  <div className="factory-conversation-heading">
                    <div>
                      <span className="conversation-kicker">FACTORY SESSION · RONDA {execution.run.roundNumber}</span>
                      <h3>Tu trabajo, en directo</h3>
                      <p>OpenCode y Claude Code muestran aquí su actividad real. Al terminar, la fábrica reúne sus resultados en una respuesta clara.</p>
                    </div>
                    <span className={"conversation-state " + (activeExecution ? "is-live" : execution.run.status === "succeeded" ? "is-done" : "is-observed")}>
                      <span />{activeExecution ? "TRABAJO EN CURSO" : statusLabels[execution.run.status] ?? execution.run.status}
                    </span>
                  </div>


                  {(() => {
                    const currentMessages = workThread?.messages.filter((message) =>
                      message.roundNumber === execution.run.roundNumber && message.role !== "assistant"
                    ) ?? [];
                    const olderMessages = workThread?.messages.filter((message) =>
                      message.roundNumber < execution.run.roundNumber
                    ) ?? [];
                    const hasCurrentUserMessage = currentMessages.some((message) => message.role === "user");
                    return (
                      <>
                        <div className="conversation-transcript">
                          {currentMessages.map((message) => (
                            <article className={"conversation-message conversation-message-" + message.role} key={message.id}>
                              <div className="conversation-message-meta">
                                <strong>{message.role === "user" ? "TÚ" : "ACTUALIZACIÓN"}</strong>
                                <span>RONDA {message.roundNumber} · {new Date(message.createdAt).toLocaleString("es-CO")}</span>
                              </div>
                              {message.role === "user" && message.content.length > 1000 ? (
                                <details className="conversation-long-message">
                                  <summary>
                                    <span>{presentConversationalText(message.content.slice(0, 420))}…</span>
                                    <strong>Ver instrucciones completas</strong>
                                  </summary>
                                  <pre>{message.content}</pre>
                                </details>
                              ) : (
                                <p className="conversation-message-copy">{presentConversationalText(message.content)}</p>
                              )}
                            </article>
                          ))}
                          {!hasCurrentUserMessage && (
                            <article className="conversation-message conversation-message-user">
                              <div className="conversation-message-meta">
                                <strong>TÚ</strong><span>RONDA {execution.run.roundNumber}</span>
                              </div>
                              {execution.run.instructions.length > 1000 ? (
                                <details className="conversation-long-message">
                                  <summary>
                                    <span>{presentConversationalText(execution.run.instructions.slice(0, 420))}…</span>
                                    <strong>Ver instrucciones completas</strong>
                                  </summary>
                                  <pre>{execution.run.instructions}</pre>
                                </details>
                              ) : (
                                <p className="conversation-message-copy">{presentConversationalText(execution.run.instructions)}</p>
                              )}
                            </article>
                          )}
                        </div>
                        {olderMessages.length > 0 && (
                          <details className="conversation-history">
                            <summary>Ver conversación anterior · {olderMessages.length} mensajes de {workThread?.rounds.length ?? 0} rondas</summary>
                            <div className="conversation-history-list">
                              {olderMessages.map((message) => (
                                <article className={"conversation-message conversation-message-" + message.role} key={message.id}>
                                  <div className="conversation-message-meta">
                                    <strong>{message.role === "user" ? "TÚ" : message.role === "assistant" ? "FÁBRICA" : "ACTUALIZACIÓN"}</strong>
                                    <span>RONDA {message.roundNumber} · {new Date(message.createdAt).toLocaleString("es-CO")}</span>
                                  </div>
                                  <p className="conversation-message-copy">{presentConversationalText(message.content)}</p>
                                </article>
                              ))}
                            </div>
                          </details>
                        )}
                      </>
                    );
                  })()}


                  <div className="engine-console-heading">
                    <div>
                      <span className="conversation-kicker">MOTORES EN ACCIÓN</span>
                      <h4>Así están trabajando los agentes</h4>
                    </div>
                    <span className="engine-console-refresh"><span /> Actividad sincronizada con las sesiones</span>
                  </div>
                  <div className="engine-console-grid">
                    <EngineActivityPanel engine="opencode" execution={execution} roleNames={roleNames} statusLabels={statusLabels} />
                    <EngineActivityPanel engine="claude" execution={execution} roleNames={roleNames} statusLabels={statusLabels} />
                  </div>

                  {decisionMonitoringPanel}

                  {(() => {
                    const currentAssistantMessage = workThread?.messages.find((message) =>
                      message.role === "assistant" &&
                      (message.runId === execution.run.id || message.roundNumber === execution.run.roundNumber)
                    );
                    const currentSummary = execution.run.summary ??
                      workThread?.rounds.find((round) => round.run.id === execution.run.id)?.run.summary;
                    if (currentAssistantMessage && currentSummary) {
                      return (
                        <article className="conversation-result-card">
                          <div className="conversation-result-meta">
                            <div>
                              <span className="conversation-kicker">RESPUESTA DE LA FÁBRICA</span>
                              <h4>{currentSummary.headline}</h4>
                            </div>
                            <span className={"conversation-verdict verdict-" + currentSummary.verdict}>
                              {currentSummary.verdict === "completed" ? "COMPLETADO" : currentSummary.verdict === "observations" ? "CON OBSERVACIONES" : "REQUIERE ATENCIÓN"}
                            </span>
                          </div>
                          <p className="conversation-result-overview">{presentConversationalText(currentSummary.overview)}</p>
                          {currentSummary.findings.length > 0 && (
                            <div className="conversation-answer-section">
                              <strong>Lo importante que encontramos</strong>
                              <ul>{currentSummary.findings.map((item, index) => <li key={index}>{item}</li>)}</ul>
                            </div>
                          )}
                          {currentSummary.nextSteps.length > 0 && (
                            <div className="conversation-answer-section">
                              <strong>Cómo podemos continuar</strong>
                              <ul>{currentSummary.nextSteps.map((item, index) => <li key={index}>{item}</li>)}</ul>
                            </div>
                          )}
                          <details className="conversation-original-answer">
                            <summary>Ver respuesta completa y datos de consolidación</summary>
                            <pre>{currentAssistantMessage.content}</pre>
                          </details>
                        </article>
                      );
                    }
                    if (currentSummary) {
                      return (
                        <article className="conversation-result-card">
                          <div className="conversation-result-meta">
                            <div><span className="conversation-kicker">RESPUESTA DE LA FÁBRICA</span><h4>{currentSummary.headline}</h4></div>
                            <span className={"conversation-verdict verdict-" + currentSummary.verdict}>
                              {currentSummary.verdict === "completed" ? "COMPLETADO" : currentSummary.verdict === "observations" ? "CON OBSERVACIONES" : "REQUIERE ATENCIÓN"}
                            </span>
                          </div>
                          <p className="conversation-result-overview">{presentConversationalText(currentSummary.overview)}</p>
                          {currentSummary.findings.length > 0 && <div className="conversation-answer-section"><strong>Lo importante que encontramos</strong><ul>{currentSummary.findings.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                          {currentSummary.nextSteps.length > 0 && <div className="conversation-answer-section"><strong>Cómo podemos continuar</strong><ul>{currentSummary.nextSteps.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                        </article>
                      );
                    }
                    return null;
                  })()}

                  {activeExecution && (
                    <div className="conversation-live-note">
                      <span className="conversation-live-pulse" />
                      Los motores siguen trabajando. La respuesta consolidada aparecerá aquí cuando terminen las fases y la revisión final.
                    </div>
                  )}

                  {workThread && execution.run.threadId === workThread.thread.id && (
                    <form className="conversation-composer" onSubmit={(event) => void submitWorkInstruction(event)}>
                      <label htmlFor="continuation-instructions">¿Qué hacemos a continuación?</label>
                      <textarea
                        id="continuation-instructions"
                        value={continuationText}
                        onChange={(event) => setContinuationText(event.target.value)}
                        placeholder="Escribe tu siguiente instrucción. Puedes pedir una corrección, profundizar en un hallazgo, solicitar pruebas o continuar con otra tarea..."
                        rows={3}
                        maxLength={MAX_WORK_INSTRUCTION_CHARS}
                        disabled={activeExecution || continuationBusy}
                      />
                      <InstructionTxtPicker
                        id="continuation-instruction-txt"
                        disabled={activeExecution || continuationBusy}
                        selected={selectedInstructionFile}
                        reusableFiles={workThread.instructionFiles ?? []}
                        reuseFileId={reuseInstructionFileId}
                        onSelected={setSelectedInstructionFile}
                        onReuseChange={setReuseInstructionFileId}
                        onBusyChange={setInstructionFileBusy}
                        onError={setError}
                      />
                      <div className="conversation-composer-footer">
                        <span>El proceso conserva el contexto, los resultados y la evidencia de las rondas anteriores. ({continuationText.length.toLocaleString("es-CO")} / {MAX_WORK_INSTRUCTION_CHARS.toLocaleString("es-CO")} caracteres)</span>
                        <button className="primary-button" type="submit" disabled={(!continuationText.trim() && !selectedInstructionFile && !reuseInstructionFileId) || activeExecution || continuationBusy || executionStarting || instructionFileBusy}>
                          {continuationBusy || executionStarting ? "Preparando..." : "Enviar instrucción"} <span>↗</span>
                        </button>
                      </div>
                    </form>
                  )}
                </section>

                <details className="factory-technical-audit">
                  <summary>
                    <span className="audit-summary-title">Ver toda la evidencia técnica y configuración de la ejecución</span>
                    <span className="audit-summary-caption">Sesiones, estados, permisos, logs originales, pruebas, handoffs, hashes, aprobaciones e informes completos</span>
                  </summary>
                  <div className="factory-technical-audit-content">
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
                {activityMonitoringPanel}
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
                    {execution.run.summary.approvals && (
                      <div className="summary-integrity summary-approvals">
                        <div className="summary-integrity-heading">
                          <strong>Trazabilidad de decisiones y aprobaciones</strong>
                          <span>{execution.run.summary.approvals.recordedDecisions + execution.run.summary.approvals.recordedApprovalEvents > 0 ? "REGISTRO DISPONIBLE" : "SIN SOLICITUDES"}</span>
                        </div>
                        <div className="summary-integrity-metrics">
                          <span>{execution.run.summary.approvals.recordedDecisions} decisiones formales</span>
                          <span>{execution.run.summary.approvals.recordedApprovalEvents} eventos de aprobación/revisión</span>
                          <span>{execution.run.summary.approvals.approved} aprobadas</span>
                          <span>{execution.run.summary.approvals.rejected} rechazadas</span>
                          <span>{execution.run.summary.approvals.answered} aclaraciones respondidas</span>
                          <span>{execution.run.summary.approvals.automaticApprovals} autorizaciones temporales aplicadas automáticamente</span>
                        </div>
                        {(execution.run.summary.approvals.pending > 0 || execution.run.summary.approvals.orphaned > 0) && (
                          <p>
                            <strong>Atención:</strong> {execution.run.summary.approvals.pending} pendientes ·
                            {execution.run.summary.approvals.orphaned} solicitudes huérfanas.
                          </p>
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
                        ) : <p className="summary-muted">No se pudieron extraer hallazgos separados; consulta los informes completos de los especialistas.</p>}
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
                      ? "Se publicará cuando terminen los especialistas, con o sin árbitro técnico."
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
                                      {" · "}{assignment.permissionMode === "automatic"
                                        ? "AUTOMÁTICO · configurado " + assignment.permissionProfile
                                        : assignment.permissionMode === "manual"
                                          ? "MANUAL · " + assignment.permissionProfile
                                          : "PERFIL HISTÓRICO · " + assignment.permissionProfile}
                                      {(() => {
                                        const effective = matchingRound.run.configurationSnapshot?.permissionResolution
                                          ?.find((item) => item.agentId === assignment.agentId);
                                        return effective ? " · efectivo " + effective.effectiveProfile : "";
                                      })()}
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

                  </section>
                )}
                <div className="execution-run-meta">
                  <span>Inicio: {new Date(execution.run.startedAt).toLocaleString("es-CO")}</span>
                  <span>Última actualización: {new Date(execution.run.updatedAt).toLocaleString("es-CO")}</span>
                </div>
              </div>
                  </div>
                </details>
              </>
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


type EngineActivityPanelProps = {
  engine: EngineId;
  execution: ExecutionData;
  roleNames: Record<string, string>;
  statusLabels: Record<string, string>;
};

function describeEngineActivity(message: string, kind: string): {
  type: "output" | "tool" | "status" | "warning";
  title: string;
  detail?: string;
  state?: string;
} {
  if (message.startsWith("TOOL ")) {
    const toolName = message.slice(5).split(" · ")[0]?.trim() || "herramienta";
    const lower = toolName.toLowerCase();
    const title = lower.includes("list_files") ? "Explorando la estructura del proyecto"
      : lower.includes("read_file") ? "Consultando archivos del proyecto"
      : lower.includes("search_text") || lower.includes("grep") ? "Buscando referencias en el código"
      : lower.includes("shell") || lower.includes("bash") ? "Ejecutando un comando autorizado"
      : lower.includes("edit") || lower.includes("write") ? "Trabajando sobre un archivo"
      : lower.includes("test") ? "Ejecutando verificaciones"
      : "Utilizando una herramienta de trabajo";
    const statusMatch = message.match(/ · (running|completed|success|error|failed|pending|in_progress|en ejecución)\b/i);
    const state = statusMatch?.[1]?.toLowerCase();
    return {
      type: "tool",
      title,
      state: state === "completed" || state === "success" ? "Completado"
        : state === "error" || state === "failed" ? "Con error"
        : state === "pending" ? "Pendiente"
        : "En curso",
      detail: message
    };
  }
  if (/Comienza la fase\./i.test(message)) {
    return { type: "status", title: "El especialista comenzó a trabajar.", detail: message };
  }
  if (/Fase .* terminada\./i.test(message)) {
    return { type: "status", title: "El especialista terminó su intervención.", detail: message };
  }
  if (/Sesión OpenCode creada|Sesión Claude Code:/i.test(message)) {
    return { type: "status", title: "La sesión de trabajo está preparada.", detail: message };
  }
  if (/inicializó el contexto de trabajo/i.test(message)) {
    return { type: "status", title: "Preparó el contexto y las herramientas de trabajo.", detail: message };
  }
  if (/MCP factory_filesystem conectado/i.test(message)) {
    return { type: "status", title: "El acceso seguro al proyecto está listo.", detail: message };
  }
  if (/se espera la conexión del MCP|se espera antes de iniciar sesiones/i.test(message)) {
    return { type: "status", title: "Preparando las herramientas seguras del proyecto.", detail: message };
  }
  if (/Bloqueo del perfil|Bloqueo de aislamiento|se rechazó la escritura/i.test(message)) {
    return { type: "warning", title: "Una operación fue detenida por las reglas de seguridad.", detail: message };
  }
  if (/Claude SDK:|error interno|no fue posible|no se pudo/i.test(message) || kind === "warning") {
    return { type: "warning", title: "El motor informó una incidencia que requiere revisión.", detail: message };
  }
  if (kind === "success") {
    return { type: "output", title: message };
  }
  return { type: "status", title: message.length > 220 ? message.slice(0, 217) + "…" : message, detail: message };
}

function EngineActivityPanel({ engine, execution, roleNames, statusLabels }: EngineActivityPanelProps) {
  const agentRuns = execution.agents.filter((agent) => agent.engine === engine);
  const agentRunIds = new Set(agentRuns.map((agent) => agent.id));
  const events = execution.events.filter((event) =>
    (event.agentRunId !== null && agentRunIds.has(event.agentRunId)) ||
    (engine === "opencode" && event.agentRunId === null && event.area === "OPENCODE-SERVER")
  );
  const isActive = agentRuns.some((agent) => ["queued", "running", "waiting"].includes(agent.status));
  const isWaiting = agentRuns.some((agent) => agent.status === "waiting");
  const allSucceeded = agentRuns.length > 0 && agentRuns.every((agent) => agent.status === "succeeded");
  const title = engine === "opencode" ? "OpenCode" : "Claude Code";
  const status = agentRuns.length === 0 ? "Sin agentes en esta ronda"
    : isWaiting ? "Esperando tu decisión"
    : isActive ? "Trabajando"
    : allSucceeded ? "Trabajo completado"
    : agentRuns.some((agent) => agent.status === "failed") ? "Requiere revisión"
    : "Ronda finalizada";
  const visibleEvents = events.slice(-36);

  return (
    <section className={"engine-console engine-console-" + engine} aria-label={"Actividad real de " + title}>
      <header className="engine-console-header">
        <div className="engine-console-brand">
          <span className="engine-console-mark">{engine === "opencode" ? "O" : "C"}</span>
          <div>
            <strong>{title}</strong>
            <span>{agentRuns.length} especialista(s) asignado(s)</span>
          </div>
        </div>
        <span className={"engine-console-state " + (isActive ? "is-running" : allSucceeded ? "is-success" : "is-idle")}>
          <span />{status}
        </span>
      </header>

      <div className="engine-console-agents">
        {agentRuns.length > 0 ? agentRuns.map((agent) => (
          <span
            className={"engine-agent-chip engine-agent-" + agent.status}
            key={agent.id}
            title={title + " · " + agent.modelId + " · " + agent.permissionProfile}
          >
            {roleNames[agent.agentId] ?? agent.agentId}
            <small>{statusLabels[agent.status] ?? agent.status}</small>
          </span>
        )) : (
          <span className="engine-no-agents">Este motor no tiene especialistas asignados en esta ronda.</span>
        )}
      </div>

      <div className="engine-terminal-screen" aria-live="polite">
        <div className="engine-terminal-toolbar">
          <span className="engine-terminal-lights"><i /><i /><i /></span>
          <span>{engine === "opencode" ? "opencode" : "claude"} · salida de sesión</span>
          <span className="engine-terminal-live">{isActive ? "LIVE" : "LOG"}</span>
        </div>
        <div className="engine-terminal-events">
          {visibleEvents.length === 0 && (
            <div className="engine-terminal-placeholder">
              <span>{agentRuns.length ? "Sesión preparada." : "Sin actividad para este motor."}</span>
              <span>{isActive ? "Esperando los primeros eventos de los especialistas…" : "La actividad de esta ronda aparecerá aquí."}</span>
            </div>
          )}
          {visibleEvents.map((event) => {
            const agent = event.agentRunId ? agentRuns.find((item) => item.id === event.agentRunId) : undefined;
            const presentation = describeEngineActivity(event.message, event.kind);
            return (
              <article className={"engine-event engine-event-" + presentation.type} key={event.id}>
                <div className="engine-event-meta">
                  <span>{agent ? (roleNames[agent.agentId] ?? agent.agentId) : title}</span>
                  <time>{new Date(event.createdAt).toLocaleTimeString("es-CO", { hour12: false })}</time>
                </div>
                {presentation.type === "output" ? (
                  <>
                    <div className="engine-event-output">
                      {presentConversationalText(presentation.title.length > 520 ? presentation.title.slice(0, 520).trimEnd() + "…" : presentation.title)}
                    </div>
                    {presentation.title.length > 520 && (
                      <details className="engine-event-detail">
                        <summary>Ver respuesta completa del motor</summary>
                        <pre>{presentation.title}</pre>
                      </details>
                    )}
                  </>
                ) : (
                  <div className="engine-event-summary">
                    <span className="engine-event-symbol">
                      {presentation.type === "tool" ? "›" : presentation.type === "warning" ? "!" : "•"}
                    </span>
                    <strong>{presentation.title}</strong>
                    {presentation.state && <span className="engine-tool-state">{presentation.state}</span>}
                  </div>
                )}
                {presentation.detail && (
                  <details className="engine-event-detail">
                    <summary>{presentation.type === "tool" ? "Ver operación y parámetros" : "Ver registro original"}</summary>
                    <pre>{presentation.detail}</pre>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      </div>
      <footer className="engine-console-footer">
        <span>{events.length} eventos capturados</span>
        <span>{agentRuns.filter((agent) => agent.status === "succeeded").length}/{agentRuns.length} especialistas completados</span>
      </footer>
    </section>
  );
}


function presentConversationalText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\x60([^\x60]+)\x60/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^(\s*)\d+\.\s+/gm, "$1• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
