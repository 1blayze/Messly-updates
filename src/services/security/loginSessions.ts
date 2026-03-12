import { z } from "zod";
import { supabase } from "../supabase";
import { EdgeFunctionError, invokeEdgeGet, invokeEdgeJson } from "../edge/edgeClient";
import { authService } from "../auth";
import { getInMemorySession } from "../auth/authStore";
import { getSessionClientDescriptor } from "./sessionClientInfo";
import appPackage from "../../../package.json";

const SESSION_ID_STORAGE_PREFIX = "messly:security:session-id:";
const LIST_SESSIONS_CACHE_TTL_MS = 8_000;
const SESSIONS_EDGE_UNAUTHORIZED_COOLDOWN_MS = 2 * 60_000;
const SESSION_STATUS_GRACE_PERIOD_MS = 90_000;

let sessionsMutationApiTemporarilyDisabled = false;
let sessionsDirectApiTemporarilyDisabled = false;
let sessionsEdgeUnauthorizedCooldownUntil = 0;
const listSessionsCacheByUid = new Map<string, { fetchedAt: number; sessions: LoginSessionView[] }>();
const listSessionsInFlightByUid = new Map<string, Promise<ListActiveLoginSessionsResult>>();

let cachedAuthUid: string | null = null;
let cachedAuthSessionId: string | null = null;
let cachedAuthSessionObservedAtMs = 0;
const confirmedSessionIdsByUid = new Map<string, Set<string>>();

const sessionViewSchema = z.object({
  id: z.string().uuid(),
  recordId: z.string().uuid(),
  deviceId: z.string().min(1),
  clientType: z.string().min(1),
  platform: z.string().min(1),
  device: z.string().min(1),
  os: z.string().min(1),
  appVersion: z.string().min(1).max(32).nullable(),
  clientVersion: z.string().min(1).max(32).nullable(),
  location: z.string().min(1).nullable(),
  ipAddressMasked: z.string().min(1),
  createdAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  loggedInLabel: z.string().min(1),
  revokedAt: z.string().min(1).nullable(),
  userAgent: z.string().min(1).nullable(),
  suspicious: z.boolean(),
});

const upsertSessionResponseSchema = z.object({
  session: sessionViewSchema,
  suspicious: z.boolean(),
  securityNotificationTriggered: z.boolean(),
});

const endSessionResponseSchema = z.object({
  ended: z.boolean(),
  session: sessionViewSchema.nullable(),
});

const listSessionsResponseSchema = z.object({
  user: z
    .object({
      firebase_uid: z.string().min(1),
      email: z.string().email().nullable(),
    })
    .optional(),
  sessions: z.array(sessionViewSchema),
  serverTime: z.string().min(1).optional(),
});

const directUserSessionRowSchema = z.object({
  id: z.string().uuid(),
  auth_session_id: z.string().uuid().nullable().optional(),
  device_id: z.string().min(1).nullable().optional(),
  client_type: z.string().min(1).nullable().optional(),
  platform: z.string().min(1).nullable().optional(),
  device: z.string().min(1),
  os: z.string().min(1),
  app_version: z.string().min(1).max(32).nullable().optional(),
  client_version: z.string().min(1).max(32).nullable(),
  city: z.string().min(1).nullable(),
  region: z.string().min(1).nullable(),
  country: z.string().min(1).nullable(),
  location_label: z.string().min(1).nullable().optional(),
  ip_address: z.string().min(1),
  created_at: z.string().min(1),
  last_seen_at: z.string().min(1),
  user_agent: z.string().min(1).nullable().optional(),
  suspicious: z.boolean().nullable().optional(),
  revoked_at: z.string().min(1).nullable().optional(),
});

export type LoginSessionView = z.infer<typeof sessionViewSchema>;
export type CurrentLoginSessionStatus = "active" | "ended" | "unknown";

interface ListActiveLoginSessionsResult {
  sessions: LoginSessionView[];
  authoritative: boolean;
}

