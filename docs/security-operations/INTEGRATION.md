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


## 8. Estabilización del orquestador y consumo — 26 de noviembre de 2026

La consolidación automática exige una hipótesis original completa idéntica
(salvo fingerprint), ubicación concreta autorizada, frontera, alcance y clase.
Las coincidencias de slugs, directorios o categorías sin registros originales
no se fusionan. Las aliases conservan su estado candidato hasta que la
validación final de la canónica y el validador oficial sean satisfactorios;
un rechazo sin registro válido, una validación fallida o un registro canónico
needs_validation no acreditan la cobertura de la alias.

La reserva de caza de cada ola se materializa inmediatamente antes de cada
invocación. Se procesan lotes acotados por la concurrencia y el saldo disponible,
se incorpora su evidencia y se protege la reserva de validación antes del
siguiente lote. Quick conserva una sola ola lógica y el crítico obligatorio;
no se amplía el presupuesto. El caso de regresión de nueve invocaciones
con tres candidatos nuevos reserva las tres validaciones y conserva como
pendiente la cobertura que no pudo cazarse.

Los contadores de OpenCode se obtienen de la base local en modo de solo lectura,
por sesión de invocación, proveedor/modelo y ventana temporal. Los resultados
oficiales del SDK Claude pueden persistir métricas numéricas asociadas a la
instancia y sesión exactas. La ausencia de datos se representa como null,
no como cero. Las métricas no constituyen facturación ni cuota restante,
no exponen contenido de mensajes y no condicionan el resultado de auditoría.

Regresión: 539 pruebas API, 19 Node.js, 25 Python, validadores e integridad
oficiales, compilación y navegador real. Se conservan 50 ejecuciones y dos
runs de auditoría históricos, así como los siete modelos asignados.

P1: prueba aislada real de OpenCode 2.1.4 con una sesión GLM-5.3 Flash y un
único prompt sobre el laboratorio. Registro de agentes, conexión exclusiva
factory_filesystem, lectura stdio de fuente y rechazo de traversal: PASS.
Acceso directo de la herramienta por el modelo: FAIL (respuesta BLOQUEADO,
sin llamada de herramienta). codemode:false en la configuración temporal
no basta para certificar su exposición efectiva. No se habilita execute ni
se cambian las políticas de permisos para simular un resultado positivo.
Se requiere resolver y verificar esta incompatibilidad antes de autorizar
otra auditoría real. No hubo nueva auditoría ni remediación en esta revisión.

### Preparación de revalidación focalizada (27-11-2026)

La revisión de un hallazgo corregido no es una auditoría completa ni puede declarar cobertura de otras unidades. El endpoint GET `/api/security-audit/runs/:runId/remediations/:fingerprint/verification-plan` deriva el plan del registro confirmado activo, de la ejecución vinculada terminal y de los artefactos originales que superan ambos validadores oficiales. Comprueba identidad del registro, metadata y captura original; limita el alcance a los archivos concretos de traza/evidencia (máximo 16), exige rutas canónicas regulares y cambio SHA-256 de la ruta original del sink (o primera entrada de traza si no hay sink). No inventa ni reutiliza evidencia actual. Requiere Reviewer y Build habilitados con motores distintos y modelos favoritos. El presupuesto previsto es exactamente 2 invocaciones secuenciales, 10 minutos, source-only. La respuesta es una preconsulta, `executable:false`; no crea runs, consume cuota, modifica el target ni cambia la remediación. El formulario muestra explícitamente esta limitación y conserva la ruta tradicional de revalidación por run completo.

Validación de esta etapa: 598 pruebas automatizadas (554 API + 19 Node + 25 Python), compilación y prueba real Playwright sobre el hallazgo del laboratorio. La fuente original y la corregida tienen hashes diferentes; cuatro archivos concretos y los dos motores se seleccionaron sin invocaciones de inferencia. Se conservaron las 53 ejecuciones históricas. El ejecutor focalizado y su cierre con evidencia de dos sesiones independientes NO están habilitados aún. Al implementarlos deben recalcular la preconsulta en el servidor, comprobar la identidad del código antes/después, persistir evidencia por fingerprint y no declarar complete de una auditoría de seis fases si dichas fases no se realizaron. No se reduce el requisito de `verified_fixed` de la vía tradicional.

### Núcleo de ejecución focalizada (27-11-2026)

`security-audit-focused-runner.ts` implementa un kernel separado e inyectable de exactamente dos verificadores secuenciales, sin replay, con presupuesto cerrado y señal de cancelación. Verifica huella del registro original, alcance, hashes de fuente antes y después de cada llamada, identidades distintas y resultados estructurados. El padre coteja citas literales y ubicaciones de traza/evidencia con los archivos reales acotados (2 MiB/archivo y 8 MiB total), y ejecuta el validador oficial sobre cada registro en un directorio temporal privado externo al proyecto. Una respuesta fixed exige rejected oficial, mismo fingerprint, evidencia en todos los archivos seleccionados y consenso de ambos motores; los desacuerdos, errores, cambios de fuente o identidades repetidas nunca acreditan la corrección. Los resultados del kernel son `evidence_ready`, `still_present`, `incomplete` o `cancelled`, NO `verified_fixed`. No se declara cobertura de auditoría completa. Se validó con ocho pruebas específicas de adaptador simulado y validadores reales, y una comprobación de admisión contra la captura real del laboratorio detenida deliberadamente antes de inferencia. Regresión completa: 606 pruebas (562 API + 19 Node + 25 Python), compilación y servicio coincidente. No se consumió cuota ni se modificó el laboratorio. Falta conectar el adaptador productivo que aplique realmente los permisos por ruta, sesiones nuevas y cancelación efectiva, persistir recibos y resultados de forma transaccional, y habilitar el flujo HTTP/UI. La preconsulta continúa `executable:false`; las verificaciones simuladas no son evidencia de una corrección real. Los hashes y citas no sustituyen la revisión semántica ni un sandbox: no hay ejecución de código del target en este flujo.

