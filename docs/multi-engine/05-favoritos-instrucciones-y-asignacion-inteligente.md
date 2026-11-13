# Instrucciones de proyecto, favoritos y asignación inteligente

## Estado implementado

- El panel incorpora un campo persistente de objetivo/instrucciones independiente de la ruta del proyecto.
- El análisis estructural devuelve dificultad estimada (baja, media, alta o muy alta), puntuación, razones y cantidad de archivos detectados.
- El conteo recorre hasta cinco niveles, omite carpetas habituales de dependencias/build y limita el total a 5.000 archivos.
- Se pueden guardar modelos favoritos por motor/proveedor y clasificarlos como económicos, equilibrados o premium.
- Tras analizar un proyecto, se prepara una recomendación de motor/modelo por agente usando exclusivamente los favoritos del proveedor activo. La propuesta se carga en las tarjetas para revisión; el usuario debe pulsar Guardar equipo.
- Los roles tienen preferencias de motor para desempatar: arquitectura/revisión/árbitro priorizan Claude; coordinación/implementación/QA/ingeniería inversa priorizan OpenCode.
- Los roles reciben niveles distintos según dificultad. Por ejemplo, implementación y arquitectura escalan a premium en proyectos complejos; QA puede permanecer equilibrado.

## Modelo Claude Code

- El catálogo anterior mostraba solo alias sonnet/opus/haiku.
- Ahora, para APMix, también se extrae el valor ANTHROPIC_MODEL de ~/.claude/settings.json si ANTHROPIC_BASE_URL coincide exactamente con https://api.apmix.ai.
- Se devuelve únicamente el identificador de modelo; no se devuelve ni registra ANTHROPIC_AUTH_TOKEN ni ANTHROPIC_API_KEY.
- La lista completa de modelos APMix aún requiere consultar GET https://api.apmix.ai/v1/models con la clave local y depende del plan. No se realizó esa llamada porque la clave fue expuesta en la conversación y debe rotarse primero.
- No se modificaron ~/.claude/settings.json, credenciales, sesión OAuth, configuración global ni archivos de agentes/Skills.

## Limitaciones deliberadas

- La dificultad actual es una heurística estructural, no una revisión semántica realizada por un LLM. Se basa en conteo de archivos, manifiestos, stacks, instrucciones y estado Git.
- Económico/equilibrado/premium es una clasificación manual del usuario, no una afirmación automática de precio o capacidad del modelo.
- El motor/modelo recomendado no se ejecuta todavía. Es una propuesta que requiere revisión y guardado.
- Si no hay favoritos, el análisis informa que no puede recomendar; no inventa modelos.
- Los favoritos de Claude se mantienen separados por proveedor APMix/Anthropic.

## Siguiente fase

1. Rotar la clave APMix expuesta y actualizarla localmente sin compartirla por chat.
2. Implementar actualización autenticada del catálogo APMix desde GET /v1/models, con redacción estricta de secretos.
3. Validar Anthropic oficial mediante la autenticación disponible sin reconfigurarla.
4. Probar una petición inocua de solo lectura por proveedor y registrar resultado/latencia sin persistir secretos.
5. Añadir calibración de dificultad mediante análisis semántico opcional y métricas de contexto/capacidades de modelo.
