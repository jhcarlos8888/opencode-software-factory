---
name: spring-boot-architecture
description: Guía la estructura y las convenciones de un proyecto Spring Boot (capas, perfiles, validación, manejo de errores y testing con JUnit 5, Mockito, @SpringBootTest y Testcontainers). CÁRGALA cuando vayas a crear, revisar o modificar un servicio Spring Boot o su configuración.
---

# Arquitectura Spring Boot

## Estructura de directorios

```
src/main/java/<paquete raíz>/
├── <paquete>/controller/    # RestController: HTTP puro, sin lógica de negocio
├── <paquete>/service/       # Lógica de negocio (@Service), transacciones
├── <paquete>/repository/    # Acceso a datos (JpaRepository, interfaces)
├── <paquete>/dto/           # Request/response (records preferibles)
├── <paquete>/entity/        # JPA entities
├── <paquete>/config/        # @Configuration, beans, properties
└── <paquete>/exception/     # Excepciones propias y @RestControllerAdvice
src/main/resources/
├── application.properties|yml            # perfil por defecto (default)
├── application-<perfil>.properties|yml   # sobrescrituras por perfil
└── ...
src/test/java/<paquete raíz>/             # ESPEJO: misma estructura de paquetes
src/test/resources/application-test.properties  # config de test (H2, mocks...)
```

Regla de oro: `src/test/java` replica el paquete de la clase que prueba
(`com.ejemplo.service.FooService` → `com.ejemplo.service.FooServiceTest`).

## Capas y sus responsabilidades

| Capa | Anotación | Reglas |
| --- | --- | --- |
| Controller | `@RestController`, `@RequestMapping` | Solo traduce HTTP ↔ DTO; delega en `service`; nunca toca `repository` directamente ni contiene lógica de negocio |
| Service | `@Service` | Lógica de negocio y `@Transactional`; recibe DTOs o dominio y devuelve DTOs o dominio |
| Repository | `@Repository` o interfaz `JpaRepository<T, ID>` | Sin lógica de negocio; consultas derivadas por nombre o `@Query` |
| DTO | `record` (Java 16+) o clase | Nunca expongas entities JPA en la API (ciclos, LazyInitialization, fuga de datos) |
| Config | `@Configuration`, `@ConfigurationProperties` | Un solo lugar para beans y propiedades |

Dependencia siempre en la dirección `controller → service → repository`;
una dependencia al revés es un defecto de diseño demostrable.

## Gestión de perfiles

- Perfil por defecto: `src/main/resources/application.properties` (o `application.yml`).
- Overrides por perfil: `application-<perfil>.properties|yml`
  (`application-dev`, `application-test`, `application-prod`).
- Activación: `--spring.profiles.active=<perfil>`,
  `SPRING_PROFILES_ACTIVE=<perfil>` o `@ActiveProfiles("<perfil>")` en tests.
- Orden de prioridad de la configuración, de **mayor a menor** (la de arriba
  siempre gana a la de abajo):
  1. Argumentos de línea de comandos (`--clave=valor`).
  2. Propiedades del sistema Java (`System.getProperties()`).
  3. Variables de entorno del SO.
  4. `application-<perfil>.properties|yml` **externo** (`file:./`,
     `file:./config/`).
  5. `application.properties|yml` **externo** (`file:./`, `file:./config/`).
  6. `application-<perfil>.properties|yml` **empaquetado** (classpath).
  7. `application.properties|yml` **empaquetado** (classpath).

  Los argumentos de línea de comandos mandan **siempre**: ninguna propiedad de
  ningún fichero `application*.properties` puede superarlas. Un fichero externo
  manda sobre su homólogo empaquetado, y dentro de la misma ubicación el de
  perfil manda sobre el genérico. Comprobado el 25/10/2026 con Spring Boot
  3.5.16 (SpringApplicationBuilder + perfil `prod`): `--profileorder=` ganó a
  todo, la propiedad de sistema ganó a la variable de entorno y a los ficheros,
  la variable de entorno ganó a los ficheros, y `file:./application.properties`
  ganó a `classpath:/application-prod.properties`.
- Config inyectada con `@ConfigurationProperties(prefix = "...")` (tipada y testeable)
  o `@Value("${clave}")` para claves puntuales.
- Nunca dejes credenciales en el repositorio: usa variables de entorno o
  `${VAR}` resuelta en runtime.

## Validación con `jakarta.validation`

- Dependencia: `spring-boot-starter-validation` (incluye Hibernate Validator).
- En el DTO de entrada: `@NotBlank`, `@NotNull`, `@Size(min=,max=)`,
  `@Email`, `@Positive`, `@Pattern` y rangos numéricos.
- En el controller: `@Valid @RequestBody MiDto dto` (o `@Validated` a nivel de
  clase para `@PathVariable`/`@RequestParam`).
- Sin `@Valid` la anotación del DTO **no se ejecuta**: es un fallo común.
- Errores de validación → `MethodArgumentNotValidException`, cuyo
  `BindingResult` contiene campo a campo.

## Manejo de errores con `@RestControllerAdvice`

