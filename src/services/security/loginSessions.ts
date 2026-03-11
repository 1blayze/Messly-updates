import { z } from "zod";
import { supabase } from "../supabase";
import { EdgeFunctionError, invokeEdgeGet, invokeEdgeJson } from "../edge/edgeClient";
import { authService } from "../auth";
import appPackage from "../../../package.json";

const SESSION_TOKEN_STORAGE_PREFIX = "messly:security:session-token:";
const SESSION_ID_STORAGE_PREFIX = "messly:security:session-id:";
const LIST_SESSIONS_CACHE_TTL_MS = 8_000;
let sessionsApiTemporarilyDisabled = false;
const listSessionsCacheByUid = new Map<string, { fetchedAt: number; sessions: LoginSessionView[] }>();
const listSessionsInFlightByUid = new Map<string, Promise<LoginSessionView[]>>();
let cachedAuthUid: string | null = null;

void authService.getCurrentUserId().then((uid) => {
  cachedAuthUid = uid;
});

supabase.auth.onAuthStateChange((_event, session) => {
  cachedAuthUid = String(session?.user?.id ?? "").trim() || null;
});

const sessionViewSchema = z.object({
  id: z.string().uuid(),
  device: z.string().min(1),
  os: z.string().min(1),
  clientVersion: z.string().min(1).max(32).nullable(),
  location: z.string().min(1).nullable(),
  ipAddressMasked: z.string().min(1),
  createdAt: z.string().min(1),
  loggedInLabel: z.string().min(1),
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
  device: z.string().min(1),
  os: z.string().min(1),
  client_version: z.string().min(1).max(32).nullable(),
  city: z.string().min(1).nullable(),
  region: z.string().min(1).nullable(),
  country: z.string().min(1).nullable(),
  ip_address: z.string().min(1),
  created_at: z.string().min(1),
  suspicious: z.boolean().nullable().optional(),
});

export type LoginSessionView = z.infer<typeof sessionViewSchema>;
export type CurrentLoginSessionStatus = "active" | "ended" | "unknown";

function invalidateListSessionsCache(uidRaw: string | null | undefined): void {
  const uid = String(uidRaw ?? "").trim();
  if (!uid) {
    return;
  }
  listSessionsCacheByUid.delete(uid);
}

