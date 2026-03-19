import { normalizeEmail } from "./crypto";
import { AuthHttpError, assertRateLimit } from "./http";
import { ensureAuthUserProfile } from "./profileProvisioning";
import type { AuthDependencies, AuthRequestContext, AuthTokenResponse, LoginRequestBody } from "./types";
import { serializeAuthUser } from "./types";
import type { User } from "@supabase/supabase-js";
import { verifyTurnstile, type TurnstileFailureReason } from "../security/verifyTurnstile";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_CAPTCHA_AFTER_FAILURES = 3;
const LOGIN_PROGRESSIVE_DELAY_BASE_MS = 200;
const LOGIN_PROGRESSIVE_DELAY_MAX_MS = 2_500;
const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
const LOGIN_FINGERPRINT_REGEX = /^[a-f0-9]{64}$/;
const LOGIN_ERROR_MESSAGE = "Unable to complete login. Please try again later.";

interface LoginFailureState {
  count: number;
  lastFailureAt: number;
}

const loginFailureBuckets = new Map<string, LoginFailureState>();

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

function mapLoginCaptchaError(reason: TurnstileFailureReason): AuthHttpError {
  switch (reason) {
    case "captcha_missing":
      return new AuthHttpError(400, "CAPTCHA_REQUIRED", LOGIN_ERROR_MESSAGE);
    case "captcha_expired":
      return new AuthHttpError(400, "CAPTCHA_EXPIRED", LOGIN_ERROR_MESSAGE);
    case "captcha_timeout":
      return new AuthHttpError(403, "CAPTCHA_TIMEOUT", LOGIN_ERROR_MESSAGE);
    case "captcha_network_error":
      return new AuthHttpError(403, "CAPTCHA_NETWORK_ERROR", LOGIN_ERROR_MESSAGE);
    case "captcha_misconfigured":
    case "captcha_response_invalid":
    case "captcha_invalid":
    default:
      return new AuthHttpError(403, "CAPTCHA_INVALID", LOGIN_ERROR_MESSAGE);
  }
}

function normalizeTurnstileToken(tokenRaw: unknown): string | null {
  const token = String(tokenRaw ?? "").trim();
  if (!token) {
    return null;
  }
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH || /\s/.test(token)) {
    throw new AuthHttpError(400, "INVALID_LOGIN_CONTEXT", "Invalid security verification token.");
  }
  return token;
}

function normalizeLoginFingerprint(fingerprintRaw: unknown): string | null {
  const fingerprint = String(fingerprintRaw ?? "").trim().toLowerCase();
  if (!fingerprint) {
    return null;
  }
  if (!LOGIN_FINGERPRINT_REGEX.test(fingerprint)) {
    throw new AuthHttpError(400, "INVALID_LOGIN_CONTEXT", "Invalid login fingerprint.");
  }
  return fingerprint;
}

function buildLoginFailureKeys(ipAddress: string, email: string, loginFingerprint: string | null): string[] {
  const keys = [`ip:${ipAddress}`, `email:${email}`, `pair:${ipAddress}:${email}`];
  if (loginFingerprint) {
    keys.push(`fingerprint:${loginFingerprint}`);
  }
  return keys;
}

function readFailureCount(key: string, now: number): number {
  const current = loginFailureBuckets.get(key);
  if (!current) {
    return 0;
  }
  if (now - current.lastFailureAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailureBuckets.delete(key);
    return 0;
  }
  return current.count;
}

function highestFailureCount(keys: string[], now: number): number {
  let highest = 0;
  for (const key of keys) {
    const count = readFailureCount(key, now);
    if (count > highest) {
      highest = count;
    }
  }
  return highest;
}

function registerFailure(keys: string[], now: number): number {
  let highest = 0;
  for (const key of keys) {
    const current = loginFailureBuckets.get(key);
    if (!current || now - current.lastFailureAt > LOGIN_FAILURE_WINDOW_MS) {
      loginFailureBuckets.set(key, {
        count: 1,
        lastFailureAt: now,
      });
      highest = Math.max(highest, 1);
      continue;
    }

    const nextCount = current.count + 1;
    loginFailureBuckets.set(key, {
      count: nextCount,
      lastFailureAt: now,
    });
    if (nextCount > highest) {
      highest = nextCount;
    }
  }
  return highest;
}

function clearFailures(keys: string[]): void {
  for (const key of keys) {
    loginFailureBuckets.delete(key);
  }
}

function computeProgressiveDelayMs(failureCount: number): number {
  if (failureCount <= 1) {
    return 0;
  }
  const exponentialSteps = Math.min(5, failureCount - 1);
  return Math.min(LOGIN_PROGRESSIVE_DELAY_MAX_MS, LOGIN_PROGRESSIVE_DELAY_BASE_MS * 2 ** exponentialSteps);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0 || atIndex === email.length - 1) {
    return "unknown";
  }
  return email.slice(atIndex + 1).toLowerCase();
}

