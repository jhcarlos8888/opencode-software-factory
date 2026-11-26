import { useCallback, useEffect, useRef, useState } from "react";
import {
  SECURITY_AUDIT_DOMAINS,
  SECURITY_AUDIT_PHASES,
  SECURITY_AUDIT_REPORT_FILES,
  SECURITY_AUDIT_SCOPE_KINDS,
  buildSecurityAuditRemediationPayload,
  buildSecurityAuditScope,
  buildSecurityAuditStartPayload,
  formatSecurityAuditTime,
  securityAuditIncompleteReasonLabel,
  securityAuditOutcomeLabel,
  securityAuditPhaseLabel,
  securityAuditProgress,
  securityAuditReportUrl,
  securityAuditRunStatusLabel,
  securityAuditScopeRequiresPaths,
  securityAuditScopeRequiresRefs,
  securityAuditSeverityLabel,
  shouldPollSecurityAudit,
  type SecurityAuditProfile,
  type SecurityAuditScopeKind,
} from "./security-operations.js";

class SecurityApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function securityApi<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new SecurityApiError(response.status, payload.error || `Error HTTP ${response.status}`);
  return payload;
}

interface IntentResult {
  intent: string;
  requiresClarification: boolean;
  matchedSignals: string[];
  createsArtifacts: boolean;
  sixPhasePlan: boolean;
  message: string;
}

interface RunSummary {
  runId: string;
  profile: string;
  runStatus: string;
  incompleteReason: string | null;
  completedPhases: number;
  cancelRequested: boolean;
  ledgerValidator: string;
  findingsValidator: string;
  createdAt: string;
  finishedAt: string | null;
}

interface RunStatus {
  run: RunSummary & { phases: string[] };
  budget: {
    maxInvocations: number | null;
    maxConcurrency: number;
    maxDurationMs: number;
    spent: Record<string, number>;
    reserved: Record<string, number>;
    spentTotal: number;
  };
  progress: { completedPhases: number; phases: Array<{ phase: number; state: string }> };
  execution: {
    runId: string;
    status: string;
    agents: Array<{
      agentId: string;
      engine: string;
      modelId: string;
      sessionId: string | null;
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
    }>;
  } | null;
  invocations: Array<{
    instanceId: string;
    phase: number;
    role: string;
    agentId: string | null;
    engine: string | null;
    model: string | null;
    sessionId: string | null;
    fingerprint: string | null;
    outcome: string;
    crossEngineVerified: boolean;
    crossEnginePlanned: boolean;
    crossEngineEvidence: {
      verified: boolean;
      reason: string | null;
      verifiedAt: string | null;
    } | null;
    autoReplay: boolean;
    startedAt: string;
    finishedAt: string | null;
  }>;
  coverage: {
    unitsTotal: number;
    byStatus: Record<string, number>;
    pendingUnits: string[];
    deferredUnits: string[];
  };
  findings: {
    total: number;
    confirmed: number;
    needsValidation: number;
    rejected: number;
    confirmedBySeverity: Record<string, number>;
    items: Array<{ fingerprint: string; verdict: string; severity: string | null; title: string }>;
  };
  remediations: Array<{
    fingerprint: string;
    state: string;
    executionRunId: string | null;
    evidenceCount: number;
    updatedAt: string;
  }>;
  validators: { ledger: string; findings: string };
  blockers: string[];
  cancelRequested: boolean;
  sandbox: { status: string; blockers: string[] };
}

type Props = {
  projectPath: string;
  /** Profundidad de preconsulta real del proyecto (quick/focused/deep). */
  researchDepth: string;
  teamSaved: boolean;
  preflightConsumed: boolean;
  activeExecution: boolean;
  onExecutionStarted: (runId: string, consumesPreflight: boolean) => void;
};

const EMPTY_SCOPE_DRAFT = {
  kind: "project" as SecurityAuditScopeKind,
  pathsText: "",
  domains: [] as string[],
  baseRef: "",
  headRef: "",
};

