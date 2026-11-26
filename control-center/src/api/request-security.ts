export const DEFAULT_CONTROL_CENTER_API_PORT = 4141;
export const VITE_DEV_SERVER_PORT = 5173;

/** Hosts de bucle en los que el Control Center acepta orígenes de navegador. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

/**
 * Orígenes confiables con la configuración por defecto (sin `FACTORY_API_PORT`):
 * el servidor de desarrollo de Vite y el puerto por defecto de la API.
 */
export const ALLOWED_BROWSER_ORIGINS: ReadonlySet<string> = new Set([
  `http://127.0.0.1:${VITE_DEV_SERVER_PORT}`,
  `http://localhost:${VITE_DEV_SERVER_PORT}`,
  `http://127.0.0.1:${DEFAULT_CONTROL_CENTER_API_PORT}`,
  `http://localhost:${DEFAULT_CONTROL_CENTER_API_PORT}`
]);

/**
 * Puerto efectivo de la API validado de `FACTORY_API_PORT` (1..65535).
 * Cualquier valor ausente o inválido cae al puerto por defecto: nunca se
 * acepta un puerto fuera de rango ni no numérico.
 */
export function effectiveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_API_PORT;
  if (typeof raw !== "string") return DEFAULT_CONTROL_CENTER_API_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CONTROL_CENTER_API_PORT;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_CONTROL_CENTER_API_PORT;
  }
  return port;
}

/**
 * Orígenes permitidos para el puerto efectivo actual: Vite (5173), el
 * puerto por defecto (4141) y el puerto validado de `FACTORY_API_PORT`,
 * SOLO para hosts de bucle. Se recalcula en cada llamada (sin cachear el
 * entorno) para que los tests y los reinicios vean el valor vigente.
 */
export function allowedBrowserOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set(ALLOWED_BROWSER_ORIGINS);
  const port = effectiveApiPort(env);
  for (const host of LOOPBACK_HOSTS) {
    origins.add(`http://${host}:${port}`);
  }
  return origins;
}

export interface RequestSecurityInput {
  origin?: string | null;
  secFetchSite?: string | null;
}

export interface RequestSecurityResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Prevent cross-origin websites (including DNS-rebinding origins) from
 * issuing state-changing requests to the loopback control plane.
 * Requests without browser provenance remain available to local CLI clients.
 *
 * @param env Entorno vigente; se lee en cada invocación (sin cachear).
 */
export function inspectRequestSecurity(
  input: RequestSecurityInput,
  env: NodeJS.ProcessEnv = process.env
): RequestSecurityResult {
  const site = input.secFetchSite?.trim().toLowerCase() ?? "";
  if (site === "cross-site") {
    return { allowed: false, reason: "Las solicitudes cross-site no pueden acceder al Control Center local." };
  }

  const origin = input.origin?.trim();
  if (origin) {
    if (origin === "null" || !allowedBrowserOrigins(env).has(origin)) {
      return { allowed: false, reason: "El origen del navegador no está autorizado para el Control Center local." };
    }
  }

  return { allowed: true, reason: null };
}

export const CONTROL_CENTER_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'"
  ].join("; ")
} as const;
