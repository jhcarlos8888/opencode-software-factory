/**
 * Resolución REAL del alcance de una auditoría `security-audit`.
 *
 * Toda semilla del ledger debe apoyarse en ficheros regulares REALES del
 * target, expresados como rutas relativas POSIX al proyecto: nada de `.`,
 * listas vacías, rutas declaradas sin verificación ni nombres ficticios.
 *
 * Reglas que sostiene este módulo:
 * - `root`/`scope` se resuelven con `realpath`: el target debe existir y ser
 *   un directorio real.
 * - Un `scope_path` se valida léxicamente (relativo POSIX, sin traversal, sin
 *   absolutas) y se verifica componente a componente con `lstat`: cualquier
 *   componente symlink se rechaza y NUNCA se sigue.
 * - El contenido enumerado queda dentro de `root` por construcción (no se
 *   sale con `..` ni con enlaces).
 * - Se excluyen `.git`, `node_modules`, ficheros de secretos y directorios
 *   sensibles (misma política que `filesystem-guards.ts`).
 * - El orden es determinista (comparación binaria lexicográfica).
 * - `project`/`domain` enumeran el target real completo; `directory`/
 *   `component` aceptan un fichero concreto o recorren un directorio;
 *   `git-diff` usa por ahora solo los `scope_paths` que son ficheros reales.
 * - Si no hay ficheros elegibles o se supera un límite defensivo, se lanza un
 *   error explícito (nunca se trunca la enumeración).
 */

import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isSensitiveFilesystemPath } from "./filesystem-guards.js";
import type { SecurityAuditScope } from "./security-audit-contracts.js";

/**
 * Límite defensivo por lista de rutas de arranque: coincide con el tope
 * `collectionItems` del validador oficial del coverage ledger (1000). Un
 * alcance que necesite más ficheros NO se trunca: se rechaza con error
 * explícito para que el run termine `incomplete`.
 */
export const SECURITY_AUDIT_SCOPE_MAX_FILES = 1000;

/** Cota defensiva de entradas recorridas: evita recorridos desbocados. */
const MAX_WALKED_ENTRIES = 50_000;

/** Directorios de dependencias/entorno excluidos además de los sensibles. */
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules"]);

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export class SecurityAuditScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SecurityAuditScopeError";
  }
}

function scopeError(code: string, message: string): SecurityAuditScopeError {
  return new SecurityAuditScopeError(code, message);
}

