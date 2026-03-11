/// <reference path="./edge-runtime.d.ts" />
import { getCorsHeaders as resolveCorsHeaders } from "./cors.ts";

export interface RequestContext {
  requestId: string;
  route: string;
  startedAt: number;
  uid?: string;
  action?: string;
}

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sanitizeRequestId(valueRaw: string | null): string | null {
  const value = String(valueRaw ?? "")
    .trim()
    .slice(0, 128);
  if (!value) {
    return null;
  }

  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
    return null;
  }

  return value;
}

export function getCorsHeaders(request: Request): Headers {
  return resolveCorsHeaders(request);
}

export function responseJson(request: Request, payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = getCorsHeaders(request);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");

  if (extraHeaders) {
    const additional = new Headers(extraHeaders);
    additional.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export function responseNoContent(request: Request, status = 204): Response {
  const headers = getCorsHeaders(request);
  headers.set("cache-control", "no-store");
  return new Response(null, {
    status,
    headers,
  });
}

export function responseError(request: Request, context: RequestContext, error: unknown): Response {
  const normalized = normalizeError(error);
  const payload: ErrorPayload = {
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
      requestId: context.requestId,
    },
  };

  return responseJson(request, payload, normalized.status);
}

function normalizeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  const message = error instanceof Error ? error.message : String(error ?? "Unexpected server error");
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message,
  };
}

export function isOptionsRequest(request: Request): boolean {
  return request.method.toUpperCase() === "OPTIONS";
}

export function createRequestContext(route: string, request?: Request): RequestContext {
  const requestId = request
    ? sanitizeRequestId(request.headers.get("sb-request-id")) ??
      sanitizeRequestId(request.headers.get("x-request-id")) ??
      crypto.randomUUID()
    : crypto.randomUUID();

  return {
    requestId,
    route,
    startedAt: Date.now(),
  };
}

export function getElapsedMs(context: RequestContext): number {
  return Math.max(0, Date.now() - context.startedAt);
}

export function logStructured(
  level: "info" | "warn" | "error",
  message: string,
  context: RequestContext,
  extras?: Record<string, unknown>,
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    route: context.route,
    requestId: context.requestId,
    uid: context.uid ?? null,
    action: context.action ?? null,
    latencyMs: getElapsedMs(context),
    ...(extras ?? {}),
  };

  const encoded = JSON.stringify(payload);
  if (level === "error") {
    console.error(encoded);
    return;
  }

  if (level === "warn") {
    console.warn(encoded);
    return;
  }

  console.log(encoded);
}

export async function parseJsonBody<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "Limite de body invalido.");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Body excede o limite permitido.");
    }
  }

  try {
    const rawBody = await request.text();
    const bodySize = new TextEncoder().encode(rawBody).byteLength;
    if (bodySize > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Body excede o limite permitido.");
    }

    return JSON.parse(rawBody) as T;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "INVALID_JSON", "Corpo JSON invalido.");
  }
}

export function assertMethod(request: Request, method: "GET" | "POST"): void {
  if (request.method.toUpperCase() !== method) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Metodo ${request.method} nao permitido.`);
  }
}
