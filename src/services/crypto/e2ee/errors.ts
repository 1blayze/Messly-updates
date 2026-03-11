export type E2EEErrorCode =
  | "unsupported_runtime"
  | "invalid_base64"
  | "invalid_argument"
  | "invalid_payload"
  | "invalid_signature"
  | "missing_session"
  | "missing_key_material"
  | "decrypt_failed"
  | "replay_detected"
  | "session_mismatch"
  | "device_revoked"
  | "migration_unsupported";

export class E2EEError extends Error {
  readonly code: E2EEErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: E2EEErrorCode, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(message);
    this.name = "E2EEError";
    this.code = code;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      try {
        (this as Error & { cause?: unknown }).cause = options.cause;
      } catch {
        // ignore non-writable cause on older runtimes
      }
    }
  }
}

export function assertOrThrow(
  condition: boolean,
  code: E2EEErrorCode,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new E2EEError(code, message, {
      details,
    });
  }
}
