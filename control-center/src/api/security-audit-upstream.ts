/**
 * Única capa adaptadora a los validadores oficiales de la skill
 * `security-audit` (`.opencode/skills/security-audit/`).
 *
 * Este módulo NO reimplementa `report-schema.json` ni la lógica de
 * validación: localiza los validadores dentro del directorio de la skill de
 * la fábrica, aplica el contrato de rutas y los ejecuta con
 * `spawnSync(process.execPath, [validador, fichero], { shell: false })`,
 * entorno vacío, timeout y límite de salida. Las salidas se redactan antes de
 * salir del módulo.
 *
 * Contrato de rutas (rechazado con `SecurityAuditUpstreamPathError`, sin
 * ejecutar nada):
 *
 * 1. `skillDir` por defecto es `<repo>/.opencode/skills/security-audit`,
 *    derivado de la ubicación de este módulo. Si se pasa un `skillDir`
 *    explícito, su ruta canónica (`realpath`) debe ser exactamente la de la
 *    skill de la fábrica: no se acepta ningún validador fuera de ella, ni
 *    componentes symlink en esa ruta.
 * 2. `runDir` (directorio de la corrida) debe ser absoluto, existir, ser un
 *    directorio real y no tener ningún componente symlink.
 * 3. El fichero a validar debe ser un descendiente estricto de `runDir`
 *    (relativa sin `..` ni absoluta hacia fuera), regular según `lstat`, sin
 *    componentes symlink entre `runDir` y el fichero, y no mayor que
 *    `maxInputBytes`. Una ruta fuera del run o un symlink se rechaza.
 *
 * Resultados: `PASS` (exit 0), `FAIL` (exit != 0) u `ERROR` (timeout, fallo
 * de spawn o límite de salida), siempre con `exitCode`/`stdout`/`stderr`
 * redactados y acotados.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./redaction.js";

const requireOfficialCjs = createRequire(import.meta.url);

/** Directorio canónico de la skill de la fábrica (sin trailing separator). */
export const SECURITY_AUDIT_SKILL_DIR = resolve(
  fileURLToPath(new URL("../../../.opencode/skills/security-audit/", import.meta.url)),
);

export const SECURITY_AUDIT_VALIDATORS = {
  findings: "validate-findings.cjs",
  "coverage-ledger": "validate-coverage-ledger.cjs",
} as const;

export type SecurityAuditUpstreamValidator = keyof typeof SECURITY_AUDIT_VALIDATORS;

export const SECURITY_AUDIT_UPSTREAM_DEFAULTS = {
  timeoutMs: 15_000,
  maxOutputBytes: 256 * 1024,
  maxInputBytes: 5 * 1024 * 1024,
} as const;

export interface SecurityAuditUpstreamOptions {
  /** Debe seguir confinado al directorio de la skill de la fábrica. */
  skillDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export type SecurityAuditUpstreamStatus = "PASS" | "FAIL" | "ERROR";

export interface SecurityAuditUpstreamResult {
  validator: SecurityAuditUpstreamValidator;
  status: SecurityAuditUpstreamStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Solo en `ERROR`: `timeout`, `output_limit`, `spawn_failed`. */
  reason: string | null;
}

export class SecurityAuditUpstreamPathError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SecurityAuditUpstreamPathError";
  }
}

function pathError(code: string, message: string): SecurityAuditUpstreamPathError {
  return new SecurityAuditUpstreamPathError(code, message);
}

function lstatOrThrow(path: string, code: string, message: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw pathError(code, message);
  }
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel.length === 0 || isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  return segments[0] !== "..";
}

function assertAbsolutePathIsSymlinkFree(path: string, code: string): void {
  const resolved = resolve(path);
  let current: string = sep;
  for (const part of resolved.split(sep).filter(Boolean)) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch {
      throw pathError(code, `no existe o no es accesible: ${current}`);
    }
    if (stats.isSymbolicLink()) {
      throw pathError(code, `componente symlink no permitido: ${current}`);
    }
  }
}

