---
name: dependency-audit
description: Audita las dependencias de un proyecto en busca de vulnerabilidades (CVE), licencias incompatibles y versiones desactualizadas usando las herramientas nativas de cada ecosistema. CÁRGALA cuando se pida revisar la superficie de dependencias o antes de declarar una entrega segura.
---

# Dependency Audit

Skill para auditar dependencias de proyectos en busca de vulnerabilidades, licencias incompatibles y versiones desactualizadas.

## Uso

Se invoca desde `implementation-plan` o directamente por el agente `tester` durante la verificación.

## Comandos soportados por lenguaje

| Lenguaje | Comando de auditoría | Permiso requerido |
|----------|---------------------|-------------------|
| Java (Maven) | `mvn dependency:tree` + `mvn org.owasp:dependency-check-maven:check` | `mvn dependency:*` + `mvn org.owasp:dependency-check-maven:*` |
| Java (Gradle) | `./gradlew dependencyCheckAnalyze` | `./gradlew dependencyCheckAnalyze` |
| Node/TypeScript | `npm audit` / `pnpm audit` / `yarn audit` | `npm audit *` |
| Python | `pip-audit` / `safety check` | `pip-audit *` / `safety check *` |
| Rust | `cargo audit` | `cargo audit *` |
| Go | `govulncheck ./...` | `govulncheck *` |

## Informe esperado

El agente debe reportar:
- Vulnerabilidades críticas/altas (CVE)
- Dependencias con licencias no compatibles (GPL, AGPL si el proyecto no lo permite)
- Dependencias desactualizadas (> 6 meses sin actualizar)
- Resumen con recomendaciones de actualización

## Permisos requeridos

```
- action: shell
  resource: "mvn dependency:*"
  effect: allow
- action: shell
  resource: "mvn org.owasp:dependency-check-maven:*"
  effect: allow
- action: shell
  resource: "./gradlew dependencyCheckAnalyze"
  effect: allow
- action: shell
  resource: "npm audit *"
  effect: allow
- action: shell
  resource: "pnpm audit *"
  effect: allow
- action: shell
  resource: "yarn audit *"
  effect: allow
- action: shell
  resource: "pip-audit *"
  effect: allow
- action: shell
  resource: "safety check *"
  effect: allow
- action: shell
  resource: "cargo audit *"
  effect: allow
- action: shell
  resource: "govulncheck *"
  effect: allow
```

## Integración

Se puede invocar como paso en `tester` después de los tests unitarios, o como skill independiente en `implementation-plan` para tareas de mantenimiento.
