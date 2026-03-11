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

const postPayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upsert"),
      sessionToken: z.string().uuid(),
      clientVersion: clientVersionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("end"),
      sessionToken: z.string().uuid(),
      clientVersion: clientVersionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("endById"),
      sessionId: z.string().uuid(),
      clientVersion: clientVersionSchema,
    })
    .strict(),
]);

interface UserSessionRow {
  id: string;
  user_id: string;
  session_token: string;
  ip_address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  device: string;
  os: string;
  client_version: string | null;
  user_agent: string | null;
  suspicious: boolean;
  suspicious_reason: string | null;
  security_notification_sent_at: string | null;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

interface SessionView {
  id: string;
  device: string;
  os: string;
  clientVersion: string | null;
  location: string | null;
  ipAddressMasked: string;
  createdAt: string;
  loggedInLabel: string;
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

function parsePostPayload(payload: unknown): PostPayload {
  const parsed = postPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload de sessao invalido.", {
    issues: parsed.error.issues.map((issue: { path: string[]; code: string; message: string }) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function toNullableText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
  return normalized || null;
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
    id: row.id,
    device: row.device,
    os: row.os,
    clientVersion: toNullableText(row.client_version, 32),
    location: buildLocationLabel(row.city, row.region, row.country),
    ipAddressMasked: maskIpAddress(row.ip_address),
    createdAt: row.created_at,
    loggedInLabel: formatLoggedInLabel(row.created_at),
    suspicious: Boolean(row.suspicious),
  };
}

async function findSessionByToken(sessionToken: string): Promise<UserSessionRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("session_token", sessionToken)
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
): Promise<{ session: UserSessionRow; created: boolean; securityNotificationTriggered: boolean }> {
  const sessionToken = payload.sessionToken;
  const existingSession = await findSessionByToken(sessionToken);
  if (existingSession) {
    if (existingSession.user_id !== userId) {
      throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Token de sessao invalido para este usuario.");
    }

    if (existingSession.ended_at) {
      throw new HttpError(409, "SESSION_ALREADY_ENDED", "A sessao atual ja foi encerrada.");
    }

    const clientInfo = getClientDeviceInfoFromRequest(request);
    const nowIso = new Date().toISOString();
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("user_sessions")
      .update({
        ip_address: location.ip,
        city: toNullableText(location.city, 120),
        region: toNullableText(location.region, 120),
        country: toNullableText(location.country, 120),
        device: toNullableText(clientInfo.device, 80) ?? "Unknown Client",
        os: toNullableText(clientInfo.os, 80) ?? "Unknown OS",
        client_version: toNullableText(payload.clientVersion, 32),
        user_agent: toNullableText(clientInfo.userAgent, 512),
        last_seen_at: nowIso,
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
      session_token: sessionToken,
      ip_address: location.ip,
      city: toNullableText(location.city, 120),
      region: toNullableText(location.region, 120),
      country: toNullableText(location.country, 120),
      device: toNullableText(clientInfo.device, 80) ?? "Unknown Client",
      os: toNullableText(clientInfo.os, 80) ?? "Unknown OS",
      client_version: toNullableText(payload.clientVersion, 32),
      user_agent: toNullableText(clientInfo.userAgent, 512),
      suspicious,
      suspicious_reason: suspicious ? SESSION_REASON_NEW_LOCATION : null,
      security_notification_sent_at: suspicious ? nowIso : null,
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

async function endLoginSession(userId: string, sessionToken: string): Promise<UserSessionRow | null> {
  const existingSession = await findSessionByToken(sessionToken);
  if (!existingSession) {
    return null;
  }

  if (existingSession.user_id !== userId) {
    throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Token de sessao invalido para este usuario.");
  }

  if (existingSession.ended_at) {
    return existingSession;
  }

  const nowIso = new Date().toISOString();
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .update({
      ended_at: nowIso,
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
  const supabase = getSupabaseAdminClient();
  const { data: existingData, error: existingError } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("id", sessionId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new HttpError(500, "SESSION_LOOKUP_FAILED", "Falha ao consultar a sessao selecionada.");
  }

  const existingSession = (existingData as UserSessionRow | null) ?? null;
  if (!existingSession) {
    return null;
  }

  if (existingSession.user_id !== userId) {
    throw new HttpError(403, "SESSION_TOKEN_CONFLICT", "Sessao invalida para este usuario.");
  }

  if (existingSession.ended_at) {
    return existingSession;
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("user_sessions")
    .update({
      ended_at: nowIso,
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

async function listActiveSessions(accessToken: string): Promise<SessionView[]> {
  const supabase = createSupabaseRlsClient(accessToken);
  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .is("ended_at", null)
    .order("created_at", { ascending: false });

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

    const auth = await validateSupabaseToken(request, {
      allowAuthorizationFallback: false,
    });

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
      const session = await endLoginSession(userId, payload.sessionToken);
      logStructured("info", "session_end_success", context, {
        status: 200,
        uidHash,
        sessionId: session?.id ?? null,
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
        sessionId: session?.id ?? null,
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

    const location = await getLoginLocation(requestIp);
    const result = await insertLoginSession(userId, payload, request, location);

    if (result.securityNotificationTriggered) {
      logStructured("warn", "suspicious_login_location", context, {
        status: 200,
        uidHash,
        sessionId: result.session.id,
        ipAddress: location.ip,
        city: location.city || null,
        region: location.region || null,
        country: location.country || null,
      });
    } else {
      logStructured("info", "session_upsert_success", context, {
        status: 200,
        uidHash,
        sessionId: result.session.id,
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
