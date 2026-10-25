---
description: Ejecuta la batería Java (build, tests, checkstyle, spotbugs, pmd, jacoco, OWASP) con códigos de salida reales y un informe de evidencia (subagente tester, solo ejecución)
agent: tester
---

Ejecuta la batería de calidad Java de este proyecto y devuelve evidencia
objetiva. Sigue la skill `java-build-quality`: detecta el build leyendo los
archivos reales (`pom.xml`, `build.gradle`, wrappers `./mvnw`/`./gradlew`),
no inventes comandos ni plugins. Tu permiso de edición está denegado: ejecuta
y reporta, no modifiques ningún archivo.

Batería a intentar en este orden (usa el wrapper si existe; si no, `mvn`/`gradle`
del sistema y dilo):

1. `mvn -B clean test` o `./gradlew clean test` — build + tests.
2. `mvn -B verify` o `./gradlew check` — verificación completa.
3. `mvn checkstyle:check` o `./gradlew checkstyleMain` — estilo.
4. `mvn spotbugs:check` o `./gradlew spotbugsMain` — análisis estático de bugs.
5. `mvn pmd:check` o `./gradlew pmdMain` — reglas estáticas.
6. `mvn jacoco:report` o `./gradlew jacocoTestReport` — cobertura.
7. `mvn org.owasp:dependency-check-maven:check` o
   `./gradlew dependencyCheckAnalyze` — auditoría OWASP de dependencias.

Reglas de la batería:

- **Códigos de salida reales**: registra el código devuelto por CADA comando.
  Un comando no ejecutado no tiene código de salida; dilo así.
- **Sin herramienta configurada → "no disponible"**, con el motivo exacto
  (plugin no declarado, task inexistente, sin red, etc.) y la propuesta de
  añadirla. Nunca simules un resultado ni omitas un paso sin decirlo.
- **Rutas de informe reales** solo si se generaron (`target/site/jacoco`,
  `build/reports/jacoco`, `target/checkstyle-result.xml`,
  `target/spotbugsXml.xml`, `target/pmd.xml`,
  `target/dependency-check-report.html`).
- Separa **fallos nuevos** de **preexistentes** y las **pruebas ejecutadas**
  de las no ejecutadas.

Informe mínimo:

```
## Batería Java
| # | Comando | Código de salida | Resultado | Informe |
|---|---------|------------------|-----------|---------|
| 1 | mvn -B clean test | 0 | pasa (42 tests) | target/surefire-reports |
...
No disponible: <comando> → <motivo exacto> → propuesta: <cómo añadirlo>
Tests no ejecutados: <nº y motivo>
```

Petición:

$ARGUMENTS
