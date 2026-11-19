import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactoryAssets, mergeAssignments } from "./factory.js";
import {
  addWorkMessage, consumeProjectPreflight, createWorkThread, databaseInfo, decideProjectPreflight,
  getClaudeProviderPreference, getExecutionAgentHandoffOutput, getProjectPreferences, getProjectPreflight,
  getWorkThreadSnapshot, listAssignments, listFavoriteModels, recordProjectPreflight, saveAssignments,
  saveClaudeProviderPreference, saveFavoriteModels, saveProjectPreferences, synchronizeConfiguredClaudeModel,
  updateWorkThreadStatus,
  type AgentAssignment, type ClaudeProviderId, type EngineId, type FavoriteModel, type ModelTier, type PermissionMode, type PermissionProfile,
  type WorkThreadSnapshot
} from "./database.js";
import { getClaudeModels, getDetectedClaudeProvider, getEngineVersion, getOpenCodeModels, readClaudeLocalConfig, listModels } from "./models.js";
import { analyzeProject } from "./projects.js";
import { cancelExecution, getExecution, getLatestExecution, recoverExecutionState, respondExecutionDecision, startExecution } from "./execution.js";
import { compareRuntimeBuilds, parseRuntimeBuildInfo } from "./runtime-build.js";
import { CONTROL_CENTER_SECURITY_HEADERS, inspectRequestSecurity } from "./request-security.js";
import { workInstructionLimitError } from "./work-instruction-limit.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(process.env.FACTORY_ROOT || resolve(currentDir, "../../.."));
const buildInfoPath = join(currentDir, "build-info.json");

function readBuildInfoFromDisk() {
  try {
    return parseRuntimeBuildInfo(readFileSync(buildInfoPath, "utf8"));
  } catch {
    return null;
  }
}

// Capture what this process loaded once. The health endpoint compares this
// immutable startup fingerprint with the artifact currently present on disk.
const runtimeBuildInfo = readBuildInfoFromDisk();
const host = "127.0.0.1";
const port = Number(process.env.FACTORY_API_PORT || 4141);

function findNonFavoriteAssignment(assignments: AgentAssignment[]): AgentAssignment | undefined {
  const activeClaudeProvider = getClaudeProviderPreference();
  const favoriteKeys = new Set(
    listFavoriteModels()
      .filter((favorite) => favorite.provider === (favorite.engine === "claude" ? activeClaudeProvider : "opencode"))
      .map((favorite) => `${favorite.engine}|${favorite.modelId}`)
  );
  return assignments.find((item) => !favoriteKeys.has(`${item.engine}|${item.modelId}`));
}

async function synchronizeConfiguredClaudeModelAtStartup(): Promise<void> {
  try {
    const config = await readClaudeLocalConfig();
    saveClaudeProviderPreference(config.provider);
    if (!config.model) return;
    const models = await getClaudeModels(config.provider);
    const configured = models.find((item) => item.source === "detected");
    if (!configured) return;
    const result = synchronizeConfiguredClaudeModel(config.provider, configured.id, models.map((item) => item.id));
    if (result.assignmentsUpdated || result.favoritesUpdated) {
      console.info(
        `[Factory Control Center] Claude provider/model synchronized: ${config.provider} / ${configured.id}; ${result.assignmentsUpdated} assignments and ${result.favoritesUpdated} favorites updated.`
      );
    }
  } catch {
    // No local Claude settings file: retain the provider preference and OAuth fallback.
  }
}

await synchronizeConfiguredClaudeModelAtStartup();
recoverExecutionState();

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
  trustProxy: false
});

await app.register(cors, {
  origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
  methods: ["GET", "POST", "PUT", "OPTIONS"]
});

// The service is a local control plane, not a public web API. Reject hostile
// browser origins and DNS-rebinding fetches before any route can mutate state.
app.addHook("onRequest", async (request, reply) => {
  const security = inspectRequestSecurity({
    origin: request.headers.origin,
    secFetchSite: request.headers["sec-fetch-site"]
  });
  if (!security.allowed) {
    return reply.code(403).send({ error: security.reason ?? "Solicitud no autorizada." });
  }
});

app.addHook("onSend", async (_request, reply, payload) => {
  for (const [name, value] of Object.entries(CONTROL_CENTER_SECURITY_HEADERS)) {
    reply.header(name, value);
  }
  return payload;
});

app.get("/api/health", async () => {
  const build = compareRuntimeBuilds(runtimeBuildInfo, readBuildInfoFromDisk(), process.env.NODE_ENV ?? "development");
  return {
    status: build.status,
    service: "Factory Control Center API",
    factoryRoot,
    database: databaseInfo.engine,
    build
  };
});

