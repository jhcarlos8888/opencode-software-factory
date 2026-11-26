# Integración de Security Operations

Documento propio de este repositorio. Resume dónde se conecta la modalidad
`security-audit` con el resto de la fábrica y qué queda pendiente.

## 1. Puntos de integración

### API (`server.ts` + `security-audit-api.ts`)

`registerSecurityAuditRoutes(app, deps)` se registra una vez en `server.ts`
con las funciones reales de la fábrica (`startExecution`, `cancelExecution`,
`analyzeProject`, preconsulta, equipo, favoritos, snapshots de ejecución y la
base de datos). Rutas:

| Método | Ruta | Efecto |
| --- | --- | --- |
| POST | `/api/security-audit/intent` | Clasifica sin crear nada. |
| POST | `/api/security-audit/runs` | Inicia una auditoría explícita (admisión + contratos). |
| GET | `/api/security-audit/runs?projectPath=` | Historial real por proyecto. |
| GET | `/api/security-audit/runs/:runId` | Fases, presupuesto, invocaciones, cobertura, hallazgos, bloqueos y validadores. |
| POST | `/api/security-audit/runs/:runId/resume` | Reanudación explícita (`resumeRunId`). |
| POST | `/api/security-audit/runs/:runId/cancel` | Reutiliza `cancelExecution`. |
| POST | `/api/security-audit/runs/:runId/validate` | Ejecuta los dos validadores oficiales y persiste sus estados. |
| GET | `/api/security-audit/runs/:runId/reports/:artifact` | Descarga con allowlist y ruta confinada. |
| GET/POST | `/api/security-audit/runs/:runId/remediations` | Lista / crea remediaciones ligadas a una ejecución independiente. |
| POST | `…/remediations/:fingerprint/revalidate` | Única vía a `verified_fixed`, exige `evidence` no vacía. |

### Ejecución (`execution.ts`)

- `StartExecutionOptions.securityAudit` se valida con
  `validateSecurityAuditStartOptions` **antes** de crear registros.
- El adaptador productivo `createSecurityAuditInvoker` crea una fila
  `execution_agents` y una sesión nueva por instancia, fuerza
  `permissionProfile: "read-only"` en ambos motores y registra cada invocación
  en `security_audit_invocations` (motor, modelo, sesión, agentRunId, handoff,
  timestamps, verificación cruzada).
- La rama tradicional sigue detrás de `else { for (const wave of EXECUTION_WAVES) … }`.

### Planificador (`task-planner.ts`)

- `planTask` añade `securityOperation` (`none` | `guidance` | `full_audit` |
  `remediation`) sin alterar las intenciones tradicionales.
- Las operaciones security fuerzan `changesExpected=false` y un equipo de solo
  lectura; una consulta general no escala a seis fases ni crea archivos.
- La auditoría completa solo arranca por endpoint explícito.

### Persistencia (`database.ts` + `security-audit-persistence.ts`)

- `initializeSecurityAuditSchema(db)` se llama una vez, tras el esquema
  actual, y es idempotente sobre una base preexistente.
- `appendExecutionAgent`, `getFactoryDatabase` y
  `listSecurityAuditExecutionRunIds` (vínculo entre la ejecución original, su
  reanudación y el run de auditoría).

### UI (`SecurityOperations.tsx` + `App.tsx` + `styles.css`)

- Sección `SECURITY OPERATIONS / Auditoría de ciberseguridad` con entrada en
  la navegación (sin eliminar ni duplicar secciones existentes).
- Controles de perfil, alcance, dominios, presupuesto, concurrencia y tiempo;
  progreso de seis fases, invocaciones con motor/modelo/sesión, cobertura,
  hallazgos por severidad, historial, reanudar/cancelar/validar, descargas y
  remediación con confirmación humana.
- Sondeo real solo mientras la corrida está activa, con limpieza del temporizador.

### Comando (`.opencode/commands/auditoria-seguridad.md`)

- Agente existente (`reviewer`) con la skill `@security-audit`.
- Guidance por defecto; la auditoría completa se indica iniciar en Security
  Operations; sin escritura en el target; remediación separada.

## 2. Datos y privacidad

- Las respuestas salen de la persistencia real (runs, unidades, invocaciones,
  hallazgos y artefactos). No hay fixtures ni datos de ejemplo en respuestas
  productivas.
- Los artefactos se sirven con allowlist de siete nombres, `Cache-Control:
  no-store`, `X-Content-Type-Options: nosniff` y `Content-Disposition` con
  nombre saneado.
- El contenido escrito por la fábrica pasa por `redactSecrets`; no se lee
  ningún valor ambiental para construir artefactos.

## 3. Actualización upstream

Procedimiento completo en `UPSTREAM.md`. Resumen:

1. Detenerse: ninguna actualización automática; todo cambio requiere un commit
   upstream nuevo y revisión explícita.
2. Clonar en un directorio temporal nuevo bajo `/tmp/opencode` con detached
   HEAD en el commit elegido.
