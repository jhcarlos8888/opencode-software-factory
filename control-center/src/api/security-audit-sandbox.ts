/**
 * Política de ejecución y sandbox de un run `security-audit`.
 *
 * Política por defecto: `source-only` (solo lectura de fuente, sin ejecución
 * de código del target). La ejecución local aislada solo se propone cuando
 * Bubblewrap pasa una sonda real y TODOS los controles exigidos se cumplen.
 *
 * Alcance honesto de este módulo:
 * - La sonda solo ejecuta `bwrap --version` y `/bin/true` aislado: nunca toca
 *   el target, nunca recibe su ruta y nunca usa variables de entorno
 *   ambientales (`env: {}`).
 * - La red de los proveedores IA pertenece a la orquestación y queda FUERA de
 *   la sandbox (`SECURITY_AUDIT_NETWORK_POLICY.aiProvider`); la red del
 *   target se denega dentro de la sandbox (`target: "denied"`, `--unshare-net`).
 * - No se usan Podman/Docker: no añaden garantía sobre estos controles.
 * - No se afirma aislamiento total: el uso total de disco no puede garantizarse
 *   con Bubblewrap (bloqueador exacto `disk_limit_unavailable`) y Node no
 *   ofrece promoción por dirfd `openat` sin carrera (bloqueador exacto
 *   `promotion_dirfd_unavailable`). Ambos desactivan la promoción dinámica.
 * - Ninguna aprobación ni rol de Auditor pueden relajar estos chequeos: las
 *   funciones solo devuelven `ok:false`/`promotion_blocked`, nunca un atajo.
 *
 * No se usa ninguna dependencia externa: solo `node:child_process`,
 * `node:fs`, `node:path` y `node:os`.
 */

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export type SecurityAuditExecutionPolicy =
  | "source-only"
  | "sandboxed-source-and-local-only";

/** Política por defecto: solo lectura de fuente. */
export const SECURITY_AUDIT_DEFAULT_POLICY: SecurityAuditExecutionPolicy = "source-only";

/**
 * Red: la red de proveedores IA es de la orquestación (fuera de la sandbox);
 * la red del target se denega dentro de la sandbox.
 */
export const SECURITY_AUDIT_NETWORK_POLICY = {
  aiProvider: "outside-sandbox-allowed",
  target: "denied",
} as const;

export interface SecurityAuditSandboxProbe {
  binary: string | null;
  version: string | null;
  functional: boolean;
  isolatedTrue: boolean;
  blockers: readonly string[];
}

export interface SecurityAuditSandboxControls {
  bwrapFunctional: boolean;
  externalNetworkDenied: boolean;
  emptyEnvironmentAllowlist: boolean;
  scratchHomeTmpCaches: boolean;
  readOnlyTargetToolchain: boolean;
  noHomeCredentialsSockets: boolean;
  uniqueScratch: boolean;
  cpuLimit: boolean;
  memoryLimit: boolean;
  nprocLimit: boolean;
  fsizeLimit: boolean;
  wallClockLimit: boolean;
  /** No garantizable con Bubblewrap: bloqueador `disk_limit_unavailable`. */
  diskTotalLimit: boolean;
  /** Node no expone `openat` por dirfd: bloqueador `promotion_dirfd_unavailable`. */
  dirfdPromotion: boolean;
}

export interface SecurityAuditSandboxEvaluation {
  policy: SecurityAuditExecutionPolicy;
  /** Controles base exigidos para proponer ejecución local aislada. */
  available: boolean;
  blockers: readonly string[];
  controls: SecurityAuditSandboxControls;
  /** Nunca `"total"`: los bloqueadores degradan a `"partial"`. */
  isolationClaim: "none" | "partial";
  dynamicPromotion: "disabled" | "enabled";
  network: typeof SECURITY_AUDIT_NETWORK_POLICY;
}

export interface SecurityAuditSandboxLimits {
  cpuSeconds: number;
  memoryBytes: number;
  nproc: number;
  fileBytes: number;
  wallMs: number;
  /** Reservado; no se puede garantizar → siempre bloqueador `disk_limit_unavailable`. */
  diskBytes?: number;
}

