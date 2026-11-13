# Decisión de arquitectura — Fábrica multi-motor

**Estado:** propuesta base para implementación incremental
**Fecha:** 2026-11-12

## Decisión principal

Mantener este repositorio como única fuente de la fábrica. No crear una segunda fábrica Claude ni sustituir los activos OpenCode. Añadir una aplicación local llamada provisionalmente **Factory Control Center**, que coordine motores y consuma el catálogo actual de agentes, comandos y Skills.

## Capas

1. **Activos de fábrica:** agentes, Skills, comandos, plantillas, reglas de calidad y documentación ya versionados.
2. **Registro lógico:** roles independientes del motor (arquitecto, implementador, revisor, QA, árbitro, especialista REA), requisitos de capacidad, Skills y permisos.
3. **Adaptadores de motor:** OpenCode y Claude Code. Cada uno traduce roles, instrucciones, modelos, herramientas, sesiones y permisos a su formato nativo.
4. **Orquestador:** planifica la tarea, recomienda equipo/modelos, ejecuta rondas de colaboración, conserva decisiones, gestiona límites y solicita aprobaciones.
5. **Interfaz local:** proyectos, tareas, equipo/roles, catálogo de modelos, eventos en vivo, decisiones y aprobaciones.
6. **Entorno de trabajo:** repositorios y Git Worktrees aislados; integración controlada de cambios.

## Motores y modelos

- **OpenCode:** iniciar un servidor local administrado por la aplicación con `opencode serve`; consultar su API para modelos/agentes/sesiones y consumir su flujo de eventos. El modelo se representa como `providerID/modelID`.
- **Claude Code:** integrar el Claude Agent SDK oficial para TypeScript como adaptador principal; conservar el CLI como mecanismo de diagnóstico/fallback. Cada sesión y subagente recibe su configuración `model` propia.
- Los catálogos son independientes. Nunca mostrar un ID de modelo de OpenCode como si fuera válido en Claude, ni al contrario.
- En cada agente configurable guardar: `engine`, `modelId`, `roleId`, `skills`, `permissionProfile`, `enabled`, `worktreePolicy`.
- La selección manual siempre está disponible. El modo automático genera una recomendación explicada, no la aplica sin aprobación.
- La configuración de modelos no incluye credenciales. Usar las credenciales locales de cada motor y nunca guardar tokens en Git.

## Skills e instrucciones

- Mantener las diez Skills actuales como activos fuente hasta validar una migración.
- Crear un validador de portabilidad que clasifique cada Skill: portable, requiere contexto/adaptación de motor, o exclusiva de una herramienta.
- Adaptar `project-discovery` para que describa capacidades abstractas y no asuma los nombres de herramientas de OpenCode.
- Mantener adaptadores de instrucciones/agentes: los permisos y herramientas OpenCode no se copian a Claude Code.
- La Skill externa `reverse-engineer-anything` se mantiene como tercero, con licencia y referencias intactas; su habilitación por motor se decide según disponibilidad MCP real.
- No duplicar contenido de Skills: generar/enlazar representaciones por motor desde una fuente canónica cuando el adaptador esté probado.

## Stack local inicial

- TypeScript sobre Node.js 24, coherente con el entorno disponible.
- API/orquestador: Fastify.
- Interfaz: React + Vite.
- Persistencia local: SQLite (tareas, sesiones, mensajes, asignaciones, eventos, decisiones, aprobaciones y métricas).
- Actualización en vivo: Server-Sent Events inicialmente; evaluar WebSocket solo si la interfaz lo necesita.
- Cola/event bus en proceso para la primera instalación local. Redis/PostgreSQL quedan para una fase multiusuario o multi-host, no son requisito del MVP.
- No instalar dependencias ni alterar versiones globales hasta crear el primer vertical slice y validar compatibilidad.

## Flujo de una tarea

