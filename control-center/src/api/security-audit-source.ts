/**
 * Procedencia de origen REAL de una auditoría `security-audit` (F10).
 *
 * El servidor es la ÚNICA autoridad sobre `sourceRef`/`sourceDirty`: los
 * valores aportados por la API/cliente se rechazan en `security-audit-start`
 * (`client_source_not_authoritative`) y aquí nunca se leen. Todo `run`
 * resuelve su origen con `git` real mediante `spawnSync` argv (sin shell,
 * sin interpolación), con entorno acotado, timeout y límites de salida:
 *
 * - Repositorio Git: top-level real (`rev-parse --show-toplevel`), HEAD real
 *   (`rev-parse --verify --end-of-options HEAD`) y dirty real
 *   (`status --porcelain=v1 --untracked-files=all`, incluye untracked).
 *   `sourceRef` es el SHA completo de HEAD.
 * - Sin Git usable (binario ausente, no-repo, repo sin HEAD): fuente actual
 *   válida con `sourceRef = null` y evidencia local del fallo; nunca se
 *   hereda un `sourceRef` declarado.
 *
 * `git-diff`: `baseRef`/`headRef` se resuelven a commits completos con
 * `rev-parse --verify --end-of-options <ref>^{commit}` (las revisiones
 * van SIEMPRE tras `--end-of-options`: ninguna opción inyectada se ejecuta).
 * Exige HEAD actual == headRef resuelto y worktree limpio (si no,
 * `git_diff_worktree_mismatch`: el worktree no es el histórico del diff).
 * Los `scope_paths` reales salen de `git diff --name-only
 * --diff-filter=ACMR base head` y se INTERSECTAN con los declarados
 * (nunca se amplían); los ficheros deben existir como regulares en HEAD
 * actual, lo que garantiza `security-audit-scope`.
 */

import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";

/** Límite defensivo de rutas de un diff: coincide con el tope del scope. */
export const SECURITY_AUDIT_SOURCE_MAX_DIFF_PATHS = 1000;

/** Timeout por comando git y cota de salida capturada. */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export class SecurityAuditSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SecurityAuditSourceError";
  }
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  error: string | null;
}

/**
 * Ejecuta `git` con argv puro (sin shell), entorno mínimo acotado (sin
 * HOME/GIT_* del operador salvo PATH y locale C), timeout y maxBuffer. Los
 * `--no-optional-locks` evitan que las consultas escriban locks/index en el
 * target auditado.
 */
function runGit(cwd: string, args: readonly string[]): GitRunResult {
  let result;
  try {
    result = spawnSync("git", ["--no-pager", "--no-optional-locks",
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
      "-c", "core.untrackedCache=false", "-c", "core.ignoreStat=false",
      "-c", "submodule.recurse=false", "-c", "protocol.allow=never",
      "-C", cwd, ...args], {
      shell: false,
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        TERM: "dumb",
      },
    });
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    status: result.status ?? null,
    error: result.error ? String(result.error) : null,
  };
}

/**
 * Git status may invoke a repository-configured clean/process filter. Inspect
 * names without expanding includes before asking Git to inspect the worktree.
 * Source-only audits never execute project-supplied Git extensions.
 */
function assertSafeWorktreeConfig(repoTopLevel: string): void {
  const config = runGit(repoTopLevel, ["config", "--no-includes", "--null", "--name-only", "--list"]);
  if (!config.ok) {
    throw new SecurityAuditSourceError("git_config_unresolved", "No fue posible verificar la configuración Git local");
  }
  const keys = config.stdout.split("\0").map((key) => key.toLowerCase());
  if (keys.some((key) => /^filter\..+\.(clean|smudge|process)$/.test(key) || /^include(?:if\..+)?\.path$/.test(key))) {
    throw new SecurityAuditSourceError("git_unsafe_config", "La configuración Git contiene filtros ejecutables o includes; no se ejecuta status en modo source-only");
  }
  const tracked = runGit(repoTopLevel, ["ls-files", "--stage", "-z"]);
  if (!tracked.ok) {
    throw new SecurityAuditSourceError("git_index_unresolved", "No fue posible verificar el índice Git");
  }
  if (tracked.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw new SecurityAuditSourceError("git_submodules_unsupported", "Los submódulos requieren una auditoría separada en modo source-only");
  }
}

