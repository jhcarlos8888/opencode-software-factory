# Reglas de OpenCode Software Factory

Este repositorio contiene configuraciones reutilizables de OpenCode.

## Límites de responsabilidad

- No modificar la configuración global del usuario desde una tarea ordinaria.
- No modificar proyectos externos a este repositorio salvo que la tarea lo solicite.
- No copiar secretos, tokens, claves API ni datos privados al repositorio.
- No sobrescribir archivos existentes durante una instalación sin respaldo y aprobación.
- Mantener separados el código de la fábrica y el código de los proyectos que utiliza.

## Ingeniería y calidad

- Inspeccionar el estado de Git y las instrucciones antes de cambiar archivos.
- Consultar la arquitectura y los comandos de verificación reales antes de implementar.
- Delegar planificación, implementación, pruebas y revisión según corresponda.
- El revisor debe evaluar el diff real y no modificar archivos.
- Registrar los comandos ejecutados y sus resultados reales.
- No declarar pruebas satisfactorias cuando no se hayan ejecutado.
- Distinguir los defectos demostrados de las hipótesis.
- No desactivar pruebas para conseguir un resultado satisfactorio.

## Cambios a la fábrica

Cuando se modifiquen agentes, skills, comandos o configuración:

1. Verificar la estructura y sintaxis.
2. Comprobar que OpenCode carga las definiciones esperadas.
3. Revisar el diff y el estado de Git.
4. Documentar incompatibilidades y tareas pendientes.

Las instrucciones específicas de cada proyecto se conservan y complementan estas reglas.
