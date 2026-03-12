import { supabase, supabaseAnonKey, supabaseUrl } from "../../lib/supabaseClient";
import { authService } from "../auth";
import {
  createDefaultSpotifyConnection,
  readSpotifyConnection,
  resolveSpotifyPlaybackProgressSeconds,
  subscribeSpotifyConnection,
  syncSpotifyConnection,
  type SpotifyConnectionState,
} from "../connections/spotifyConnection";
import { gatewayService } from "../gateway";
import {
  PRESENCE_STALE_AFTER_MS,
  toPersistedPresenceStatus,
  type PresenceSpotifyActivity,
  type PresenceState,
} from "./presenceTypes";
import { getPresenceTableColumnCapabilities, getPresenceTableName } from "./presenceTable";
import { readPresencePreference, writePresencePreference } from "./presencePreference";

type PresenceSubscriber = (state: PresenceState) => void;

const IDLE_AFTER_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_FOREGROUND_MS = 25_000;
const HEARTBEAT_INTERVAL_BACKGROUND_MS = Math.min(
  45_000,
  Math.max(30_000, PRESENCE_STALE_AFTER_MS - 25_000),
);
const LOCAL_ACTIVITY_SYNC_MIN_INTERVAL_MS = 8_000;
const PRESENCE_CONTROLLER_DEBUG_ENABLED = import.meta.env.DEV;

interface PersistedPresencePayload {
  user_id: string;
  status: ReturnType<typeof toPersistedPresenceStatus>;
  activities?: PresenceSpotifyActivity[];
  last_seen: string;
  updated_at: string;
}

interface PresenceSemanticSnapshot {
  state: PresenceState;
  activity: PresenceSpotifyActivity | null;
}

let currentUserId: string | null = null;
let currentState: PresenceState = "invisivel";
let preferredState: PresenceState = "online";
let lastActivityAtMs = Date.now();
let heartbeatTimerId: number | null = null;
let idleTimerId: number | null = null;
let spotifyConnectionScope: string | null = null;
let currentAccessToken: string | null = null;
let startSequence = 0;
let spotifyUnsubscribe: (() => void) | null = null;
let gatewayStateUnsubscribe: (() => void) | null = null;
let currentSpotifyConnection: SpotifyConnectionState = createDefaultSpotifyConnection();
let lastPersistedSnapshot: PresenceSemanticSnapshot | null = null;
let lastBroadcastSnapshot: PresenceSemanticSnapshot | null = null;
let lastGatewayStatus = "idle";
let lastLocalActivitySyncAtMs = 0;

const subscribers = new Set<PresenceSubscriber>();

function logPresenceControllerDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!PRESENCE_CONTROLLER_DEBUG_ENABLED) {
    return;
  }
  console.debug(`[presence:controller] ${event}`, details);
}

void authService.getCurrentAccessToken().then((token) => {
  currentAccessToken = token;
});

supabase.auth.onAuthStateChange((_event, session) => {
  currentAccessToken = session?.access_token ?? null;
});

function notify(): void {
  subscribers.forEach((subscriber) => subscriber(currentState));
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimerId !== null && typeof window !== "undefined") {
    window.clearInterval(heartbeatTimerId);
    heartbeatTimerId = null;
  }
}

function clearIdleTimer(): void {
  if (idleTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(idleTimerId);
    idleTimerId = null;
  }
}

function clearSpotifySubscription(): void {
  if (!spotifyUnsubscribe) {
    return;
  }
  spotifyUnsubscribe();
  spotifyUnsubscribe = null;
}

function clearGatewaySubscription(): void {
  if (!gatewayStateUnsubscribe) {
    return;
  }
  gatewayStateUnsubscribe();
  gatewayStateUnsubscribe = null;
}

function buildPresencePayload(
  state: PresenceState,
  activity: PresenceSpotifyActivity | null,
  userIdOverride?: string | null,
): PersistedPresencePayload | null {
  const userId = String(userIdOverride ?? currentUserId ?? "").trim();
  if (!userId) {
    return null;
  }

  const nowIso = new Date().toISOString();
  return {
    user_id: userId,
    status: toPersistedPresenceStatus(state),
    activities: activity ? [activity] : [],
    last_seen: nowIso,
    updated_at: nowIso,
  };
}

function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProgressSeconds(value: number, durationSeconds: number): number {
  return Math.max(0, Math.min(durationSeconds, Math.round(value)));
}