function decodeSupabaseSessionId(tokenRaw: string | null | undefined): string | null {
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
    const payloadText = window.atob(paddedPayload);
    const payload = JSON.parse(payloadText) as { session_id?: unknown; sessionId?: unknown };
    const sessionId = String(payload.session_id ?? payload.sessionId ?? "").trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

function updateCachedAuthState(): void {
  const session = getInMemorySession();
  cachedAuthUid = String(session?.user?.id ?? "").trim() || null;
  cachedAuthSessionId = decodeSupabaseSessionId(session?.access_token ?? null);
  cachedAuthSessionObservedAtMs = cachedAuthSessionId ? Date.now() : 0;

  if (cachedAuthUid && cachedAuthSessionId) {
    setStoredSessionId(cachedAuthUid, cachedAuthSessionId);
  }
}

function normalizeSessionIdentity(valueRaw: string | null | undefined): string {
  return String(valueRaw ?? "").trim();
}

function markSessionAsConfirmed(uidRaw: string | null | undefined, sessionIdRaw: string | null | undefined): void {
  const uid = normalizeSessionIdentity(uidRaw);
  const sessionId = normalizeSessionIdentity(sessionIdRaw);
  if (!uid || !sessionId) {
    return;
  }

  const current = confirmedSessionIdsByUid.get(uid) ?? new Set<string>();
  current.add(sessionId);
  confirmedSessionIdsByUid.set(uid, current);
}

function hasConfirmedSession(uidRaw: string | null | undefined, sessionIdRaw: string | null | undefined): boolean {
  const uid = normalizeSessionIdentity(uidRaw);
  const sessionId = normalizeSessionIdentity(sessionIdRaw);
  if (!uid || !sessionId) {
    return false;
  }
  return confirmedSessionIdsByUid.get(uid)?.has(sessionId) ?? false;
}

function clearConfirmedSessions(uidRaw: string | null | undefined): void {
  const uid = normalizeSessionIdentity(uidRaw);
  if (!uid) {
    return;
  }
  confirmedSessionIdsByUid.delete(uid);
}

void authService.getCurrentSession().then(() => {
  updateCachedAuthState();
}).catch(() => undefined);

supabase.auth.onAuthStateChange((_event, session) => {
  const previousUid = cachedAuthUid;
  cachedAuthUid = String(session?.user?.id ?? "").trim() || null;
  cachedAuthSessionId = decodeSupabaseSessionId(session?.access_token ?? null);
  cachedAuthSessionObservedAtMs = cachedAuthSessionId ? Date.now() : 0;
  const didAuthPrincipalChange = previousUid !== cachedAuthUid;
  if (didAuthPrincipalChange) {
    clearSessionsEdgeUnauthorizedCooldown();
    if (cachedAuthUid) {
      sessionsMutationApiTemporarilyDisabled = false;
      sessionsDirectApiTemporarilyDisabled = false;
    }
  }

  if (previousUid) {
    invalidateListSessionsCache(previousUid);
    clearConfirmedSessions(previousUid);
  }
  if (cachedAuthUid) {
    invalidateListSessionsCache(cachedAuthUid);
  }

  if (cachedAuthUid && cachedAuthSessionId) {
    setStoredSessionId(cachedAuthUid, cachedAuthSessionId);
    return;
  }

  if (previousUid) {
    clearStoredSessionId(previousUid);
  }
});

function invalidateListSessionsCache(uidRaw: string | null | undefined): void {
  const uid = String(uidRaw ?? "").trim();
  if (!uid) {
    return;
  }
  listSessionsCacheByUid.delete(uid);
}

function shouldDisableSessionsMutationApiForError(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    if (error.status === 401 || error.status === 403) {
      return true;
    }
    if (error.status === 404 && error.code === "NOT_FOUND") {
      return true;
    }
    if (error.code === "EDGE_NETWORK_ERROR" || error.status === 0) {
      return true;
    }
    return false;
  }

  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("cors") ||
    message.includes("function was not found") ||
    message.includes("requested function was not found")
  );
}

