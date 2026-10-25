# Instrucciones del proyecto

Este archivo fue instalado por la fábrica de software multiagente de OpenCode.
Puedes editarlo libremente: la fábrica lo conserva si lo modificas y nunca lo
sobrescribe. Si no existe, la instalación lo crea; si ya existe, no lo toca.

## Agentes disponibles

- `build`: coordinador principal, recibe la tarea en modo `primary` y delega.
- `architect`: planificación en solo lectura; propone planes con evidencia.
- `implementer`: escribe código siguiendo un plan, con cambios pequeños.
- `tester`: ejecuta build, tests y análisis estático; exige evidencia real.
- `reviewer`: revisión en solo lectura del diff; no modifica archivos.
- `cloud-arbiter`: árbitro, úsalo solo ante discrepancias difíciles.
- `reverse`: ingeniería inversa sobre artefactos ya compilados o empaquetados.

## Cómo trabajar

- Delega con subagentes: planificación a `architect`, código a `implementer`,
  verificación a `tester` y revisión final a `reviewer`.
- Exige evidencia real: comando exacto ejecutado, código de salida y resumen
  de resultados. Una opinión no sustituye una ejecución.
- Nunca afirmes que algo pasó sin ejecutar el comando y observar su salida.
- Distingue los defectos demostrados de las hipótesis y de lo desconocido.

## Verificación del proyecto

Anota aquí el comando REAL de build, test y lint de este proyecto. Ejemplos:

- `./gradlew clean test`
- `mvn test`
- `python3 -m pytest`
- `npm test`
- `tsc --noEmit`

El agente `tester` debe usar este comando (o el que declare el propio
proyecto) y reportar su salida literal con el código de salida real. Si el
comando de verificación cambia, actualiza esta sección.

## Reglas duras

- Evidencia real: no des un resultado por bueno sin ejecutar el comando.
- No inventes rutas, herramientas, resultados ni fuentes.
- No desactives, omitas ni saltes pruebas para conseguir un resultado verde.
- Corrige la causa raíz; no ocultes el fallo cambiando el síntoma.
- Informa los comandos ejecutados y sus resultados reales.
- Respeta los cambios preexistentes y no los reviertas sin autorización.