```java
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(
            MethodArgumentNotValidException ex) {
        Map<String, String> campos = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors()
          .forEach(f -> campos.put(f.getField(), f.getDefaultMessage()));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("timestamp", Instant.now());
        body.put("status", 400);
        body.put("errores", campos);
        return ResponseEntity.badRequest().body(body);
    }

    @ExceptionHandler(RecursoNoEncontrado.class)
    public ResponseEntity<Map<String, Object>> handleNotFound(
            RecursoNoEncontrado ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", 404);
        body.put("mensaje", Optional.ofNullable(ex.getMessage())
                .orElse("Recurso no encontrado"));
        return ResponseEntity.status(404).body(body);
    }
}
```

- El cuerpo se construye con `LinkedHashMap` y `put` en el orden deseado
  (timestamp, status, mensaje/errores): `Map.of` **no conserva el orden** y
  además lanza `NullPointerException` si algún valor es `null`.
- El mensaje se resuelve con `Optional.ofNullable(ex.getMessage()).orElse(...)`
  para que una excepción sin mensaje no rompa el handler (otro `NPE` dentro del
  manejo de errores).
- Convierte excepciones de negocio (`@ResponseStatus` o advice) en
  respuestas HTTP coherentes; nunca dejes un 500 por una entidad inexistente.
- Un handler por familia de excepción; respeta siempre un cuerpo de error
  consistente (timestamp, status, mensaje).
- Evita que los `@ExceptionHandler` filtren mensajes internos de la
  base de datos en producción.

## Testing (JUnit 5 + Mockito + SpringBootTest + Testcontainers)

| Nivel | Herramienta | Cuándo |
| --- | --- | --- |
| Unitario | JUnit 5 + Mockito | Lógica de `service`/`dto` sin contexto Spring: el más rápido, escribe siempre muchos de estos |
| Slice | `@WebMvcTest` + `@MockitoBean` | Controllers + MVC solo (`MockMvc`) |
| Integración | `@SpringBootTest` | Contexto completo arrancando; lento, úsalo con moderación |
| Integración con BD real | Testcontainers (`@Testcontainers`, `@Container`) | Postgres/MySQL reales en Docker: **en esta máquina Docker NO está instalado**, así que este nivel es "no ejecutable" aquí y debe reportarse como tal |

- Regla de la pirámide: muchos unitarios, pocos `@SpringBootTest`.
- En Spring Boot 3.4+ `@MockBean` está deprecado → usa `@MockitoBean`.
- `testRuntimeOnly 'org.junit.platform:junit-platform-launcher'` es necesario
  en Gradle para que arranque JUnit 5.
- Los tests de integración deben aislar datos (transactions rollback o BD por
  contenedor) para poder repetirlos.

## Errores comunes

1. **El contexto no arranca**: casi siempre dependencia duplicada/conflictiva,
   bean que no puede inyectarse (`NoSuchBeanDefinitionException`) o una clase
   `@Entity` fuera del escaneo del paquete base (`@SpringBootApplication`).
   Lee la traza hasta la primera causa raíz, no el último `Caused by`.
2. **`BeanCreationException` por circular dependency**: rompe el ciclo
   extrayendo la interfaz o con `@Lazy`.
3. **Dependencias con scope equivocado**: las anotaciones JPA
   (`jakarta.persistence`) son `provided`/`runtime`; las de test
   (`spring-boot-starter-test`, Testcontainers) deben ser
   `testImplementation` (Gradle) o `<scope>test</scope>` (Maven). Si una
   clase compila en el IDE y falla en `mvn -B test`, revisa scopes.
4. **Toolchain mismatch**: si `pom.xml`/`build.gradle` pide Java 21 y solo hay
   17 en el PATH, el build falla con `invalid target release`. Comprueba con
   `java -version` y `mvn -version`/`gradle --version` antes de culpar al código.
5. **Tests que usan la BD de desarrollo**: usa perfiles de test y nunca
   conectes un `@SpringBootTest` a la BD de producción.
6. **Puerto ocupado en tests**: fija `spring.profiles.active=test` con
   `server.port=0` o desactiva la capa web en los tests de servicio.

## Convenciones de paquetes

- Paquete raíz descriptivo del dominio, no de la empresa:
  `com.ejemplo.pedidos`, no `com.ejemplo.proyecto123`.
- Un paquete por capa (`...controller`, `...service`, `...repository`,
  `...dto`, `...config`, `...exception`) o el estilo feature-first
  (`...pedidos.controller`, `...pedidos.service`) — elige UNO y mantenlo.
- Los tests replican el paquete del código fuente que prueban.
- Clases en inglés o español según el proyecto, pero **consistente**;
  nombres de paquete en minúsculas sin guiones.

## Verificación mínima de un cambio Spring Boot

```
java -version && mvn -version      # o gradle --version / ./gradlew --version
mvn -B test                        # o ./gradlew test
mvn -B verify                      # o ./gradlew check
```

Comprueba que la suite existe y se ejecuta de verdad antes de afirmar nada;
usa `java-build-quality` para la batería completa de calidad.