function isUnauthorizedSessionsEdgeError(error: unknown): boolean {
  if (!(error instanceof EdgeFunctionError)) {
    return false;
  }

  const status = Number(error.status ?? 0);
  if (status === 401 || status === 403) {
    return true;
  }

  const code = String(error.code ?? "").trim().toUpperCase();
  const message = String(error.message ?? "").trim().toLowerCase();
  return (
    code === "INVALID_TOKEN" ||
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    message.includes("invalid jwt") ||
    message.includes("sessao invalida") ||
    message.includes("sessão inválida") ||
    (message.includes("token") && message.includes("expir"))
  );
}

function activateSessionsEdgeUnauthorizedCooldown(): void {
  sessionsEdgeUnauthorizedCooldownUntil = Date.now() + SESSIONS_EDGE_UNAUTHORIZED_COOLDOWN_MS;
}

function clearSessionsEdgeUnauthorizedCooldown(): void {
  sessionsEdgeUnauthorizedCooldownUntil = 0;
}

function isSessionsEdgeUnauthorizedCooldownActive(): boolean {
  return sessionsEdgeUnauthorizedCooldownUntil > Date.now();
}

function shouldDisableSessionsApiForDirectError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  if (status === 401 || status === 403) {
    return true;
  }

  return (
    code === "PGRST301" ||
    message.includes("jwt") ||
    message.includes("session not found") ||
    message.includes("session from session_id claim in jwt does not exist") ||
    message.includes("not authenticated") ||
    message.includes("permission denied") ||
    message.includes("row level security")
  );
}

function shouldClearLocalSessionForAuthError(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    const status = Number(error.status ?? 0);
    const code = String(error.code ?? "").trim().toUpperCase();
    const message = String(error.message ?? "").trim().toLowerCase();

    if (status === 401 || status === 403) {
      return true;
    }

    return (
      code === "UNAUTHENTICATED" ||
      code === "UNAUTHORIZED" ||
      code === "INVALID_TOKEN" ||
      code === "SESSION_NOT_FOUND" ||
      message.includes("invalid jwt") ||
      message.includes("jwt expired") ||
      message.includes("session not found") ||
      message.includes("session from session_id claim in jwt does not exist")
    );
  }

  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();
  const details = String((error as { details?: unknown } | null)?.details ?? "").trim().toLowerCase();
  const combined = `${code} ${message} ${details}`;

  return (
    status === 401 ||
    status === 403 ||
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "INVALID_TOKEN" ||
    code === "INVALID_JWT" ||
    code === "JWT_EXPIRED" ||
    code === "SESSION_NOT_FOUND" ||
    code === "PGRST301" ||
    combined.includes("invalid jwt") ||
    combined.includes("jwt expired") ||
    combined.includes("session not found") ||
    combined.includes("session from session_id claim in jwt does not exist") ||
    combined.includes("session_id claim")
  );
}

function clearLocalSessionIfInvalid(error: unknown, uidRaw?: string | null): void {
  if (!shouldClearLocalSessionForAuthError(error)) {
    return;
  }

  const uid = normalizeSessionIdentity(uidRaw);
  if (uid) {
    clearStoredSessionId(uid);
    invalidateListSessionsCache(uid);
  }
  // Session registry checks are optional hardening. Do not force a global sign-out
  // when this subsystem detects auth/session inconsistencies, because transient
  // edge/RLS/config issues here can otherwise eject valid users from the app.
}

function shouldFallbackToEdgeSessionsList(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  if (
    status === 400 ||
    status === 404 ||
    code === "42P01" ||
    code === "PGRST205" ||
    code === "PGRST106" ||
    code === "PGRST204"
  ) {
    return true;
  }

  return (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("column") ||
    message.includes("ended_at")
  );
}

function buildSessionIdStorageKey(uid: string): string {
  return `${SESSION_ID_STORAGE_PREFIX}${uid}`;
}