function shouldDisableSessionsApiForError(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    if (error.status === 404 && error.code === "NOT_FOUND") {
      return true;
    }
    if (error.status === 401) {
      const code = String(error.code ?? "").trim().toUpperCase();
      const message = String(error.message ?? "").trim().toLowerCase();
      if (
        code === "INVALID_TOKEN" ||
        code === "UNAUTHENTICATED" ||
        code === "UNAUTHORIZED" ||
        message.includes("invalid jwt") ||
        message.includes("sessao invalida") ||
        message.includes("sessão inválida")
      ) {
        return true;
      }
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

function shouldRotateSessionToken(error: unknown): boolean {
  if (!(error instanceof EdgeFunctionError)) {
    return false;
  }

  if (error.status === 409 && String(error.code ?? "").trim().toUpperCase() === "SESSION_ALREADY_ENDED") {
    return true;
  }

  const message = String(error.message ?? "").trim().toLowerCase();
  return error.status === 409 && message.includes("sessao atual ja foi encerrada");
}

function buildStorageKey(uid: string): string {
  return `${SESSION_TOKEN_STORAGE_PREFIX}${uid}`;
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
    .select("id,device,os,client_version,city,region,country,ip_address,created_at,suspicious")
    .is("ended_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return z
    .array(directUserSessionRowSchema)
    .parse(data ?? [])
    .map((row) => ({
      id: row.id,
      device: row.device,
      os: row.os,
      clientVersion: row.client_version ?? null,
      location: buildLocationLabel(row.city, row.region, row.country),
      ipAddressMasked: maskIpAddress(row.ip_address),
      createdAt: row.created_at,
      loggedInLabel: formatLoggedInLabel(row.created_at),
      suspicious: Boolean(row.suspicious),
    }));
}

function generateSessionToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const randomHex = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${randomHex()}${randomHex()}-${randomHex()}-4${randomHex().slice(1)}-8${randomHex().slice(1)}-${randomHex()}${randomHex()}${randomHex()}`;
}

function getStoredSessionToken(uid: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const token = window.localStorage.getItem(buildStorageKey(uid));
    return token && z.string().uuid().safeParse(token).success ? token : null;
  } catch {
    return null;
  }
}

function setStoredSessionToken(uid: string, sessionToken: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(buildStorageKey(uid), sessionToken);
  } catch {
    // Ignore storage failures.
  }
}

function clearStoredSessionToken(uid: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(buildStorageKey(uid));
  } catch {
    // Ignore storage failures.
  }
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

function ensureCurrentSessionToken(): { uid: string; sessionToken: string } {
  const uid = getCurrentAuthUid();
  if (!uid) {
    throw new Error("AUTH_REQUIRED");
  }

  const existingToken = getStoredSessionToken(uid);
  if (existingToken) {
    return {
      uid,
      sessionToken: existingToken,
    };
  }

  const createdToken = generateSessionToken();
  setStoredSessionToken(uid, createdToken);
  return {
    uid,
    sessionToken: createdToken,
  };
}

function getClientVersion(): string {
  return String(appPackage.version ?? "0.0.0").trim() || "0.0.0";
}

export async function recordLoginSession(): Promise<LoginSessionView | null> {
  if (sessionsApiTemporarilyDisabled) {
    return null;
  }

  if (!(await hasCurrentAuthAccessToken())) {
    return null;
  }

  const { uid, sessionToken } = ensureCurrentSessionToken();
  const upsertSession = async (token: string): Promise<LoginSessionView> => {
    const response = await invokeEdgeJson<
      {
        action: "upsert";
        sessionToken: string;
        clientVersion: string;
      },
      unknown
    >("sessions", {
      action: "upsert",
      sessionToken: token,
      clientVersion: getClientVersion(),
    });

    const parsed = upsertSessionResponseSchema.parse(response);
    setStoredSessionId(uid, parsed.session.id);
    invalidateListSessionsCache(uid);
    return parsed.session;
  };

  try {
    return await upsertSession(sessionToken);
  } catch (error) {
    if (shouldRotateSessionToken(error)) {
      const replacementToken = generateSessionToken();
      setStoredSessionToken(uid, replacementToken);
      try {
        return await upsertSession(replacementToken);
      } catch (retryError) {
        if (shouldDisableSessionsApiForError(retryError)) {
          sessionsApiTemporarilyDisabled = true;
          return null;
        }
        throw retryError;
      }
    }

    if (shouldDisableSessionsApiForError(error)) {
      sessionsApiTemporarilyDisabled = true;
      return null;
    }
    throw error;
  }
}

export async function endCurrentLoginSession(): Promise<void> {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return;
  }

  if (sessionsApiTemporarilyDisabled) {
    clearStoredSessionToken(uid);
    clearStoredSessionId(uid);
    return;
  }

  const sessionToken = getStoredSessionToken(uid);
  if (!sessionToken) {
    clearStoredSessionId(uid);
    return;
  }

  if (!(await hasCurrentAuthAccessToken())) {
    invalidateListSessionsCache(uid);
    clearStoredSessionToken(uid);
    clearStoredSessionId(uid);
    return;
  }

  try {
    try {
      const response = await invokeEdgeJson<
        {
          action: "end";
          sessionToken: string;
          clientVersion: string;
        },
        unknown
      >("sessions", {
        action: "end",
        sessionToken,
        clientVersion: getClientVersion(),
      });

      endSessionResponseSchema.parse(response);
    } catch (error) {
      if (shouldDisableSessionsApiForError(error)) {
        sessionsApiTemporarilyDisabled = true;
        return;
      }
      throw error;
    }
  } finally {
    invalidateListSessionsCache(uid);
    clearStoredSessionToken(uid);
    clearStoredSessionId(uid);
  }
}

export function clearCurrentLoginSessionStorage(): void {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return;
  }

  clearStoredSessionToken(uid);
  clearStoredSessionId(uid);
}

export async function endLoginSessionById(sessionId: string): Promise<void> {
  if (sessionsApiTemporarilyDisabled) {
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
        clientVersion: string;
      },
      unknown
    >("sessions", {
      action: "endById",
      sessionId: normalizedSessionId,
      clientVersion: getClientVersion(),
    });

    endSessionResponseSchema.parse(response);
    invalidateListSessionsCache(uid);
  } catch (error) {
    if (shouldDisableSessionsApiForError(error)) {
      sessionsApiTemporarilyDisabled = true;
      return;
    }
    throw error;
  }
}

export async function listActiveLoginSessions(): Promise<LoginSessionView[]> {
  if (sessionsApiTemporarilyDisabled) {
    return [];
  }

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
      const directSessions = await listActiveLoginSessionsDirect();
      listSessionsCacheByUid.set(uid, {
        fetchedAt: Date.now(),
        sessions: directSessions,
      });
      return directSessions;
    } catch (error) {
      if (shouldDisableSessionsApiForDirectError(error)) {
        sessionsApiTemporarilyDisabled = true;
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
      if (shouldDisableSessionsApiForError(error)) {
        sessionsApiTemporarilyDisabled = true;
        return [];
      }
      throw error;
    } finally {
      listSessionsInFlightByUid.delete(uid);
    }
  })();

  listSessionsInFlightByUid.set(uid, fetchPromise);

  return fetchPromise;
}

export async function getCurrentLoginSessionStatus(): Promise<CurrentLoginSessionStatus> {
  if (sessionsApiTemporarilyDisabled) {
    return "unknown";
  }

  const uid = getCurrentAuthUid();
  if (!uid) {
    return "unknown";
  }

  const sessionId = getStoredSessionId(uid);
  if (!sessionId) {
    return "unknown";
  }

  const sessions = await listActiveLoginSessions();
  if (sessionsApiTemporarilyDisabled) {
    return "unknown";
  }

  return sessions.some((session) => session.id === sessionId) ? "active" : "ended";
}

export function getCurrentLoginSessionId(): string | null {
  const uid = getCurrentAuthUid();
  if (!uid) {
    return null;
  }

  return getStoredSessionId(uid);
}
