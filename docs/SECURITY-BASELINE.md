# Línea base de seguridad — OpenCode Software Factory

Última revisión: 17 de noviembre de 2026.

## Fronteras operativas

- El Control Center y la API escuchan únicamente en 127.0.0.1.
- La API rechaza orígenes de navegador no autorizados, Origin: null y solicitudes Sec-Fetch-Site: cross-site. Los clientes CLI locales sin procedencia de navegador siguen permitidos.
- Las respuestas incorporan Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Resource-Policy y Cross-Origin-Opener-Policy.
- La base SQLite y los sidecars WAL/SHM usan 0600; los directorios de estado usan 0700.
- Las lecturas del MCP abren archivos sin seguir el último symlink (O_NOFOLLOW), verifican la identidad del descriptor y enumeran directorios a través de descriptores abiertos.
- El MCP no ofrece herramientas de escritura, shell, red ni ejecución de procesos.
- El verificador de agentes rechaza symlinks en la configuración, las carpetas y las definiciones de agentes.
- El instalador usa creación exclusiva, manifiestos privados, respaldo y reemplazo atómico de archivos de build; quality rechaza builds simbólicos.
- Los secretos conocidos se redactan en eventos, errores, cargas JSON y handoffs antes de persistirse.
- Las autorizaciones temporales son específicas del agentRunId y de los recursos concretos. Las sugerencias save del proveedor no conceden permisos persistentes.

## Modalidad security-audit

- Toda instancia de una auditoría es de solo lectura en ambos motores; la auditoría nunca modifica el target. La corrección de hallazgos `confirmed` se hace en una ejecución tradicional independiente y `verified_fixed` exige evidencia de revalidación.
- La política por defecto (y única implementada) es `source-only`: no se ejecuta código del target. La política `sandboxed-source-and-local-only` NO está implementada: se rechaza siempre con el error `sandbox_not_implemented`, aunque llegue con una autorización sandbox que parecería válida; no hay fallback silencioso ni metadata sandboxed.
- Bloqueadores exactos hoy: `disk_limit_unavailable` (uso total de disco no garantizable) y `promotion_dirfd_unavailable` (Node no ofrece promoción por dirfd sin carrera); ambos desactivan la promoción dinámica.
- La red de los proveedores IA queda fuera de cualquier sandbox; la red del target se denega dentro de ella.
- El presupuesto nunca se supera: gate pre-reconocimiento, reservas de críticos y validación antes de cada invocación y clasificación de errores de proveedor con `autoReplay=false`.
- Detalle en docs/security-operations/ARCHITECTURE.md; procedencia e integridad de la skill upstream en docs/security-operations/UPSTREAM.md.

## Dependencias npm

La política de npm run security:audit ejecuta dos auditorías:

1. npm audit --omit=dev: producción debe tener cero vulnerabilidades altas o críticas.
2. npm audit: el árbol completo se inspecciona y cualquier vulnerabilidad alta/crítica desconocida bloquea la verificación.

### Excepción temporal registrada

A fecha de la revisión, picomatch@4.0.7 está afectado por CVE-2026-112366 / GHSA-fc5q-39xc-vjpf, una denegación de servicio por expresiones regulares (ReDoS) al evaluar determinados extglobs repetidos de una sola rama. La base de GitHub registra severidad alta y los rangos afectados llegan hasta 4.0.7.

La ruta afecta solo a las dependencias de desarrollo de Vite y sus herramientas transitivas en este proyecto. El informe npm muestra cinco nombres de paquete afectados (picomatch, fdir, tinyglobby, vite y @vitejs/plugin-react), pero corresponden a una misma causa raíz, no a cinco CVE distintos.

El registro npm sigue mostrando picomatch 4.0.7 como última versión disponible en esta revisión; no aparece todavía una versión corregida publicada. En upstream hay propuestas abiertas para la rama principal y la rama 2.x: PR #238 (https://github.com/micromatch/picomatch/pull/238) y PR #246 (https://github.com/micromatch/picomatch/pull/246). Ninguna equivale a un release npm verificable. Por eso no se aplica un fork, un parche de procedencia no verificada ni un downgrade a una rama de Vite 6 que introduce otras vulnerabilidades conocidas.

Mitigaciones actuales:

- vite permanece en la rama 8.3.x y @vitejs/plugin-react en 6.3.x.
- El servidor Vite está configurado explícitamente con --host 127.0.0.1; no publicarlo con 0.0.0.0 ni a través de un proxy de red.
- La API del Control Center rechaza solicitudes originadas en sitios externos.
- La auditoría automatizada solo permite esta cadena conocida. Un hallazgo adicional de severidad alta/crítica, una vulnerabilidad de producción o una dependencia que no pueda trazarse hasta esta alerta hace fallar npm run verify.

La excepción se debe retirar tan pronto como exista una versión oficial corregida de picomatch y toda la cadena de dependencias se haya actualizado y vuelto a probar.

## Puerta de calidad

Antes del despliegue:

~~~bash
npm run verify
npm run deploy
~~~

verify ejecuta pruebas de API, persistencia, decisiones, permisos, handoffs, seguridad de solicitudes, MCP, fingerprint, auditoría de dependencias, typecheck, validación Python y verificación real del registro de agentes. deploy solo reinicia el servicio después de superar esa puerta, y exige que el fingerprint cargado por el proceso coincida con el artefacto compilado en disco.
