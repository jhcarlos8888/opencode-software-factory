/**
 * Único escritor de los archivos compartidos de un run `security-audit`.
 *
 * Contrato:
 * - Raíz por defecto EXACTA: `~/.local/state/opencode-software-factory/security-audits/`.
 *   Con `FACTORY_STATE_DIR` (tests) la raíz es `<FACTORY_STATE_DIR>/security-audits/`.
 *   Es la ÚNICA variable de entorno leída; no se usa ningún valor ambiental
 *   en el contenido de los archivos.
 * - Raíz y directorios de run en `0700`, ficheros en `0600`, id de run único
 *   (un directorio por run; reutilizar un id existente es un error).
 * - El directorio de salida debe quedar fuera del target, fuera de su `.git`
 *   y fuera de las entradas sensibles del home.
 * - `run-metadata.json` se escribe ANTES de invocar agentes y su
 *   `execution_policy` es SIEMPRE `source-only` (F08: la política sandboxed
 *   no tiene ejecución implementada y se rechaza aunque la autorización
 *   sandbox parezca válida). Ninguna aprobación relaja esta regla.
 * - Escrituras atómicas propias (temp `wx` + `rename`), sin seguir symlinks.
 * - El ledger se valida con el validador oficial tras el seed y tras TODA
 *   actualización; `findings.json` tras cada escritura/reemplazo. Si el
 *   validador no devuelve PASS, la escritura se aborta y no se publica.
 * - `declareSecurityAuditComplete` exige los 7 artefactos, ambos validadores
 *   en PASS, las 6 fases completas y cero candidatos sin validar.
 * - El modo incompleto conserva motivo y huecos y exige el marcador
 *   `ESTADO: INCOMPLETO` en el informe parcial.
 * - Todo el contenido propio pasa por `redactSecrets` antes de escribirse.
 */

import { randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  validateCoverageLedgerFile,
  validateFindingsFile,
  type SecurityAuditUpstreamResult,
} from "./security-audit-upstream.js";
import type { SecurityAuditIncompleteReason } from "./security-audit-contracts.js";
import {
  buildSecurityAuditReports,
  type SecurityAuditReportCoverage,
  type SecurityAuditReportFinding,
} from "./security-audit-reports.js";
import {
  isOutputOutsideSensitiveHome,
  isOutputOutsideTarget,
} from "./security-audit-sandbox.js";
import { redactSecrets } from "./redaction.js";

export const SECURITY_AUDIT_STATE_ENV = "FACTORY_STATE_DIR";

/** Artefactos compartidos oficiales del run (siete en total). */
export const SECURITY_AUDIT_SHARED_ARTIFACTS = [
  "run-metadata.json",
  "architecture.md",
  "coverage-ledger.json",
  "findings.json",
  "REPORT.md",
  "FINDINGS-DETAIL.md",
  "NEEDS-VALIDATION.md",
] as const;

export type SecurityAuditSharedArtifact = (typeof SECURITY_AUDIT_SHARED_ARTIFACTS)[number];

export const SECURITY_AUDIT_INCOMPLETE_MARKER = "ESTADO: INCOMPLETO";

/** Identificador de run/agente según la regex canónica upstream. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export interface SecurityAuditRunLayout {
  runId: string;
  root: string;
  runDir: string;
  paths: Record<SecurityAuditSharedArtifact, string>;
  agentsRoot: string;
}

function safeId(value: string, what: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || WINDOWS_DEVICE_NAMES.has(value)) {
    throw new Error(`${what} inválido: ${JSON.stringify(value)}`);
  }
  return value;
}

function ensurePrivateDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} debe ser un directorio real, no un enlace simbólico: ${path}`);
  }
  chmodSync(path, 0o700);
}

/**
 * Raíz de los runs de auditoría. Respetando `FACTORY_STATE_DIR`; sin ella se
 * usa la ruta por defecto exacta bajo el home.
 */
export function securityAuditsRoot(): string {
  const base = process.env[SECURITY_AUDIT_STATE_ENV]
    ? resolve(process.env[SECURITY_AUDIT_STATE_ENV] as string)
    : join(homedir(), ".local", "state", "opencode-software-factory");
  return join(base, "security-audits");
}

