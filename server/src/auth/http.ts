import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayEnv } from "../infra/env";
import type { RateLimiter } from "../edge/rateLimiter";

export class AuthHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

function isElectronOrigin(originRaw: string): boolean {
  const origin = String(originRaw ?? "").trim().toLowerCase();
  return origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || origin.startsWith("messly://");
}

export function resolveCorsHeaders(origin: string | null, env: GatewayEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };

  const normalizedOrigin = String(origin ?? "").trim();
  if (!normalizedOrigin) {
    return headers;
  }

  if (env.allowedOrigins.includes(normalizedOrigin)) {
    headers["access-control-allow-origin"] = normalizedOrigin;
    return headers;
  }

  if (env.allowElectronOrigin && isElectronOrigin(normalizedOrigin)) {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }

  throw new AuthHttpError(403, "ORIGIN_NOT_ALLOWED", "Origin not allowed.");
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {} as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AuthHttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  corsHeaders: Record<string, string>,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders,
    ...(extraHeaders ?? {}),
  });
  response.end(JSON.stringify(payload));
}

export function writeEmpty(
  response: ServerResponse,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    ...corsHeaders,
    ...(extraHeaders ?? {}),
  });
  response.end();
}

export async function assertRateLimit(
  rateLimiter: RateLimiter,
  buckets: Array<{
    key: string;
    limit: number;
    windowMs: number;
  }>,
): Promise<void> {
  for (const bucket of buckets) {
    const outcome = await rateLimiter.consume(bucket.key, bucket.limit, bucket.windowMs);
    if (!outcome.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
      throw new AuthHttpError(
        429,
        "AUTH_RATE_LIMITED",
        "Too many authentication attempts. Try again later.",
        {
          retry_after_ms: outcome.retryAfterMs,
          limit: bucket.limit,
          window_ms: bucket.windowMs,
        },
        {
          "retry-after": String(retryAfterSeconds),
        },
      );
    }
  }
}
