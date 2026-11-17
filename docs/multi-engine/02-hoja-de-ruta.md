# Hoja de ruta — Factory Control Center

Estado actualizado: 17 de noviembre de 2026.

La documentación inicial de diseño y los registros de bloqueos se conservan como historial. El estado operativo vigente está descrito en control-center/README.md y docs/GUIA-USUARIO-CONTROL-CENTER.md.

## Principios de ejecución

- Incrementos pequeños, ejecutables y reversibles.
- No alterar la instalación CLI existente ni la configuración global del usuario.
- No mover ni renombrar los siete agentes, Skills o comandos sin pruebas de equivalencia.
- No modificar proyectos consumidores durante el mantenimiento de la fábrica.
- Cada fase incluye pruebas y evidencia; ningún resultado se declara por intuición.
- Una aprobación temporal nunca se convierte en autorización global.

## Fase 0 — Auditoría y decisiones

**COMPLETADA**

- [x] Auditar estructura, agentes, Skills, configuración MCP e instalador.
- [x] Comprobar estado Git y preservar el trabajo local preexistente.
- [x] Ejecutar verificaciones estructurales.
- [x] Documentar arquitectura, límites y opciones tecnológicas.

## Fase 1 — Núcleo y catálogo

**IMPLEMENTADA**

- [x] Contratos TypeScript para motores, modelos, agentes, ejecuciones, mensajes, decisiones y eventos.
- [x] Detección de OpenCode y Claude Code.
- [x] Descubrimiento y validación de modelos favoritos por motor/proveedor.
- [x] Lectura de los siete agentes, Skills, comandos y activos de la fábrica.
- [x] Validación que impide asignar modelos que no estén en los favoritos/catálogos correspondientes.
- [x] Persistencia local SQLite de preferencias, asignaciones, hilos, rondas, eventos y decisiones.

## Fase 2 — Adaptadores y ejecución controlada

**IMPLEMENTADA CON VALIDACIÓN OPERATIVA PENDIENTE**

- [x] Adaptador OpenCode con servidor local aislado, catálogo de agentes, sesiones, eventos y cancelación.
- [x] Adaptador Claude Code basado en Claude Agent SDK.
- [x] Modelo y motor independientes por agente.
- [x] Perfiles de permisos y solicitudes de aprobación humana.
- [x] Comprobación de que OpenCode haya registrado los siete agentes con sus modos esperados antes de crear sesiones.
- [x] MCP de archivos local, de solo lectura, limitado al proyecto.
- [x] Timeouts, cancelación y registro de errores.
- [x] Pruebas automatizadas para los límites principales.
- [ ] Repetir prueba operativa bidireccional Claude ↔ OpenCode después del endurecimiento de permisos.

## Fase 3 — Orquestador y colaboración

**IMPLEMENTADA CON VALIDACIÓN BIDIRECCIONAL PARCIAL**

- [x] Planner que inspecciona el proyecto y clasifica complejidad/profundidad.
- [x] Preconsulta obligatoria del proyecto.
- [x] Propuesta de equipo/modelos basada exclusivamente en favoritos.
- [x] Decisión entre aceptar la recomendación y configuración manual.
- [x] Guardado obligatorio del equipo antes de iniciar.
- [x] Hilos de trabajo persistentes, mensajes, rondas y contexto de continuidad.
- [x] Handoffs estructurados, IDs, hashes, longitudes, recepción y evidencia de utilización.
- [x] Revisión cruzada y Cloud Arbiter como fase de consolidación.
- [x] Ledger de decisiones/aprobaciones y eventos completo.
- [x] Reserva atómica de decisiones para impedir doble respuesta.
- [x] Aislamiento de autorizaciones temporales por ejecución de agente y recurso concreto.
- [ ] Acreditar ambas direcciones de handoff en una sola prueba end-to-end posterior a las correcciones recientes.
- [ ] Incorporar controles explícitos para el presupuesto total de rondas, tokens/coste y tiempo, si los proveedores exponen esos datos.

### Evidencia de la Ronda 4 — 17 de noviembre de 2026

