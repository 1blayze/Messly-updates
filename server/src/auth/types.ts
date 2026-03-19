import type { IncomingMessage } from "node:http";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { RateLimiter } from "../edge/rateLimiter";
import type { SessionClientInfo, AuthSessionManager } from "../sessions/sessionManager";
import type { GatewayEnv } from "../infra/env";
import type { Logger } from "../infra/logger";
import { extractClientIpFromHeaders } from "../sessions/loginLocation";

export interface AuthDependencies {
  adminSupabase: SupabaseClient;
  createPublicSupabase: () => SupabaseClient;
  sessionManager: AuthSessionManager;
  rateLimiter: RateLimiter;
  env: GatewayEnv;
  logger?: Logger;
}

export interface AuthRequestContext {
  ipAddress: string;
  userAgent: string | null;
  origin: string | null;
  authorizationToken: string | null;
}

export interface SignupProfileInput {
  displayName?: string | null;
  username?: string | null;
}

export interface SignupRequestBody {
  email?: string;
  password?: string;
  turnstileToken?: string;
  registrationFingerprint?: string;
  profile?: SignupProfileInput | null;
  client?: SessionClientInfo | null;
}

export interface ResendVerificationRequestBody {
  email?: string;
}

export interface LoginRequestBody {
  email?: string;
  password?: string;
  turnstileToken?: string;
  loginFingerprint?: string;
  client?: SessionClientInfo | null;
}

export interface VerifyEmailRequestBody {
  email?: string;
  code?: string;
  client?: SessionClientInfo | null;
}

export interface SerializedAuthUser {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
}

export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number | null;
  user: SerializedAuthUser;
}

export function serializeAuthUser(user: User): SerializedAuthUser {
  return {
    id: user.id,
    email: user.email ?? null,
    email_confirmed_at: user.email_confirmed_at ?? user.confirmed_at ?? null,
    last_sign_in_at: user.last_sign_in_at ?? null,
    user_metadata: ((user.user_metadata ?? {}) as Record<string, unknown>) ?? {},
  };
}

export function readAuthRequestContext(request: IncomingMessage): AuthRequestContext {
  const ipAddress = extractClientIpFromHeaders(request.headers, String(request.socket.remoteAddress ?? "").trim());
  const authorization = String(request.headers.authorization ?? "").trim();
  const authorizationToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || null
    : null;

  return {
    ipAddress,
    userAgent: String(request.headers["user-agent"] ?? "").trim() || null,
    origin: String(request.headers.origin ?? "").trim() || null,
    authorizationToken,
  };
}