function layoutFor(runId: string, runDir: string): SecurityAuditRunLayout {
  const paths = {} as Record<SecurityAuditSharedArtifact, string>;
  for (const name of SECURITY_AUDIT_SHARED_ARTIFACTS) {
    paths[name] = join(runDir, name);
  }
  return { runId, root: securityAuditsRoot(), runDir, paths, agentsRoot: join(runDir, "agents") };
}

/**
 * Crea el directorio único del run bajo la raíz privada. Falla si el id ya
 * existiera (un run nunca reutiliza su directorio).
 */
export function createSecurityAuditRunDirectory(runId: string, targetPath?: string): SecurityAuditRunLayout {
  safeId(runId, "runId");
  const root = securityAuditsRoot();
  const runDir = join(root, runId);
  assertNoOutputSymlinkAncestors(runDir);
  // La comprobación debe preceder a mkdir/chmod, incluso si la raíz no existe.
  if (targetPath !== undefined) assertSecurityAuditOutputOutsideTarget(layoutFor(runId, runDir), targetPath);
  ensurePrivateDirectory(root, "La raíz de auditorías de seguridad");
  if (lstatSyncExists(runDir)) {
    throw new Error(`El directorio del run ya existe y no se reutiliza: ${runDir}`);
  }
  mkdirSync(runDir, { mode: 0o700 });
  const info = lstatSync(runDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`El directorio del run debe ser real: ${runDir}`);
  }
  chmodSync(runDir, 0o700);
  if (!runDir.startsWith(root + sep)) {
    throw new Error(`El directorio del run queda fuera de la raíz: ${runDir}`);
  }
  ensurePrivateDirectory(join(runDir, "agents"), "El directorio de agentes");
  return layoutFor(runId, runDir);
}

/** Recupera un layout existente verificando privacidad y ausencia de symlinks. */
export function resolveSecurityAuditRunDirectory(runId: string, targetPath?: string): SecurityAuditRunLayout {
  safeId(runId, "runId");
  const root = securityAuditsRoot();
  const runDir = join(root, runId);
  assertNoOutputSymlinkAncestors(runDir);
  if (targetPath !== undefined) assertSecurityAuditOutputOutsideTarget(layoutFor(runId, runDir), targetPath);
  const info = lstatSync(runDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`El directorio del run debe ser un directorio real: ${runDir}`);
  }
  if ((lstatSync(root).mode & 0o777) !== 0o700 || (info.mode & 0o777) !== 0o700) {
    throw new Error(`La raíz de auditorías debe tener permisos 0700: ${root}`);
  }
  return layoutFor(runId, runDir);
}

function lstatSyncExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Rechaza componentes enlazados, incluidos los ancestros de una raíz aún inexistente. */
function assertNoOutputSymlinkAncestors(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Ancestro de salida no es un directorio real: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
}

/**
 * El output de un run nunca puede vivir dentro del target, de su `.git` ni de
 * entradas sensibles del home.
 */
export function assertSecurityAuditOutputOutsideTarget(
  layout: SecurityAuditRunLayout,
  targetPath: string,
): void {
  if (!isAbsolute(targetPath)) {
    throw new Error(`La ruta del target debe ser absoluta: ${targetPath}`);
  }
  assertNoOutputSymlinkAncestors(layout.runDir);
  // Canonicalizar el target evita que un alias symlink eluda el límite.
  const missingParts: string[] = [];
  let ancestor = resolve(targetPath);
  while (!lstatSyncExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No se pudo resolver el target");
    missingParts.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
  }
  const canonicalTarget = resolve(realpathSync(ancestor), ...missingParts);
  if (!isOutputOutsideTarget(layout.runDir, canonicalTarget) || !isOutputOutsideTarget(layout.runDir, targetPath)) {
    throw new Error(`El directorio de salida no puede vivir dentro del target: ${layout.runDir}`);
  }
  if (!isOutputOutsideSensitiveHome(layout.runDir)) {
    throw new Error(`El directorio de salida no puede vivir en el home sensible: ${layout.runDir}`);
  }
}

