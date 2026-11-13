# Planificador inteligente de tareas

## Primera iteración

El planificador separa dos dimensiones que no deben confundirse:

- **Complejidad del proyecto:** heurística estructural existente (archivos, manifiestos, stacks, documentos de instrucciones y estado Git).
- **Complejidad de la tarea:** clasificación de la instrucción concreta (explicación, diagnóstico, implementación, pruebas, revisión arquitectónica o general).

La clasificación se realiza localmente mediante reglas deterministas, sin enviar instrucciones a un modelo adicional ni consumir créditos durante la preconsulta.

## Profundidad y equipo

| Profundidad | Uso | Límite por agente |
|---|---|---:|
| Rápida | Resúmenes y explicaciones; documentación y archivos representativos | 2 min |
| Focalizada | Diagnóstico o cambio acotado; módulo y dependencias directas | 8 min |
| Profunda | Auditorías, arquitectura amplia o cambios de alcance general | 25 min |

La preconsulta propone agentes y modelos tomados exclusivamente de favoritos. Antes de aceptar, el usuario puede cambiar la profundidad y activar o desactivar cualquier especialista. La propuesta habilita únicamente los agentes recomendados por defecto; los demás quedan desactivados, pero pueden habilitarse manualmente. El usuario conserva la decisión final y debe guardar el equipo.

Los límites son máximos por agente, no promesas de duración total. El tiempo real depende del arranque del motor, proveedor, latencia y herramientas. Cuando se agota el límite, el agente se interrumpe y la fase se registra como fallida; no se marca como exitosa sin respuesta verificable.

## Reglas de seguridad y alcance

- Las explicaciones y diagnósticos no habilitan escritura automáticamente.
- La clasificación de implementación no modifica perfiles de permisos: el usuario debe revisar y guardar los permisos del equipo.
- La profundidad rápida instruye al agente para revisar README, instrucciones, manifiestos y una muestra pequeña de archivos; debe detener la exploración cuando tenga evidencia suficiente.
- La clasificación es heurística y debe evolucionar con pruebas de uso real. Una tarea ambigua se enruta conservadoramente al Arquitecto con investigación focalizada.
- La estimación visible es orientativa; el límite por agente es el control efectivo. La profundidad elegida manualmente se envía a la ejecución y prevalece sobre la profundidad sugerida automáticamente.

## Caso de regresión

Instrucción: «Quisiera que en un párrafo me explicaras de qué trata el proyecto y su arquitectura».

Resultado esperado: tipo explanation, complejidad de tarea low, profundidad quick, agente architect solamente, sin cambios y con límite de dos minutos para el agente.
