import { getSupabaseFunctionHeaders, supabase } from "../supabase";
import { authService } from "../auth";

export class EdgeFunctionError extends Error {
  status: number;
  code: string;
  details?: unknown;
  requestId?: string;

  constructor(message: string, status: number, code: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "EdgeFunctionError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

interface InvokeEdgeOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  signOutOnUnauthorized?: boolean;
  requireAuth?: boolean;
}

interface InvokeEdgeGetOptions extends InvokeEdgeOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
}

interface ErrorResponseBody {
  error?:
    | {
        code?: string;
        message?: string;
        details?: unknown;
        requestId?: string;
      }
    | string;
  code?: string | number;
  message?: string;
  details?: unknown;
  requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 18_000;
const DEFAULT_RETRIES = 1;
const DEV_SUPABASE_PROXY_PREFIX = "/__supabase";
const EDGE_UNAUTHORIZED_COOLDOWN_MS = 45_000;

let edgeUnauthorizedCooldownUntil = 0;

function shouldUseDevSupabaseProxy(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const host = String(window.location.hostname ?? "").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

function getFunctionBaseUrl(): string {
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  if (!supabaseUrl) {
    throw new Error("VITE_SUPABASE_URL nao configurada.");
  }

  if (shouldUseDevSupabaseProxy()) {
    return `${DEV_SUPABASE_PROXY_PREFIX}/functions/v1`;
  }

  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildEdgeUrl(
  functionName: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const baseUrl = `${getFunctionBaseUrl()}/${functionName}`;
  const url = /^https?:\/\//i.test(baseUrl)
    ? new URL(baseUrl)
    : new URL(baseUrl, window.location.origin);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function shouldRetry(error: unknown, attempt: number, maxRetries: number): boolean {
  if (attempt >= maxRetries) {
    return false;
  }

  if (error instanceof EdgeFunctionError) {
    return error.status >= 500 || error.status === 429;
  }

  return true;
}

function toEdgeFunctionError(response: Response, payload: unknown): EdgeFunctionError {
  const parsed = (payload ?? {}) as ErrorResponseBody;
  const status = response.status;

  const nestedError = typeof parsed.error === "object" && parsed.error !== null ? parsed.error : null;
  const flatError = typeof parsed.error === "string" ? parsed.error : null;
  const code = String(nestedError?.code ?? flatError ?? parsed.code ?? `HTTP_${status}`);
  const message =
    String(nestedError?.message ?? parsed.message ?? "Falha na chamada da Edge Function.").trim() ||
    "Falha na chamada da Edge Function.";
  const details = nestedError?.details ?? parsed.details;
  const requestId = nestedError?.requestId ?? parsed.requestId;

  return new EdgeFunctionError(message, status, code, details, requestId);
}

function getHeaderValueCaseInsensitive(headers: Record<string, string>, name: string): string | null {
  const target = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      const normalized = String(value ?? "").trim();
      return normalized || null;
    }
  }
  return null;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  const normalized = String(authorizationHeader ?? "").trim();
  if (!normalized) {
    return null;
  }

  return normalized.replace(/^bearer\s+/i, "").trim() || null;
}

function isUnauthorizedEdgeError(error: unknown): boolean {
  if (!(error instanceof EdgeFunctionError)) {
    return false;
  }

  if (error.status !== 401 && error.status !== 403) {
    return false;
  }

  const code = String(error.code ?? "").trim().toUpperCase();
  const message = String(error.message ?? "").trim().toLowerCase();
  return (
    code === "INVALID_TOKEN" ||
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    message.includes("invalid jwt") ||
    message.includes("sessao invalida") ||
    message.includes("sessão inválida") ||
    (message.includes("token") && message.includes("expirad"))
  );
}

function buildMissingEdgeAuthError(): EdgeFunctionError {
  return new EdgeFunctionError("Sessao invalida ou expirada.", 401, "UNAUTHENTICATED");
}

function isEdgeUnauthorizedCooldownActive(): boolean {
  return edgeUnauthorizedCooldownUntil > Date.now();
}

function activateEdgeUnauthorizedCooldown(): void {
  edgeUnauthorizedCooldownUntil = Date.now() + EDGE_UNAUTHORIZED_COOLDOWN_MS;
}

function clearEdgeUnauthorizedCooldown(): void {
  edgeUnauthorizedCooldownUntil = 0;
}

export async function invokeEdgeJson<TRequest, TResponse>(
  functionName: string,
  payload: TRequest,
  options: InvokeEdgeOptions = {},
): Promise<TResponse> {
  return invokeEdgeRequest<TResponse>(
    functionName,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
    options,
  );
}

export async function invokeEdgeGet<TResponse>(
  functionName: string,
  options: InvokeEdgeGetOptions = {},
): Promise<TResponse> {
  const { query, ...requestOptions } = options;
  return invokeEdgeRequest<TResponse>(
    functionName,
    {
      method: "GET",
      query,
    },
    requestOptions,
  );
}

async function invokeEdgeRequest<TResponse>(
  functionName: string,
  request: {
    method: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | null | undefined>;
  },
  options: InvokeEdgeOptions = {},
): Promise<TResponse> {
  if (options.requireAuth && isEdgeUnauthorizedCooldownActive()) {
    throw buildMissingEdgeAuthError();
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(options.retries) ? Math.max(0, Number(options.retries)) : DEFAULT_RETRIES;
  const baseRequestHeaders: Record<string, string> = {
    ...(request.headers ?? {}),
    ...(options.headers ?? {}),
  };

  const url = buildEdgeUrl(functionName, request.query);
  let attempt = 0;
  let didRefreshSupabaseSession = false;

  for (;;) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);
    let currentAccessToken: string | null = null;

    const abortListener = () => {
      controller.abort(options.signal?.reason);
    };

    try {
      options.signal?.addEventListener("abort", abortListener, { once: true });
      const functionHeaders = await getSupabaseFunctionHeaders({
        requireAuth: Boolean(options.requireAuth),
      });
      const baseHeaders = {
        ...(baseRequestHeaders ?? {}),
        ...(functionHeaders ?? {}),
      };
      const requestHeaders: Record<string, string> = {
        ...baseHeaders,
      };
      currentAccessToken = extractBearerToken(getHeaderValueCaseInsensitive(requestHeaders, "authorization"));
      if (options.requireAuth && !currentAccessToken) {
        try {
          const refreshedSession = await authService.refreshSession();
          const refreshedToken = String(refreshedSession?.access_token ?? "").trim();
          if (refreshedToken) {
            continue;
          }
        } catch {
          // Fall through to standard missing auth error handling below.
        }
        throw buildMissingEdgeAuthError();
      }

      const response = await fetch(url, {
        method: request.method,
        headers: requestHeaders,
        ...(request.body ? { body: request.body } : {}),
        signal: controller.signal,
      });

      const parsedPayload = await parseJsonSafe(response);

      if (!response.ok) {
        throw toEdgeFunctionError(response, parsedPayload);
      }

      clearEdgeUnauthorizedCooldown();

      return parsedPayload as TResponse;
    } catch (error) {
      if (isUnauthorizedEdgeError(error) && !didRefreshSupabaseSession) {
        didRefreshSupabaseSession = true;
        try {
          const refreshedSession = await authService.refreshSession();
          const refreshedAccessToken = String(refreshedSession?.access_token ?? "").trim() || null;
          if (refreshedAccessToken) {
            clearEdgeUnauthorizedCooldown();
            continue;
          }
          activateEdgeUnauthorizedCooldown();
        } catch {
          activateEdgeUnauthorizedCooldown();
          // Fall through to the standard error handling below.
        }
      }

      if (isUnauthorizedEdgeError(error) && options.requireAuth) {
        await authService.clearLocalSession().catch(() => undefined);
      } else if (isUnauthorizedEdgeError(error) && options.signOutOnUnauthorized) {
        void supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      }

      if (!shouldRetry(error, attempt, retries)) {
        if (error instanceof EdgeFunctionError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : "Falha de rede ao chamar a Edge Function.";
        throw new EdgeFunctionError(message, 0, "EDGE_NETWORK_ERROR");
      }

      attempt += 1;
      const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 6_000);
      await wait(backoffMs);
    } finally {
      window.clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortListener);
    }
  }
}