function buildSpotifyPresenceActivity(
  connection: SpotifyConnectionState,
  nowMs: number = Date.now(),
): PresenceSpotifyActivity | null {
  if (!connection.connected || !connection.showAsStatus || !connection.playback) {
    return null;
  }

  const playback = connection.playback;
  const durationSeconds = Math.max(0, Math.round(Number(playback.durationSeconds ?? 0)));
  if (!durationSeconds) {
    return null;
  }

  const isPlaying = playback.isPlaying !== false;
  const connectionUpdatedAtMs = parseTimestampMs(connection.updatedAt) ?? nowMs;
  const baseProgressSeconds = clampProgressSeconds(Number(playback.progressSeconds ?? 0), durationSeconds);
  const startedAt = Math.max(0, connectionUpdatedAtMs - baseProgressSeconds * 1000);
  const progressSeconds = isPlaying
    ? clampProgressSeconds(resolveSpotifyPlaybackProgressSeconds(playback, connection.updatedAt, nowMs), durationSeconds)
    : baseProgressSeconds;

  return {
    type: "spotify",
    provider: "spotify",
    showOnProfile: connection.showOnProfile,
    trackId: String(playback.trackId ?? "").trim(),
    trackTitle: String(playback.trackTitle ?? "").trim(),
    artistNames: String(playback.artistNames ?? "").trim(),
    trackUrl: String(playback.trackUrl ?? "").trim(),
    coverUrl: String(playback.coverUrl ?? "").trim(),
    progressSeconds,
    durationSeconds,
    isPlaying,
    ...(isPlaying ? { startedAt } : {}),
    updatedAt: nowMs,
  };
}

function getCurrentSemanticSnapshot(nowMs: number = Date.now()): PresenceSemanticSnapshot {
  return {
    state: resolveEffectiveState(nowMs),
    activity: buildSpotifyPresenceActivity(currentSpotifyConnection, nowMs),
  };
}

function areSpotifyActivitiesMeaningfullyEqual(
  left: PresenceSpotifyActivity | null | undefined,
  right: PresenceSpotifyActivity | null | undefined,
): boolean {
  const safeLeft = left ?? null;
  const safeRight = right ?? null;
  if (!safeLeft && !safeRight) {
    return true;
  }
  if (!safeLeft || !safeRight) {
    return false;
  }

  if (
    safeLeft.provider !== safeRight.provider ||
    (safeLeft.showOnProfile ?? true) !== (safeRight.showOnProfile ?? true) ||
    safeLeft.trackId !== safeRight.trackId ||
    safeLeft.trackTitle !== safeRight.trackTitle ||
    safeLeft.artistNames !== safeRight.artistNames ||
    safeLeft.trackUrl !== safeRight.trackUrl ||
    safeLeft.coverUrl !== safeRight.coverUrl ||
    safeLeft.durationSeconds !== safeRight.durationSeconds ||
    (safeLeft.isPlaying ?? true) !== (safeRight.isPlaying ?? true)
  ) {
    return false;
  }

  if (safeLeft.isPlaying === false || safeRight.isPlaying === false) {
    return Math.abs(safeLeft.progressSeconds - safeRight.progressSeconds) <= 1;
  }

  const leftStartedAt = Number(safeLeft.startedAt ?? 0);
  const rightStartedAt = Number(safeRight.startedAt ?? 0);
  return Math.abs(leftStartedAt - rightStartedAt) <= 2_500;
}

function areSemanticSnapshotsEqual(
  left: PresenceSemanticSnapshot | null | undefined,
  right: PresenceSemanticSnapshot | null | undefined,
): boolean {
  const safeLeft = left ?? null;
  const safeRight = right ?? null;
  if (!safeLeft && !safeRight) {
    return true;
  }
  if (!safeLeft || !safeRight) {
    return false;
  }

  return safeLeft.state === safeRight.state && areSpotifyActivitiesMeaningfullyEqual(safeLeft.activity, safeRight.activity);
}

async function persistPresencePayload(payload: PersistedPresencePayload): Promise<void> {
  const tableName = await getPresenceTableName();
  const { hasActivitiesColumn } = await getPresenceTableColumnCapabilities();
  const rowPayload: Record<string, unknown> = {
    user_id: payload.user_id,
    status: payload.status,
    last_seen: payload.last_seen,
    updated_at: payload.updated_at,
  };

  if (hasActivitiesColumn && payload.activities) {
    rowPayload.activities = payload.activities;
  }

  await supabase.from(tableName).upsert(rowPayload, { onConflict: "user_id" });
}

