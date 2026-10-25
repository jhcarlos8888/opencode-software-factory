---
name: security-scan
description: Ejecuta escaneo de seguridad estático (SAST) y detección de secretos en el código con las herramientas disponibles en el proyecto. CÁRGALA cuando se pida revisar vulnerabilidades de código, secretos expuestos o aplicar hardening de seguridad.
---

# Security Scan

Skill para escaneo de seguridad estático (SAST) y análisis de secretos en el código.

## Uso

Se usa desde `tester` como parte de la verificación completa, o desde `implementation-plan` para auditorías de seguridad.

## Herramientas soportadas por lenguaje

| Lenguaje | Herramienta SAST | Comando | Permiso |
|----------|-----------------|---------|---------|
| Java | SpotBugs / SonarQube | `mvn spotbugs:check` / `sonar-scanner` | `mvn spotbugs:*` |
| TypeScript/JavaScript | ESLint security plugins / CodeQL | `npm run lint:security` / `codeql database analyze` | `npm run lint:security *` |
| Python | Bandit / Semgrep | `bandit -r .` / `semgrep scan` | `bandit *` / `semgrep *` |
| Go | gosec | `gosec ./...` | `gosec *` |
| Rust | cargo-audit + clippy | `cargo clippy -- -D warnings` | `cargo clippy *` |
| Multi-lenguaje | Semgrep / CodeQL | `semgrep scan --config=auto` | `semgrep scan *` |

## Detección de secretos

- `truffleHog filesystem .` / `git-secrets --scan` / `detect-secrets scan`
- Permiso: `truffleHog *` / `git-secrets *` / `detect-secrets *`

## Informe esperado

- Hallazgos SAST clasificados por severidad (Crítico, Alto, Medio, Bajo)
- Secretos detectados (API keys, passwords, tokens) con archivo y línea
- Falsos positivos identificados
- Recomendaciones de remediación

## Permisos requeridos

```
- action: shell
  resource: "mvn spotbugs:*"
  effect: allow
- action: shell
  resource: "sonar-scanner *"
  effect: allow
- action: shell
  resource: "npm run lint:security *"
  effect: allow
- action: shell
  resource: "codeql *"
  effect: allow
- action: shell
  resource: "bandit *"
  effect: allow
- action: shell
  resource: "semgrep *"
  effect: allow
- action: shell
  resource: "gosec *"
  effect: allow
- action: shell
  resource: "cargo clippy *"
  effect: allow
- action: shell
  resource: "truffleHog *"
  effect: allow
- action: shell
  resource: "git-secrets *"
  effect: allow
- action: shell
  resource: "detect-secrets *"
  effect: allow
```

## Integración

Ejecutar en `tester` después de build y tests. En `implementation-plan` para tareas de hardening.