export interface SecurityAuditSandboxCommand {
  /** Comando a ejecutar dentro de la sandbox (sin shell interpolado). */
  target: readonly string[];
  /** Raíz del target, enlazada de solo lectura. */
  targetPath: string;
  /** Toolchain (compiladores, runtimes) enlazada de solo lectura. */
  toolchainPaths?: readonly string[];
  /** Scratch único y escribible; debe quedar fuera del target. */
  scratchDir: string;
  limits: SecurityAuditSandboxLimits;
  /** Allowlist explícita de variables; se bloquean claves con apariencia de secreto. */
  allowEnv?: Readonly<Record<string, string>>;
}

export interface SecurityAuditSandboxArgv {
  ok: boolean;
  argv: readonly string[];
  blockers: readonly string[];
  controls: SecurityAuditSandboxControls;
  isolationClaim: "none" | "partial";
  dynamicPromotion: "disabled" | "enabled";
  network: typeof SECURITY_AUDIT_NETWORK_POLICY;
  /** Límite de reloj aplicado por el llamador con `spawnSync({ timeout })`. */
  wallClockLimitMs: number | null;
}

export const SECURITY_AUDIT_BLOCKERS = {
  bubblewrapUnavailable: "bubblewrap_unavailable",
  externalNetworkNotDenied: "external_network_not_denied",
  environmentNotAllowlisted: "environment_not_allowlisted",
  scratchLayoutUnavailable: "scratch_layout_unavailable",
  targetNotReadOnly: "target_not_read_only",
  homeExposed: "home_exposed",
  scratchNotUnique: "scratch_not_unique",
  cpuLimitUnavailable: "cpu_limit_unavailable",
  memoryLimitUnavailable: "memory_limit_unavailable",
  nprocLimitUnavailable: "nproc_limit_unavailable",
  fsizeLimitUnavailable: "fsize_limit_unavailable",
  wallClockLimitUnavailable: "wall_clock_limit_unavailable",
  diskLimitUnavailable: "disk_limit_unavailable",
  promotionDirfdUnavailable: "promotion_dirfd_unavailable",
  commandInvalid: "command_invalid",
} as const;

/** Candidatos absolutos: sin PATH ambiental. */
const BWRAP_CANDIDATES = [
  "/usr/bin/bwrap",
  "/usr/local/bin/bwrap",
  "/bin/bwrap",
  "/usr/sbin/bwrap",
] as const;

const PROBE_TIMEOUT_MS = 5000;
const ENV_ALLOWLIST_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SECRETISH_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH)/i;
const HOST_RO_BINDS = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc"] as const;
const SENSITIVE_HOME_ENTRIES = [".ssh", ".aws", ".gnupg", ".kube", ".config/opencode"] as const;

function findExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function isUnder(parent: string, child: string): boolean {
  const rel = resolve(child).startsWith(resolve(parent) + sep);
  return rel;
}

/**
 * Sonda real de Bubblewrap sin tocar el target: `--version` y un `/bin/true`
 * aislado con red e IDs nuevos. Solo enlaza directorios de sistema existentes
 * (nunca `/home`, `/root` ni `/run`) y cualquier fallo deja
 * `functional:false` (fail-closed).
 */
export function probeBubblewrap(): SecurityAuditSandboxProbe {
  const binary = findExecutable(BWRAP_CANDIDATES);
  if (!binary) {
    return {
      binary: null,
      version: null,
      functional: false,
      isolatedTrue: false,
      blockers: [SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable],
    };
  }

  const versionRun = spawnSync(binary, ["--version"], {
    env: {},
    timeout: PROBE_TIMEOUT_MS,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const version = versionRun.status === 0
    ? (versionRun.stdout ?? "").trim().split("\n")[0] ?? null
    : null;

  const probeArgv: string[] = [binary, "--unshare-all", "--new-session", "--die-with-parent"];
  for (const bind of HOST_RO_BINDS.filter((path) => existsSync(path))) {
    probeArgv.push("--ro-bind", bind, bind);
  }
  probeArgv.push("--proc", "/proc", "--dev", "/dev", "--", "/bin/true");
  const isolatedRun = spawnSync(probeArgv[0] as string, probeArgv.slice(1), {
    env: {},
    cwd: "/",
    timeout: PROBE_TIMEOUT_MS,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const isolatedTrue = !isolatedRun.error && isolatedRun.status === 0;
  const functional = version !== null && isolatedTrue;

  return {
    binary,
    version,
    functional,
    isolatedTrue,
    blockers: functional ? [] : [SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable],
  };
}

/**
 * Node no ofrece `openat`/dirfd sin carrera en `node:fs`: la promoción de
 * archivos queda bloqueada (fail-closed, sin copia).
 */
export function supportsDirfdPromotion(): boolean {
  const candidate = (nodeFs as unknown as Record<string, unknown>).openat;
  return typeof candidate === "function";
}

function positiveLimits(limits: SecurityAuditSandboxLimits | undefined): {
  ok: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (!limits) {
    return {
      ok: false,
      blockers: [
        SECURITY_AUDIT_BLOCKERS.cpuLimitUnavailable,
        SECURITY_AUDIT_BLOCKERS.memoryLimitUnavailable,
        SECURITY_AUDIT_BLOCKERS.nprocLimitUnavailable,
        SECURITY_AUDIT_BLOCKERS.fsizeLimitUnavailable,
        SECURITY_AUDIT_BLOCKERS.wallClockLimitUnavailable,
      ],
    };
  }
  if (!Number.isInteger(limits.cpuSeconds) || limits.cpuSeconds < 1) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.cpuLimitUnavailable);
  }
  if (!Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 1) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.memoryLimitUnavailable);
  }
  if (!Number.isInteger(limits.nproc) || limits.nproc < 1) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.nprocLimitUnavailable);
  }
  if (!Number.isInteger(limits.fileBytes) || limits.fileBytes < 1) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.fsizeLimitUnavailable);
  }
  if (!Number.isInteger(limits.wallMs) || limits.wallMs < 1) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.wallClockLimitUnavailable);
  }
  return { ok: blockers.length === 0, blockers };
}