function nonEmptyLines(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

export interface SecurityAuditSourceResolution {
  /** `git` cuando hay repositorio usable; `non-git` en el resto. */
  kind: "git" | "non-git";
  /** Directorio consultado (realpath del projectPath). */
  projectPath: string;
  /** Top-level real del repositorio; `null` fuera de Git. */
  repoTopLevel: string | null;
  /** SHA completo de HEAD; `null` fuera de Git. */
  headSha: string | null;
  /** Identidad de origen persistible: SHA de HEAD o `null` (no-Git). */
  sourceRef: string | null;
  /** Dirty real calculado por el servidor (nunca heredado del cliente). */
  sourceDirty: boolean;
  /** Evidencia local acotada de la resolución (comandos y resultado). */
  evidence: string[];
}

/**
 * Resuelve el origen REAL del target: top-level, HEAD y dirty con `git`.
 * Sin Git usable devuelve una fuente actual válida con `sourceRef = null`
 * y evidencia local del motivo (nunca lanza por "no es Git").
 */
export async function resolveSecurityAuditSource(
  projectPath: string,
): Promise<SecurityAuditSourceResolution> {
  const root = await realpath(projectPath).catch(() => {
    throw new SecurityAuditSourceError(
      "target_missing",
      `el target de la auditoría no existe: ${projectPath}`,
    );
  });

  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return {
      kind: "non-git",
      projectPath: root,
      repoTopLevel: null,
      headSha: null,
      sourceRef: null,
      sourceDirty: false,
      evidence: [
        "git rev-parse --show-toplevel falló: el target no es un repositorio Git usable",
        `detalle: ${bounded(top.stderr || top.error || "sin detalle")}`,
      ],
    };
  }
  const repoTopLevel = top.stdout.trim();
  assertSafeWorktreeConfig(repoTopLevel);
  const head = runGit(repoTopLevel, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"]);
  if (!head.ok) {
    return {
      kind: "non-git",
      projectPath: root,
      repoTopLevel,
      headSha: null,
      sourceRef: null,
      sourceDirty: false,
      evidence: [
        `git rev-parse HEAD falló en ${repoTopLevel}: repositorio sin HEAD resoluble`,
        `detalle: ${bounded(head.stderr || head.error || "sin detalle")}`,
      ],
    };
  }
  const headSha = head.stdout.trim();
  const status = runGit(
    repoTopLevel,
    ["status", "--porcelain=v1", "--untracked-files=all", "--"],
  );
  if (!status.ok) {
    throw new SecurityAuditSourceError("git_status_unresolved", `git status falló: dirty real no verificable: ${bounded(status.stderr || status.error || "sin detalle")}`);
  }
  const dirtyEntries = nonEmptyLines(status.stdout);
  return {
    kind: "git",
    projectPath: root,
    repoTopLevel,
    headSha,
    sourceRef: headSha,
    sourceDirty: dirtyEntries.length > 0,
    evidence: [
      `git rev-parse --show-toplevel -> ${repoTopLevel}`,
      `git rev-parse HEAD -> ${headSha}`,
      `git status --porcelain -> ${dirtyEntries.length} entrada(s)`,
    ],
  };
}

export interface SecurityAuditGitDiffScopeInput {
  projectPath: string;
  /** Ref/base declarado (ya validado léxicamente en los contratos). */
  baseRef: string;
  /** Ref/head declarado: debe ser EXACTAMENTE el HEAD actual. */
  headRef: string;
  /** scope_paths declarados (opcionales): el diff nunca se amplía. */
  declaredPaths: readonly string[];
  /** Límite defensivo de rutas (por defecto 1000). */
  maxPaths?: number;
}

export interface SecurityAuditGitDiffScope {
  /** Top-level real del repositorio. */
  repoTopLevel: string;
  /** Commits completos resueltos (persistibles como refs oficiales). */
  baseSha: string;
  headSha: string;
  /** Rutas changed (ACMR) del diff completo, orden determinista. */
  changedPaths: string[];
  /** scope_paths reales definitivos: changed ∩ declarados (o todo el diff). */
  scopePaths: string[];
  /** Identidad de origen del diff: head SHA y worktree limpio. */
  sourceRef: string;
  sourceDirty: false;
  evidence: string[];
}

/** Resuelve un ref a commit completo con `rev-parse` seguro. */
function revParseCommit(repoTopLevel: string, ref: string): string {
  const run = runGit(repoTopLevel, [
    "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`,
  ]);
  if (!run.ok) {
    throw new SecurityAuditSourceError(
      "git_diff_unresolved",
      `la referencia ${JSON.stringify(ref)} no resuelve a un commit completo: ${
        bounded(run.stderr || run.error || "sin detalle")
      }`,
    );
  }
  return run.stdout.trim();
}

/**
 * Resuelve el alcance REAL de un scope `git-diff`. Lanza
 * `SecurityAuditSourceError` con `git_diff_unresolved` si git/refs fallan,
 * `git_diff_worktree_mismatch` si HEAD actual ≠ headRef o el worktree está
 * dirty, `git_diff_file_limit` al superar el tope y `git_diff_scope_empty`
 * si la intersección con los declarados no deja rutas.
 */
export async function resolveSecurityAuditGitDiffScope(
  input: SecurityAuditGitDiffScopeInput,
): Promise<SecurityAuditGitDiffScope> {
  const maxPaths = input.maxPaths ?? SECURITY_AUDIT_SOURCE_MAX_DIFF_PATHS;
  if (!Number.isInteger(maxPaths) || maxPaths < 1) {
    throw new SecurityAuditSourceError("bad_limit", "maxPaths debe ser un entero >= 1");
  }
  const root = await realpath(input.projectPath).catch(() => {
    throw new SecurityAuditSourceError(
      "target_missing",
      `el target de la auditoría no existe: ${input.projectPath}`,
    );
  });
  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    throw new SecurityAuditSourceError(
      "git_diff_unresolved",
      `git-diff exige un repositorio Git usable y ${input.projectPath} no lo es: ${
        bounded(top.stderr || top.error || "sin detalle")
      }`,
    );
  }
  const repoTopLevel = top.stdout.trim();
  assertSafeWorktreeConfig(repoTopLevel);
  const baseSha = revParseCommit(repoTopLevel, input.baseRef);
  const headSha = revParseCommit(repoTopLevel, input.headRef);

  // El worktree NO es el histórico del diff: headRef debe ser el HEAD actual
  // y el worktree debe estar limpio (incluye untracked). Sin esta igualdad
  // leer el worktree como si fuera el head del diff fabricaría evidencia.
  const currentHead = revParseCommit(repoTopLevel, "HEAD");
  const status = runGit(
    repoTopLevel,
    ["status", "--porcelain=v1", "--untracked-files=all", "--"],
  );
  if (!status.ok) {
    throw new SecurityAuditSourceError(
      "git_diff_unresolved",
      `git status falló en ${repoTopLevel}: ${bounded(status.stderr || status.error || "sin detalle")}`,
    );
  }
  const dirtyEntries = nonEmptyLines(status.stdout);
  if (currentHead !== headSha || dirtyEntries.length > 0) {
    const motive = currentHead !== headSha
      ? `HEAD actual ${currentHead} no es el headRef resuelto ${headSha}`
      : `el worktree está dirty con ${dirtyEntries.length} entrada(s) (incluye untracked)`;
    throw new SecurityAuditSourceError(
      "git_diff_worktree_mismatch",
      `git-diff exige headRef == HEAD actual y worktree limpio: ${motive}. ` +
        "El worktree no se lee como si fuera el histórico del diff.",
    );
  }

  const diff = runGit(
    root,
    ["diff", "--relative", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--diff-filter=ACMR", "--end-of-options", baseSha, headSha, "--"],
  );
  if (!diff.ok) {
    throw new SecurityAuditSourceError(
      "git_diff_unresolved",
      `git diff base..head falló: ${bounded(diff.stderr || diff.error || "sin detalle")}`,
    );
  }
  const changedPaths = [...new Set(diff.stdout.split("\0").filter(Boolean))].sort();
  if (changedPaths.length > maxPaths) {
    throw new SecurityAuditSourceError(
      "git_diff_file_limit",
      `el diff ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} tiene ${changedPaths.length} rutas y supera el límite defensivo de ${maxPaths}: no se trunca`,
    );
  }

  // Intersección con los scope_paths declarados: NUNCA se amplía el alcance
  // declarado. Sin declaraciones, el diff completo es el alcance.
  const declared = input.declaredPaths;
  const scopePaths = declared.length === 0
    ? changedPaths
    : changedPaths.filter((path) =>
        declared.some((declaredPath) =>
          path === declaredPath || path.startsWith(`${declaredPath}/`),
        ),
      );
  if (scopePaths.length === 0) {
    throw new SecurityAuditSourceError(
      "git_diff_scope_empty",
      `la intersección del diff ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} con los scope_paths declarados ${JSON.stringify(declared)} no deja rutas reales: el alcance declarado no se amplía`,
    );
  }

  return {
    repoTopLevel,
    baseSha,
    headSha,
    changedPaths,
    scopePaths: [...scopePaths].sort(),
    sourceRef: headSha,
    sourceDirty: false,
    evidence: [
      `git rev-parse base ${JSON.stringify(input.baseRef)} -> ${baseSha}`,
      `git rev-parse head ${JSON.stringify(input.headRef)} -> ${headSha}`,
      `HEAD actual == headRef; worktree limpio (${dirtyEntries.length} entradas dirty)`,
      `git diff --name-only --diff-filter=ACMR -> ${changedPaths.length} ruta(s); alcance definitivo ${scopePaths.length} ruta(s)`,
    ],
  };
}

/** Recorta un detalle de error a una línea acotada para evidencia. */
function bounded(raw: string): string {
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length <= 300 ? clean : `${clean.slice(0, 300)} […truncado]`;
}

/**
 * Inspector de origen inyectable: SOLO para pruebas. En producción siempre
 * se usa `defaultSecurityAuditSourceInspector` (comandos git reales).
 */
export interface SecurityAuditSourceInspector {
  resolveSource(projectPath: string): Promise<SecurityAuditSourceResolution>;
  resolveGitDiffScope(
    input: SecurityAuditGitDiffScopeInput,
  ): Promise<SecurityAuditGitDiffScope>;
}

/** Inspector productivo: resuelve SIEMPRE contra el repositorio real. */
export const defaultSecurityAuditSourceInspector: SecurityAuditSourceInspector = {
  resolveSource: resolveSecurityAuditSource,
  resolveGitDiffScope: resolveSecurityAuditGitDiffScope,
};
