import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const KNOWN_DEV_ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

function parseAudit(stdout, stderr = "") {
  const raw = String(stdout ?? "").trim() || String(stderr ?? "").trim();
  if (!raw) throw new Error("npm audit no devolvió un informe JSON.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("npm audit devolvió contenido que no es JSON válido.");
  }
}

function collectAdvisoryLeaves(name, audit, visited = new Set()) {
  if (visited.has(name)) return [];
  visited.add(name);
  const entry = audit.vulnerabilities?.[name];
  if (!entry) return [{ url: null, title: "No se pudo resolver la cadena de dependencia: " + name }];

  const leaves = [];
  for (const via of entry.via ?? []) {
    if (typeof via === "string") {
      if (!audit.vulnerabilities?.[via]) {
        leaves.push({ url: null, title: "Dependencia vulnerable no resuelta: " + via });
      } else {
        leaves.push(...collectAdvisoryLeaves(via, audit, new Set(visited)));
      }
    } else if (via && typeof via === "object") {
      leaves.push({ url: typeof via.url === "string" ? via.url : null, title: String(via.title ?? name) });
    } else {
      leaves.push({ url: null, title: "Entrada de advisory inválida para " + name });
    }
  }
  return leaves;
}

export function classifySecurityAudits(productionAudit, fullAudit) {
  const production = productionAudit.metadata?.vulnerabilities ?? {};
  const productionHigh = Number(production.high ?? 0);
  const productionCritical = Number(production.critical ?? 0);
  const productionTotal = Number(production.total ?? 0);
  const full = fullAudit.metadata?.vulnerabilities ?? {};
  const highPackages = Object.entries(fullAudit.vulnerabilities ?? {})
    .filter(([, item]) => ["high", "critical"].includes(item.severity))
    .map(([name, item]) => ({
      name,
      severity: item.severity,
      leaves: collectAdvisoryLeaves(name, fullAudit)
    }));

  const knownPackages = [];
  const unknownFindings = [];
  for (const item of highPackages) {
    const urls = [...new Set(item.leaves.map((leaf) => leaf.url))];
    if (urls.length > 0 && urls.every((url) => url === KNOWN_DEV_ADVISORY)) {
      knownPackages.push(item.name);
    } else {
      unknownFindings.push(item);
    }
  }

  return {
    production: {
      total: productionTotal,
      high: productionHigh,
      critical: productionCritical
    },
    full: {
      total: Number(full.total ?? 0),
      high: Number(full.high ?? 0),
      critical: Number(full.critical ?? 0)
    },
    knownDevAdvisory: {
      url: KNOWN_DEV_ADVISORY,
      packages: [...new Set(knownPackages)].sort()
    },
    unknownFindings,
    passed: productionTotal === 0 && productionHigh === 0 && productionCritical === 0 && unknownFindings.length === 0
  };
}

function runNpmAudit(args, cwd) {
  try {
    const stdout = execFileSync("npm", ["audit", ...args, "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024
    });
    return parseAudit(stdout);
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    if ((status === 1 || status === 0) && String(stdout ?? "").trim()) {
      return parseAudit(stdout, stderr);
    }
    throw new Error("No se pudo completar npm audit: " + String(error));
  }
}

export function formatSecurityAuditReport(result) {
  const lines = [
    "AUDITORÍA DE DEPENDENCIAS",
    `Producción: ${result.production.total} vulnerabilidades (high=${result.production.high}, critical=${result.production.critical}).`,
    `Árbol completo: ${result.full.total} vulnerabilidades (high=${result.full.high}, critical=${result.full.critical}).`
  ];
  if (result.knownDevAdvisory.packages.length) {
    lines.push(
      "EXCEPCIÓN DE DESARROLLO REGISTRADA: GHSA-fc5q-39xc-vjpf (ReDoS en picomatch hasta 4.0.7).",
      "Cadena afectada: " + result.knownDevAdvisory.packages.join(", ") + ".",
      "La última versión publicada consultada sigue siendo picomatch 4.0.7; las propuestas upstream para master y v2 continúan sin release npm verificable.",
      "No se debe sustituir por un fork no revisado ni forzar un downgrade de Vite.",
      "Mitigación operativa: mantener Vite enlazado a 127.0.0.1; no exponer el servidor de desarrollo a la red."
    );
  }
  if (result.unknownFindings.length) {
    lines.push("HALLAZGOS HIGH/CRITICAL NO APROBADOS:");
    for (const item of result.unknownFindings) {
      lines.push(`- ${item.name} (${item.severity}): ${[...new Set(item.leaves.map((leaf) => leaf.title))].join("; ")}`);
    }
  }
  lines.push(result.passed ? "PASS: política de seguridad de dependencias satisfecha." : "FAIL: se requiere resolver los hallazgos no aprobados.");
  return lines.join("\n");
}

async function main() {
  const controlCenterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const production = runNpmAudit(["--omit=dev"], controlCenterRoot);
  const full = runNpmAudit([], controlCenterRoot);
  const result = classifySecurityAudits(production, full);
  process.stdout.write(formatSecurityAuditReport(result) + "\n");
  if (!result.passed) process.exitCode = 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write("ERROR en auditoría de dependencias: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