app.get("/api/engines", async () => {
  const [openCodeVersion, claudeVersion] = await Promise.all([
    getEngineVersion("opencode"),
    getEngineVersion("claude")
  ]);

  return {
    engines: [
      { id: "opencode", name: "OpenCode", available: openCodeVersion !== null, version: openCodeVersion },
      { id: "claude", name: "Claude Code", available: claudeVersion !== null, version: claudeVersion }
    ]
  };
});

app.get("/api/mcps", async () => {
  const configPath = join(factoryRoot, "opencode.json");
  if (!existsSync(configPath)) return { configFound: false, servers: [] };

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp?: { servers?: Record<string, unknown> };
    };
    const entries = config.mcp?.servers && typeof config.mcp.servers === "object"
      ? Object.entries(config.mcp.servers)
      : [];
    const servers = entries.map(([name, value]) => {
      const server = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        name,
        transport: server.type === "remote" ? "Remoto" as const : "Local" as const,
        enabled: server.enabled !== false
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return { configFound: true, servers };
  } catch {
    return { configFound: false, servers: [] };
  }
});

app.get<{ Params: { engine: string } }>("/api/models/:engine", async (request, reply) => {
  const engine = request.params.engine;
  if (engine !== "opencode" && engine !== "claude") {
    return reply.code(400).send({ error: "Motor no válido. Usa 'opencode' o 'claude'." });
  }

  try {
    const provider = engine === "claude"
      ? await getDetectedClaudeProvider(getClaudeProviderPreference())
      : getClaudeProviderPreference();
    const models = await listModels(engine as EngineId, provider);
    return { engine, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(503).send({ engine, models: [], error: message });
  }
});

app.post("/api/providers/claude/synchronize-model", async (request, reply) => {
  try {
    const config = await readClaudeLocalConfig();
    const provider = config.provider;
    saveClaudeProviderPreference(provider);
    if (!config.model) {
      return { synchronized: false, provider, assignmentsUpdated: 0, favoritesUpdated: 0 };
    }
    const models = await getClaudeModels(provider);
    const configured = models.find((item) => item.source === "detected");
    if (!configured) {
      return reply.code(409).send({ error: "No se detectó un modelo válido en ~/.claude/settings.json." });
    }
    const result = synchronizeConfiguredClaudeModel(provider, configured.id, models.map((item) => item.id));
    return { synchronized: true, provider, modelId: configured.id, ...result };
  } catch {
    return { synchronized: false, provider: getClaudeProviderPreference(), assignmentsUpdated: 0, favoritesUpdated: 0 };
  }
});

app.get("/api/providers/claude", async () => {
  const selectedProvider = await getDetectedClaudeProvider(getClaudeProviderPreference());
  let config: Awaited<ReturnType<typeof readClaudeLocalConfig>> | null = null;
  try { config = await readClaudeLocalConfig(); } catch { /* Configuración local no disponible */ }
  return {
    selectedProvider,
    configured: Boolean(config?.baseUrl && config?.hasCredential && config?.model && config.endpointCompatible),
    endpointCompatible: config?.endpointCompatible ?? false,
    baseUrl: config?.baseUrl ?? "",
    model: config?.model ?? "",
    credentialDetected: Boolean(config?.hasCredential),
    providers: [
      { id: "apmix", name: "APMix", baseUrl: "https://api.apmix.ai", protocol: "Anthropic Messages API" },
      { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/inference/go/anthropic", protocol: "Anthropic Messages API" },
      { id: "anthropic", name: "Anthropic oficial", baseUrl: "https://api.anthropic.com", protocol: "Anthropic Messages API" }
    ],
    runtimeConnected: false,
    credentialsModified: false
  };
});

app.put<{ Body: { provider?: unknown } }>("/api/providers/claude", async (request, reply) => {
  const provider = request.body?.provider;
  if (provider !== "apmix" && provider !== "anthropic" && provider !== "opencode-go") {
    return reply.code(400).send({ error: "Proveedor no válido. Usa APMix, OpenCode Go o Anthropic." });
  }
  saveClaudeProviderPreference(provider as ClaudeProviderId);
  return {
    saved: true,
    selectedProvider: provider,
    runtimeConnected: false,
    credentialsModified: false,
    message: "Preferencia guardada localmente. No se modificaron credenciales ni settings de Claude Code."
  };
});

app.get("/api/favorites", async () => ({ favorites: listFavoriteModels() }));

app.put<{ Body: { favorites?: unknown } }>("/api/favorites", async (request, reply) => {
  if (!Array.isArray(request.body?.favorites)) return reply.code(400).send({ error: "Se esperaba un arreglo favorites." });
  const normalized: FavoriteModel[] = [];
  const seen = new Set<string>();
  for (const row of request.body.favorites) {
    if (!row || typeof row !== "object") return reply.code(400).send({ error: "Favorito inválido." });
    const item = row as Record<string, unknown>;
    const engine = item.engine;
    const provider = String(item.provider ?? "");
    const modelId = String(item.modelId ?? "");
    const tier = item.tier;
    if ((engine !== "opencode" && engine !== "claude") ||
        (engine === "claude" && provider !== "apmix" && provider !== "anthropic" && provider !== "opencode-go") ||
        (engine === "opencode" && provider !== "opencode") ||
        !modelId || modelId.length > 200 ||
        !["economy", "balanced", "premium"].includes(String(tier))) {
      return reply.code(400).send({ error: "Un favorito contiene motor, proveedor, modelo o nivel inválido." });
    }
    const key = [engine, provider, modelId].join("|");
    if (seen.has(key)) return reply.code(400).send({ error: "Hay modelos favoritos duplicados." });
    seen.add(key);
    normalized.push({ engine, provider, modelId, tier: tier as ModelTier });
  }
  const grouped = new Map<string, Set<string>>();
  for (const engine of ["opencode", "claude"] as const) {
    const provider = engine === "claude" ? getClaudeProviderPreference() : "opencode";
    const rows = normalized.filter((item) => item.engine === engine && item.provider === provider);
    if (!rows.length) continue;
    const ids = new Set((await listModels(engine, getClaudeProviderPreference())).map((model) => model.id));
    const invalid = rows.find((item) => !ids.has(item.modelId));
    if (invalid) return reply.code(400).send({ error: `El modelo favorito ${invalid.modelId} no está en el catálogo actual de ${provider}.` });
  }
  saveFavoriteModels(normalized);
  return { saved: normalized.length, favorites: normalized };
});


function openDirectoryDialog(initialPath?: string): Promise<string | null> {
  return new Promise((resolveSelection, reject) => {
    const args = [
      "--file-selection",
      "--directory",
      "--title=Seleccionar carpeta del proyecto"
    ];
    if (initialPath) args.push("--filename=" + initialPath + "/");

    const child = spawn("zenity", args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("El selector de carpetas superó el tiempo permitido."));
    }, 180000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 8192) {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error("La ruta seleccionada excede el tamaño permitido."));
      }
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(new Error(error.code === "ENOENT"
        ? "No se encontró el selector nativo de carpetas (zenity)."
        : "No fue posible abrir el selector nativo de carpetas."));
    });

    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const selected = output.trim();
        if (!selected || !isAbsolute(selected)) {
          reject(new Error("El selector no devolvió una ruta absoluta válida."));
          return;
        }
        resolveSelection(resolve(selected));
      } else if (code === 1 || code === 5) {
        resolveSelection(null);
      } else {
        reject(new Error("El selector nativo de carpetas no pudo completarse."));
      }
    });
  });
}

