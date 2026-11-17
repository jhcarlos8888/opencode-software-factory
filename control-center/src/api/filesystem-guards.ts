import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git", ".hg", ".svn", ".bzr",
  ".claude", ".ssh", ".aws", ".azure", ".config", ".local",
  ".gnupg", ".kube", ".docker", ".npm", ".pki"
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf",
  ".htpasswd", ".envrc"
]);

const SENSITIVE_FILE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".p7b", ".p7c",
  ".der", ".jks", ".keystore", ".kdbx", ".ppk", ".crt"
]);

const SENSITIVE_NAME_PATTERN =
  /(?:^|[._-])(?:credentials?|secrets?|token|api[_-]?key|private[_-]?key|id_rsa|id_ed25519)(?:$|[._-])/i;

/** OpenCode V2 glob resources mirroring the canonical Claude filesystem guard. */
export const OPENCODE_SENSITIVE_PATH_GLOBS = [
  "**/.git/**", "**/.hg/**", "**/.svn/**", "**/.bzr/**",
  "**/.env*", "**/.envrc", "**/.netrc", "**/.npmrc", "**/.pypirc",
  "**/.pgpass", "**/.my.cnf", "**/.htpasswd",
  "**/.claude/**", "**/.ssh/**", "**/.aws/**", "**/.azure/**",
  "**/.config/**", "**/.local/**", "**/.gnupg/**", "**/.kube/**",
  "**/.docker/**", "**/.npm/**", "**/.pki/**",
  "**/secrets/**", "**/credentials/**",
  "**/*credentials*", "**/*secret*", "**/*_token*", "**/*-token*",
  "**/*_api_key*", "**/*-api-key*", "**/*apikey*", "**/*private_key*",
  "**/*id_rsa*", "**/*id_ed25519*",
  "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.p7b",
  "**/*.p7c", "**/*.der", "**/*.jks", "**/*.keystore", "**/*.kdbx",
  "**/*.ppk", "**/*.crt"
] as const;

function pathSegments(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isSensitiveSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  if (SENSITIVE_DIRECTORY_NAMES.has(normalized) ||
      [...SENSITIVE_DIRECTORY_NAMES].some((name) => normalized.startsWith(name + "*") || normalized.startsWith(name + "?"))) return true;
  if (SENSITIVE_FILE_NAMES.has(normalized)) return true;
  if (/^\.env(?:$|[.*?])/i.test(segment)) return true;
  if (SENSITIVE_FILE_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf(".")))) return true;
  return SENSITIVE_NAME_PATTERN.test(segment);
}

export function isSensitiveFilesystemPath(pathValue: string): boolean {
  return pathSegments(pathValue).some(isSensitiveSegment);
}

export function isSafeFilesystemGlob(pattern: unknown): pattern is string {
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.length > 4096 ||
    pattern.includes("\0") ||
    isAbsolute(pattern) ||
    pattern.startsWith("~")
  ) {
    return false;
  }

  const segments = pathSegments(pattern);
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (segments.some(isSensitiveSegment)) return false;
  if (segments.some((segment) =>
    /[*?]/.test(segment) &&
    /(?:token|api[_-]?key|private[_-]?key|credentials?|secrets?|id_rsa|id_ed25519)/i.test(segment)
  )) return false;
  if (pattern === "*" || pattern === "**" || pattern === "**/*") return false;
  return true;
}

/**
 * Execution must start from the same canonical root selected at preflight.
 * A symlink or path substitution between preflight and process creation fails
 * closed rather than silently changing the project being accessed.
 */
export async function requireCanonicalProjectRoot(projectPath: string): Promise<string> {
  const absolutePath = resolve(projectPath);
  const canonicalPath = await realpath(absolutePath).catch(() => null);
  if (!canonicalPath || canonicalPath !== absolutePath) {
    throw new Error("La ruta del proyecto dejó de ser canónica desde la preconsulta. Vuelve a analizar el proyecto.");
  }
  const info = await stat(canonicalPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error("La ruta canónica del proyecto no existe o dejó de ser un directorio.");
  }
  return canonicalPath;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const rel = relative(directory, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

export async function resolveProjectCandidate(
  projectPath: string,
  candidate: unknown
): Promise<string | null> {
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    candidate.length > 4096 ||
    candidate.includes("\0")
  ) return null;

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

function decodeFileUri(value: string): string | null {
  if (!value.startsWith("file://")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") ||
        url.search || url.hash) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function hasSensitiveSearchScope(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "Glob" && !isSafeFilesystemGlob(input.pattern)) return true;
  if (toolName === "Grep") {
    for (const field of ["glob", "file_glob", "glob_pattern"]) {
      const value = input[field];
      if (value !== undefined && !isSafeFilesystemGlob(value)) return true;
    }
  }
  return false;
}

export async function claudeToolPathIsAllowed(
  projectPath: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  // Skill/TodoRead do not accept arbitrary filesystem paths.
  if (toolName === "Skill" || toolName === "TodoRead") return true;
  if (hasSensitiveSearchScope(toolName, input)) return false;

  let rawPath = inputPath(input);
  if (rawPath === undefined && ["Glob", "Grep", "LS", "List", "LSP"].includes(toolName)) {
    rawPath = ".";
  }
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;

  const normalizedPath = decodeFileUri(rawPath);
  if (!normalizedPath || isSensitiveFilesystemPath(normalizedPath)) return false;

  const canonicalPath = await resolveProjectCandidate(projectPath, normalizedPath);
  if (!canonicalPath || isSensitiveFilesystemPath(canonicalPath)) return false;

  return true;
}