function getCurrentAuthUid(): string | null {
  const uid = String(cachedAuthUid ?? "").trim();
  return uid || null;
}

function toNullableText(valueRaw: string | null | undefined): string | null {
  const normalized = String(valueRaw ?? "").trim();
  return normalized || null;
}

function buildLocationLabel(cityRaw: string | null, regionRaw: string | null, countryRaw: string | null): string | null {
  const parts = [cityRaw, regionRaw, countryRaw]
    .map((value) => toNullableText(value))
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(", ") : null;
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
  return `${visible.join(":")}:xxxx:xxxx:xxxx:xxxx`;
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

async function listActiveLoginSessionsDirect(): Promise<LoginSessionView[]> {
  const { data, error } = await supabase
    .from("user_sessions")
    .select(
      "id,auth_session_id,device_id,client_type,platform,device,os,app_version,client_version,city,region,country,location_label,ip_address,created_at,last_seen_at,user_agent,suspicious,revoked_at",
    )
    .is("ended_at", null)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });

  if (error) {
    throw error;
  }

  return z
    .array(directUserSessionRowSchema)
    .parse(data ?? [])
    .map((row) => {
      const sessionId = row.auth_session_id ?? row.id;
      return {
        id: sessionId,
        recordId: row.id,
        deviceId: row.device_id ?? `legacy:${row.id}`,
        clientType: row.client_type ?? "unknown",
        platform: row.platform ?? "unknown",
        device: row.device,
        os: row.os,
        appVersion: row.app_version ?? row.client_version ?? null,
        clientVersion: row.client_version ?? null,
        location: row.location_label ?? buildLocationLabel(row.city, row.region, row.country),
        ipAddressMasked: maskIpAddress(row.ip_address),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        loggedInLabel: formatLoggedInLabel(row.created_at),
        revokedAt: row.revoked_at ?? null,
        userAgent: row.user_agent ?? null,
        suspicious: Boolean(row.suspicious),
      } satisfies LoginSessionView;
    });
}

function getStoredSessionId(uid: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const sessionId = window.localStorage.getItem(buildSessionIdStorageKey(uid));
    return sessionId && z.string().uuid().safeParse(sessionId).success ? sessionId : null;
  } catch {
    return null;
  }
}

function setStoredSessionId(uid: string, sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(buildSessionIdStorageKey(uid), sessionId);
  } catch {
    // Ignore storage failures.
  }
}

function clearStoredSessionId(uid: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(buildSessionIdStorageKey(uid));
  } catch {
    // Ignore storage failures.
  }
}

function getCurrentAuthSessionId(): string | null {
  const directCached = String(cachedAuthSessionId ?? "").trim();
  if (directCached) {
    return directCached;
  }

  const session = getInMemorySession();
  const decoded = decodeSupabaseSessionId(session?.access_token ?? null);
  if (decoded) {
    cachedAuthSessionId = decoded;
    return decoded;
  }

  const uid = getCurrentAuthUid();
  return uid ? getStoredSessionId(uid) : null;
}

function getClientVersion(): string {
  return String(appPackage.version ?? "0.0.0").trim() || "0.0.0";
}

async function resolveSessionsAccessToken(): Promise<string | null> {
  const validatedAccessToken = String(await authService.getValidatedEdgeAccessToken() ?? "").trim();
  return validatedAccessToken || null;
}

