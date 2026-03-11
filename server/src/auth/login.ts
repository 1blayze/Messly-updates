import { normalizeEmail } from "./crypto";
import { AuthHttpError, assertRateLimit } from "./http";
import { ensureAuthUserProfile } from "./profileProvisioning";
import type { AuthDependencies, AuthRequestContext, AuthTokenResponse, LoginRequestBody } from "./types";
import { serializeAuthUser } from "./types";
import type { User } from "@supabase/supabase-js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_WINDOW_MS = 15 * 60_000;

function mapLoginError(error: unknown): AuthHttpError {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  const normalized = message.toLowerCase();

  if (normalized.includes("email not confirmed")) {
    return new AuthHttpError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before logging in.");
  }
  if (normalized.includes("invalid login credentials")) {
    return new AuthHttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (normalized.includes("rate limit") || normalized.includes("too many")) {
    return new AuthHttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts. Try again later.");
  }

  return new AuthHttpError(502, "AUTH_PROVIDER_ERROR", message || "Supabase login failed.");
}

function normalizeLoginInput(body: LoginRequestBody): {
  email: string;
  password: string;
} {
  const email = normalizeEmail(body.email ?? "");
  const password = String(body.password ?? "");
  if (!EMAIL_REGEX.test(email)) {
    throw new AuthHttpError(400, "INVALID_EMAIL", "A valid email is required.");
  }
  if (!password) {
    throw new AuthHttpError(400, "INVALID_PASSWORD", "Password is required.");
  }

  return { email, password };
}

export async function finalizeAuthSession(
  deps: AuthDependencies,
  context: AuthRequestContext,
  input: {
    session: {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      expires_at?: number | null;
    };
    user: User;
    client?: LoginRequestBody["client"];
  },
): Promise<AuthTokenResponse> {
  try {
    await ensureAuthUserProfile(deps, input.user);
    await deps.sessionManager.upsertFromAccessToken({
      accessToken: input.session.access_token,
      userId: input.user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      client: input.client ?? null,
    });
  } catch (sessionError) {
    try {
      await deps.adminSupabase.auth.admin.signOut(input.session.access_token, "local");
    } catch {
      // Ignore best-effort cleanup failure.
    }

    throw new AuthHttpError(
      503,
      "SESSION_REGISTRATION_FAILED",
      "The session was created but could not be registered for Messly.",
      sessionError instanceof Error ? sessionError.message : String(sessionError),
    );
  }

  return {
    access_token: input.session.access_token,
    refresh_token: input.session.refresh_token,
    token_type: input.session.token_type,
    expires_in: input.session.expires_in,
    expires_at: input.session.expires_at ?? null,
    user: serializeAuthUser(input.user),
  };
}

export async function completePasswordLogin(
  deps: AuthDependencies,
  context: AuthRequestContext,
  input: {
    email: string;
    password: string;
    client?: LoginRequestBody["client"];
  },
): Promise<AuthTokenResponse> {
  const publicSupabase = deps.createPublicSupabase();
  const loginResult = await publicSupabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (loginResult.error || !loginResult.data.session || !loginResult.data.user) {
    throw mapLoginError(loginResult.error);
  }

  return finalizeAuthSession(deps, context, {
    session: loginResult.data.session,
    user: loginResult.data.user,
    client: input.client ?? null,
  });
}

export async function handleLogin(
  deps: AuthDependencies,
  context: AuthRequestContext,
  body: LoginRequestBody,
): Promise<AuthTokenResponse> {
  const { email, password } = normalizeLoginInput(body);

  await assertRateLimit(deps.rateLimiter, [
    {
      key: `auth:login:ip:${context.ipAddress}`,
      limit: 20,
      windowMs: LOGIN_WINDOW_MS,
    },
    {
      key: `auth:login:email:${email}`,
      limit: 12,
      windowMs: LOGIN_WINDOW_MS,
    },
  ]);

  return completePasswordLogin(deps, context, {
    email,
    password,
    client: body.client ?? null,
  });
}

export async function handleLogout(
  deps: AuthDependencies,
  context: AuthRequestContext,
): Promise<{ revoked: boolean }> {
  const accessToken = String(context.authorizationToken ?? "").trim();
  if (!accessToken) {
    throw new AuthHttpError(401, "UNAUTHENTICATED", "A bearer access token is required.");
  }

  const authResult = await deps.adminSupabase.auth.getUser(accessToken);
  if (authResult.error || !authResult.data.user) {
    throw new AuthHttpError(401, "UNAUTHENTICATED", "The access token is invalid.");
  }

  const revoked = await deps.sessionManager.revokeCurrentAccessToken(accessToken, authResult.data.user.id);
  return { revoked };
}
