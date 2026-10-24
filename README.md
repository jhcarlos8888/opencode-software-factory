
# OpenCode Software Factory

Repositorio fuente de la fábrica de software multiagente.

## Objetivos

- Coordinar análisis, planificación, implementación y revisión.
- Mantener agentes, skills y comandos versionados.
- Exigir evidencia real de compilaciones y pruebas.
- Separar la infraestructura de la fábrica de los proyectos de trabajo.
- Permitir instalación y reversión controladas.

## Estructura

- `.opencode/agents/`: agentes Markdown existentes.
- `.opencode/commands/`: comandos personalizados existentes.
- `.opencode/skills/`: skills del directorio global de OpenCode.
- `.agents/skills/`: skills del directorio compatible con agentes.
- `config/global-inline-agents.snapshot.json`: instantánea de los agentes
  `build` y `reverse` definidos actualmente en la configuración global.
- `opencode.json`: configuración predeterminada de este repositorio.

## Estado de migración

Esta es una captura inicial, no un instalador.

Los agentes `build` y `reverse` siguen activos en la configuración global.
La instantánea se conserva para migrarlos de forma controlada más adelante.
No modificar ni instalar automáticamente esa instantánea.

La configuración global, los MCP y las credenciales existentes no se
modifican mediante esta captura.

## Modelo inicial

`openrouter/cohere/north-mini-code:free`

La disponibilidad y los límites dependen de OpenRouter.

## Principios de calidad

- No afirmar que una prueba pasó si no se ejecutó y se observó su salida.
- No inventar archivos, herramientas, resultados ni fuentes.
- Revisar los cambios mediante Git.
- Proteger operaciones destructivas y despliegues mediante aprobación.
- Separar hallazgos comprobados de hipótesis.

