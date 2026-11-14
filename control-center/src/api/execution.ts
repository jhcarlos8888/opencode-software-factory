import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { readClaudeLocalConfig } from "./models.js";
import { planTask, type ResearchDepth } from "./task-planner.js";
import {
  addExecutionEvent, createExecutionDecision, createExecutionRecords, getClaudeProviderPreference,
  getExecutionDecision, getExecutionSnapshot, getLatestExecutionId, listAssignments, markUnfinishedExecutionsInterrupted, orphanExecutionDecisions, orphanExecutionDecisionsForAgent,
  resolveExecutionDecision, updateExecutionAgent, updateExecutionRun,
  type AgentAssignment, type EngineId, type ExecutionAgentRecord, type ExecutionDecisionRecord,
  type ExecutionSnapshot, type ExecutionStatus
} from "./database.js";

type DecisionAnswer = { action: "allow" | "allow-run" | "deny" | "answer"; answer?: string };
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
  /** Temporary approvals are scoped to this run and discarded in executeRun.finally. */
  openCodeRunApprovals: Array<{ action: string; resource: string }>;
  seenOpenCodePermissionRequests: Set<string>;
  claudeRunApprovalKeys: Set<string>;
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
const opencodeBinary = join(homedir(), ".opencode", "bin", "opencode");
const readTools = new Set(["Read", "Glob", "Grep", "LS", "List", "Skill", "LSP", "TodoRead", "NotebookRead"]);
const writeTools = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "NotebookWrite", "NotebookCellEdit"]);
const shellTools = new Set(["Bash", "BashOutput", "KillShell"]);
const delegationTools = new Set(["Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"]);
const sensitivePathPattern = /(^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.claude|\.ssh|\.aws|\.azure|\.config|\.local|\.gnupg|\.kube|\.docker|\.npm|secrets?|credentials?|id_rsa[^/\\]*|.*(?:token|apikey|api_key|private_key).*|[^/\\]+\.(?:pem|key))($|[/\\])/i;
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

