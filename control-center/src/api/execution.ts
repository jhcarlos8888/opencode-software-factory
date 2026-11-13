import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { planTask, type ResearchDepth } from "./task-planner.js";
import {
  addExecutionEvent, createExecutionDecision, createExecutionRecords, getClaudeProviderPreference,
  getExecutionDecision, getExecutionSnapshot, getLatestExecutionId, listAssignments, markUnfinishedExecutionsInterrupted, orphanExecutionDecisions,
  resolveExecutionDecision, updateExecutionAgent, updateExecutionRun,
  type AgentAssignment, type EngineId, type ExecutionAgentRecord, type ExecutionDecisionRecord,
  type ExecutionSnapshot, type ExecutionStatus
} from "./database.js";

type DecisionAnswer = { action: "allow" | "deny" | "answer"; answer?: string };
type OpenCodeRuntime = {
  child: ChildProcess;
  baseUrl: string;
  password: string;
  sessions: Map<string, string>;
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
};
type AgentInput = {
  id: string;
  runId: string;
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: AgentAssignment["permissionProfile"];
};
type OpenCodePermission = {
  id?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

const runtimeByRun = new Map<string, RuntimeState>();
const opencodeBinary = join(homedir(), ".opencode", "bin", "opencode");
const readTools = new Set(["Read", "Glob", "Grep", "LS", "List", "Skill", "LSP", "TodoRead"]);
const writeTools = new Set(["Edit", "Write", "NotebookEdit"]);
const sensitivePathPattern = /(^|[/\\])(?:\.env(?:\.[^/\\]*)?|secrets?|credentials?|.*(?:token|apikey|api_key|private_key).*)($|[/\\])/i;
const secretTextPatterns = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s"' ,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)[^\s"' ,;]+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g
];

