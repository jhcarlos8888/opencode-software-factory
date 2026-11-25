/**
 * Auditor de permisos de la fábrica.
 *
 * This is a deterministic, fail-closed policy, not a language model
 * improvising security decisions. It never expands read-only profiles.
 * Unknown operations and user questions must reach the human queue.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { assessDiagnosticCommand, assessIndependentDiagnostic, matchDiagnosticResources } from "./diagnostic-policy.js";
import { assessAuthorizedGitWorkflow, isGitWorkflowInspection, isContextualGitInspection, nativeGitCommandMatches, type GitRoundAuthority } from "./git-workflow-policy.js";

export type AuditorVerdict = "auto" | "human" | "block";
export interface AuditorAssessment {
  verdict: AuditorVerdict;
  reason: string;
  category: "inspection" | "test" | "browser" | "workspace" | "high-risk" | "unknown";
}

export interface AuditorToolRequest {
  engine: "claude" | "opencode";
  toolName: string;
  input: unknown;
  projectPath: string;
  roundInstructions?: string;
  permissionProfile: "read-only" | "workspace-write" | "approval-required";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function isWithinProject(path: string, root: string): boolean {
  const destination = resolve(root, path);
  const rel = relative(resolve(root), destination);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * Reject dangerous process control even when it is described as a test cleanup.
 * A command string is NOT a proof of ownership. Future support for stopping
 * temporary processes must use a process handle recorded by the orchestrator.
 */
export function isProtectedShellCommand(command: string): boolean {
  return /(?:^|[^\w])(?:pkill|killall|kill|fuser|shutdown|reboot|poweroff|halt|sudo|su|doas|rm|rmdir|shred|mkfs|dd|wipefs|format|truncate)(?=\s|$|[;|&])/i.test(command)
    || /\bsystemctl\s+(?:--user\s+)?(?:stop|restart|disable|mask|kill|poweroff)\b/i.test(command)
    || /\bgit\s+(?:-C\s+\S+\s+)?(?:reset\s+--hard|clean\b|push\s+--force|branch\s+-D)\b/i.test(command)
    || /\bdocker\s+(?:stop|kill|rm|system\s+prune)\b/i.test(command)
    || /\bpodman\s+(?:stop|kill|rm|system\s+prune)\b/i.test(command);
}

/**
 * Allow the precise, side-effect-limited output wrapper used by Claude Code
 * when displaying a known npm verification script. Never permit arbitrary
 * pipelines, extra shell segments, alternate npm subcommands, redirection
 * targets or post-processing scripts.
 *
 * Bash expands PIPESTATUS[0] from the immediately preceding pipeline when
 * entering the echo command. This keeps the test's real result observable.
 */
