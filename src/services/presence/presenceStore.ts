import { supabase } from "../../lib/supabaseClient";
import { createDebouncedTask } from "../../utils/debounce";
import {
  PRESENCE_STALE_AFTER_MS,
  arePresenceSpotifyActivitiesEqual,
  normalizePresenceActivities,
  resolvePresenceStateFromRow,
  type PresenceGatewayEventPayload,
  type PersistedPresenceStatus,
  type PresenceSnapshot,
  type PresenceSpotifyActivity,
  type PresenceState,
  type PresenceTableRow,
} from "./presenceTypes";
import {
  getPresenceTableColumnCapabilities,
  getPresenceTableName,
  resolvePresenceSelectColumns,
} from "./presenceTable";
import { gatewayService } from "../gateway";
import { authService } from "../auth";

const MAX_USER_IDS_PER_FILTER = 100;
const PRESENCE_UI_DEBOUNCE_MS = 50;
const PRESENCE_FETCH_DEBOUNCE_MS = 20;
const PRESENCE_FETCH_RETRY_DELAY_MS = 2_500;
const PRESENCE_REALTIME_RECONNECT_DELAY_MS = 1_500;
const PRESENCE_REALTIME_DISCONNECT_GRACE_MS = 750;
const PRESENCE_DEBUG_ENABLED = import.meta.env.DEV;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PresenceEntry {
  userId: string;
  status: PersistedPresenceStatus | null;
  activities: PresenceSpotifyActivity[];
  lastSeen: string | null;
  updatedAt: string | null;
}

type PresenceStoreListener = () => void;
type PresenceRealtimePayload = {
  eventType?: string;
  new?: unknown;
  old?: unknown;
};

const entries = new Map<string, PresenceEntry>();
const listeners = new Set<PresenceStoreListener>();
const trackedUserRefCounts = new Map<string, number>();
const hydratedUserIds = new Set<string>();
const queuedFetchUserIds = new Set<string>();
const inFlightFetchUserIds = new Set<string>();

let staleTimerId: number | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let realtimeReconnectTimerId: number | null = null;
let realtimeDisconnectTimerId: number | null = null;
let fetchRetryTimerId: number | null = null;
let unsubscribeGatewayEvents: (() => void) | null = null;
let ensureRealtimeSubscriptionPromise: Promise<void> | null = null;
let authStateSubscription: ReturnType<typeof supabase.auth.onAuthStateChange>["data"]["subscription"] | null = null;
let lastRealtimeAuthAccessToken: string | null = null;

function logPresenceDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!PRESENCE_DEBUG_ENABLED) {
    return;
  }
  console.debug(`[presence:store] ${event}`, details);
}

function isPresenceAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const normalized = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const status = Number(normalized.status ?? 0);
  const code = String(normalized.code ?? "").trim().toUpperCase();
  const message = String(normalized.message ?? "").trim().toLowerCase();
  const details = String(normalized.details ?? "").trim().toLowerCase();
  const combined = `${code} ${message} ${details}`;

  return (
    status === 401 ||
    status === 403 ||
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "INVALID_TOKEN" ||
    code === "INVALID_JWT" ||
    code === "JWT_EXPIRED" ||
    code === "PGRST301" ||
    combined.includes("invalid jwt") ||
    combined.includes("jwt expired") ||
    combined.includes("session from session_id claim in jwt does not exist") ||
    combined.includes("session_id claim") ||
    combined.includes("authorization")
  );
}

function shouldMaintainRealtimeConnection(): boolean {
  return listeners.size > 0 || trackedUserRefCounts.size > 0;
}

function clearRealtimeReconnectTimer(): void {
  if (realtimeReconnectTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(realtimeReconnectTimerId);
    realtimeReconnectTimerId = null;
  }
}

function clearRealtimeDisconnectTimer(): void {
  if (realtimeDisconnectTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(realtimeDisconnectTimerId);
    realtimeDisconnectTimerId = null;
  }
}

