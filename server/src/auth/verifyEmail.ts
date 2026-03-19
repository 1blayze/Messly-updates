import { normalizeEmail } from "./crypto";
import { finalizeAuthSession } from "./login";
import { AuthHttpError, assertRateLimit } from "./http";
import type { AuthDependencies, AuthRequestContext, AuthTokenResponse, VerifyEmailRequestBody } from "./types";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_WINDOW_MS = 15 * 60_000;

function normalizeVerifyInput(body: VerifyEmailRequestBody): {
  email: string;
  code: string;
} {
  const email = normalizeEmail(body.email ?? "");
  const code = String(body.code ?? "").trim();
  if (!EMAIL_REGEX.test(email)) {
    throw new AuthHttpError(400, "INVALID_EMAIL", "A valid email is required.");
  }
  if (!/^\d{8}$/.test(code)) {
    throw new AuthHttpError(400, "INVALID_VERIFICATION_CODE", "Verification code must contain 8 digits.");
  }
  return { email, code };
}

function mapVerifyEmailError(error: unknown): AuthHttpError {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  const normalized = message.toLowerCase();

  if (normalized.includes("expired")) {
    return new AuthHttpError(400, "INVALID_VERIFICATION_CODE", "Verification code expired.");
  }
  if (normalized.includes("invalid") || normalized.includes("token")) {
    return new AuthHttpError(400, "INVALID_VERIFICATION_CODE", "Invalid verification code.");
  }
  if (normalized.includes("rate limit") || normalized.includes("too many")) {
    return new AuthHttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts. Try again later.");
  }

  return new AuthHttpError(502, "AUTH_PROVIDER_ERROR", message || "Supabase email verification failed.");
}

export async function handleVerifyEmail(
  deps: AuthDependencies,
  context: AuthRequestContext,
  body: VerifyEmailRequestBody,
): Promise<AuthTokenResponse> {
  const { email, code } = normalizeVerifyInput(body);

  await assertRateLimit(deps.rateLimiter, [
    {
      key: `auth:verify:ip:${context.ipAddress}`,
      limit: 24,
      windowMs: VERIFY_WINDOW_MS,
    },
    {
      key: `auth:verify:email:${email}`,
      limit: 12,
      windowMs: VERIFY_WINDOW_MS,
    },
  ]);

  const publicSupabase = deps.createPublicSupabase();
  const verifyResult = await publicSupabase.auth.verifyOtp({
    email,
    token: code,
    type: "signup",
  });

  if (verifyResult.error || !verifyResult.data.session || !verifyResult.data.user) {
    throw mapVerifyEmailError(verifyResult.error);
  }

  return finalizeAuthSession(deps, context, {
    session: verifyResult.data.session,
    user: verifyResult.data.user,
    client: body.client ?? null,
  });
}
