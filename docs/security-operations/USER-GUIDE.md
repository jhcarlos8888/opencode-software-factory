# Guía de uso — Security Operations

Documento propio de este repositorio. Describe el uso de la modalidad
`security-audit` desde el Control Center, por API y con el comando nativo.

## 1. Idea general

- **Guidance por defecto**: preguntar o clasificar una petición de seguridad
  no crea directorios, archivos ni corridas.
- **Auditoría completa solo explícita**: se inicia desde la sección
  `SECURITY OPERATIONS / Auditoría de ciberseguridad` (o desde su endpoint),
  nunca por efecto secundario de una conversación.
- **Remediación separada**: las correcciones se ejecutan en una ejecución
  tradicional independiente, con confirmación humana.

## 2. Preparación (igual que para una ejecución normal)

1. Selecciona el proyecto en **Proyectos**.
2. Ejecuta la preconsulta y acepta la propuesta automática o registra la
   configuración manual.
3. Guarda el equipo en **Equipo de agentes** y marca como favorito el modelo
   de cada agente habilitado.
4. La primera auditoría consume la preconsulta; para la siguiente vuelve a
   ejecutarla (mismo criterio que en `Centro de operaciones`).

Roles que la auditoría necesita habilitados: Architect y Reverse (siempre),
Reviewer o Build, Build o Tester, y Cloud Arbiter (salvo en `quick`).

## 3. Clasificar una petición

En el panel **1 · Intención** escribe la petición y pulsa **Clasificar**:

- `guidance` → `Crea artefactos: no`, `Plan de seis fases: no`.
- `full_audit` → el plan existe, pero nada se inicia hasta pulsar **Iniciar auditoría**.
- `remediation` → se resuelve desde el panel de remediación, no aquí.
- `requiresClarification: sí` → la petición es ambigua; pide una aclaración.

## 4. Iniciar una auditoría

Panel **2 · Configuración de la auditoría**:

| Control | Valores |
| --- | --- |
| Perfil | `quick`, `standard`, `deep` |
| Alcance | `project`, `directory`, `component`, `domain`, `git-diff` |
| Rutas | una por línea (obligatorio en `directory`/`component`) |
| Dominios | los 10 companion oficiales (obligatorio en `domain`) |
| Referencias | `baseRef` y `headRef` distintos (obligatorio en `git-diff`) |
| Presupuesto | invocaciones máximas (vacío = sin tope) |
| Concurrencia | enteros ≥ 1 |
| Tiempo | minutos (se envía en milisegundos) |

Si el proyecto, la preconsulta, el equipo o los favoritos no están listos, el
botón se bloquea y el motivo aparece en español. Un error de validación
(p. ej. `../etc` en las rutas) se muestra sin iniciar nada.

## 5. Seguir la corrida

Panel **3 · Historial** lista las corridas reales del proyecto. Al seleccionar
una, el panel **4 · Estado** muestra:

- Las seis fases con su estado y el porcentaje de progreso.
- Presupuesto: máximo, concurrencia, tiempo, gastado y reservado.
- Cobertura: unidades por estado, pendientes y diferidas.
- Validadores oficiales (`coverage-ledger` y `findings`) y estado del sandbox.
- Bloqueos (motivo oficial `incomplete`, cancelación, validadores en FAIL…).
- Hallazgos: confirmados por severidad, `needs_validation` y `rejected`.
- Invocaciones reales: fase, rol, agente, motor, modelo, sesión, estado,
  verificación cruzada e inicio.
- Acciones: **Reanudar**, **Cancelar**, **Validar artefactos** y descargas
  (`run-metadata.json`, `architecture.md`, `coverage-ledger.json`,
  `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`).

El estado se refresca solo mientras la corrida está activa y el sondeo se
detiene al cancelar o terminar.

## 6. Remediar un hallazgo confirmado

1. En el panel de estado marca los hallazgos **confirmados** que quieras
   corregir.
2. Pulsa **Remediar seleccionados** y confirma el diálogo: se creará una
   ejecución **independiente** con los permisos normales y el equipo que el
   planificador recomienda para esas instrucciones (Architect, Implementer,
   Reviewer, Tester, Build y Cloud Arbiter según el alcance). La ruta debe
   coincidir exactamente con la de la auditoría.
3. El resultado queda registrado en `security_audit_remediations` como
   `in_progress`. La auditoría no modifica el target. La remediación reutiliza
   la preconsulta ya consumida por la auditoría: `approved: true` actúa como
   nueva autorización explícita y, antes de iniciar, se revalidan ruta
   canónica, profundidad real (`researchDepth` del proyecto), equipo y
   favoritos. Las ejecuciones y auditorías normales mantienen todos sus
   controles.
4. `verified_fixed` solo se alcanza con `POST …/remediations/:fingerprint/revalidate`
   enviando `verificationAuditRunId` de **otra** corrida de auditoría del mismo
   proyecto que esté `complete`, con ambos validadores PASS, el fingerprint con
   veredicto `rejected` y evidencia `phase5` exitosa; la evidencia guardada se
   deriva de ese run. Sin eso, el servidor responde 409 y el estado no cambia.
   Una ejecución exitosa **no** equivale a `verified_fixed`.

## 7. Comando nativo

```
/auditoria-seguridad ¿qué debo revisar antes de publicar este servicio?
```

Usa el agente Reviewer con la skill `@security-audit`: guidance por defecto,
sin escritura en el target y sin arrancar las seis fases; si pides la
auditoría completa te indicará iniciarla desde Security Operations.

## 8. Errores frecuentes (en español)

| Mensaje | Qué hacer |
| --- | --- |
| `La ruta o profundidad no coinciden con una preconsulta vigente…` | Ejecuta de nuevo la preconsulta. |
| `Esta preconsulta ya fue utilizada…` | Nueva preconsulta para otra auditoría inicial. |
| `…no está marcado como favorito` | Marca el modelo del agente como favorito. |
| `El equipo habilitado no cubre los roles de la auditoría…` | Habilita los roles indicados y guarda. |
| `El presupuesto no cubre reconimiento y reservas…` | Sube el presupuesto, reduce el alcance o cambia a `quick`. |
| `El validador oficial … rechazó…` | Revisa el detalle y vuelve a pulsar **Validar artefactos**. |
