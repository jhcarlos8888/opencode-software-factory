# Arquitectura de Security Operations

Documento propio de este repositorio. Describe cómo se implementa la modalidad
`security-audit` sobre la fábrica existente, sin sustituir la skill upstream
(`.opencode/skills/security-audit/`, commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`,
integridad en `provenance.sha256` y detalle en `UPSTREAM.md`).

## 1. Piezas

| Pieza | Responsabilidad |
| --- | --- |
| `control-center/src/api/security-audit-contracts.ts` | Tipos y validación runtime: intención, perfiles, alcance, dominios, fases, estados, motivos `incomplete`, presupuesto y clasificación de errores de proveedor. |
| `security-audit-intent.ts` | Detección conservadora ES/EN (guidance por defecto; `full_audit` y `remediation` solo con señales explícitas; ambigüedad → aclaración). |
| `security-audit-budget.ts` | Gate pre-reconocimiento, reservas, gasto, concurrencia, cancelación/reanudación y evidencia (funciones puras). |
| `security-audit-orchestrator.ts` | Máquina de fases 1→6 con `SecurityAuditAgentInvoker` inyectable (solo pruebas lo sustituyen). |
| `security-audit-start.ts` | Validación de las opciones `securityAudit` de `startExecution` con los contratos. |
| `security-audit-persistence.ts` | Tablas SQLite (`security_audit_*`): runs, unidades, invocaciones, hallazgos, checkpoints y remediaciones. |
| `security-audit-artifacts.ts` | Único escritor de los artefactos compartidos (0700/0600, atómico, sin symlinks, validado). |
| `security-audit-upstream.ts` | Única capa a los validadores oficiales (`spawnSync` sin shell, rutas confinadas, salida redactada). |
| `security-audit-reports.ts` | Informes de fase 6 deterministas en español, sin modelo. |
| `security-audit-sandbox.ts` | Política `source-only`, sonda real de Bubblewrap y constructor de argv (limitación documentada: sin llamador productivo; el arranque sandboxed se rechaza con `sandbox_not_implemented`). |
| `security-audit-api.ts` + `server.ts` | Rutas HTTP de la modalidad. |
| `security-audit-orchestrator.ts` en `execution.ts` | Adaptador productivo del invoker (una sesión nueva por instancia). |
| `task-planner.ts` | Metadato `securityOperation` y selección de solo lectura; nunca arranca las seis fases. |
| `SecurityOperations.tsx` + `security-operations.ts` | Sección de UI y helpers puros. |
| `.opencode/commands/auditoria-seguridad.md` | Comando nativo (guidance por defecto). |

## 2. Flujo de las seis fases

1. **Reconocimiento**: exactamente 4 invocaciones baseline con instancias
   frescas de Architect y Reverse; producen superficies que se fusionan en el
   ledger (deduplicadas).
2. **Olas de caza**: hunters frescos desde el ledger (Reverse, Architect,
   Implementer) alternando motores cuando el equipo tiene dos; crítico
   post-ola (Build o Tester); en `standard`/`deep` además un crítico final
   limpio (Cloud Arbiter). `quick` ejecuta UNA ola y UN crítico.
3. **Validación de candidatos**: un verificador fresco por candidato que
   **nunca** es su descubridor.
4. **Salida estructurada**: el padre escribe y valida `findings.json` y
   `coverage-ledger.json` (sin agentes).
5. **Verificación de registros**: verificador fresco distinto del hunter y de
   la fase 3; `quick` fusiona 3/5 en la misma instancia fresca pero nunca
   elimina la revisión de un `confirmed`; un reemplazo material exige OTRA
   instancia independiente.
6. **Informe objetivo**: el padre genera `REPORT.md`, `FINDINGS-DETAIL.md` y
   `NEEDS-VALIDATION.md` y solo declara `complete` si `declareSecurityAuditComplete`
   pasa (7 artefactos, ambos validadores PASS, 6 fases y cero candidatos sin validar).

Todos los roles de la fábrica participan (Architect, Build, Implementer,
Reviewer, Tester, Reverse, Cloud Arbiter) sin cambiar el Auditor de permisos.

## 3. Perfiles, dominios y alcance

- Perfiles: `quick` (1 ola + 1 crítico), `standard` (workflow completo),
  `deep` (críticos adicionales y unidades más finas).
- Dominios oficiales: los 10 documentos companion con sección
  `When to use this file` (AI-AND-LLM, CLIENT-SIDE, CLOUD-AND-DEPLOYMENT,
  DATA-ISOLATION-AND-LIFECYCLE, DESKTOP-MOBILE-AND-LOCAL-IPC,
  MEMORY-SAFETY-AND-BINARY, PROTOCOLS-RPC-AND-MESSAGING,
  RESOURCE-EXHAUSTION-AND-AVAILABILITY, SUPPLY-CHAIN-AND-RELEASE,
  WEB-PROTOCOL-AND-AUTH).
- Alcance: `project`, `directory`, `component`, `domain`, `git-diff` con
  `scopePaths`, `domains`, `baseRef`/`headRef`. Lo que queda fuera del alcance
  se registra como `out_of_scope` y **jamás** como cubierto.
- Favoritos: antes de iniciar se exige que todos los agentes habilitados tengan
  su modelo marcado como favorito (la misma regla que en `/api/executions`).

## 4. Presupuesto, concurrencia y errores de proveedor

- Gate pre-reconocimiento: 4 llamadas de recon + críticos (quick 1;
  standard/deep 2) + al menos 1 verificador ⇒ mínimos `quick=6`,
  `standard/deep=7`. Si no alcanza, **cero invocaciones** y
  `incomplete_reason: budget_cannot_fund_reconnaissance_and_reserves`.
- Reserva atómica ANTES de cada invocación; las reservas de críticos y
  validación nunca se gastan en caza; el presupuesto jamás se supera.
- Concurrencia real limitada por `maxConcurrency` y por el runtime: las
  invocaciones de un mismo motor se serializan (no se promete paralelismo que
  el motor no da).
- Duración máxima (`maxDurationMs`) expirada ⇒ sin más gasto
  (`max_duration_exhausted` en la compuerta).
- Errores de proveedor (429/timeout/5xx…) se clasifican con
  `classifySecurityAuditProviderError` con **`autoReplay=false`**: nunca se
  reenvía un prompt automáticamente; el error real queda en
  `security_audit_invocations` y en un checkpoint, y la continuación exige
  reanudación explícita con presupuesto.
- Motivos oficiales de `incomplete`: `budget_cannot_fund_reconnaissance_and_reserves`,
  `budget_cannot_reserve_critics_and_validation`, `critic_budget_exhausted`,
  `validation_budget_exhausted`. No se inventan motivos para otros fallos: el
  run queda `in_progress` con el error registrado.

## 5. Persistencia y artefactos

Tablas (índice de recuperación; **la fuente canónica son los archivos
oficiales**): `security_audit_runs`, `security_audit_units`,
`security_audit_invocations`, `security_audit_findings`,
`security_audit_checkpoints`, `security_audit_remediations`. Restricciones
CHECK: severidad solo en `confirmed`, motivo `incomplete` obligatorio ⇔
`run_status='incomplete'`, `auto_replay=0`, `verified_fixed` exige evidencia.

Artefactos (único escritor: `security-audit-artifacts.ts`):
`run-metadata.json` (antes de invocar agentes), `architecture.md`,
`coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`,
`NEEDS-VALIDATION.md`. Raíz por defecto
`~/.local/state/opencode-software-factory/security-audits/` (respeta
`FACTORY_STATE_DIR`), directorios 0700, ficheros 0600, escritura atómica sin
seguir symlinks y salida siempre fuera del target (ni su `.git` ni entradas
sensibles del home).

El ledger se valida con el validador oficial tras el seed y tras cada
actualización; `findings.json` tras cada escritura o reemplazo. Si el
validador no devuelve PASS, no se publica el archivo.

## 6. Reanudación y cancelación

- La cancelación es persistente (`cancel_requested`) y reutiliza
  `cancelExecution` de las ejecuciones tradicionales.
- La reanudación es explícita (`resumeRunId`): no repite fases con checkpoint
  `complete`, no reutiliza `instance_id` ni sesiones, y restaura el presupuesto
  desde la evidencia persistida.
- `recoverExecutionState()` sigue marcando ejecuciones interrumpidas al
  arrancar el servicio.

## 7. Permisos, Auditor y red

- Todas las instancias de auditoría son `read-only` en ambos motores:
  OpenCode recibe las reglas de `buildOpenCodePermissionRules("read-only")` y
  Claude recibe `disallowedTools` + guard `PreToolUse`. No se otorga
  `workspace-write` a Implementer/Tester en esta modalidad.
- La skill `security-audit` está disponible en ambos motores (plugin local
  `factory-skills` en Claude).
- El Auditor de permisos, sus bloqueos y las decisiones humanas siguen
  activos: ninguna aprobación relaja estos controles.
- **Red de proveedores IA vs red del target**: la red de los proveedores IA
  pertenece a la orquestación y queda FUERA de cualquier sandbox; la red del
  target se denega dentro de la sandbox (`--unshare-net`).

## 8. Sandbox: source-only y bloqueos exactos

- Política por defecto y ÚNICA implementada: `source-only` (solo lectura de
  fuente; no se ejecuta código del target). La política
  `sandboxed-source-and-local-only` NO tiene ejecución implementada: se
  rechaza siempre con el error `sandbox_not_implemented` en las opciones de
  arranque, en el orquestador y en `run-metadata.json`, AUNQUE la autorización
  sandbox aparente válida (controles base cumplidos, aislamiento `partial` y
  solo bloqueadores de degradación). No hay fallback silencioso ni metadata
  sandboxed; el módulo `security-audit-sandbox.ts` queda como limitación
  documentada sin llamador productivo.
- La sonda de Bubblewrap solo ejecuta `bwrap --version` y `/bin/true` aislado;
  nada del target.
- Bloqueadores exactos que hoy desactivan la promoción dinámica:
  - `disk_limit_unavailable`: el uso total de disco no puede garantizarse con
    Bubblewrap ⇒ `dynamicPromotion: "disabled"`.
  - `promotion_dirfd_unavailable`: Node no expone `openat` por dirfd sin
    carrera ⇒ `promoteSecurityAuditArtifact` devuelve `promotion_blocked` y
    **no copia**.
- Nunca se afirma aislamiento total: `isolationClaim` es `partial` o `none`.
- No se usan Podman/Docker: no añaden garantía sobre estos controles.

## 9. Hallazgos y validadores

- Veredictos oficiales `confirmed | needs_validation | rejected`; severidad
  solo en `confirmed`; deduplicación por fingerprint.
- Los prompts de fase 3/5 reciben solo el candidato/registro y la arquitectura
  necesaria: sin conclusiones de otros verificadores ni razonamiento del
  hunter, y con cabecera anti-inyección (el código y las salidas de
  herramientas son datos).
- Salidas estructuradas acotadas (<40 000 caracteres): truncadas o malformadas
  se descartan **sin repararlas**.
- Validadores oficiales ejecutados mediante `security-audit-upstream.ts`:
  `spawnSync(process.execPath, …)`, sin shell, entorno vacío, timeout y límite
  de salida, con rutas confinadas al directorio de la skill y a la corrida.

## 10. Remediación

- La remediación es una **ejecución tradicional independiente** iniciada desde
  `POST /api/security-audit/runs/:runId/remediations` con
  `approved: true`, exigiendo hallazgos `confirmed` explícitos y un equipo
  coherente con el plan real del planificador (Architect, Implementer,
  Reviewer, Tester, Build y Cloud Arbiter según el alcance). El vínculo
  `securityRemediation {auditRunId, fingerprints}` queda en el
  `configurationSnapshot` de la ejecución (consultado con `json_extract`).
- La auditoría jamás modifica el target.
- El estado `verified_fixed` solo se alcanza enviando `verificationAuditRunId`
  de otra corrida completa del mismo proyecto con ambos validadores PASS, el
  fingerprint en `rejected` y evidencia `phase5` exitosa; la evidencia se
  deriva de ese run. Sin eso el servidor responde 409 y conserva el estado.
  Una ejecución exitosa deja la remediación en `in_progress`.

## 11. Ejemplos

```sh
# Clasificar sin crear nada
curl -sX POST http://127.0.0.1:4141/api/security-audit/intent \
  -H 'Content-Type: application/json' -d '{"text":"¿qué es una vulnerabilidad de inyección?"}'

# Iniciar una auditoría (tras preconsulta y equipo guardados)
curl -sX POST http://127.0.0.1:4141/api/security-audit/runs \
  -H 'Content-Type: application/json' \
  -d '{"path":"/ruta/absoluta/del/proyecto","profile":"standard","scope":{"kind":"project"},"preflightDepth":"focused"}'

# Estado, validación y descarga
curl -s http://127.0.0.1:4141/api/security-audit/runs/<runId>
curl -sX POST http://127.0.0.1:4141/api/security-audit/runs/<runId>/validate
curl -sOJ http://127.0.0.1:4141/api/security-audit/runs/<runId>/reports/REPORT.md
```

## 12. Limitaciones

- Sin corrida end-to-end real con motores de pago hasta la fecha: el adaptador
  productivo está verificado por typecheck y revisión de contrato.
- El `missing_units` de un crítico frena la caza (fail-closed) pero todavía no
  genera unidades nuevas.
- La remediación no tiene ciclo automático de verificación: la revalidación es
  un paso explícito con evidencia.
- El sandbox con Bubblewrap no tiene llamador productivo todavía: la política
  `sandboxed-source-and-local-only` se rechaza en el arranque
  (`sandbox_not_implemented`) y el backend es source-only.