### Aislamiento focalizado y persistencia de evidencias (27-11-2026)

El MCP admite una lista cerrada de 1–16 archivos mediante argumento de lanzamiento `--focused-paths-json`, nunca mediante argumentos de herramientas. Valida rutas y tipos al arrancar, impide leer rutas hermanas y limita listados/búsquedas a los archivos y directorios ancestros estrictamente necesarios; JUnit queda deshabilitado. Los dos constructores de configuración de motores admiten este parámetro opcional. Sin él, se conserva el flujo normal de cuatro herramientas. Se comprobaron los dos comandos de lanzamiento reales mediante protocolo stdio sobre el laboratorio, sin invocar modelos. Este control del MCP no es un sandbox del motor: el futuro adaptador debe además denegar todas las herramientas nativas, otros MCP y delegación en revalidación focalizada.

Se añadieron `security_audit_focused_runs` y `security_audit_focused_attempts`, independientes de la auditoría completa. El ledger exige el vínculo del plan con una ejecución en cola, cobra cada intento antes de invocar, limita a dos y bloquea una segunda llamada sin recibo aceptado de la primera. Vincula motor/modelo/sesión al registro `execution_agents` y conserva los hashes del resultado y del recibo. El consenso se comprueba frente a las evidencias persistidas; interrupciones terminales se reconcilian al recuperar el servicio, sin reintentos ni recibos inventados. No hay endpoint público de escritura, ni transición a `verified_fixed` en este ledger. La preconsulta sigue `executable:false`: falta el adaptador productivo, el control efectivo de herramientas del motor, la cancelación real y el cierre transaccional, seguidos de certificación en vivo.

Validación: 617 pruebas (570 API + 22 Node + 25 Python), compilación, prueba de migración sobre copia de la base real con las 13 tablas originales idénticas, dos tablas nuevas vacías, verificación de integridad de SQLite y procedencia Cloudflare, y prueba de navegador real sin errores. Servicio actualizado, 53 ejecuciones anteriores y 7 asignaciones conservadas. Cero invocaciones de modelos. Las pruebas de persistencia utilizan sesiones simuladas claramente limitadas a fixtures; no son verificaciones reales de vulnerabilidades.

### Ejecución focalizada productiva y evidencia nativa (27-11-2026)

El formulario permite preparar y ejecutar la revalidación focalizada con un hash de plan recalculado en el servidor. El ejecutor comparte la exclusión de ejecución tradicional, crea sesiones nuevas e independientes, limita a dos intentos y usa un MCP de tres herramientas con rutas cerradas; Claude se inicia en cwd privado sin plugins ni herramientas nativas, y OpenCode usa permisos exactos de solo lectura sin skills. La cancelación se propaga a los controladores y al interrupt de OpenCode; no hay reintento automático. No es una auditoría de seis fases. La publicación `verified_fixed` exige consenso, recibos y sesiones vinculados, registro original intacto y una preconsulta fresca del mismo snapshot; se conserva la auditoría original.

Prueba real desde el formulario: ejecución `df88974c-d6f0-4b96-93df-2e97702933e5`, Revisor Claude DeepSeek Flash y Build OpenCode MiMo Flash, dos invocaciones, cero permisos manuales. Ambos respondieron fixed y leyeron los cuatro archivos autorizados. El primer recibo pasó el validador; el segundo quedó sin recibo por `record_location_not_checked` (referencias de lines 7, 8 y 12 sin cita duplicada en source_checks). El estado histórico queda incomplete y la remediación in_progress. El diagnóstico posterior, de solo lectura, recuperó la salida exacta de la sesión OpenCode y verificó su SHA-256: las tres líneas estaban en los resultados reales read_file y coincidían con la captura actual; el registro pasó el validador oficial sin inferencia adicional. El nuevo contrato registra el origen model_quote o native_read y hash de línea, únicamente de las ubicaciones seleccionadas por el modelo y devueltas por el MCP. Persiste evidencia nativa con hash y exige correspondencia en el cierre; nunca convierte retrospectivamente el run fallido en éxito. El consumo observado para Build fue 7806 tokens de entrada, 1496 de salida, 0 de razonamiento, 6144 de lectura de caché y 0 de escritura; no se capturó aquí el contador Claude.

Regresión final: 623 pruebas (576 API + 22 Node + 25 Python), compilación, procedencia Cloudflare, migración aditiva sobre copia real de 15 tablas, servicio actualizado, navegador real sin errores y 54 ejecuciones históricas conservadas. No se modificaron asignaciones ni el laboratorio durante esta etapa. El botón está habilitado; todavía falta una nueva ejecución real con la corrección final y una auditoría completa certificada, más el merge a master. No se ejecutó otra llamada de modelo tras la primera corrida de dos invocaciones.