La ronda real de sandbox terminó con los siete agentes en estado succeeded, 18 handoffs y solapamiento temporal entre motores. Los siete informes llegaron y pasaron la comprobación de integridad. Sin embargo, el veredicto fue observations: el Árbitro no acreditó Claude → OpenCode, aunque sí OpenCode → Claude. También detectó dos autorizaciones con patrones más amplios de lo solicitado (edit: * y rm * ) y desviaciones fuera del sandbox para herramientas temporales/JDK.

Estas evidencias motivaron el endurecimiento posterior: recursos concretos para autorizaciones temporales, aislamiento por agentRunId, reserva atómica de decisiones, reconciliación de estados del motor y pruebas de regresión. No se debe presentar la Ronda 4 como prueba bidireccional aprobada: sus propios datos dicen lo contrario.

## Fase 4 — Interfaz de usuario

**IMPLEMENTADA**

- [x] Dashboard local con motores, proyecto, configuración y estado de ejecución.
- [x] Selector independiente de motor/modelo/perfil por agente.
- [x] Configuración manual y recomendación automática.
- [x] Consola de actividad y estado de especialistas.
- [x] Centro de decisiones humanas.
- [x] Resumen de ejecución y continuidad de trabajo.
- [x] Advertencia de build cuando el runtime no coincide con el artefacto en disco.
- [ ] Mejorar visualización de diffs previos a integración cuando exista un flujo de worktrees.

## Fase 5 — Aislamiento de cambios y calidad

**PARCIAL**

- [x] Perfiles de permisos aplicados por motor.
- [x] Bloqueo de rutas sensibles, traversal y symlinks.
- [x] MCP de lectura con límites de tamaño/profundidad y apertura sin seguir symlinks.
- [x] Autorización de escritura/shell bajo los perfiles correspondientes.
- [x] Cancelación de sesiones y exclusión de ejecuciones simultáneas.
- [x] Verificación automatizada integral y despliegue con fingerprint.
- [x] Instalador reversible con manifiesto y protección frente a conflictos.
- [x] Pruebas del instalador, del verificador de agentes y de las herramientas MCP.
- [ ] Git Worktrees por ejecución/agente para aislar cambios y poder comparar diffs antes de integrar.
- [ ] Asegurar integración de cambios únicamente después de revisión y autorización.
- [ ] Pruebas de recuperación ante caída real de proceso/proveedor y reinicio durante una decisión pendiente.
- [ ] Prueba completa con los dos motores que acredite ambas direcciones de handoff después de los cambios recientes.

## Nueva línea base de calidad y despliegue

- [x] 90 pruebas automatizadas en la suite del Control Center (77 de API y 13 auxiliares).
- [x] 11 pruebas Python para límites anti-symlink, contratos de permisos y precedencia efectiva de reglas por agente.
- [x] Typecheck API y frontend.
- [x] Self-test del instalador.
- [x] Verificación del registro real de los siete agentes OpenCode sin llamadas a modelos.
- [x] Verificación estática de los permisos de los siete agentes: Build solo delega en especialistas nombrados; los perfiles de análisis bloquean edición/shell; Tester no edita; Implementer bloquea comandos peligrosos.
- [x] Auditoría npm obligatoria: producción debe tener cero vulnerabilidades; solo se permite la excepción temporal identificada para picomatch en desarrollo.
- [x] Build fingerprint SHA-256 de código/configuración/activos operativos.
- [x] Despliegue de un solo comando que verifica, compila, reinicia systemd y confirma el fingerprint activo.
- [x] Advertencia de runtime desfasado en el endpoint de salud y en la interfaz.

## Próxima prioridad

1. Desplegar el último endurecimiento y comprobar el endpoint real de salud, los permisos SQLite y la protección de origen desde HTTP.
2. Ejecutar una nueva ronda controlada de dos motores en sandbox y exigir evidencia Claude → OpenCode y OpenCode → Claude.
3. Verificar que todas las aprobaciones temporales se serializan con recurso exacto y que un agente no hereda permisos de otro.
4. Diseñar e implementar el aislamiento por worktree para proyectos que ya tengan Git, sin inicializar Git en carpetas que no lo tengan.
5. Añadir escenarios de recuperación real para caída/cancelación/reinicio y decisiones ambiguas del proveedor.