3. Revisar `git diff <actual>..<nuevo> -- skills/security-audit LICENSE`.
4. Copiar conservando bytes y permisos; sobrescribir solo lo aprobado.
5. Recalcular `provenance.json` y `provenance.sha256`.
6. Ejecutar `sha256sum -c`, las dos suites oficiales con `node --test` y
   `git diff --check`.
7. Registrar commit upstream, diff revisado y salidas reales; hacer commit
   solo tras aprobación.

## 4. Verificación

```sh
npx tsx --test src/api/security-audit-*.test.ts   # desde control-center
npm run test:orchestration
npm run typecheck
npm run build
bash scripts/verify-factory.sh
git diff --check
sha256sum -c docs/security-operations/provenance.sha256
```

## 5. Pendiente

- Corrida end-to-end real con OpenCode y Claude (ninguna ejecutada hasta la
  fecha): el adaptador está verificado por typecheck y revisión de contrato.
- Conectar `buildSecurityAuditSandboxArgv`/`probeBubblewrap` a un llamador
  productivo (hoy el backend es `source-only` y el arranque sandboxed se
  rechaza con `sandbox_not_implemented`; el módulo queda como limitación
  documentada).
- Los críticos post-ola ya incorporan unidades y reasignaciones verificadas dentro del alcance. Un crítico final con pendientes impide cerrar como complete; no inicia automáticamente otra ronda final.
- Exponer la remediación desde la UI de ejecuciones (hoy desde Security
  Operations) y automatizar la solicitud de revalidación.
- Servir `security-audit` detrás de `server.ts` ya está hecho; falta la UI de
  decisiones/actividad específica para auditorías (se reutiliza la existente).

## 6. Revisión de continuidad — 26 de noviembre de 2026

Se conservaron los cambios previos de Kimi, GLM y DeepSeek. La revisión local
reforzó el cierre incompleto, el historial de intentos, el alcance en
subdirectorios Git, la cancelación y reanudación, y la protección de los
artefactos. El puerto efectivo del servidor y las reglas HTTP usan la misma
configuración. Los directorios ilegibles, configuraciones Git con filtros
ejecutables/includes, submódulos y rutas de salida inseguras fallan de forma
explícita; no se presume cobertura.

La identidad del origen incluye una captura SHA-256 de los archivos elegibles
del alcance, con límite defensivo de 256 MiB. No se guardan sus bytes. Se
comprueba al reanudar y antes de declarar complete. La revalidación exige
una respuesta aceptada de fase 5 para el registro rechazado concreto y huellas
distintas antes/después del archivo afectado, además de las comprobaciones
de ejecución, tiempo, alcance y procedencia. Los runs antiguos sin estas
evidencias no pueden acreditar verified_fixed. Un run antiguo sin huella de
contenido y con origen dirty o no-Git exige una nueva auditoría.

Se realizaron regresiones automatizadas con invocadores de prueba, validadores
oficiales sin cambios, compilación y un arranque HTTP aislado con SQLite
temporal en un puerto alternativo: health, historial, orientación sin
artefactos y entrega de JS/CSS. No se reinició ni desplegó el servicio del
usuario. El límite de cuota de OpenCode Go impidió una corrida completa con
modelos reales; no se declara acreditada la ejecución dual real.

La modalidad continúa siendo source-only; no se presenta como aislamiento
de sistema operativo ni como validación dinámica de vulnerabilidades.


## 7. Validación del navegador y del arranque — 26 de noviembre de 2026

Playwright (Brave, sandbox habilitado) sobre el servidor compilado y SQLite
temporal: 13 comprobaciones de interfaz, preconsulta real sin LLM, perfiles
y alcances, historial, seis fases, validación oficial, descarga HTTP y
cancelación de la confirmación de remediación. Los registros sintéticos
empleados para las vistas de historial estaban identificados como fixtures y
no se insertaron en la base habitual. Render a 1440 y 390 px; se corrigió el
desbordamiento horizontal y no se observaron errores JS ni HTTP en esa suite.

Una segunda prueba inició realmente una auditoría quick sobre el laboratorio
local con un presupuesto deliberadamente insuficiente de una invocación.
La API registró el estado terminal incomplete, cero invocaciones y gasto
cero, produjo REPORT.md parcial y el repositorio objetivo quedó limpio.
El navegador actualizó el historial sin recargar y marcó consumida la
preconsulta. Se corrigió la espera asíncrona del registro de auditoría tras
el arranque de los motores y se conectó el inicio de Security Operations
con la consola general de ejecuciones. Se sigue sondeando una cancelación
hasta recibir el cierre terminal.

El laboratorio desechable `factory-demo-security-20261126` está fuera del
repositorio de la fábrica, con datos ficticios, dependencias externas cero,
sin servidor HTTP y tres pruebas de base. Se creó un commit local inicial
solo en ese laboratorio. Queda pendiente la auditoría con llamadas reales
a los modelos, la remediación y su revalidación con evidencia real.
