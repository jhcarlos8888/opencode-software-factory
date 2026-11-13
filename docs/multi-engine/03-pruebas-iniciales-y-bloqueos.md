
# Pruebas de integración iniciales — 2026-11-13

## Aplicación local

- Servicio systemd de usuario: `factory-control-center.service`, habilitado y activo.
- URL: `http://127.0.0.1:4141/`.
- El servicio utiliza un symlink local sin espacios hacia la carpeta original, para que systemd pueda resolver correctamente el proyecto.
- Health, interfaz y assets estáticos responden HTTP 200.
- Catálogo OpenCode: 112 modelos en el momento de la prueba; catálogo Claude: tres alias (sonnet, opus, haiku).
- Los siete agentes, diez Skills y siete asignaciones se leen desde la fábrica original.

## Autenticación y llamadas reales

La detección de un CLI y la presencia de credenciales no demuestran que un modelo pueda responder.

### Claude Code

- `claude auth status` informa sesión OAuth, pero el archivo local `~/.claude/settings.json` define `ANTHROPIC_BASE_URL=https://api.apmix.ai`, `ANTHROPIC_MODEL=tencent/hy4-free` y un token (no documentar ni copiar el valor del token).
- Prueba con alias `haiku`: el gateway respondió HTTP 403 indicando que el modelo Claude Sonnet 5.5 requiere un plan superior.
- Prueba temporal con `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4.1-flash-1017-free`: Claude Code SDK rechazó el identificador como `unrecognized_model`.
- Prueba temporal con `--model tencent/hy4-free`: también `unrecognized_model`.
- No se modificó `~/.claude/settings.json` ni se imprimió el token.
- Conclusión: hay que definir qué proveedor y modelos compatibles se desean para Claude Code. No asumir que cualquier ID OpenAI-compatible o de APMix es aceptado por el SDK de Claude Code.

### OpenCode

- `opencode auth list` muestra credenciales almacenadas para Nvidia y OpenCode Console; no se exportaron secretos.
- El servidor local OpenCode ya existente escucha en 127.0.0.1:49374 y exige `OPENCODE_PASSWORD`; no se intentó extraer ni mostrar ese secreto.
- La prueba contra ese servidor falló por autenticación HTTP.
- La prueba aislada `opencode run --standalone` quedó sin respuesta durante el arranque/ejecución y se terminó sin alterar el proyecto.
- El servicio Zen Proxy local responde a `/v1/models`, pero la petición de chat de prueba no devolvió respuesta dentro del límite aplicado y se canceló.
- Conclusión: todavía no hay una prueba de generación satisfactoria de OpenCode. Investigar la autenticación del servidor o implementar un adaptador aislado y sin MCP innecesarios.

## Decisiones para el siguiente desarrollo

1. No mostrar "conectado" cuando solo se detecta el ejecutable. Separar estados: CLI instalado, credenciales detectadas, proveedor/modelo validado y última prueba.
2. Consultar modelos reales por motor/proveedor y validar el modelo antes de guardar la asignación.
3. Añadir un botón de prueba que envíe un prompt mínimo, sin herramientas, sin acceso a archivos y con límite de tiempo/coste cuando el proveedor lo permita.
4. Para Claude Code, resolver el conflicto de APMix/model IDs con el usuario antes de cambiar sus ajustes.
5. Para OpenCode, diseñar el adaptador con un contrato interno y no depender de un password de un servidor externo sin autorización explícita.
6. Mantener la primera ronda de ejecución de agentes en modo lectura; los perfiles de permisos de la UI aún son solo configuración persistida y no una barrera aplicada.
