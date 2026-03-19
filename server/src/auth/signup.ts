import { normalizeEmail } from "./crypto";
import { AuthHttpError, assertRateLimit } from "./http";
import {
  buildCaptchaHttpError,
  consumeRegistrationLease,
  evaluateRegistrationRisk,
  logRegisterPayloadInvalid,
  mapCaptchaFailureEvent,
  prepareRegistrationRiskInput,
  releaseRegistrationLease,
  recordCaptchaFailure,
  recordRegistrationSuccess,
  reserveRegistrationLease,
} from "../security/evaluateRegistrationRisk";
import { verifyTurnstile } from "../security/verifyTurnstile";
import type {
  AuthDependencies,
  AuthRequestContext,
  SignupProfileInput,
  ResendVerificationRequestBody,
  SignupRequestBody,
} from "./types";

const RESEND_WINDOW_MS = 10 * 60_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-z0-9_.]{2,32}$/;
const REGISTRATION_ERROR_MESSAGE = "Unable to complete registration. Please try again later.";
const REGISTRATION_EMAIL_UNAVAILABLE_MESSAGE =
  "Unable to send confirmation email right now. Please try again later.";
const REGISTRATION_RATE_LIMIT_MESSAGE = "Too many registration attempts. Please try again later.";
const EMAIL_MAX_LENGTH = 254;
const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

interface VerificationIssueResult {
  email: string;
  expires_at: string;
  max_attempts: number;
  status: "verification_required";
}

function normalizeDisplayName(displayNameRaw: string | null | undefined): string | null {
  const displayName = String(displayNameRaw ?? "").trim().replace(/\s+/g, " ");
  if (!displayName) {
    return null;
  }
  if (displayName.length < 2 || displayName.length > 32) {
    throw new AuthHttpError(400, "INVALID_DISPLAY_NAME", "Display name must have between 2 and 32 characters.");
  }
  return displayName;
}

function normalizeUsername(usernameRaw: string | null | undefined): string | null {
  const username = String(usernameRaw ?? "").trim().toLowerCase();
  if (!username) {
    return null;
  }
  if (!USERNAME_REGEX.test(username)) {
    throw new AuthHttpError(
      400,
      "INVALID_USERNAME",
      "Username must use 2 to 32 lowercase characters with letters, numbers, dot or underscore.",
    );
  }
  return username;
}

function assertPasswordStrength(passwordRaw: string): string {
  const password = String(passwordRaw ?? "");
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9\s]/.test(password);
  if (password.length < 8 || !hasNumber || !hasSymbol) {
    throw new AuthHttpError(
      400,
      "WEAK_PASSWORD",
      "Password must have at least 8 characters, including one number and one symbol.",
    );
  }
  return password;
}

function buildUserMetadata(profile: SignupProfileInput | null | undefined): Record<string, string> {
  const displayName = normalizeDisplayName(profile?.displayName);
  const username = normalizeUsername(profile?.username);
  const metadata: Record<string, string> = {};

  if (displayName) {
    metadata.display_name = displayName;
  }
  if (username) {
    metadata.username = username;
  }

  return metadata;
}

function normalizeSignupInput(body: SignupRequestBody): {
  email: string;
  password: string;
  turnstileToken: string | null;
  registrationFingerprint: string;
  metadata: Record<string, string>;
} {
  const email = normalizeEmail(body.email ?? "");
  if (!EMAIL_REGEX.test(email) || email.length > EMAIL_MAX_LENGTH) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }
  const turnstileTokenRaw = String(body.turnstileToken ?? "").trim();
  if (turnstileTokenRaw.length > TURNSTILE_TOKEN_MAX_LENGTH || /\s/.test(turnstileTokenRaw)) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }
  const turnstileToken = turnstileTokenRaw || null;
  const registrationFingerprint = String(body.registrationFingerprint ?? "").trim();
  if (!registrationFingerprint) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }

  return {
    email,
    password: assertPasswordStrength(body.password ?? ""),
    turnstileToken,
    registrationFingerprint,
    metadata: buildUserMetadata(body.profile),
  };
}

function normalizeResendInput(body: ResendVerificationRequestBody): { email: string } {
  const email = normalizeEmail(body.email ?? "");
  if (!EMAIL_REGEX.test(email)) {
    throw new AuthHttpError(400, "INVALID_EMAIL", "A valid email is required.");
  }

  return { email };
}

function buildVerificationResponse(deps: AuthDependencies, email: string): VerificationIssueResult {
  return {
    status: "verification_required",
    email,
    expires_at: new Date(Date.now() + deps.env.authOtpTtlSeconds * 1000).toISOString(),
    max_attempts: deps.env.authOtpMaxAttempts,
  };
}

