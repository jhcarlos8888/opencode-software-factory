export const ALLOWED_BROWSER_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4141",
  "http://localhost:4141"
]);

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
 */
export function inspectRequestSecurity(input: RequestSecurityInput): RequestSecurityResult {
  const site = input.secFetchSite?.trim().toLowerCase() ?? "";
  if (site === "cross-site") {
    return { allowed: false, reason: "Las solicitudes cross-site no pueden acceder al Control Center local." };
  }

  const origin = input.origin?.trim();
  if (origin) {
    if (origin === "null" || !ALLOWED_BROWSER_ORIGINS.has(origin)) {
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