function resolveValidator(
  validator: SecurityAuditUpstreamValidator,
  options: SecurityAuditUpstreamOptions,
): { skillDir: string; validatorPath: string } {
  const expectedSkillDir = SECURITY_AUDIT_SKILL_DIR;
  let canonicalExpected: string;
  try {
    canonicalExpected = realpathSync(expectedSkillDir);
  } catch {
    throw pathError("skill_dir_missing", `falta la skill de la fábrica: ${expectedSkillDir}`);
  }

  const skillDir = options.skillDir === undefined ? expectedSkillDir : resolve(options.skillDir);
  assertAbsolutePathIsSymlinkFree(skillDir, "skill_dir_symlink");
  let canonicalSkillDir: string;
  try {
    canonicalSkillDir = realpathSync(skillDir);
  } catch {
    throw pathError("skill_dir_missing", `no existe el directorio de skill: ${skillDir}`);
  }
  if (canonicalSkillDir !== canonicalExpected) {
    throw pathError(
      "skill_dir_outside_factory",
      `el directorio de skill queda fuera de la fábrica: ${skillDir}`,
    );
  }

  const validatorPath = join(skillDir, SECURITY_AUDIT_VALIDATORS[validator]);
  const stats = lstatOrThrow(
    validatorPath,
    "validator_missing",
    `falta el validador oficial: ${validatorPath}`,
  );
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pathError("validator_symlink", `el validador no es un fichero regular: ${validatorPath}`);
  }
  if (!isStrictDescendant(canonicalSkillDir, realpathSync(validatorPath))) {
    throw pathError("validator_outside_skill", `validador fuera de la skill: ${validatorPath}`);
  }
  return { skillDir, validatorPath };
}

function resolveInputFile(
  filePath: string,
  runDir: string,
  maxInputBytes: number,
): string {
  if (!isAbsolute(runDir)) {
    throw pathError("run_dir_not_absolute", `runDir debe ser absoluto: ${runDir}`);
  }
  const resolvedRunDir = resolve(runDir);
  assertAbsolutePathIsSymlinkFree(resolvedRunDir, "run_dir_symlink");
  const runStats = lstatOrThrow(resolvedRunDir, "run_dir_missing", `no existe runDir: ${runDir}`);
  if (!runStats.isDirectory()) {
    throw pathError("run_dir_not_directory", `runDir no es un directorio: ${runDir}`);
  }

  const resolvedInput = resolve(filePath);
  if (!isStrictDescendant(resolvedRunDir, resolvedInput)) {
    throw pathError(
      "input_outside_run",
      `el fichero queda fuera del run (${resolvedRunDir}): ${resolvedInput}`,
    );
  }
  // Primero el propio fichero (ausente → input_missing; symlink → input_symlink)
  // y después cada componente intermedio entre runDir y el fichero.
  const stats = lstatOrThrow(
    resolvedInput,
    "input_missing",
    `no existe el fichero a validar: ${resolvedInput}`,
  );
  if (stats.isSymbolicLink()) {
    throw pathError("input_symlink", `fichero symlink no permitido: ${resolvedInput}`);
  }
  const segments = relative(resolvedRunDir, resolvedInput).split(sep);
  let current = resolvedRunDir;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let parentStats: Stats;
    try {
      parentStats = lstatSync(current);
    } catch {
      throw pathError("input_path_unreadable", `no se pudo comprobar ${current}`);
    }
    if (parentStats.isSymbolicLink()) {
      throw pathError("input_symlink", `componente symlink no permitido: ${current}`);
    }
  }
  if (!stats.isFile()) {
    throw pathError("input_not_regular", `no es un fichero regular: ${resolvedInput}`);
  }
  if (stats.size > maxInputBytes) {
    throw pathError(
      "input_too_large",
      `el fichero supera maxInputBytes (${stats.size} > ${maxInputBytes})`,
    );
  }
  return resolvedInput;
}

/**
 * Identificador canónico de cobertura calculado con la función OFICIAL
 * `canonicalCoverageId` de `validate-coverage-ledger.cjs` (no se reimplementa
 * el algoritmo). Se usa para sembrar unidades del ledger deterministas.
 */