function normalizeLoginInput(body: LoginRequestBody): {
  email: string;
  password: string;
  turnstileToken: string | null;
  loginFingerprint: string | null;
} {
  const email = normalizeEmail(body.email ?? "");
  const password = String(body.password ?? "");
  if (!EMAIL_REGEX.test(email)) {
    throw new AuthHttpError(400, "INVALID_EMAIL", "A valid email is required.");
  }
  if (password.length < 8) {
    throw new AuthHttpError(400, "INVALID_PASSWORD", "Password must have at least 8 characters.");
  }

  return {
    email,
    password,
    turnstileToken: normalizeTurnstileToken(body.turnstileToken),
    loginFingerprint: normalizeLoginFingerprint(body.loginFingerprint),
  };
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
      "The session was created but could not be registered for Azyoon.",
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

  if (loginResult.error) {
    throw mapLoginError(loginResult.error);
  }

  if (!loginResult.data.session || !loginResult.data.user) {
    throw new AuthHttpError(502, "INVALID_AUTH_RESPONSE", "Invalid authentication response from provider.");
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
  const { email, password, turnstileToken, loginFingerprint } = normalizeLoginInput(body);
  const failureKeys = buildLoginFailureKeys(context.ipAddress, email, loginFingerprint);
  const emailDomain = getEmailDomain(email);
  const previousFailures = highestFailureCount(failureKeys, Date.now());

  deps.logger?.info("login_payload_received", {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    emailDomain,
    hasTurnstileToken: Boolean(turnstileToken),
    hasLoginFingerprint: Boolean(loginFingerprint),
    failureCount: previousFailures,
    clientType: String(body.client?.clientType ?? "").trim() || null,
    clientPlatform: String(body.client?.platform ?? "").trim() || null,
  });

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

  const progressiveDelayMs = computeProgressiveDelayMs(previousFailures);
  if (progressiveDelayMs > 0) {
    await sleep(progressiveDelayMs);
  }

  const requiresCaptcha = previousFailures >= LOGIN_CAPTCHA_AFTER_FAILURES;
  if (requiresCaptcha || turnstileToken) {
    if (!turnstileToken) {
      deps.logger?.warn("login_captcha_required", {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        emailDomain,
        failureCount: previousFailures,
      });
      throw new AuthHttpError(400, "CAPTCHA_REQUIRED", LOGIN_ERROR_MESSAGE);
    }

    const captchaVerification = await verifyTurnstile({
      token: turnstileToken,
      secretKey: deps.env.turnstileSecretKey,
      remoteIp: context.ipAddress,
      logger: deps.logger,
    });

    deps.logger?.info("login_captcha_status", {
      status: captchaVerification.success ? "verified" : "failed",
      reason: captchaVerification.reason ?? null,
      emailDomain,
      ipAddress: context.ipAddress,
    });

    if (!captchaVerification.success) {
      const failedCount = registerFailure(failureKeys, Date.now());
      deps.logger?.warn("login_captcha_failed", {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        emailDomain,
        failureCount: failedCount,
        reason: captchaVerification.reason ?? "captcha_invalid",
      });
      throw mapLoginCaptchaError(captchaVerification.reason ?? "captcha_invalid");
    }
  }

  try {
    const response = await completePasswordLogin(deps, context, {
      email,
      password,
      client: body.client ?? null,
    });

    clearFailures(failureKeys);
    deps.logger?.info("login_success", {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      emailDomain,
      failureCountBeforeSuccess: previousFailures,
      usedCaptcha: requiresCaptcha || Boolean(turnstileToken),
    });
    return response;
  } catch (error) {
    const httpError = error instanceof AuthHttpError ? error : mapLoginError(error);
    const shouldRegisterFailure =
      httpError.code === "INVALID_CREDENTIALS" ||
      httpError.code === "AUTH_RATE_LIMITED" ||
      httpError.code === "CAPTCHA_REQUIRED" ||
      httpError.code === "CAPTCHA_INVALID" ||
      httpError.code === "CAPTCHA_EXPIRED" ||
      httpError.code === "CAPTCHA_TIMEOUT" ||
      httpError.code === "CAPTCHA_NETWORK_ERROR";

    const failureCount = shouldRegisterFailure ? registerFailure(failureKeys, Date.now()) : previousFailures;

    deps.logger?.warn("login_failed", {
      code: httpError.code,
      status: httpError.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      emailDomain,
      failureCount,
      requiresCaptcha,
    });

    throw httpError;
  }
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
