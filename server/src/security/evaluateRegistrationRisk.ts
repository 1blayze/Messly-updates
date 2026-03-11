import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthHttpError } from "../auth/http";
import type { AuthDependencies, AuthRequestContext } from "../auth/types";
import type { Logger } from "../infra/logger";
import { DISPOSABLE_EMAIL_DOMAINS } from "./disposableEmailDomains";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const REGISTRATION_ERROR_MESSAGE = "Unable to complete registration. Please try again later.";
const REGISTRATION_BLOCKED_MESSAGE = "Registration temporarily blocked.";
const REGISTRATION_RATE_LIMIT_MESSAGE = "Too many registration attempts. Please try again later.";
const EMAIL_MAX_LENGTH = 254;
const CLIENT_FINGERPRINT_REGEX = /^[a-f0-9]{64}$/;
const COMMON_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "uol.com.br",
  "bol.com.br",
]);

type SecurityEventName =
  | "register_attempt_started"
  | "register_payload_invalid"
  | "register_rate_limited"
  | "fingerprint_rate_limited"
  | "captcha_failed"
  | "captcha_failed_attempt"
  | "captcha_expired"
  | "captcha_timeout"
  | "captcha_network_error"
  | "security_block_ip"
  | "security_block_fingerprint"
  | "disposable_email_blocked"
  | "suspicious_registration_pattern"
  | "register_success"
  | "register_blocked_high_risk";

export interface RegistrationRiskSignals {
  email: string;
  registrationFingerprint: string;
}

export interface RegistrationRiskContext extends RegistrationRiskSignals {
  ipAddress: string;
  userAgent: string | null;
  origin: string | null;
}

export interface RegistrationRiskPreparedInput {
  email: string;
  emailDomain: string;
  emailMasked: string;
  fingerprintHash: string;
}

export interface RegistrationRiskDecision {
  emailDomain: string;
  fingerprintHash: string;
}

export interface RegistrationLease {
  leaseId: string;
}

export interface CaptchaFailureInput {
  event: "captcha_failed" | "captcha_expired" | "captcha_timeout" | "captcha_network_error";
  context: RegistrationRiskContext;
  prepared: RegistrationRiskPreparedInput;
  details?: Record<string, unknown>;
}

export interface RegistrationSuccessInput {
  context: RegistrationRiskContext;
  prepared: RegistrationRiskPreparedInput;
  userId?: string | null;
}

interface StoredBlock {
  reason: string;
  blockedUntil: string;
}

interface SecurityEventPayload {
  eventType: SecurityEventName;
  ipAddress?: string | null;
  fingerprintHash?: string | null;
  emailDomain?: string | null;
  emailMasked?: string | null;
  details?: Record<string, unknown>;
}

interface LeaseAcquireRpcRow {
  allowed?: boolean | null;
  reason?: string | null;
  lease_id?: string | null;
  ip_count?: number | null;
  fingerprint_count?: number | null;
}

function toIsoDate(date: Date): string {
  return date.toISOString();
}

function truncate(valueRaw: string, maxLength: number): string {
  const value = String(valueRaw ?? "").trim();
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) {
    return "";
  }
  return email.slice(at + 1).trim().toLowerCase();
}