/** Comparación binaria lexicográfica: orden determinista y estable. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byPath);
}

/** Valida la forma léxica de un `scope_path` declarado. */
function assertScopePathShape(raw: string): void {
  if (typeof raw !== "string" || raw.length === 0) {
    throw scopeError("scope_path_empty", "scope_paths no admite cadenas vacías");
  }
  if (raw.length > 4096 || raw.includes("\0")) {
    throw scopeError("scope_path_invalid", `scope_path inválido: ${JSON.stringify(raw.slice(0, 64))}`);
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw scopeError("scope_path_invalid", `scope_path con caracteres de control: ${JSON.stringify(raw.slice(0, 64))}`);
  }
  if (raw.includes("\\") || raw.includes(":")) {
    throw scopeError("scope_path_invalid", `scope_path debe ser relativo POSIX sin separadores de Windows: ${JSON.stringify(raw.slice(0, 64))}`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[/\\]/.test(raw) || raw.startsWith("~")) {
    throw scopeError("scope_path_absolute", `scope_path debe ser relativo al target: ${JSON.stringify(raw.slice(0, 64))}`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw scopeError("scope_path_traversal", `scope_path con segmentos vacíos o de traversal: ${JSON.stringify(raw.slice(0, 64))}`);
  }
  if (isSensitiveFilesystemPath(raw)) {
    throw scopeError("scope_path_sensitive", `scope_path sensible excluido: ${JSON.stringify(raw.slice(0, 64))}`);
  }
}

interface ScopePathCheck {
  relative: string;
  kind: "file" | "directory";
}

/**
 * Verifica un `scope_path` componente a componente desde `root` con `lstat`
 * (sin seguir symlinks): rechaza componentes ausentes, symlink o sensibles y
 * garantiza que el contenido queda dentro de `root`.
 */
async function checkScopePath(root: string, raw: string): Promise<ScopePathCheck> {
  assertScopePathShape(raw);
  let current = root;
  const segments = raw.split("/");
  for (const segment of segments) {
    current = `${current}/${segment}`;
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      throw scopeError("scope_path_missing", `scope_path inexistente en el target: ${JSON.stringify(raw)}`);
    }
    if (stats.isSymbolicLink()) {
      throw scopeError("scope_path_symlink", `scope_path con componente symlink no permitido: ${JSON.stringify(raw)}`);
    }
  }
  const finalStats = await stat(current);
  if (finalStats.isFile()) return { relative: raw, kind: "file" };
  if (finalStats.isDirectory()) return { relative: raw, kind: "directory" };
  throw scopeError("scope_path_not_regular", `scope_path no es fichero ni directorio: ${JSON.stringify(raw)}`);
}

/**
 * Recorre `dir` (real, sin symlinks) y devuelve los ficheros regulares reales
 * relativos POSIX a `root`, excluyendo `.git`, `node_modules`, secretos y
 * directorios sensibles. No sigue symlinks: se omiten ficheros y directorios
 * enlazados. Aborta con error si se supera un límite defensivo.
 */
async function walkRealFiles(
  root: string,
  dir: string,
  sink: { files: string[]; walked: number },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Un subárbol no enumerado es una brecha de cobertura, nunca una omisión silenciosa.
    const relativePath = dir === root ? "<target>" : dir.slice(root.length + 1);
    throw scopeError("walk_unreadable", `no se pudo enumerar ${JSON.stringify(relativePath)}: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
  }
  for (const entry of entries) {
    sink.walked += 1;
    if (sink.walked > MAX_WALKED_ENTRIES) {
      throw scopeError(
        "walk_limit",
        `la enumeración del target supera el límite defensivo de ${MAX_WALKED_ENTRIES} entradas`,
      );
    }
    const relativePath = dir === root ? entry.name : `${dir.slice(root.length + 1)}/${entry.name}`;
    if (entry.isSymbolicLink()) continue; // nunca se siguen enlaces
    if (isSensitiveFilesystemPath(relativePath)) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkRealFiles(root, `${dir}/${entry.name}`, sink);
      continue;
    }
    if (!entry.isFile()) continue; // solo ficheros regulares
    sink.files.push(relativePath);
  }
}

export interface SecurityAuditScopeFiles {
  /** Realpath del target: raíz canónica de la enumeración. */
  root: string;
  /** Todos los ficheros regulares reales del target (relativos POSIX, orden binario). */
  files: string[];
  /** Ficheros autorizados por el alcance concreto (subconjunto de `files`). */
  scopeFiles: string[];
}

export interface ResolveSecurityAuditScopeOptions {
  /** Límite defensivo por lista de ficheros (por defecto 1000). */
  maxFiles?: number;
}

/**
 * Resuelve el alcance contra el sistema de ficheros real. Lanza
 * `SecurityAuditScopeError` si el target no existe, un `scope_path` es
 * traversal/absoluto/symlink/sensible/ausente, si no hay ficheros elegibles o
 * si se supera el límite defensivo: nunca trunca.
 */
export async function resolveSecurityAuditScopeFiles(
  projectPath: string,
  scope: SecurityAuditScope,
  options: ResolveSecurityAuditScopeOptions = {},
): Promise<SecurityAuditScopeFiles> {
  const maxFiles = options.maxFiles ?? SECURITY_AUDIT_SCOPE_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw scopeError("bad_limit", "maxFiles debe ser un entero >= 1");
  }

  const root = await realpath(projectPath).catch(() => {
    throw scopeError("target_missing", `el target de la auditoría no existe: ${projectPath}`);
  });
  const rootStats = await stat(root).catch(() => {
    throw scopeError("target_missing", `el target de la auditoría no existe: ${projectPath}`);
  });
  if (!rootStats.isDirectory()) {
    throw scopeError("target_not_directory", `el target de la auditoría no es un directorio: ${projectPath}`);
  }

  const sink = { files: [] as string[], walked: 0 };
  await walkRealFiles(root, root, sink);
  const files = dedupeSorted(sink.files);
  if ((scope.kind === "project" || scope.kind === "domain") && files.length > maxFiles) {
    throw scopeError(
      "file_limit",
      `el target tiene ${files.length} ficheros reales y supera el límite defensivo de ${maxFiles}: no se trunca la enumeración`,
    );
  }

  let scopeFiles: string[];
  if (scope.kind === "project" || scope.kind === "domain") {
    // project/domain enumeran el target real completo.
    scopeFiles = files;
  } else if (scope.kind === "directory" || scope.kind === "component") {
    if (scope.scopePaths.length === 0) {
      throw scopeError("scope_paths_empty", `${scope.kind} exige al menos un scope_path`);
    }
    const collected: string[] = [];
    for (const raw of scope.scopePaths) {
      const check = await checkScopePath(root, raw);
      const under = check.kind === "file"
        ? files.filter((file) => file === check.relative)
        : files.filter((file) => file === check.relative || file.startsWith(`${check.relative}/`));
      if (under.length === 0) {
        throw scopeError(
          "scope_path_without_files",
          `el scope_path ${JSON.stringify(raw)} no contiene ficheros reales elegibles`,
        );
      }
      if (under.length > maxFiles) {
        throw scopeError(
          "file_limit",
          `el scope_path ${JSON.stringify(raw)} supera el límite defensivo de ${maxFiles} ficheros: no se trunca`,
        );
      }
      collected.push(...under);
    }
    scopeFiles = dedupeSorted(collected);
  } else {
    // git-diff: por ahora solo los scope_paths que son ficheros reales.
    scopeFiles = dedupeSorted(files.filter((file) => scope.scopePaths.includes(file)));
  }

  if (scopeFiles.length === 0) {
    throw scopeError(
      "scope_without_files",
      `el alcance ${scope.kind} no tiene ficheros reales elegibles en el target`,
    );
  }
  if (scopeFiles.length > maxFiles) {
    throw scopeError(
      "file_limit",
      `el alcance ${scope.kind} supera el límite defensivo de ${maxFiles} ficheros: no se trunca`,
    );
  }

  return { root, files, scopeFiles };
}

/**
 * Rutas de arranque de la semilla para un `scope_path` concreto: los ficheros
 * reales autorizados bajo esa ruta (la propia ruta si es fichero).
 */
export function startingPathsForScopePath(
  resolved: SecurityAuditScopeFiles,
  scopePath: string,
): string[] {
  return resolved.scopeFiles.filter(
    (file) => file === scopePath || file.startsWith(`${scopePath}/`),
  );
}

/**
 * Filtra las `starting_paths` de un prior run contra el conjunto real
 * autorizado: una ruta previa solo se conserva si es un fichero real del
 * conjunto. Si el filtro deja la lista vacía, se usa el fallback
 * determinista (ficheros autorizados bajo la superficie de la unidad; si no
 * hay, el conjunto autorizado completo) para que la unidad nunca quede sin
 * rutas reales. Nunca inventa rutas.
 */
export function priorStartingPathsForSurface(
  priorPaths: readonly string[],
  authorized: readonly string[],
  surface: string,
): string[] {
  const authorizedSet = new Set(authorized);
  const kept = priorPaths.filter((path) => authorizedSet.has(path));
  if (kept.length > 0) return dedupeSorted(kept);
  const under = authorized.filter(
    (file) => file === surface || file.startsWith(`${surface}/`),
  );
  if (under.length > 0) return dedupeSorted(under);
  return dedupeSorted(authorized);
}

/** Identidad del contenido autorizado: HEAD/dirty solos no identifican un worktree. */
export interface SecurityAuditSourceSnapshot {
  sha256: string;
  files: Array<{ path: string; sha256: string }>;
}

export async function snapshotSecurityAuditScope(resolved: SecurityAuditScopeFiles): Promise<SecurityAuditSourceSnapshot> {
  const files: SecurityAuditSourceSnapshot["files"] = [];
  let totalBytes = 0;
  const maxTotalBytes = 256 * 1024 * 1024;
  for (const path of dedupeSorted(resolved.scopeFiles)) {
    const checked = await checkScopePath(resolved.root, path);
    if (checked.kind !== "file") throw scopeError("snapshot_changed", "El alcance cambió durante la captura");
    const absolute = join(resolved.root, path);
    if (await realpath(absolute) !== absolute) throw scopeError("snapshot_changed", "Ruta de captura no canónica");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxTotalBytes - totalBytes) {
        throw scopeError("snapshot_limit", "No se puede identificar íntegramente el contenido autorizado dentro del límite de 256 MiB");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let read = 0;
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
        if (read > before.size || totalBytes + read > maxTotalBytes) throw scopeError("snapshot_changed", "El fichero cambió durante la captura");
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await handle.stat();
      const current = await lstat(absolute);
      if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev ||
          !current.isFile() || await realpath(absolute) !== absolute) {
        throw scopeError("snapshot_changed", "El fichero cambió durante la captura");
      }
      totalBytes += read;
      files.push({ path, sha256: hash.digest("hex") });
    } finally {
      await handle.close();
    }
  }
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