export function isBoundedTestOutputPipeline(command: string): boolean {
  if (command.length > 250 || /[\r\n\x00-\x1f`]/.test(command)) return false;
  const match = /^(npm run (check|test:unit|smoke)) 2>&1 \| tail -([1-9]\d?|100); echo "(CHECK|UNIT|TEST|SMOKE)_EXIT=\$\{PIPESTATUS\[0\]\}"$/.exec(command);
  if (!match) return false;
  const kind = match[2];
  const label = match[4];
  return (
    (kind === "check" && label === "CHECK") ||
    (kind === "test:unit" && (label === "UNIT" || label === "TEST")) ||
    (kind === "smoke" && label === "SMOKE")
  );
}

function isSafeShell(command: string): boolean {
  const value = command.trim();
  if (isBoundedTestOutputPipeline(value)) return true;
  if (!value || value.length > 1200 || /[\r\n;|&<>\x00-\x1f`]/.test(value.replace(/ 2>&1$/, ""))) {
    // Stderr may be merged into stdout, but arbitrary redirects and pipelines
    // must never be inferred safe from a matching command prefix.
    return false;
  }
  // The common OpenCode shell renderer uses echo to display a test's native
  // exit status and other fixed separators. Interpolation is allowed ONLY for
  // the exact shell status variables, never arbitrary command expansion.
  if (/^echo "(?:=== [A-Z][A-Z0-9 _()-]{0,40} ===|check-ok|exit(?:_ref|_heads)?=\$\?)"$/.test(value)) return true;
  if (/^echo (?:'---[A-Za-z0-9 _()/\-]{0,40}---'|"---[A-Za-z0-9 _()/\-]{0,40}---"|'---'|"---"|"(?:CHECK_EXIT|EXIT|EXIT_CODE|UNIT_EXIT|TEST_EXIT|SMOKE_EXIT|CACHED_EXIT|EXIT_DIFF|EXIT_CACHED)=\$\?"|"(?:CHECK_EXIT|EXIT|EXIT_CODE|UNIT_EXIT|TEST_EXIT|SMOKE_EXIT)=\$\{PIPESTATUS\[0\]\}")$/.test(value)) {
    return true;
  }
  if (/[\$\\*?]/.test(value)) return false;
  // Inspection-only filter commands: no filenames, shell redirection or scripts.
  if (/^(?:head -(?:[1-9]\d?|c [1-9]\d{0,4})|tail -[1-9]\d{0,2})$/.test(value)) return true;
  // Git inspection: recognize concrete options, not provider wildcard proposals.
  // Keep option names separate from path arguments so flags such as --ext-diff,
  // --no-index and --output cannot be admitted as arbitrary path strings.
  if (/^git status(?:\s+(?:-sb|-s|-b|--short|--porcelain(?:=v[12])?|--branch|-u(?:all|normal|no)?|--untracked-files(?:=(?:all|normal|no))?))*$/.test(value)) return true;
  if (/^git (?:branch --show-current|rev-parse (?:HEAD|--show-toplevel|--is-inside-work-tree|--abbrev-ref HEAD|origin\/master)|log -(?:[1-9]|1\d|20)(?: --oneline)?|log --oneline -(?:[1-9]|1\d|20)|log origin\/master -1 --format='%H %s')$/.test(value)) return true;
  if (/^git log -[1235] --format='%H %s'$/.test(value)) return true;
  if (/^git show (?:(?:--stat |--name-only --format="" )[0-9a-f]{7,40}|[0-9a-f]{7,40} (?:--stat|--name-only --format="")|--stat --format='%H%n%an%n%s' [0-9a-f]{7,40})$/.test(value)) return true;
  if (value === "git diff" || value.startsWith("git diff ")) {
    const args = value.slice("git diff".length).trim().split(/\s+/).filter(Boolean);
    const allowedOption = /^(?:--stat|--check|--numstat|--name-only|--name-status|--cached|--staged|--unified=\d+|-U\d+)$/;
    let pathOnly = false;
    return args.every((arg) => {
      if (!pathOnly && arg === "--") { pathOnly = true; return true; }
      if (!pathOnly && allowedOption.test(arg)) return true;
      // Relative workspace paths only; no option-like tokens, traversal or
      // sensitive Git metadata. Unknown flags must go to the human queue.
      return /^[\w.][\w./-]*$/.test(arg) &&
        !arg.split("/").some((part) => part === ".." || part === ".git" || part.startsWith(".env"));
    });
  }
  if (/^(?:npm run (?:check|test:unit|smoke)|bash scripts\/smoke-test\.sh)(?: 2>&1)?$/.test(value)) return true;
  if (/^(?:pwd|ss -ltnp?|node --check [\w./-]+\.js)$/.test(value)) return true;
  return false;
}