function environmentAllowlist(allowEnv: Readonly<Record<string, string>> | undefined): {
  ok: boolean;
  blockers: string[];
  entries: Array<[string, string]>;
} {
  const blockers: string[] = [];
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(allowEnv ?? {})) {
    if (!ENV_ALLOWLIST_KEY.test(key) || SECRETISH_KEY.test(key)) {
      blockers.push(SECURITY_AUDIT_BLOCKERS.environmentNotAllowlisted);
      continue;
    }
    if (/[\p{Cc}\p{Cf}]/u.test(value)) {
      blockers.push(SECURITY_AUDIT_BLOCKERS.environmentNotAllowlisted);
      continue;
    }
    entries.push([key, value]);
  }
  return { ok: blockers.length === 0, blockers, entries };
}

/**
 * Evalúa los controles. `available` exige los controles base; disco total y
 * promoción dirfd son degradaciones documentadas con bloqueador exacto, no
 * una afirmación de aislamiento total.
 */
export function evaluateSecurityAuditSandbox(
  probe: SecurityAuditSandboxProbe = probeBubblewrap(),
): SecurityAuditSandboxEvaluation {
  // CPU/mem/nproc/fsize son expresables con `ulimit` dentro de la sandbox y el
  // reloj de pared con el timeout del llamador; el uso TOTAL de disco no.
  const controls: SecurityAuditSandboxControls = {
    bwrapFunctional: probe.functional,
    externalNetworkDenied: true,
    emptyEnvironmentAllowlist: true,
    scratchHomeTmpCaches: true,
    readOnlyTargetToolchain: true,
    noHomeCredentialsSockets: true,
    uniqueScratch: true,
    cpuLimit: true,
    memoryLimit: true,
    nprocLimit: true,
    fsizeLimit: true,
    wallClockLimit: true,
    diskTotalLimit: false,
    dirfdPromotion: supportsDirfdPromotion(),
  };

  const blockers: string[] = [];
  if (!controls.bwrapFunctional) blockers.push(SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable);
  if (!controls.externalNetworkDenied) blockers.push(SECURITY_AUDIT_BLOCKERS.externalNetworkNotDenied);
  if (!controls.emptyEnvironmentAllowlist) blockers.push(SECURITY_AUDIT_BLOCKERS.environmentNotAllowlisted);
  if (!controls.scratchHomeTmpCaches) blockers.push(SECURITY_AUDIT_BLOCKERS.scratchLayoutUnavailable);
  if (!controls.readOnlyTargetToolchain) blockers.push(SECURITY_AUDIT_BLOCKERS.targetNotReadOnly);
  if (!controls.noHomeCredentialsSockets) blockers.push(SECURITY_AUDIT_BLOCKERS.homeExposed);
  if (!controls.uniqueScratch) blockers.push(SECURITY_AUDIT_BLOCKERS.scratchNotUnique);
  if (!controls.cpuLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.cpuLimitUnavailable);
  if (!controls.memoryLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.memoryLimitUnavailable);
  if (!controls.nprocLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.nprocLimitUnavailable);
  if (!controls.fsizeLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.fsizeLimitUnavailable);
  if (!controls.wallClockLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.wallClockLimitUnavailable);
  // Degradaciones exactas: desactivan la promoción dinámica.
  if (!controls.diskTotalLimit) blockers.push(SECURITY_AUDIT_BLOCKERS.diskLimitUnavailable);
  if (!controls.dirfdPromotion) blockers.push(SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable);

  const baseBlockers = blockers.filter(
    (blocker) =>
      blocker !== SECURITY_AUDIT_BLOCKERS.diskLimitUnavailable &&
      blocker !== SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable,
  );
  const available = baseBlockers.length === 0;

  return {
    policy: SECURITY_AUDIT_DEFAULT_POLICY,
    available,
    blockers,
    controls,
    isolationClaim: available ? "partial" : "none",
    dynamicPromotion: available && controls.diskTotalLimit ? "enabled" : "disabled",
    network: SECURITY_AUDIT_NETWORK_POLICY,
  };
}

