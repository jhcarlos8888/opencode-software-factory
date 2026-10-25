# Metric Collector

Este skill permite que los agentes recopilen métricas de ejecución del proyecto (ej. tiempo de compilación, número de archivos, cobertura de pruebas). Se usa mediante `implementation-plan` y `tester`.

## Ejemplo de uso
```
- **Objetivo**: medir tiempo de build.
- **Comando**: `./gradlew build`.
- **Métricas**: tiempo, líneas de código, nombres de archivos.
```

## Registro de métricas
Las métricas se guardan en `metrics.json` en la raíz del proyecto. El agente `tester` las agrega al informe de resultados.

## Permisos requeridos
```
- action: shell
  resource: "./gradlew --help"
  effect: allow
```
