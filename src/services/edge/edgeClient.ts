import { getAuthenticatedEdgeHeaders, type EdgeAuthMode } from "../auth/firebaseToken";

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
}

interface ErrorResponseBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
  code?: string | number;
  message?: string;
  details?: unknown;
  requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 18_000;
const DEFAULT_RETRIES = 1;

function getFunctionBaseUrl(): string {
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  if (!supabaseUrl) {
    throw new Error("VITE_SUPABASE_URL nao configurada.");
  }

  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
  const code = String(parsed.error?.code ?? parsed.code ?? `HTTP_${status}`);
  const message =
    String(parsed.error?.message ?? parsed.message ?? "Falha na chamada da Edge Function.").trim() ||
    "Falha na chamada da Edge Function.";
  const details = parsed.error?.details ?? parsed.details;
  const requestId = parsed.error?.requestId ?? parsed.requestId;

  return new EdgeFunctionError(message, status, code, details, requestId);
}

function shouldRetryWithSupabaseAuth(error: unknown, alreadyRetried: boolean): boolean {
  if (alreadyRetried || !(error instanceof EdgeFunctionError)) {
    return false;
  }

  if (error.status !== 401) {
    return false;
  }

  const normalized = `${error.code} ${error.message}`.toLowerCase();
  return (
    normalized.includes("invalid jwt") ||
    normalized.includes("jwt") ||
    normalized.includes("http_401") ||
    normalized.includes("unauthorized")
  );
}

export async function invokeEdgeJson<TRequest, TResponse>(
  functionName: string,
  payload: TRequest,
  options: InvokeEdgeOptions = {},
): Promise<TResponse> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(options.retries) ? Math.max(0, Number(options.retries)) : DEFAULT_RETRIES;
  const baseRequestHeaders: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...(options.headers ?? {}),
  };

  const url = `${getFunctionBaseUrl()}/${functionName}`;
  let attempt = 0;
  let authMode: EdgeAuthMode = "firebase";
  let retriedWithRefreshedFirebaseToken = false;
  let retriedWithSupabaseAuth = false;

  for (;;) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeoutMs);

    const abortListener = () => {
      controller.abort(options.signal?.reason);
    };

    try {
      options.signal?.addEventListener("abort", abortListener, { once: true });
      const baseHeaders = await getAuthenticatedEdgeHeaders(baseRequestHeaders, {
        mode: authMode,
        forceRefresh: authMode === "firebase" && retriedWithRefreshedFirebaseToken,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const parsedPayload = await parseJsonSafe(response);

      if (!response.ok) {
        throw toEdgeFunctionError(response, parsedPayload);
      }

      return parsedPayload as TResponse;
    } catch (error) {
      if (shouldRetryWithSupabaseAuth(error, false) && !retriedWithRefreshedFirebaseToken && authMode === "firebase") {
        retriedWithRefreshedFirebaseToken = true;
        continue;
      }

      if (shouldRetryWithSupabaseAuth(error, retriedWithSupabaseAuth)) {
        retriedWithSupabaseAuth = true;
        authMode = "supabase";
        continue;
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
