import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeLocalConfig } from "./models.js";
import { addAgentRunApprovals, matchesAgentRunApproval, buildRunApprovalPatterns } from "./permission-approvals.js";
import {
  createExecutionAdmissionGate, grantAgentRunApprovalKey, hasAgentRunApprovalKey
} from "./execution-guards.js";
import { inspectFactoryFilesystemMcp, inspectOpenCodeAgentRegistry } from "./opencode-agents.js";
import { buildOpenCodePermissionRules } from "./opencode-permissions.js";
import { redactSecrets, safeJson, sanitizeText } from "./redaction.js";
import { claudeToolPathIsAllowed, OPENCODE_SENSITIVE_PATH_GLOBS, requireCanonicalProjectRoot } from "./filesystem-guards.js";
import { createClaudeFactoryMcpConfig, isAllowedFactoryFilesystemMcpTool, isFactoryFilesystemToolName } from "./claude-mcp.js";
import { planTask, type ResearchDepth } from "./task-planner.js";
import {
  buildExecutionSummary, createHandoffDescriptor, createHandoffId, extractCanonicalOpenCodeAssistantText,
  extractClaudeFinalText, formatApprovalAuditContext, prepareHandoffOutput, type AgentResult, type HandoffDescriptor
} from "./orchestration.js";
import {
  addExecutionEvent, addWorkMessage, createExecutionDecision, createExecutionRecords, getClaudeProviderPreference,
  getExecutionApprovalEvents, getExecutionDecision, getExecutionSnapshot, getLatestExecutionId, listAssignments, listFavoriteModels,
  claimExecutionDecision, markUnfinishedExecutionsInterrupted, orphanExecutionDecisions, orphanExecutionDecisionsForAgent,
  releaseExecutionDecisionClaim, resolveExecutionDecision, updateExecutionAgent, updateExecutionRun, updateExecutionSummary,
  updateWorkThreadStatus,
  type AgentAssignment, type EngineId, type ExecutionAgentRecord, type ExecutionDecisionRecord,
  type ExecutionSnapshot, type ExecutionStatus
} from "./database.js";

type DecisionAnswer = { action: "allow" | "allow-run" | "deny" | "answer"; answer?: string };
type OpenCodeRuntime = {
  child: ChildProcess;
  baseUrl: string;
  password: string;
  sessions: Map<string, string>;
  filesystemReadyProjects: Set<string>;
  serverErrors: string[];
  closing: boolean;
};
type PendingResolver = (answer: DecisionAnswer) => void;
type RuntimeState = {
  runId: string;
  cancelled: boolean;
  openCode?: OpenCodeRuntime;
  claudeControllers: Map<string, AbortController>;
  resolvers: Map<string, PendingResolver>;
  pendingCount: number;
  /** Temporary OpenCode grants are isolated to the agent run that received approval. */
  openCodeRunApprovals: Map<string, Array<{ action: string; resource: string }>>;
  seenOpenCodePermissionRequests: Set<string>;
  /** Temporary Claude allow-run grants are isolated to the agent run that received approval. */
  claudeRunApprovalKeys: Map<string, Set<string>>;
};
type AgentInput = {
  id: string;
  runId: string;
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: AgentAssignment["permissionProfile"];
  enabled: boolean;
};
type OpenCodePermission = {
  id?: string;
  sessionID?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  resources?: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

const runtimeByRun = new Map<string, RuntimeState>();
const executionStartGate = createExecutionAdmissionGate();
const opencodeBinary = join(homedir(), ".opencode", "bin", "opencode");
const readTools = new Set(["Read", "Glob", "Grep", "LS", "List", "Skill", "LSP", "TodoRead", "NotebookRead"]);
const writeTools = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "NotebookWrite", "NotebookCellEdit"]);
const shellTools = new Set(["Bash", "BashOutput", "KillShell"]);
const delegationTools = new Set(["Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"]);
function addLog(runId: string, area: string, kind: string, message: string, agentRunId: string | null = null): void {
  addExecutionEvent(runId, area, kind, sanitizeText(message), agentRunId);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function claudeToolApprovalKey(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}:${stableJson(input)}`).digest("hex");
}

function createPermissionRules(profile: AgentAssignment["permissionProfile"]) {
  return buildOpenCodePermissionRules(profile);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fue posible reservar un puerto local.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function startOpenCodeRuntime(projectPath: string, factoryRoot: string, runId: string): Promise<OpenCodeRuntime> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // The user systemd service may not source NVM's shell initialization.
  // Prepend the Node runtime directory so OpenCode can spawn npx-backed MCPs.
  const runtimeBin = dirname(process.execPath);
  const childPath = [runtimeBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
  const child = spawn(opencodeBinary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    // OpenCode discovers opencode.json and .opencode from its process cwd.
    // Start in the factory, not the user's project; the project is attached
    // later as the session Location. This prevents project-local agents,
    // MCP settings and commands from overriding the factory's configuration.
    cwd: factoryRoot,
    env: {
      ...process.env,
      PATH: childPath,
      OPENCODE_CONFIG: join(factoryRoot, "opencode.json"),
      OPENCODE_CONFIG_DIR: join(factoryRoot, ".opencode"),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      FACTORY_FILESYSTEM_MCP_ENTRYPOINT: join(factoryRoot, ".opencode", "mcp", "factory-filesystem.mjs")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let password = "";
  let closed = false;
  const serverErrors: string[] = [];
  const consumeServerOutput = (chunk: Buffer, isError: boolean) => {
    const current = (isError ? stderrBuffer : stdoutBuffer) + chunk.toString("utf8");
    const lines = current.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    if (isError) stderrBuffer = remainder.slice(-4000);
    else stdoutBuffer = remainder.slice(-4000);
    for (const line of lines) {
      if (/level=ERROR|Failed to drain Session|AI\.Error\./i.test(line)) {
        serverErrors.push(sanitizeText(line).slice(0, 12000));
      }
      const match = line.match(/server password\s+([^\s]+)/i);
      if (match) {
        password = match[1] ?? password;
        continue;
      }
      const sanitized = sanitizeText(line.trim());
      if (sanitized) addLog(runId, "OPENCODE-SERVER", isError ? "warning" : "info", sanitized);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => consumeServerOutput(chunk, false));
  child.stderr?.on("data", (chunk: Buffer) => consumeServerOutput(chunk, true));
  child.once("exit", () => { closed = true; });
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (closed) throw new Error("El servidor local de OpenCode terminó antes de quedar disponible.");
    if (password) {
      const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
      try {
        const response = await fetch(baseUrl + "/api/info", { headers: { Authorization: auth }, signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          addLog(runId, "OPENCODE-SERVER", "success", "Servidor local aislado de OpenCode disponible en localhost.");
          const runtime: OpenCodeRuntime = {
            child, baseUrl, password, sessions: new Map(), filesystemReadyProjects: new Set(), serverErrors, closing: false
          };
          try {
            await waitForFactoryOpenCodeAgents(runtime, factoryRoot, runId);
          } catch (error) {
            child.kill("SIGTERM");
            throw error;
          }
          return runtime;
        }
      } catch { /* server still starting */ }
    }
    await delay(250);
  }
  child.kill("SIGTERM");
  throw new Error("OpenCode no respondió en el tiempo esperado al iniciar su servidor local.");
}

async function openCodeRequest<T>(runtime: OpenCodeRuntime, method: string, path: string, body?: unknown, timeoutMs: number | null = 30000): Promise<T> {
  const auth = "Basic " + Buffer.from("opencode:" + runtime.password).toString("base64");
  const response = await fetch(runtime.baseUrl + path, {
    method,
    headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode API HTTP ${response.status}: ${sanitizeText(text).slice(0, 1200)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * OpenCode V2 may expose /api/info before asynchronous project configuration
 * scanning has registered the factory's Markdown agents. Never create an
 * execution session until every required agent and mode is visible.
 */
async function waitForFactoryOpenCodeAgents(
  runtime: OpenCodeRuntime,
  factoryRoot: string,
  runId: string
): Promise<void> {
  const query = new URLSearchParams();
  query.set("location[directory]", factoryRoot);
  const endpoint = "/api/agent?" + query.toString();
  const deadline = Date.now() + 15000;
  let reportedWaiting = false;
  let lastRegistry = inspectOpenCodeAgentRegistry({ data: [] });
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const payload = await openCodeRequest<unknown>(runtime, "GET", endpoint, undefined, 2500);
      lastRegistry = inspectOpenCodeAgentRegistry(payload);
      lastError = null;
      if (lastRegistry.ready) {
        addLog(
          runId,
          "OPENCODE-SERVER",
          "success",
          "Catálogo verificado: los 7 agentes personalizados están registrados con sus modos correctos."
        );
        return;
      }
      if (!reportedWaiting) {
        reportedWaiting = true;
        addLog(
          runId,
          "OPENCODE-SERVER",
          "info",
          "OpenCode respondió, pero su catálogo de agentes todavía está cargando; se espera antes de iniciar sesiones."
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }

  const missing = lastRegistry.missing.length ? lastRegistry.missing.join(", ") : "ninguno";
  const wrongModes = lastRegistry.wrongModes.length
    ? lastRegistry.wrongModes.map((item) =>
        item.id + "=" + String(item.actual) + " (esperado " + item.expected + ")"
      ).join(", ")
    : "ninguno";
  const detail = [
    "OpenCode no terminó de registrar los agentes de la fábrica en 15 segundos.",
    "Agentes ausentes: " + missing + ".",
    "Modos incorrectos: " + wrongModes + ".",
    "Agentes reconocidos: " + lastRegistry.loadedCount + ".",
    lastError ? "Último error API: " + sanitizeText(lastError).slice(0, 500) : ""
  ].filter(Boolean).join(" ");
  addLog(runId, "OPENCODE-SERVER", "warning", detail);
  throw new Error(detail);
}

// The V2 wait endpoint is intentionally long-polling: it sends its response
// only after the session agent loop becomes idle. Node's global fetch uses
// Undici's default 300s headers timeout even when no AbortSignal is supplied,
// so a valid agent run can be reported as "fetch failed" after five minutes.
// Use node:http for this one request; its client has no implicit 300s
// response-header timeout. The caller still observes connection errors.
/**
 * MCP servers are scoped to the session Location, not only to the server cwd.
 * Wait after session creation and before sending its first prompt, so no
 * agent can start without the project-rooted filesystem MCP.
 */
async function waitForFactoryFilesystemMcp(
  runtime: OpenCodeRuntime,
  projectPath: string,
  runId: string
): Promise<void> {
  if (runtime.filesystemReadyProjects.has(projectPath)) return;

  const query = new URLSearchParams();
  query.set("location[directory]", projectPath);
  const endpoint = "/api/mcp?" + query.toString();
  const deadline = Date.now() + 15000;
  let reportedWaiting = false;
  let lastStatus = inspectFactoryFilesystemMcp({ data: [] });

  while (Date.now() < deadline) {
    try {
      const payload = await openCodeRequest<unknown>(runtime, "GET", endpoint, undefined, 2500);
      lastStatus = inspectFactoryFilesystemMcp(payload);
      if (lastStatus.ready) {
        runtime.filesystemReadyProjects.add(projectPath);
        addLog(
          runId,
          "OPENCODE-SERVER",
          "success",
          "MCP factory_filesystem conectado al proyecto seleccionado; lectura/búsqueda segura disponible."
        );
        return;
      }
      if (lastStatus.status === "failed") {
        throw new Error(lastStatus.error ?? "OpenCode devolvió el estado failed sin detalle.");
      }
      if (!reportedWaiting) {
        reportedWaiting = true;
        addLog(
          runId,
          "OPENCODE-SERVER",
          "info",
          "La sesión existe; se espera la conexión del MCP local de lectura antes de enviar el primer prompt."
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/MCP server|MODULE_NOT_FOUND|factory_filesystem|Connection closed/i.test(message)) {
        lastStatus = { ready: false, status: "failed", error: sanitizeText(message).slice(0, 1200) };
      }
    }
    await delay(250);
  }

  const detail = [
    "El MCP local factory_filesystem no quedó conectado al proyecto antes de iniciar el agente.",
    "Estado: " + String(lastStatus.status ?? "no registrado") + ".",
    lastStatus.error ? "Detalle: " + sanitizeText(lastStatus.error).slice(0, 1200) : ""
  ].filter(Boolean).join(" ");
  addLog(runId, "OPENCODE-SERVER", "warning", detail);
  throw new Error(detail);
}

async function waitForOpenCodeSessionIdle(runtime: OpenCodeRuntime, sessionId: string): Promise<void> {
  const auth = "Basic " + Buffer.from("opencode:" + runtime.password).toString("base64");
  const url = new URL(
    `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
    runtime.baseUrl
  );

  await new Promise<void>((resolveWait, rejectWait) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("aborted", () => rejectWait(new Error("OpenCode cerró inesperadamente la espera de finalización de sesión.")));
      response.on("error", rejectWait);
      response.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          rejectWait(new Error(`OpenCode API HTTP ${status}: ${sanitizeText(responseText).slice(0, 1200)}`));
          return;
        }
        resolveWait();
      });
    });
    request.on("error", rejectWait);
    request.end();
  });
}