function mapSignupProviderError(deps: AuthDependencies, error: unknown): AuthHttpError {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  const normalized = message.toLowerCase();
  deps.logger?.error("supabase_signup_error", {
    message: message || "unknown",
    error,
  });

  if (
    normalized.includes("already registered") ||
    normalized.includes("already exists") ||
    normalized.includes("email_exists")
  ) {
    return new AuthHttpError(409, "EMAIL_ALREADY_REGISTERED", "Email already registered.");
  }

  if (normalized.includes("rate limit") || normalized.includes("too many")) {
    return new AuthHttpError(429, "REGISTRATION_TOO_MANY_ATTEMPTS", REGISTRATION_RATE_LIMIT_MESSAGE);
  }

  if (
    normalized.includes("error sending confirmation email") ||
    normalized.includes("confirmation email") ||
    normalized.includes("smtp")
  ) {
    return new AuthHttpError(503, "REGISTRATION_EMAIL_UNAVAILABLE", REGISTRATION_EMAIL_UNAVAILABLE_MESSAGE);
  }

  return new AuthHttpError(400, "REGISTRATION_UNABLE", message || REGISTRATION_ERROR_MESSAGE);
}

interface SignupProviderUser {
  id?: string | null;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  confirmation_sent_at?: string | null;
  identities?: unknown;
}

function extractSignupProviderUser(signupResult: unknown): SignupProviderUser | null {
  const user = (
    signupResult as {
      data?: {
        user?: unknown;
      };
    }
  )?.data?.user;
  if (!user || typeof user !== "object") {
    return null;
  }
  return user as SignupProviderUser;
}

function isExistingRegisteredUser(user: SignupProviderUser | null): boolean {
  if (!user) {
    return false;
  }
  if (!Array.isArray(user.identities)) {
    return false;
  }
  return user.identities.length === 0;
}

function mapResendProviderError(error: unknown): AuthHttpError {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  const normalized = message.toLowerCase();

  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many") ||
    normalized.includes("request this after") ||
    normalized.includes("for security purposes")
  ) {
    return new AuthHttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts. Try again later.");
  }
  if (normalized.includes("not found") || normalized.includes("signup")) {
    return new AuthHttpError(404, "VERIFICATION_NOT_FOUND", "No pending email verification was found for this address.");
  }

  return new AuthHttpError(502, "AUTH_PROVIDER_ERROR", message || "Supabase resend verification failed.");
}