app.post<{ Body: { currentPath?: unknown } }>("/api/projects/select-directory", async (request, reply) => {
  let initialPath: string | undefined;
  const candidate = request.body?.currentPath;
  if (typeof candidate === "string" && candidate.length <= 4096 && isAbsolute(candidate) && existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) initialPath = resolve(candidate);
    } catch {
      // Si la ruta actual ya no existe o no es accesible, el selector abre en la ubicación predeterminada.
    }
  }

  try {
    const selected = await openDirectoryDialog(initialPath);
    return selected ? { path: selected, cancelled: false } : { path: null, cancelled: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No fue posible seleccionar la carpeta.";
    return reply.code(503).send({ error: message });
  }
});

app.get("/api/project-preferences", async () => getProjectPreferences());

app.get("/api/projects/preflight", async () => {
  const preferences = getProjectPreferences();
  return { preflight: getProjectPreflight(preferences.path) };
});

app.post<{ Body: { path?: unknown; depth?: unknown; decision?: unknown } }>(
  "/api/projects/preflight/decision",
  async (request, reply) => {
    const path = typeof request.body?.path === "string" ? request.body.path : "";
    const depth = request.body?.depth;
    const decision = request.body?.decision;
    if (!path.trim() || !["quick", "focused", "deep"].includes(String(depth))) {
      return reply.code(400).send({ error: "La ruta y la profundidad deben coincidir con la preconsulta." });
    }
    if (decision !== "accepted" && decision !== "manual") {
      return reply.code(400).send({ error: "La decisión debe ser accepted o manual." });
    }
    const saved = decideProjectPreflight(path, String(depth), decision);
    if (!saved) {
      return reply.code(409).send({ error: "No existe una preconsulta vigente para esta ruta y profundidad. Vuelve a analizar el proyecto." });
    }
    return { saved: true, decision };
  }
);

