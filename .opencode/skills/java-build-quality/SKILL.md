---
name: java-build-quality
description: Ejecuta la batería de calidad de proyectos Java con los comandos exactos de Maven y Gradle (test, checkstyle, spotbugs, pmd, jacoco, OWASP), indica dónde quedan los informes y qué hacer si una herramienta no está configurada. CÁRGALA al verificar un proyecto Java o al pedir cobertura, análisis estático o auditoría de dependencias.
---

# Calidad de build en Java

## 1. Detecta el build antes de ejecutar nada

| Señal | Build | Comando base |
| --- | --- | --- |
| Existe `./mvnw` | Maven con wrapper | `./mvnw -B ...` |
| Existe `mvn` en el PATH y `pom.xml` | Maven sin wrapper | `mvn -B ...` |
| Existe `./gradlew` | Gradle con wrapper | `./gradlew ...` |
| Existe `gradle` en el PATH y `build.gradle[.kts]` | Gradle sin wrapper | `gradle ...` |

Reglas:

- **Usa el wrapper si existe** (`./gradlew` / `./mvnw`): fija la versión exacta
  y evita diferencias entre máquinas.
- Si no hay wrapper, usa el `gradle`/`mvn` del sistema y **dilo en el informe**.
- `-B` (Maven) = modo no interactivo: sin prompts y logs limpios en CI.
- No ejecutes comandos de un build que no esté declarado en el proyecto
  (`pom.xml` o `build.gradle`): si la herramienta no está configurada, mira §5.

## 2. Comandos exactos

### Maven (con wrapper: sustituye `mvn` por `./mvnw`)

| Propósito | Comando |
| --- | --- |
| Tests unitarios | `mvn -B test` |
| Build completo (tests incluidos) | `mvn -B verify` |
| Estilo | `mvn checkstyle:check` |
| Estática (bugs) | `mvn spotbugs:check` |
| Estática (reglas) | `mvn pmd:check` |
| Auditoría OWASP de dependencias | `mvn org.owasp:dependency-check-maven:check` |
| Cobertura (informe) | `mvn jacoco:report` |
| Árbol de dependencias | `mvn dependency:tree` |

Nota: los plugins `checkstyle`, `spotbugs`, `pmd`, `jacoco` y
`dependency-check` se ejecutan como goals; si no están declarados en el
`pom.xml`, el comando puede descargar el plugin y ejecutar con su
configuración por defecto, o fallar — aplica §5.

### Gradle (con wrapper: `./gradlew`)

| Propósito | Comando |
| --- | --- |
| Tests unitarios | `./gradlew test` |
| Verificación completa (tests + checkstyle + pmd + spotbugs si están aplicados) | `./gradlew check` |
| Cobertura (informe) | `./gradlew jacocoTestReport` |
| Estática (bugs) | `./gradlew spotbugsMain` |
| Estilo | `./gradlew checkstyleMain` |
| Estática (reglas) | `./gradlew pmdMain` |
| Auditoría OWASP de dependencias | `./gradlew dependencyCheckAnalyze` |

Los tasks `...Main` analizan `src/main`; si quieres el código de test añade
`...Test` (`./gradlew spotbugsTest`). Si el task no existe en el proyecto,
Gradle falla con `Task 'xyz' not found` → §5.

## 3. Dónde quedan los informes

| Herramienta | Maven | Gradle |
| --- | --- | --- |
| Cobertura (HTML) | `target/site/jacoco/index.html` | `build/reports/jacoco/test/html/index.html` |
| Cobertura (XML, para máquinas) | `target/site/jacoco/jacoco.xml` | `build/reports/jacoco/test/jacocoTestReport.xml` |
| Checkstyle | `target/checkstyle-result.xml` y `target/checkstyle-checker.xml` | `build/reports/checkstyle/main.html` + `build/reports/checkstyle/main.xml` |
| SpotBugs | `target/spotbugsXml.xml` (y `target/spotbugs.html`) | `build/reports/spotbugs/main.html` |
| PMD | `target/pmd.xml` | `build/reports/pmd/main.html` |
| OWASP dependency-check | `target/dependency-check-report.html` (+ `.json`/`.xml`) | `build/reports/dependency-check/` |
| Tests (JUnit XML/HTML) | `target/surefire-reports/` | `build/reports/tests/test/` |

Los informes solo existen tras ejecutar la herramienta correspondiente:
**no cites un informe que no se haya generado**.

## 4. Cómo interpretar el XML de cobertura (Jacoco)

```xml
<report name="...">
  <package name="com.ejemplo">
    <class name="com/ejemplo/Servicio" sourcefilename="Servicio.java">
      <counter type="INSTRUCTION" missed="120" covered="880"/>
      <counter type="BRANCH" missed="10" covered="30"/>
      <counter type="LINE" missed="15" covered="145"/>
```

- Dos métricas por unidad: `covered` (ejecutadas) y `missed` (no ejecutadas);
  por `type`: `INSTRUCTION`, `BRANCH`, `LINE`, `METHOD`, `COMPLEXITY`.
- % cobertura = `covered / (covered + missed)`. Con `grep`/`awk` basta para el
  total del proyecto; los totales están en el `<counter>` final del `<report>`.
- **Rama (`BRANCH`) < línea (`LINE`)** suele indicar `if`/`switch` sin cubrir:
  prioriza tests de caminos, no de líneas.
- Nunca subas la cobertura desactivando o deletreando tests: añade tests que
  ejerciten el código descubierto.
- El XML (no el HTML) es la fuente para comparar entre ejecuciones y para
  `metric-collector`.

## 5. Si la herramienta NO está configurada en el proyecto

**No falles y no simules: reporta "no disponible" y propón añadirla.**

1. Comprueba si el plugin está declarado: grep en `pom.xml`
   (`checkstyle-maven-plugin`, `spotbugs-maven-plugin`, `maven-pmd-plugin`,
   `jacoco-maven-plugin`, `dependency-check-maven`) o en
   `build.gradle[.kts]` (`checkstyle`, `spotbugs`, `pmd`, `jacoco`,
   `dependencycheck` / `org.owasp.dependencycheck`).
2. Si no está: informe con algo así —
   > `mvn spotbugs:check` → **no disponible**: el proyecto no declara
   > `spotbugs-maven-plugin`. Informe no generado. Propuesta: añadir el
   > plugin a la sección `<build><plugins>` con una versión fijada.
3. Si decides probarlo igualmente (el plugin se puede resolver por
   descriptor), ejecútalo, informa el código de salida real y deja claro que
   es una **ejecución sin configuración del proyecto** (reglas por defecto).
4. OWASP dependency-check descarga la BD NVD la primera vez (puede tardar
   minutos y necesita red): si falla por red, repórtalo como "no disponible
   por red", nunca como "sin vulnerabilidades".
5. Nunca inventes porcentajes, conteos ni rutas de informe: o se generaron o
   constan como no disponibles.

## 6. Batería mínima con evidencia

```bash
mvn -B clean test                          # o ./gradlew clean test
mvn -B verify                              # o ./gradlew check
mvn checkstyle:check                       # o ./gradlew checkstyleMain
mvn spotbugs:check                         # o ./gradlew spotbugsMain
mvn pmd:check                              # o ./gradlew pmdMain
mvn jacoco:report                          # o ./gradlew jacocoTestReport
mvn org.owasp:dependency-check-maven:check # o ./gradlew dependencyCheckAnalyze
```

Para cada comando: comando exacto + **código de salida real** + rutas de los
informes generados. En esta fábrica, el agente `tester` ejecuta esta batería
con el comando `/calidad-java`.