function persistPresenceWithKeepalive(
  state: PresenceState,
  activity: PresenceSpotifyActivity | null,
  userIdOverride?: string | null,
): void {
  const payload = buildPresencePayload(state, activity, userIdOverride);
  if (!payload || typeof fetch !== "function" || !supabaseUrl || !supabaseAnonKey) {
    return;
  }

  const sendKeepalive = async (): Promise<void> => {
    const tableName = await getPresenceTableName();
    const { hasActivitiesColumn } = await getPresenceTableColumnCapabilities();
    const accessToken = String(await authService.getValidatedEdgeAccessToken() ?? "").trim();
    if (!accessToken) {
      return;
    }

    const keepalivePayload: Record<string, unknown> = {
      user_id: payload.user_id,
      status: payload.status,
      last_seen: payload.last_seen,
      updated_at: payload.updated_at,
    };
    if (hasActivitiesColumn && payload.activities) {
      keepalivePayload.activities = payload.activities;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      Prefer: "resolution=merge-duplicates,return=minimal",
      authorization: `Bearer ${accessToken}`,
    };

    await fetch(`${supabaseUrl}/rest/v1/${tableName}?on_conflict=user_id`, {
      method: "POST",
      headers,
      body: JSON.stringify(keepalivePayload),
      keepalive: true,
    });
  };

  void sendKeepalive().catch(() => undefined);
}

function resolveEffectiveState(nowMs: number = Date.now()): PresenceState {
  if (!currentUserId) {
    return "invisivel";
  }

  if (preferredState === "dnd" || preferredState === "invisivel" || preferredState === "idle") {
    return preferredState;
  }

  const isDocumentHidden = typeof document !== "undefined" ? document.hidden : false;
  if (isDocumentHidden) {
    return "idle";
  }

  return nowMs - lastActivityAtMs >= IDLE_AFTER_MS ? "idle" : "online";
}

function scheduleIdleTransition(): void {
  clearIdleTimer();

  if (
    typeof window === "undefined" ||
    !currentUserId ||
    preferredState === "dnd" ||
    preferredState === "invisivel" ||
    preferredState === "idle"
  ) {
    return;
  }

  const remainingMs = Math.max(1_000, IDLE_AFTER_MS - (Date.now() - lastActivityAtMs));
  idleTimerId = window.setTimeout(() => {
    void syncPresenceState({
      forcePersist: true,
      reason: "idle-transition",
    });
  }, remainingMs);
}

function ensureHeartbeat(): void {
  clearHeartbeatTimer();
  if (typeof window === "undefined" || !currentUserId) {
    return;
  }

  const intervalMs =
    typeof document !== "undefined" && document.hidden
      ? HEARTBEAT_INTERVAL_BACKGROUND_MS
      : HEARTBEAT_INTERVAL_FOREGROUND_MS;

  heartbeatTimerId = window.setInterval(() => {
    void syncPresenceState({
      forcePersist: true,
      reason: "heartbeat",
    });
  }, intervalMs);
}

async function broadcastPresenceEvents(
  previousSnapshot: PresenceSemanticSnapshot | null,
  nextSnapshot: PresenceSemanticSnapshot,
  payload: PersistedPresencePayload,
): Promise<void> {
  void previousSnapshot;
  void nextSnapshot;
  await gatewayService.publish("PRESENCE_UPDATE", {
    presence: {
      status: payload.status,
      activities: payload.activities ?? [],
    },
  });
}

