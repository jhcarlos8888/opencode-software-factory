import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  SECURITY_AUDIT_BLOCKERS,
  SECURITY_AUDIT_DEFAULT_POLICY,
  SECURITY_AUDIT_NETWORK_POLICY,
  buildSecurityAuditSandboxArgv,
  evaluateSecurityAuditSandbox,
  isOutputOutsideSensitiveHome,
  isOutputOutsideTarget,
  probeBubblewrap,
  promoteSecurityAuditArtifact,
  supportsDirfdPromotion,
  type SecurityAuditSandboxCommand,
} from "./security-audit-sandbox.js";

const isolated = mkdtempSync(join(tmpdir(), "factory-security-audit-sandbox-"));

after(() => {
  rmSync(isolated, { recursive: true, force: true });
});

function workspace(): { target: string; scratch: string } {
  const target = join(isolated, "target-" + Math.random().toString(36).slice(2, 8));
  const scratch = join(isolated, "scratch-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(target, { recursive: true });
  mkdirSync(join(scratch, "home"), { recursive: true });
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  mkdirSync(join(scratch, "cache"), { recursive: true });
  mkdirSync(join(scratch, "config"), { recursive: true });
  return { target, scratch };
}

const workingProbe = {
  binary: "/usr/bin/bwrap",
  version: "bwrap 0.8.0",
  functional: true,
  isolatedTrue: true,
  blockers: [] as readonly string[],
};

function command(overrides: Partial<SecurityAuditSandboxCommand> = {}): SecurityAuditSandboxCommand {
  const { target, scratch } = workspace();
  return {
    target: ["/bin/echo", "hola"],
    targetPath: target,
    scratchDir: scratch,
    limits: { cpuSeconds: 10, memoryBytes: 512 * 1024 * 1024, nproc: 64, fileBytes: 1024 * 1024, wallMs: 30_000 },
    ...overrides,
  };
}

test("absent bubblewrap fails closed without any argv", () => {
  const probe = {
    binary: null,
    version: null,
    functional: false,
    isolatedTrue: false,
    blockers: [SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable],
  };
  const evaluation = evaluateSecurityAuditSandbox(probe);
  assert.equal(evaluation.available, false);
  assert.equal(evaluation.isolationClaim, "none");
  assert.ok(evaluation.blockers.includes(SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable));

  const built = buildSecurityAuditSandboxArgv(command(), probe);
  assert.equal(built.ok, false);
  assert.deepEqual(built.argv, []);
  assert.equal(built.wallClockLimitMs, null);
  assert.ok(built.blockers.includes(SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable));
});

test("the real probe is safe, target-free and honest about availability", () => {
  const probe = probeBubblewrap();
  assert.equal(typeof probe.functional, "boolean");
  assert.equal(typeof probe.isolatedTrue, "boolean");
  if (probe.functional) {
    assert.ok(probe.version && probe.version.length > 0);
    assert.deepEqual(probe.blockers, []);
    assert.ok(probe.binary?.startsWith("/"));
  } else {
    assert.ok(probe.blockers.includes(SECURITY_AUDIT_BLOCKERS.bubblewrapUnavailable));
  }
  // La sonda jamás recibe la ruta del target.
  assert.equal(JSON.stringify(probe).includes("target"), false);
});

test("argv denies target network, keeps AI-provider network outside and leaks no secrets", () => {
  const built = buildSecurityAuditSandboxArgv(
    command({ allowEnv: { LANG: "C.UTF-8" } }),
    workingProbe,
  );
  assert.equal(built.ok, true, built.blockers.join(", "));
  const rendered = built.argv.join(" ");
  assert.ok(rendered.includes("--unshare-net"));
  assert.ok(rendered.includes("--clearenv"));
  assert.equal(rendered.includes(homedir()), false, "nunca el home del host");
  assert.equal(rendered.includes("/home/"), false, "sin enlaces al home");
  assert.equal(rendered.includes("/run/"), false, "sin sockets del host");
  assert.equal(rendered.includes("TOKEN"), false);
  assert.equal(rendered.includes("SECRET"), false);
  assert.deepEqual(built.network, SECURITY_AUDIT_NETWORK_POLICY);
  assert.equal(built.network.target, "denied");
  assert.equal(built.network.aiProvider, "outside-sandbox-allowed");
  assert.equal(SECURITY_AUDIT_DEFAULT_POLICY, "source-only");
  assert.equal(built.dynamicPromotion, "disabled");
  assert.equal(built.isolationClaim, "partial");
  assert.equal(built.wallClockLimitMs, 30_000);

  // Un valor con apariencia de secreto en la allowlist bloquea todo.
  const withSecret = buildSecurityAuditSandboxArgv(
    command({ allowEnv: { API_KEY: "valor-secreto-no-debe-salir" } }),
    workingProbe,
  );
  assert.equal(withSecret.ok, false);
  assert.ok(withSecret.blockers.includes(SECURITY_AUDIT_BLOCKERS.environmentNotAllowlisted));
  assert.equal(withSecret.argv.join(" ").includes("valor-secreto-no-debe-salir"), false);
});

test("explicit limits and a scratch disjoint from the target are mandatory", () => {
  const missingLimits = buildSecurityAuditSandboxArgv(
    command({ limits: { cpuSeconds: 0, memoryBytes: -1, nproc: 0, fileBytes: 0, wallMs: 0 } }),
    workingProbe,
  );
  assert.equal(missingLimits.ok, false);
  for (const blocker of [
    SECURITY_AUDIT_BLOCKERS.cpuLimitUnavailable,
    SECURITY_AUDIT_BLOCKERS.memoryLimitUnavailable,
    SECURITY_AUDIT_BLOCKERS.nprocLimitUnavailable,
    SECURITY_AUDIT_BLOCKERS.fsizeLimitUnavailable,
    SECURITY_AUDIT_BLOCKERS.wallClockLimitUnavailable,
  ]) {
    assert.ok(missingLimits.blockers.includes(blocker), blocker);
  }

  const baseCommand = command();
  const scratchInsideTarget = buildSecurityAuditSandboxArgv(
    { ...baseCommand, scratchDir: join(baseCommand.targetPath, "scratch") },
    workingProbe,
  );
  assert.equal(scratchInsideTarget.ok, false);
  assert.ok(scratchInsideTarget.blockers.includes(SECURITY_AUDIT_BLOCKERS.scratchNotUnique));

  const noCommand = buildSecurityAuditSandboxArgv(command({ target: [] }), workingProbe);
  assert.equal(noCommand.ok, false);
  assert.ok(noCommand.blockers.includes(SECURITY_AUDIT_BLOCKERS.commandInvalid));
});

test("disk and dirfd limitations are disclosed, never claimed as total isolation", () => {
  const evaluation = evaluateSecurityAuditSandbox(workingProbe);
  assert.equal(evaluation.available, true);
  assert.equal(evaluation.isolationClaim, "partial");
  assert.notEqual(evaluation.isolationClaim, "total");
  assert.equal(evaluation.controls.diskTotalLimit, false);
  assert.ok(evaluation.blockers.includes(SECURITY_AUDIT_BLOCKERS.diskLimitUnavailable));
  assert.ok(evaluation.blockers.includes(SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable));
  assert.equal(evaluation.dynamicPromotion, "disabled");
  assert.equal(supportsDirfdPromotion(), false);
});

test("promotion is blocked without copying anything", () => {
  const { scratch } = workspace();
  const artifactsDir = join(scratch, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const scratchFile = join(scratch, "scratch", "result.txt");
  mkdirSync(join(scratch, "scratch"), { recursive: true });
  writeFileSync(scratchFile, "resultado", { mode: 0o600 });

  const allowed = promoteSecurityAuditArtifact({
    scratchFile,
    artifactsDir,
    relativeName: "result.txt",
    allowlist: ["result.txt"],
    maxBytes: 1024,
  });
  assert.equal(allowed.status, "promotion_blocked");
  assert.equal(allowed.blocker, SECURITY_AUDIT_BLOCKERS.promotionDirfdUnavailable);
  assert.equal(allowed.copied, false);
  assert.equal(existsSync(join(artifactsDir, "result.txt")), false, "sin copia alguna");

  const traversal = promoteSecurityAuditArtifact({
    scratchFile,
    artifactsDir,
    relativeName: "../fuera/result.txt",
    allowlist: ["../fuera/result.txt"],
    maxBytes: 1024,
  });
  assert.equal(traversal.status, "promotion_blocked");
  assert.equal(traversal.blocker, "path_outside_scope");
  assert.equal(traversal.copied, false);

  const absolute = promoteSecurityAuditArtifact({
    scratchFile,
    artifactsDir,
    relativeName: "/etc/passwd",
    allowlist: ["/etc/passwd"],
    maxBytes: 1024,
  });
  assert.equal(absolute.blocker, "path_outside_scope");
  assert.equal(absolute.copied, false);

  const notAllowlisted = promoteSecurityAuditArtifact({
    scratchFile,
    artifactsDir,
    relativeName: "otro.txt",
    allowlist: ["result.txt"],
    maxBytes: 1024,
  });
  assert.equal(notAllowlisted.blocker, "not_allowlisted");
  assert.equal(notAllowlisted.copied, false);
  assert.deepEqual(
    readdirSync(artifactsDir),
    [],
    "el directorio de artefactos queda vacío",
  );
});

test("outputs outside the target and outside sensitive home paths", () => {
  const { target } = workspace();
  assert.equal(isOutputOutsideTarget(join(isolated, "salida"), target), true);
  assert.equal(isOutputOutsideTarget(join(target, "salida"), target), false);
  assert.equal(isOutputOutsideTarget(join(target, ".git", "salida"), target), false);
  assert.equal(isOutputOutsideSensitiveHome(join(homedir(), ".ssh", "salida")), false);
  assert.equal(isOutputOutsideSensitiveHome(join(homedir(), ".aws", "salida")), false);
  assert.equal(isOutputOutsideSensitiveHome(join(isolated, "salida")), true);
});