/** Escritura atómica propia: temp `wx` 0600 + `rename`, sin seguir symlinks. */
function writeArtifactAtomic(path: string, content: string): void {
  const directory = resolve(path, "..");
  assertNoOutputSymlinkAncestors(directory);
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  const bytes = redactSecrets(content);
  writeFileSync(tempPath, bytes, { mode: 0o600, flag: "wx" });
  try {
    if (lstatSyncExists(path)) {
      const target = lstatSync(path);
      if (target.isSymbolicLink()) {
        throw new Error(`No se publica sobre un symlink: ${path}`);
      }
      if (!target.isFile()) {
        throw new Error(`El artefacto destino no es un fichero regular: ${path}`);
      }
    }
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* el temporal puede no existir */
    }
    throw error;
  }
}

function assertSharedArtifact(name: string): asserts name is SecurityAuditSharedArtifact {
  if (!(SECURITY_AUDIT_SHARED_ARTIFACTS as readonly string[]).includes(name)) {
    throw new Error(`Artefacto compartido no permitido: ${name}`);
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function writeValidatedJson(
  layout: SecurityAuditRunLayout,
  name: "coverage-ledger.json" | "findings.json",
  value: unknown,
  validate: (path: string, runDir: string) => SecurityAuditUpstreamResult,
): SecurityAuditUpstreamResult {
  assertSharedArtifact(name);
  assertNoOutputSymlinkAncestors(layout.runDir);
  const finalPath = layout.paths[name];
  const content = redactSecrets(serialize(value));
  const tempPath = join(layout.runDir, `.${name}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, content, { mode: 0o600, flag: "wx" });
  let result: SecurityAuditUpstreamResult;
  try {
    result = validate(tempPath, layout.runDir);
    if (result.status !== "PASS") {
      throw new Error(
        `El validador oficial rechazó ${name}: ${result.status} — ` +
          `${(result.stderr || result.stdout).slice(0, 500)}`,
      );
    }
    if (lstatSyncExists(finalPath)) {
      const target = lstatSync(finalPath);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error(`El destino de ${name} no es un fichero regular: ${finalPath}`);
      }
    }
    renameSync(tempPath, finalPath);
    chmodSync(finalPath, 0o600);
    return result;
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* sin temporal que limpiar */
    }
    throw error;
  }
}

export interface SecurityAuditSandboxAuthorization {
  available: boolean;
  isolationClaim: "none" | "partial";
  blockers: readonly string[];
  networkTarget: "denied" | "allowed";
}

/**
 * Autorización sandbox válida: controles base cumplidos, aislamiento parcial
 * declarado (nunca total), solo bloqueadores de degradación y red del target
 * denegada. Ninguna aprobación o rol puede relajar estos criterios.
 */
export function isSandboxAuthorizationValid(
  authorization: SecurityAuditSandboxAuthorization | null | undefined,
): boolean {
  if (!authorization) return false;
  if (!authorization.available) return false;
  if (authorization.isolationClaim !== "partial") return false;
  if (authorization.networkTarget !== "denied") return false;
  const degradationBlockers = new Set([
    "disk_limit_unavailable",
    "promotion_dirfd_unavailable",
  ]);
  return authorization.blockers.every((blocker) => degradationBlockers.has(blocker));
}

export interface SecurityAuditRunMetadata {
  runId: string;
  repo: string;
  target: string;
  sourceRef: string | null;
  sourceDirty: boolean;
  profile: "quick" | "standard" | "deep";
  scope: unknown;
  budget: unknown;
  executionPolicy: "source-only" | "sandboxed-source-and-local-only";
  sandboxAuthorization?: SecurityAuditSandboxAuthorization | null;
  selectedCompanions: readonly string[];
  priorRunPaths: readonly string[];
  /**
   * Paquete 7: instrucción del operador del run (dato NO confiable; nunca
   * amplía permisos, presupuesto ni alcance). Vacía si no se registró.
   */
  instructions?: string;
  createdAt: string;
}

/**
 * `run-metadata.json` se escribe antes de invocar agentes. SOLO acepta
 * `source-only`: la política `sandboxed-source-and-local-only` se rechaza
 * SIEMPRE (F08: no tiene ejecución implementada y ninguna autorización
 * sandbox —ni aparentemente válida— la habilita). No hay fallback silencioso.
 */
export function writeSecurityAuditRunMetadata(
  layout: SecurityAuditRunLayout,
  metadata: SecurityAuditRunMetadata,
): void {
  assertSharedArtifact("run-metadata.json");
  if (metadata.executionPolicy === "sandboxed-source-and-local-only") {
    throw new Error(
      "sandbox_not_implemented: la política sandboxed-source-and-local-only no tiene ejecución " +
        "implementada; run-metadata.json solo publica source-only (ninguna autorización sandbox la habilita).",
    );
  }
  if (metadata.executionPolicy !== "source-only") {
    throw new Error(`execution_policy desconocida: ${String(metadata.executionPolicy)}`);
  }
  const { executionPolicy, sandboxAuthorization: _authorization, instructions, ...rest } = metadata;
  writeArtifactAtomic(layout.paths["run-metadata.json"], serialize({
    // Paquete 7: instrucción efectiva del operador (texto; vacía si no llegó
    // ninguna). Es un campo propio del run y no toca findings ni ledger.
    instructions: typeof instructions === "string" ? instructions : "",
    ...rest,
    execution_policy: executionPolicy,
  }));
}

export function writeSecurityAuditArchitecture(
  layout: SecurityAuditRunLayout,
  content: string,
): void {
  assertSharedArtifact("architecture.md");
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("architecture.md no puede estar vacío");
  }
  writeArtifactAtomic(layout.paths["architecture.md"], content);
}

/** Seed inicial del ledger: escribe y exige PASS del validador oficial. */
export function seedSecurityAuditCoverageLedger(
  layout: SecurityAuditRunLayout,
  ledger: unknown,
): SecurityAuditUpstreamResult {
  return writeValidatedJson(layout, "coverage-ledger.json", ledger, validateCoverageLedgerFile);
}

/** Toda actualización del ledger vuelve a exigir PASS antes de publicarse. */
export function updateSecurityAuditCoverageLedger(
  layout: SecurityAuditRunLayout,
  ledger: unknown,
): SecurityAuditUpstreamResult {
  return writeValidatedJson(layout, "coverage-ledger.json", ledger, validateCoverageLedgerFile);
}

/** Escritura/reemplazo de `findings.json` exige PASS del validador oficial. */
export function writeSecurityAuditFindings(
  layout: SecurityAuditRunLayout,
  findings: unknown,
): SecurityAuditUpstreamResult {
  return writeValidatedJson(layout, "findings.json", findings, validateFindingsFile);
}

export interface SecurityAuditPhaseSixReports {
  report: string;
  detail: string;
  needsValidation: string;
}

/**
 * Fase 6: publica los tres informes. En modo incompleto el `REPORT.md` debe
 * llevar el marcador oficial de parcialidad; si no, se aborta. La lista
 * `incompleteReasons` (Paquete 6) acompaña al motivo primario; los artefactos
 * la conservan para el desglose honesto de motivos.
 */
export function writeSecurityAuditPhaseSixReports(
  layout: SecurityAuditRunLayout,
  reports: SecurityAuditPhaseSixReports,
  options: {
    incomplete: boolean;
    incompleteReason?: string | null;
    incompleteReasons?: readonly string[];
  } = { incomplete: false },
): void {
  for (const name of ["REPORT.md", "FINDINGS-DETAIL.md", "NEEDS-VALIDATION.md"] as const) {
    assertSharedArtifact(name);
  }
  if (options.incomplete && !reports.report.includes(SECURITY_AUDIT_INCOMPLETE_MARKER)) {
    throw new Error(
      `El informe parcial debe llevar el marcador ${SECURITY_AUDIT_INCOMPLETE_MARKER}`,
    );
  }
  writeArtifactAtomic(layout.paths["REPORT.md"], reports.report);
  writeArtifactAtomic(layout.paths["FINDINGS-DETAIL.md"], reports.detail);
  writeArtifactAtomic(layout.paths["NEEDS-VALIDATION.md"], reports.needsValidation);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SecurityAuditMetadataStatusUpdate {
  runStatus: "complete" | "incomplete";
  /** Motivo oficial primario del cierre incomplete. */
  incompleteReason?: string | null;
  /**
   * Paquete 6: TODOS los motivos oficiales del cierre (primario incluido),
   * persistidos en `run-metadata.json` como `incomplete_reasons`.
   */
  incompleteReasons?: readonly string[];
}

/**
 * Actualiza `run-metadata.json` con el estado terminal del run sin tocar nada
 * más. Nunca rebaja un run `complete` (intentarlo es un error) y conserva la
 * `execution_policy` real: el modo source-only no cambia en el cierre.
 */
export function updateSecurityAuditRunMetadataStatus(
  layout: SecurityAuditRunLayout,
  update: SecurityAuditMetadataStatusUpdate,
): void {
  assertSharedArtifact("run-metadata.json");
  if (update.runStatus === "incomplete" && !update.incompleteReason) {
    throw new Error("un cierre incomplete exige incomplete_reason");
  }
  let existing: Record<string, unknown> = {};
  if (lstatSyncExists(layout.paths["run-metadata.json"])) {
    const parsed: unknown = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
    if (!isPlainObject(parsed)) throw new Error("run-metadata.json corrupto: " + layout.runId);
    existing = parsed;
    if (existing.run_status === "complete" && update.runStatus !== "complete") {
      throw new Error("nunca se sobrescribe un run complete: " + layout.runId);
    }
  }
  const next: Record<string, unknown> = {
    ...existing,
    run_status: update.runStatus,
    incomplete_reason: update.runStatus === "incomplete" ? update.incompleteReason! : null,
  };
  if (update.runStatus === "incomplete") {
    next.incomplete_at = new Date().toISOString();
    // Paquete 6: la lista completa de motivos (primario incluido), deduplicada
    // conservando el orden dado (el primario primero).
    const reasons = [...new Set(update.incompleteReasons ?? [])]
      .filter((reason) => typeof reason === "string" && reason.length > 0);
    if (reasons.length > 0) next.incomplete_reasons = reasons;
    else delete next.incomplete_reasons;
  } else {
    delete next.incomplete_at;
    delete next.incomplete_reasons;
  }
  writeArtifactAtomic(layout.paths["run-metadata.json"], serialize(next));
}

function boundedErrorLine(error: string | null | undefined): string {
  if (typeof error !== "string" || error.trim().length === 0) {
    return "sin error registrado";
  }
  const clean = error.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length <= 500 ? clean : clean.slice(0, 500) + " […truncado]";
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "ninguno";
}

export interface SecurityAuditIncompleteArtifactsInput {
  /** Motivo oficial primario de `run_status: "incomplete"`. */
  reason: SecurityAuditIncompleteReason;
  /**
   * Paquete 6: TODOS los motivos oficiales del cierre (opcional, retro-
   * compatible). Sin ella, la lista se reduce al motivo primario.
   */
  incompleteReasons?: readonly string[];
  /** Error acotado y redactado (se recorta a 500 caracteres). */
  error?: string | null;
  profile: "quick" | "standard" | "deep";
  scopeKind: "project" | "directory" | "component" | "domain" | "git-diff";
  scopePaths?: readonly string[];
  domains?: readonly string[];
  sourceRef?: string | null;
  sourceDirty?: boolean;
  executionPolicy: string;
  budget?: { maxInvocations: number | null; spent: number } | null;
  phasesComplete?: readonly number[];
  pendingUnits?: readonly string[];
  unvalidatedFingerprints?: readonly string[];
  deferredUnits?: readonly string[];
  findings?: readonly SecurityAuditReportFinding[];
  coverage?: Partial<SecurityAuditReportCoverage>;
}

/**
 * Cierre terminal parcial (artefactos para un run `incomplete`):
 *
 * - Actualiza `run-metadata.json` con `run_status`/`incomplete_reason`.
 * - Genera o REEMPLAZA `REPORT.md`, `FINDINGS-DETAIL.md` y
 *   `NEEDS-VALIDATION.md` como informes parciales con el marcador oficial
 *   `ESTADO: INCOMPLETO`, el motivo, el error acotado/redactado y las
 *   fases/units/fingerprints pendientes.
 * - NO exige validadores en PASS (un cierre parcial no valida) y JAMÁS
 *   sobrescribe un run `complete` ni declara cobertura: los contadores que
 *   aparecen son evidencia acumulada, nunca una declaración de cobertura.
 */
export function writeSecurityAuditIncompleteArtifacts(
  layout: SecurityAuditRunLayout,
  input: SecurityAuditIncompleteArtifactsInput,
): void {
  updateSecurityAuditRunMetadataStatus(layout, {
    runStatus: "incomplete",
    incompleteReason: input.reason,
    incompleteReasons: input.incompleteReasons,
  });
  const coverage: SecurityAuditReportCoverage = {
    unitsTotal: 0,
    unitsCovered: 0,
    unitsCandidate: 0,
    unitsBlocked: 0,
    unitsDeferred: 0,
    unitsOutOfScope: 0,
    ...(input.coverage ?? {}),
  };
  const phasesComplete = [...(input.phasesComplete ?? [])].sort((a, b) => a - b);
  const pendingPhases = [1, 2, 3, 4, 5, 6].filter((phase) => !phasesComplete.includes(phase));
  const pendingUnits = [...new Set(input.pendingUnits ?? [])].sort();
  const unvalidated = [...new Set(input.unvalidatedFingerprints ?? [])].sort();
  const deferred = [...new Set(input.deferredUnits ?? [])].sort();
  // Paquete 6: motivo primario primero; el resto de motivos se listan además
  // en el cierre (nunca se pierde un motivo oficial registrado).
  const reasonList = [...new Set([input.reason, ...(input.incompleteReasons ?? [])])]
    .filter((reason): reason is SecurityAuditIncompleteReason =>
      typeof reason === "string" && reason.length > 0);
  const additionalReasons = reasonList.filter((reason) => reason !== input.reason);
  const bundle = buildSecurityAuditReports({
    runId: layout.runId,
    profile: input.profile,
    scopeKind: input.scopeKind,
    scopePaths: input.scopePaths ?? [],
    domains: input.domains ?? [],
    runStatus: "incomplete",
    incompleteReason: input.reason,
    incompleteReasons: reasonList,
    sourceRef: input.sourceRef ?? null,
    sourceDirty: input.sourceDirty ?? false,
    executionPolicy: input.executionPolicy,
    budget: input.budget ?? null,
    findings: input.findings ?? [],
    coverage,
    pendingFingerprints: unvalidated,
    deferredUnits: deferred,
    hardeningNotes: [],
  });
  const closure: string[] = [
    "",
    "## Cierre terminal (run parcial)",
    "",
    `- Motivo oficial principal: \`${input.reason}\`.`,
    ...(additionalReasons.length > 0
      ? [`- Motivos oficiales adicionales: ${additionalReasons.map((reason) => `\`${reason}\``).join(", ")}.`]
      : []),
    `- Fases completadas: ${listOrNone(phasesComplete.map(String))}.`,
    `- Fases pendientes: ${listOrNone(pendingPhases.map(String))}.`,
    `- Unidades pendientes de cobertura: ${listOrNone(pendingUnits)}.`,
    `- Unidades diferidas: ${listOrNone(deferred)}.`,
    `- Fingerprints sin validar: ${listOrNone(unvalidated)}.`,
    "- Cobertura: NO declarada en un cierre parcial; los contadores de arriba son evidencia acumulada, nunca una declaración de cobertura.",
    `- Error acotado: ${boundedErrorLine(input.error)}`,
    "- Reanudar el run conserva artefactos y resultados; las sesiones nuevas se crean desde cero.",
    "",
  ];
  writeSecurityAuditPhaseSixReports(
    layout,
    {
      report: bundle.report + closure.join("\n"),
      detail: bundle.detail,
      needsValidation: bundle.needsValidation,
    },
    { incomplete: true, incompleteReason: input.reason, incompleteReasons: reasonList },
  );
}

export interface SecurityAuditAgentWorkspace {
  agentId: string;
  agentDir: string;
  scratchDir: string;
  artifactsDir: string;
}

/**
 * Crea el espacio propio del agente. Devuelve SOLO rutas del agente: los
 * artefactos compartidos jamás quedan dentro del scratch/artifacts de un
 * agente, y el agente nunca recibe permiso de escritura compartida.
 */
export function createSecurityAuditAgentWorkspace(
  layout: SecurityAuditRunLayout,
  agentId: string,
): SecurityAuditAgentWorkspace {
  safeId(agentId, "agentId");
  const agentDir = join(layout.agentsRoot, agentId);
  assertNoOutputSymlinkAncestors(agentDir);
  if (lstatSyncExists(agentDir)) {
    throw new Error(`El espacio del agente ya existe: ${agentDir}`);
  }
  mkdirSync(agentDir, { mode: 0o700 });
  const scratchDir = join(agentDir, "scratch");
  const artifactsDir = join(agentDir, "artifacts");
  mkdirSync(scratchDir, { mode: 0o700 });
  mkdirSync(artifactsDir, { mode: 0o700 });
  for (const dir of [agentDir, scratchDir, artifactsDir]) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Directorio de agente inválido: ${dir}`);
    }
    chmodSync(dir, 0o700);
  }
  return { agentId, agentDir, scratchDir, artifactsDir };
}

