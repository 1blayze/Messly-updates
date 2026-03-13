/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { evaluateCorsRequest } from "../_shared/cors.ts";
import {
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { getLoginLocation, extractClientIpFromRequest, type LoginLocation } from "../_shared/loginLocation.ts";
import { getClientDeviceInfoFromRequest } from "../_shared/userAgent.ts";
import { resolveUserId, upsertUserIdentity } from "../_shared/user.ts";
import { createSupabaseRlsClient, getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";

const ROUTE = "sessions";
const SESSION_REASON_NEW_LOCATION = "new_location";
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_QUERY_BYTES = 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);

const LOCAL_RATE_WINDOW_MS = 60_000;
const localRateBuckets = new Map<string, { count: number; resetAtMs: number }>();

const clientVersionSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/)
  .optional()
  .nullable();

const clientTypeSchema = z.enum(["desktop", "web", "mobile", "unknown"]);
const platformSchema = z.string().trim().min(1).max(32);
const deviceIdSchema = z.string().trim().min(1).max(128);
const clientNameSchema = z.string().trim().min(1).max(80).optional().nullable();
const sessionIdentitySchema = z.string().trim().max(128).optional().nullable();

const postPayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upsert"),
      sessionId: sessionIdentitySchema,
      sessionToken: sessionIdentitySchema,
      deviceId: deviceIdSchema,
      clientType: clientTypeSchema,
      platform: platformSchema,
      clientName: clientNameSchema,
      appVersion: clientVersionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("end"),
      sessionId: sessionIdentitySchema,
      sessionToken: sessionIdentitySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("endById"),
      sessionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("endAllOther"),
      sessionId: sessionIdentitySchema,
      sessionToken: sessionIdentitySchema,
    })
    .strict(),
]);

interface UserSessionRow {
  id: string;
  user_id: string;
  session_token: string;
  auth_session_id: string | null;
  device_id: string | null;
  client_type: string | null;
  platform: string | null;
  ip_address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  location_label: string | null;
  device: string;
  os: string;
  app_version: string | null;
  client_version: string | null;
  user_agent: string | null;
  suspicious: boolean;
  suspicious_reason: string | null;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  revoked_at: string | null;
}

interface SessionView {
  id: string;
  recordId: string;
  deviceId: string;
  clientType: string;
  platform: string;
  device: string;
  os: string;
  appVersion: string | null;
  clientVersion: string | null;
  location: string | null;
  ipAddressMasked: string;
  createdAt: string;
  lastSeenAt: string;
  loggedInLabel: string;
  revokedAt: string | null;
  userAgent: string | null;
  suspicious: boolean;
}

type PostPayload = z.infer<typeof postPayloadSchema>;

function toErrorKey(error: HttpError | null): string {
  if (!error) {
    return "internal_error";
  }

  if (error.status === 401 || error.code === "INVALID_TOKEN" || error.code === "UNAUTHENTICATED") {
    return "unauthorized";
  }

  if (error.status === 429) {
    return "rate_limited";
  }

  return String(error.code ?? "internal_error")
    .trim()
    .toLowerCase();
}

function responseSessionError(request: Request, requestId: string, error: unknown): Response {
  const normalized = error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", "Erro interno.");
  return responseJson(
    request,
    {
      error: toErrorKey(error instanceof HttpError ? error : null),
      message: normalized.message,
      requestId,
    },
    normalized.status,
  );
}

function enforceAllowedMethod(request: Request): void {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Metodo nao suportado.");
  }
}

function enforceQueryLimit(request: Request): void {
  const url = new URL(request.url);
  const queryBytes = new TextEncoder().encode(url.search).byteLength;
  if (queryBytes > MAX_QUERY_BYTES) {
    throw new HttpError(414, "QUERY_TOO_LARGE", "Query string excede o limite permitido.");
  }
}

