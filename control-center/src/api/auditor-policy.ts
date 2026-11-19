/**
 * Auditor de permisos de la fábrica.
 *
 * This is a deterministic, fail-closed policy, not a language model
 * improvising security decisions. It never expands read-only profiles.
 * Unknown operations and user questions must reach the human queue.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { lstatSync } from "node:fs";

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

function isSafeShell(command: string): boolean {
  const value = command.trim();
  // Never parse untrusted shell fragments as though they were argv: reject
  // substitutions, redirection, pipes, command chaining and control characters.
  if (!value || value.length > 1200 || /[\r\n;|&<>\x00-`]/.test(value) ||
      /\$|\\|\*|\?|\b(?:eval|exec|source|env|xargs|python|node\s+-e|npx)\b/i.test(value)) return false;
  return /^(?:pwd|git status(?:\s+(?:-sb|--short|--porcelain(?:=v1)?|--branch))*|git diff(?:\s+(?:--stat|--check|--numstat|--name-only|--cached|--unified=\d+|-U\d+|--|[\w./-]+))*|git log\s+-(?:1|2|3|5)(?:\s+--oneline)?|git rev-parse\s+(?:--show-toplevel|--is-inside-work-tree|HEAD)|npm run (?:check|test:unit|smoke)|bash scripts\/smoke-test\.sh|ss\s+-ltnp?|ss\s+-ltn|node\s+--check\s+[\w./-]+\.js)$/i.test(value);
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
    if (isSafeShell(shell)) {
      return { verdict: "auto", category: /npm run|smoke-test/.test(shell) ? "test" : "inspection",
        reason: "Comando exacto de comprobación autorizado por lista conservadora." };
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
  permissionProfile: AuditorToolRequest["permissionProfile"]
): AuditorAssessment {
  const tool = String(request.action ?? request.permission ?? "");
  const metadata = object(request.metadata);
  const input = object(metadata.input);
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
    if (permissionProfile === "workspace-write" && resources.every((resource) => isSafeShell(resource))) {
      return { verdict: "auto", category: resources.some((r) => /npm run|smoke-test/.test(r)) ? "test" : "inspection",
        reason: "Todos los segmentos concretos del shell coinciden con comandos de lectura/pruebas autorizados." };
    }
    return { verdict: "human", category: "unknown",
      reason: "Uno o más segmentos no son operaciones permitidas por la lista conservadora." };
  }
  if (!tool) return { verdict: "human", category: "unknown", reason: "Acción sin nombre." };
  return assessAuditorTool({ engine: "opencode", toolName: tool, input, projectPath, permissionProfile });
}