export interface SecurityAuditCompletionInput {
  /** Fases 1..6 completadas. */
  phasesComplete: readonly number[];
  ledgerValidator: "pass" | "fail" | "pending";
  findingsValidator: "pass" | "fail" | "pending";
  /** Candidatos aún sin validación independiente. */
  unvalidatedCandidates: readonly string[];
  /** Unidades planificadas/candidatas que quedaron sin cerrar. */
  pendingUnits?: readonly string[];
}

export interface SecurityAuditCompletionEvaluation {
  complete: boolean;
  missing: readonly string[];
}

/** Evalúa las cuatro condiciones de `run_status: "complete"`. */
export function evaluateSecurityAuditCompletion(
  layout: SecurityAuditRunLayout,
  input: SecurityAuditCompletionInput,
): SecurityAuditCompletionEvaluation {
  const missing: string[] = [];
  for (const name of SECURITY_AUDIT_SHARED_ARTIFACTS) {
    try {
      assertNoOutputSymlinkAncestors(layout.runDir);
      const info = lstatSync(layout.paths[name]);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0) missing.push(`artifact:${name}`);
    } catch {
      missing.push(`artifact:${name}`);
    }
  }
  for (let phase = 1; phase <= 6; phase += 1) {
    if (!input.phasesComplete.includes(phase)) missing.push(`phase:${phase}`);
  }
  if (input.ledgerValidator !== "pass") missing.push("validator:coverage-ledger");
  if (input.findingsValidator !== "pass") missing.push("validator:findings");
  for (const fingerprint of input.unvalidatedCandidates) {
    missing.push(`unvalidated:${fingerprint}`);
  }
  for (const unitId of input.pendingUnits ?? []) {
    missing.push(`pending-unit:${unitId}`);
  }
  return { complete: missing.length === 0, missing };
}