export async function handleSignup(
  deps: AuthDependencies,
  context: AuthRequestContext,
  body: SignupRequestBody,
): Promise<VerificationIssueResult> {
  let leaseId: string | null = null;
  try {
    let normalizedInput:
      | {
          email: string;
          password: string;
          turnstileToken: string | null;
          registrationFingerprint: string;
          metadata: Record<string, string>;
        }
      | null = null;

    try {
      normalizedInput = normalizeSignupInput(body);
    } catch (error) {
      if (error instanceof AuthHttpError && error.code === "REGISTER_PAYLOAD_INVALID") {
        await logRegisterPayloadInvalid(deps, context, {
          reason: "invalid_signup_payload",
        });
      }
      throw error;
    }

    const { email, password, metadata, turnstileToken, registrationFingerprint } = normalizedInput;
    const preparedRiskInput = prepareRegistrationRiskInput({
      email,
      registrationFingerprint,
    });
    const riskContext = {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      origin: context.origin,
      email,
      registrationFingerprint,
    };
    deps.logger?.info("signup_payload_received", {
      emailDomain: preparedRiskInput.emailDomain,
      hasTurnstileToken: Boolean(turnstileToken),
      fingerprintHashPrefix: preparedRiskInput.fingerprintHash.slice(0, 12),
      hasDisplayName: Boolean(metadata.display_name),
      hasUsername: Boolean(metadata.username),
      ipAddress: context.ipAddress,
      origin: context.origin ?? null,
    });

    await evaluateRegistrationRisk(deps, context, preparedRiskInput);
    const lease = await reserveRegistrationLease(deps, context, preparedRiskInput);
    leaseId = lease.leaseId;

    if (turnstileToken) {
      const turnstileVerification = await verifyTurnstile({
        token: turnstileToken,
        secretKey: deps.env.turnstileSecretKey,
        remoteIp: context.ipAddress,
        logger: deps.logger,
      });

      deps.logger?.info("signup_captcha_status", {
        status: turnstileVerification.success ? "verified" : "failed",
        reason: turnstileVerification.reason ?? null,
        hasErrorCodes: Array.isArray(turnstileVerification.errorCodes) && turnstileVerification.errorCodes.length > 0,
      });

      if (!turnstileVerification.success) {
        const failureReason = turnstileVerification.reason ?? "captcha_invalid";
        try {
          await releaseRegistrationLease(deps, leaseId, failureReason);
        } catch (leaseReleaseError) {
          deps.logger?.warn("registration_lease_release_failed", {
            stage: "captcha_failed",
            leaseId,
            reason: leaseReleaseError instanceof Error ? leaseReleaseError.message : String(leaseReleaseError),
          });
        }
        leaseId = null;

        await recordCaptchaFailure(deps, {
          event: mapCaptchaFailureEvent({
            reason: failureReason,
          }),
          context: riskContext,
          prepared: preparedRiskInput,
          details: {
            errorCodes: turnstileVerification.errorCodes,
            hostname: turnstileVerification.hostname,
          },
        });
        throw buildCaptchaHttpError(failureReason);
      }
    } else {
      deps.logger?.info("signup_captcha_status", {
        status: "skipped",
        reason: "token_missing_low_risk_path",
      });
    }

    const publicSupabase = deps.createPublicSupabase();
    const signupResult = await publicSupabase.auth.signUp({
      email,
      password,
      options: {
        data: metadata,
        captchaToken: turnstileToken ?? undefined,
      },
    });

    if (process.env.NODE_ENV === "development") {
      deps.logger?.info("supabase_signup_response", {
        error: signupResult.error ?? null,
        data: signupResult.data ?? null,
      });
    }

    if (signupResult.error) {
      try {
        await releaseRegistrationLease(deps, leaseId, "provider_error");
      } catch (leaseReleaseError) {
        deps.logger?.warn("registration_lease_release_failed", {
          stage: "provider_error",
          leaseId,
          reason: leaseReleaseError instanceof Error ? leaseReleaseError.message : String(leaseReleaseError),
        });
      }
      leaseId = null;
      throw mapSignupProviderError(deps, signupResult.error);
    }

    const signupUser = extractSignupProviderUser(signupResult);
    if (isExistingRegisteredUser(signupUser)) {
      try {
        await releaseRegistrationLease(deps, leaseId, "provider_existing_account");
      } catch (leaseReleaseError) {
        deps.logger?.warn("registration_lease_release_failed", {
          stage: "provider_existing_account",
          leaseId,
          reason: leaseReleaseError instanceof Error ? leaseReleaseError.message : String(leaseReleaseError),
        });
      }
      leaseId = null;
      throw new AuthHttpError(409, "EMAIL_ALREADY_REGISTERED", "Email already registered.");
    }

    if (!signupUser) {
      try {
        await releaseRegistrationLease(deps, leaseId, "provider_user_missing");
      } catch (leaseReleaseError) {
        deps.logger?.warn("registration_lease_release_failed", {
          stage: "provider_user_missing",
          leaseId,
          reason: leaseReleaseError instanceof Error ? leaseReleaseError.message : String(leaseReleaseError),
        });
      }
      leaseId = null;
      throw new AuthHttpError(502, "AUTH_PROVIDER_ERROR", "Supabase signup did not return a user.");
    }

    deps.logger?.info("signup_verification_issued", {
      userId: signupUser.id ?? null,
      emailDomain: preparedRiskInput.emailDomain,
      confirmationSentAt: signupUser.confirmation_sent_at ?? null,
      emailConfirmedAt: signupUser.email_confirmed_at ?? signupUser.confirmed_at ?? null,
      identitiesCount: Array.isArray(signupUser.identities) ? signupUser.identities.length : null,
    });

    try {
      await consumeRegistrationLease(deps, leaseId);
    } catch (leaseConsumeError) {
      deps.logger?.warn("registration_lease_consume_failed", {
        leaseId,
        reason: leaseConsumeError instanceof Error ? leaseConsumeError.message : String(leaseConsumeError),
      });
    }
    leaseId = null;

    try {
      await recordRegistrationSuccess(deps, {
        context: riskContext,
        prepared: preparedRiskInput,
        userId: signupResult.data.user?.id ?? null,
      });
    } catch (error) {
      deps.logger?.warn("registration_success_audit_failed", {
        ipAddress: context.ipAddress,
        emailDomain: preparedRiskInput.emailDomain,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return buildVerificationResponse(deps, email);
  } catch (error) {
    if (leaseId) {
      try {
        await releaseRegistrationLease(deps, leaseId, "signup_aborted");
      } catch (leaseReleaseError) {
        deps.logger?.warn("registration_lease_release_failed", {
          stage: "signup_aborted",
          leaseId,
          reason: leaseReleaseError instanceof Error ? leaseReleaseError.message : String(leaseReleaseError),
        });
      }
    }
    if (error instanceof AuthHttpError) {
      deps.logger?.warn("signup_rejected", {
        code: error.code,
        status: error.status,
        message: error.message,
      });
    } else {
      deps.logger?.error("signup_rejected_unexpected", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function handleResendVerification(
  deps: AuthDependencies,
  context: AuthRequestContext,
  body: ResendVerificationRequestBody,
): Promise<VerificationIssueResult> {
  const { email } = normalizeResendInput(body);

  await assertRateLimit(deps.rateLimiter, [
    {
      key: `auth:resend:ip:${context.ipAddress}`,
      limit: 12,
      windowMs: RESEND_WINDOW_MS,
    },
    {
      key: `auth:resend:email:${email}`,
      limit: 4,
      windowMs: RESEND_WINDOW_MS,
    },
  ]);

  const publicSupabase = deps.createPublicSupabase();
  const resendResult = await publicSupabase.auth.resend({
    type: "signup",
    email,
  });

  if (resendResult.error) {
    throw mapResendProviderError(resendResult.error);
  }

  return buildVerificationResponse(deps, email);
}
