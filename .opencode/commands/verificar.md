---
description: Ejecuta build y tests reales y devuelve evidencia objetiva: comandos, códigos de salida y fallos (subagente tester)
agent: tester
---

Ejecuta las verificaciones reales de este proyecto y devuelve evidencia objetiva. Detecta las herramientas leyendo los archivos de build; no inventes comandos. Separa fallos nuevos de preexistentes y no modifiques nada: tu permiso de edición está denegado.

Flujo de verificación con las skills de la fábrica:

- Si el proyecto es Java (Maven o Gradle), sigue la skill `java-build-quality`
  para los comandos exactos y, si es Spring Boot, apóyate en
  `spring-boot-architecture` para validar estructura y configuración.
- Si hay dependencias nuevas o se pide revisar paquetes, aplica
  `dependency-audit`; si se pide seguridad del código, aplica `security-scan`.
- Si necesitas comparar tiempos o cobertura entre ejecuciones, reporta las
  métricas siguiendo `metric-collector` en tu informe: tú solo ejecutas y
  reportas (tu permiso de edición está denegado), la escritura de
  `metrics.json` la hace `build` o `implementer`.
- Para la batería Java completa (build, tests, checkstyle, spotbugs, pmd,
  jacoco, OWASP) usa el comando `/calidad-java`.

Verificación solicitada:

$ARGUMENTS