async function syncPresenceState(
  options: {
    forcePersist?: boolean;
    forceBroadcast?: boolean;
    reason?: string;
  } = {},
): Promise<void> {
  const nowMs = Date.now();
  const nextSnapshot = getCurrentSemanticSnapshot(nowMs);
  const nextState = nextSnapshot.state;
  const stateChanged = currentState !== nextState;

  if (stateChanged) {
    currentState = nextState;
    notify();
  }

  scheduleIdleTransition();

  const payload = buildPresencePayload(nextSnapshot.state, nextSnapshot.activity);
  if (!payload) {
    return;
  }

  const shouldPersist =
    options.forcePersist === true ||
    options.reason === "heartbeat" ||
    !areSemanticSnapshotsEqual(lastPersistedSnapshot, nextSnapshot);

  if (shouldPersist) {
    try {
      await persistPresencePayload(payload);
      lastPersistedSnapshot = nextSnapshot;
    } catch {
      // Keep trying on the next heartbeat or semantic change.
    }
  }

  const shouldBroadcast =
    options.forceBroadcast === true ||
    !areSemanticSnapshotsEqual(lastBroadcastSnapshot, nextSnapshot);

  if (!shouldBroadcast) {
    return;
  }

  const previousSnapshot = lastBroadcastSnapshot;
  try {
    await broadcastPresenceEvents(previousSnapshot, nextSnapshot, payload);
    lastBroadcastSnapshot = nextSnapshot;
  } catch {
    // Gateway reconnect logic will re-publish the latest snapshot when connected again.
  }
}

function handleLocalActivity(): void {
  if (!currentUserId || preferredState === "dnd" || preferredState === "invisivel" || preferredState === "idle") {
    return;
  }

  const nowMs = Date.now();
  lastActivityAtMs = nowMs;

  // Reduce high-frequency mouse/keyboard churn while keeping quick idle->online recovery.
  if (currentState === "idle") {
    lastLocalActivitySyncAtMs = nowMs;
    void syncPresenceState({
      forcePersist: true,
      forceBroadcast: true,
      reason: "local-activity-idle-exit",
    });
    return;
  }

  if (nowMs - lastLocalActivitySyncAtMs < LOCAL_ACTIVITY_SYNC_MIN_INTERVAL_MS) {
    return;
  }

  lastLocalActivitySyncAtMs = nowMs;
  void syncPresenceState({
    reason: "local-activity",
  });
}

function handleVisibilityChange(): void {
  if (!currentUserId) {
    return;
  }

  ensureHeartbeat();
  if (typeof document !== "undefined" && !document.hidden) {
    lastActivityAtMs = Date.now();
  }

  void syncPresenceState({
    forcePersist: true,
    reason: "visibility-change",
  });
}

function handleBrowserOnline(): void {
  if (!currentUserId) {
    return;
  }

  lastActivityAtMs = Date.now();
  void syncPresenceState({
    forcePersist: true,
    forceBroadcast: true,
    reason: "browser-online",
  });
}

function handleBrowserOffline(): void {
  if (currentState === "invisivel") {
    return;
  }

  currentState = "invisivel";
  notify();
}

function bindLifecycleListeners(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.addEventListener("pointerdown", handleLocalActivity, true);
  window.addEventListener("keydown", handleLocalActivity, true);
  window.addEventListener("mousemove", handleLocalActivity, true);
  window.addEventListener("focus", handleLocalActivity, true);
  window.addEventListener("online", handleBrowserOnline);
  window.addEventListener("offline", handleBrowserOffline);
  window.addEventListener("pagehide", handlePageHide, true);
  window.addEventListener("beforeunload", handlePageHide, true);
  document.addEventListener("visibilitychange", handleVisibilityChange, true);
}

function unbindLifecycleListeners(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.removeEventListener("pointerdown", handleLocalActivity, true);
  window.removeEventListener("keydown", handleLocalActivity, true);
  window.removeEventListener("mousemove", handleLocalActivity, true);
  window.removeEventListener("focus", handleLocalActivity, true);
  window.removeEventListener("online", handleBrowserOnline);
  window.removeEventListener("offline", handleBrowserOffline);
  window.removeEventListener("pagehide", handlePageHide, true);
  window.removeEventListener("beforeunload", handlePageHide, true);
  document.removeEventListener("visibilitychange", handleVisibilityChange, true);
}

function handlePageHide(): void {
  if (!currentUserId) {
    return;
  }

  const snapshot = getCurrentSemanticSnapshot();
  persistPresenceWithKeepalive(snapshot.state, snapshot.activity, currentUserId);
}

function getEffectiveSpotifyScope(): string | null {
  const normalizedScope = String(spotifyConnectionScope ?? "").trim();
  if (normalizedScope) {
    return normalizedScope;
  }

  const normalizedUserId = String(currentUserId ?? "").trim();
  return normalizedUserId || null;
}