async function claudeToolPathIsAllowed(
  projectPath: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  // Skill/TodoRead do not accept arbitrary filesystem paths. All path-based
  // tools must resolve inside the canonical project root.
  if (toolName === "Skill" || toolName === "TodoRead") return true;

  let rawPath = inputPath(input);
  if (rawPath === undefined && ["Glob", "Grep", "LS", "List", "LSP"].includes(toolName)) {
    rawPath = ".";
  }
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;
  let normalizedPath: string = rawPath;

  if (normalizedPath.startsWith("file://")) {
    try {
      normalizedPath = decodeURIComponent(new URL(normalizedPath).pathname);
    } catch {
      return false;
    }
  }

  // Glob patterns are separate from their base directory. Reject absolute
  // patterns and traversal segments so a safe base path cannot be escaped.
  if (toolName === "Glob") {
    const pattern = input.pattern;
    if (typeof pattern !== "string" || isAbsolute(pattern) || pattern.startsWith("~") ||
        pattern.split(/[\\/]+/).some((segment) => segment === "..")) {
      return false;
    }
  }

  const canonicalPath = await resolveProjectCandidate(projectPath, normalizedPath);
  return canonicalPath !== null && !pathIsSensitive(normalizedPath, canonicalPath);
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

function openCodePatternMatches(action: string, pattern: string, resource: string): boolean {
  const normalize = (value: string) => value.split(String.fromCharCode(92)).join("/");
  const normalizedPattern = normalize(pattern);
  const normalizedResource = normalize(resource);
  if (action === "shell" && normalizedPattern.endsWith(" *") && normalizedResource === normalizedPattern.slice(0, -2)) {
    return true;
  }
  const expression = normalizedPattern.split("").map((character) => {
    if (character === "*") return "[\\s\\S]*";
    if (character === "?") return "[\\s\\S]";
    return "|\\{}()[]^$+?.".includes(character) ? "\\" + character : character;
  }).join("");
  return new RegExp(`^${expression}$`).test(normalizedResource);
}

function runApprovalPatterns(request: OpenCodePermission): Array<{ action: string; resource: string }> {
  const action = String(request.action ?? request.permission ?? "").trim();
  if (!action) return [];
  const proposed = Array.isArray(request.save) ? request.save : [];
  const resources = Array.isArray(request.resources) ? request.resources : Array.isArray(request.patterns) ? request.patterns : [];
  return [...new Set((proposed.length ? proposed : resources).filter((item): item is string => typeof item === "string" && !!item.trim()))]
    .map((resource) => ({ action, resource }));
}

function matchesOpenCodeRunApproval(state: RuntimeState, request: OpenCodePermission): boolean {
  const action = String(request.action ?? request.permission ?? "").trim();
  const resources = Array.isArray(request.resources) ? request.resources : Array.isArray(request.patterns) ? request.patterns : [];
  if (!action || resources.length === 0) return false;
  return resources.every((resource) => typeof resource === "string" && state.openCodeRunApprovals.some((rule) =>
    rule.action === action && openCodePatternMatches(action, rule.resource, resource)
  ));
}

function pathIsSensitive(pathValue: string, canonicalPath?: string): boolean {
  const paths = canonicalPath === undefined ? [pathValue] : [pathValue, canonicalPath];
  return paths.some((candidate) =>
    sensitivePathPattern.test(candidate) ||
    /(^|[/\\])\.git[/\\](?:config|credentials|hooks)(?:[/\\]|$)/i.test(candidate)
  );
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
    "**/.claude/**", "**/.ssh/**", "**/.aws/**", "**/.azure/**", "**/.config/**",
    "**/.local/**", "**/.gnupg/**", "**/.kube/**", "**/.docker/**", "**/.npm/**",
    "**/.git/config", "**/.git/credentials", "**/.git/hooks/**",
    "**/*.pem", "**/*.key", "**/id_rsa*", "**/*token*", "**/*apikey*", "**/*api_key*"
  ];
  for (const action of ["read", "edit"]) {
    for (const resource of sensitiveResources) {
      rules.push({ action, resource, effect: "deny" });
    }
  }
  // The REA MCP exposes filesystem-oriented tools. Keep it denied even when
  // its server is present in the factory-level OpenCode configuration.
  rules.push({ action: "rea_*", resource: "*", effect: "deny" });
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
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true"
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

// The V2 wait endpoint is intentionally long-polling: it sends its response
// only after the session agent loop becomes idle. Node's global fetch uses
// Undici's default 300s headers timeout even when no AbortSignal is supplied,
// so a valid agent run can be reported as "fetch failed" after five minutes.
// Use node:http for this one request; its client has no implicit 300s
// response-header timeout. The caller still observes connection errors.
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
  if (kind === "permission") {
    if (state.seenOpenCodePermissionRequests.has(requestKey)) return;
    state.seenOpenCodePermissionRequests.add(requestKey);
  }
  const snapshot = getExecutionSnapshot(state.runId);
  if (snapshot?.decisions.some((item) => item.engineRequestId === requestId && item.engineSessionId === sessionId)) return;
  const action = String(request.action ?? request.permission ?? "acción");
  const resources = Array.isArray(request.resources) ? request.resources : Array.isArray(request.patterns) ? request.patterns : [];
  const proposedPatterns = Array.isArray(request.save) ? request.save : [];
  const resourceText = resources.length ? ` Recursos solicitados: ${resources.join(", ")}.` : "";
  const patternText = proposedPatterns.length ? ` Patrones propuestos para esta ejecución: ${proposedPatterns.join(", ")}.` : "";
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
    if (matchesOpenCodeRunApproval(state, request)) {
      try {
        await replyOpenCodePermission(runtime, sessionId, requestId, "once");
        state.seenOpenCodePermissionRequests.add(requestKey);
        const action = String(request.action ?? request.permission ?? "acción");
        const resources = Array.isArray(request.resources) ? request.resources.join(", ") : "";
        addLog(state.runId, agent.agentId.toUpperCase(), "success", `Autorización temporal aplicada automáticamente durante esta ejecución: ${action}${resources ? ` · ${resources}` : ""}.`, agent.id);
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

  const localClaudeConfig = await readClaudeLocalConfig().catch(() => null);
  const stream = claudeQuery({
    prompt,
    options: {
      cwd: projectPath,
      env: { ...process.env, ...(localClaudeConfig?.env ?? {}) },
      model: agent.modelId,
      permissionMode: agent.permissionProfile === "read-only" ? "plan" : "default",
      abortController: controller,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: role + "\n\nLa fábrica administra otras fases de trabajo. No invoques subagentes ni delegues."
      },
      disallowedTools: agent.permissionProfile === "read-only"
        ? ["Bash", "BashOutput", "KillShell", "Edit", "Write", "NotebookEdit", "MultiEdit", "NotebookWrite", "NotebookCellEdit", "Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"]
        : ["Agent", "Task", "TaskCreate", "TaskGet", "TaskStop"],
      // SDK isolation mode: do not import global/project Claude settings,
      // including user allow-lists, plugins, MCP servers or filesystem hooks.
      // Provider credentials are passed explicitly via localClaudeConfig.env.
      settingSources: [],
      // canUseTool is not a hard boundary: CLI allow-rules may auto-approve a
      // tool before that callback runs. PreToolUse executes for every tool and
      // is therefore the enforcement point for project filesystem isolation.
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

            if (hookInput.mcp_server || toolName.startsWith("mcp__")) {
              addLog(state.runId, agent.agentId.toUpperCase(), "warning",
                "Bloqueo de aislamiento: las herramientas MCP no configuradas por la fábrica no están permitidas en sesiones Claude.", agent.id);
              return deny("La sesión de fábrica no tiene permiso para invocar servidores MCP externos a su configuración controlada.");
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
        const approvalKey = claudeToolApprovalKey(toolName, input);
        if (!isQuestion && state.claudeRunApprovalKeys.has(approvalKey)) {
          addLog(state.runId, agent.agentId.toUpperCase(), "success", `Autorización temporal reutilizada para la misma operación ${toolName} durante esta ejecución.`, agent.id);
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
        // A failed agent must not leave live permissions that can be approved
        // after its orchestrator turn has already ended.
        orphanExecutionDecisionsForAgent(state.runId, agent.id);
        if (agent.engine === "opencode") {
          const runtime = state.openCode;
          const sessionId = runtime?.sessions.get(agent.id);
          if (runtime && sessionId && !runtime.closing) {
            await openCodeRequest(
              runtime,
              "POST",
              `/api/session/${encodeURIComponent(sessionId)}/interrupt`
            ).catch(() => undefined);
          }
        }
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
    state.openCodeRunApprovals.length = 0;
    state.seenOpenCodePermissionRequests.clear();
    state.claudeRunApprovalKeys.clear();
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
    resolvers: new Map(), pendingCount: 0,
    openCodeRunApprovals: [], seenOpenCodePermissionRequests: new Set(), claudeRunApprovalKeys: new Set()
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
  if (decision.kind === "question" && response.action !== "answer") {
    throw new Error("Las solicitudes de aclaración requieren una respuesta escrita; no admiten permisos persistentes.");
  }
  if (decision.engine === "opencode") {
    const runtime = state.openCode;
    if (!runtime || !decision.engineSessionId || !decision.engineRequestId) {
      throw new Error("No se encontró la sesión OpenCode asociada a esta solicitud.");
    }
    if (decision.kind === "permission") {
      if (response.action === "answer") throw new Error("Esta solicitud requiere aprobar o rechazar la acción.");
      const details = decision.details && typeof decision.details === "object"
        ? decision.details as OpenCodePermission
        : {};
      const addedRules = response.action === "allow-run" ? runApprovalPatterns(details) : [];
      if (response.action === "allow-run" && addedRules.length === 0) {
        throw new Error("OpenCode no propuso recursos o patrones concretos para recordar. Aprueba esta operación una sola vez.");
      }
      state.openCodeRunApprovals.push(...addedRules);
      try {
        await replyOpenCodePermission(
          runtime,
          decision.engineSessionId,
          decision.engineRequestId,
          response.action === "deny" ? "reject" : "once",
          response.answer
        );
      } catch (error) {
        for (const rule of addedRules) {
          const index = state.openCodeRunApprovals.lastIndexOf(rule);
          if (index >= 0) state.openCodeRunApprovals.splice(index, 1);
        }
        if (error instanceof Error && /OpenCode API HTTP 404/.test(error.message)) {
          const pendingPayload = await openCodeRequest<unknown>(
            runtime, "GET", `/api/session/${encodeURIComponent(decision.engineSessionId)}/permission`
          ).catch(() => null);
          const requestStillPending = pendingPayload !== null &&
            parseOpenCodeData<OpenCodePermission>(pendingPayload).some((item) => item.id === decision.engineRequestId);
          if (pendingPayload !== null && !requestStillPending) {
            const reason = "OpenCode ya no conserva esta solicitud pendiente; se retiró de la cola para evitar una aprobación fantasma.";
            resolveExecutionDecision(decisionId, "orphaned", reason);
            addLog(runId, "HUMAN-REVIEW", "warning", reason, decision.agentRunId);
            throw new Error(reason);
          }
        }
        throw error;
      }
      resolveExecutionDecision(
        decisionId,
        response.action === "deny" ? "rejected" : "approved",
        response.action === "allow-run"
          ? `Aprobado durante esta ejecución: ${addedRules.map((rule) => `${rule.action}: ${rule.resource}`).join("; ")}`
          : response.action === "allow" ? "Aprobado una vez." : "Rechazado."
      );
      if (response.action === "deny") {
        // OpenCode rejects every other pending permission request in the same session too.
        const siblings = getExecutionSnapshot(runId)?.decisions.filter((item) =>
          item.id !== decisionId && item.engine === "opencode" &&
          item.kind === "permission" && item.engineSessionId === decision.engineSessionId
        ) ?? [];
        for (const sibling of siblings) {
          resolveExecutionDecision(sibling.id, "rejected", "OpenCode rechazó las demás solicitudes pendientes de esta sesión.");
          addLog(runId, "HUMAN-REVIEW", "warning", "Solicitud rechazada junto con otra autorización de la misma sesión OpenCode.", sibling.agentRunId);
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
      addLog(runId, "HUMAN-REVIEW", "success", `Solicitud atendida: ${decision.title}.`, decision.agentRunId);
    }
  } else {
    const resolver = state.resolvers.get(decisionId);
    if (!resolver) throw new Error("La solicitud ya no tiene un agente esperando una respuesta.");
    if (decision.kind === "permission" && response.action === "allow-run") {
      const details = decision.details && typeof decision.details === "object"
        ? decision.details as Record<string, unknown>
        : {};
      const approvalKey = typeof details.approvalKey === "string" ? details.approvalKey : "";
      if (!approvalKey) throw new Error("No se pudo identificar la operación exacta de Claude para recordarla durante esta ejecución.");
      state.claudeRunApprovalKeys.add(approvalKey);
    }
    const finalAnswer: DecisionAnswer = decision.kind === "question" && response.action !== "answer"
      ? { action: "answer", answer: response.action === "deny" ? "No, no continúes." : "Sí, continúa." }
      : response.action === "allow-run" ? { action: "allow" } : response;
    resolver(finalAnswer);
    resolveExecutionDecision(
      decisionId,
      finalAnswer.action === "answer" ? "answered" : finalAnswer.action === "allow" ? "approved" : "rejected",
      response.action === "allow-run" ? "Aprobado para repetir esta misma operación durante esta ejecución." : finalAnswer.answer ?? ""
    );
    addLog(runId, "HUMAN-REVIEW", "success",
      response.action === "allow-run"
        ? `Autorización limitada a la misma operación durante esta ejecución: ${decision.title}.`
        : `Solicitud atendida: ${decision.title}.`,
      decision.agentRunId
    );
  }
}