app.get("/api/factory/assets", async () => loadFactoryAssets(factoryRoot));

app.get("/api/assignments", async () => {
  const assets = await loadFactoryAssets(factoryRoot);
  const persisted = listAssignments();
  return {
    assignments: mergeAssignments(assets.agents, persisted),
    saved: persisted.length === assets.agents.length
  };
});

app.put<{ Body: { assignments?: unknown } }>("/api/assignments", async (request, reply) => {
  const input = request.body?.assignments;
  if (!Array.isArray(input)) {
    return reply.code(400).send({ error: "Se esperaba un arreglo 'assignments'." });
  }

  const assets = await loadFactoryAssets(factoryRoot);
  const knownAgents = new Set(assets.agents.map((agent) => agent.id));
  const normalized: AgentAssignment[] = [];
  const seenAgents = new Set<string>();

  for (const row of input) {
    if (!row || typeof row !== "object") {
      return reply.code(400).send({ error: "Una asignación tiene formato inválido." });
    }
    const item = row as Record<string, unknown>;
    const agentId = String(item.agentId ?? "");
    const engine = item.engine;
    const modelId = String(item.modelId ?? "");
    const permissionMode = item.permissionMode ?? "automatic";
    const permissionProfile = item.permissionProfile;
    const enabled = item.enabled;

    if (!knownAgents.has(agentId)) {
      return reply.code(400).send({ error: `Agente desconocido: ${agentId}` });
    }
    if (seenAgents.has(agentId)) {
      return reply.code(400).send({ error: `Agente duplicado: ${agentId}` });
    }
    seenAgents.add(agentId);
    if (engine !== "opencode" && engine !== "claude") {
      return reply.code(400).send({ error: `Motor inválido para ${agentId}.` });
    }
    if (!modelId || modelId.length > 200) {
      return reply.code(400).send({ error: `Modelo inválido para ${agentId}.` });
    }
    if (permissionMode !== "automatic" && permissionMode !== "manual") {
      return reply.code(400).send({ error: `Modo de permisos inválido para ${agentId}.` });
    }
    if (!["read-only", "workspace-write", "approval-required"].includes(String(permissionProfile))) {
      return reply.code(400).send({ error: `Perfil de permisos inválido para ${agentId}.` });
    }
    if (typeof enabled !== "boolean") {
      return reply.code(400).send({ error: `Estado enabled inválido para ${agentId}.` });
    }

    normalized.push({
      agentId,
      engine: engine as EngineId,
      modelId,
      permissionMode: permissionMode as PermissionMode,
      permissionProfile: permissionProfile as PermissionProfile,
      enabled
    });
  }

  if (normalized.length !== assets.agents.length) {
    return reply.code(400).send({ error: "Envía exactamente una asignación por cada agente de la fábrica." });
  }

  // La fábrica solo permite asignar modelos guardados como favoritos del motor/proveedor activo.
  const nonFavorite = findNonFavoriteAssignment(normalized);
  if (nonFavorite) {
    return reply.code(400).send({
      error: `El modelo "${nonFavorite.modelId}" asignado a ${nonFavorite.agentId} no está marcado como favorito. Solo se permiten modelos favoritos.`
    });
  }

  // Impide guardar IDs de modelo de otro motor o modelos que no figuran en su catálogo actual.
  for (const engine of ["opencode", "claude"] as const) {
    const selected = normalized.filter((item) => item.engine === engine);
    if (selected.length === 0) continue;
    try {
      const availableModels = new Set((await listModels(engine, getClaudeProviderPreference())).map((model) => model.id));
      const invalid = selected.find((item) => !availableModels.has(item.modelId));
      if (invalid) {
        return reply.code(400).send({
          error: `El modelo "${invalid.modelId}" no pertenece al catálogo disponible de ${engine}.`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(503).send({ error: message });
    }
  }

  saveAssignments(normalized);
  return { saved: normalized.length, assignments: normalized };
});

app.post<{ Body: { path?: string; depth?: string } }>("/api/projects/analyze", async (request, reply) => {
  const projectPath = request.body?.path;
  const depth = request.body?.depth;
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    return reply.code(400).send({ error: "Indica la ruta absoluta del proyecto." });
  }
  if (!["quick", "focused", "deep"].includes(String(depth))) {
    return reply.code(400).send({ error: "Selecciona una profundidad de preconsulta válida." });
  }

  try {
    const analysis = await analyzeProject(projectPath, depth as "quick" | "focused" | "deep");
    // Persist only the canonical project path. Work instructions belong to chat.
    saveProjectPreferences(analysis.path, "");
    const current = listAssignments();
    const favorites = listFavoriteModels().filter((item) =>
      item.provider === (item.engine === "claude" ? getClaudeProviderPreference() : "opencode")
    );
    const roleTierByDifficulty: Record<string, Record<string, ModelTier[]>> = {
      low: {
        build: ["balanced", "economy", "premium"], architect: ["balanced", "premium", "economy"],
        implementer: ["economy", "balanced", "premium"], reviewer: ["economy", "balanced", "premium"],
        tester: ["economy", "balanced", "premium"], "cloud-arbiter": ["premium", "balanced", "economy"],
        reverse: ["balanced", "economy", "premium"]
      },
      medium: {
        build: ["balanced", "premium", "economy"], architect: ["premium", "balanced", "economy"],
        implementer: ["balanced", "premium", "economy"], reviewer: ["balanced", "premium", "economy"],
        tester: ["balanced", "economy", "premium"], "cloud-arbiter": ["premium", "balanced", "economy"],
        reverse: ["balanced", "premium", "economy"]
      },
      high: {
        build: ["premium", "balanced", "economy"], architect: ["premium", "balanced", "economy"],
        implementer: ["premium", "balanced", "economy"], reviewer: ["premium", "balanced", "economy"],
        tester: ["balanced", "premium", "economy"], "cloud-arbiter": ["premium", "balanced", "economy"],
        reverse: ["balanced", "premium", "economy"]
      },
      "very-high": {
        build: ["premium", "balanced", "economy"], architect: ["premium", "balanced", "economy"],
        implementer: ["premium", "balanced", "economy"], reviewer: ["premium", "balanced", "economy"],
        tester: ["balanced", "premium", "economy"], "cloud-arbiter": ["premium", "balanced", "economy"],
        reverse: ["balanced", "premium", "economy"]
      }
    };
    const rolePreference: Record<string, EngineId[]> = {
      build: ["opencode", "claude"], architect: ["claude", "opencode"],
      implementer: ["opencode", "claude"], reviewer: ["claude", "opencode"],
      tester: ["opencode", "claude"], "cloud-arbiter": ["claude", "opencode"],
      reverse: ["opencode", "claude"]
    };
    const selectedAgents = new Set(analysis.projectPlan.recommendedAgents);
    const recommendationDifficulty = analysis.complexity.level === "very-high"
      ? "high"
      : analysis.complexity.level;
    const suggestedAssignments = current.map((assignment) => {
      const preferredTier = roleTierByDifficulty[recommendationDifficulty]?.[assignment.agentId] ?? ["balanced", "premium", "economy"];
      const prefs = rolePreference[assignment.agentId] ?? ["opencode", "claude"];
      const candidates = favorites.slice().sort((a, b) => {
        const tierDiff = preferredTier.indexOf(a.tier) - preferredTier.indexOf(b.tier);
        if (tierDiff !== 0) return tierDiff;
        const engineDiff = prefs.indexOf(a.engine) - prefs.indexOf(b.engine);
        if (engineDiff !== 0) return engineDiff;
        return a.modelId.localeCompare(b.modelId);
      });
      const chosen = candidates[0];
      return chosen
        ? { ...assignment, engine: chosen.engine, modelId: chosen.modelId, enabled: selectedAgents.has(assignment.agentId) }
        : { ...assignment, enabled: selectedAgents.has(assignment.agentId) };
    });
    const response = {
      ...analysis,
      suggestedAssignments,
      recommendationReady: favorites.length > 0,
      recommendationMessage: favorites.length
        ? "Preconsulta " + analysis.projectPlan.depth + ": " + analysis.projectPlan.recommendedAgents.length + " agentes recomendados por el tamaño y la arquitectura del proyecto, usando exclusivamente tus modelos favoritos activos."
        : "Aún no hay modelos favoritos. Configúralos para activar la asignación automática."
    };
    recordProjectPreflight(analysis.path, analysis.projectPlan.depth, response as unknown as Record<string, unknown>);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: message });
  }
});