function bindSpotifyPresence(): void {
  clearSpotifySubscription();
  currentSpotifyConnection = createDefaultSpotifyConnection();

  const scope = getEffectiveSpotifyScope();
  if (!currentUserId || !scope) {
    void syncPresenceState({
      forcePersist: true,
      forceBroadcast: true,
      reason: "spotify-scope-cleared",
    });
    return;
  }

  currentSpotifyConnection = readSpotifyConnection(scope);
  spotifyUnsubscribe = subscribeSpotifyConnection(
    scope,
    (connection) => {
      currentSpotifyConnection = connection;
      void syncPresenceState({
        reason: "spotify-update",
      });
    },
    {
      enablePolling: true,
    },
  );

  void syncSpotifyConnection(scope)
    .then((result) => {
      currentSpotifyConnection = result.connection;
      return syncPresenceState({
        forcePersist: true,
        forceBroadcast: true,
        reason: "spotify-prime",
      });
    })
    .catch(() => {
      void syncPresenceState({
        forcePersist: true,
        forceBroadcast: true,
        reason: "spotify-prime-failed",
      });
    });
}

export function subscribe(subscriber: PresenceSubscriber): () => void {
  subscribers.add(subscriber);
  subscriber(currentState);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function getState(): PresenceState {
  return currentState;
}

export function stop(): void {
  clearHeartbeatTimer();
  clearIdleTimer();
  clearSpotifySubscription();
  clearGatewaySubscription();
  unbindLifecycleListeners();

  if (currentUserId) {
    const snapshot = getCurrentSemanticSnapshot();
    persistPresenceWithKeepalive(snapshot.state, snapshot.activity, currentUserId);
  }

  currentUserId = null;
  currentState = "invisivel";
  preferredState = "online";
  lastActivityAtMs = Date.now();
  currentSpotifyConnection = createDefaultSpotifyConnection();
  lastPersistedSnapshot = null;
  lastBroadcastSnapshot = null;
  lastGatewayStatus = "idle";
  lastLocalActivitySyncAtMs = 0;
  notify();
}

export function setPreferredState(state: PresenceState): void {
  preferredState = state;
  if (state === "online") {
    lastActivityAtMs = Date.now();
  }
  void writePresencePreference(currentUserId, state);
  if (!currentUserId) {
    currentState = state;
    notify();
    return;
  }

  void syncPresenceState({
    forcePersist: true,
    forceBroadcast: true,
    reason: "preferred-state",
  });
}

export function setSpotifyConnectionScope(scope: string | null): void {
  const normalizedScope = String(scope ?? "").trim() || null;
  if (spotifyConnectionScope === normalizedScope) {
    return;
  }

  spotifyConnectionScope = normalizedScope;
  if (!currentUserId) {
    return;
  }

  bindSpotifyPresence();
}

export function start(userId: string | null | undefined): void {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    stop();
    return;
  }

  stop();

  currentUserId = normalizedUserId;
  preferredState = "online";
  lastActivityAtMs = Date.now();
  lastLocalActivitySyncAtMs = 0;
  currentState = resolveEffectiveState();
  notify();

  bindLifecycleListeners();
  ensureHeartbeat();
  scheduleIdleTransition();
  bindSpotifyPresence();

  gatewayStateUnsubscribe = gatewayService.subscribeState((gatewayState) => {
    const nextStatus = gatewayState.status;
    if (lastGatewayStatus !== "connected" && nextStatus === "connected" && currentUserId) {
      void syncPresenceState({
        forcePersist: true,
        forceBroadcast: true,
        reason: "gateway-reconnected",
      });
    }
    lastGatewayStatus = nextStatus;
  });

  const currentStartSequence = ++startSequence;
  void (async () => {
    const storedPreference = await readPresencePreference(normalizedUserId);
    if (!currentUserId || currentUserId !== normalizedUserId || currentStartSequence !== startSequence) {
      return;
    }

    if (storedPreference) {
      preferredState = storedPreference;
    }

    await syncPresenceState({
      forcePersist: true,
      forceBroadcast: lastBroadcastSnapshot == null,
      reason: "startup",
    });
  })().catch((error) => {
    logPresenceControllerDebug("startup_sync_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

export function sendTyping(_userId: string): void {
  void currentSpotifyConnection;
}

export const presenceController = {
  start,
  stop,
  subscribe,
  getState,
  setPreferredState,
  setSpotifyConnectionScope,
  sendTyping,
};
