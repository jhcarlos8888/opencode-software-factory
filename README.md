
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

`mistral/codestral-2508`

La disponibilidad y los límites dependen del proveedor Mistral y del plan asociado.

## Principios de calidad

- No afirmar que una prueba pasó si no se ejecutó y se observó su salida.
- No inventar archivos, herramientas, resultados ni fuentes.
- Revisar los cambios mediante Git.
- Proteger operaciones destructivas y despliegues mediante aprobación.
- Separar hallazgos comprobados de hipótesis.

## Mejoras de fiabilidad y validación

### Arquitecto: planes respaldados por evidencia

El agente `architect` debe inspeccionar las instrucciones, los manifiestos,
el código y las pruebas pertinentes antes de proponer un plan. Debe distinguir
hechos verificados, inferencias y datos desconocidos; diferenciar versiones
declaradas de versiones resueltas; y no inventar rutas, dependencias,
comandos ni resultados. Su función es planificar, no modificar el repositorio.

Archivo: `.opencode/agents/architect.md`.

### Descubrimiento de proyectos

La skill `project-discovery` exige que las conclusiones sobre estructura,
stack, dependencias, pruebas y comandos se apoyen en archivos leídos o
comprobaciones ejecutadas. También exige revisar el estado de Git y respetar
los cambios preexistentes.

Archivo: `.opencode/skills/project-discovery/SKILL.md`.

### Tester: resultados reales y permisos

El agente `tester` debe informar los comandos ejecutados, sus códigos de
salida, los resultados observados y las pruebas que no se ejecutaron.
Debe diferenciar la verificación estructural de la ejecución real de las
pruebas del proyecto. La edición de archivos permanece denegada y la ejecución
de comandos de shell requiere autorización por defecto, salvo las reglas
explícitas configuradas.

Archivo: `.opencode/agents/tester.md`.

### Modelo y verificación de la fábrica

La configuración del repositorio y el script `scripts/verify-factory.sh`
usan `mistral/codestral-2508` como modelo configurado en lugar de
`openrouter/thinkingmachines/inkling:free`.

El script `bash scripts/verify-factory.sh` valida la configuración JSON,
la estructura de agentes y skills, la carga de la configuración de OpenCode
y el reconocimiento de los agentes. Esta comprobación es estructural:
no sustituye las pruebas del proyecto consumidor ni demuestra por sí sola
que las respuestas de los agentes sean correctas.

### Validaciones registradas

Según la salida observada en la sesión del 24 de octubre de 2026:

- `bash scripts/verify-factory.sh`: finalizó correctamente; todas las
  comprobaciones mostradas terminaron en `PASS`.
- `python3 scripts/factory.py self-test`: finalizó con `SELF-TEST COMPLETADO`.
  La salida confirma pruebas de instalación, preservación, reversión y
  detección de conflictos sin sobrescribir archivos diferentes.
- Estas validaciones no equivalen a ejecutar las pruebas de un proyecto Java
  ni a verificar la calidad de todas las respuestas generadas por los agentes.

### Separación entre fábrica y proyectos consumidores

La fuente mantenible de los agentes, skills, comandos, scripts y documentación
debe permanecer en este repositorio: `opencode-software-factory`.
Los proyectos consumidores son destinos de instalación y prueba, no el lugar
donde se deben desarrollar o documentar las mejoras generales de la fábrica.

Antes de instalar o sincronizar cambios en un consumidor, se debe revisar
el estado del destino y preservar sus archivos propios, su configuración
`opencode.json` y cualquier modificación ajena. No se deben eliminar archivos
sin verificar su procedencia y obtener autorización cuando exista duda.

### Pendientes

- Probar el cumplimiento de las nuevas reglas del arquitecto con resultados
  contrastados contra los archivos reales del proyecto de prueba.
- Verificar que el tester informe correctamente los códigos de salida y
  distinga las pruebas reales de las verificaciones estructurales.
- Revisar cualquier configuración sobrante del proyecto consumidor por
  separado, sin usarlo como repositorio fuente de las mejoras.
