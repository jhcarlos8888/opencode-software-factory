# Selección de proveedor Claude Code

## Estado de implementación

El Control Center permite seleccionar entre APMix y Anthropic oficial desde la interfaz. La preferencia se almacena en la base SQLite local (claude_provider_preferences) y no se escribe en la configuración de Claude Code.

## Límites de seguridad

- No se leen ni muestran valores de claves, tokens o credenciales.
- No se modifica ~/.claude/settings.json.
- No se modifica la sesión OAuth oficial de Claude Code.
- La selección aún no enruta ejecuciones: es una preferencia para el adaptador futuro.
- No se inicia una petición de modelo durante el cambio de proveedor.

## Datos técnicos verificados

- APMix documenta un endpoint compatible con Anthropic en https://api.apmix.ai (sin sufijo /v1) para Claude Code.
- Anthropic oficial utiliza https://api.anthropic.com.
- La compatibilidad del protocolo no garantiza que un modelo esté habilitado en el plan APMix.
- Los intentos anteriores con APMix dieron errores de modelo/plan. Por eso los catálogos y la autenticación deben validarse por separado antes de habilitar ejecución.

## Próxima fase

1. Crear adaptadores de proveedor aislados para Claude Agent SDK.
2. Separar autenticación oficial de APMix sin copiar secretos a SQLite ni al repositorio.
3. Consultar los modelos disponibles por proveedor usando credenciales locales sin imprimirlas.
4. Ejecutar una prueba mínima de solo lectura por proveedor.
5. Registrar resultado, modelo real, latencia y error sin almacenar prompts sensibles ni secretos.
6. Habilitar la selección como ruta efectiva solo después de superar esas pruebas.