1. Usuario elige proyecto, describe resultado esperado y selecciona modo manual o recomendación automática.
2. Discovery inspecciona stack, instrucciones, estado Git, build/tests y activos de la fábrica.
3. Planner recomienda roles, motores y modelos disponibles, con motivos, coste relativo estimado y limitaciones.
4. Usuario aprueba o ajusta equipo y permisos.
5. Orquestador crea sesiones independientes y transmite contexto mínimo, Skills pertinentes y criterios de aceptación.
6. Los agentes intercambian informes estructurados mediante el orquestador; rondas, presupuesto y tiempo tienen límites.
7. Agentes de solo lectura revisan; agentes escritores trabajan en worktrees aislados.
8. El sistema solicita aprobación para integrar cambios o ejecutar acciones sensibles.
9. QA ejecuta comandos reales; el informe conserva evidencia, diffs, costes y pendientes.

## Seguridad y concurrencia

- Denegar por defecto escritura, borrado, despliegue, instalación de dependencias y comandos sensibles; solicitar autorización según perfil.
- El agente no puede elevar sus permisos ni cambiar su propio perfil.
- Dos agentes no escriben sobre el mismo worktree simultáneamente.
- Cada tarea mantiene límites de rondas, tiempo, tokens/coste y reintentos; detectar debates repetitivos.
- Registrar cada mensaje, llamada, permiso, decisión y aprobación para trazabilidad.
- Nunca exponer servidores locales en interfaces públicas; enlazar a loopback y proteger el panel local.

## Referencias técnicas

- OpenCode server/API y eventos: https://opencode.ai/docs/api
- OpenCode server/plugins: https://opencode.ai/docs/build/plugins/server
- OpenCode catálogo y selección de modelos: https://opencode.ai/docs/models
- Claude Agent SDK: https://docs.claude.com/en/api/agent-sdk/overview
- Claude Code subagents: https://docs.claude.com/en/docs/claude-code/sub-agents
- Claude Code Skills: https://docs.claude.com/en/docs/claude-code/skills


## Precisiones de integración verificadas en documentación oficial (2026-11-12)

- OpenCode mantiene la superficie HttpApi marcada como experimental. Antes de integrar el adaptador, fijar una versión probada del CLI y encapsular el acceso detrás de un contrato propio.
- El catálogo HTTP de OpenCode `GET /api/model` está documentado como experimental. El panel 0.1 usa `opencode models` como descubrimiento del catálogo local; el adaptador futuro debe evaluar el SDK/API y manejar cambios.
- El stream `GET /api/event` también es experimental y volátil: puede perder eventos durante desconexión o desbordamiento. Guardar los eventos propios de la orquestación en SQLite y reconciliar el estado consultando las sesiones/mensajes; no tratar el stream como historial durable.
- Claude Agent SDK TypeScript define `AgentDefinition.model` para asignar un alias (por ejemplo `sonnet`, `opus`, `haiku`) o un ID completo por subagente; también admite `skills`, `tools`, `disallowedTools`, `permissionMode` y `maxTurns`.
- Claude Code permite cargar Skills desde un directorio externo añadido con `--add-dir` (el directorio contiene `.claude/skills/`). OpenCode descubre también ubicaciones de compatibilidad `.claude/skills` y `.agents/skills`, además de `.opencode/skills`.
- Por tanto, la estrategia de biblioteca compartida no debe asumir que ambos motores escanean la misma ruta. El adaptador de Claude puede exponer las Skills portables desde un directorio gestionado que contenga `.claude/skills/`; el adaptador de OpenCode podrá seguir usando las rutas actuales o el mecanismo compatible. No copiar definiciones OpenCode-specific de agentes o permisos.
- El primer panel sirve en desarrollo mediante Vite y Fastify; en producción la compilación se separa en `dist/` y `dist-api/`, y Fastify entrega ambos desde una única dirección local.

Fuentes oficiales:
- https://opencode.ai/docs/api
- https://opencode.ai/docs/skills/
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/sub-agents