function maskEmail(email: string): string {
  const normalized = String(email ?? "").trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const safeLocal = local.length <= 2 ? `${local[0] ?? "*"}*` : `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function normalizeFingerprint(inputRaw: string): string {
  const input = String(inputRaw ?? "").trim().toLowerCase();
  if (!CLIENT_FINGERPRINT_REGEX.test(input)) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }
  return createHash("sha256").update(`messly-reg-fingerprint:${input}`).digest("hex");
}

function toFingerprintLogHash(fingerprintHash: string): string {
  return truncate(fingerprintHash, 12);
}

function buildSecurityError(status: number, code: string, message: string): AuthHttpError {
  return new AuthHttpError(status, code, message);
}

function throwRateLimitedError(): never {
  throw buildSecurityError(429, "REGISTRATION_TOO_MANY_ATTEMPTS", REGISTRATION_RATE_LIMIT_MESSAGE);
}

function throwRegistrationBlockedError(code = "REGISTRATION_TEMPORARILY_BLOCKED"): never {
  throw buildSecurityError(403, code, REGISTRATION_BLOCKED_MESSAGE);
}

function toStorageError(_reason: string, _error: unknown): AuthHttpError {
  return new AuthHttpError(503, "REGISTRATION_SECURITY_UNAVAILABLE", REGISTRATION_ERROR_MESSAGE);
}

async function requireNoSupabaseError(reason: string, error: unknown): Promise<void> {
  if (!error) {
    return;
  }
  throw toStorageError(reason, error);
}

function logSecurityEvent(logger: Logger | undefined, payload: SecurityEventPayload, level: "info" | "warn" = "info"): void {
  const logPayload = {
    event: payload.eventType,
    ipAddress: payload.ipAddress ?? null,
    fingerprintHashPrefix: payload.fingerprintHash ? toFingerprintLogHash(payload.fingerprintHash) : null,
    emailDomain: payload.emailDomain ?? null,
    emailMasked: payload.emailMasked ?? null,
    details: payload.details ?? {},
  };
  if (level === "warn") {
    logger?.warn("registration_security_event", logPayload);
    return;
  }
  logger?.info("registration_security_event", logPayload);
}

async function persistSecurityEvent(adminSupabase: SupabaseClient, payload: SecurityEventPayload): Promise<void> {
  const { error } = await adminSupabase.from("suspicious_registration_events").insert({
    event_type: payload.eventType,
    ip_address: payload.ipAddress ?? null,
    fingerprint_hash: payload.fingerprintHash ?? null,
    email_domain: payload.emailDomain ?? null,
    email_masked: payload.emailMasked ?? null,
    details: payload.details ?? {},
  });
  await requireNoSupabaseError(`persist_event:${payload.eventType}`, error);
}

async function readIpBlock(adminSupabase: SupabaseClient, ipAddress: string, nowIso: string): Promise<StoredBlock | null> {
  const { data, error } = await adminSupabase
    .from("blocked_ips")
    .select("reason,blocked_until")
    .eq("ip_address", ipAddress)
    .gt("blocked_until", nowIso)
    .maybeSingle();
  await requireNoSupabaseError("read_blocked_ip", error);
  if (!data) {
    return null;
  }
  return {
    reason: String((data as { reason?: unknown }).reason ?? "").trim() || "unknown",
    blockedUntil: String((data as { blocked_until?: unknown }).blocked_until ?? "").trim(),
  };
}

async function readFingerprintBlock(
  adminSupabase: SupabaseClient,
  fingerprintHash: string,
  nowIso: string,
): Promise<StoredBlock | null> {
  const { data, error } = await adminSupabase
    .from("blocked_fingerprints")
    .select("reason,blocked_until")
    .eq("fingerprint_hash", fingerprintHash)
    .gt("blocked_until", nowIso)
    .maybeSingle();
  await requireNoSupabaseError("read_blocked_fingerprint", error);
  if (!data) {
    return null;
  }
  return {
    reason: String((data as { reason?: unknown }).reason ?? "").trim() || "unknown",
    blockedUntil: String((data as { blocked_until?: unknown }).blocked_until ?? "").trim(),
  };
}

async function countRowsByWindow(
  adminSupabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
  sinceIso: string,
  eventType?: string,
): Promise<number> {
  let query = adminSupabase
    .from(table)
    .select("id", {
      head: true,
      count: "exact",
    })
    .eq(column, value)
    .gte("created_at", sinceIso);
  if (eventType) {
    query = query.eq("event_type", eventType);
  }
  const { count, error } = await query;
  await requireNoSupabaseError(`count_rows:${table}:${column}`, error);
  return Number(count ?? 0);
}

async function sampleDistinctValuesByWindow(
  adminSupabase: SupabaseClient,
  column: "ip_address" | "fingerprint_hash",
  filters: Array<{ column: string; value: string }>,
  sinceIso: string,
  maxCorrelationSample: number,
): Promise<number> {
  let query = adminSupabase
    .from("suspicious_registration_events")
    .select(column)
    .gte("created_at", sinceIso)
    .not(column, "is", null)
    .limit(maxCorrelationSample);

  for (const filter of filters) {
    query = query.eq(filter.column, filter.value);
  }

  const { data, error } = await query;
  await requireNoSupabaseError("sample_distinct_values", error);

  const distinct = new Set<string>();
  for (const row of data ?? []) {
    const value = String((row as Record<string, unknown>)[column] ?? "").trim();
    if (value) {
      distinct.add(value);
    }
  }
  return distinct.size;
}

async function upsertIpBlock(
  adminSupabase: SupabaseClient,
  ipAddress: string,
  blockedUntilIso: string,
  reason: string,
): Promise<void> {
  const { error } = await adminSupabase.from("blocked_ips").upsert(
    {
      ip_address: ipAddress,
      blocked_until: blockedUntilIso,
      reason,
      updated_at: toIsoDate(new Date()),
    },
    {
      onConflict: "ip_address",
    },
  );
  await requireNoSupabaseError("upsert_ip_block", error);
}

async function upsertFingerprintBlock(
  adminSupabase: SupabaseClient,
  fingerprintHash: string,
  blockedUntilIso: string,
  reason: string,
): Promise<void> {
  const { error } = await adminSupabase.from("blocked_fingerprints").upsert(
    {
      fingerprint_hash: fingerprintHash,
      blocked_until: blockedUntilIso,
      reason,
      updated_at: toIsoDate(new Date()),
    },
    {
      onConflict: "fingerprint_hash",
    },
  );
  await requireNoSupabaseError("upsert_fingerprint_block", error);
}

function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

function normalizeLeaseRpcRow(data: unknown): LeaseAcquireRpcRow | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return first && typeof first === "object" ? (first as LeaseAcquireRpcRow) : null;
  }
  if (data && typeof data === "object") {
    return data as LeaseAcquireRpcRow;
  }
  return null;
}

function normalizeRpcBoolean(data: unknown): boolean {
  if (typeof data === "boolean") {
    return data;
  }
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "boolean") {
      return first;
    }
    if (first && typeof first === "object") {
      const objectValues = Object.values(first as Record<string, unknown>);
      if (typeof objectValues[0] === "boolean") {
        return objectValues[0];
      }
    }
  }
  return false;
}

export function prepareRegistrationRiskInput(signals: RegistrationRiskSignals): RegistrationRiskPreparedInput {
  const email = String(signals.email ?? "").trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }

  const emailDomain = normalizeEmailDomain(email);
  if (!emailDomain) {
    throw new AuthHttpError(400, "REGISTER_PAYLOAD_INVALID", REGISTRATION_ERROR_MESSAGE);
  }

  return {
    email,
    emailDomain,
    emailMasked: maskEmail(email),
    fingerprintHash: normalizeFingerprint(signals.registrationFingerprint),
  };
}

export async function evaluateRegistrationRisk(
  deps: AuthDependencies,
  context: AuthRequestContext,
  prepared: RegistrationRiskPreparedInput,
): Promise<RegistrationRiskDecision> {
  const nowMs = Date.now();
  const nowIso = toIsoDate(new Date(nowMs));
  const correlationWindowMs = deps.env.correlationWindowMinutes * ONE_MINUTE_MS;
  const suspiciousWindowMs = deps.env.suspiciousEventWindowHours * ONE_HOUR_MS;
  const adminSupabase = deps.adminSupabase;
  const ipAddress = context.ipAddress;

  const baseEvent = {
    ipAddress,
    fingerprintHash: prepared.fingerprintHash,
    emailDomain: prepared.emailDomain,
    emailMasked: prepared.emailMasked,
    details: {
      userAgent: truncate(String(context.userAgent ?? ""), 180),
      origin: truncate(String(context.origin ?? ""), 180),
    },
  };

  await persistSecurityEvent(adminSupabase, {
    eventType: "register_attempt_started",
    ...baseEvent,
  });
  logSecurityEvent(deps.logger, {
    eventType: "register_attempt_started",
    ...baseEvent,
  });

  const ipBlock = await readIpBlock(adminSupabase, ipAddress, nowIso);
  if (ipBlock) {
    await persistSecurityEvent(adminSupabase, {
      eventType: "security_block_ip",
      ...baseEvent,
      details: {
        reason: ipBlock.reason,
        blockedUntil: ipBlock.blockedUntil,
      },
    });
    logSecurityEvent(
      deps.logger,
      {
        eventType: "security_block_ip",
        ...baseEvent,
        details: {
          reason: ipBlock.reason,
          blockedUntil: ipBlock.blockedUntil,
        },
      },
      "warn",
    );
    throwRegistrationBlockedError();
  }

  const fingerprintBlock = await readFingerprintBlock(adminSupabase, prepared.fingerprintHash, nowIso);
  if (fingerprintBlock) {
    await persistSecurityEvent(adminSupabase, {
      eventType: "security_block_fingerprint",
      ...baseEvent,
      details: {
        reason: fingerprintBlock.reason,
        blockedUntil: fingerprintBlock.blockedUntil,
      },
    });
    logSecurityEvent(
      deps.logger,
      {
        eventType: "security_block_fingerprint",
        ...baseEvent,
        details: {
          reason: fingerprintBlock.reason,
          blockedUntil: fingerprintBlock.blockedUntil,
        },
      },
      "warn",
    );
    throwRegistrationBlockedError();
  }

  if (deps.env.enableDisposableEmailBlock && isDisposableDomain(prepared.emailDomain)) {
    await persistSecurityEvent(adminSupabase, {
      eventType: "disposable_email_blocked",
      ...baseEvent,
    });
    logSecurityEvent(
      deps.logger,
      {
        eventType: "disposable_email_blocked",
        ...baseEvent,
      },
      "warn",
    );
    throw buildSecurityError(403, "REGISTRATION_BLOCKED", REGISTRATION_ERROR_MESSAGE);
  }

  const correlationSinceIso = toIsoDate(new Date(nowMs - correlationWindowMs));
  const suspiciousSinceIso = toIsoDate(new Date(nowMs - suspiciousWindowMs));
  const [distinctIpsForFingerprint, distinctFingerprintsForIp, domainBurstCount, priorSuspiciousByIp, priorSuspiciousByFingerprint] =
    await Promise.all([
      sampleDistinctValuesByWindow(
        adminSupabase,
        "ip_address",
        [{ column: "fingerprint_hash", value: prepared.fingerprintHash }],
        correlationSinceIso,
        deps.env.maxCorrelationSample,
      ),
      sampleDistinctValuesByWindow(
        adminSupabase,
        "fingerprint_hash",
        [{ column: "ip_address", value: ipAddress }],
        correlationSinceIso,
        deps.env.maxCorrelationSample,
      ),
      countRowsByWindow(
        adminSupabase,
        "registration_attempts_by_email_domain",
        "email_domain",
        prepared.emailDomain,
        correlationSinceIso,
      ),
      countRowsByWindow(
        adminSupabase,
        "suspicious_registration_events",
        "ip_address",
        ipAddress,
        suspiciousSinceIso,
        "suspicious_registration_pattern",
      ),
      countRowsByWindow(
        adminSupabase,
        "suspicious_registration_events",
        "fingerprint_hash",
        prepared.fingerprintHash,
        suspiciousSinceIso,
        "suspicious_registration_pattern",
      ),
    ]);

  const nonCommonDomainBurstRisk =
    !COMMON_EMAIL_DOMAINS.has(prepared.emailDomain) &&
    !isDisposableDomain(prepared.emailDomain) &&
    domainBurstCount >= deps.env.domainBurstThreshold;

  const suspiciousPattern =
    distinctIpsForFingerprint >= deps.env.fingerprintDistinctIpThreshold ||
    distinctFingerprintsForIp >= deps.env.ipDistinctFingerprintThreshold ||
    nonCommonDomainBurstRisk;

  if (suspiciousPattern) {
    const suspiciousDetails = {
      distinctIpsForFingerprint,
      distinctFingerprintsForIp,
      domainBurstCount,
      correlationWindowMinutes: deps.env.correlationWindowMinutes,
    };
    await persistSecurityEvent(adminSupabase, {
      eventType: "suspicious_registration_pattern",
      ...baseEvent,
      details: suspiciousDetails,
    });
    logSecurityEvent(
      deps.logger,
      {
        eventType: "suspicious_registration_pattern",
        ...baseEvent,
        details: suspiciousDetails,
      },
      "warn",
    );

    const previousSuspiciousCount = Math.max(priorSuspiciousByIp, priorSuspiciousByFingerprint);
    if (previousSuspiciousCount >= deps.env.suspiciousReincidenceThreshold) {
      const blockUntilIso = toIsoDate(new Date(nowMs + deps.env.captchaBlockHours * ONE_HOUR_MS));
      await Promise.all([
        upsertIpBlock(adminSupabase, ipAddress, blockUntilIso, "high_risk_pattern"),
        upsertFingerprintBlock(adminSupabase, prepared.fingerprintHash, blockUntilIso, "high_risk_pattern"),
      ]);
      await Promise.all([
        persistSecurityEvent(adminSupabase, {
          eventType: "security_block_ip",
          ...baseEvent,
          details: {
            reason: "high_risk_pattern",
            blockedUntil: blockUntilIso,
          },
        }),
        persistSecurityEvent(adminSupabase, {
          eventType: "security_block_fingerprint",
          ...baseEvent,
          details: {
            reason: "high_risk_pattern",
            blockedUntil: blockUntilIso,
          },
        }),
        persistSecurityEvent(adminSupabase, {
          eventType: "register_blocked_high_risk",
          ...baseEvent,
          details: suspiciousDetails,
        }),
      ]);
      logSecurityEvent(
        deps.logger,
        {
          eventType: "register_blocked_high_risk",
          ...baseEvent,
          details: {
            ...suspiciousDetails,
            blockedUntil: blockUntilIso,
          },
        },
        "warn",
      );
      throwRegistrationBlockedError();
    }
  }

  return {
    emailDomain: prepared.emailDomain,
    fingerprintHash: prepared.fingerprintHash,
  };
}

export async function reserveRegistrationLease(
  deps: AuthDependencies,
  context: AuthRequestContext,
  prepared: RegistrationRiskPreparedInput,
): Promise<RegistrationLease> {
  const nowIso = toIsoDate(new Date());
  const baseEvent = {
    ipAddress: context.ipAddress,
    fingerprintHash: prepared.fingerprintHash,
    emailDomain: prepared.emailDomain,
    emailMasked: prepared.emailMasked,
  };

  const { data, error } = await deps.adminSupabase.rpc("registration_try_acquire_lease", {
    p_ip_address: context.ipAddress,
    p_fingerprint_hash: prepared.fingerprintHash,
    p_now: nowIso,
    p_ip_limit: deps.env.registrationIpLimitMax,
    p_fingerprint_limit: deps.env.fingerprintLimitMax,
    p_ip_window_seconds: deps.env.registrationIpLimitWindowHours * 3600,
    p_fingerprint_window_seconds: deps.env.fingerprintLimitWindowHours * 3600,
    p_lease_ttl_seconds: deps.env.registrationLeaseTtlMinutes * 60,
  });
  await requireNoSupabaseError("registration_try_acquire_lease", error);

  const row = normalizeLeaseRpcRow(data);
  if (!row) {
    throw toStorageError("registration_try_acquire_lease_invalid_response", data);
  }

  if (row.allowed !== true) {
    const reason = String(row.reason ?? "").trim();
    const eventType: SecurityEventName = reason === "fingerprint_limit" ? "fingerprint_rate_limited" : "register_rate_limited";
    const details = {
      reason,
      ipCount: Number(row.ip_count ?? 0),
      fingerprintCount: Number(row.fingerprint_count ?? 0),
      ipLimit: deps.env.registrationIpLimitMax,
      fingerprintLimit: deps.env.fingerprintLimitMax,
    };
    await persistSecurityEvent(deps.adminSupabase, {
      eventType,
      ...baseEvent,
      details,
    });
    logSecurityEvent(
      deps.logger,
      {
        eventType,
        ...baseEvent,
        details,
      },
      "warn",
    );
    throwRateLimitedError();
  }

  const leaseId = String(row.lease_id ?? "").trim();
  if (!leaseId) {
    throw toStorageError("registration_try_acquire_lease_missing_id", row);
  }

  return {
    leaseId,
  };
}

export async function releaseRegistrationLease(
  deps: AuthDependencies,
  leaseIdRaw: string | null | undefined,
  releaseReasonRaw: string,
): Promise<void> {
  const leaseId = String(leaseIdRaw ?? "").trim();
  if (!leaseId) {
    return;
  }
  const releaseReason = truncate(String(releaseReasonRaw ?? "").trim() || "released", 120);

  const { data, error } = await deps.adminSupabase.rpc("registration_release_lease", {
    p_lease_id: leaseId,
    p_reason: releaseReason,
    p_now: toIsoDate(new Date()),
  });
  await requireNoSupabaseError("registration_release_lease", error);

  const released = normalizeRpcBoolean(data);
  if (!released) {
    deps.logger?.warn("registration_lease_release_noop", {
      leaseId,
      reason: releaseReason,
    });
  }
}

export async function consumeRegistrationLease(
  deps: AuthDependencies,
  leaseIdRaw: string | null | undefined,
): Promise<void> {
  const leaseId = String(leaseIdRaw ?? "").trim();
  if (!leaseId) {
    return;
  }

  const { data, error } = await deps.adminSupabase.rpc("registration_consume_lease", {
    p_lease_id: leaseId,
    p_now: toIsoDate(new Date()),
  });
  await requireNoSupabaseError("registration_consume_lease", error);

  const consumed = normalizeRpcBoolean(data);
  if (!consumed) {
    deps.logger?.warn("registration_lease_consume_noop", {
      leaseId,
    });
  }
}

export async function recordCaptchaFailure(deps: AuthDependencies, input: CaptchaFailureInput): Promise<void> {
  const nowMs = Date.now();
  const adminSupabase = deps.adminSupabase;
  const ipAddress = input.context.ipAddress;
  const shouldCountForPunitiveBlock = input.event !== "captcha_network_error";

  await persistSecurityEvent(adminSupabase, {
    eventType: input.event,
    ipAddress,
    fingerprintHash: input.prepared.fingerprintHash,
    emailDomain: input.prepared.emailDomain,
    emailMasked: input.prepared.emailMasked,
    details: input.details ?? {},
  });
  await persistSecurityEvent(adminSupabase, {
    eventType: "captcha_failed_attempt",
    ipAddress,
    fingerprintHash: input.prepared.fingerprintHash,
    emailDomain: input.prepared.emailDomain,
    emailMasked: input.prepared.emailMasked,
    details: {
      ...(input.details ?? {}),
      punitiveCounted: shouldCountForPunitiveBlock,
    },
  });
  logSecurityEvent(
    deps.logger,
    {
      eventType: input.event,
      ipAddress,
      fingerprintHash: input.prepared.fingerprintHash,
      emailDomain: input.prepared.emailDomain,
      emailMasked: input.prepared.emailMasked,
      details: {
        ...(input.details ?? {}),
        punitiveCounted: shouldCountForPunitiveBlock,
      },
    },
    "warn",
  );

  if (!shouldCountForPunitiveBlock) {
    return;
  }

  const { error: insertError } = await adminSupabase.from("captcha_failures_by_ip").insert({
    ip_address: ipAddress,
    fingerprint_hash: input.prepared.fingerprintHash,
    reason: input.event,
  });
  await requireNoSupabaseError("insert_captcha_failure", insertError);

  const sinceIso = toIsoDate(new Date(nowMs - deps.env.captchaFailWindowMinutes * ONE_MINUTE_MS));
  const captchaFailureCount = await countRowsByWindow(adminSupabase, "captcha_failures_by_ip", "ip_address", ipAddress, sinceIso);

  if (captchaFailureCount < deps.env.captchaFailLimit) {
    return;
  }

  const blockUntilIso = toIsoDate(new Date(nowMs + deps.env.captchaBlockHours * ONE_HOUR_MS));
  await upsertIpBlock(adminSupabase, ipAddress, blockUntilIso, "captcha_fail_limit");

  await persistSecurityEvent(adminSupabase, {
    eventType: "security_block_ip",
    ipAddress,
    fingerprintHash: input.prepared.fingerprintHash,
    emailDomain: input.prepared.emailDomain,
    emailMasked: input.prepared.emailMasked,
    details: {
      reason: "captcha_fail_limit",
      blockedUntil: blockUntilIso,
      failCount: captchaFailureCount,
      failLimit: deps.env.captchaFailLimit,
    },
  });
  logSecurityEvent(
    deps.logger,
    {
      eventType: "security_block_ip",
      ipAddress,
      fingerprintHash: input.prepared.fingerprintHash,
      emailDomain: input.prepared.emailDomain,
      emailMasked: input.prepared.emailMasked,
      details: {
        reason: "captcha_fail_limit",
        blockedUntil: blockUntilIso,
        failCount: captchaFailureCount,
        failLimit: deps.env.captchaFailLimit,
      },
    },
    "warn",
  );

  throwRegistrationBlockedError();
}

export async function recordRegistrationSuccess(deps: AuthDependencies, input: RegistrationSuccessInput): Promise<void> {
  const { context, prepared, userId } = input;
  const adminSupabase = deps.adminSupabase;

  const payload = {
    ip_address: context.ipAddress,
    fingerprint_hash: prepared.fingerprintHash,
    user_id: String(userId ?? "").trim() || null,
    email_domain: prepared.emailDomain,
  };

  const [ipInsert, fingerprintInsert, domainInsert, eventInsert] = await Promise.all([
    adminSupabase.from("registration_attempts_by_ip").insert({
      ip_address: payload.ip_address,
      fingerprint_hash: payload.fingerprint_hash,
      user_id: payload.user_id,
      email_domain: payload.email_domain,
    }),
    adminSupabase.from("registration_attempts_by_fingerprint").insert(payload),
    adminSupabase.from("registration_attempts_by_email_domain").insert(payload),
    adminSupabase.from("suspicious_registration_events").insert({
      event_type: "register_success",
      ip_address: context.ipAddress,
      fingerprint_hash: prepared.fingerprintHash,
      email_domain: prepared.emailDomain,
      email_masked: prepared.emailMasked,
      details: {},
    }),
  ]);

  await Promise.all([
    requireNoSupabaseError("insert_registration_attempts_by_ip", ipInsert.error),
    requireNoSupabaseError("insert_registration_attempts_by_fingerprint", fingerprintInsert.error),
    requireNoSupabaseError("insert_registration_attempts_by_email_domain", domainInsert.error),
    requireNoSupabaseError("insert_register_success_event", eventInsert.error),
  ]);

  logSecurityEvent(deps.logger, {
    eventType: "register_success",
    ipAddress: context.ipAddress,
    fingerprintHash: prepared.fingerprintHash,
    emailDomain: prepared.emailDomain,
    emailMasked: prepared.emailMasked,
    details: {},
  });
}

export function mapCaptchaFailureEvent(input: {
  reason:
    | "captcha_missing"
    | "captcha_invalid"
    | "captcha_expired"
    | "captcha_timeout"
    | "captcha_network_error"
    | "captcha_response_invalid"
    | "captcha_misconfigured";
}): CaptchaFailureInput["event"] {
  if (input.reason === "captcha_expired") {
    return "captcha_expired";
  }
  if (input.reason === "captcha_timeout") {
    return "captcha_timeout";
  }
  if (input.reason === "captcha_network_error") {
    return "captcha_network_error";
  }
  return "captcha_failed";
}

export function buildCaptchaHttpError(reason: string): AuthHttpError {
  switch (reason) {
    case "captcha_missing":
      return new AuthHttpError(400, "CAPTCHA_REQUIRED", REGISTRATION_ERROR_MESSAGE);
    case "captcha_expired":
      return new AuthHttpError(400, "CAPTCHA_EXPIRED", REGISTRATION_ERROR_MESSAGE);
    case "captcha_timeout":
      return new AuthHttpError(403, "CAPTCHA_TIMEOUT", REGISTRATION_ERROR_MESSAGE);
    case "captcha_network_error":
      return new AuthHttpError(403, "CAPTCHA_NETWORK_ERROR", REGISTRATION_ERROR_MESSAGE);
    case "captcha_misconfigured":
    case "captcha_response_invalid":
    case "captcha_invalid":
    default:
      return new AuthHttpError(403, "CAPTCHA_INVALID", REGISTRATION_ERROR_MESSAGE);
  }
}

export async function logRegisterPayloadInvalid(
  deps: AuthDependencies,
  context: AuthRequestContext,
  details: Record<string, unknown>,
): Promise<void> {
  const eventPayload: SecurityEventPayload = {
    eventType: "register_payload_invalid",
    ipAddress: context.ipAddress,
    details,
  };
  try {
    await persistSecurityEvent(deps.adminSupabase, eventPayload);
  } catch {
    // Keep original payload error, ignore persistence failures.
  }
  logSecurityEvent(deps.logger, eventPayload, "warn");
}

export function isRegistrationRiskStorageError(error: unknown): boolean {
  return (
    error instanceof AuthHttpError &&
    (error.code === "REGISTRATION_SECURITY_UNAVAILABLE" || error.code === "REGISTER_PAYLOAD_INVALID")
  );
}