function buildContinuityContext(workflow: WorkThreadSnapshot): string {
  const sections: string[] = [
    "PROCESO PRINCIPAL: " + workflow.thread.id,
    "PROYECTO: " + workflow.thread.projectPath,
    "OBJETIVO ORIGINAL (no reemplazar):",
    workflow.thread.objective,
    "",
    "HISTORIAL CONVERSACIONAL PERSISTIDO:"
  ];
  const messages = workflow.messages.slice(-24);
  for (const message of messages) {
    sections.push(
      "[" + message.createdAt + " · ronda " + message.roundNumber + " · " + message.role + " · " + message.kind + "]",
      message.content
    );
  }
  sections.push("", "RESULTADOS DE RONDAS ANTERIORES:");
  for (const round of workflow.rounds.slice(-4)) {
    sections.push(
      "RONDA " + round.run.roundNumber + " · " + round.run.status +
      " · ejecución " + round.run.id,
      "Instrucción: " + round.run.instructions
    );
    if (round.run.summary) {
      sections.push(
        "Resumen: " + round.run.summary.headline,
        round.run.summary.overview,
        "Hallazgos: " + round.run.summary.findings.join(" | "),
        "Próximos pasos: " + round.run.summary.nextSteps.join(" | ")
      );
    }
    sections.push("CONFIGURACIÓN HISTÓRICA DE ESTA RONDA:");
    if (round.run.configurationSnapshot) {
      sections.push(
        "Capturada: " + round.run.configurationSnapshot.capturedAt,
        "Proveedor Claude: " + round.run.configurationSnapshot.claudeProvider,
        "Favoritos: " + round.run.configurationSnapshot.favorites.map((item) =>
          item.engine + "/" + item.modelId + " (" + item.tier + ")"
        ).join(", "),
        "Huella Skill: " + (round.run.configurationSnapshot.workflowSkillDigest ?? "no disponible"),
        "Huellas SHA-256 de instrucciones usadas: " + Object.entries(round.run.configurationSnapshot.roleInstructionDigests)
          .map(([agentId, digest]) => agentId + "=" + digest).join(", "),
        "Asignaciones efectivas: " + round.run.configurationSnapshot.assignments.map((item) =>
          item.agentId + "=" + (item.enabled ? item.engine + "/" + item.modelId : "disabled") +
          "/" + item.permissionProfile
        ).join(", ")
      );
    }
    sections.push("DECISIONES Y APROBACIONES REGISTRADAS:");
    for (const decision of round.decisionHistory) {
      sections.push(
        decision.createdAt + " · " + decision.engine + " · " + decision.kind +
        " · " + decision.status + " · " + decision.title +
        (decision.response ? " · respuesta: " + decision.response : "")
      );
    }
    sections.push("Participación y configuración histórica:");
    for (const agent of round.agents) {
      sections.push(
        agent.agentId + " · " + agent.engine + " · " + agent.modelId + " · " + agent.status +
        " · permisos " + agent.permissionProfile +
        " · sesión " + (agent.sessionId ?? "no disponible") +
        " · handoffs recibidos " + agent.handoffIn.map((item) => item.id).join(", ") +
        " · handoffs emitidos " + agent.handoffOut.map((item) => item.id).join(", ")
      );
    }
    const relevantEvents = round.events.filter((event) =>
      event.kind === "success" &&
      !["ORCHESTRATOR", "HANDOFF", "EXECUTIVE-SUMMARY", "PLANNER"].includes(event.area)
    );
    const perAgent = new Map<string, string[]>();
    for (const event of relevantEvents) {
      const items = perAgent.get(event.area) ?? [];
      items.push(event.message);
      perAgent.set(event.area, items);
    }
    for (const [agent, outputs] of perAgent) {
      sections.push("EVIDENCIA DEL AGENTE " + agent + ":");
      for (const output of outputs.slice(-2)) sections.push(output.slice(0, 1800));
    }
    sections.push("---");
  }
  const full = sections.join("\n");
  // Keep the most recent conversation and evidence while retaining the original objective.
  if (full.length <= 26000) return full;
  const header = sections.slice(0, 5).join("\n") + "\n[Se conserva el objetivo original; parte del historial antiguo queda disponible en el registro persistente.]\n";
  return header + full.slice(-(26000 - header.length));
}