function validateCommand(
  command: SecurityAuditSandboxCommand,
  evaluation: SecurityAuditSandboxEvaluation,
): string[] {
  const blockers: string[] = [];
  if (!Array.isArray(command.target) || command.target.length === 0) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.commandInvalid);
  }
  if (!isAbsolute(command.targetPath)) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.commandInvalid);
  }
  if (!isAbsolute(command.scratchDir)) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.commandInvalid);
  } else if (
    isUnder(command.scratchDir, command.targetPath) ||
    isUnder(command.targetPath, command.scratchDir)
  ) {
    // El scratch nunca vive dentro del target ni lo contiene.
    blockers.push(SECURITY_AUDIT_BLOCKERS.scratchNotUnique);
  }
  const limits = positiveLimits(command.limits);
  if (!limits.ok) blockers.push(...limits.blockers);
  const env = environmentAllowlist(command.allowEnv);
  if (!env.ok) blockers.push(...env.blockers);
  for (const toolchainPath of command.toolchainPaths ?? []) {
    if (!isAbsolute(toolchainPath)) blockers.push(SECURITY_AUDIT_BLOCKERS.commandInvalid);
  }
  if (!evaluation.available) {
    blockers.push(SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable);
  }
  return [...new Set(blockers)];
}

const ULIMIT_SCRIPT =
  'ulimit -t "$1"; ulimit -v "$2"; ulimit -u "$3"; ulimit -f "$4"; shift 4; exec "$@"';

/**
 * Construye el argv de ejecución local aislada SOLO cuando todos los controles
 * base se cumplen. Devuelve `ok:false` (fail-closed) sin argv en caso contrario.
 * Nunca incluye home, credenciales ni sockets del host: `/home`, `/root` y
 * `/run` no se enlazan.
 */
export function buildSecurityAuditSandboxArgv(
  command: SecurityAuditSandboxCommand,
  probe: SecurityAuditSandboxProbe = probeBubblewrap(),
): SecurityAuditSandboxArgv {
  const evaluation = evaluateSecurityAuditSandbox(probe);
  const blockers = validateCommand(command, evaluation);
  const base = {
    blockers,
    controls: evaluation.controls,
    isolationClaim: evaluation.isolationClaim,
    dynamicPromotion: evaluation.dynamicPromotion,
    network: evaluation.network,
    wallClockLimitMs: evaluation.available && blockers.length === 0
      ? command.limits.wallMs
      : null,
  };
  if (blockers.length > 0 || !probe.binary || !evaluation.available) {
    return { ok: false, argv: [], ...base, isolationClaim: "none" };
  }

  const scratch = resolve(command.scratchDir);
  const target = resolve(command.targetPath);
  const env = environmentAllowlist(command.allowEnv);

  const argv: string[] = [
    probe.binary,
    "--unshare-all",
    "--unshare-net",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
  ];
  for (const bind of HOST_RO_BINDS.filter((path) => existsSync(path))) {
    argv.push("--ro-bind", bind, bind);
  }
  argv.push("--ro-bind", target, target);
  for (const toolchainPath of command.toolchainPaths ?? []) {
    argv.push("--ro-bind", resolve(toolchainPath), resolve(toolchainPath));
  }
  argv.push(
    "--bind", scratch, scratch,
    "--setenv", "HOME", `${scratch}${sep}home`,
    "--setenv", "TMPDIR", `${scratch}${sep}tmp`,
    "--setenv", "XDG_CACHE_HOME", `${scratch}${sep}cache`,
    "--setenv", "XDG_CONFIG_HOME", `${scratch}${sep}config`,
    "--setenv", "PATH", "/usr/bin:/bin",
  );
  for (const [key, value] of env.entries) {
    argv.push("--setenv", key, value);
  }
  argv.push("--chdir", target, "--");
  // /bin/sh solo aplica ulimit con argumentos posicionales; ningún string del
  // llamador se interpola en el script. `ulimit -v` usa KiB; `ulimit -f` usa
  // bloques POSIX de 512 bytes (con shells de 1024 el límite queda >= el
  // pedido, nunca por debajo).
  argv.push(
    "/bin/sh",
    "-c",
    ULIMIT_SCRIPT,
    "sh",
    String(command.limits.cpuSeconds),
    String(Math.ceil(command.limits.memoryBytes / 1024)),
    String(command.limits.nproc),
    String(Math.ceil(command.limits.fileBytes / 512)),
    ...command.target,
  );

  return { ok: true, argv, ...base };
}