export async function recordLoginSession(): Promise<LoginSessionView | null> {
  if (isSessionsEdgeUnauthorizedCooldownActive()) {
    return null;
  }

  const uid = getCurrentAuthUid();
  const accessToken = await resolveSessionsAccessToken();
  const sessionId = getCurrentAuthSessionId() ?? decodeSupabaseSessionId(accessToken);
  if (!uid || !sessionId || sessionsMutationApiTemporarilyDisabled) {
    return null;
  }

  if (!accessToken) {
    return null;
  }

  const descriptor = getSessionClientDescriptor(getClientVersion());

  try {
    const response = await invokeEdgeJson<
      {
        action: "upsert";
        sessionId: string;
        deviceId: string;
        clientType: string;
        platform: string;
        clientName: string;
        appVersion: string;
      },
      unknown
    >("sessions", {
      action: "upsert",
      sessionId,
      deviceId: descriptor.deviceId,
      clientType: descriptor.clientType,
      platform: descriptor.platform,
      clientName: descriptor.name,
      appVersion: descriptor.version,
    }, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 12_000,
    });

    const parsed = upsertSessionResponseSchema.parse(response);
    clearSessionsEdgeUnauthorizedCooldown();
    cachedAuthSessionId = parsed.session.id;
    setStoredSessionId(uid, parsed.session.id);
    markSessionAsConfirmed(uid, parsed.session.id);
    invalidateListSessionsCache(uid);
    return parsed.session;
  } catch (error) {
    if (isUnauthorizedSessionsEdgeError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      activateSessionsEdgeUnauthorizedCooldown();
      clearLocalSessionIfInvalid(error, uid);
      return null;
    }
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      clearLocalSessionIfInvalid(error, uid);
      return null;
    }
    throw error;
  }
}

export async function endCurrentLoginSession(): Promise<void> {
  if (isSessionsEdgeUnauthorizedCooldownActive()) {
    return;
  }

  const uid = getCurrentAuthUid();
  const accessToken = await resolveSessionsAccessToken();
  const sessionId = getCurrentAuthSessionId() ?? decodeSupabaseSessionId(accessToken);
  if (!uid) {
    return;
  }

  if (sessionsMutationApiTemporarilyDisabled || !sessionId) {
    clearStoredSessionId(uid);
    return;
  }

  if (!accessToken) {
    invalidateListSessionsCache(uid);
    clearStoredSessionId(uid);
    return;
  }

  try {
    const response = await invokeEdgeJson<
      {
        action: "end";
        sessionId: string;
      },
      unknown
    >("sessions", {
      action: "end",
      sessionId,
    }, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 12_000,
    });

    endSessionResponseSchema.parse(response);
    clearSessionsEdgeUnauthorizedCooldown();
  } catch (error) {
    if (isUnauthorizedSessionsEdgeError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      activateSessionsEdgeUnauthorizedCooldown();
      clearLocalSessionIfInvalid(error, uid);
      return;
    }
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      clearLocalSessionIfInvalid(error, uid);
      return;
    }
    throw error;
  } finally {
    invalidateListSessionsCache(uid);
    clearStoredSessionId(uid);
  }
}

export function clearCurrentLoginSessionStorage(): void {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return;
  }

  clearStoredSessionId(uid);
}

export async function endLoginSessionById(sessionId: string): Promise<void> {
  if (isSessionsEdgeUnauthorizedCooldownActive()) {
    return;
  }

  if (sessionsMutationApiTemporarilyDisabled) {
    return;
  }

  if (!(await resolveSessionsAccessToken())) {
    return;
  }

  const normalizedSessionId = z.string().uuid().parse(sessionId);
  const uid = getCurrentAuthUid();
  try {
    const response = await invokeEdgeJson<
      {
        action: "endById";
        sessionId: string;
      },
      unknown
    >("sessions", {
      action: "endById",
      sessionId: normalizedSessionId,
    }, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 12_000,
    });

    endSessionResponseSchema.parse(response);
    clearSessionsEdgeUnauthorizedCooldown();
    invalidateListSessionsCache(uid);
  } catch (error) {
    if (isUnauthorizedSessionsEdgeError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      activateSessionsEdgeUnauthorizedCooldown();
      clearLocalSessionIfInvalid(error, uid);
      return;
    }
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      clearLocalSessionIfInvalid(error, uid);
      return;
    }
    throw error;
  }
}