function presentWorkThread(workflow: WorkThreadSnapshot): WorkThreadSnapshot {
  return {
    thread: workflow.thread,
    messages: workflow.messages,
    rounds: workflow.rounds.map((round) => ({
      ...round,
      run: { ...round.run, continuityContext: "" },
      events: round.events.slice(-60).map((event) => ({ ...event, message: event.message.slice(0, 2200) })),
      decisions: []
    }))
  };
}

app.get<{ Params: { threadId: string } }>("/api/work-threads/:threadId", async (request, reply) => {
  const workflow = getWorkThreadSnapshot(request.params.threadId);
  if (!workflow) return reply.code(404).send({ error: "Proceso de trabajo no encontrado." });
  return { workflow: presentWorkThread(workflow) };
});

app.get("/api/executions/latest", async () => ({
  execution: getLatestExecution()
}));

app.get<{ Params: { runId: string; agentRunId: string } }>(
  "/api/executions/:runId/agents/:agentRunId/handoff-output",
  async (request, reply) => {
    const handoffOutput = getExecutionAgentHandoffOutput(request.params.runId, request.params.agentRunId);
    if (!handoffOutput) return reply.code(404).send({ error: "El informe del agente no está disponible." });
    return { handoffOutput };
  }
);

app.get<{ Params: { runId: string } }>("/api/executions/:runId", async (request, reply) => {
  const execution = getExecution(request.params.runId);
  if (!execution) return reply.code(404).send({ error: "Ejecución no encontrada." });
  return { execution };
});