function enforceLocalRateLimit(key: string, limit: number): void {
  const nowMs = Date.now();
  const existing = localRateBuckets.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    localRateBuckets.set(key, {
      count: 1,
      resetAtMs: nowMs + LOCAL_RATE_WINDOW_MS,
    });
    return;
  }

  existing.count += 1;
  localRateBuckets.set(key, existing);
  if (existing.count > limit) {
    const retryAfterMs = Math.max(1, existing.resetAtMs - nowMs);
    throw new HttpError(429, "RATE_LIMITED", "Muitas requisicoes em pouco tempo.", {
      retryAfterMs,
      limit,
      windowMs: LOCAL_RATE_WINDOW_MS,
      backend: "memory",
    });
  }
}

async function hashUid(uidRaw: string): Promise<string> {
  const uid = String(uidRaw ?? "").trim();
  if (!uid) {
    return "unknown";
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid));
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function decodeSupabaseSessionId(tokenRaw: string): string | null {
  const token = String(tokenRaw ?? "").trim();
  if (!token) {
    return null;
  }

  const [, payloadSegment = ""] = token.split(".");
  if (!payloadSegment) {
    return null;
  }

  try {
    const normalizedPayload = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, "=");
    const payloadText = atob(paddedPayload);
    const payload = JSON.parse(payloadText) as { session_id?: unknown; sessionId?: unknown };
    const sessionId = String(payload.session_id ?? payload.sessionId ?? "").trim();
    return isUuidLike(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function parsePostPayload(payload: unknown): PostPayload {
  const parsed = postPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const legacyEndAllOther = normalizeLegacyEndAllOtherPayload(payload);
  if (legacyEndAllOther) {
    return legacyEndAllOther;
  }

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload de sessao invalido.", {
    issues: parsed.error.issues.map((issue: { path: string[]; code: string; message: string }) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function toPayloadRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function resolveLegacySessionIdentity(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.sessionId,
    payload.session_id,
    payload.sessionToken,
    payload.session_token,
    payload.currentSessionId,
    payload.current_session_id,
  ];

  for (const candidate of candidates) {
    const normalized = toNullableText(candidate, 128);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeLegacyEndAllOtherPayload(payload: unknown): Extract<PostPayload, { action: "endAllOther" }> | null {
  const input = toPayloadRecord(payload);
  if (!input) {
    return null;
  }

  const action = String(input.action ?? "").trim().toLowerCase();
  const acceptedLegacyActions = new Set([
    "endallother",
    "endallothers",
    "endallothersessions",
    "end_all_other",
    "end_all_others",
    "end_all_other_sessions",
  ]);

  if (!acceptedLegacyActions.has(action)) {
    return null;
  }

  const sessionIdentity = resolveLegacySessionIdentity(input);
  if (sessionIdentity) {
    return {
      action: "endAllOther",
      sessionId: sessionIdentity,
      sessionToken: sessionIdentity,
    };
  }

  return {
    action: "endAllOther",
    sessionId: null,
    sessionToken: null,
  };
}

function toNullableText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
  return normalized || null;
}

function resolveRequestedSessionId(payload: PostPayload, accessToken: string): string {
  const authSessionId = decodeSupabaseSessionId(accessToken);
  if (authSessionId) {
    return authSessionId;
  }

  if ("sessionId" in payload && isUuidLike(String(payload.sessionId ?? "").trim())) {
    return String(payload.sessionId ?? "").trim();
  }

  if ("sessionToken" in payload && isUuidLike(String(payload.sessionToken ?? "").trim())) {
    return String(payload.sessionToken ?? "").trim();
  }

  return "";
}

function buildLocationLabel(city: string | null, region: string | null, country: string | null): string | null {
  const parts = [city, region, country]
    .map((part) => toNullableText(part, 120))
    .filter((part, index, array): part is string => Boolean(part) && array.indexOf(part) === index);

  return parts.length > 0 ? parts.join(", ") : null;
}

function buildLocationFingerprint(city: string | null, region: string | null, country: string | null): string | null {
  const normalized = [city, region, country]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join("|") : null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizePlatformLabel(platformRaw: string | null | undefined): string {
  const platform = String(platformRaw ?? "").trim().toLowerCase();
  switch (platform) {
    case "win32":
    case "windows":
      return "windows";
    case "darwin":
    case "mac":
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    case "web":
    case "browser":
      return "browser";
    case "android":
      return "android";
    case "ios":
    case "iphone":
    case "ipad":
      return "ios";
    default:
      return platform || "unknown";
  }
}

function resolveClientName(payload: Extract<PostPayload, { action: "upsert" }>, request: Request): string {
  const explicit = toNullableText(payload.clientName, 80);
  if (explicit) {
    return explicit;
  }

  return toNullableText(getClientDeviceInfoFromRequest(request).device, 80) ?? "Unknown Client";
}

function maskIpAddress(ipAddressRaw: string): string {
  const ipAddress = String(ipAddressRaw ?? "").trim();
  if (!ipAddress) {
    return "0.0.0.0";
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress)) {
    const [firstOctet] = ipAddress.split(".");
    return `${firstOctet ?? "0"}.xxx.xxx.xxx`;
  }

  const segments = ipAddress.split(":");
  const visible = segments.slice(0, 2);
  while (visible.length < 2) {
    visible.push("xxxx");
  }
  return `${visible.join(":")}:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx`;
}

function formatLoggedInLabel(createdAtRaw: string): string {
  const createdAtMs = Date.parse(createdAtRaw);
  if (!Number.isFinite(createdAtMs)) {
    return "Logged in recently";
  }

  const diffMs = Math.max(0, Date.now() - createdAtMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return "Logged in just now";
  }
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.round(diffMs / minuteMs));
    return `Logged in ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.round(diffMs / hourMs));
    return `Logged in ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.max(1, Math.round(diffMs / dayMs));
  return `Logged in ${days} day${days === 1 ? "" : "s"} ago`;
}

function toSessionView(row: UserSessionRow): SessionView {
  return {
    id: row.auth_session_id ?? row.id,
    recordId: row.id,
    deviceId: toNullableText(row.device_id, 128) ?? `legacy:${row.id}`,
    clientType: toNullableText(row.client_type, 32) ?? "unknown",
    platform: toNullableText(row.platform, 32) ?? "unknown",
    device: row.device,
    os: row.os,
    appVersion: toNullableText(row.app_version, 32),
    clientVersion: toNullableText(row.client_version, 32),
    location: toNullableText(row.location_label, 240) ?? buildLocationLabel(row.city, row.region, row.country),
    ipAddressMasked: maskIpAddress(row.ip_address),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    loggedInLabel: formatLoggedInLabel(row.created_at),
    revokedAt: row.revoked_at ?? row.ended_at ?? null,
    userAgent: toNullableText(row.user_agent, 512),
    suspicious: Boolean(row.suspicious),
  };
}

async function findSessionByKey(sessionIdRaw: string): Promise<UserSessionRow | null> {
  const sessionId = toNullableText(sessionIdRaw, 64);
  if (!sessionId) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  if (isUuidLike(sessionId)) {
    const authSessionLookup = await supabase
      .from("user_sessions")
      .select("*")
      .eq("auth_session_id", sessionId)
      .limit(1)
      .maybeSingle();

    if (authSessionLookup.error) {
      throw new HttpError(500, "SESSION_LOOKUP_FAILED", "Falha ao consultar a sessao atual.");
    }

    if (authSessionLookup.data) {
      return authSessionLookup.data as UserSessionRow;
    }
  }

  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("session_token", sessionId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "SESSION_LOOKUP_FAILED", "Falha ao consultar a sessao atual.");
  }

  return (data as UserSessionRow | null) ?? null;
}

async function isSuspiciousLocation(userId: string, location: LoginLocation): Promise<boolean> {
  const candidateFingerprint = buildLocationFingerprint(location.city, location.region, location.country);
  if (!candidateFingerprint) {
    return false;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .select("city,region,country")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new HttpError(500, "SESSION_LOCATION_CHECK_FAILED", "Falha ao verificar localizacoes anteriores.");
  }

  const previousRows = ((data ?? []) as Array<{ city?: string | null; region?: string | null; country?: string | null }>)
    .map((row) => buildLocationFingerprint(row.city ?? null, row.region ?? null, row.country ?? null))
    .filter((row): row is string => Boolean(row));

  if (previousRows.length === 0) {
    return false;
  }

  return !previousRows.includes(candidateFingerprint);
}

async function insertLoginSession(
  userId: string,
  payload: PostPayload,
  request: Request,
  location: LoginLocation,
  accessToken: string,
): Promise<{ session: UserSessionRow; created: boolean; securityNotificationTriggered: boolean }> {
  if (payload.action !== "upsert") {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload de sessao invalido.");
  }

  const sessionId = resolveRequestedSessionId(payload, accessToken);
  if (!sessionId) {
    throw new HttpError(401, "INVALID_TOKEN", "Sessao atual invalida.");
  }

  const existingSession = await findSessionByKey(sessionId);
  if (existingSession) {
    if (existingSession.user_id !== userId) {
      throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Token de sessao invalido para este usuario.");
    }

    if (existingSession.ended_at || existingSession.revoked_at) {
      throw new HttpError(409, "SESSION_ALREADY_ENDED", "A sessao atual ja foi encerrada.");
    }

    const clientInfo = getClientDeviceInfoFromRequest(request);
    const nowIso = new Date().toISOString();
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("user_sessions")
      .update({
        auth_session_id: sessionId,
        session_token: sessionId,
        device_id: payload.deviceId,
        client_type: payload.clientType,
        platform: normalizePlatformLabel(payload.platform),
        ip_address: location.ip,
        city: toNullableText(location.city, 120),
        region: toNullableText(location.region, 120),
        country: toNullableText(location.country, 120),
        location_label: buildLocationLabel(
          toNullableText(location.city, 120),
          toNullableText(location.region, 120),
          toNullableText(location.country, 120),
        ),
        device: resolveClientName(payload, request),
        os: toNullableText(clientInfo.os, 80) ?? "Unknown OS",
        app_version: toNullableText(payload.appVersion, 32),
        client_version: toNullableText(payload.appVersion, 32),
        user_agent: toNullableText(clientInfo.userAgent, 512),
        last_seen_at: nowIso,
        ended_at: null,
        revoked_at: null,
      })
      .eq("id", existingSession.id)
      .select("*")
      .single();

    if (error || !data) {
      throw new HttpError(500, "SESSION_UPDATE_FAILED", "Falha ao atualizar a sessao atual.");
    }

    return {
      session: data as UserSessionRow,
      created: false,
      securityNotificationTriggered: false,
    };
  }

  const suspicious = await isSuspiciousLocation(userId, location);
  const nowIso = new Date().toISOString();
  const clientInfo = getClientDeviceInfoFromRequest(request);
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .insert({
      user_id: userId,
      session_token: sessionId,
      auth_session_id: sessionId,
      device_id: payload.deviceId,
      client_type: payload.clientType,
      platform: normalizePlatformLabel(payload.platform),
      ip_address: location.ip,
      city: toNullableText(location.city, 120),
      region: toNullableText(location.region, 120),
      country: toNullableText(location.country, 120),
      location_label: buildLocationLabel(
        toNullableText(location.city, 120),
        toNullableText(location.region, 120),
        toNullableText(location.country, 120),
      ),
      device: resolveClientName(payload, request),
      os: toNullableText(clientInfo.os, 80) ?? "Unknown OS",
      app_version: toNullableText(payload.appVersion, 32),
      client_version: toNullableText(payload.appVersion, 32),
      user_agent: toNullableText(clientInfo.userAgent, 512),
      suspicious,
      suspicious_reason: suspicious ? SESSION_REASON_NEW_LOCATION : null,
      created_at: nowIso,
      last_seen_at: nowIso,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, "SESSION_INSERT_FAILED", "Falha ao registrar a sessao de login.");
  }

  return {
    session: data as UserSessionRow,
    created: true,
    securityNotificationTriggered: suspicious,
  };
}

async function findSessionByRecordId(sessionIdRaw: string): Promise<UserSessionRow | null> {
  const sessionId = toNullableText(sessionIdRaw, 64);
  if (!sessionId) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("id", sessionId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "SESSION_LOOKUP_FAILED", "Falha ao consultar a sessao selecionada.");
  }

  return (data as UserSessionRow | null) ?? null;
}

async function endLoginSession(userId: string, sessionIdRaw: string): Promise<UserSessionRow | null> {
  const existingSession = await findSessionByKey(sessionIdRaw);
  if (!existingSession) {
    return null;
  }

  if (existingSession.user_id !== userId) {
    throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Token de sessao invalido para este usuario.");
  }

  if (existingSession.ended_at || existingSession.revoked_at) {
    return existingSession;
  }

  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .update({
      ended_at: nowIso,
      revoked_at: nowIso,
      last_seen_at: nowIso,
    })
    .eq("id", existingSession.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, "SESSION_END_FAILED", "Falha ao encerrar a sessao atual.");
  }

  return data as UserSessionRow;
}

