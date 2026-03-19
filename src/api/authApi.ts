import { getGatewayUrl } from "./client";
import { getApiBaseUrl } from "../config/domains";
import { getRuntimeAuthApiUrl } from "../config/runtimeApiConfig";
import { getSessionClientDescriptor, type SessionClientDescriptor } from "../services/security/sessionClientInfo";

const DEFAULT_TIMEOUT_MS = 18_000;

export class AuthApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, code: string, details?: unknown, retryAfterSeconds?: number | null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

export interface AuthClientDescriptor {
  name: string;
  version: string;
  platform: string;
  clientType: SessionClientDescriptor["clientType"];
  deviceId: string;
  userAgent?: string;
}

export interface SignupApiRequest {
  email: string;
  password: string;
  turnstileToken: string;
  registrationFingerprint: string;
  profile?: {
    displayName?: string | null;
    username?: string | null;
  };
  client: AuthClientDescriptor;
}

export interface SignupApiResponse {
  status: "verification_required";
  email: string;
  expires_at: string;
  max_attempts: number;
}

export interface LoginApiRequest {
  email: string;
  password: string;
  turnstileToken?: string;
  loginFingerprint?: string;
  client: AuthClientDescriptor;
}

export interface VerifyEmailApiRequest {
  email: string;
  code: string;
  client: AuthClientDescriptor;
}

export interface AuthTokenApiResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number | null;
  user: {
    id: string;
    email: string | null;
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    user_metadata: Record<string, unknown>;
  };
}

interface ErrorPayload {
  error?:
    | {
        code?: string;
        message?: string;
        details?: unknown;
      }
    | string;
}

function normalizeBaseUrl(valueRaw: string): string | null {
  const value = String(valueRaw ?? "").trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() === "www.messly.site") {
      parsed.hostname = "messly.site";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function normalizeApiBaseUrl(valueRaw: string): string | null {
  const normalized = normalizeBaseUrl(valueRaw);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "api.messly.site" || hostname === "messly.site" || hostname === "www.messly.site") {
      parsed.hostname = "gateway.messly.site";
      parsed.port = "";

      const normalizedPath = parsed.pathname.replace(/\/+$/, "");
      if (!normalizedPath || normalizedPath === "/" || normalizedPath === "/api") {
        parsed.pathname = "";
      } else if (normalizedPath.startsWith("/api/")) {
        const withoutApiPrefix = normalizedPath.slice(4);
        parsed.pathname = withoutApiPrefix || "/";
      } else {
        parsed.pathname = normalizedPath;
      }
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function isLocalHostname(hostnameRaw: string): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function toHttpBaseFromGatewayUrl(gatewayUrlRaw: string): string | null {
  const gatewayUrl = normalizeBaseUrl(gatewayUrlRaw);
  if (!gatewayUrl) {
    return null;
  }

  try {
    const parsed = new URL(gatewayUrl);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    }
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function deriveAuthApiBaseUrl(): string {
  const explicitUrl = normalizeApiBaseUrl(String(import.meta.env.VITE_MESSLY_AUTH_API_URL ?? ""));
  if (explicitUrl) {
    return explicitUrl;
  }

  const runtimeConfiguredUrl = normalizeApiBaseUrl(getRuntimeAuthApiUrl() ?? "");
  if (runtimeConfiguredUrl) {
    return runtimeConfiguredUrl;
  }

  const gatewayBaseUrl = toHttpBaseFromGatewayUrl(getGatewayUrl() ?? "");
  if (gatewayBaseUrl) {
    try {
      const hostname = new URL(gatewayBaseUrl).hostname;
      if (isLocalHostname(hostname)) {
        return gatewayBaseUrl;
      }
    } catch {
      // Ignore malformed URL and use API base fallback.
    }
  }

  const apiBaseUrl = normalizeApiBaseUrl(getApiBaseUrl());
  if (apiBaseUrl) {
    return apiBaseUrl;
  }

  return gatewayBaseUrl ?? "";
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toAuthApiError(response: Response, payload: unknown): AuthApiError {
  const parsed = (payload ?? {}) as ErrorPayload;
  const nested = typeof parsed.error === "object" && parsed.error !== null ? parsed.error : null;
  const code = String(nested?.code ?? parsed.error ?? `HTTP_${response.status}`).trim() || `HTTP_${response.status}`;
  const message =
    String(nested?.message ?? "Authentication request failed.").trim() || "Authentication request failed.";
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
  return new AuthApiError(message, response.status, code, nested?.details, retryAfterSeconds);
}

async function postJson<TResponse>(
  path: string,
  payload: unknown,
  options: {
    accessToken?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<TResponse> {
  const requestUrl = `${deriveAuthApiBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort(new DOMException("Request timeout", "TimeoutError"));
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
    };
    const accessToken = String(options.accessToken ?? "").trim();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const parsed = await parseJsonSafe(response);
    if (!response.ok) {
      throw toAuthApiError(response, parsed);
    }
    return parsed as TResponse;
  } catch (error) {
    if (error instanceof AuthApiError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Network failure during authentication.";
    throw new AuthApiError(message, 0, "AUTH_NETWORK_ERROR", {
      url: requestUrl,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function buildAuthClientDescriptor(): AuthClientDescriptor {
  return getSessionClientDescriptor(String(import.meta.env.VITE_MESSLY_GATEWAY_CLIENT_VERSION ?? "0.0.5"));
}

export async function signup(payload: SignupApiRequest): Promise<SignupApiResponse> {
  return postJson<SignupApiResponse>("/auth/signup", payload);
}

export async function resendVerification(email: string): Promise<SignupApiResponse> {
  return postJson<SignupApiResponse>("/auth/resend-verification", {
    email,
  });
}

export async function verifyEmail(payload: VerifyEmailApiRequest): Promise<AuthTokenApiResponse> {
  return postJson<AuthTokenApiResponse>("/auth/verify-email", payload);
}

export async function login(payload: LoginApiRequest): Promise<AuthTokenApiResponse> {
  return postJson<AuthTokenApiResponse>("/auth/login", payload);
}

export async function logout(accessToken: string): Promise<{ revoked: boolean }> {
  return postJson<{ revoked: boolean }>(
    "/auth/logout",
    {},
    {
      accessToken,
    },
  );
}
