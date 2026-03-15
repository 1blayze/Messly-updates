/// <reference path="./edge-runtime.d.ts" />

const DEV_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;
const ALLOWED_HEADERS =
  "authorization, apikey, content-type, x-client-info, x-firebase-authorization, x-media-key, x-requested-with, x-presign-expires";
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const CORS_MAX_AGE_SECONDS = "86400";

interface ParsedCorsEnv {
  allowedOrigins: string[];
  allowElectronOrigin: boolean;
  allowCredentials: boolean;
}

export interface CorsEvaluation {
  requestOrigin: string | null;
  isAllowed: boolean;
  allowCredentials: boolean;
  headers: Headers;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseCsvEnv(name: string): string[] {
  const raw = String(Deno.env.get(name) ?? "").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDevelopmentEnvironment(): boolean {
  const explicitEnvironment = String(
    Deno.env.get("EDGE_ENV") ??
      Deno.env.get("ENVIRONMENT") ??
      Deno.env.get("NODE_ENV") ??
      Deno.env.get("DENO_ENV") ??
      "",
  )
    .trim()
    .toLowerCase();

  if (["development", "dev", "local"].includes(explicitEnvironment)) {
    return true;
  }

  if (["production", "prod"].includes(explicitEnvironment)) {
    return false;
  }

  if (String(Deno.env.get("DENO_DEPLOYMENT_ID") ?? "").trim()) {
    return false;
  }

  return true;
}

function parseCorsEnv(): ParsedCorsEnv {
  const configuredOrigins = parseCsvEnv("ALLOWED_ORIGINS");
  const legacyConfiguredOrigins = parseCsvEnv("CORS_ALLOWED_ORIGINS");
  const combinedConfiguredOrigins = Array.from(new Set([...configuredOrigins, ...legacyConfiguredOrigins]));

  const allowedOrigins = isDevelopmentEnvironment()
    ? Array.from(new Set([...DEV_ALLOWED_ORIGINS, ...combinedConfiguredOrigins]))
    : combinedConfiguredOrigins;

  return {
    allowedOrigins,
    allowElectronOrigin: parseBooleanEnv(Deno.env.get("ALLOW_ELECTRON_ORIGIN"), false),
    allowCredentials: parseBooleanEnv(Deno.env.get("CORS_ALLOW_CREDENTIALS"), false),
  };
}

function isElectronOrigin(origin: string): boolean {
  const normalized = origin.trim().toLowerCase();
  return (
    normalized === "app://." ||
    normalized.startsWith("app://") ||
    normalized.startsWith("file://") ||
    normalized === "null"
  );
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isOriginAllowed(origin: string, env: ParsedCorsEnv): boolean {
  if (env.allowElectronOrigin && (isElectronOrigin(origin) || isLoopbackHttpOrigin(origin))) {
    return true;
  }

  if (env.allowedOrigins.length === 0) {
    return true;
  }

  return env.allowedOrigins.includes(origin);
}

export function evaluateCorsRequest(request: Request): CorsEvaluation {
  const env = parseCorsEnv();
  const requestOrigin = request.headers.get("origin")?.trim() || null;
  const isAllowed = !requestOrigin || isOriginAllowed(requestOrigin, env);
  const headers = new Headers();

  headers.set("access-control-allow-headers", ALLOWED_HEADERS);
  headers.set("access-control-allow-methods", ALLOWED_METHODS);
  headers.set("access-control-max-age", CORS_MAX_AGE_SECONDS);
  headers.set("vary", "Origin");

  if (requestOrigin) {
    headers.set("access-control-allow-origin", requestOrigin);
    if (env.allowCredentials) {
      headers.set("access-control-allow-credentials", "true");
    }
  }

  return {
    requestOrigin,
    isAllowed,
    allowCredentials: env.allowCredentials,
    headers,
  };
}

export function getCorsHeaders(request: Request): Headers {
  return evaluateCorsRequest(request).headers;
}