async function listActiveLoginSessionsDetailed(): Promise<ListActiveLoginSessionsResult> {
  if (isSessionsEdgeUnauthorizedCooldownActive()) {
    return {
      sessions: [],
      authoritative: false,
    };
  }

  const uid = getCurrentAuthUid();
  if (!uid) {
    return {
      sessions: [],
      authoritative: false,
    };
  }

  if (!(await resolveSessionsAccessToken())) {
    return {
      sessions: [],
      authoritative: false,
    };
  }

  const cached = listSessionsCacheByUid.get(uid);
  if (cached && Date.now() - cached.fetchedAt <= LIST_SESSIONS_CACHE_TTL_MS) {
    return {
      sessions: cached.sessions,
      authoritative: true,
    };
  }

  const inFlight = listSessionsInFlightByUid.get(uid);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async (): Promise<ListActiveLoginSessionsResult> => {
    try {
      if (!sessionsDirectApiTemporarilyDisabled) {
        try {
          const directSessions = await listActiveLoginSessionsDirect();
          clearSessionsEdgeUnauthorizedCooldown();
          listSessionsCacheByUid.set(uid, {
            fetchedAt: Date.now(),
            sessions: directSessions,
          });
          return {
            sessions: directSessions,
            authoritative: true,
          };
        } catch (error) {
          const shouldFallback = shouldFallbackToEdgeSessionsList(error);
          if (shouldDisableSessionsApiForDirectError(error)) {
            sessionsDirectApiTemporarilyDisabled = true;
            clearLocalSessionIfInvalid(error, uid);
          }
          if (shouldFallback) {
            sessionsDirectApiTemporarilyDisabled = true;
          }

          if (!shouldFallback) {
            throw error;
          }
        }
      }

      try {
        const response = await invokeEdgeGet<unknown>("sessions", {
          requireAuth: true,
          retries: 0,
          timeoutMs: 12_000,
        });

        const sessions = listSessionsResponseSchema.parse(response).sessions;
        clearSessionsEdgeUnauthorizedCooldown();
        listSessionsCacheByUid.set(uid, {
          fetchedAt: Date.now(),
          sessions,
        });
        return {
          sessions,
          authoritative: true,
        };
      } catch (error) {
        if (isUnauthorizedSessionsEdgeError(error)) {
          sessionsMutationApiTemporarilyDisabled = true;
          sessionsDirectApiTemporarilyDisabled = true;
          activateSessionsEdgeUnauthorizedCooldown();
          clearLocalSessionIfInvalid(error, uid);
          return {
            sessions: [],
            authoritative: false,
          };
        }
        if (shouldDisableSessionsMutationApiForError(error)) {
          clearLocalSessionIfInvalid(error, uid);
          return {
            sessions: [],
            authoritative: false,
          };
        }
        throw error;
      }
    } finally {
      listSessionsInFlightByUid.delete(uid);
    }
  })();

  listSessionsInFlightByUid.set(uid, fetchPromise);
  return fetchPromise;
}

export async function listActiveLoginSessions(): Promise<LoginSessionView[]> {
  const result = await listActiveLoginSessionsDetailed();
  return result.sessions;
}

export async function getCurrentLoginSessionStatus(): Promise<CurrentLoginSessionStatus> {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return "unknown";
  }

  const sessionId = getCurrentAuthSessionId();
  if (!sessionId) {
    return "unknown";
  }

  const result = await listActiveLoginSessionsDetailed();
  if (!result.authoritative) {
    return "unknown";
  }

  const hasCurrentSession = result.sessions.some((session) => session.id === sessionId);
  if (hasCurrentSession) {
    markSessionAsConfirmed(uid, sessionId);
    return "active";
  }

  if (!hasConfirmedSession(uid, sessionId)) {
    return "unknown";
  }

  const inGracePeriod =
    cachedAuthSessionId === sessionId &&
    cachedAuthSessionObservedAtMs > 0 &&
    Date.now() - cachedAuthSessionObservedAtMs < SESSION_STATUS_GRACE_PERIOD_MS;
  if (inGracePeriod) {
    return "unknown";
  }

  return "ended";
}

export function getCurrentLoginSessionId(): string | null {
  return getCurrentAuthSessionId();
}
