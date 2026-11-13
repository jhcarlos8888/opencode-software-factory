# Planificador inteligente de tareas

## Primera iteración

El planificador separa dos dimensiones que no deben confundirse:

- **Complejidad del proyecto:** heurística estructural existente (archivos, manifiestos, stacks, documentos de instrucciones y estado Git).
- **Complejidad de la tarea:** clasificación de la instrucción concreta (explicación, diagnóstico, implementación, pruebas, revisión arquitectónica o general).

La clasificación se realiza localmente mediante reglas deterministas, sin enviar instrucciones a un modelo adicional ni consumir créditos durante la preconsulta.

## Profundidad y equipo

| Profundidad | Uso |
|---|---|
| Rápida | Resúmenes y explicaciones; documentación y archivos representativos |
| Focalizada | Diagnóstico o cambio acotado; módulo y dependencias directas |
| Profunda | Auditorías, arquitectura amplia o cambios de alcance general |

La preconsulta propone agentes y modelos tomados exclusivamente de favoritos. Antes de aceptar, el usuario puede cambiar la profundidad y activar o desactivar cualquier especialista. La propuesta habilita únicamente los agentes recomendados por defecto; los demás quedan desactivados, pero pueden habilitarse manualmente. El usuario conserva la decisión final y debe guardar el equipo.

Los agentes no tienen un límite artificial de duración. Cada fase continúa hasta que el motor termina su trabajo o el usuario cancela explícitamente la ejecución. La profundidad (rápida, focalizada o profunda) orienta el alcance de la exploración, no establece un cronómetro ni interrumpe al agente.

## Reglas de seguridad y alcance

- Las explicaciones y diagnósticos no habilitan escritura automáticamente.
- La clasificación de implementación no modifica perfiles de permisos: el usuario debe revisar y guardar los permisos del equipo.
- La profundidad rápida orienta al agente a comenzar por README, instrucciones, manifiestos y archivos representativos; puede ampliar la exploración si la evidencia todavía no basta.
- La clasificación es heurística y debe evolucionar con pruebas de uso real. Una tarea ambigua se enruta conservadoramente al Arquitecto con investigación focalizada.
- La profundidad elegida manualmente se envía a la ejecución y prevalece sobre la profundidad sugerida automáticamente. No existe un límite de duración por agente.

## Ejecución concurrente entre motores

Cuando una ejecución incluye agentes de OpenCode y Claude Code y los agentes son de solo lectura, la fábrica ejecuta ambos grupos de motor simultáneamente. El único perfil adicional admitido en este modo es `approval-required` para el agente Tester, cuyas acciones requieren autorización humana. Dentro de cada motor se conserva el orden de sus especialistas y el contexto compartido entre ellos. Los resultados de ambos grupos se consolidan al terminar. Si hay agentes con permiso `workspace-write` u otros perfiles que puedan modificar archivos, se conserva el modo secuencial para evitar modificaciones concurrentes sobre los mismos archivos.

## Caso de regresión

Instrucción: «Quisiera que en un párrafo me explicaras de qué trata el proyecto y su arquitectura».

Resultado esperado: tipo explanation, complejidad de tarea low, profundidad quick, agente architect solamente y sin cambios. La ejecución continúa hasta que el agente complete la explicación o el usuario la cancele.