// Claude submits the complete Bash invocation, while OpenCode often
// submits concrete segments. Use the same inspection classifier for both.
// Each segment is a closed grammar, never a generic shell allow-list.
function isSafeGitInspectionSegment(segment: string, root: string, contextual: boolean): boolean {
  if (segment.startsWith("echo ")) return isSafeShell(segment);
  let body = segment;
  const bounded = /^(git .+) \| head -(?:n )?(?:[1-9]\d?|100)$/.exec(body);
  if (bounded) body = bounded[1]!;
  body = body.replace(/ 2>&1$/, "");
  const timed = /^timeout (?:[1-9]|[1-9]\d|1[01]\d|120) (git ls-remote .+)$/.exec(body);
  if (timed) body = timed[1]!;
  if (!body.startsWith("git ") && body !== "type -a git") return false;
  if (isContextualGitInspection(body) && !contextual) return false;
  return isSafeShell(body) || isGitWorkflowInspection(body, root);
}

function isSafeGitInspectionChain(command: string, projectPath: string, cwd?: string): boolean {
  if (!isAbsolute(projectPath) || command.length > 2400 ||
      /[\r\n\x00-\x1f\x60]/.test(command)) return false;
  const parts = command.trim().split(/ && |; /);
  if (parts.length > 20) return false;
  let explicitRoot = false;
  if (parts[0]?.startsWith("cd ")) {
    if (/["'&|;<>$\x60\\]/.test(projectPath)) return false;
    if (parts.shift() !== 'cd "' + projectPath + '"' ||
        !command.trim().startsWith('cd "' + projectPath + '" && ')) return false;
    explicitRoot = true;
  }
  // A semicolon after a failed cd could execute in the previous directory.
  // Therefore it requires independently verified current cwd at the root.
  const hasSemicolon = command.includes("; ");
  const rootCwd = cwd === projectPath;
  if (explicitRoot && hasSemicolon && !rootCwd) return false;
  const contextual = rootCwd || (explicitRoot && !hasSemicolon);
  return parts.some(part => /^(?:git |timeout \d+ git )/.test(part)) &&
    parts.every(part => isSafeGitInspectionSegment(part, projectPath, contextual));
}

/** Explicitly disabling the engine's sandbox is never an ordinary grant.
 * Check both the policy and the mandatory Claude PreToolUse hook. */
export function requestsSandboxBypass(input: unknown): boolean {
  const record = object(input);
  return Object.prototype.hasOwnProperty.call(record, "dangerouslyDisableSandbox") &&
    record.dangerouslyDisableSandbox !== false && record.dangerouslyDisableSandbox !== undefined;
}

// Only the selected project's existing wrapper, with bounded test/build
// tasks. Like npm test this executes project code: trusted workspace only.
function isSafeGradleVerification(command: string, projectPath: string): boolean {
  if (!isAbsolute(projectPath) || command.length > 1200 ||
      /[\r\n\x00-\x1f\x60\\]/.test(command)) return false;
  let body = command.trim();
  const prefix = 'cd "' + projectPath + '" && ';
  if (body.startsWith("cd ")) {
    if (/["'&;$|<>\x60\\]/.test(projectPath) || !body.startsWith(prefix)) return false;
    body = body.slice(prefix.length);
  }
  // Tail is bounded; without PIPESTATUS the displayed shell exit is not
  // evidence of Gradle success. The runtime logs that limitation.
  const pipeline = / 2>&1 \| tail -(?:n )?(?:[1-9]\d?|100)(?:; echo "(?:EXIT_CODE|exit|TEST_EXIT)=\$\{PIPESTATUS\[0\]\}")?$/;
  body = body.replace(pipeline, "").replace(/ 2>&1$/, "");
  if (!/^\.\/gradlew (?:test|build|check|(?::[A-Za-z0-9_-]+)+:test)(?: (?:(?::[A-Za-z0-9_-]+)+:test|--console=plain|--rerun-tasks|--offline|--no-daemon)){0,12}$/.test(body)) return false;
  try {
    const wrapper = resolve(projectPath, "gradlew");
    const info = lstatSync(wrapper);
    return realpathSync(projectPath) === projectPath && info.isFile() &&
      !info.isSymbolicLink() && realpathSync(wrapper) === wrapper;
  } catch { return false; }
}

function getShellCommand(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "shell" && tool !== "Bash") return null;
  return typeof input.command === "string" ? input.command : null;
}

function checkBrowserAction(name: string, input: Record<string, unknown>, projectPath: string): AuditorAssessment {
  if (/^playwright_browser_(?:snapshot|tabs|console_messages|close)$/.test(name)) {
    return { verdict: "auto", category: "browser", reason: "Inspección de navegador sin escritura solicitada." };
  }
  if (name === "playwright_browser_resize" &&
      Number.isInteger(input.width) && Number(input.width) >= 320 && Number(input.width) <= 3840 &&
      Number.isInteger(input.height) && Number(input.height) >= 240 && Number(input.height) <= 2400) {
    return { verdict: "auto", category: "browser", reason: "Cambio de tamaño del navegador de pruebas." };
  }
  if (name === "playwright_browser_navigate" && typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          /^\/((?:api\/health)?)$/.test(url.pathname) && !url.search && !url.hash) {
        return { verdict: "auto", category: "browser", reason: "Navegación GET al inicio o salud de un servidor local." };
      }
    } catch { /* Human must inspect malformed URLs. */ }
  }
  if (name === "playwright_browser_take_screenshot") {
    const file = input.filename;
    let confined = file === undefined || file === null;
    if (typeof file === "string" && /^\.playwright-mcp\/[\w.-]+\.png$/.test(file) &&
        isWithinProject(file, projectPath)) {
      // Do not overwrite a symlink that escapes the project or a screenshot
      // folder redirected to another directory.
      const absoluteTarget = resolve(projectPath, file);
      try {
        const folder = lstatSync(resolve(projectPath, ".playwright-mcp"));
        const output = (() => { try { return lstatSync(absoluteTarget); } catch { return null; } })();
        confined = folder.isDirectory() && !folder.isSymbolicLink() && !output?.isSymbolicLink();
      } catch { confined = false; }
    }
    if (confined) {
      return { verdict: "auto", category: "browser", reason: "Captura de pantalla confinada al directorio de pruebas." };
    }
  }
  return {
    verdict: "human", category: "browser",
    reason: "La acción del navegador puede alterar la sesión o sus datos; se requiere revisión humana."
  };
}

/**
 * Called for every permission request, using the engine's *actual* tool input.
 * Do not treat provider-suggested wildcard resources/save globs as authorization.
 */
export function assessAuditorTool(request: AuditorToolRequest): AuditorAssessment {
  const input = object(request.input);
  const tool = request.toolName;
  const shell = getShellCommand(tool, input);
  if (shell !== null && isProtectedShellCommand(shell)) {
    return { verdict: "block", category: "high-risk",
      reason: "Operación de terminación/destrucción o control de servicio: no hay prueba de que el proceso pertenezca al agente. El Auditor la bloqueó." };
  }
  if (shell !== null && /^git config (?:--global|--system)(?: |$)/.test(shell.trim())) {
    return { verdict: "block", category: "high-risk", reason: "Configuración Git global o del sistema: puede exponer credenciales. Usa consultas acotadas del proyecto." };
  }
  if (requestsSandboxBypass(input)) {
    return { verdict: "block", category: "high-risk",
      reason: "La solicitud intenta desactivar el sandbox. Repite la operación sin dangerouslyDisableSandbox; el Auditor no autoriza esta excepción." };
  }
  if (request.permissionProfile !== "workspace-write") {
    return { verdict: "human", category: "unknown",
      reason: "El perfil de permisos del agente no permite ampliar automáticamente su alcance." };
  }
  if (shell !== null) {
    const workdir = input.workdir ?? input.cwd;
    if (workdir !== undefined && (typeof workdir !== "string" ||
        !isWithinProject(workdir, request.projectPath))) {
      return { verdict: "human", category: "high-risk", reason: "El comando solicita trabajar fuera del proyecto." };
    }
    if (input.env !== undefined || input.environment !== undefined) return { verdict: "human", category: "high-risk", reason: "El comando solicita alterar el entorno de ejecución." };
    const diagnostic = assessDiagnosticCommand(shell, request.projectPath, typeof workdir === "string" ? workdir : undefined, request.roundInstructions) ?? assessIndependentDiagnostic(shell, request.projectPath);
    if (diagnostic) return { verdict: "auto", category: diagnostic.category,
      reason: "Diagnóstico acotado del proyecto con directorio y comando verificados." };
    const gradle = (workdir === undefined || resolve(request.projectPath, String(workdir)) === request.projectPath) && isSafeGradleVerification(shell, request.projectPath);
    if (gradle || isSafeShell(shell) || isSafeGitInspectionChain(shell, request.projectPath, typeof workdir === "string" ? resolve(request.projectPath, workdir) : undefined) || (isGitWorkflowInspection(shell.trim(), request.projectPath) && (!isContextualGitInspection(shell.trim()) || (workdir !== undefined && resolve(request.projectPath, String(workdir)) === request.projectPath && input.env === undefined && input.environment === undefined)))) {
      return { verdict: "auto", category: gradle || /npm run|smoke-test/.test(shell) ? "test" : "inspection",
        reason: gradle && /\| tail /.test(shell) && !shell.includes("PIPESTATUS[0]")
          ? "Verificación Gradle con salida acotada; el código de salida del filtro no acredita éxito de Gradle. Contrasta JUnit y BUILD SUCCESSFUL/FAILED."
          : "Comando exacto de comprobación autorizado por lista conservadora." };
    }
    return { verdict: "human", category: "unknown",
      reason: "Comando shell no incluido en la lista segura; requiere valoración humana." };
  }
  if (tool.startsWith("playwright_browser_")) return checkBrowserAction(tool, input, request.projectPath);
  if (tool === "BashOutput") {
    return { verdict: "auto", category: "inspection", reason: "Lectura del resultado de un comando ya iniciado." };
  }
  return { verdict: "human", category: "unknown",
    reason: "Herramienta no identificada como operación segura; requiere autorización humana." };
}

export function assessOpenCodePermission(
  request: Record<string, unknown>, projectPath: string,
  permissionProfile: AuditorToolRequest["permissionProfile"],
  authority?: GitRoundAuthority, nativeInput: Record<string, unknown> | null = null
): AuditorAssessment {
  const tool = String(request.action ?? request.permission ?? "");
  const metadata = object(request.metadata);
  const input = object(metadata.input);
  if (requestsSandboxBypass(input) || requestsSandboxBypass(metadata) || requestsSandboxBypass(request) || requestsSandboxBypass(nativeInput)) {
    return { verdict: "block", category: "high-risk", reason: "No se autoriza desactivar el sandbox." };
  }
  if (tool === "shell" && permissionProfile === "workspace-write" &&
      Array.isArray(request.resources) && request.resources.every((r): r is string => typeof r === "string") &&
      nativeInput && typeof nativeInput.command === "string" && (nativeInput.workdir === undefined || nativeInput.workdir === projectPath) &&
      (nativeInput.cwd === undefined || nativeInput.cwd === projectPath) &&
      nativeInput.env === undefined && nativeInput.environment === undefined &&
      !isProtectedShellCommand(nativeInput.command)) {
    const diagnostic = assessDiagnosticCommand(nativeInput.command, projectPath, nativeInput.workdir === projectPath ? projectPath : undefined, authority?.instructions) ?? assessIndependentDiagnostic(nativeInput.command, projectPath);
    if (diagnostic && matchDiagnosticResources(request.resources, diagnostic.resources))
      return { verdict: "auto", category: diagnostic.category, reason: "Diagnóstico concreto verificado contra la llamada nativa; no se conceden comodines." };
  }
  if (tool === "shell" && permissionProfile === "workspace-write" && Array.isArray(request.resources) &&
      request.resources.length > 0 && request.resources.length <= 12 &&
      request.resources.every((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 6500)) {
    if (assessAuthorizedGitWorkflow(request.resources, projectPath, authority, nativeInput,
        (value) => !isProtectedShellCommand(value) && isSafeShell(value) && /^(?:git |echo )/.test(value))) {
      return { verdict: "auto", category: "workspace", reason: "Operación Git concreta autorizada expresamente en esta ronda por el usuario; archivos, comando nativo y destino comprobados." };
    }
  }
  if (tool === "shell" && typeof input.command !== "string") {
    // OpenCode 2.1 supplies a *segmented* resources list for shell permissions,
    // e.g. ["npm run check"] or ["git status --porcelain", "git diff --stat"].
    // Do not confuse provider-proposed save patterns with executable commands.
    const resources = Array.isArray(request.resources) ? request.resources : [];
    if (!resources.length || resources.length > 12 ||
        !resources.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 1200)) {
      return { verdict: "human", category: "unknown", reason: "OpenCode no describió todos los segmentos del comando." };
    }
    if (resources.some((resource) => isProtectedShellCommand(resource))) {
      return { verdict: "block", category: "high-risk",
        reason: "Segmento de shell destructivo o de terminación de procesos. Requiere revisión humana, nunca autoaprobación." };
    }
    const workdir = input.workdir ?? input.cwd ?? metadata.workdir ?? metadata.cwd;
    if (workdir !== undefined && (typeof workdir !== "string" || !isWithinProject(workdir, projectPath))) {
      return { verdict: "human", category: "high-risk", reason: "El comando solicita trabajar fuera del proyecto." };
    }
    if (resources.some(resource => /^git config (?:--global|--system)(?: |$)/.test(resource))) {
      return { verdict: "block", category: "high-risk", reason: "Configuración Git global o del sistema: puede exponer credenciales. Usa consultas acotadas del proyecto." };
    }
    const remoteInspection = resources.some(resource => /(?:^| && |; |timeout \d+ )git (?:config|remote|ls-remote|fetch)(?: |$)/.test(resource));
    if (remoteInspection && (!nativeInput || nativeInput.workdir !== projectPath ||
        (nativeInput.cwd !== undefined && nativeInput.cwd !== projectPath) || nativeInput.env !== undefined || nativeInput.environment !== undefined ||
        typeof nativeInput.command !== "string" || !nativeGitCommandMatches(nativeInput.command, resources))) {
      return { verdict: "human", category: "unknown", reason: "La consulta de configuración o remoto exige verificar el comando nativo y la raíz real del proyecto." };
    }
    const gradle = (workdir === undefined || resolve(projectPath, String(workdir)) === projectPath)
      && resources.some((resource) => isSafeGradleVerification(resource, projectPath));
    if (permissionProfile === "workspace-write" && resources.every((resource) => isSafeShell(resource) || isSafeGitInspectionChain(resource, projectPath, remoteInspection ? projectPath : undefined) || isGitWorkflowInspection(resource, projectPath) ||
        (gradle && isSafeGradleVerification(resource, projectPath)))) {
      return { verdict: "auto", category: gradle || resources.some((r) => /npm run|smoke-test/.test(r)) ? "test" : "inspection",
        reason: "Todos los segmentos concretos del shell coinciden con comandos de lectura/pruebas autorizados." };
    }
    return { verdict: "human", category: "unknown",
      reason: "Uno o más segmentos no son operaciones permitidas por la lista conservadora." };
  }
  if (!tool) return { verdict: "human", category: "unknown", reason: "Acción sin nombre." };
  return assessAuditorTool({ engine: "opencode", toolName: tool, input, projectPath, permissionProfile });
}