export function SecurityOperations({ projectPath, researchDepth, teamSaved, preflightConsumed, activeExecution, onExecutionStarted }: Props) {
  const [intentText, setIntentText] = useState("");
  const [intent, setIntent] = useState<IntentResult | null>(null);
  const [profile, setProfile] = useState<SecurityAuditProfile>("standard");
  const [scopeDraft, setScopeDraft] = useState(EMPTY_SCOPE_DRAFT);
  const [maxInvocations, setMaxInvocations] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState("1");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const selectedRunRef = useRef("");
  const statusRequest = useRef(0);
  const awaitingExecutionRef = useRef("");
  const [awaitingExecutionId, setAwaitingExecutionId] = useState("");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<string[]>([]);
  const [verificationInputs, setVerificationInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadHistory = useCallback(async () => {
    if (!projectPath) return;
    try {
      const payload = await securityApi<{ runs: RunSummary[] }>(
        `/api/security-audit/runs?projectPath=${encodeURIComponent(projectPath)}`,
      );
      setHistory(payload.runs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectPath]);

  const trackExecution = useCallback((executionId: string) => {
    awaitingExecutionRef.current = executionId;
    setAwaitingExecutionId(executionId);
  }, []);

  const loadStatus = useCallback(async (runId: string) => {
    if (!runId || selectedRunRef.current !== runId) return;
    const request = ++statusRequest.current;
    const pendingId = awaitingExecutionRef.current;
    const current = () => selectedRunRef.current === runId && statusRequest.current === request;
    try {
      let payload: RunStatus | null = null;
      try {
        payload = await securityApi<RunStatus>(
          "/api/security-audit/runs/" + encodeURIComponent(runId),
        );
      } catch (cause) {
        // POST returns before the engines are ready and the audit row exists.
        // A 404 is provisional only while a known accepted execution is active.
        if (!pendingId || !(cause instanceof SecurityApiError) || cause.status !== 404) throw cause;
      }
      if (!current()) return;
      if (payload) {
        setStatus(payload);
        const confirmed = new Set(payload.findings.items.filter((item) => item.verdict === "confirmed").map((item) => item.fingerprint));
        setSelectedFindings((previous) => previous.filter((fingerprint) => confirmed.has(fingerprint)));
      }
      if (pendingId) {
        const execution = await securityApi<{ execution: { run: { status: string } } }>(
          "/api/executions/" + encodeURIComponent(pendingId),
        );
        if (!current()) return;
        if (!["queued", "running", "waiting"].includes(execution.execution.run.status)) {
          trackExecution("");
          if (!payload) {
            setError("La ejecución terminó sin registrar la auditoría. Consulta la consola de actividad.");
          }
          await loadHistory();
        } else if (payload) {
          // Refresh history as soon as the newly registered audit is visible.
          await loadHistory();
        }
      } else if (payload && payload.run.runStatus !== "in_progress") {
        await loadHistory();
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadHistory, trackExecution]);

  const selectRun = useCallback((runId: string) => {
    selectedRunRef.current = runId;
    statusRequest.current += 1;
    trackExecution("");
    setSelectedRunId(runId);
    setStatus(null);
    setSelectedFindings([]);
    setVerificationInputs({});
  }, [trackExecution]);

  useEffect(() => {
    setHistory([]);
    selectRun("");
    void loadHistory();
  }, [loadHistory, selectRun]);

  // Sondear también mientras la ejecución espera a que el orquestador registre la auditoría.
  const polling = Boolean(awaitingExecutionId) || shouldPollSecurityAudit(status?.run);
  useEffect(() => {
    if (!polling || !selectedRunId) return;
    const timer = setInterval(() => { void loadStatus(selectedRunId); }, 1500);
    return () => clearInterval(timer);
  }, [polling, selectedRunId, loadStatus]);

  async function runAction(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function classifyIntent(): Promise<void> {
    await runAction(async () => {
      const payload = await securityApi<IntentResult>("/api/security-audit/intent", {
        method: "POST",
        body: JSON.stringify({ text: intentText }),
      });
      setIntent(payload);
      setNotice(payload.message);
    });
  }

  async function startAudit(): Promise<void> {
    await runAction(async () => {
      const scope = buildSecurityAuditScope(scopeDraft);
      if (!scope.ok) throw new Error(scope.error);
      const budget = {
        maxInvocations: maxInvocations.trim() ? Number(maxInvocations.trim()) : null,
        maxConcurrency: Number(maxConcurrency) || 1,
        maxDurationMs: Math.max(1, Number(durationMinutes) || 60) * 60_000,
      };
      if (budget.maxInvocations !== null &&
          (!Number.isInteger(budget.maxInvocations) || budget.maxInvocations < 1)) {
        throw new Error("El presupuesto máximo debe ser un entero mayor que cero.");
      }
      const payload = await securityApi<{ runId: string; message: string }>(
        "/api/security-audit/runs",
        {
          method: "POST",
          body: JSON.stringify(buildSecurityAuditStartPayload({
            projectPath,
            researchDepth,
            profile,
            scope: scope.scope,
            budget,
          })),
        },
      );
      setNotice(payload.message);
      selectRun(payload.runId);
      trackExecution(payload.runId);
      onExecutionStarted(payload.runId, true);
      await loadHistory();
      await loadStatus(payload.runId);
    });
  }

  async function resumeAudit(runId: string): Promise<void> {
    await runAction(async () => {
      const payload = await securityApi<{ message: string; executionRunId: string }>(
        `/api/security-audit/runs/${encodeURIComponent(runId)}/resume`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setNotice(payload.message);
      trackExecution(payload.executionRunId);
      onExecutionStarted(payload.executionRunId, false);
      await loadStatus(runId);
      await loadHistory();
    });
  }

  async function cancelAudit(runId: string): Promise<void> {
    await runAction(async () => {
      await securityApi<{ runId: string }>(
        `/api/security-audit/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setNotice("Cancelación solicitada. La corrida se detiene en la próxima compuerta.");
      await loadStatus(runId);
      await loadHistory();
    });
  }

  async function validateAudit(runId: string): Promise<void> {
    await runAction(async () => {
      const payload = await securityApi<{ ok: boolean; message: string }>(
        `/api/security-audit/runs/${encodeURIComponent(runId)}/validate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setNotice(payload.message);
      await loadStatus(runId);
    });
  }

  async function remediate(): Promise<void> {
    if (selectedFindings.length === 0) {
      setError("Selecciona al menos un hallazgo confirmado para remediar.");
      return;
    }
    const confirmed = window.confirm(
      `Se creará una ejecución INDEPENDIENTE (permisos normales) para remediar ` +
      `${selectedFindings.length} hallazgo(s): ${selectedFindings.join(", ")}. ` +
      "La auditoría no modifica el target. ¿Continuar?",
    );
    if (!confirmed) return;
    await runAction(async () => {
      const payload = await securityApi<{ executionRunId: string; note: string }>(
        `/api/security-audit/runs/${encodeURIComponent(selectedRunId)}/remediations`,
        {
          method: "POST",
          body: JSON.stringify(buildSecurityAuditRemediationPayload({
            projectPath,
            researchDepth,
            fingerprints: selectedFindings,
          })),
        },
      );
      setNotice(payload.note);
      onExecutionStarted(payload.executionRunId, false);
      setSelectedFindings([]);
      await loadStatus(selectedRunId);
    });
  }

  async function revalidateRemediation(fingerprint: string): Promise<void> {
    const verificationAuditRunId = (verificationInputs[fingerprint] ?? "").trim();
    if (!verificationAuditRunId) {
      setError("Indica el runId del run de verificación completo para revalidar.");
      return;
    }
    await runAction(async () => {
      const payload = await securityApi<{ state: string; evidenceSource: string }>(
        `/api/security-audit/runs/${encodeURIComponent(selectedRunId)}` +
        `/remediations/${encodeURIComponent(fingerprint)}/revalidate`,
        { method: "POST", body: JSON.stringify({ verificationAuditRunId }) },
      );
      setNotice(
        `Remediación ${fingerprint} marcada como verified_fixed con evidencia del run ${payload.evidenceSource}.`,
      );
      await loadStatus(selectedRunId);
    });
  }

  const progress = securityAuditProgress(status?.run?.phases ?? []);
  const confirmedFindings = status?.findings.items.filter((item) => item.verdict === "confirmed") ?? [];
  const canStart = Boolean(projectPath) && teamSaved && !preflightConsumed && !busy && !activeExecution && !awaitingExecutionId;
  const scopeNeedsPaths = securityAuditScopeRequiresPaths(scopeDraft.kind);
  const scopeNeedsRefs = securityAuditScopeRequiresRefs(scopeDraft.kind);

  return (
    <div className="security-ops">
      <div className="security-ops-header">
        <div className="eyebrow">SECURITY OPERATIONS</div>
        <h2>Auditoría de ciberseguridad</h2>
        <p>
          Guidance por defecto: clasificar no crea archivos ni corridas. La auditoría completa
          solo inicia con una acción explícita y con el equipo, la preconsulta y los favoritos
          del proyecto en orden.
        </p>
      </div>

      {error && <div className="notice error-notice"><strong>Error</strong><span>{error}</span></div>}
      {notice && <div className="notice success-notice"><strong>Estado</strong><span>{notice}</span></div>}
      {awaitingExecutionId && !status && <div className="security-ops-hint" role="status">Preparando motores y registro de auditoría. La información aparecerá automáticamente.</div>}

      <div className="security-ops-grid">
        <section className="security-ops-panel">
          <h3>1 · Intención</h3>
          <textarea
            value={intentText}
            onChange={(event) => setIntentText(event.target.value)}
            placeholder="Escribe la petición de seguridad (ej.: ¿qué es una vulnerabilidad de inyección?)"
            rows={3}
          />
          <div className="security-ops-actions">
            <button type="button" onClick={() => void classifyIntent()} disabled={busy || !intentText.trim()}>
              Clasificar
            </button>
          </div>
          {intent && (
            <div className="security-ops-intent">
              <div><b>Intención:</b> {intent.intent}</div>
              <div><b>Requiere aclaración:</b> {intent.requiresClarification ? "sí" : "no"}</div>
              <div><b>Crea artefactos:</b> {intent.createsArtifacts ? "sí" : "no"}</div>
              <div><b>Plan de seis fases:</b> {intent.sixPhasePlan ? "sí" : "no"}</div>
              {intent.matchedSignals.length > 0 && (
                <div><b>Señales:</b> {intent.matchedSignals.join(", ")}</div>
              )}
            </div>
          )}
        </section>

        <section className="security-ops-panel">
          <h3>2 · Configuración de la auditoría</h3>
          <div className="security-ops-field">
            <label htmlFor="security-profile">Perfil</label>
            <select
              id="security-profile"
              value={profile}
              onChange={(event) => setProfile(event.target.value as SecurityAuditProfile)}
            >
              <option value="quick">Quick (1 ola, 1 crítico)</option>
              <option value="standard">Standard (6 fases completas)</option>
              <option value="deep">Deep (críticos adicionales)</option>
            </select>
          </div>

          <div className="security-ops-field">
            <label htmlFor="security-scope">Alcance</label>
            <select
              id="security-scope"
              value={scopeDraft.kind}
              onChange={(event) => setScopeDraft({
                ...scopeDraft,
                kind: event.target.value as SecurityAuditScopeKind,
              })}
            >
              {SECURITY_AUDIT_SCOPE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </div>

          {(scopeNeedsPaths || scopeDraft.kind === "git-diff") && (
            <div className="security-ops-field">
              <label htmlFor="security-paths">Rutas (una por línea)</label>
              <textarea
                id="security-paths"
                rows={3}
                value={scopeDraft.pathsText}
                onChange={(event) => setScopeDraft({ ...scopeDraft, pathsText: event.target.value })}
                placeholder={"src/api\nsrc/lib"}
              />
            </div>
          )}

          {scopeDraft.kind === "domain" && (
            <fieldset className="security-ops-domains">
              <legend>Dominios oficiales</legend>
              {SECURITY_AUDIT_DOMAINS.map((domain) => (
                <label key={domain}>
                  <input
                    type="checkbox"
                    checked={scopeDraft.domains.includes(domain)}
                    onChange={(event) => setScopeDraft({
                      ...scopeDraft,
                      domains: event.target.checked
                        ? [...scopeDraft.domains, domain]
                        : scopeDraft.domains.filter((item) => item !== domain),
                    })}
                  />
                  {domain}
                </label>
              ))}
            </fieldset>
          )}

          {scopeNeedsRefs && (
            <div className="security-ops-inline">
              <div className="security-ops-field">
                <label htmlFor="security-base">baseRef</label>
                <input
                  id="security-base"
                  value={scopeDraft.baseRef}
                  onChange={(event) => setScopeDraft({ ...scopeDraft, baseRef: event.target.value })}
                />
              </div>
              <div className="security-ops-field">
                <label htmlFor="security-head">headRef</label>
                <input
                  id="security-head"
                  value={scopeDraft.headRef}
                  onChange={(event) => setScopeDraft({ ...scopeDraft, headRef: event.target.value })}
                />
              </div>
            </div>
          )}

          <div className="security-ops-inline">
            <div className="security-ops-field">
              <label htmlFor="security-budget">Presupuesto (vacío = sin tope)</label>
              <input
                id="security-budget"
                inputMode="numeric"
                value={maxInvocations}
                onChange={(event) => setMaxInvocations(event.target.value)}
                placeholder="p. ej. 20"
              />
            </div>
            <div className="security-ops-field">
              <label htmlFor="security-concurrency">Concurrencia</label>
              <input
                id="security-concurrency"
                inputMode="numeric"
                value={maxConcurrency}
                onChange={(event) => setMaxConcurrency(event.target.value)}
              />
            </div>
            <div className="security-ops-field">
              <label htmlFor="security-duration">Tiempo (minutos)</label>
              <input
                id="security-duration"
                inputMode="numeric"
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(event.target.value)}
              />
            </div>
          </div>

          <div className="security-ops-actions">
            <button type="button" className="primary" onClick={() => void startAudit()} disabled={!canStart}>
              Iniciar auditoría
            </button>
          </div>
          {!projectPath && <div className="security-ops-hint">Selecciona un proyecto antes de iniciar.</div>}
          {projectPath && !teamSaved && (
            <div className="security-ops-hint">Guarda el equipo del proyecto (preconsulta) antes de iniciar.</div>
          )}
          {projectPath && teamSaved && preflightConsumed && (
            <div className="security-ops-hint">
              La preconsulta ya fue utilizada; ejecuta una nueva preconsulta para iniciar otra auditoría.
            </div>
          )}
        </section>
      </div>

      <section className="security-ops-panel">
        <h3>3 · Historial de corridas</h3>
        {history.length === 0 ? (
          <div className="security-ops-hint">Sin auditorías registradas para este proyecto.</div>
        ) : (
          <div className="security-ops-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th><th>Perfil</th><th>Estado</th><th>Fases</th>
                  <th>Creada</th><th></th>
                </tr>
              </thead>
              <tbody>
                {history.map((run) => (
                  <tr key={run.runId} className={run.runId === selectedRunId ? "selected" : ""}>
                    <td><code>{run.runId.slice(0, 12)}</code></td>
                    <td>{run.profile}</td>
                    <td>
                      {securityAuditRunStatusLabel(run.runStatus)}
                      {run.incompleteReason ? ` · ${securityAuditIncompleteReasonLabel(run.incompleteReason)}` : ""}
                    </td>
                    <td>{run.completedPhases}/6</td>
                    <td>{formatSecurityAuditTime(run.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => { selectRun(run.runId); void loadStatus(run.runId); }}
                        disabled={busy || Boolean(awaitingExecutionId)}
                      >
                        Ver estado
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {status && (
        <section className="security-ops-panel security-ops-status">
          <h3>4 · Estado de la corrida <code>{status.run.runId.slice(0, 12)}</code></h3>

          <div className="security-ops-phases">
            {SECURITY_AUDIT_PHASES.map((item) => {
              const state = status.run.phases[item.phase - 1] ?? "pending";
              return (
                <div key={item.phase} className={`security-ops-phase state-${state}`}>
                  <span className="security-ops-phase-number">{item.phase}</span>
                  <span className="security-ops-phase-label">{item.label}</span>
                  <span className="security-ops-phase-state">{securityAuditPhaseLabel(state)}</span>
                </div>
              );
            })}
          </div>
          <div className="security-ops-progress">
            Progreso {progress.completed}/{progress.total} fases ({progress.percent}%)
            {" · "}Estado: {securityAuditRunStatusLabel(status.run.runStatus)}
            {status.run.incompleteReason && (
              <> · {securityAuditIncompleteReasonLabel(status.run.incompleteReason)}</>
            )}
          </div>

          <div className="security-ops-columns">
            <div>
              <h4>Presupuesto</h4>
              <ul>
                <li>Máximo: {status.budget.maxInvocations ?? "sin tope"}</li>
                <li>Concurrencia: {status.budget.maxConcurrency}</li>
                <li>Tiempo: {Math.round(status.budget.maxDurationMs / 60000)} min</li>
                <li>Gastado: {status.budget.spentTotal}</li>
                <li>Reservado: {JSON.stringify(status.budget.reserved)}</li>
                <li>Gasto por fase: {JSON.stringify(status.budget.spent)}</li>
              </ul>
            </div>
            <div>
              <h4>Cobertura</h4>
              <ul>
                <li>Unidades: {status.coverage.unitsTotal}</li>
                <li>Por estado: {JSON.stringify(status.coverage.byStatus)}</li>
                <li>Pendientes: {status.coverage.pendingUnits.length}</li>
                <li>Diferidas: {status.coverage.deferredUnits.length}</li>
              </ul>
            </div>
            <div>
              <h4>Validadores</h4>
              <ul>
                <li>coverage-ledger: {status.validators.ledger}</li>
                <li>findings: {status.validators.findings}</li>
                <li>Sandbox: {status.sandbox.status}</li>
                {status.sandbox.blockers.length > 0 && (
                  <li>Bloqueos: {status.sandbox.blockers.join(", ")}</li>
                )}
              </ul>
            </div>
          </div>

          {status.blockers.length > 0 && (
            <div className="security-ops-blockers">
              <h4>Bloqueos</h4>
              <ul>{status.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            </div>
          )}

          <h4>Hallazgos</h4>
          <div className="security-ops-severity-row">
            <span>Confirmados: {status.findings.confirmed}</span>
            {Object.entries(status.findings.confirmedBySeverity).map(([severity, count]) => (
              <span key={severity}>{securityAuditSeverityLabel(severity)}: {count}</span>
            ))}
            <span>needs_validation: {status.findings.needsValidation}</span>
            <span>rejected: {status.findings.rejected}</span>
          </div>

          {confirmedFindings.length > 0 && (
            <div className="security-ops-remediation">
              <h4>Remediación (ejecución independiente)</h4>
              {confirmedFindings.map((item) => (
                <label key={item.fingerprint}>
                  <input
                    type="checkbox"
                    checked={selectedFindings.includes(item.fingerprint)}
                    onChange={(event) => setSelectedFindings(event.target.checked
                      ? [...selectedFindings, item.fingerprint]
                      : selectedFindings.filter((fingerprint) => fingerprint !== item.fingerprint))}
                  />
                  <code>{item.fingerprint}</code> · {securityAuditSeverityLabel(item.severity)} · {item.title}
                </label>
              ))}
              <div className="security-ops-actions">
                <button type="button" onClick={() => void remediate()} disabled={busy || activeExecution || Boolean(awaitingExecutionId) || selectedFindings.length === 0}>
                  Remediar seleccionados
                </button>
              </div>
            </div>
          )}

          {status.remediations.length > 0 && (
            <div className="security-ops-remediation-list">
              <h4>Remediaciones registradas</h4>
              <ul>
                {status.remediations.map((remediation) => (
                  <li key={remediation.fingerprint}>
                    <code>{remediation.fingerprint}</code> → {remediation.state}
                    {remediation.executionRunId ? ` · ejecución ${remediation.executionRunId.slice(0, 8)}` : ""}
                    {" · evidencias: "}{remediation.evidenceCount}
                    {remediation.state !== "verified_fixed" && (
                      <span className="security-ops-revalidate">
                        <input
                          aria-label={`Run de verificación para ${remediation.fingerprint}`}
                          value={verificationInputs[remediation.fingerprint] ?? ""}
                          onChange={(event) => setVerificationInputs({
                            ...verificationInputs,
                            [remediation.fingerprint]: event.target.value,
                          })}
                          placeholder="runId del run de verificación completo"
                        />
                        <button
                          type="button"
                          onClick={() => void revalidateRemediation(remediation.fingerprint)}
                          disabled={busy}
                        >
                          Revalidar
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h4>Invocaciones</h4>
          {status.invocations.length === 0 ? (
            <div className="security-ops-hint">Sin invocaciones registradas todavía.</div>
          ) : (
            <div className="security-ops-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fase</th><th>Rol</th><th>Agente</th><th>Motor</th><th>Modelo</th>
                    <th>Sesión</th><th>Estado</th><th>Cross-engine</th><th>Inicio</th>
                  </tr>
                </thead>
                <tbody>
                  {status.invocations.map((invocation) => (
                    <tr key={invocation.instanceId}>
                      <td>{invocation.phase}</td>
                      <td>{invocation.role}</td>
                      <td>{invocation.agentId ?? "—"}</td>
                      <td>{invocation.engine ?? "—"}</td>
                      <td>{invocation.model ?? "—"}</td>
                      <td><code>{invocation.sessionId ?? "—"}</code></td>
                      <td>{securityAuditOutcomeLabel(invocation.outcome)}</td>
                      <td
                        title={invocation.crossEngineEvidence?.reason
                          ? `razón: ${invocation.crossEngineEvidence.reason}`
                          : invocation.crossEngineEvidence?.verifiedAt
                            ? `verificada ${invocation.crossEngineEvidence.verifiedAt}`
                            : undefined}
                      >
                        {invocation.crossEngineEvidence?.verified
                          ? "verificada"
                          : invocation.crossEnginePlanned
                            ? "planificada (sin evidencia)"
                            : "no aplica"}
                      </td>
                      <td>{formatSecurityAuditTime(invocation.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="security-ops-actions">
            <button
              type="button"
              onClick={() => void resumeAudit(status.run.runId)}
              disabled={busy || activeExecution || Boolean(awaitingExecutionId) || status.run.runStatus === "complete"}
            >
              Reanudar
            </button>
            <button
              type="button"
              onClick={() => void cancelAudit(status.run.runId)}
              disabled={busy || status.run.runStatus !== "in_progress" || status.cancelRequested}
            >
              Cancelar
            </button>
            <button type="button" onClick={() => void validateAudit(status.run.runId)} disabled={busy}>
              Validar artefactos
            </button>
          </div>

          <div className="security-ops-downloads">
            <h4>Descargas</h4>
            {SECURITY_AUDIT_REPORT_FILES.map((artifact) => (
              <a
                key={artifact}
                href={securityAuditReportUrl(status.run.runId, artifact)}
                download
                target="_blank"
                rel="noreferrer"
              >
                {artifact}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default SecurityOperations;