function clearFetchRetryTimer(): void {
  if (fetchRetryTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(fetchRetryTimerId);
    fetchRetryTimerId = null;
  }
}

async function syncRealtimeAuth(accessTokenRaw: string | null | undefined): Promise<void> {
  const accessToken = String(accessTokenRaw ?? "").trim() || null;
  if (!accessToken) {
    lastRealtimeAuthAccessToken = null;
    return;
  }

  if (lastRealtimeAuthAccessToken === accessToken) {
    return;
  }

  await supabase.realtime.setAuth(accessToken);
  lastRealtimeAuthAccessToken = accessToken;
  logPresenceDebug("realtime_auth_synced");
}

async function ensureRealtimeAuth(): Promise<void> {
  try {
    const validatedToken = await authService.getValidatedEdgeAccessToken();
    await syncRealtimeAuth(validatedToken);
  } catch (error) {
    logPresenceDebug("realtime_auth_sync_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function ensureAuthStateSubscription(): void {
  if (authStateSubscription) {
    return;
  }

  const authState = supabase.auth.onAuthStateChange((_event, session) => {
    void syncRealtimeAuth(session?.access_token ?? null).catch((error) => {
      logPresenceDebug("realtime_auth_refresh_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });
  authStateSubscription = authState.data.subscription;
}

function flushListenersNow(): void {
  scheduleStaleSweep();
  listeners.forEach((listener) => listener());
}

const scheduleListenerFlush = createDebouncedTask(() => {
  flushListenersNow();
}, PRESENCE_UI_DEBOUNCE_MS);

function notify(): void {
  if (typeof window === "undefined") {
    flushListenersNow();
    return;
  }

  scheduleListenerFlush();
}

function normalizeUserIds(userIds: string[]): string[] {
  return Array.from(
    new Set(
      userIds
        .map((userId) => String(userId ?? "").trim())
        .filter((userId) => UUID_PATTERN.test(userId)),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function splitUserIdsIntoChunks(userIds: string[]): string[][] {
  if (userIds.length === 0) {
    return [];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < userIds.length; index += MAX_USER_IDS_PER_FILTER) {
    chunks.push(userIds.slice(index, index + MAX_USER_IDS_PER_FILTER));
  }
  return chunks;
}

function arePresenceActivityListsEqual(
  left: PresenceSpotifyActivity[],
  right: PresenceSpotifyActivity[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (!arePresenceSpotifyActivitiesEqual(left[index] ?? null, right[index] ?? null)) {
      return false;
    }
  }

  return true;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPresenceEntryEqual(left: PresenceEntry | undefined, right: PresenceEntry): boolean {
  if (!left) {
    return false;
  }

  return (
    left.userId === right.userId &&
    left.status === right.status &&
    left.lastSeen === right.lastSeen &&
    left.updatedAt === right.updatedAt &&
    arePresenceActivityListsEqual(left.activities, right.activities)
  );
}

function createPresenceEntry(row: PresenceTableRow): PresenceEntry | null {
  const userId = String(row.user_id ?? "").trim();
  if (!userId) {
    return null;
  }

  return {
    userId,
    status: row.status,
    activities: normalizePresenceActivities(row.activities ?? []),
    lastSeen: row.last_seen,
    updatedAt: row.updated_at,
  };
}

function upsertPresenceEntry(entry: PresenceEntry): boolean {
  const current = entries.get(entry.userId);
  if (isPresenceEntryEqual(current, entry)) {
    return false;
  }

  const currentUpdatedAtMs = parseTimestampMs(current?.updatedAt ?? current?.lastSeen ?? null) ?? 0;
  const nextUpdatedAtMs = parseTimestampMs(entry.updatedAt ?? entry.lastSeen ?? null) ?? 0;
  if (current && currentUpdatedAtMs > 0 && nextUpdatedAtMs > 0 && nextUpdatedAtMs < currentUpdatedAtMs) {
    return false;
  }

  entries.set(entry.userId, entry);
  return true;
}

function removeMissingEntries(userIds: string[], rows: PresenceTableRow[]): boolean {
  const seenUserIds = new Set<string>();
  rows.forEach((row) => {
    const userId = String(row.user_id ?? "").trim();
    if (userId) {
      seenUserIds.add(userId);
    }
  });

  let changed = false;
  userIds.forEach((userId) => {
    if (seenUserIds.has(userId)) {
      return;
    }
    if (entries.delete(userId)) {
      changed = true;
    }
  });

  return changed;
}

function applyPresenceRows(rows: PresenceTableRow[], watchedUserIds?: string[]): void {
  let changed = false;

  rows.forEach((row) => {
    const entry = createPresenceEntry(row);
    if (!entry) {
      return;
    }

    changed = upsertPresenceEntry(entry) || changed;
  });

  if (watchedUserIds && watchedUserIds.length > 0) {
    changed = removeMissingEntries(watchedUserIds, rows) || changed;
  }

  if (changed) {
    notify();
  } else {
    scheduleStaleSweep();
  }
}

function scheduleStaleSweep(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (staleTimerId !== null) {
    window.clearTimeout(staleTimerId);
    staleTimerId = null;
  }

  const nowMs = Date.now();
  let nextExpirationMs: number | null = null;

  entries.forEach((entry) => {
    const resolvedState = resolvePresenceStateFromRow(
      {
        status: entry.status,
        updated_at: entry.updatedAt,
        last_seen: entry.lastSeen,
      },
      nowMs,
    );

    if (resolvedState === "invisivel") {
      return;
    }

    const updatedAtMs = parseTimestampMs(entry.updatedAt ?? entry.lastSeen ?? null);
    if (!Number.isFinite(updatedAtMs)) {
      return;
    }

    const expiresAtMs = (updatedAtMs ?? nowMs) + PRESENCE_STALE_AFTER_MS;
    if (expiresAtMs <= nowMs) {
      nextExpirationMs = nowMs;
      return;
    }

    if (nextExpirationMs == null || expiresAtMs < nextExpirationMs) {
      nextExpirationMs = expiresAtMs;
    }
  });

  if (nextExpirationMs == null) {
    return;
  }

  staleTimerId = window.setTimeout(() => {
    staleTimerId = null;
    notify();
  }, Math.max(250, nextExpirationMs - nowMs + 50));
}

async function fetchPresenceRows(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  let shouldRetry = false;
  try {
    const tableName = await getPresenceTableName();
    const { hasActivitiesColumn } = await getPresenceTableColumnCapabilities();
    const selectColumns = resolvePresenceSelectColumns(hasActivitiesColumn);
    const { data, error } = await supabase
      .from(tableName)
      .select(selectColumns)
      .in("user_id", userIds);

    if (error) {
      shouldRetry = !isPresenceAuthError(error);
      if (isPresenceAuthError(error)) {
        void authService.clearLocalSession().catch(() => undefined);
      }
      logPresenceDebug("fetch_rows_failed", {
        reason: String((error as { message?: unknown } | null)?.message ?? "unknown"),
        userCount: userIds.length,
        authRejected: isPresenceAuthError(error),
      });
    } else {
      userIds.forEach((userId) => {
        hydratedUserIds.add(userId);
      });

      applyPresenceRows(
        ((data ?? []) as unknown) as PresenceTableRow[],
        userIds.filter((userId) => trackedUserRefCounts.has(userId)),
      );
    }
  } catch (error) {
    shouldRetry = !isPresenceAuthError(error);
    if (isPresenceAuthError(error)) {
      void authService.clearLocalSession().catch(() => undefined);
    }
    logPresenceDebug("fetch_rows_threw", {
      reason: error instanceof Error ? error.message : String(error),
      userCount: userIds.length,
      authRejected: isPresenceAuthError(error),
    });
  } finally {
    userIds.forEach((userId) => {
      if (!shouldRetry) {
        queuedFetchUserIds.delete(userId);
      }
      inFlightFetchUserIds.delete(userId);
    });
  }

  if (shouldRetry) {
    schedulePresenceFetchRetry(userIds);
  }
}

function flushQueuedPresenceFetches(): void {
  const userIds = normalizeUserIds(Array.from(queuedFetchUserIds));
  if (userIds.length === 0) {
    return;
  }

  userIds.forEach((userId) => {
    queuedFetchUserIds.delete(userId);
    inFlightFetchUserIds.add(userId);
  });

  splitUserIdsIntoChunks(userIds).forEach((chunkUserIds) => {
    void fetchPresenceRows(chunkUserIds);
  });
}

const scheduleQueuedPresenceFetches = createDebouncedTask(() => {
  flushQueuedPresenceFetches();
}, PRESENCE_FETCH_DEBOUNCE_MS);

function schedulePresenceFetchRetry(userIds: string[]): void {
  let hasQueued = false;
  userIds.forEach((userId) => {
    if (!trackedUserRefCounts.has(userId)) {
      return;
    }
    if (inFlightFetchUserIds.has(userId)) {
      return;
    }
    queuedFetchUserIds.add(userId);
    hasQueued = true;
  });

  if (!hasQueued) {
    return;
  }

  if (typeof window === "undefined") {
    flushQueuedPresenceFetches();
    return;
  }

  if (fetchRetryTimerId !== null) {
    return;
  }

  fetchRetryTimerId = window.setTimeout(() => {
    fetchRetryTimerId = null;
    flushQueuedPresenceFetches();
  }, PRESENCE_FETCH_RETRY_DELAY_MS);
}

function queueInitialPresenceFetch(userIds: string[]): void {
  let hasQueuedUser = false;

  normalizeUserIds(userIds).forEach((userId) => {
    if (hydratedUserIds.has(userId) || queuedFetchUserIds.has(userId) || inFlightFetchUserIds.has(userId)) {
      return;
    }

    queuedFetchUserIds.add(userId);
    hasQueuedUser = true;
  });

  if (!hasQueuedUser) {
    return;
  }

  if (typeof window === "undefined") {
    flushQueuedPresenceFetches();
    return;
  }

  scheduleQueuedPresenceFetches();
}

function retainTrackedUsers(userIds: string[]): () => void {
  userIds.forEach((userId) => {
    trackedUserRefCounts.set(userId, (trackedUserRefCounts.get(userId) ?? 0) + 1);
  });

  return () => {
    userIds.forEach((userId) => {
      const currentRefCount = trackedUserRefCounts.get(userId) ?? 0;
      if (currentRefCount <= 1) {
        trackedUserRefCounts.delete(userId);
        hydratedUserIds.delete(userId);
        queuedFetchUserIds.delete(userId);
        inFlightFetchUserIds.delete(userId);
        return;
      }
      trackedUserRefCounts.set(userId, currentRefCount - 1);
    });
  };
}

function removePresenceEntry(userId: string): void {
  if (!entries.delete(userId)) {
    return;
  }

  notify();
}

function handlePresencePayload(payload: PresenceRealtimePayload): void {
  const eventType = String(payload.eventType ?? "").trim().toUpperCase();
  const rowSource = eventType === "DELETE" ? payload.old : payload.new;
  const row =
    rowSource && typeof rowSource === "object" && rowSource !== null
      ? (rowSource as PresenceTableRow)
      : null;
  if (!row) {
    return;
  }

  const userId = String(row?.user_id ?? "").trim();
  if (!userId) {
    return;
  }

  if (eventType === "DELETE") {
    removePresenceEntry(userId);
    return;
  }

  if (!trackedUserRefCounts.has(userId)) {
    return;
  }

  applyPresenceRows([row]);
}

function createPresenceEntryFromGatewayPayload(payload: PresenceGatewayEventPayload): PresenceEntry | null {
  const userId = String(payload.user_id ?? "").trim();
  if (!userId) {
    return null;
  }

  const current = entries.get(userId);
  const eventType = String(payload.event ?? "").trim().toUpperCase();
  const fallbackStatus: PersistedPresenceStatus =
    eventType === "USER_ONLINE"
      ? "online"
      : eventType === "USER_OFFLINE"
        ? "invisible"
        : (current?.status ?? "online");
  const status = payload.status ?? fallbackStatus;
  const timestamp = String(payload.timestamp ?? "").trim() || new Date().toISOString();
  const activities =
    eventType === "USER_OFFLINE"
      ? []
      : normalizePresenceActivities(payload.activities ?? current?.activities ?? []);

  return {
    userId,
    status,
    activities,
    lastSeen: timestamp,
    updatedAt: timestamp,
  };
}

function handlePresenceGatewayPayload(payload: PresenceGatewayEventPayload): void {
  const entry = createPresenceEntryFromGatewayPayload(payload);
  if (!entry) {
    return;
  }

  if (!trackedUserRefCounts.has(entry.userId)) {
    return;
  }

  if (!upsertPresenceEntry(entry)) {
    return;
  }

  notify();
}

function scheduleRealtimeReconnect(reason: string): void {
  if (!shouldMaintainRealtimeConnection() || typeof window === "undefined") {
    return;
  }

  if (realtimeReconnectTimerId !== null) {
    return;
  }

  logPresenceDebug("realtime_reconnect_scheduled", {
    reason,
    delayMs: PRESENCE_REALTIME_RECONNECT_DELAY_MS,
  });
  realtimeReconnectTimerId = window.setTimeout(() => {
    realtimeReconnectTimerId = null;
    if (!shouldMaintainRealtimeConnection()) {
      return;
    }
    void ensureRealtimeSubscription().catch((error) => {
      logPresenceDebug("realtime_reconnect_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }, PRESENCE_REALTIME_RECONNECT_DELAY_MS);
}

async function ensureRealtimeSubscription(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  clearRealtimeDisconnectTimer();

  if (ensureRealtimeSubscriptionPromise) {
    return ensureRealtimeSubscriptionPromise;
  }

  const ensurePromise = (async () => {
    ensureAuthStateSubscription();
    await ensureRealtimeAuth();

    if (!shouldMaintainRealtimeConnection()) {
      return;
    }

    if (!unsubscribeGatewayEvents) {
      unsubscribeGatewayEvents = gatewayService.subscribeEvent("PRESENCE_UPDATE", (payload) => {
        handlePresenceGatewayPayload({
          event: "PRESENCE_UPDATE",
          user_id: payload.presence.userId,
          status: payload.presence.status === "offline" ? "invisible" : payload.presence.status,
          activities: payload.presence.activities,
          timestamp: payload.presence.lastSeen,
        });
      });
    }

    if (realtimeChannel) {
      return;
    }

    let tableName: string;
    try {
      tableName = await getPresenceTableName();
    } catch (error) {
      scheduleRealtimeReconnect("resolve-table-failed");
      throw error;
    }

    if (!shouldMaintainRealtimeConnection()) {
      return;
    }

    const nextChannel = supabase
      .channel("presence:updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: tableName,
        },
        handlePresencePayload,
      )
      .subscribe((status) => {
        if (realtimeChannel !== nextChannel) {
          return;
        }

        if (status === "SUBSCRIBED") {
          clearRealtimeReconnectTimer();
          logPresenceDebug("realtime_subscribed", { tableName });
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          realtimeChannel = null;
          void supabase.removeChannel(nextChannel);
          scheduleRealtimeReconnect(status.toLowerCase());
        }
      });

    if (!shouldMaintainRealtimeConnection()) {
      void supabase.removeChannel(nextChannel);
      return;
    }

    realtimeChannel = nextChannel;
  })();

  const trackedPromise = ensurePromise.finally(() => {
    if (ensureRealtimeSubscriptionPromise === trackedPromise) {
      ensureRealtimeSubscriptionPromise = null;
    }
  });

  ensureRealtimeSubscriptionPromise = trackedPromise;
  return trackedPromise;
}

function releaseRealtimeResources(): void {
  clearRealtimeReconnectTimer();
  clearFetchRetryTimer();

  if (realtimeChannel) {
    void supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  if (unsubscribeGatewayEvents) {
    unsubscribeGatewayEvents();
    unsubscribeGatewayEvents = null;
  }

  if (authStateSubscription) {
    authStateSubscription.unsubscribe();
    authStateSubscription = null;
  }

  ensureRealtimeSubscriptionPromise = null;
}

function clearRealtimeSubscriptionIfUnused(): void {
  if (shouldMaintainRealtimeConnection()) {
    clearRealtimeDisconnectTimer();
    return;
  }

  if (typeof window === "undefined") {
    releaseRealtimeResources();
    return;
  }

  if (realtimeDisconnectTimerId !== null) {
    return;
  }

  realtimeDisconnectTimerId = window.setTimeout(() => {
    realtimeDisconnectTimerId = null;
    if (shouldMaintainRealtimeConnection()) {
      return;
    }
    releaseRealtimeResources();
  }, PRESENCE_REALTIME_DISCONNECT_GRACE_MS);
}

function buildEmptyPresenceSnapshot(userId: string): PresenceSnapshot {
  return {
    userId,
    presenceState: "invisivel",
    activities: [],
    spotifyActivity: null,
    lastSeen: null,
    updatedAt: null,
  };
}

export function subscribe(listener: PresenceStoreListener): () => void {
  listeners.add(listener);
  clearRealtimeDisconnectTimer();
  void ensureRealtimeSubscription().catch(() => undefined);
  return () => {
    listeners.delete(listener);
    clearRealtimeSubscriptionIfUnused();
  };
}

export function watchUsers(userIds: string[]): () => void {
  const normalizedUserIds = normalizeUserIds(userIds);
  if (normalizedUserIds.length === 0) {
    return () => undefined;
  }

  const releaseTrackedUsers = retainTrackedUsers(normalizedUserIds);
  clearRealtimeDisconnectTimer();
  void ensureRealtimeSubscription().catch(() => undefined);
  queueInitialPresenceFetch(normalizedUserIds);

  return () => {
    releaseTrackedUsers();
    clearRealtimeSubscriptionIfUnused();
  };
}

export function getPresenceSnapshot(userId: string | null | undefined): PresenceSnapshot {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return buildEmptyPresenceSnapshot("");
  }

  const entry = entries.get(normalizedUserId);
  if (!entry) {
    return buildEmptyPresenceSnapshot(normalizedUserId);
  }

  const presenceState = resolvePresenceStateFromRow({
    status: entry.status,
    last_seen: entry.lastSeen,
    updated_at: entry.updatedAt,
  });
  const spotifyActivity = presenceState === "invisivel" ? null : entry.activities[0] ?? null;

  return {
    userId: normalizedUserId,
    presenceState,
    activities: entry.activities,
    spotifyActivity,
    lastSeen: entry.lastSeen,
    updatedAt: entry.updatedAt,
  };
}

export function getPresenceState(userId: string | null | undefined): PresenceState {
  return getPresenceSnapshot(userId).presenceState;
}

export function getSpotifyActivity(userId: string | null | undefined): PresenceSpotifyActivity | null {
  return getPresenceSnapshot(userId).spotifyActivity;
}

export const presenceStore = {
  getPresenceSnapshot,
  getPresenceState,
  getSpotifyActivity,
  subscribe,
  watchUsers,
};