export function securityAuditCanonicalCoverageId(refs: {
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
}): string {
  const modulePath = join(SECURITY_AUDIT_SKILL_DIR, SECURITY_AUDIT_VALIDATORS["coverage-ledger"]);
  const official = requireOfficialCjs(modulePath) as {
    canonicalCoverageId?: (value: unknown) => unknown;
  };
  if (typeof official.canonicalCoverageId !== "function") {
    throw pathError(
      "validator_missing",
      "el validador oficial no expone canonicalCoverageId",
    );
  }
  const id = official.canonicalCoverageId(refs);
  if (typeof id !== "string" || id.length === 0) {
    throw pathError("validator_missing", "canonicalCoverageId devolvió un id inválido");
  }
  return id;
}

/**
 * Redacta secretos y acota la salida al límite en bytes. Se exporta para que
 * los tests cubran el paso de redacción sin inventar invocaciones.
 */
export function redactSecurityAuditUpstreamOutput(text: string, maxBytes: number): string {
  const redacted = redactSecrets(text);
  const buffer = Buffer.from(redacted, "utf8");
  if (buffer.length <= maxBytes) return redacted;
  return new TextDecoder("utf-8").decode(buffer.subarray(0, maxBytes));
}

function runUpstreamValidator(
  validator: SecurityAuditUpstreamValidator,
  filePath: string,
  runDir: string,
  options: SecurityAuditUpstreamOptions,
): SecurityAuditUpstreamResult {
  const timeoutMs = options.timeoutMs ?? SECURITY_AUDIT_UPSTREAM_DEFAULTS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? SECURITY_AUDIT_UPSTREAM_DEFAULTS.maxOutputBytes;
  const maxInputBytes = options.maxInputBytes ?? SECURITY_AUDIT_UPSTREAM_DEFAULTS.maxInputBytes;
  for (const [field, value] of [
    ["timeoutMs", timeoutMs],
    ["maxOutputBytes", maxOutputBytes],
    ["maxInputBytes", maxInputBytes],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${field} debe ser un entero >= 1`);
    }
  }

  const { skillDir, validatorPath } = resolveValidator(validator, options);
  const inputPath = resolveInputFile(filePath, runDir, maxInputBytes);

  const execution = spawnSync(process.execPath, [validatorPath, inputPath], {
    cwd: skillDir,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    // Entorno vacío: el validador oficial no necesita variables heredadas.
    env: {},
    shell: false,
    windowsHide: true,
  });

  const stdout = redactSecurityAuditUpstreamOutput(execution.stdout ?? "", maxOutputBytes);
  const stderr = redactSecurityAuditUpstreamOutput(execution.stderr ?? "", maxOutputBytes);
  const base = { validator, exitCode: execution.status, stdout, stderr };

  if (execution.error) {
    const code = (execution.error as NodeJS.ErrnoException).code;
    const reason = code === "ETIMEDOUT"
      ? "timeout"
      : code === "ENOBUFS" || code === "E2BIG"
        ? "output_limit"
        : "spawn_failed";
    return { ...base, status: "ERROR", reason };
  }
  if (execution.status === 0) {
    return { ...base, status: "PASS", reason: null };
  }
  return { ...base, status: "FAIL", reason: null };
}

/** Valida `findings.json` con el validador oficial `validate-findings.cjs`. */
export function validateFindingsFile(
  filePath: string,
  runDir: string,
  options: SecurityAuditUpstreamOptions = {},
): SecurityAuditUpstreamResult {
  return runUpstreamValidator("findings", filePath, runDir, options);
}

/** Valida `coverage-ledger.json` con `validate-coverage-ledger.cjs`. */
export function validateCoverageLedgerFile(
  filePath: string,
  runDir: string,
  options: SecurityAuditUpstreamOptions = {},
): SecurityAuditUpstreamResult {
  return runUpstreamValidator("coverage-ledger", filePath, runDir, options);
}
