import type { Logger } from "../infra/logger";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_VERIFY_TIMEOUT_MS = 6_000;
const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

type TurnstileErrorCode =
  | "missing-input-secret"
  | "invalid-input-secret"
  | "missing-input-response"
  | "invalid-input-response"
  | "bad-request"
  | "timeout-or-duplicate"
  | "internal-error"
  | string;

interface TurnstileVerifyApiResponse {
  success?: boolean;
  "error-codes"?: TurnstileErrorCode[];
  challenge_ts?: string;
  hostname?: string;
}

export interface VerifyTurnstileInput {
  token: string;
  secretKey: string;
  remoteIp?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export type TurnstileFailureReason =
  | "captcha_missing"
  | "captcha_invalid"
  | "captcha_expired"
  | "captcha_timeout"
  | "captcha_network_error"
  | "captcha_response_invalid"
  | "captcha_misconfigured";

export interface VerifyTurnstileResult {
  success: boolean;
  reason?: TurnstileFailureReason;
  errorCodes: TurnstileErrorCode[];
  challengeTimestamp: string | null;
  hostname: string | null;
}

function sanitizeRemoteIp(remoteIpRaw: string | null | undefined): string | null {
  const remoteIp = String(remoteIpRaw ?? "").trim();
  if (!remoteIp || remoteIp.toLowerCase() === "unknown") {
    return null;
  }
  return remoteIp;
}

async function parseTurnstileJsonSafe(response: Response): Promise<TurnstileVerifyApiResponse | null> {
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as TurnstileVerifyApiResponse;
  } catch {
    return null;
  }
}

function mapFailureReason(errorCodes: TurnstileErrorCode[]): TurnstileFailureReason {
  if (errorCodes.includes("timeout-or-duplicate")) {
    return "captcha_expired";
  }
  if (errorCodes.includes("missing-input-response")) {
    return "captcha_missing";
  }
  if (errorCodes.includes("missing-input-secret") || errorCodes.includes("invalid-input-secret")) {
    return "captcha_misconfigured";
  }
  return "captcha_invalid";
}

export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<VerifyTurnstileResult> {
  const token = String(input.token ?? "").trim();
  const secretKey = String(input.secretKey ?? "").trim();
  if (!secretKey) {
    input.logger?.error("Turnstile secret key missing. Registration is fail-closed.");
    return {
      success: false,
      reason: "captcha_misconfigured",
      errorCodes: [],
      challengeTimestamp: null,
      hostname: null,
    };
  }

  if (!token) {
    return {
      success: false,
      reason: "captcha_missing",
      errorCodes: ["missing-input-response"],
      challengeTimestamp: null,
      hostname: null,
    };
  }
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH || /\s/.test(token)) {
    return {
      success: false,
      reason: "captcha_invalid",
      errorCodes: ["invalid-input-response"],
      challengeTimestamp: null,
      hostname: null,
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS);
  const requestBody = new URLSearchParams();
  requestBody.set("secret", secretKey);
  requestBody.set("response", token);
  const remoteIp = sanitizeRemoteIp(input.remoteIp);
  if (remoteIp) {
    requestBody.set("remoteip", remoteIp);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: requestBody.toString(),
      signal: controller.signal,
    });

    const parsed = await parseTurnstileJsonSafe(response);
    if (!parsed) {
      return {
        success: false,
        reason: "captcha_response_invalid",
        errorCodes: [],
        challengeTimestamp: null,
        hostname: null,
      };
    }

    const errorCodes = Array.isArray(parsed["error-codes"])
      ? parsed["error-codes"].map((code) => String(code).trim()).filter(Boolean)
      : [];
    const success = parsed.success === true;
    if (!success) {
      return {
        success: false,
        reason: mapFailureReason(errorCodes),
        errorCodes,
        challengeTimestamp: String(parsed.challenge_ts ?? "").trim() || null,
        hostname: String(parsed.hostname ?? "").trim() || null,
      };
    }

    return {
      success: true,
      errorCodes,
      challengeTimestamp: String(parsed.challenge_ts ?? "").trim() || null,
      hostname: String(parsed.hostname ?? "").trim() || null,
    };
  } catch (error) {
    const isAbortError = error instanceof DOMException && error.name === "AbortError";
    return {
      success: false,
      reason: isAbortError ? "captcha_timeout" : "captcha_network_error",
      errorCodes: [],
      challengeTimestamp: null,
      hostname: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
