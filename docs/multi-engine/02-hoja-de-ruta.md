# Hoja de ruta — Factory Control Center

## Principios de ejecución

- Incrementos pequeños, ejecutables y reversibles.
- No alterar la instalación CLI existente ni la configuración global del usuario.
- No mover ni renombrar los siete agentes, las Skills o los comandos existentes sin pruebas de equivalencia.
- Conservar el diff local preexistente de `scripts/factory.py`.
- Cada fase incluye pruebas y evidencia; ningún resultado se declara por intuición.

## Fase 0 — Auditoría y decisiones

- [x] Auditar estructura, agentes, Skills, configuración MCP e instalador.
- [x] Comprobar estado Git y registrar cambio local preexistente.
- [x] Ejecutar las verificaciones estructurales actuales.
- [x] Documentar arquitectura, límites y opciones tecnológicas.
- [ ] Validar la arquitectura con un primer prototipo de los dos adaptadores.

## Fase 1 — Núcleo y catálogo

- Definir contratos TypeScript para Engine, Model, AgentRole, Project, Task, Run, Message, Approval y Event.
- Implementar registro de motores y comprobación de disponibilidad.
- Descubrir modelos OpenCode desde su catálogo real y normalizarlos.
- Crear allowlist inicial de modelos Claude y validar cuáles acepta la sesión autenticada.
- Leer agentes y Skills de la fábrica; generar informe de compatibilidad por motor.
- No iniciar todavía trabajos que escriban archivos.

## Fase 2 — Adaptadores y ejecución controlada

- Adaptador OpenCode: iniciar/parar servidor local, sesiones, selección de agente/modelo, prompt y eventos.
- Adaptador Claude Code: sesiones del Agent SDK, subagentes dinámicos y modelo por subagente.
- Propagar cancelación, timeouts, errores, uso y costes disponibles.
- Añadir perfiles de permisos y pedir confirmación para acciones sensibles.
- Prueba de ida y vuelta: ambos motores analizan y responden a una misma tarea en solo lectura.

## Fase 3 — Orquestador y colaboración

- Planner que inspecciona proyecto y propone equipo/roles/modelos.
- Panel de propuesta editable antes de ejecutar.
- Mensajería estructurada entre agentes y memoria por tarea.
- Debate con límite de rondas y condición de consenso/escalamiento.
- Detección de contradicciones y cierre con recomendación fundamentada.
- Auditoría de mensajes, herramientas, decisiones y aprobaciones.

## Fase 4 — Interfaz de usuario

- Dashboard local con proyectos, estado de motores y actividad.
- Selector de motor y modelo independiente para cada agente/rol.
- Modo manual y modo recomendar equipo automáticamente.
- Vista de conversaciones/debate, timeline, costes, errores y permisos.
- Bandeja de aprobaciones y diff antes de integrar cambios.

## Fase 5 — Escritura, aislamiento y calidad

- Crear Git Worktrees por rama de trabajo/agente escritor.
- Prohibir escrituras simultáneas en el mismo worktree.
- Ejecutar build/tests con evidencia, integrar solo después de autorización.
- Revisión cruzada usando el motor/modelo independiente cuando sea conveniente.
- Probar recuperación ante caída de motor, timeout, cancelación y conflicto Git.

## Primer entregable funcional

Un panel local donde se registre un proyecto, se compruebe OpenCode y Claude Code, se visualicen catálogos separados, se asigne un modelo distinto a cada agente y ambos realicen un análisis independiente de solo lectura. No se escribirá en el proyecto consumidor en este primer entregable.


## Estado real tras el primer prototipo (0.1.0)

- [x] Aplicación local `control-center` con API Fastify y UI React/Vite.
- [x] Detección de los CLI y versiones instaladas.
- [x] Catálogo dinámico de OpenCode y catálogo de alias Claude separado.
- [x] Asignación individual de motor, modelo y perfil de permisos por agente.
- [x] Persistencia local SQLite fuera del repositorio.
- [x] Preanálisis estructural de proyecto en modo de solo lectura.
- [x] Validación para impedir que se guarde un ID de modelo de un motor en el otro.
- [ ] Sesiones reales de ambos motores y verificación de autenticación/modelos.
- [ ] Intercambio autónomo de mensajes, debate y decisiones.
- [ ] Git Worktrees y ejecución de cambios.

El preanálisis 0.1.0 detecta manifiestos, stack probable, archivos de contexto y estado Git; no equivale todavía a un análisis semántico con un modelo. La fase siguiente debe conectar los adaptadores reales y ejecutar primero tareas de solo lectura.


## Entrega del planificador (primera iteración)

La clasificación determinista, los límites por agente y el caso de regresión están documentados en [06-planificador-inteligente.md](06-planificador-inteligente.md). La selección de agentes recomendados se refleja en enabled; la propuesta sigue requiriendo aceptación y guardado explícitos.
