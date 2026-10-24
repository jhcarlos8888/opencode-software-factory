---
name: implementation-plan
description: Divide una tarea de programación en pasos pequeños y verificables, identifica los archivos afectados y define criterios de aceptación antes de escribir código. CÁRGALA cuando la tarea toque varios archivos, el alcance sea ambiguo o vayas a empezar una implementación no trivial.
---

# Planificación de implementación

## Objetivo

Convertir un requisito en pasos pequeños, comprobables y acotados, antes de escribir una sola línea.

## Procedimiento

1. **Reformula el requisito**: qué se pide exactamente, y qué NO se pide. Si falta un requisito esencial que cambia el diseño, pídelo con la herramienta `question` en lugar de suponer.
2. **Reúne contexto**: usa `project-discovery` si no conoces el proyecto. Localiza con `glob`/`grep` el código y las pruebas relacionados.
3. **Acota el alcance**: lista los archivos concretos que cambiarán y por qué. Si un archivo queda fuera, dilo.
4. **Divide en pasos**: cada paso debe ser pequeño y comprobable por sí mismo (compila o tiene una prueba que lo valida).
5. **Define criterios de aceptación**: la comprobación exacta (comando + resultado esperado) que demuestra que la tarea terminó.
6. **Estima el riesgo**: contratos públicos, dependencias compartidas, datos, migraciones.

## Formato del plan

```
## Objetivo
## No está en alcance
## Archivos afectados
- ruta → cambio
## Pasos
1. cambio pequeño → verificación
2. ...
## Criterios de aceptación
- comando exacto + resultado esperado
## Riesgos
```

## Reglas

- Máximo lo necesario: no planees refactorizaciones que la tarea no pida.
- Cada paso debe reducir la incertidumbre; si un paso no se puede verificar, rediseñalo.
- Un plan de más de 7 pasos casi siempre se puede partir en dos tareas.
- No empieces a implementar sin haber localizado el código real del que hablas.