function sanitizeText(value: string): string {
  let result = value;
  for (const pattern of secretTextPatterns) result = result.replace(pattern, "$1[REDACTED]");
  return result.slice(0, 12000);
}
function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeText(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|password|secret|authorization|api.?key|credential/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = safeJson(entry);
  }
  return output;
}
function addLog(runId: string, area: string, kind: string, message: string, agentRunId: string | null = null): void {
  addExecutionEvent(runId, area, kind, sanitizeText(message), agentRunId);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function isWithinDirectory(directory: string, candidate: string): boolean {
  const rel = relative(directory, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Resolve a tool path against the canonical project directory. Resolving the
 * nearest existing ancestor also detects symlinks when the final file does
 * not exist yet (for example, a new file being written).
 */
async function resolveProjectCandidate(projectPath: string, candidate: unknown): Promise<string | null> {
  if (typeof candidate !== "string" || !candidate.trim()) return null;

  const projectRoot = await realpath(projectPath).catch(() => null);
  if (!projectRoot) return null;

  const suppliedPath = candidate.trim();
  const lexicalPath = isAbsolute(suppliedPath)
    ? resolve(suppliedPath)
    : resolve(projectRoot, suppliedPath);
  if (!isWithinDirectory(projectRoot, lexicalPath)) return null;

  let current = lexicalPath;
  const missingSegments: string[] = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      const existingAncestor = await realpath(current);
      const canonicalCandidate = resolve(existingAncestor, ...missingSegments);
      return isWithinDirectory(projectRoot, canonicalCandidate) ? canonicalCandidate : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
  return null;
}

function inputPath(input: Record<string, unknown>): unknown {
  return input.file_path ?? input.filePath ?? input.path ??
    input.notebook_path ?? input.notebookPath ?? input.uri;
}

function pathIsSensitive(pathValue: string, canonicalPath?: string): boolean {
  return sensitivePathPattern.test(pathValue) ||
    (canonicalPath !== undefined && sensitivePathPattern.test(canonicalPath));
}
function createPermissionRules(profile: AgentAssignment["permissionProfile"]) {
  // OpenCode V2 evaluates ordered rules with "last match wins".
  const rules: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> = [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "list", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" }
  ];

  if (profile === "read-only") {
    for (const action of ["edit", "shell", "subagent"]) {
      rules.push({ action, resource: "*", effect: "deny" });
    }
  } else if (profile === "workspace-write") {
    rules.push({ action: "edit", resource: "*", effect: "allow" });
    rules.push({ action: "subagent", resource: "*", effect: "deny" });
  }

  // Hard boundaries must be appended after broad profile rules because V2
  // resolves the last matching rule.
  rules.push({ action: "external_directory", resource: "*", effect: "deny" });
  const sensitiveResources = [
    "*.env*", "**/.env*", "**/.env.*", "**/secrets/**", "**/credentials/**",
    "**/*.pem", "**/*.key", "**/id_rsa*", "**/*token*", "**/*apikey*", "**/*api_key*"
  ];
  for (const action of ["read", "edit"]) {
    for (const resource of sensitiveResources) {
      rules.push({ action, resource, effect: "deny" });
    }
  }
  return rules;
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
    cwd: projectPath,
    env: {
      ...process.env,
      PATH: childPath,
      OPENCODE_CONFIG: join(factoryRoot, "opencode.json"),
      OPENCODE_CONFIG_DIR: join(factoryRoot, ".opencode")
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
          return { child, baseUrl, password, sessions: new Map(), serverErrors, closing: false };
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
  const snapshot = getExecutionSnapshot(state.runId);
  if (snapshot?.decisions.some((item) => item.engineRequestId === requestId && item.engineSessionId === sessionId)) return;
  const action = String(request.permission ?? request.action ?? "acción");
  const resources = Array.isArray(request.patterns) ? request.patterns.join(", ") : "";
  const description = kind === "permission"
    ? `OpenCode solicita autorización para ${action}.${resources ? " Recursos: " + resources : ""}`
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
  const assistantText = parseTextParts(messages)
    .filter((item) => !item.tool)
    .map((item) => item.text)
    .join("\n");
  return assistantText.slice(-9000);
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
  let session: Record<string, unknown>;
  try {
    session = await openCodeRequest<Record<string, unknown>>(runtime, "POST", "/api/session", sessionPayload);
  } catch (error) {
    if (!/agent|unknown|not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const { agent: _ignored, ...withoutAgent } = sessionPayload;
    session = await openCodeRequest<Record<string, unknown>>(runtime, "POST", "/api/session", withoutAgent);
    addLog(state.runId, agent.agentId.toUpperCase(), "warning", "No se pudo activar la definición de agente desde la carpeta de configuración; se utilizará su instrucción de rol integrada.", agent.id);
  }
  const sessionData = session.data && typeof session.data === "object" ? session.data as Record<string, unknown> : session;
  const sessionId = String(sessionData.id ?? "");
  if (!sessionId) throw new Error("OpenCode creó una sesión sin devolver su identificador.");
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
  const waitPromise = openCodeRequest<unknown>(
    runtime,
    "POST",
    `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
    undefined,
    null
  ).then(() => { waitDone = true; })
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
  agentId: string,
  instructions: string,
  roleInstructions: string,
  projectContext: string,
  previousResults: string[]
): string {
  const previous = previousResults.slice(-3).map((item) => item.slice(-5000)).join("\n\n--- RESULTADO DEL AGENTE ANTERIOR ---\n\n");
  const roleOverrides: Record<string, string> = {
    architect: "Tu entrega en esta fase es un plan breve, priorizado y respaldado por evidencia. No modifiques archivos.",
    build: "Actúas como coordinador de cierre. La fábrica ya ejecutó las fases de especialistas por separado: NO invoques subagentes ni delegues. Consolida los resultados, señala riesgos y pendientes.",
    implementer: "Implementa el objetivo usando el plan/contexto anterior. Respeta estrictamente el perfil de permisos de tu sesión. No hagas commits ni pushes.",
    reviewer: "Revisa el estado actual y los cambios realizados. No modifiques archivos. Informa defectos demostrables y discrepancias que requieran arbitraje.",
    tester: "Ejecuta las pruebas y verificaciones pertinentes si tus permisos lo permiten. No ocultes fallos. Informa comandos y resultados reales.",
    reverse: "Solo realiza ingeniería inversa cuando existan binarios o el objetivo la requiera. Utiliza únicamente herramientas que estén realmente disponibles.",
    "cloud-arbiter": "Resuelve exclusivamente discrepancias técnicas concretas entre los informes anteriores. No modifiques archivos."
  };
  return [
    "OBJETIVO E INSTRUCCIONES DEL USUARIO:",
    instructions,
    "",
    "CONTEXTO ESTRUCTURAL DE LA PRECONSULTA:",
    projectContext,
    "",
    "TU ROL EN ESTA FASE:",
    roleInstructions,
    "",
    "INSTRUCCIÓN OPERATIVA DE LA FÁBRICA:",
    roleOverrides[agentId] ?? "Cumple exclusivamente tu función como especialista.",
    "La fábrica ejecuta los agentes de forma secuencial y comparte sus resultados; no crees subagentes ni delegues tareas. Trabaja en español. Distingue evidencia, hipótesis y tareas no verificadas. No cambies credenciales ni configuración global.",
    "",
    previous ? "CONTEXTO Y RESULTADOS DE FASES PREVIAS:\n" + previous : "Esta es la primera fase de la ejecución."
  ].join("\n");
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
  prompt: string
): Promise<string> {
  const controller = new AbortController();
  state.claudeControllers.set(agent.id, controller);
  const role = await loadRoleInstructions(factoryRoot, agent.agentId);
  let sessionId: string | null = null;
  let finalText = "";
  let resultFailure: string | null = null;
  addLog(state.runId, agent.agentId.toUpperCase(), "info", `Iniciando Claude Code con modelo ${agent.modelId}.`, agent.id);

  const stream = claudeQuery({
    prompt,
    options: {
      cwd: projectPath,
      model: agent.modelId,
      settingSources: ["user"],
      permissionMode: agent.permissionProfile === "read-only" ? "plan" : "default",
      abortController: controller,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: role + "\n\nLa fábrica administra otras fases de trabajo. No invoques subagentes ni delegues."
      },
      disallowedTools: agent.permissionProfile === "read-only"
        ? ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"]
        : ["Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"],
      canUseTool: async (toolName, input, options) => {
        if (readTools.has(toolName)) {
          // These tools do not accept an arbitrary filesystem path.
          if (toolName === "Skill" || toolName === "TodoRead") {
            return { behavior: "allow", toolUseID: options.toolUseID };
          }

          const rawPath = inputPath(input) ??
            (["Glob", "Grep", "LS", "List", "LSP"].includes(toolName) ? "." : undefined);
          const pathValue = typeof rawPath === "string" && rawPath.startsWith("file://")
            ? decodeURIComponent(new URL(rawPath).pathname)
            : rawPath;
          const canonicalPath = await resolveProjectCandidate(projectPath, pathValue);
          if (canonicalPath && typeof pathValue === "string" && !pathIsSensitive(pathValue, canonicalPath)) {
            return { behavior: "allow", toolUseID: options.toolUseID };
          }
          return {
            behavior: "deny",
            message: "La lectura fue bloqueada: la ruta no pertenece al proyecto o corresponde a un archivo sensible.",
            toolUseID: options.toolUseID
          };
        }
        if (agent.permissionProfile === "workspace-write" && writeTools.has(toolName)) {
          const rawPath = inputPath(input) ??
            (["Glob", "Grep", "LS", "List", "LSP"].includes(toolName) ? "." : undefined);
          const pathValue = typeof rawPath === "string" && rawPath.startsWith("file://")
            ? decodeURIComponent(new URL(rawPath).pathname)
            : rawPath;
          const canonicalPath = await resolveProjectCandidate(projectPath, pathValue);
          if (canonicalPath && typeof pathValue === "string" && !pathIsSensitive(pathValue, canonicalPath)) {
            return { behavior: "allow", toolUseID: options.toolUseID };
          }
        }
        const isQuestion = toolName === "AskUserQuestion";
        const title = isQuestion ? "Claude necesita una aclaración" : (options.title ?? `Autorizar herramienta: ${toolName}`);
        const questionList = Array.isArray(input.questions)
          ? input.questions.map((item) => {
              const question = item as Record<string, unknown>;
              return String(question.question ?? question.header ?? "Pregunta del agente");
            }).join("\n")
          : "";
        const details = { toolName, input: safeJson(input), displayName: options.displayName, blockedPath: options.blockedPath };
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
              finalText += block.text + "\n";
              addLog(state.runId, agent.agentId.toUpperCase(), "success", block.text, agent.id);
            } else if (block.type === "tool_use") {
              const toolName = String(block.name ?? "herramienta");
              const input = block.input && typeof block.input === "object" ? JSON.stringify(safeJson(block.input)).slice(0, 700) : "";
              addLog(state.runId, agent.agentId.toUpperCase(), "info", `TOOL ${toolName}${input ? " · " + input : ""}`, agent.id);
            }
          }
        }
      } else if (record.type === "result") {
        const isSuccessfulResult = record.subtype === "success" && record.is_error !== true;
        if (isSuccessfulResult) {
          addLog(state.runId, agent.agentId.toUpperCase(), "success", "Turno de Claude Code completado.", agent.id);
        } else {
          const providerErrors = Array.isArray(record.errors)
            ? record.errors.filter((item): item is string => typeof item === "string")
            : [];
          const detail = providerErrors.join(" | ") || (typeof record.result === "string" ? record.result : "");
          resultFailure = `Claude Code terminó con estado ${String(record.subtype ?? "error")}${detail ? ": " + sanitizeText(detail) : "."}`;
          addLog(state.runId, agent.agentId.toUpperCase(), "warning", resultFailure, agent.id);
        }
        if (typeof record.result === "string") finalText += record.result;
      } else if (record.type === "system" && record.subtype === "init") {
        addLog(state.runId, agent.agentId.toUpperCase(), "info", "Claude Code inicializó el contexto de trabajo.", agent.id);
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

function isRelevantSpecialist(agentId: string, instructions: string, previousResults: string[]): boolean {
  const text = (instructions + "\n" + previousResults.join("\n")).toLowerCase();
  if (agentId === "reverse") {
    return /ingenier[ií]a inversa|descompil|decompil|desensambl|disassembl|binario|\.dll\b|\.exe\b|\.so\b|\.class\b|\bjar\b/.test(text);
  }
  if (agentId === "cloud-arbiter") {
    return /discrepancia|conflicto entre|no coincide|hip[oó]tesis contradictorias|requiere arbitraje/.test(text);
  }
  return true;
}
function executionOrder(agentId: string): number {
  const order = ["architect", "implementer", "reviewer", "tester", "build", "reverse", "cloud-arbiter"];
  return order.indexOf(agentId) < 0 ? 100 : order.indexOf(agentId);
}

async function validateClaudeProvider(): Promise<void> {
  const provider = getClaudeProviderPreference();
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let baseUrl = "";
  let hasCredential = false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    baseUrl = String(settings.env?.ANTHROPIC_BASE_URL ?? "").replace(/\/$/, "");
    hasCredential = Boolean(settings.env?.ANTHROPIC_AUTH_TOKEN || settings.env?.ANTHROPIC_API_KEY);
  } catch {
    // Claude Code can also use its OAuth session; the SDK will validate it when it starts.
  }
  if (provider === "apmix") {
    if (baseUrl !== "https://api.apmix.ai") {
      throw new Error("El proveedor APMix está seleccionado, pero ~/.claude/settings.json no apunta a https://api.apmix.ai. No se modificó ninguna credencial.");
    }
    if (!hasCredential) {
      throw new Error("No se detectó una credencial APMix en la configuración local. Revisa tu sesión en el equipo; no compartas tokens en el chat.");
    }
  } else if (baseUrl && baseUrl !== "https://api.anthropic.com") {
    throw new Error("Está seleccionado Anthropic oficial, pero la configuración local apunta a otro proveedor. La fábrica no cambiará ANTHROPIC_BASE_URL ni reutilizará credenciales de APMix.");
  }
}

async function executeRun(
  state: RuntimeState,
  projectPath: string,
  instructions: string,
  factoryRoot: string,
  agents: AgentInput[],
  depthOverride?: ResearchDepth
): Promise<void> {
  const failures: string[] = [];
  const previousResults: string[] = [];
  const openCodeAgents = agents.some((agent) => agent.engine === "opencode");
  const needsClaude = agents.some((agent) => agent.engine === "claude");
  let openCodeReady = !openCodeAgents;
  let claudeReady = !needsClaude;
  try {
    if (openCodeAgents) {
      try {
        state.openCode = await startOpenCodeRuntime(projectPath, factoryRoot, state.runId);
        openCodeReady = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addLog(state.runId, "OPENCODE", "warning", `No fue posible iniciar el motor OpenCode: ${message}`);
        for (const agent of agents.filter((item) => item.engine === "opencode")) {
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
        for (const agent of agents.filter((item) => item.engine === "claude")) {
          updateExecutionAgent(agent.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
          failures.push(agent.agentId);
        }
      }
    }

    const taskPlan = planTask(instructions, depthOverride);
    addLog(state.runId, "PLANNER", "success", `Plan ${taskPlan.depth}: ${taskPlan.recommendedAgents.length} agentes recomendados. Sin límite de duración; la ejecución termina al completar el trabajo o por cancelación del usuario.`);
    const depthGuidance = taskPlan.depth === "quick"
      ? "INVESTIGACIÓN RÁPIDA: lee primero README.md y documentos de instrucciones. Revisa manifiestos y árbol superficial; consulta solo 5-8 archivos representativos. No recorras exhaustivamente el repositorio, no busques herramientas que no necesitas, no elabores planes extensos y detente cuando tengas evidencia suficiente para responder al formato solicitado."
      : taskPlan.depth === "focused"
        ? "INVESTIGACIÓN FOCALIZADA: identifica el módulo relacionado con el objetivo y sigue únicamente sus dependencias directas. Evita explorar áreas no relacionadas y explica cualquier límite de evidencia."
        : "INVESTIGACIÓN PROFUNDA: realiza un análisis sistemático del alcance solicitado, sigue dependencias relevantes y respalda conclusiones con rutas/archivos. No amplíes el alcance sin justificación.";
    const structuralContext = [
      `Planificador: ${taskPlan.kind}; complejidad de tarea ${taskPlan.complexity}; profundidad ${taskPlan.depth}; agentes recomendados: ${taskPlan.recommendedAgents.join(", ")}.`,
      depthGuidance,
      `Repositorio: ${projectPath}`,
      `Instrucciones: ${instructions}`,
      "Los agentes pueden inspeccionar directamente los archivos del proyecto según sus permisos."
    ].join("\n");
    const ordered = agents.slice().sort((a, b) => executionOrder(a.agentId) - executionOrder(b.agentId));
    const eligible: AgentInput[] = [];
    for (const agent of ordered) {
      if ((agent.engine === "opencode" && !openCodeReady) ||
          (agent.engine === "claude" && !claudeReady)) continue;
      eligible.push(agent);
    }

    const executeAgent = async (agent: AgentInput, contextResults: string[]): Promise<void> => {
      if (state.cancelled) {
        updateExecutionAgent(agent.id, { status: "cancelled", error: "Cancelado por el usuario.", finishedAt: new Date().toISOString() });
        return;
      }
      if (!isRelevantSpecialist(agent.agentId, instructions, contextResults)) {
        const reason = agent.agentId === "reverse"
          ? "Se omitió: el objetivo no requiere ingeniería inversa ni se identificaron binarios relevantes."
          : "Se omitió: no hay una discrepancia técnica que requiera arbitraje.";
        updateExecutionAgent(agent.id, { status: "skipped", error: reason, finishedAt: new Date().toISOString() });
        addLog(state.runId, agent.agentId.toUpperCase(), "warning", reason, agent.id);
        return;
      }
      updateExecutionAgent(agent.id, { status: "running", startedAt: new Date().toISOString(), error: null });
      updateExecutionRun(state.runId, state.pendingCount > 0 ? "waiting" : "running");
      addLog(state.runId, agent.agentId.toUpperCase(), "info", `Comienza la fase de ${agent.agentId}. Motor: ${agent.engine}. Modelo: ${agent.modelId}. Permisos: ${agent.permissionProfile}.`, agent.id);
      try {
        const roleInstructions = await loadRoleInstructions(factoryRoot, agent.agentId);
        const prompt = makeAgentPrompt(agent.agentId, instructions, roleInstructions, structuralContext, contextResults);
        const output = agent.engine === "opencode"
          ? await runOpenCodeAgent(state, agent, projectPath, factoryRoot, prompt)
          : await runClaudeAgent(state, agent, projectPath, factoryRoot, prompt);
        contextResults.push(`AGENTE ${agent.agentId.toUpperCase()} (resumen):\n${output.slice(-9000)}`);
        updateExecutionAgent(agent.id, { status: "succeeded", finishedAt: new Date().toISOString(), error: null });
        addLog(state.runId, agent.agentId.toUpperCase(), "success", `Fase ${agent.agentId} terminada.`, agent.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (state.cancelled) {
          updateExecutionAgent(agent.id, { status: "cancelled", error: "Cancelado por el usuario.", finishedAt: new Date().toISOString() });
          return;
        }
        failures.push(agent.agentId);
        contextResults.push(`AGENTE ${agent.agentId.toUpperCase()} (error): ${message}`);
        updateExecutionAgent(agent.id, { status: "failed", error: sanitizeText(message), finishedAt: new Date().toISOString() });
        addLog(state.runId, agent.agentId.toUpperCase(), "warning", `Fase fallida: ${message}`, agent.id);
      }
    };

    const parallelEligible = eligible.filter((agent) => agent.agentId !== "cloud-arbiter");
    const arbitrationAgents = eligible.filter((agent) => agent.agentId === "cloud-arbiter");
    const engines = new Set(parallelEligible.map((agent) => agent.engine));
    const canRunEnginesTogether = engines.has("opencode") && engines.has("claude") &&
      parallelEligible.every((agent) => agent.permissionProfile === "read-only" ||
        (agent.agentId === "tester" && agent.permissionProfile === "approval-required"));
    if (canRunEnginesTogether) {
      addLog(state.runId, "ORCHESTRATOR", "success", "Modo paralelo seguro: OpenCode y Claude Code trabajarán simultáneamente. Los agentes de cada motor conservan su orden interno; el Tester solo puede ejecutar acciones que autorices.");
      const baseContext = previousResults.slice();
      const engineGroups: Array<{ engine: EngineId; agents: AgentInput[] }> = [
        { engine: "opencode" as EngineId, agents: parallelEligible.filter((agent) => agent.engine === "opencode") },
        { engine: "claude" as EngineId, agents: parallelEligible.filter((agent) => agent.engine === "claude") }
      ].filter((group) => group.agents.length > 0);
      const groupResults = await Promise.all(engineGroups.map(async (group) => {
        const contextResults = baseContext.slice();
        for (const agent of group.agents) await executeAgent(agent, contextResults);
        return contextResults.slice(baseContext.length);
      }));
      previousResults.push(...groupResults.flat());
      for (const agent of arbitrationAgents) await executeAgent(agent, previousResults);
    } else {
      if (eligible.some((agent) => agent.permissionProfile === "workspace-write")) {
        addLog(state.runId, "ORCHESTRATOR", "info", "Modo secuencial: hay agentes con permiso de escritura; se preserva el orden de planificación para evitar conflictos en archivos compartidos.");
      }
      for (const agent of eligible) {
        if (state.cancelled) break;
        await executeAgent(agent, previousResults);
      }
    }

    const snapshot = getExecutionSnapshot(state.runId);
    const hasFailed = snapshot?.agents.some((agent) => agent.status === "failed") ?? failures.length > 0;
    if (state.cancelled) {
      updateExecutionRun(state.runId, "cancelled", true);
      addLog(state.runId, "ORCHESTRATOR", "warning", "Ejecución cancelada por el usuario.");
    } else if (hasFailed) {
      updateExecutionRun(state.runId, "failed", true);
      addLog(state.runId, "ORCHESTRATOR", "warning", "Ejecución terminada con una o más fases fallidas. Consulta los logs y los estados de cada agente.");
    } else {
      updateExecutionRun(state.runId, "succeeded", true);
      addLog(state.runId, "ORCHESTRATOR", "success", "Ejecución completada. Consulta los resultados de los agentes y los cambios realizados en el proyecto.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateExecutionRun(state.runId, state.cancelled ? "cancelled" : "failed", true);
    addLog(state.runId, "ORCHESTRATOR", "warning", `Ejecución interrumpida: ${message}`);
  } finally {
    for (const controller of state.claudeControllers.values()) controller.abort();
    if (state.openCode && !state.openCode.closing) {
      state.openCode.closing = true;
      state.openCode.child.kill("SIGTERM");
      state.openCode.password = "";
    }
    for (const resolver of state.resolvers.values()) resolver({ action: "deny" });
    state.resolvers.clear();
    runtimeByRun.delete(state.runId);
  }
}

export async function startExecution(projectPath: string, instructions: string, factoryRoot: string, depthOverride?: ResearchDepth): Promise<{ runId: string }> {
  const active = [...runtimeByRun.values()].find((runtime) => !runtime.cancelled);
  if (active) throw new Error("Ya hay una ejecución activa. Termínala o cancélala antes de comenzar otra.");
  const resolvedProjectPath = resolve(projectPath);
  const projectStat = await stat(resolvedProjectPath).catch(() => null);
  if (!projectStat?.isDirectory()) throw new Error("La ruta del proyecto no existe o no es una carpeta.");
  if (!instructions.trim()) throw new Error("Escribe las instrucciones que deben ejecutar los agentes.");
  const assignments = listAssignments().filter((item) => item.enabled);
  if (!assignments.length) throw new Error("No hay agentes habilitados. Activa al menos uno y guarda el equipo.");
  if (assignments.some((item) => item.engine === "opencode") && !(await stat(opencodeBinary).catch(() => null))) {
    throw new Error("No se encontró OpenCode en ~/.opencode/bin/opencode.");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const agents: AgentInput[] = assignments.map((assignment) => ({
    id: randomUUID(), runId: id, agentId: assignment.agentId,
    engine: assignment.engine, modelId: assignment.modelId,
    permissionProfile: assignment.permissionProfile
  }));
  createExecutionRecords({
    id, projectPath: resolvedProjectPath, instructions: instructions.trim(),
    status: "queued", startedAt: now
  }, agents.map((agent) => ({
    id: agent.id, agentId: agent.agentId, engine: agent.engine,
    modelId: agent.modelId, permissionProfile: agent.permissionProfile, status: "queued"
  })));
  const state: RuntimeState = {
    runId: id, cancelled: false, claudeControllers: new Map(),
    resolvers: new Map(), pendingCount: 0
  };
  runtimeByRun.set(id, state);
  addLog(id, "ORCHESTRATOR", "success", `Ejecución creada para ${resolvedProjectPath}. ${agents.length} agentes habilitados.`);
  void executeRun(state, resolvedProjectPath, instructions.trim(), factoryRoot, agents, depthOverride);
  return { runId: id };
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
    throw new Error("La solicitud ya fue respondida o no pertenece a esta ejecución.");
  }
  const state = runtimeByRun.get(runId);
  if (!state) throw new Error("La sesión del motor ya no está activa. Reanuda la ejecución desde el motor o inicia una nueva.");
  if (decision.engine === "opencode") {
    const runtime = state.openCode;
    if (!runtime || !decision.engineSessionId || !decision.engineRequestId) {
      throw new Error("No se encontró la sesión OpenCode asociada a esta solicitud.");
    }
    if (decision.kind === "permission") {
      if (response.action === "answer") throw new Error("Esta solicitud requiere aprobar o rechazar la acción.");
      await openCodeRequest(runtime, "POST",
        `/api/session/${encodeURIComponent(decision.engineSessionId)}/permission/${encodeURIComponent(decision.engineRequestId)}/reply`,
        { decision: response.action === "allow" ? "once" : "reject", message: response.answer ?? null }
      );
      resolveExecutionDecision(decisionId, response.action === "allow" ? "approved" : "rejected", response.answer ?? "");
    } else {
      if (response.action !== "answer") throw new Error("Esta solicitud requiere una respuesta escrita.");
      const details = decision.details as Record<string, unknown>;
      const metadata = details.metadata && typeof details.metadata === "object" ? details.metadata as Record<string, unknown> : details;
      const fields = Array.isArray(metadata.fields) ? metadata.fields as Array<Record<string, unknown>> : [];
      let answers: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(response.answer ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answers = parsed as Record<string, unknown>;
      } catch {
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
      await openCodeRequest(runtime, "POST",
        `/api/session/${encodeURIComponent(decision.engineSessionId)}/form/${encodeURIComponent(decision.engineRequestId)}/reply`,
        { answer: answers }
      );
      resolveExecutionDecision(decisionId, "answered", response.answer ?? "");
    }
  } else {
    const resolver = state.resolvers.get(decisionId);
    if (!resolver) throw new Error("La solicitud ya no tiene un agente esperando una respuesta.");
    const finalAnswer = decision.kind === "question" && response.action !== "answer"
      ? { action: "answer" as const, answer: response.action === "allow" ? "Sí, continúa." : "No, no continúes." }
      : response;
    resolver(finalAnswer);
    resolveExecutionDecision(
      decisionId,
      finalAnswer.action === "answer" ? "answered" : finalAnswer.action === "allow" ? "approved" : "rejected",
      finalAnswer.answer ?? ""
    );
  }
  addLog(runId, "HUMAN-REVIEW", "success", `Solicitud atendida: ${decision.title}.`, decision.agentRunId);
}