/** Solo publica el estado `complete` cuando las cuatro condiciones se cumplen. */
export function declareSecurityAuditComplete(
  layout: SecurityAuditRunLayout,
  input: SecurityAuditCompletionInput,
): SecurityAuditCompletionEvaluation {
  const evaluation = evaluateSecurityAuditCompletion(layout, input);
  if (!evaluation.complete) {
    throw new Error(
      "No se puede declarar complete; faltan: " + evaluation.missing.join(", "),
    );
  }
  return evaluation;
}

/** Comprueba que un artefacto compartido existe, es regular y pesa > 0. */
export function readSecurityAuditArtifact(
  layout: SecurityAuditRunLayout,
  name: SecurityAuditSharedArtifact,
): string {
  assertSharedArtifact(name);
  assertNoOutputSymlinkAncestors(layout.runDir);
  const info = lstatSync(layout.paths[name]);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error(`Artefacto inválido: ${layout.paths[name]}`);
  }
  return readFileSync(layout.paths[name], "utf8");
}

/** Guardar solo huellas de contenido, nunca los bytes de los ficheros. */
export function writeSecurityAuditSourceSnapshot(layout: SecurityAuditRunLayout, snapshot: import("./security-audit-scope.js").SecurityAuditSourceSnapshot): void {
  const metadata: unknown = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
  if (!isPlainObject(metadata) || metadata.run_status === "complete") throw new Error("Metadata no modificable para captura de origen");
  writeArtifactAtomic(layout.paths["run-metadata.json"], serialize({ ...metadata, sourceSnapshot: snapshot }));
}

export function readSecurityAuditSourceSnapshot(layout: SecurityAuditRunLayout): import("./security-audit-scope.js").SecurityAuditSourceSnapshot | null {
  const metadata: unknown = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
  if (!isPlainObject(metadata) || !isPlainObject(metadata.sourceSnapshot)) return null;
  const snapshot = metadata.sourceSnapshot;
  if (typeof snapshot.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.sha256) || !Array.isArray(snapshot.files)) return null;
  const files = snapshot.files;
  if (!files.every((entry) => isPlainObject(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256))) return null;
  if (createHash("sha256").update(JSON.stringify(files)).digest("hex") !== snapshot.sha256) return null;
  return snapshot as unknown as import("./security-audit-scope.js").SecurityAuditSourceSnapshot;
}
