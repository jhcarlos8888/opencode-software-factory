# Plantillas de calidad Java

Fragmentos con los plugins de calidad ya configurados y con versiones
verificadas:

- `maven-quality-plugins.xml`: bloques `<plugin>` (checkstyle, PMD,
  SpotBugs y JaCoCo) para pegar dentro de `<build><plugins>` del `pom.xml`.
- `gradle-quality.gradle`: bloques Groovy (checkstyle, PMD y JaCoCo) para
  pegar al final de `build.gradle` (requiere el plugin `java`). SpotBugs en
  Gradle requiere el plugin del Portal (com.github.spotbugs) y se añade
  aparte.

Pegado a mano: copia solo los bloques que falten, sin duplicar los que ya
declare tu build; la cabecera de cada plantilla indica los comandos de
ejecución y los informes que genera.

```bash
python3 scripts/factory.py quality <proyecto>          # informe, no toca nada
python3 scripts/factory.py quality <proyecto> --apply  # respalda e inyecta
```

Versiones verificadas con **JDK 17** (Temurin 17.0.20, el `java` del PATH):

- Gradle 8.14.5 → `checkstyle` 12.3.1, `pmd` 7.28.0, `jacoco` 0.8.15.
  Checkstyle 12.3.1 es la última versión con `<java.version>17</java.version>`
  en su POM (Maven Central); 13.x y 14.x exigen Java 21 y, sin *toolchain* en
  la plantilla, rompen la build en un entorno con Java 17.
- Maven 3.9.16 → `maven-checkstyle-plugin` 3.6.0, `maven-pmd-plugin` 3.28.0,
  `spotbugs-maven-plugin` 4.10.5.0, `jacoco-maven-plugin` 0.8.15.
