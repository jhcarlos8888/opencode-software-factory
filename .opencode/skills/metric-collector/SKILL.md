---
name: metric-collector
description: Registra métricas de ejecución de un proyecto (etapa, comando exacto, duración en ms, código de salida y timestamp) y las resume en el informe final. CÁRGALA cuando necesites comparar tiempos de build, cobertura o resultados entre ejecuciones.
---

# Metric Collector

Esta skill define cómo registrar métricas de ejecución del proyecto (duración
de build, tiempo de tests, cobertura, número de archivos) de forma que sean
comparables entre ejecuciones y estén respaldadas por un código de salida real.

## Quién escribe el registro

- **Escribe** el fichero `metrics.json` el agente que tenga permiso de
  edición: el agente coordinador `build` o el agente `implementer`.
- **`tester` NO escribe**: su permiso de edición está denegado
  (`action: edit / resource: "*" / effect: deny`). El `tester` ejecuta los
  comandos, mide y **reporta** las métricas en su informe; quien las persista
  en `metrics.json` es el coordinador o el `implementer` a partir de ese
  informe.
- No se requiere ningún permiso de shell especial para esta skill: se usan
  los comandos de build/test que el propio proyecto ya declara.

## Formato del registro

Fichero `metrics.json` en la raíz del proyecto: un array de objetos, cada uno
con exactamente estos campos:

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `timestamp` | string | Marca ISO-8601 en UTC del inicio de la ejecución, p. ej. `2026-10-25T13:30:00Z` |
| `etapa` | string | Fase medida: `build`, `test`, `lint`, `cobertura`, `dependency-audit`, `security-scan` |
| `comando` | string | Comando EXACTO ejecutado, con todos sus argumentos |
| `duracion_ms` | number | Duración total en milisegundos (entero, medida con `date +%s%3N` o `SECONDS`/`time`) |
| `codigo_salida` | number | Código de salida real devuelto por el comando (nunca estimado) |
| `resultado` | string | `pasa`, `falla` o `no ejecutable` (con motivo) |
| `agente` | string | Quien ejecutó la medición: `build`, `implementer` o `tester` |

Ejemplo de registro:

```json
{
  "timestamp": "2026-10-25T13:30:00Z",
  "etapa": "test",
  "comando": "./gradlew test",
  "duracion_ms": 42310,
  "codigo_salida": 0,
  "resultado": "pasa",
  "agente": "tester"
}
```

Reglas:

- Nunca registres un `codigo_salida` que no hayas observado: si no se ejecutó,
  no existe registro.
- Si el comando no existe en el proyecto, usa `resultado: "no ejecutable"` y
  no inventes `duracion_ms`.
- Une cada registro a la tarea o commit que lo produjo si la información
  está disponible (`tarea` opcional), pero no inventes el identificador.

## Ejemplo de informe final

```markdown
## Métricas (2026-10-25)

| Etapa | Comando | Duración | Código de salida | Resultado |
| --- | --- | --- | --- | --- |
| build | `./gradlew build` | 18 402 ms | 0 | pasa |
| test | `./gradlew test` | 42 310 ms | 0 | pasa |
| cobertura | `./gradlew jacocoTestReport` | 6 115 ms | 0 | pasa |

- Cobertura total: 78,4 % (`build/reports/jacoco/test/html/index.html`).
- Comparación con la ejecución anterior (2026-10-24): test +3,1 s, sin
  regresión de cobertura.
- No ejecutable: `dependency-audit` (el proyecto no declara OWASP dependency-check).
```

## Cuándo usarla

- Para comparar el coste de un cambio antes/después (build y tests).
- Para dejar constancia de la cobertura y su evolución.
- Como insumo del informe de `verificar` o `calidad-java`: la métrica sin
  comando y código de salida real no es evidencia.