app.post<{ Body: { path?: unknown; instructions?: unknown; preflightDepth?: unknown; taskDepth?: unknown } }>("/api/executions", async (request, reply) => {
  const projectPath = typeof request.body?.path === "string" ? request.body.path.trim() : getProjectPreferences().path;
  const rawInstructions = typeof request.body?.instructions === "string"
    ? request.body.instructions : getProjectPreferences().instructions;
  const limitError = workInstructionLimitError(rawInstructions);
  if (limitError) return reply.code(400).send({ error: limitError });
  const instructions = rawInstructions.trim();
  if (!projectPath || !isAbsolute(projectPath)) {
    return reply.code(400).send({ error: "Selecciona una ruta absoluta para el proyecto." });
  }
  if (!instructions) {
    return reply.code(400).send({ error: "Escribe las instrucciones que deben ejecutar los agentes." });
  }
  const preflightDepth = request.body?.preflightDepth;
  if (!["quick", "focused", "deep"].includes(String(preflightDepth))) {
    return reply.code(400).send({ error: "La profundidad de la preconsulta no coincide con la registrada." });
  }
  const taskDepth = request.body?.taskDepth;
  if (taskDepth !== undefined && !["quick", "focused", "deep"].includes(String(taskDepth))) {
    return reply.code(400).send({ error: "Profundidad de tarea inválida." });
  }
  const nonFavorite = findNonFavoriteAssignment(listAssignments().filter((item) => item.enabled));
  if (nonFavorite) {
    return reply.code(409).send({
      error: `No se puede iniciar: el agente ${nonFavorite.agentId} tiene asignado ${nonFavorite.modelId}, que no está marcado como favorito.`
    });
  }
  const preflightState = getProjectPreflight(projectPath, String(preflightDepth));
  if (!preflightState) {
    return reply.code(409).send({
      error: "La ruta o profundidad no coinciden con una preconsulta vigente. Ejecuta primero la preconsulta del proyecto."
    });
  }
  if (!preflightState.decision) {
    return reply.code(409).send({
      error: "Primero acepta la propuesta automática o registra la configuración manual."
    });
  }
  if (!preflightState.teamSaved) {
    return reply.code(409).send({
      error: "Guarda el equipo de agentes después de aceptar la propuesta o elegir la configuración manual."
    });
  }
  if (preflightState.consumed) {
    return reply.code(409).send({
      error: "Esta preconsulta ya fue utilizada. Ejecuta una nueva preconsulta para iniciar otra ejecución inicial."
    });
  }
  let createdThreadId: string | null = null;
  try {
    // Recheck the project structure, then atomically consume the server-side
    // preflight/decision/team snapshot. Client-side button state is not trusted.
    const revalidatedProject = await analyzeProject(projectPath, preflightDepth as "quick" | "focused" | "deep");
    if (revalidatedProject.path !== projectPath) {
      return reply.code(409).send({
        error: "La ruta real del proyecto cambió desde la preconsulta. Ejecuta nuevamente la preconsulta y confirma la ruta canónica."
      });
    }
    const preflight = consumeProjectPreflight(projectPath, String(preflightDepth));
    if (!preflight.consumed) {
      return reply.code(409).send({ error: preflight.reason ?? "Completa el flujo de preconsulta antes de iniciar." });
    }
    saveProjectPreferences(projectPath, "");
    const threadId = randomUUID();
    createdThreadId = threadId;
    createWorkThread({ id: threadId, projectPath, objective: instructions });
    addWorkMessage(threadId, null, 1, "user", instructions, "initial-instruction");
    const result = await startExecution(projectPath, instructions, factoryRoot, taskDepth as "quick" | "focused" | "deep" | undefined, {
      threadId, roundNumber: 1
    });
    return reply.code(202).send({
      started: true, runId: result.runId, threadId, execution: getExecution(result.runId),
      workflow: presentWorkThread(getWorkThreadSnapshot(threadId)!)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (createdThreadId) {
      addWorkMessage(createdThreadId, null, 1, "assistant", "No se pudo iniciar la ejecución: " + message, "start-error");
      updateWorkThreadStatus(createdThreadId, "failed");
    }
    return reply.code(409).send({ error: message });
  }
});

app.post<{
  Params: { threadId: string };
  Body: { instructions?: unknown; taskDepth?: unknown };
}>("/api/work-threads/:threadId/continue", async (request, reply) => {
  const workflow = getWorkThreadSnapshot(request.params.threadId);
  if (!workflow) return reply.code(404).send({ error: "Proceso de trabajo no encontrado." });
  const rawInstructions = typeof request.body?.instructions === "string"
    ? request.body.instructions : "";
  const limitError = workInstructionLimitError(rawInstructions);
  if (limitError) return reply.code(400).send({ error: limitError });
  const instructions = rawInstructions.trim();
  if (!instructions) return reply.code(400).send({ error: "Escribe la siguiente instrucción para continuar el proceso." });
  const latestRound = workflow.rounds.at(-1);
  if (latestRound && ["queued", "running", "waiting"].includes(latestRound.run.status)) {
    return reply.code(409).send({ error: "La ronda actual todavía está activa. Puedes continuar cuando termine." });
  }
  const taskDepth = request.body?.taskDepth;
  if (taskDepth !== undefined && !["quick", "focused", "deep"].includes(String(taskDepth))) {
    return reply.code(400).send({ error: "Profundidad de tarea inválida." });
  }
  const nonFavorite = findNonFavoriteAssignment(listAssignments().filter((item) => item.enabled));
  if (nonFavorite) {
    return reply.code(409).send({
      error: `No se puede continuar: el agente ${nonFavorite.agentId} tiene asignado ${nonFavorite.modelId}, que no está marcado como favorito.`
    });
  }
  const latestRecordedNumber = Math.max(
    latestRound?.run.roundNumber ?? 0,
    ...workflow.messages.map((message) => message.roundNumber)
  );
  const roundNumber = latestRecordedNumber + 1;
  const continuityContext = buildContinuityContext(workflow);
  try {
    if (!existsSync(workflow.thread.projectPath) || !statSync(workflow.thread.projectPath).isDirectory()) {
      return reply.code(409).send({ error: "El proyecto original ya no está disponible en esa ruta." });
    }
    addWorkMessage(request.params.threadId, null, roundNumber, "user", instructions, "continuation-instruction");
    updateWorkThreadStatus(request.params.threadId, "active");
    const result = await startExecution(
      workflow.thread.projectPath,
      instructions,
      factoryRoot,
      taskDepth as "quick" | "focused" | "deep" | undefined,
      { threadId: request.params.threadId, roundNumber, continuityContext }
    );
    return reply.code(202).send({
      started: true, runId: result.runId, threadId: request.params.threadId,
      execution: getExecution(result.runId),
      workflow: presentWorkThread(getWorkThreadSnapshot(request.params.threadId)!)
    });
  } catch (error) {
    updateWorkThreadStatus(request.params.threadId, "failed");
    const message = error instanceof Error ? error.message : String(error);
    addWorkMessage(request.params.threadId, null, roundNumber, "assistant",
      "No se pudo iniciar esta ronda: " + message, "start-error");
    return reply.code(409).send({ error: message });
  }
});

app.post<{ Params: { runId: string } }>("/api/executions/:runId/cancel", async (request, reply) => {
  try {
    await cancelExecution(request.params.runId);
    return { cancelled: true, execution: getExecution(request.params.runId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(409).send({ error: message });
  }
});

app.post<{
  Params: { runId: string; decisionId: string };
  Body: { action?: unknown; answer?: unknown };
}>("/api/executions/:runId/decisions/:decisionId/respond", async (request, reply) => {
  const action = request.body?.action;
  if (action !== "allow" && action !== "allow-run" && action !== "deny" && action !== "answer") {
    return reply.code(400).send({ error: "La respuesta debe ser allow, allow-run, deny o answer." });
  }
  const answer = typeof request.body?.answer === "string" ? request.body.answer.slice(0, 12000) : undefined;
  if (action === "answer" && !answer?.trim()) {
    return reply.code(400).send({ error: "Escribe una respuesta antes de enviarla." });
  }
  try {
    await respondExecutionDecision(request.params.runId, request.params.decisionId, { action, answer });
    return { responded: true, execution: getExecution(request.params.runId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(409).send({ error: message });
  }
});

// En producción, Fastify sirve también la interfaz compilada desde el mismo origen.
const webDist = resolve(factoryRoot, "control-center", "dist");
if (existsSync(join(webDist, "index.html"))) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Ruta API no encontrada." });
    }
    if (request.method === "GET") {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send();
  });
}

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ error: "Error interno de Factory Control Center." });
});

try {
  await app.listen({ host, port });
  app.log.info(`Factory Control Center API escuchando en http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