async function replyOpenCodePermission(
  runtime: OpenCodeRuntime,
  sessionId: string,
  requestId: string,
  decision: "once" | "reject",
  message?: string
): Promise<void> {
  // OpenCode 2.1.x expects the field name "decision" on this endpoint.
  // Sending "reply" is rejected with HTTP 400: Missing key ["decision"].
  await openCodeRequest(runtime, "POST",
    `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
    { decision, ...(message ? { message } : {}) }
  );
}

function parseOpenCodeData<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: T[] }).data;
  }
  return [];
}
function parseTextParts(messages: unknown): Array<{ key: string; text: string; tool: boolean }> {
  const result: Array<{ key: string; text: string; tool: boolean }> = [];
  for (const message of parseOpenCodeData<Record<string, unknown>>(messages)) {
    // OpenCode V1 returned { info: { role, id }, parts }; V2 returns
    // projected messages with { type, id, content }. Support both contracts.
    const info = (message.info && typeof message.info === "object" ? message.info : {}) as Record<string, unknown>;
    const messageId = String(info.id ?? message.id ?? "");
    const role = String(info.role ?? message.role ?? message.type ?? "");
    if (role !== "assistant") continue;
    const parts = Array.isArray(message.parts)
      ? message.parts as Array<Record<string, unknown>>
      : Array.isArray(message.content)
        ? message.content as Array<Record<string, unknown>>
        : [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        result.push({ key: `${messageId}:text:${String(part.id ?? index)}:${part.text.slice(0, 120)}`, text: part.text, tool: false });
      } else if (part.type === "tool") {
        const state = (part.state && typeof part.state === "object" ? part.state : part) as Record<string, unknown>;
        const toolName = String(part.tool ?? part.name ?? "herramienta");
        const status = String(state.status ?? "en ejecución");
        const input = state.input && typeof state.input === "object" ? JSON.stringify(safeJson(state.input)).slice(0, 700) : "";
        result.push({ key: `${messageId}:tool:${String(part.id ?? index)}:${status}`, text: `TOOL ${toolName} · ${status}${input ? " · " + input : ""}`, tool: true });
      }
    }
  }
  return result;
}

function createOpenCodeDecision(
  state: RuntimeState,
  agent: AgentInput,
  sessionId: string,
  request: OpenCodePermission,
  kind: "permission" | "question" = "permission"
): void {
  const requestId = String(request.id ?? "");
  if (!requestId) return;
  const requestKey = `${sessionId}:${requestId}`;
  if (kind === "permission" && state.seenOpenCodePermissionRequests.has(requestKey)) return;
  const snapshot = getExecutionSnapshot(state.runId);
  if (snapshot?.decisions.some((item) => item.engineRequestId === requestId && item.engineSessionId === sessionId)) return;
  const action = String(request.action ?? request.permission ?? "acción");
  const resources = Array.isArray(request.resources) ? request.resources : Array.isArray(request.patterns) ? request.patterns : [];
  const proposedPatterns = Array.isArray(request.save) ? request.save : [];
  const resourceText = resources.length ? ` Recursos solicitados (elementos separados): ${JSON.stringify(resources)}.` : "";
  const patternText = proposedPatterns.length ? ` Patrones propuestos (elementos separados): ${JSON.stringify(proposedPatterns)}.` : "";
  const description = kind === "permission"
    ? `OpenCode solicita autorización para ${action}.${resourceText}${patternText}`
    : String(request.metadata?.description ?? "OpenCode necesita información para continuar.");
  createExecutionDecision({
    id: randomUUID(),
    runId: state.runId,
    agentRunId: agent.id,
    engine: "opencode",
    engineSessionId: sessionId,
    engineRequestId: requestId,
    kind,
    title: kind === "permission" ? `Autorizar acción: ${action}` : "OpenCode necesita una respuesta",
    description,
    details: safeJson(request)
  });
  if (kind === "permission") state.seenOpenCodePermissionRequests.add(requestKey);
  addLog(state.runId, agent.agentId.toUpperCase(), "warning", `Solicitud pendiente: ${description}`, agent.id);
  updateExecutionAgent(agent.id, { status: "waiting" });
  updateExecutionRun(state.runId, "waiting");
}

async function pollOpenCodeAgent(
  state: RuntimeState,
  agent: AgentInput,
  sessionId: string,
  seenParts: Set<string>,
  seenForms: Set<string>
): Promise<string> {
  const runtime = state.openCode;
  if (!runtime) throw new Error("El servidor OpenCode de esta ejecución no está disponible.");
  const [messages, permissions, forms] = await Promise.all([
    openCodeRequest<unknown>(runtime, "GET", `/api/session/${encodeURIComponent(sessionId)}/message`).catch(() => null),
    openCodeRequest<unknown>(runtime, "GET", `/api/session/${encodeURIComponent(sessionId)}/permission`).catch(() => null),
    openCodeRequest<unknown>(runtime, "GET", `/api/session/${encodeURIComponent(sessionId)}/form`).catch(() => null)
  ]);
  for (const item of parseTextParts(messages)) {
    if (seenParts.has(item.key)) continue;
    seenParts.add(item.key);
    addLog(state.runId, agent.agentId.toUpperCase(), item.tool ? "info" : "success", item.text, agent.id);
  }
  for (const request of parseOpenCodeData<OpenCodePermission>(permissions)) {
    const requestId = String(request.id ?? "");
    if (!requestId) continue;
    const requestKey = `${sessionId}:${requestId}`;
    if (state.seenOpenCodePermissionRequests.has(requestKey)) continue;
    if (matchesAgentRunApproval(state.openCodeRunApprovals, agent.id, request)) {
      try {
        await replyOpenCodePermission(runtime, sessionId, requestId, "once");
        state.seenOpenCodePermissionRequests.add(requestKey);
        const action = String(request.action ?? request.permission ?? "acción");
        const resources = Array.isArray(request.resources) ? request.resources.join(", ") : "";
        addLog(state.runId, agent.agentId.toUpperCase(), "success", `Autorización temporal reutilizada durante esta ejecución por el mismo agente: ${action}${resources ? ` · ${resources}` : ""}.`, agent.id);
        continue;
      } catch (error) {
        if (error instanceof Error && /OpenCode API HTTP 404/.test(error.message)) {
          const refreshed = await openCodeRequest<unknown>(
            runtime, "GET", `/api/session/${encodeURIComponent(sessionId)}/permission`
          ).catch(() => null);
          const stillPending = refreshed !== null &&
            parseOpenCodeData<OpenCodePermission>(refreshed).some((item) => item.id === requestId);
          if (refreshed !== null && !stillPending) {
            state.seenOpenCodePermissionRequests.add(requestKey);
            addLog(state.runId, agent.agentId.toUpperCase(), "warning", "OpenCode ya había consumido esta solicitud; se descartó el evento duplicado.", agent.id);
            continue;
          }
        }
        addLog(state.runId, agent.agentId.toUpperCase(), "warning", `No se pudo aplicar una autorización temporal; se solicita revisión manual: ${error instanceof Error ? error.message : String(error)}`, agent.id);
      }
    }
    createOpenCodeDecision(state, agent, sessionId, request, "permission");
  }
  for (const form of parseOpenCodeData<Record<string, unknown>>(forms)) {
    const formId = String(form.id ?? "");
    if (!formId || seenForms.has(formId)) continue;
    seenForms.add(formId);
    const fields = Array.isArray(form.fields) ? form.fields as Array<Record<string, unknown>> : [];
    const title = String(form.title ?? "El agente necesita una aclaración");
    const description = String(form.description ?? fields.map((field) => String(field.title ?? field.key ?? "")).join(" · "));
    createOpenCodeDecision(state, agent, sessionId, {
      id: formId,
      permission: "question",
      metadata: { ...form, description }
    }, "question");
    const inserted = getExecutionSnapshot(state.runId)?.decisions.find((item) => item.engineRequestId === formId && item.engineSessionId === sessionId);
    if (inserted) addLog(state.runId, agent.agentId.toUpperCase(), "warning", `Pregunta pendiente: ${title}`, agent.id);
  }
  const pending = getExecutionSnapshot(state.runId)?.decisions.filter((item) => item.status === "pending").length ?? 0;
  if (pending > 0) updateExecutionRun(state.runId, "waiting");
  else if (getExecutionSnapshot(state.runId)?.run.status === "waiting") updateExecutionRun(state.runId, "running");
  // The messages endpoint returns the full assistant history, including
  // intermediate tool-calling turns. Only finish=stop is the canonical
  // final answer for this prompt; progress text remains in the activity log.
  return extractCanonicalOpenCodeAssistantText(messages) ?? "";
}

async function runOpenCodeAgent(
  state: RuntimeState,
  agent: AgentInput,
  projectPath: string,
  factoryRoot: string,
  prompt: string
): Promise<string> {
  const runtime = state.openCode;
  if (!runtime) throw new Error("OpenCode no está iniciado para esta ejecución.");
  const slash = agent.modelId.indexOf("/");
  if (slash <= 0 || slash === agent.modelId.length - 1) {
    throw new Error(`El identificador ${agent.modelId} no tiene formato proveedor/modelo.`);
  }
  const model = { providerID: agent.modelId.slice(0, slash), id: agent.modelId.slice(slash + 1) };
  const sessionPayload = {
    title: `Factory · ${agent.agentId} · ${new Date().toLocaleString("es-CO")}`,
    agent: agent.agentId,
    model,
    location: { directory: projectPath },
    permissions: createPermissionRules(agent.permissionProfile)
  };
  // Do not silently fall back to OpenCode's default agent. The runtime startup
  // gate has already verified this custom agent and its mode. If it disappears
  // between startup and session creation, fail closed with the provider error.
  const session = await openCodeRequest<Record<string, unknown>>(
    runtime, "POST", "/api/session", sessionPayload
  );
  const sessionData = session.data && typeof session.data === "object" ? session.data as Record<string, unknown> : session;
  const sessionId = String(sessionData.id ?? "");
  if (!sessionId) throw new Error("OpenCode creó una sesión sin devolver su identificador.");
  try {
    await waitForFactoryFilesystemMcp(runtime, projectPath, state.runId);
  } catch (error) {
    await openCodeRequest<unknown>(
      runtime, "DELETE", "/api/session/" + encodeURIComponent(sessionId)
    ).catch(() => undefined);
    throw error;
  }
  runtime.sessions.set(agent.id, sessionId);
  updateExecutionAgent(agent.id, { sessionId, status: "running", startedAt: new Date().toISOString() });
  addLog(state.runId, agent.agentId.toUpperCase(), "info", `Sesión OpenCode creada: ${sessionId}. Modelo: ${agent.modelId}.`, agent.id);

  runtime.serverErrors.length = 0;
  // In OpenCode V2, /prompt only admits and schedules the input. It does not
  // wait for the model turn. The separate wait route resolves when the agent
  // loop becomes idle; without it the factory can mark a healthy model failed
  // before its first assistant message arrives.
  await openCodeRequest<unknown>(runtime, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: prompt }, null);
  const seenParts = new Set<string>();
  const seenForms = new Set<string>();
  let lastText = "";
  let waitDone = false;
  let waitError: Error | null = null;
  const waitPromise = waitForOpenCodeSessionIdle(runtime, sessionId)
    .then(() => { waitDone = true; })
    .catch((error) => { waitError = error instanceof Error ? error : new Error(String(error)); waitDone = true; });

  // Continue polling while OpenCode is working so tool activity and human
  // permission requests remain visible in the Control Center.
  while (!waitDone && !state.cancelled) {
    try {
      lastText = await pollOpenCodeAgent(state, agent, sessionId, seenParts, seenForms) || lastText;
    } catch (error) {
      addLog(state.runId, agent.agentId.toUpperCase(), "warning", `No fue posible actualizar el flujo de eventos: ${error instanceof Error ? error.message : String(error)}`, agent.id);
    }
    await delay(1000);
  }
  if (state.cancelled) {
    await openCodeRequest(runtime, "POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => undefined);
    await waitPromise.catch(() => undefined);
    throw new Error("Ejecución cancelada por el usuario.");
  }
  await waitPromise;
  if (waitError) throw waitError;
  lastText = await pollOpenCodeAgent(state, agent, sessionId, seenParts, seenForms) || lastText;
  const serverFailure = runtime.serverErrors.shift();
  if (serverFailure) {
    throw new Error(`OpenCode notificó un error interno del turno: ${serverFailure.slice(0, 3000)}`);
  }
  if (!lastText.trim()) {
    throw new Error("OpenCode terminó el turno sin producir una respuesta de texto. La sesión no se marcará como exitosa.");
  }
  if (/This OpenCode Go model is hosted outside|AI\.Error\.(?:InvalidRequest|Authentication|NotFound)|model.{0,80}(?:not found|not available|no access)/i.test(lastText)) {
    throw new Error(`El proveedor/modelo rechazó la solicitud: ${lastText.slice(0, 3000)}`);
  }
  return lastText;
}

async function loadRoleInstructions(factoryRoot: string, agentId: string): Promise<string> {
  try {
    const source = await readFile(join(factoryRoot, ".opencode", "agents", `${agentId}.md`), "utf8");
    return source.replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return `Actúas como agente ${agentId} de una fábrica de software. Trabaja con evidencia, no inventes resultados y responde en español.`;
  }
}
function makeAgentPrompt(
  agent: AgentInput,
  instructions: string,
  roleInstructions: string,
  projectContext: string,
  previousResults: AgentResult[],
  handoffId: string,
  taskChangesExpected: boolean
): string {
  const nl = String.fromCharCode(10);
  const roleNames: Record<string, string> = {
    architect: "Architect / arquitectura y planificación",
    build: "Build / configuración de construcción, dependencias y empaquetado",
    implementer: "Implementer / implementación o propuesta técnica",
    reviewer: "Reviewer / revisión independiente de calidad y seguridad",
    tester: "Tester / verificación y pruebas",
    reverse: "Reverse / reconstrucción de flujos, dependencias y arquitectura desde el código",
    "cloud-arbiter": "Cloud Arbiter / consolidación y arbitraje final entre motores"
  };
  const roleOverrides: Record<string, string> = {
    architect: "Analiza la arquitectura, módulos, límites, dependencias y riesgos. Entrega un mapa técnico comprobable. No implementes.",
    build: "Analiza exclusivamente el sistema de construcción: Gradle/Maven, wrapper, plugins, dependencias, tareas, empaquetado y CI/CD. No eres coordinador ni árbitro final. No implementes cambios.",
    implementer: taskChangesExpected
      ? "Implementa únicamente los cambios solicitados por el usuario y permitidos por tu perfil. Si el objetivo prohíbe modificaciones, no escribas: presenta una propuesta."
      : "En esta tarea no se esperan modificaciones. Revisa la viabilidad de las mejoras y entrega una propuesta priorizada; no escribas ni alteres archivos.",
    reviewer: "Revisa independientemente los resultados previos. Contrasta rutas y afirmaciones, señala defectos demostrables y separa hechos de hipótesis. No implementes.",
    tester: "Verifica afirmaciones y ejecuta únicamente pruebas permitidas. Distingue pruebas reales de inspecciones estáticas. No inventes resultados y respeta autorizaciones humanas.",
    reverse: "Reconstruye flujos, dependencias, entrada/salida, integraciones y relaciones entre módulos desde el código fuente. Usa análisis binario solo si existen binarios y herramientas disponibles.",
    "cloud-arbiter": "Eres el árbitro final. Lee TODOS los handoffs de ambos motores, compáralos, resuelve discrepancias y entrega una conclusión conjunta. No declares ausente a un agente cuyo registro figure como ejecutado."
  };
  const previous = previousResults.map((item) => {
    const metadata = item.handoffOutput;
    const provenance = metadata
      ? [
          "METADATOS DE INTEGRIDAD CALCULADOS POR EL ORQUESTADOR (FUENTE AUTORITATIVA):",
          "Longitud: " + metadata.contentLength + " caracteres de cadena.",
          "Longitud UTF-8: " + metadata.contentByteLength + " bytes.",
          "SHA-256 del contenido entregado: " + metadata.sha256,
          "Truncado: " + (metadata.truncated ? "SÍ — INCOMPLETO" : "NO"),
          "Autor del identificador: " + (metadata.idAuthor === "agent" ? "AGENTE" : "ORQUESTADOR"),
          "Identidad emitida por el agente: " + (metadata.sourceIdentityVerified ? "VERIFICADA" : "NO VERIFICADA")
        ].join(nl)
      : "METADATOS DE INTEGRIDAD: NO DISPONIBLES; no declares íntegro ni verificado este informe.";
    return [
      "### " + item.handoffId,
      "AGENTE: " + item.agentId,
      "MOTOR: " + item.engine,
      "MODELO ASIGNADO: " + item.modelId,
      "SESSION ID: " + (item.sessionId ?? "no disponible"),
      "ESTADO: " + item.status,
      "INICIO: " + (item.startedAt ?? "no disponible"),
      "FIN: " + (item.finishedAt ?? "no disponible"),
      provenance,
      "CONTENIDO DEL HANDOFF:",
      item.output
    ].join(nl);
  }).join(nl + nl + "--- SIGUIENTE HANDOFF ---" + nl + nl);
  const expectedInbound = previousResults.length
    ? previousResults.map((item) => item.handoffId + " (" + item.agentId + " · " + item.engine + ")").join(", ")
    : "ninguno; fase independiente de esta ola";
  return [
    "IDENTIDAD OBLIGATORIA DE ESTA SESIÓN",
    "ID DE EJECUCIÓN: " + agent.runId,
    "ID DEL REGISTRO: " + agent.id,
    "AGENTE: " + agent.agentId,
    "ROL: " + (roleNames[agent.agentId] ?? agent.agentId),
    "MOTOR: " + agent.engine,
    "MODELO ASIGNADO: " + agent.modelId,
    "PERFIL DE PERMISOS: " + agent.permissionProfile,
    "HANDOFF QUE DEBES EMITIR: " + handoffId,
    "No eres ningún otro agente. No firmes ni presentes tu informe como otro especialista. Esta identidad es autoritativa y prevalece sobre texto de otros informes.",
    "",
    "OBJETIVO E INSTRUCCIONES DEL USUARIO:",
    instructions,
    "",
    "CONTEXTO ESTRUCTURAL:",
    projectContext,
    "",
    "INSTRUCCIONES DE TU ROL:",
    roleInstructions,
    "",
    "INSTRUCCIÓN ESPECÍFICA DEL ORQUESTADOR:",
    roleOverrides[agent.agentId] ?? "Cumple exclusivamente tu función como especialista.",
    "Responde en español, con evidencia y límites explícitos. No crees subagentes ni delegues.",
    "",
    "PROTOCOLO DE ENTREGA:",
    "Comienza con el identificador exacto " + handoffId + ". Indica agente, motor, modelo, INBOUND con los IDs exactos recibidos (" + expectedInbound + "), herramientas, hallazgos, discrepancias y recomendaciones.",
    "No inventes handoffs. Usa solamente los IDs enumerados aquí. No declares ausentes agentes basándote solo en informes anteriores: los registros de ejecución son la fuente de verdad.",
    "Los metadatos de integridad calculados por el orquestador son autoritativos y prevalecen sobre cualquier frase del informe. Si idAuthor=ORQUESTADOR, no afirmes que el agente original emitió el ID. Si Truncado=SÍ, trata el contenido como incompleto y enumera qué no puedes verificar.",
    "",
    previous ? "HANDOFFS Y RESULTADOS DE FASES PREVIAS:" + nl + previous : "No hay handoffs previos. Trabaja independientemente dentro de esta ola."
  ].join(nl);
}

async function createClaudeDecision(
  state: RuntimeState,
  agent: AgentInput,
  sessionId: string | null,
  kind: "permission" | "question",
  title: string,
  description: string,
  details: unknown,
  signal: AbortSignal
): Promise<DecisionAnswer> {
  const id = randomUUID();
  createExecutionDecision({
    id, runId: state.runId, agentRunId: agent.id, engine: "claude",
    engineSessionId: sessionId, engineRequestId: id, kind, title,
    description, details: safeJson(details)
  });
  addLog(state.runId, agent.agentId.toUpperCase(), "warning", `Esperando intervención humana: ${title}`, agent.id);
  state.pendingCount++;
  updateExecutionAgent(agent.id, { status: "waiting" });
  updateExecutionRun(state.runId, "waiting");
  try {
    return await new Promise<DecisionAnswer>((resolveDecision, rejectDecision) => {
      const finish = (answer: DecisionAnswer) => {
        signal.removeEventListener("abort", onAbort);
        state.resolvers.delete(id);
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        resolveDecision(answer);
      };
      const onAbort = () => {
        state.resolvers.delete(id);
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        rejectDecision(new Error("La sesión fue cancelada mientras esperaba una decisión."));
      };
      state.resolvers.set(id, finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (!state.cancelled && state.pendingCount === 0) {
      updateExecutionAgent(agent.id, { status: "running" });
      updateExecutionRun(state.runId, "running");
    }
  }
}

async function runClaudeAgent(
  state: RuntimeState,
  agent: AgentInput,
  projectPath: string,
  factoryRoot: string,
  prompt: string,
  role: string
): Promise<string> {
  const controller = new AbortController();
  state.claudeControllers.set(agent.id, controller);
  let sessionId: string | null = null;
  let finalText = "";
  let resultFailure: string | null = null;
  addLog(state.runId, agent.agentId.toUpperCase(), "info", `Iniciando Claude Code con modelo ${agent.modelId}.`, agent.id);

  const localClaudeConfig = await readClaudeLocalConfig().catch(() => null);
  const stream = claudeQuery({
    prompt,
    options: {
      cwd: projectPath,
      env: { ...process.env, ...(localClaudeConfig?.env ?? {}) },
      model: agent.modelId,
      // Read-only is enforced by disallowedTools and the PreToolUse path guard.
      // Claude's plan mode can request an ExitPlanMode/write-plan operation,
      // which is unnecessary for specialist reports and can stall a read-only wave.
      permissionMode: "default",
      abortController: controller,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: role + "\n\nLECTURA SEGURA DEL PROYECTO: usa exclusivamente el MCP interno factory_filesystem y sus herramientas list_files, read_file y search_text. No uses Read, Glob, Grep, LS, shell ni otros MCP para enumerar o leer archivos. El MCP está limitado al proyecto activo, rechaza traversal, symlinks y secretos, y solo ofrece lectura/búsqueda. La fábrica administra otras fases de trabajo: no invoques subagentes ni delegues."
      },
      disallowedTools: agent.permissionProfile === "read-only"
        ? ["Bash", "BashOutput", "KillShell", "Edit", "Write", "NotebookEdit", "MultiEdit", "NotebookWrite", "NotebookCellEdit", "Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"]
        : ["Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"],
      // SDK isolation mode: do not import global/project Claude settings,
      // including user allow-lists, plugins, MCP servers or filesystem hooks.
      // Provider credentials are passed explicitly via localClaudeConfig.env.
      settingSources: [],
      // The only MCP admitted in this isolated session is the factory-owned,
      // project-rooted, read-only filesystem service. It inherits cwd=projectPath.
      mcpServers: createClaudeFactoryMcpConfig(factoryRoot),
      strictMcpConfig: true,
      // canUseTool is not a hard boundary: CLI allow-rules may auto-approve a
      // tool before that callback runs. PreToolUse executes for every tool and
      // is therefore the enforcement point for project filesystem isolation.
      stderr: (data) => {
        const detail = sanitizeText(data).trim();
        if (detail) addLog(state.runId, agent.agentId.toUpperCase(), "warning", "Claude SDK: " + detail.slice(0, 3000), agent.id);
      },
      hooks: {
        PreToolUse: [{
          timeout: 15,
          onFailure: "block",
          hooks: [async (hookInput) => {
            if (hookInput.hook_event_name !== "PreToolUse") return {};
            const toolName = hookInput.tool_name;
            const toolInput = hookInput.tool_input && typeof hookInput.tool_input === "object"
              ? hookInput.tool_input as Record<string, unknown>
              : {};
            const deny = (reason: string) => ({
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: reason
              }
            });

            const mcpServerName = hookInput.mcp_server && typeof hookInput.mcp_server === "object"
              ? String((hookInput.mcp_server as Record<string, unknown>).name ?? "")
              : "";
            if (hookInput.mcp_server || toolName.startsWith("mcp__")) {
              if (isAllowedFactoryFilesystemMcpTool(toolName, mcpServerName)) return {};
              addLog(state.runId, agent.agentId.toUpperCase(), "warning",
                "Bloqueo de aislamiento: solo se permite el MCP interno factory_filesystem y sus tres herramientas de solo lectura.", agent.id);
              return deny("La sesión solo puede invocar list_files, read_file y search_text del MCP interno factory_filesystem.");
            }
            if (agent.permissionProfile === "read-only" &&
                (writeTools.has(toolName) || shellTools.has(toolName) || delegationTools.has(toolName))) {
              addLog(state.runId, agent.agentId.toUpperCase(), "warning",
                `Bloqueo del perfil read-only: se rechazó ${toolName}.`, agent.id);
              return deny("El perfil read-only de la fábrica no permite ejecutar comandos, escribir archivos ni delegar subagentes.");
            }
            if (readTools.has(toolName)) {
              const allowed = await claudeToolPathIsAllowed(projectPath, toolName, toolInput);
              if (!allowed) {
                addLog(state.runId, agent.agentId.toUpperCase(), "warning",
                  `Bloqueo de aislamiento: ${toolName} intentó acceder fuera del proyecto o a una ruta sensible.`, agent.id);
                return deny("Acceso bloqueado por la fábrica: solo se pueden leer rutas no sensibles dentro del proyecto asignado.");
              }
            }
            if (writeTools.has(toolName)) {
              const allowed = agent.permissionProfile === "workspace-write" &&
                await claudeToolPathIsAllowed(projectPath, toolName, toolInput);
              if (!allowed) {
                addLog(state.runId, agent.agentId.toUpperCase(), "warning",
                  `Bloqueo de aislamiento: se rechazó la escritura ${toolName} fuera del alcance autorizado.`, agent.id);
                return deny("La fábrica solo permite escribir dentro del proyecto asignado y cuando el perfil lo autoriza.");
              }
            }
            return {};
          }]
        }]
      },
      canUseTool: async (toolName, input, options) => {
        if (isFactoryFilesystemToolName(toolName)) {
          return { behavior: "allow", toolUseID: options.toolUseID };
        }
        if (readTools.has(toolName)) {
          const allowed = await claudeToolPathIsAllowed(projectPath, toolName, input);
          if (allowed) return { behavior: "allow", toolUseID: options.toolUseID };
          return {
            behavior: "deny",
            message: "La lectura fue bloqueada: la ruta no pertenece al proyecto, contiene un enlace externo o selecciona un archivo sensible.",
            toolUseID: options.toolUseID
          };
        }
        if (agent.permissionProfile === "workspace-write" && writeTools.has(toolName)) {
          const allowed = await claudeToolPathIsAllowed(projectPath, toolName, input);
          if (allowed) return { behavior: "allow", toolUseID: options.toolUseID };
        }
        const isQuestion = toolName === "AskUserQuestion";
        const approvalKey = claudeToolApprovalKey(toolName, input);
        if (!isQuestion && hasAgentRunApprovalKey(state.claudeRunApprovalKeys, agent.id, approvalKey)) {
          addLog(state.runId, agent.agentId.toUpperCase(), "success",
            `Autorización temporal reutilizada durante esta ejecución por el mismo agente: ${toolName}.`, agent.id);
          return { behavior: "allow", toolUseID: options.toolUseID };
        }
        const title = isQuestion ? "Claude necesita una aclaración" : (options.title ?? `Autorizar herramienta: ${toolName}`);
        const questionList = Array.isArray(input.questions)
          ? input.questions.map((item) => {
              const question = item as Record<string, unknown>;
              return String(question.question ?? question.header ?? "Pregunta del agente");
            }).join("\n")
          : "";
        const details = { toolName, approvalKey, input: safeJson(input), displayName: options.displayName, blockedPath: options.blockedPath };
        const answer = await createClaudeDecision(
          state, agent, sessionId, isQuestion ? "question" : "permission", title,
          isQuestion ? questionList || "Claude necesita que aclares un punto antes de continuar." : (options.description ?? `Claude solicita ejecutar ${toolName}.`),
          details, options.signal
        );
        if (isQuestion && answer.action === "answer") {
          return {
            behavior: "deny",
            message: `Respuesta del usuario: ${sanitizeText(answer.answer ?? "")}. Usa esta respuesta para continuar sin repetir la pregunta.`,
            toolUseID: options.toolUseID
          };
        }
        if (answer.action === "allow") return { behavior: "allow", toolUseID: options.toolUseID };
        return {
          behavior: "deny",
          message: answer.action === "answer" ? answer.answer ?? "La acción no fue autorizada." : "El usuario rechazó esta operación.",
          toolUseID: options.toolUseID
        };
      }
    }
  });

  try {
    for await (const message of stream) {
      const record = message as unknown as Record<string, unknown>;
      const messageSessionId = typeof record.session_id === "string" ? record.session_id : null;
      if (messageSessionId && messageSessionId !== sessionId) {
        sessionId = messageSessionId;
        updateExecutionAgent(agent.id, { sessionId });
        addLog(state.runId, agent.agentId.toUpperCase(), "info", `Sesión Claude Code: ${sessionId}.`, agent.id);
      }
      if (record.type === "assistant" && record.message && typeof record.message === "object") {
        const content = (record.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              // Assistant events are streamed content blocks (often several
              // per turn). Keep them for activity visibility, not as the
              // canonical handoff; the SDK result event carries the final text.
              addLog(state.runId, agent.agentId.toUpperCase(), "success", block.text, agent.id);
            } else if (block.type === "tool_use") {
              const toolName = String(block.name ?? "herramienta");
              const input = block.input && typeof block.input === "object" ? JSON.stringify(safeJson(block.input)).slice(0, 700) : "";
              addLog(state.runId, agent.agentId.toUpperCase(), "info", `TOOL ${toolName}${input ? " · " + input : ""}`, agent.id);
            }
          }
        }
      } else if (record.type === "result") {
        const canonicalResult = extractClaudeFinalText(record);
        if (canonicalResult) {
          finalText = canonicalResult;
          addLog(state.runId, agent.agentId.toUpperCase(), "success", "Turno de Claude Code completado; respuesta final canónica capturada.", agent.id);
        } else {
          const providerErrors = Array.isArray(record.errors)
            ? record.errors.filter((item): item is string => typeof item === "string")
            : [];
          const detail = providerErrors.join(" | ") || (typeof record.result === "string" ? record.result : "");
          resultFailure = record.subtype === "success" && record.is_error !== true
            ? "Claude Code informó éxito, pero no entregó texto final canónico en el evento result."
            : "Claude Code terminó con estado " + String(record.subtype ?? "error") + (detail ? ": " + sanitizeText(detail) : ".");
          addLog(state.runId, agent.agentId.toUpperCase(), "warning", resultFailure, agent.id);
        }
      } else if (record.type === "system" && record.subtype === "init") {
        const mcpStatuses = Array.isArray(record.mcp_servers)
          ? (record.mcp_servers as Array<Record<string, unknown>>).map((server) =>
              String(server.name ?? "servidor") + "=" + String(server.status ?? "desconocido") +
              (server.source ? " (source=" + String(server.source) + ")" : "")
            ).join(", ")
          : "no informado por esta versión del SDK";
        addLog(state.runId, agent.agentId.toUpperCase(), "info",
          "Claude Code inicializó el contexto de trabajo. MCP: " + mcpStatuses + ".", agent.id);
      } else if (record.type === "tool_progress") {
        addLog(state.runId, agent.agentId.toUpperCase(), "info", "Herramienta de Claude Code en ejecución.", agent.id);
      }
      if (state.cancelled) break;
    }
  } finally {
    state.claudeControllers.delete(agent.id);
  }
  if (state.cancelled) throw new Error("Ejecución cancelada por el usuario.");
  if (resultFailure) throw new Error(resultFailure);
  if (!finalText.trim()) throw new Error("Claude Code finalizó sin una respuesta verificable.");
  return finalText.trim();
}

async function validateClaudeProvider(): Promise<void> {
  const provider = getClaudeProviderPreference();
  let config: Awaited<ReturnType<typeof readClaudeLocalConfig>> | null = null;
  try {
    config = await readClaudeLocalConfig();
  } catch {
    // La sesión OAuth oficial de Claude Code también puede autenticar el motor.
  }
  if (provider === "opencode-go") {
    if (!config || config.baseUrl !== "https://opencode.ai/inference/go/anthropic") {
      throw new Error("OpenCode Go para Claude Code requiere ANTHROPIC_BASE_URL=https://opencode.ai/inference/go/anthropic. El endpoint /zen/go no es el endpoint Anthropic documentado actualmente.");
    }
    if (!config.hasCredential || !config.model) {
      throw new Error("No se detectó ANTHROPIC_AUTH_TOKEN/API_KEY o ANTHROPIC_MODEL en la configuración local de OpenCode Go.");
    }
  } else if (provider === "apmix") {
    if (!config || config.baseUrl !== "https://api.apmix.ai") {
      throw new Error("APMix está seleccionado, pero la configuración local no apunta a https://api.apmix.ai.");
    }
    if (!config.hasCredential) throw new Error("No se detectó una credencial APMix en la configuración local.");
  } else if (config && config.baseUrl && config.baseUrl !== "https://api.anthropic.com") {
    throw new Error("Anthropic oficial está seleccionado, pero ~/.claude/settings.json apunta a otro proveedor.");
  }
}

async function executeRun(
  state: RuntimeState,
  projectPath: string,
  instructions: string,
  factoryRoot: string,
  agents: AgentInput[],
  depthOverride: ResearchDepth | undefined,
  workflow: {
    threadId: string | null;
    roundNumber: number;
    continuityContext: string;
    skillContent: string;
    roleInstructions: Record<string, string>;
  }
): Promise<void> {
  let workflowResponseSaved = false;
  const failures: string[] = [];
  const activeAgents = agents.filter((agent) => agent.enabled);
  const allResults: AgentResult[] = [];
  const handoffOutByAgent = new Map<string, HandoffDescriptor[]>();
  let cloudArbiterOutput: string | null = null;

  try {
    const openCodeAgents = activeAgents.some((agent) => agent.engine === "opencode");
    const needsClaude = activeAgents.some((agent) => agent.engine === "claude");
    let openCodeReady = !openCodeAgents;
    let claudeReady = !needsClaude;

    if (openCodeAgents) {
      try {
        state.openCode = await startOpenCodeRuntime(projectPath, factoryRoot, state.runId);
        openCodeReady = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addLog(state.runId, "OPENCODE", "warning", "No fue posible iniciar el motor OpenCode: " + message);
        for (const agent of activeAgents.filter((item) => item.engine === "opencode")) {
          updateExecutionAgent(agent.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
          failures.push(agent.agentId);
        }
      }
    }
    if (needsClaude) {
      try {
        await validateClaudeProvider();
        claudeReady = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addLog(state.runId, "CLAUDE", "warning", message);
        for (const agent of activeAgents.filter((item) => item.engine === "claude")) {
          updateExecutionAgent(agent.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
          failures.push(agent.agentId);
        }
      }
    }

    const taskPlan = planTask(instructions, depthOverride);
    addLog(state.runId, "PLANNER", "success",
      "Plan " + taskPlan.depth + ": " + taskPlan.recommendedAgents.length +
      " agentes recomendados. Cambios esperados: " + (taskPlan.changesExpected ? "sí" : "no") + ".");
    const depthGuidance = taskPlan.depth === "quick"
      ? "INVESTIGACIÓN RÁPIDA: lee primero README.md y manifiestos. Consulta solo lo necesario para responder con evidencia."
      : taskPlan.depth === "focused"
        ? "INVESTIGACIÓN FOCALIZADA: identifica el módulo relacionado y sigue sus dependencias directas. Evita explorar áreas no relacionadas."
        : "INVESTIGACIÓN PROFUNDA: realiza un análisis sistemático del alcance solicitado y respalda conclusiones con rutas y archivos.";
    const structuralContext = [
      workflow.threadId
        ? "PROCESO PERSISTENTE: " + workflow.threadId + " · RONDA: " + workflow.roundNumber +
          ". Conserva el objetivo original; trata la instrucción actual como el siguiente paso del mismo trabajo."
        : "Ejecución independiente sin hilo conversacional persistente.",
      workflow.continuityContext
        ? "HISTORIAL Y CONTEXTO RECUPERADO DEL PROCESO:\n" + workflow.continuityContext
        : "No hay rondas anteriores para recuperar.",
      workflow.skillContent ? "SKILL COMPARTIDA — CONTINUIDAD DE TRABAJO:\n" + workflow.skillContent : "",
      "Planificador: " + taskPlan.kind + "; complejidad " + taskPlan.complexity + "; profundidad " + taskPlan.depth + ".",
      depthGuidance,
      "Repositorio: " + projectPath,
      "Cambios esperados por el planificador: " + (taskPlan.changesExpected ? "sí" : "no"),
      "Cada agente recibe los handoffs de las olas anteriores, con identidad, motor, modelo, sesión e intervalo temporal."
    ].join(String.fromCharCode(10));

    const eligible = activeAgents.filter((agent) =>
      (agent.engine !== "opencode" || openCodeReady) &&
      (agent.engine !== "claude" || claudeReady)
    );

    const executeAgent = async (agent: AgentInput, inbound: AgentResult[]): Promise<AgentResult> => {
      const handoffId = createHandoffId(agent.agentId, state.runId);
      const startedAt = new Date().toISOString();
      if (state.cancelled) {
        const cancelled: AgentResult = {
          agentRunId: agent.id, agentId: agent.agentId, engine: agent.engine, modelId: agent.modelId,
          sessionId: null, status: "cancelled", startedAt, finishedAt: new Date().toISOString(),
          handoffId, output: "La fase fue cancelada por el usuario."
        };
        updateExecutionAgent(agent.id, { status: "cancelled", error: "Cancelado por el usuario.", startedAt, finishedAt: cancelled.finishedAt });
        return cancelled;
      }

      const delivered: HandoffDescriptor[] = inbound.map((result) =>
        createHandoffDescriptor(result, agent.agentId, agent.id, agent.engine)
      );
      updateExecutionAgent(agent.id, { handoffIn: delivered });
      for (let index = 0; index < inbound.length; index++) {
        const source = inbound[index];
        const descriptor = delivered[index];
        if (!source || !descriptor) continue;
        const outgoing = handoffOutByAgent.get(source.agentRunId) ?? [];
        outgoing.push(descriptor);
        handoffOutByAgent.set(source.agentRunId, outgoing);
        updateExecutionAgent(source.agentRunId, { handoffOut: outgoing });
        addLog(state.runId, "HANDOFF", "success",
          descriptor.id + " entregado de " + source.agentId + " (" + source.engine + ") a " +
          agent.agentId + " (" + agent.engine + ").", agent.id);
      }

      updateExecutionAgent(agent.id, { status: "running", startedAt, error: null });
      updateExecutionRun(state.runId, state.pendingCount > 0 ? "waiting" : "running");
      addLog(state.runId, agent.agentId.toUpperCase(), "info",
        "Comienza la fase. Motor: " + agent.engine + ". Modelo: " + agent.modelId +
        ". Permisos: " + agent.permissionProfile + ". INBOUND: " +
        (delivered.length ? delivered.map((item) => item.id).join(", ") : "ninguno; ejecución independiente de esta ola") + ".",
        agent.id);

      try {
        const roleInstructions = workflow.roleInstructions[agent.agentId] ??
          await loadRoleInstructions(factoryRoot, agent.agentId);
        const arbiterLedger = agent.agentId === "cloud-arbiter"
          ? getExecutionSnapshot(state.runId)
          : null;
        const roster = arbiterLedger?.agents.map((item) =>
          item.agentId + " | motor=" + item.engine + " | modelo=" + item.modelId +
          " | estado=" + item.status + " | sesión=" + (item.sessionId ?? (item.agentId === "cloud-arbiter" && item.status === "running"
            ? "se asignará durante la inicialización de esta fase; consultar el ledger final"
            : "no disponible")) +
          " | inicio=" + (item.startedAt ?? "no iniciado") + " | fin=" + (item.finishedAt ?? "pendiente") +
          " | handoff-out=" + (item.handoffOut.map((handoff) => handoff.id + "→" + handoff.toAgent).join(", ") || "ninguno")
        ).join("; ") ?? "registro no disponible";
        const approvalEvents = arbiterLedger ? getExecutionApprovalEvents(state.runId) : [];
        const approvalAudit = arbiterLedger
          ? formatApprovalAuditContext(
              arbiterLedger.decisionHistory.map((decision) => ({
                id: decision.id,
                agentId: arbiterLedger.agents.find((item) => item.id === decision.agentRunId)?.agentId ?? "agente desconocido",
                engine: decision.engine,
                kind: decision.kind,
                status: decision.status,
                title: decision.title,
                description: decision.description,
                response: decision.response,
                createdAt: decision.createdAt,
                resolvedAt: decision.resolvedAt
              })),
              approvalEvents.map((event) => ({
                area: event.area,
                message: event.message,
                createdAt: event.createdAt,
                agentRunId: event.agentRunId
              }))
            )
          : "No se pudo recuperar el ledger de decisiones de esta ejecución.";
        const agentStructuralContext = agent.agentId === "cloud-arbiter"
          ? [
              structuralContext,
              "REGISTRO REAL DE PARTICIPACIÓN (FUENTE DE VERDAD): " + roster,
              "REGISTRO DE DECISIONES Y APROBACIONES (FUENTE DE VERDAD):",
              approvalAudit,
              "Estos registros pertenecen exclusivamente a la ejecución actual y prevalecen sobre las afirmaciones textuales de los handoffs.",
              "La sesión propia del Cloud Arbiter se asigna después de construir este contexto. Si el roster dice que se asignará durante la inicialización, no informes que la sesión está ausente; el ledger final contiene el ID definitivo."
            ].join(String.fromCharCode(10))
          : structuralContext;
        const prompt = makeAgentPrompt(
          agent, instructions, roleInstructions, agentStructuralContext, inbound, handoffId, taskPlan.changesExpected
        );
        const output = agent.engine === "opencode"
          ? await runOpenCodeAgent(state, agent, projectPath, factoryRoot, prompt)
          : await runClaudeAgent(state, agent, projectPath, factoryRoot, prompt, roleInstructions);
        const finishedAt = new Date().toISOString();
        const snapshot = getExecutionSnapshot(state.runId);
        const sessionId = snapshot?.agents.find((item) => item.id === agent.id)?.sessionId ?? null;
        const handoffOutput = prepareHandoffOutput(redactSecrets(output), handoffId);
        const result: AgentResult = {
          agentRunId: agent.id, agentId: agent.agentId, engine: agent.engine, modelId: agent.modelId,
          sessionId, status: "succeeded", startedAt, finishedAt, handoffId,
          output: handoffOutput.content, handoffOutput
        };
        // Once the recipient session exists, close the handoff evidence with
        // the real receiving session ID in both source and destination records.
        const completedInbound = delivered.map((item) => ({ ...item, toSessionId: sessionId }));
        updateExecutionAgent(agent.id, {
          status: "succeeded", finishedAt, error: null,
          handoffIn: completedInbound,
          handoffOut: handoffOutByAgent.get(agent.id) ?? [],
          handoffOutput
        });
        for (const handoff of completedInbound) {
          const sourceAgent = getExecutionSnapshot(state.runId)?.agents.find((item) => item.id === handoff.fromAgentRunId);
          if (sourceAgent) {
            const updatedOutbound = sourceAgent.handoffOut.map((existing) =>
              existing.id === handoff.id && existing.toAgentRunId === handoff.toAgentRunId ? handoff : existing
            );
            updateExecutionAgent(sourceAgent.id, { handoffOut: updatedOutbound });
          }
        }
        addLog(state.runId, "HANDOFF", "success", JSON.stringify({
          id: handoffId, agentId: agent.agentId, engine: agent.engine, modelId: agent.modelId,
          sessionId, startedAt, finishedAt, inbound: delivered.map((item) => item.id)
        }), agent.id);
        addLog(state.runId, agent.agentId.toUpperCase(), "success", "Fase " + agent.agentId + " terminada.", agent.id);
        if (agent.agentId === "cloud-arbiter") cloudArbiterOutput = handoffOutput.content;
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        if (state.cancelled) {
          updateExecutionAgent(agent.id, {
            status: "cancelled",
            error: "Cancelado por el usuario.",
            finishedAt
          });
          return {
            agentRunId: agent.id, agentId: agent.agentId, engine: agent.engine, modelId: agent.modelId,
            sessionId: getExecutionSnapshot(state.runId)?.agents.find((item) => item.id === agent.id)?.sessionId ?? null,
            status: "cancelled", startedAt, finishedAt, handoffId, output: "La fase fue cancelada por el usuario."
          };
        }
        failures.push(agent.agentId);
        updateExecutionAgent(agent.id, { status: "failed", error: sanitizeText(message), finishedAt });
        orphanExecutionDecisionsForAgent(state.runId, agent.id);
        if (agent.engine === "opencode") {
          const runtime = state.openCode;
          const sessionId = runtime?.sessions.get(agent.id);
          if (runtime && sessionId && !runtime.closing) {
            await openCodeRequest(runtime, "POST", "/api/session/" + encodeURIComponent(sessionId) + "/interrupt").catch(() => undefined);
          }
        }
        addLog(state.runId, agent.agentId.toUpperCase(), "warning", "Fase fallida: " + message, agent.id);
        return {
          agentRunId: agent.id, agentId: agent.agentId, engine: agent.engine, modelId: agent.modelId,
          sessionId: getExecutionSnapshot(state.runId)?.agents.find((item) => item.id === agent.id)?.sessionId ?? null,
          status: "failed", startedAt, finishedAt, handoffId, output: "FASE FALLIDA: " + sanitizeText(message)
        };
      }
    };

    const runWave = async (waveId: string, agentIds: string[]): Promise<void> => {
      const waveAgents = eligible.filter((agent) => agentIds.includes(agent.agentId));
      if (!waveAgents.length || state.cancelled) return;
      const waveStartedAt = new Date().toISOString();
      const groups: Array<{ engine: EngineId; agents: AgentInput[] }> = [
        { engine: "claude" as EngineId, agents: waveAgents.filter((agent) => agent.engine === "claude") },
        { engine: "opencode" as EngineId, agents: waveAgents.filter((agent) => agent.engine === "opencode") }
      ].filter((group) => group.agents.length > 0);
      addLog(state.runId, "ORCHESTRATOR", "success",
        "OLA " + waveId + " iniciada. Ejecución simultánea entre motores; secuencial dentro de cada motor. Agentes: " +
        waveAgents.map((agent) => agent.agentId + " [" + agent.engine + "]").join(", ") + ".");
      const groupResults = await Promise.all(groups.map(async (group) => {
        const localResults: AgentResult[] = [];
        for (const agent of group.agents) {
          if (state.cancelled) break;
          const result = await executeAgent(agent, [...allResults, ...localResults]);
          localResults.push(result);
        }
        return localResults;
      }));
      const waveResults = groupResults.flat().sort((left, right) =>
        (left.finishedAt ?? "").localeCompare(right.finishedAt ?? "")
      );
      allResults.push(...waveResults);
      addLog(state.runId, "ORCHESTRATOR", "success",
        "OLA " + waveId + " finalizada. " + waveResults.filter((item) => item.status === "succeeded").length +
        "/" + waveAgents.length + " fases completadas. Inicio de ola: " + waveStartedAt + ".");
    };

    // Four explicit collaboration stages. The two engines investigate independently
    // in waves 1 and 3; later waves receive all completed handoffs from both engines.
    await runWave("01 · DESCUBRIMIENTO", ["architect", "build", "reverse"]);
    await runWave("02 · IMPLEMENTACIÓN / PROPUESTA", ["implementer"]);
    await runWave("03 · REVISIÓN CRUZADA", ["reviewer", "tester"]);
    await runWave("04 · ARBITRAJE FINAL", ["cloud-arbiter"]);

    const snapshot = getExecutionSnapshot(state.runId);
    if (!snapshot) throw new Error("No se pudo recuperar el registro final de la ejecución.");
    const agentIdByRunId = new Map(snapshot.agents.map((agent) => [agent.id, agent.agentId]));
    const summary = buildExecutionSummary({
      instructions,
      agents: snapshot.agents,
      results: allResults,
      cloudArbiterOutput,
      decisions: snapshot.decisionHistory.map((decision) => ({
        id: decision.id,
        agentId: agentIdByRunId.get(decision.agentRunId) ?? "agente desconocido",
        engine: decision.engine,
        kind: decision.kind,
        status: decision.status,
        title: decision.title,
        description: decision.description,
        response: decision.response,
        createdAt: decision.createdAt,
        resolvedAt: decision.resolvedAt
      })),
      approvalEvents: getExecutionApprovalEvents(state.runId).map((event) => ({
        area: event.area,
        message: event.message,
        createdAt: event.createdAt,
        agentRunId: event.agentRunId
      }))
    });
    updateExecutionSummary(state.runId, summary);
    addLog(state.runId, "EXECUTIVE-SUMMARY", summary.verdict === "failed" ? "warning" : "success",
      JSON.stringify(summary));

    const hasFailed = snapshot.agents.some((agent) => agent.status === "failed") || failures.length > 0;
    const terminalStatus: ExecutionStatus = state.cancelled ? "cancelled" : hasFailed ? "failed" : "succeeded";
    if (workflow.threadId) {
      const finalStatus = state.cancelled || hasFailed ? "failed" : "completed";
      const response = [
        "Ronda " + workflow.roundNumber + " · " + (state.cancelled ? "Cancelada" : hasFailed ? "Terminada con errores" : "Completada"),
        summary.headline,
        summary.overview,
        summary.findings.length ? "Hallazgos: " + summary.findings.join(" | ") : "",
        summary.nextSteps.length ? "Siguientes pasos: " + summary.nextSteps.join(" | ") : ""
      ].filter(Boolean).join("\n\n");
      addWorkMessage(workflow.threadId, state.runId, workflow.roundNumber, "assistant", response, "round-summary");
      updateWorkThreadStatus(workflow.threadId, finalStatus);
      workflowResponseSaved = true;
    }
    // Publish a terminal run status only after its durable conversation response exists.
    updateExecutionRun(state.runId, terminalStatus, true);
    addLog(state.runId, "ORCHESTRATOR", terminalStatus === "succeeded" ? "success" : "warning",
      terminalStatus === "succeeded"
        ? "Ejecución completada. El resumen ejecutivo y el ledger de handoffs están disponibles."
        : terminalStatus === "cancelled"
          ? "Ejecución cancelada por el usuario."
          : "Ejecución terminada con una o más fases fallidas. Consulta el resumen ejecutivo y los logs.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog(state.runId, "ORCHESTRATOR", "warning", "Ejecución interrumpida: " + message);
    if (workflow.threadId && !workflowResponseSaved) {
      addWorkMessage(workflow.threadId, state.runId, workflow.roundNumber, "assistant",
        "Ronda " + workflow.roundNumber + " fallida: " + sanitizeText(message), "round-error");
      updateWorkThreadStatus(workflow.threadId, "failed");
      workflowResponseSaved = true;
    }
    updateExecutionRun(state.runId, state.cancelled ? "cancelled" : "failed", true);
  } finally {
    for (const controller of state.claudeControllers.values()) controller.abort();
    if (state.openCode && !state.openCode.closing) {
      state.openCode.closing = true;
      state.openCode.child.kill("SIGTERM");
      state.openCode.password = "";
    }
    for (const resolver of state.resolvers.values()) resolver({ action: "deny" });
    state.resolvers.clear();
    state.openCodeRunApprovals.clear();
    state.seenOpenCodePermissionRequests.clear();
    state.claudeRunApprovalKeys.clear();
    runtimeByRun.delete(state.runId);
  }
}

export interface StartExecutionOptions {
  threadId?: string | null;
  roundNumber?: number;
  continuityContext?: string;
}

export async function startExecution(
  projectPath: string,
  instructions: string,
  factoryRoot: string,
  depthOverride?: ResearchDepth,
  options: StartExecutionOptions = {}
): Promise<{ runId: string }> {
  // Acquire synchronously before the first await so simultaneous HTTP requests cannot
  // both pass the active-run check while project/configuration preparation is in flight.
  const releaseStartReservation = executionStartGate.tryAcquire();
  if (!releaseStartReservation) {
    throw new Error("Ya se está preparando otra ejecución. Espera a que comience o termine antes de iniciar otra.");
  }
  try {
    // A cancelled run remains exclusive until executeRun() finishes its cleanup.
    if (runtimeByRun.size > 0) {
      throw new Error("Ya hay una ejecución activa o en proceso de cancelación. Espera a que termine antes de comenzar otra.");
    }
    const resolvedProjectPath = await requireCanonicalProjectRoot(projectPath);
    if (!instructions.trim()) throw new Error("Escribe las instrucciones que deben ejecutar los agentes.");
    const assignments = listAssignments();
    const enabledAssignments = assignments.filter((item) => item.enabled);
    if (!enabledAssignments.length) throw new Error("No hay agentes habilitados. Activa al menos uno y guarda el equipo.");
    if (enabledAssignments.some((item) => item.engine === "opencode") && !(await stat(opencodeBinary).catch(() => null))) {
      throw new Error("No se encontró OpenCode en ~/.opencode/bin/opencode.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const agents: AgentInput[] = assignments.map((assignment) => ({
      id: randomUUID(), runId: id, agentId: assignment.agentId,
      engine: assignment.engine, modelId: assignment.modelId,
      permissionProfile: assignment.permissionProfile, enabled: assignment.enabled
    }));
    const roundNumber = Math.max(1, Math.floor(options.roundNumber ?? 1));
    const continuityContext = (options.continuityContext ?? "").slice(0, 28000);
    const roleEntries = await Promise.all(assignments.map(async (assignment) => {
      const roleText = await loadRoleInstructions(factoryRoot, assignment.agentId);
      return [assignment.agentId, roleText, createHash("sha256").update(roleText).digest("hex")] as const;
    }));
    const roleInstructions = Object.fromEntries(roleEntries.map(([agentId, roleText]) => [agentId, roleText]));
    const roleDigests = Object.fromEntries(roleEntries.map(([agentId, _roleText, digest]) => [agentId, digest]));
    const workflowSkillSource = options.threadId
      ? await readFile(join(factoryRoot, ".opencode", "skills", "continuous-workflow", "SKILL.md"), "utf8").catch(() => "")
      : "";
    createExecutionRecords({
      id, projectPath: resolvedProjectPath, instructions: instructions.trim(),
      status: "queued", startedAt: now,
      threadId: options.threadId ?? null,
      roundNumber,
      continuityContext,
      configurationSnapshot: {
        capturedAt: now,
        claudeProvider: getClaudeProviderPreference(),
        favorites: listFavoriteModels(),
        assignments: assignments.map((item) => ({ ...item })),
        roleInstructionDigests: roleDigests,
        roleInstructions,
        workflowSkillDigest: workflowSkillSource
          ? createHash("sha256").update(workflowSkillSource).digest("hex") : null,
        workflowSkillContent: workflowSkillSource
      }
    }, agents.map((agent) => ({
      id: agent.id, agentId: agent.agentId, engine: agent.engine,
      modelId: agent.modelId, permissionProfile: agent.permissionProfile,
      status: agent.enabled ? "queued" : "skipped",
      error: agent.enabled ? null : "Deshabilitado en la configuración del equipo; se registra explícitamente y no se ejecuta.",
      finishedAt: null
    })));
    const state: RuntimeState = {
      runId: id, cancelled: false, claudeControllers: new Map(),
      resolvers: new Map(), pendingCount: 0,
      openCodeRunApprovals: new Map(), seenOpenCodePermissionRequests: new Set(), claudeRunApprovalKeys: new Map()
    };
    try {
      addLog(id, "ORCHESTRATOR", "success",
        "Ejecución creada para " + resolvedProjectPath + ". " + enabledAssignments.length +
        " agentes habilitados y " + (assignments.length - enabledAssignments.length) +
        " deshabilitados (registrados explícitamente como skipped)." +
        (options.threadId ? " Proceso persistente " + options.threadId + " · ronda " + roundNumber + "." : ""));
    } catch (error) {
      try { updateExecutionRun(id, "failed", true); } catch { /* Preserve the original startup error. */ }
      throw error;
    }
    runtimeByRun.set(id, state);
    void executeRun(state, resolvedProjectPath, instructions.trim(), factoryRoot, agents, depthOverride, {
      threadId: options.threadId ?? null, roundNumber, continuityContext,
      skillContent: workflowSkillSource, roleInstructions
    });
    return { runId: id };
  } finally {
    releaseStartReservation();
  }
}

export function getLatestExecution(): ExecutionSnapshot | null {
  const id = getLatestExecutionId();
  return id ? getExecutionSnapshot(id) : null;
}
export function getExecution(runId: string): ExecutionSnapshot | null {
  return getExecutionSnapshot(runId);
}
export function recoverExecutionState(): void {
  markUnfinishedExecutionsInterrupted();
}

export async function cancelExecution(runId: string): Promise<void> {
  const state = runtimeByRun.get(runId);
  if (!state) throw new Error("La ejecución no está activa en este proceso. Puede haber terminado o el servicio se reinició.");
  state.cancelled = true;
  for (const controller of state.claudeControllers.values()) controller.abort();
  for (const resolver of state.resolvers.values()) resolver({ action: "deny" });
  state.resolvers.clear();
  if (state.openCode) {
    for (const sessionId of state.openCode.sessions.values()) {
      await openCodeRequest(state.openCode, "POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => undefined);
    }
    state.openCode.child.kill("SIGTERM");
    state.openCode.password = "";
    state.openCode.closing = true;
  }
  const snapshot = getExecutionSnapshot(runId);
  for (const agent of snapshot?.agents ?? []) {
    if (["queued", "running", "waiting"].includes(agent.status)) {
      updateExecutionAgent(agent.id, { status: "cancelled", error: "Cancelado por el usuario.", finishedAt: new Date().toISOString() });
    }
  }
  orphanExecutionDecisions(runId);
  updateExecutionRun(runId, "cancelled", true);
  addLog(runId, "ORCHESTRATOR", "warning", "Se solicitó cancelar la ejecución.");
}

export async function respondExecutionDecision(
  runId: string,
  decisionId: string,
  response: DecisionAnswer
): Promise<void> {
  const decision = getExecutionDecision(decisionId);
  if (!decision || decision.runId !== runId || decision.status !== "pending") {
    throw new Error("La solicitud ya fue respondida, está siendo procesada o no pertenece a esta ejecución.");
  }
  const state = runtimeByRun.get(runId);
  if (!state) throw new Error("La sesión del motor ya no está activa. Reanuda la ejecución desde el motor o inicia una nueva.");
  if (decision.kind === "question" && response.action !== "answer") {
    throw new Error("Las solicitudes de aclaración requieren una respuesta escrita; no admiten permisos persistentes.");
  }

  const openCodeRuntime = decision.engine === "opencode" ? state.openCode : undefined;
  if (decision.engine === "opencode" && (!openCodeRuntime || !decision.engineSessionId || !decision.engineRequestId)) {
    throw new Error("No se encontró la sesión OpenCode asociada a esta solicitud.");
  }
  const claudeResolver = decision.engine === "claude" ? state.resolvers.get(decisionId) : undefined;
  if (decision.engine === "claude" && !claudeResolver) {
    throw new Error("La solicitud ya no tiene un agente Claude esperando una respuesta.");
  }

  const details = decision.details && typeof decision.details === "object"
    ? decision.details as OpenCodePermission
    : {};
  const addedRules = decision.engine === "opencode" && decision.kind === "permission" && response.action === "allow-run"
    ? buildRunApprovalPatterns(details)
    : [];
  if (decision.engine === "opencode" && decision.kind === "permission" &&
      response.action === "allow-run" && addedRules.length === 0) {
    throw new Error("OpenCode no propuso recursos concretos que puedan recordarse de forma segura. Aprueba esta operación una sola vez.");
  }

  // Claim the row before making an asynchronous provider call. Only one request
  // can transition pending -> responding; a second browser click gets HTTP 409.
  if (!claimExecutionDecision(decisionId)) {
    throw new Error("Otra solicitud ya está respondiendo esta decisión. Actualiza el Centro de decisiones.");
  }

  let claimHeld = true;
  let engineConsumedRequest = false;
  try {
    if (decision.engine === "opencode") {
      const runtime = openCodeRuntime!;
      const sessionId = decision.engineSessionId!;
      const requestId = decision.engineRequestId!;

      if (decision.kind === "permission") {
        if (response.action === "answer") throw new Error("Esta solicitud requiere aprobar o rechazar la acción.");
        try {
          await replyOpenCodePermission(
            runtime,
            sessionId,
            requestId,
            response.action === "deny" ? "reject" : "once",
            response.answer
          );
          engineConsumedRequest = true;
        } catch (error) {
          const pendingPayload = await openCodeRequest<unknown>(
            runtime, "GET", `/api/session/${encodeURIComponent(sessionId)}/permission`
          ).catch(() => null);
          const requestStillPending = pendingPayload !== null &&
            parseOpenCodeData<OpenCodePermission>(pendingPayload).some((item) => item.id === requestId);
          if (!requestStillPending) {
            const reason = pendingPayload === null
              ? "No se pudo reconciliar con OpenCode si la solicitud sigue pendiente. Se marcó como huérfana para impedir una segunda aprobación."
              : "OpenCode ya no conserva esta solicitud pendiente; se retiró de la cola para evitar una aprobación fantasma.";
            if (resolveExecutionDecision(decisionId, "orphaned", reason)) claimHeld = false;
            addLog(runId, "HUMAN-REVIEW", "warning", reason, decision.agentRunId);
            throw new Error(reason);
          }
          // OpenCode confirms the permission is still pending; the outer catch
          // may safely release the claim so the user can retry.
          throw error;
        }

        const resolved = resolveExecutionDecision(
          decisionId,
          response.action === "deny" ? "rejected" : "approved",
          response.action === "allow-run"
            ? `Aprobado durante esta ejecución: ${addedRules.map((rule) => `${rule.action}: ${rule.resource}`).join("; ")}`
            : response.action === "allow" ? "Aprobado una vez." : "Rechazado."
        );
        if (!resolved) throw new Error("OpenCode consumió la solicitud, pero no se pudo persistir su decisión; se marcará para revisión.");
        claimHeld = false;
        if (response.action === "allow-run") {
          addAgentRunApprovals(state.openCodeRunApprovals, decision.agentRunId, addedRules);
        }

        if (response.action === "deny") {
          // OpenCode rejects other pending permission requests in the same session.
          const siblings = getExecutionSnapshot(runId)?.decisions.filter((item) =>
            item.id !== decisionId && item.status === "pending" && item.engine === "opencode" &&
            item.kind === "permission" && item.engineSessionId === sessionId
          ) ?? [];
          for (const sibling of siblings) {
            if (resolveExecutionDecision(sibling.id, "rejected", "OpenCode rechazó las demás solicitudes pendientes de esta sesión.")) {
              addLog(runId, "HUMAN-REVIEW", "warning", "Solicitud rechazada junto con otra autorización de la misma sesión OpenCode.", sibling.agentRunId);
            }
          }
        }
        addLog(runId, "HUMAN-REVIEW", "success",
          response.action === "allow-run"
            ? `Autorización limitada a esta ejecución: ${decision.title}.`
            : `Solicitud atendida: ${decision.title}.`,
          decision.agentRunId
        );
      } else {
        if (response.action !== "answer") throw new Error("Esta solicitud requiere una respuesta escrita.");
        const metadata = details.metadata && typeof details.metadata === "object"
          ? details.metadata as Record<string, unknown>
          : details;
        const fields = Array.isArray(metadata.fields) ? metadata.fields as Array<Record<string, unknown>> : [];
        let answers: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(response.answer ?? "");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answers = parsed as Record<string, unknown>;
          else throw new Error("La respuesta JSON debe ser un objeto.");
        } catch (error) {
          if (error instanceof Error && error.message === "La respuesta JSON debe ser un objeto.") throw error;
          if (fields.length > 1) throw new Error("El formulario tiene varios campos. Envía un objeto JSON con una respuesta por cada clave de campo.");
          if (fields.length === 1) {
            const field = fields[0];
            if (!field) throw new Error("No se encontró el campo que debe responderse.");
            const key = String(field.key ?? "answer");
            if (field.type === "boolean") answers[key] = /^(si|sí|true|1|yes)$/i.test(response.answer ?? "");
            else if (field.type === "number") {
              const number = Number(response.answer);
              if (!Number.isFinite(number)) throw new Error("La respuesta debe ser un número válido.");
              answers[key] = number;
            } else answers[key] = response.answer ?? "";
          } else answers.answer = response.answer ?? "";
        }
        try {
          await openCodeRequest(runtime, "POST",
            `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`,
            { answer: answers }
          );
          engineConsumedRequest = true;
        } catch (error) {
          const definitiveRejection = error instanceof Error &&
            /OpenCode API HTTP (400|401|403|405|409|422):/.test(error.message);
          engineConsumedRequest = !definitiveRejection;
          throw error;
        }
        if (!resolveExecutionDecision(decisionId, "answered", response.answer ?? "")) {
          throw new Error("OpenCode aceptó la respuesta, pero no se pudo confirmar en el ledger.");
        }
        claimHeld = false;
        addLog(runId, "HUMAN-REVIEW", "success", `Solicitud atendida: ${decision.title}.`, decision.agentRunId);
      }
    } else {
      const resolver = claudeResolver!;
      let claudeApprovalKey: string | null = null;
      if (decision.kind === "permission" && response.action === "allow-run") {
        claudeApprovalKey = typeof details.approvalKey === "string" ? details.approvalKey : "";
        if (!claudeApprovalKey) throw new Error("No se pudo identificar la operación exacta de Claude para recordarla durante esta ejecución.");
        if (!decision.agentRunId) throw new Error("No se pudo vincular la autorización de Claude con el agente que la solicitó.");
      }
      const finalAnswer: DecisionAnswer = decision.kind === "question" && response.action !== "answer"
        ? { action: "answer", answer: response.action === "deny" ? "No, no continúes." : "Sí, continúa." }
        : response.action === "allow-run" ? { action: "allow" } : response;
      resolver(finalAnswer);
      engineConsumedRequest = true;
      const resolved = resolveExecutionDecision(
        decisionId,
        finalAnswer.action === "answer" ? "answered" : finalAnswer.action === "allow" ? "approved" : "rejected",
        response.action === "allow-run" ? "Aprobado para repetir esta misma operación durante esta ejecución." : finalAnswer.answer ?? ""
      );
      if (!resolved) throw new Error("Claude recibió la respuesta, pero no se pudo confirmar en el ledger.");
      claimHeld = false;
      if (claudeApprovalKey) {
        grantAgentRunApprovalKey(state.claudeRunApprovalKeys, decision.agentRunId, claudeApprovalKey);
      }
      addLog(runId, "HUMAN-REVIEW", "success",
        response.action === "allow-run"
          ? `Autorización limitada a la misma operación durante esta ejecución: ${decision.title}.`
          : `Solicitud atendida: ${decision.title}.`,
        decision.agentRunId
      );
    }
  } catch (error) {
    if (claimHeld) {
      if (engineConsumedRequest) {
        // The engine may have consumed the request even if persistence failed.
        // Never make it approvable a second time; fail closed and leave evidence.
        resolveExecutionDecision(
          decisionId,
          "orphaned",
          "El motor aceptó o pudo aceptar la respuesta, pero la fábrica no pudo confirmar el resultado. Revisión manual requerida."
        );
      } else {
        releaseExecutionDecisionClaim(decisionId);
      }
    }
    throw error;
  }
}