async function endLoginSessionById(userId: string, sessionId: string): Promise<UserSessionRow | null> {
  const existingSession = (await findSessionByKey(sessionId)) ?? (await findSessionByRecordId(sessionId));
  if (!existingSession) {
    return null;
  }

  if (existingSession.user_id !== userId) {
    throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Sessao invalida para este usuario.");
  }

  if (existingSession.ended_at || existingSession.revoked_at) {
    return existingSession;
  }

  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .update({
      ended_at: nowIso,
      revoked_at: nowIso,
      last_seen_at: nowIso,
    })
    .eq("id", existingSession.id)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, "SESSION_END_FAILED", "Falha ao encerrar a sessao selecionada.");
  }

  return data as UserSessionRow;
}

async function endAllOtherLoginSessions(
  userId: string,
  currentSessionIdRaw: string,
): Promise<{ endedCount: number }> {
  const currentSessionId = toNullableText(currentSessionIdRaw, 64);
  if (!currentSessionId) {
    throw new HttpError(401, "INVALID_TOKEN", "Sessao atual invalida.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: activeSessions, error: activeSessionsError } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("user_id", userId)
    .is("ended_at", null)
    .is("revoked_at", null);

  if (activeSessionsError) {
    throw new HttpError(500, "SESSION_LIST_FAILED", "Falha ao listar sessoes ativas.");
  }

  const rows = (activeSessions ?? []) as UserSessionRow[];
  const rowsToEnd = rows.filter((row) => {
    const authSessionId = toNullableText(row.auth_session_id, 64);
    const sessionToken = toNullableText(row.session_token, 64);
    return authSessionId !== currentSessionId && sessionToken !== currentSessionId;
  });

  if (rowsToEnd.length === 0) {
    return { endedCount: 0 };
  }

  const nowIso = new Date().toISOString();
  const idsToEnd = rowsToEnd.map((row) => row.id);
  const { data: updatedRows, error: updateError } = await supabase
    .from("user_sessions")
    .update({
      ended_at: nowIso,
      revoked_at: nowIso,
      last_seen_at: nowIso,
    })
    .in("id", idsToEnd)
    .select("id");

  if (updateError) {
    throw new HttpError(500, "SESSION_END_FAILED", "Falha ao encerrar as outras sessoes.");
  }

  return {
    endedCount: Array.isArray(updatedRows) ? updatedRows.length : 0,
  };
}

async function listActiveSessions(accessToken: string): Promise<SessionView[]> {
  const supabase = createSupabaseRlsClient(accessToken);
  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .is("ended_at", null)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "SESSION_LIST_FAILED", "Falha ao listar as sessoes ativas.");
  }

  return ((data ?? []) as UserSessionRow[]).map(toSessionView);
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE, request);
  const requestIp = extractClientIpFromRequest(request);

  try {
    const cors = evaluateCorsRequest(request);
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    if (!cors.isAllowed) {
      throw new HttpError(403, "CORS_FORBIDDEN", "Origin nao permitida.");
    }

    enforceAllowedMethod(request);
    enforceQueryLimit(request);
    enforceLocalRateLimit(`ip:${requestIp}`, 180);
    await enforceRateLimit(`sessions:ip:${requestIp}`, 240, 60_000, ROUTE, {
      action: "auth",
    });

    const auth = await validateSupabaseToken(request);

    const uidHash = await hashUid(auth.uid);
    const userId = await resolveUserId(auth.uid, auth.email);
    await upsertUserIdentity(auth.uid, userId, auth.email);
    enforceLocalRateLimit(`uid:${auth.uid}`, 240);

    if (request.method.toUpperCase() === "GET") {
      context.action = "list";
      await enforceRateLimit(`sessions:list:${auth.uid}:${requestIp}`, 120, 60_000, ROUTE, {
        action: "list",
      });

      const sessions = await listActiveSessions(auth.token);
      logStructured("info", "sessions_list_success", context, {
        status: 200,
        uidHash,
        count: sessions.length,
      });

      return responseJson(
        request,
        {
          user: {
            firebase_uid: auth.uid,
            email: auth.email,
          },
          sessions,
          serverTime: new Date().toISOString(),
        },
        200,
      );
    }

    const rawPayload = await parseJsonBody<unknown>(request, MAX_JSON_BODY_BYTES);
    const payload = parsePostPayload(rawPayload);
    context.action = payload.action;

    await enforceRateLimit(
      `sessions:${payload.action}:${auth.uid}:${requestIp}`,
      payload.action === "upsert" ? 20 : 40,
      60_000,
      ROUTE,
      {
        action: payload.action,
      },
    );

    if (payload.action === "end") {
      const session = await endLoginSession(userId, resolveRequestedSessionId(payload, auth.token));
      logStructured("info", "session_end_success", context, {
        status: 200,
        uidHash,
        sessionId: session?.auth_session_id ?? session?.id ?? null,
      });

      return responseJson(
        request,
        {
          ended: Boolean(session?.ended_at),
          session: session ? toSessionView(session) : null,
        },
        200,
      );
    }

    if (payload.action === "endById") {
      const session = await endLoginSessionById(userId, payload.sessionId);
      logStructured("info", "session_end_by_id_success", context, {
        status: 200,
        uidHash,
        sessionId: session?.auth_session_id ?? session?.id ?? null,
      });

      return responseJson(
        request,
        {
          ended: Boolean(session?.ended_at),
          session: session ? toSessionView(session) : null,
        },
        200,
      );
    }

    if (payload.action === "endAllOther") {
      const currentSessionId = resolveRequestedSessionId(payload, auth.token);
      const result = await endAllOtherLoginSessions(userId, currentSessionId);
      logStructured("warn", "session_end_all_other_success", context, {
        status: 200,
        uidHash,
        currentSessionId,
        endedCount: result.endedCount,
      });

      return responseJson(
        request,
        {
          ended: true,
          endedCount: result.endedCount,
        },
        200,
      );
    }

    const location = await getLoginLocation(requestIp);
    const result = await insertLoginSession(userId, payload, request, location, auth.token);

    if (result.securityNotificationTriggered) {
      logStructured("warn", "suspicious_login_location", context, {
        status: 200,
        uidHash,
        sessionId: result.session.auth_session_id ?? result.session.id,
        ipAddress: location.ip,
        city: location.city || null,
        region: location.region || null,
        country: location.country || null,
      });
    } else {
      logStructured("info", "session_upsert_success", context, {
        status: 200,
        uidHash,
        sessionId: result.session.auth_session_id ?? result.session.id,
        created: result.created,
      });
    }

    return responseJson(
      request,
      {
        session: toSessionView(result.session),
        suspicious: result.session.suspicious,
        securityNotificationTriggered: result.securityNotificationTriggered,
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    logStructured("error", "sessions_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseSessionError(request, context.requestId, error);
  }
});
