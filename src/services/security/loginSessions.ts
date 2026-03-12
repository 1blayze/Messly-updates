import { z } from "zod";
import { supabase } from "../supabase";
import { EdgeFunctionError, invokeEdgeGet, invokeEdgeJson } from "../edge/edgeClient";
import { authService } from "../auth";
import { getInMemorySession } from "../auth/authStore";
import { getSessionClientDescriptor } from "./sessionClientInfo";
import appPackage from "../../../package.json";

const SESSION_ID_STORAGE_PREFIX = "messly:security:session-id:";
const LIST_SESSIONS_CACHE_TTL_MS = 8_000;

let sessionsMutationApiTemporarilyDisabled = false;
const listSessionsCacheByUid = new Map<string, { fetchedAt: number; sessions: LoginSessionView[] }>();
const listSessionsInFlightByUid = new Map<string, Promise<LoginSessionView[]>>();

let cachedAuthUid: string | null = null;
let cachedAuthSessionId: string | null = null;

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
    const payload = JSON.parse(payloadText) as { session_id?: unknown };
    const sessionId = String(payload.session_id ?? "").trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

function updateCachedAuthState(): void {
  const session = getInMemorySession();
  cachedAuthUid = String(session?.user?.id ?? "").trim() || null;
  cachedAuthSessionId = decodeSupabaseSessionId(session?.access_token ?? null);

  if (cachedAuthUid && cachedAuthSessionId) {
    setStoredSessionId(cachedAuthUid, cachedAuthSessionId);
  }
}

void authService.getCurrentSession().then(() => {
  updateCachedAuthState();
}).catch(() => undefined);

supabase.auth.onAuthStateChange((_event, session) => {
  const previousUid = cachedAuthUid;
  cachedAuthUid = String(session?.user?.id ?? "").trim() || null;
  cachedAuthSessionId = decodeSupabaseSessionId(session?.access_token ?? null);

  if (previousUid) {
    invalidateListSessionsCache(previousUid);
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
    message.includes("not authenticated") ||
    message.includes("permission denied") ||
    message.includes("row level security")
  );
}

function shouldFallbackToEdgeSessionsList(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  if (status === 404 || code === "42P01" || code === "PGRST205" || code === "PGRST106") {
    return true;
  }

  return message.includes("does not exist") || message.includes("schema cache");
}

function buildSessionIdStorageKey(uid: string): string {
  return `${SESSION_ID_STORAGE_PREFIX}${uid}`;
}

function getCurrentAuthUid(): string | null {
  const uid = String(cachedAuthUid ?? "").trim();
  return uid || null;
}

async function hasCurrentAuthAccessToken(): Promise<boolean> {
  return Boolean(await authService.getCurrentAccessToken());
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

export async function recordLoginSession(): Promise<LoginSessionView | null> {
  const uid = getCurrentAuthUid();
  const accessToken = await authService.getCurrentAccessToken();
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
    });

    const parsed = upsertSessionResponseSchema.parse(response);
    cachedAuthSessionId = parsed.session.id;
    setStoredSessionId(uid, parsed.session.id);
    invalidateListSessionsCache(uid);
    return parsed.session;
  } catch (error) {
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      return null;
    }
    throw error;
  }
}

export async function endCurrentLoginSession(): Promise<void> {
  const uid = getCurrentAuthUid();
  const accessToken = await authService.getCurrentAccessToken();
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
    });

    endSessionResponseSchema.parse(response);
  } catch (error) {
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
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
  if (sessionsMutationApiTemporarilyDisabled) {
    return;
  }

  if (!(await hasCurrentAuthAccessToken())) {
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
    });

    endSessionResponseSchema.parse(response);
    invalidateListSessionsCache(uid);
  } catch (error) {
    if (shouldDisableSessionsMutationApiForError(error)) {
      sessionsMutationApiTemporarilyDisabled = true;
      return;
    }
    throw error;
  }
}

export async function listActiveLoginSessions(): Promise<LoginSessionView[]> {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return [];
  }

  if (!(await hasCurrentAuthAccessToken())) {
    return [];
  }

  const cached = listSessionsCacheByUid.get(uid);
  if (cached && Date.now() - cached.fetchedAt <= LIST_SESSIONS_CACHE_TTL_MS) {
    return cached.sessions;
  }

  const inFlight = listSessionsInFlightByUid.get(uid);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async (): Promise<LoginSessionView[]> => {
    try {
      try {
        const directSessions = await listActiveLoginSessionsDirect();
        listSessionsCacheByUid.set(uid, {
          fetchedAt: Date.now(),
          sessions: directSessions,
        });
        return directSessions;
      } catch (error) {
        if (shouldDisableSessionsApiForDirectError(error)) {
          return [];
        }

        if (!shouldFallbackToEdgeSessionsList(error)) {
          throw error;
        }
      }

      try {
        const response = await invokeEdgeGet<unknown>("sessions", {
          retries: 1,
          timeoutMs: 18_000,
        });

        const sessions = listSessionsResponseSchema.parse(response).sessions;
        listSessionsCacheByUid.set(uid, {
          fetchedAt: Date.now(),
          sessions,
        });
        return sessions;
      } catch (error) {
        if (shouldDisableSessionsMutationApiForError(error)) {
          return [];
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

export async function getCurrentLoginSessionStatus(): Promise<CurrentLoginSessionStatus> {
  const sessionId = getCurrentAuthSessionId();
  if (!sessionId) {
    return "unknown";
  }

  const sessions = await listActiveLoginSessions();
  return sessions.some((session) => session.id === sessionId) ? "active" : "ended";
}

export function getCurrentLoginSessionId(): string | null {
  return getCurrentAuthSessionId();
}