export interface SecurityAuditPromotionRequest {
  /** Fichero de origen dentro del scratch del agente. */
  scratchFile: string;
  /** Directorio `artifacts/` padre-del-run, propiedad del padre. */
  artifactsDir: string;
  /** Nombre relativo permitido; sin traversal, sin absolutos, sin symlinks. */
  relativeName: string;
  allowlist: readonly string[];
  maxBytes: number;
}

export interface SecurityAuditPromotionResult {
  status: "promotion_blocked" | "promoted";
  blocker: string | null;
  copied: boolean;
  reason: string;
}

/**
 * Promoción scratch → artifacts. En Node no existe `openat` por dirfd con
 * operaciones no-follow, así que la función devuelve `promotion_blocked` y NO
 * copia nunca. Si en el futuro Node lo ofreciera, además exigiría nombre en el
 * allowlist, tamaño bajo el límite y cero componentes symlink.
 */
export function promoteSecurityAuditArtifact(
  request: SecurityAuditPromotionRequest,
): SecurityAuditPromotionResult {
  const blocked = (blocker: string, reason: string): SecurityAuditPromotionResult => ({
    status: "promotion_blocked",
    blocker,
    copied: false,
    reason,
  });

  const { relativeName } = request;
  if (typeof relativeName !== "string" || relativeName.length === 0) {
    return blocked(SECURITY_AUDIT_BLOCKERS.commandInvalid, "nombre vacío");
  }
  if (isAbsolute(relativeName) || relativeName.split(/[\\/]+/).some((part) => part === ".." || part === "." || part === "")) {
    return blocked("path_outside_scope", "nombre relativo con traversal o absoluto");
  }
  if (!request.allowlist.includes(relativeName)) {
    return blocked("not_allowlisted", "el fichero no está en el allowlist registrado");
  }
  if (!Number.isInteger(request.maxBytes) || request.maxBytes < 1) {
    return blocked(SECURITY_AUDIT_BLOCKERS.commandInvalid, "límite de bytes inválido");
  }
  if (!supportsDirfdPromotion()) {
    return blocked(
      SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable,
      "Node no expone openat/dirfd sin carrera; promoción deshabilitada",
    );
  }
  return blocked(SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable, "sin implementación dirfd");
}

/**
 * Rutas sensibles del home que jamás deben aparecer enlazadas en la sandbox
 * ni servir de directorio de salida.
 */
export function sensitiveHomePaths(home: string = homedir()): string[] {
  return SENSITIVE_HOME_ENTRIES.map((entry) => resolve(home, entry));
}

/** Comprueba que una ruta de salida no vive dentro del target ni de su `.git`. */
export function isOutputOutsideTarget(outputDir: string, targetPath: string): boolean {
  const output = resolve(outputDir);
  const target = resolve(targetPath);
  if (output === target || isUnder(target, output)) return false;
  if (isUnder(resolve(target, ".git"), output)) return false;
  return true;
}

/** Comprueba que una ruta no cae en entradas sensibles del home. */
export function isOutputOutsideSensitiveHome(outputDir: string, home: string = homedir()): boolean {
  const output = resolve(outputDir);
  return !sensitiveHomePaths(home).some((sensitive) => output === sensitive || isUnder(sensitive, output));
}

/** Realpath sin symlinks para comprobar rutas ya resueltas. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
