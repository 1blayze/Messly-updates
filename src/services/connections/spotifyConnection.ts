import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";

export interface SpotifyPlaybackState {
  trackTitle: string;
  artistNames: string;
  coverUrl: string;
  trackUrl: string;
  trackId: string;
  progressSeconds: number;
  durationSeconds: number;
  isPlaying?: boolean;
  deviceId?: string;
  deviceName?: string;
  shuffleEnabled?: boolean;
  repeatMode?: "off" | "track" | "context";
  updatedAt?: string;
}

export interface SpotifyTokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
}

export type SpotifyConnectionAuthState = "oauth" | "detached";

export interface SpotifyConnectionState {
  v: 1;
  provider: "spotify";
  authState: SpotifyConnectionAuthState;
  connected: boolean;
  accountName: string;
  accountId: string;
  accountUrl: string;
  accountProduct: string;
  showOnProfile: boolean;
  showAsStatus: boolean;
  playback: SpotifyPlaybackState | null;
  token: SpotifyTokenState | null;
  updatedAt: string;
}

export interface SpotifyConnectionUpdatedDetail {
  userId: string;
  connection: SpotifyConnectionState;
}

export interface PersistedSpotifyConnectionState {
  v: 1;
  provider: "spotify";
  authState: "detached";
  connected: true;
  accountName: string;
  accountId: string;
  accountUrl: string;
  showOnProfile: boolean;
  showAsStatus: boolean;
  updatedAt: string;
}

const SPOTIFY_CONNECTION_STORAGE_KEY_PREFIX = "messly:spotify-connection:";
const SPOTIFY_RATE_LIMIT_STORAGE_KEY_PREFIX = "messly:spotify-rate-limit:";
export const SPOTIFY_CONNECTION_UPDATED_EVENT = "messly:spotify-connection-updated";
const FALLBACK_USER_SCOPE = "guest";
const SPOTIFY_CONNECTIONS_EDGE_FUNCTION = "spotify-connections";
const SPOTIFY_WEB_CALLBACK_FALLBACK_URL = "https://messly.site/callback";
const SPOTIFY_DESKTOP_PRESENCE_BRIDGE_ENABLED = String(import.meta.env.VITE_SPOTIFY_DESKTOP_BRIDGE ?? "").trim() === "1";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_POPUP_NAME = "messly_spotify_oauth";
const SPOTIFY_POPUP_TIMEOUT_MS = 3 * 60 * 1000;
const SPOTIFY_PLAYBACK_ACTIVE_SYNC_INTERVAL_MS = 2_500;
const SPOTIFY_PLAYBACK_ACTIVE_DEGRADED_SYNC_INTERVAL_MS = 5_000;
const SPOTIFY_PLAYBACK_IDLE_SYNC_INTERVAL_MS = 4_500;
const SPOTIFY_PLAYBACK_IDLE_DEGRADED_SYNC_INTERVAL_MS = 5_000;
const SPOTIFY_PLAYBACK_DISCONNECTED_SYNC_INTERVAL_MS = 8_000;
const SPOTIFY_PLAYBACK_TRANSITION_CONFIRM_DELAY_MS = 1_250;
const SPOTIFY_PLAYBACK_TRANSITION_BURST_INTERVAL_MS = 1_000;
const SPOTIFY_PLAYBACK_TRANSITION_BURST_WINDOW_MS = 2_500;
const SPOTIFY_INTERACTIVE_MIN_SYNC_GAP_MS = 4_000;
const SPOTIFY_RATE_LIMIT_BACKOFF_BASE_MS = 3_000;
const SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS = 60_000;
const SPOTIFY_RATE_LIMIT_MIN_COOLDOWN_MS = 15_000;
const SPOTIFY_PLAYBACK_END_GRACE_MS = 8_000;
const SPOTIFY_PLAYBACK_NO_DURATION_STALE_MS = 60_000;
const SPOTIFY_TOKEN_EXPIRY_SKEW_MS = 60_000;
const SPOTIFY_DEFAULT_ACCOUNT_NAME = "Spotify";
const SPOTIFY_RATE_LIMIT_FALLBACK_MS = SPOTIFY_RATE_LIMIT_BACKOFF_BASE_MS;
const SPOTIFY_RATE_LIMIT_MAX_BACKOFF_MS = 60_000;
const SPOTIFY_LOCAL_RATE_WINDOW_MS = 20_000;
const SPOTIFY_LOCAL_RATE_WINDOW_MAX_REQUESTS = 7;
const SPOTIFY_DEGRADED_MODE_WINDOW_MS = 45_000;
const SPOTIFY_HIGH_LATENCY_THRESHOLD_MS = 1_500;
const SPOTIFY_BACKOFF_JITTER_RATIO = 0.25;
const SPOTIFY_POLLING_DEBUG_KEY = "messly:spotify-polling-debug";
const SPOTIFY_DESKTOP_STATE_REFRESH_TTL_MS = 8_000;

const SPOTIFY_OAUTH_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
];

interface DesktopSpotifyPresencePayload {
  scope?: string | null;
  connection?: unknown;
}

interface DesktopScopeSnapshot {
  fetchedAt: number;
  requestedAt: number;
}

interface SpotifyDesktopBridgeRuntimeState {
  stopListening: (() => void) | null;
  scopeSnapshots: Map<string, DesktopScopeSnapshot>;
  pollingSubscribersByScope: Map<string, number>;
}

interface SpotifyProfileSnapshot {
  accountName: string;
  accountId: string;
  accountUrl: string;
  accountProduct: string;
}

interface SpotifyTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface SpotifyEdgeBeginOauthResponse {
  authorizeUrl?: unknown;
  state?: unknown;
  redirectUri?: unknown;
  expiresAt?: unknown;
}

interface SpotifyEdgeConnectionResponse {
  connection?: unknown;
}

type SpotifyEdgeSyncResponse = SpotifyEdgeConnectionResponse;

interface SpotifyPlaybackApiArtist {
  name?: string;
}

interface SpotifyPlaybackApiImage {
  url?: string;
  height?: number;
  width?: number;
}

interface SpotifyPlaybackApiTrack {
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  external_urls?: {
    spotify?: string;
  };
  artists?: SpotifyPlaybackApiArtist[];
  album?: {
    images?: SpotifyPlaybackApiImage[];
  };
}

interface SpotifyPlaybackApiDevice {
  id?: string;
  name?: string;
}

interface SpotifyPlayerResponse {
  is_playing?: boolean;
  progress_ms?: number;
  currently_playing_type?: string;
  shuffle_state?: boolean;
  repeat_state?: string;
  device?: SpotifyPlaybackApiDevice | null;
  item?: SpotifyPlaybackApiTrack | null;
}

type SpotifyPlaybackFetchStatus = "playing" | "idle" | "no_device";

interface SpotifyPlaybackFetchResult {
  playback: SpotifyPlaybackState | null;
  playbackKey: string;
  status: SpotifyPlaybackFetchStatus;
  latencyMs: number;
}

interface SpotifySyncResult {
  connection: SpotifyConnectionState;
  playbackKey: string;
  playbackStatus: SpotifyPlaybackFetchStatus;
  latencyMs: number;
  didConnectionChange: boolean;
}

interface SpotifyPollerState {
  subscribers: number;
  timerId: number | null;
  syncing: boolean;
  syncAbortController: AbortController | null;
  rateLimitedUntil: number;
  rateLimitAttempt: number;
  burstUntil: number;
  degradedUntil: number;
  lastSyncStartedAt: number;
  requestTimestamps: number[];
  lastPlaybackKey: string | null;
  hasLoggedRateLimit: boolean;
  lastLogSignature: string | null;
  onWindowFocus: (() => void) | null;
  onVisibilityChange: (() => void) | null;
}

interface SpotifyConnectionRuntimeState {
  pollers: Map<string, SpotifyPollerState>;
  generation: string;
}

type SpotifyPollerSnapshot = Partial<SpotifyPollerState> & {
  timerId?: number | null;
  syncAbortController?: AbortController | null;
  onWindowFocus?: (() => void) | null;
  onVisibilityChange?: (() => void) | null;
};

const SPOTIFY_RUNTIME_GENERATION = `${Date.now()}:${Math.random().toString(36).slice(2)}`;

function cleanupSpotifyPollers(pollers: unknown): void {
  if (!(pollers instanceof Map) || typeof window === "undefined") {
    return;
  }

  for (const poller of pollers.values()) {
    const snapshot = poller as SpotifyPollerSnapshot;
    if (typeof snapshot.timerId === "number") {
      window.clearTimeout(snapshot.timerId);
    }
    snapshot.syncAbortController?.abort();
    if (snapshot.onWindowFocus) {
      window.removeEventListener("focus", snapshot.onWindowFocus);
    }
    if (snapshot.onVisibilityChange) {
      document.removeEventListener("visibilitychange", snapshot.onVisibilityChange);
    }
  }

  pollers.clear();
}

function getSpotifyConnectionRuntimeState(): SpotifyConnectionRuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __messlySpotifyConnectionRuntimeState__?: SpotifyConnectionRuntimeState;
  };

  if (!runtime.__messlySpotifyConnectionRuntimeState__) {
    runtime.__messlySpotifyConnectionRuntimeState__ = {
      pollers: new Map<string, SpotifyPollerState>(),
      generation: SPOTIFY_RUNTIME_GENERATION,
    };
  } else if (runtime.__messlySpotifyConnectionRuntimeState__.generation !== SPOTIFY_RUNTIME_GENERATION) {
    cleanupSpotifyPollers(runtime.__messlySpotifyConnectionRuntimeState__.pollers);
    runtime.__messlySpotifyConnectionRuntimeState__ = {
      pollers: new Map<string, SpotifyPollerState>(),
      generation: SPOTIFY_RUNTIME_GENERATION,
    };
  }

  return runtime.__messlySpotifyConnectionRuntimeState__;
}

const spotifyPollers = getSpotifyConnectionRuntimeState().pollers;

function isDesktopSpotifyPresenceBridgeAvailable(): boolean {
  if (!SPOTIFY_DESKTOP_PRESENCE_BRIDGE_ENABLED) {
    return false;
  }
  // In Electron desktop runtime, Spotify networking/polling is delegated to main process via IPC.
  if (typeof window === "undefined") {
    return false;
  }
  const api = window.electronAPI;
  return Boolean(
    api &&
      typeof api.spotifyPresenceGetState === "function" &&
      typeof api.spotifyPresenceConnect === "function" &&
      typeof api.spotifyPresenceDisconnect === "function" &&
      typeof api.spotifyPresenceSetVisibility === "function" &&
      typeof api.spotifyPresenceStart === "function" &&
      typeof api.spotifyPresenceStop === "function" &&
      typeof api.onSpotifyPresenceUpdate === "function",
  );
}

function getSpotifyDesktopBridgeRuntimeState(): SpotifyDesktopBridgeRuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __messlySpotifyDesktopBridgeRuntimeState__?: SpotifyDesktopBridgeRuntimeState;
  };

  if (!runtime.__messlySpotifyDesktopBridgeRuntimeState__) {
    runtime.__messlySpotifyDesktopBridgeRuntimeState__ = {
      stopListening: null,
      scopeSnapshots: new Map<string, DesktopScopeSnapshot>(),
      pollingSubscribersByScope: new Map<string, number>(),
    };
  }

  return runtime.__messlySpotifyDesktopBridgeRuntimeState__;
}

function applyDesktopConnectionSnapshot(
  scope: string | null | undefined,
  connectionRaw: unknown,
  options: { suppressDesktopSync?: boolean } = {},
): SpotifyConnectionState {
  const normalizedScope = resolveUserScope(scope);
  return writeSpotifyConnection(normalizedScope, normalizeConnection(connectionRaw), {
    suppressDesktopSync: options.suppressDesktopSync ?? true,
  });
}

function bindDesktopSpotifyPresenceUpdates(): void {
  if (!isDesktopSpotifyPresenceBridgeAvailable() || typeof window === "undefined") {
    return;
  }

  const runtime = getSpotifyDesktopBridgeRuntimeState();
  if (runtime.stopListening) {
    return;
  }

  const unsubscribe = window.electronAPI?.onSpotifyPresenceUpdate?.((payload: DesktopSpotifyPresencePayload) => {
    const scope = resolveUserScope(payload?.scope);
    applyDesktopConnectionSnapshot(scope, payload?.connection ?? null, {
      suppressDesktopSync: true,
    });
    runtime.scopeSnapshots.set(scope, {
      fetchedAt: Date.now(),
      requestedAt: Date.now(),
    });
  });

  runtime.stopListening = typeof unsubscribe === "function" ? unsubscribe : null;
}

async function requestDesktopSpotifyPresenceState(scope: string): Promise<void> {
  if (!isDesktopSpotifyPresenceBridgeAvailable() || typeof window === "undefined") {
    return;
  }

  const api = window.electronAPI;
  const getState = api?.spotifyPresenceGetState;
  const pollOnce = api?.spotifyPresencePollOnce;
  if (typeof getState !== "function") {
    return;
  }

  const runtime = getSpotifyDesktopBridgeRuntimeState();
  const snapshot = runtime.scopeSnapshots.get(scope);
  const nowMs = Date.now();
  if (snapshot && nowMs - snapshot.fetchedAt <= SPOTIFY_DESKTOP_STATE_REFRESH_TTL_MS) {
    return;
  }
  if (snapshot && nowMs - snapshot.requestedAt <= 750) {
    return;
  }
  runtime.scopeSnapshots.set(scope, {
    fetchedAt: snapshot?.fetchedAt ?? 0,
    requestedAt: nowMs,
  });

  try {
    // Prefer a single forced poll so renderer receives fresh playback data
    // immediately instead of a potentially stale cached snapshot.
    if (typeof pollOnce === "function") {
      const polledConnection = await pollOnce({ scope });
      applyDesktopConnectionSnapshot(scope, polledConnection ?? null, {
        suppressDesktopSync: true,
      });
    } else {
      const response = await getState({ scope });
      applyDesktopConnectionSnapshot(scope, response?.connection ?? null, {
        suppressDesktopSync: true,
      });
    }
    runtime.scopeSnapshots.set(scope, {
      fetchedAt: Date.now(),
      requestedAt: nowMs,
    });
  } catch {
    runtime.scopeSnapshots.set(scope, {
      fetchedAt: snapshot?.fetchedAt ?? 0,
      requestedAt: nowMs,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface SpotifyApiError extends Error {
  code: "spotify_unauthorized" | "spotify_rate_limited" | "spotify_api_error" | "spotify_request_aborted";
  retryAfterMs?: number;
}

function createSpotifyApiError(
  code: SpotifyApiError["code"],
  message: string,
  options: { retryAfterMs?: number } = {},
): SpotifyApiError {
  const error = new Error(message) as SpotifyApiError;
  error.code = code;
  if (typeof options.retryAfterMs === "number" && Number.isFinite(options.retryAfterMs) && options.retryAfterMs > 0) {
    error.retryAfterMs = Math.round(options.retryAfterMs);
  }
  return error;
}

function readRetryAfterMs(response: Response): number | null {
  const raw = String(response.headers.get("retry-after") ?? "").trim();
  if (!raw) {
    return null;
  }
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.max(1_000, Math.round(asSeconds * 1000));
  }
  const asDate = Date.parse(raw);
  if (!Number.isFinite(asDate)) {
    return null;
  }
  return Math.max(1_000, asDate - Date.now());
}

function isSpotifyApiError(value: unknown): value is SpotifyApiError {
  return Boolean(value) && typeof value === "object" && "code" in (value as Record<string, unknown>);
}

function readEdgeRetryAfterMs(error: EdgeFunctionError): number | undefined {
  const details = error.details;
  if (details && typeof details === "object" && "retryAfterMs" in (details as Record<string, unknown>)) {
    const raw = Number((details as { retryAfterMs?: unknown }).retryAfterMs ?? 0);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.round(raw);
    }
  }
  return undefined;
}

function normalizeSpotifyEdgeError(error: unknown): never {
  if (error instanceof EdgeFunctionError) {
    const status = Number(error.status ?? 0);
    const code = String(error.code ?? "").trim().toUpperCase();
    const message = String(error.message ?? "").trim() || "Falha ao sincronizar a conexao Spotify.";

    if (status === 401 || status === 403 || code === "UNAUTHENTICATED" || code === "INVALID_TOKEN") {
      throw createSpotifyApiError("spotify_unauthorized", message);
    }

    if (status === 429 || code === "RATE_LIMITED" || code === "SPOTIFY_RATE_LIMITED") {
      throw createSpotifyApiError("spotify_rate_limited", message, {
        retryAfterMs: readEdgeRetryAfterMs(error),
      });
    }

    throw createSpotifyApiError("spotify_api_error", message);
  }

  if (error instanceof Error) {
    throw createSpotifyApiError("spotify_api_error", error.message || "Falha ao sincronizar a conexao Spotify.");
  }

  throw createSpotifyApiError("spotify_api_error", "Falha ao sincronizar a conexao Spotify.");
}

async function invokeSpotifyConnectionsEdge<TRequest extends Record<string, unknown>, TResponse>(
  payload: TRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<TResponse> {
  try {
    return await invokeEdgeJson<TRequest, TResponse>(SPOTIFY_CONNECTIONS_EDGE_FUNCTION, payload, {
      requireAuth: true,
      retries: 0,
      timeoutMs: options.timeoutMs ?? 15_000,
      signal: options.signal,
    });
  } catch (error) {
    normalizeSpotifyEdgeError(error);
  }
}

function parseSpotifyEdgeBeginResponse(raw: SpotifyEdgeBeginOauthResponse): {
  authorizeUrl: string;
  state: string;
  redirectUri: string;
} {
  const authorizeUrl = String(raw?.authorizeUrl ?? "").trim();
  const state = String(raw?.state ?? "").trim();
  const redirectUri = String(raw?.redirectUri ?? "").trim() || getSpotifyRedirectUri();

  if (!authorizeUrl) {
    throw new Error("Nao foi possivel iniciar a autenticacao com Spotify.");
  }
  if (!state) {
    throw new Error("Nao foi possivel validar o estado de autenticacao do Spotify.");
  }

  return {
    authorizeUrl,
    state,
    redirectUri,
  };
}

function normalizeSpotifyEdgeConnection(connectionRaw: unknown): SpotifyConnectionState {
  return normalizeConnection(connectionRaw);
}

export async function completeSpotifyOAuthCallbackCode(
  userId: string | null | undefined,
  code: string,
  state: string,
): Promise<SpotifyConnectionState> {
  const scopedUserId = resolveUserScope(userId);
  const normalizedCode = String(code ?? "").trim();
  const normalizedState = String(state ?? "").trim();
  if (!normalizedCode || !normalizedState) {
    throw new Error("Codigo de autorizacao do Spotify invalido.");
  }

  const response = await invokeSpotifyConnectionsEdge<
    {
      action: "complete_oauth";
      code: string;
      state: string;
    },
    SpotifyEdgeConnectionResponse
  >({
    action: "complete_oauth",
    code: normalizedCode,
    state: normalizedState,
  });

  const nextConnection = normalizeSpotifyEdgeConnection(response?.connection ?? null);
  return writeSpotifyConnection(scopedUserId, nextConnection);
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException
    ? value.name === "AbortError"
    : Boolean(value) && typeof value === "object" && String((value as { name?: unknown }).name ?? "") === "AbortError";
}

function logSpotifyPolling(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {},
): void {
  const debugEnabled = (() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(SPOTIFY_POLLING_DEBUG_KEY) === "1";
    } catch {
      return false;
    }
  })();

  if (level === "info" && !debugEnabled) {
    return;
  }

  const detailSummary = Object.entries(details)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const message = detailSummary
    ? `[spotify-polling] ${event} ${detailSummary}`
    : `[spotify-polling] ${event}`;

  if (level === "error") {
    console.error(message);
    return;
  }
  if (level === "warn") {
    console.warn(message);
    return;
  }
  console.info(message);
}

function buildSpotifyPlaybackKey(playback: SpotifyPlaybackState | null | undefined): string {
  if (!playback) {
    return "idle";
  }

  return [
    String(playback.trackId ?? "").trim() || "-",
    playback.isPlaying === false ? "0" : "1",
    String(playback.deviceId ?? "").trim() || "-",
    playback.shuffleEnabled ? "1" : "0",
    String(playback.repeatMode ?? "off").trim() || "off",
  ].join("|");
}

function hasRelevantPlaybackTransition(
  previousPlayback: SpotifyPlaybackState | null | undefined,
  nextPlayback: SpotifyPlaybackState | null | undefined,
): boolean {
  const safePrevious = previousPlayback ?? null;
  const safeNext = nextPlayback ?? null;

  if (!safePrevious && !safeNext) {
    return false;
  }
  if (!safePrevious || !safeNext) {
    return true;
  }

  if (
    safePrevious.trackId !== safeNext.trackId ||
    safePrevious.isPlaying !== safeNext.isPlaying ||
    safePrevious.deviceId !== safeNext.deviceId ||
    safePrevious.shuffleEnabled !== safeNext.shuffleEnabled ||
    safePrevious.repeatMode !== safeNext.repeatMode
  ) {
    return true;
  }

  const progressDeltaSeconds = Math.abs(
    Math.round(Number(safePrevious.progressSeconds ?? 0)) - Math.round(Number(safeNext.progressSeconds ?? 0)),
  );
  const seekToleranceSeconds =
    safePrevious.isPlaying === false && safeNext.isPlaying === false
      ? 3
      : 12;

  return progressDeltaSeconds >= seekToleranceSeconds;
}

function buildSpotifyConnectionFingerprint(connection: SpotifyConnectionState): string {
  return [
    connection.connected ? "1" : "0",
    connection.accountId,
    connection.accountName,
    connection.accountUrl,
    connection.accountProduct,
    connection.showOnProfile ? "1" : "0",
    connection.showAsStatus ? "1" : "0",
    buildSpotifyPlaybackKey(connection.playback),
    connection.token?.accessToken ?? "",
    String(connection.token?.expiresAt ?? 0),
    connection.token?.scope ?? "",
  ].join("::");
}

function computeBackoffWithJitterMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const baseDelayMs = Math.min(
    SPOTIFY_RATE_LIMIT_MAX_BACKOFF_MS,
    SPOTIFY_RATE_LIMIT_BACKOFF_BASE_MS * (2 ** safeAttempt),
  );
  const jitterWindowMs = Math.max(0, Math.round(baseDelayMs * SPOTIFY_BACKOFF_JITTER_RATIO));
  const jitterMs = jitterWindowMs > 0 ? Math.floor(Math.random() * (jitterWindowMs + 1)) : 0;
  return Math.min(SPOTIFY_RATE_LIMIT_MAX_BACKOFF_MS, baseDelayMs + jitterMs);
}

function prunePollerRequestTimestamps(poller: SpotifyPollerState, nowMs: number): void {
  poller.requestTimestamps = poller.requestTimestamps.filter((timestamp) => nowMs - timestamp < SPOTIFY_LOCAL_RATE_WINDOW_MS);
}

function getPollerRateWindowDelayMs(poller: SpotifyPollerState, nowMs: number): number {
  prunePollerRequestTimestamps(poller, nowMs);
  if (poller.requestTimestamps.length < SPOTIFY_LOCAL_RATE_WINDOW_MAX_REQUESTS) {
    return 0;
  }
  const oldestTimestamp = poller.requestTimestamps[0] ?? nowMs;
  return Math.max(250, oldestTimestamp + SPOTIFY_LOCAL_RATE_WINDOW_MS - nowMs);
}

function reservePollerRequestSlot(poller: SpotifyPollerState, nowMs: number): void {
  prunePollerRequestTimestamps(poller, nowMs);
  poller.requestTimestamps.push(nowMs);
}

function areTokensEqual(left: SpotifyTokenState | null, right: SpotifyTokenState | null): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.tokenType === right.tokenType &&
    left.scope === right.scope
  );
}

function arePlaybackStatesEquivalent(
  left: SpotifyPlaybackState | null | undefined,
  right: SpotifyPlaybackState | null | undefined,
): boolean {
  const safeLeft = left ?? null;
  const safeRight = right ?? null;
  if (!safeLeft && !safeRight) {
    return true;
  }
  if (!safeLeft || !safeRight) {
    return false;
  }
  return (
    safeLeft.trackId === safeRight.trackId &&
    safeLeft.trackTitle === safeRight.trackTitle &&
    safeLeft.artistNames === safeRight.artistNames &&
    safeLeft.trackUrl === safeRight.trackUrl &&
    safeLeft.coverUrl === safeRight.coverUrl &&
    safeLeft.deviceId === safeRight.deviceId &&
    safeLeft.shuffleEnabled === safeRight.shuffleEnabled &&
    safeLeft.repeatMode === safeRight.repeatMode &&
    safeLeft.isPlaying === safeRight.isPlaying &&
    safeLeft.durationSeconds === safeRight.durationSeconds &&
    Math.abs(safeLeft.progressSeconds - safeRight.progressSeconds) <= (safeLeft.isPlaying ? 12 : 3)
  );
}

function resolveUserScope(userId: string | null | undefined): string {
  const normalized = String(userId ?? "").trim();
  return normalized || FALLBACK_USER_SCOPE;
}

function buildSpotifyRateLimitStorageKey(userId: string): string {
  return `${SPOTIFY_RATE_LIMIT_STORAGE_KEY_PREFIX}${resolveUserScope(userId)}`;
}

function readSpotifyRateLimitUntil(userId: string): number {
  if (typeof window === "undefined") {
    return 0;
  }

  try {
    const raw = window.localStorage.getItem(buildSpotifyRateLimitStorageKey(userId));
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > Date.now() ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSpotifyRateLimitUntil(userId: string, untilMs: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
      window.localStorage.removeItem(buildSpotifyRateLimitStorageKey(userId));
      return;
    }
    window.localStorage.setItem(buildSpotifyRateLimitStorageKey(userId), String(Math.round(untilMs)));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeToken(raw: unknown): SpotifyTokenState | null {
  if (!isRecord(raw)) {
    return null;
  }

  const accessToken = String(raw.accessToken ?? "").trim();
  if (!accessToken) {
    return null;
  }

  const refreshToken = String(raw.refreshToken ?? "").trim();
  const tokenType = String(raw.tokenType ?? "Bearer").trim() || "Bearer";
  const scope = String(raw.scope ?? "").trim();
  const expiresAt = clampInt(raw.expiresAt, Date.now() + 30 * 60 * 1000, Date.now(), Date.now() + 48 * 60 * 60 * 1000);

  return {
    accessToken,
    refreshToken,
    tokenType,
    scope,
    expiresAt,
  };
}

function normalizePlayback(raw: unknown): SpotifyPlaybackState | null {
  if (!isRecord(raw)) {
    return null;
  }

  const trackTitle = String(raw.trackTitle ?? "").trim();
  const artistNames = String(raw.artistNames ?? "").trim();
  const coverUrl = String(raw.coverUrl ?? "").trim();
  const trackUrl = String(raw.trackUrl ?? "").trim();
  const trackId = String(raw.trackId ?? "").trim();
  const durationSeconds = clampInt(raw.durationSeconds, 0, 0, 60 * 60 * 10);
  const progressSeconds = clampInt(raw.progressSeconds, 0, 0, durationSeconds || 60 * 60 * 10);
  const repeatModeRaw = String(raw.repeatMode ?? "off").trim().toLowerCase();
  const repeatMode: "off" | "track" | "context" = repeatModeRaw === "track" || repeatModeRaw === "context"
    ? repeatModeRaw
    : "off";

  if (!trackTitle || !artistNames || durationSeconds <= 0) {
    return null;
  }

  return {
    trackTitle,
    artistNames,
    coverUrl,
    trackUrl,
    trackId,
    progressSeconds,
    durationSeconds,
    isPlaying: typeof raw.isPlaying === "boolean" ? raw.isPlaying : true,
    deviceId: String(raw.deviceId ?? "").trim(),
    deviceName: String(raw.deviceName ?? "").trim(),
    shuffleEnabled: Boolean(raw.shuffleEnabled),
    repeatMode,
  };
}

function normalizeConnection(raw: unknown): SpotifyConnectionState {
  const casted = isRecord(raw) ? raw : {};
  const requestedConnected = Boolean(casted.connected);
  const authStateRaw = String(casted.authState ?? "").trim().toLowerCase();
  const token = requestedConnected ? normalizeToken(casted.token) : null;
  const accountNameRaw = String(casted.accountName ?? "").trim();
  const accountIdRaw = String(casted.accountId ?? "").trim();
  const accountUrlRaw = String(casted.accountUrl ?? "").trim();
  const hasAnyIdentity = Boolean(accountNameRaw || accountIdRaw || accountUrlRaw);
  const hasDetachedIdentity =
    authStateRaw === "detached" && hasAnyIdentity;
  const hasDesktopOAuthIdentity =
    authStateRaw === "oauth" &&
    isDesktopSpotifyPresenceBridgeAvailable();
  const hasServerManagedOAuthIdentity =
    authStateRaw === "oauth" &&
    hasAnyIdentity;
  // Legacy mock connections (without OAuth token) are considered disconnected unless
  // they were explicitly restored from the persisted profile payload.
  // Desktop bridge snapshots are tokenless in renderer by design, but still valid OAuth.
  const connected = requestedConnected &&
    (Boolean(token) || hasDetachedIdentity || hasDesktopOAuthIdentity || hasServerManagedOAuthIdentity);
  const playback = token || hasDesktopOAuthIdentity || hasServerManagedOAuthIdentity
    ? normalizePlayback(casted.playback)
    : null;
  const accountName = connected ? String(casted.accountName ?? "").trim() || SPOTIFY_DEFAULT_ACCOUNT_NAME : "";
  const accountId = connected ? String(casted.accountId ?? "").trim() : "";
  const accountUrl = connected ? String(casted.accountUrl ?? "").trim() : "";
  const accountProduct = connected ? String(casted.accountProduct ?? "").trim().toLowerCase() : "";
  const updatedAtRaw = String(casted.updatedAt ?? "").trim();
  const updatedAt = updatedAtRaw || new Date().toISOString();

  return {
    v: 1,
    provider: "spotify",
    authState: connected && (Boolean(token) || hasDesktopOAuthIdentity || hasServerManagedOAuthIdentity)
      ? "oauth"
      : "detached",
    connected,
    accountName,
    accountId,
    accountUrl,
    accountProduct,
    showOnProfile: connected ? (typeof casted.showOnProfile === "boolean" ? casted.showOnProfile : true) : false,
    showAsStatus: connected ? (typeof casted.showAsStatus === "boolean" ? casted.showAsStatus : true) : false,
    playback,
    token,
    updatedAt,
  };
}

function getSpotifyClientId(): string {
  const candidate = String(import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "").trim();
  return candidate;
}

function buildWebFallbackRedirectUri(): string {
  if (typeof window === "undefined") {
    return SPOTIFY_WEB_CALLBACK_FALLBACK_URL;
  }

  try {
    const currentUrl = new URL(window.location.href);
    currentUrl.search = "";
    currentUrl.hash = "";
    return `${currentUrl.origin}/callback`;
  } catch {
    return SPOTIFY_WEB_CALLBACK_FALLBACK_URL;
  }
}

function getSpotifyRedirectUri(): string {
  const fromEnv = String(import.meta.env.VITE_SPOTIFY_REDIRECT_URI ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }

  return buildWebFallbackRedirectUri();
}

function ensureSpotifyOAuthConfig(): { redirectUri: string } {
  const redirectUri = getSpotifyRedirectUri();
  if (!redirectUri) {
    throw new Error("Nao foi possivel resolver o redirect URI do Spotify.");
  }

  return { redirectUri };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateSecureRandomString(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomBuffer = new Uint8Array(length);
  crypto.getRandomValues(randomBuffer);

  let output = "";
  for (let index = 0; index < randomBuffer.length; index += 1) {
    output += charset[randomBuffer[index] % charset.length];
  }
  return output;
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return encodeBase64Url(new Uint8Array(hashBuffer));
}

function buildSpotifyAuthPopupUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
  const authUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("scope", SPOTIFY_OAUTH_SCOPES.join(" "));
  return authUrl.toString();
}

function openSpotifyAuthPopup(url: string): Window | null {
  if (typeof window === "undefined") {
    return null;
  }

  const width = 520;
  const height = 720;
  const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
  const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2));
  const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  return window.open(url, SPOTIFY_POPUP_NAME, features);
}

function normalizeUrlPathname(pathname: string): string {
  const normalized = String(pathname ?? "").trim().replace(/\/+$/g, "");
  return normalized || "/";
}

function isSameRedirectTarget(currentUrl: URL, expectedRedirectUrl: URL): boolean {
  return (
    currentUrl.protocol.toLowerCase() === expectedRedirectUrl.protocol.toLowerCase() &&
    currentUrl.hostname.toLowerCase() === expectedRedirectUrl.hostname.toLowerCase() &&
    normalizeUrlPathname(currentUrl.pathname) === normalizeUrlPathname(expectedRedirectUrl.pathname)
  );
}

function isDesktopSpotifyOAuthBridgeAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const api = window.electronAPI;
  return Boolean(
    api &&
      typeof api.openExternalUrl === "function" &&
      typeof api.getPendingSpotifyOAuthCallback === "function" &&
      typeof api.onSpotifyOAuthCallback === "function",
  );
}

function waitForSpotifyAuthCode(popup: Window, redirectUri: string, expectedState: string): Promise<string> {
  const redirectUrl = new URL(redirectUri);

  return new Promise((resolve, reject) => {
    let isDone = false;
    const clearHandlers = (): void => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
    };
    const closePopup = (): void => {
      try {
        if (!popup.closed) {
          popup.close();
        }
      } catch {
        // ignore
      }
    };

    const finish = (callback: () => void): void => {
      if (isDone) {
        return;
      }
      isDone = true;
      clearHandlers();
      callback();
    };

    const resolveCallbackUrl = (rawUrl: string): void => {
      let popupUrl: URL;
      try {
        popupUrl = new URL(String(rawUrl ?? ""));
      } catch {
        return;
      }

      if (!isSameRedirectTarget(popupUrl, redirectUrl)) {
        return;
      }

      const authError = popupUrl.searchParams.get("error");
      const authCode = popupUrl.searchParams.get("code");
      const returnedState = popupUrl.searchParams.get("state");

      finish(() => {
        setTimeout(closePopup, 1500);
      });

      if (authError) {
        reject(new Error(`Spotify retornou erro de autenticacao: ${authError}.`));
        return;
      }

      if (!authCode) {
        reject(new Error("Nao foi possivel obter o codigo de autorizacao do Spotify."));
        return;
      }

      if (!returnedState || returnedState !== expectedState) {
        reject(new Error("Falha de validacao de seguranca na conexao do Spotify."));
        return;
      }

      resolve(authCode);
    };

    const handleMessage = (event: MessageEvent): void => {
      if (event.origin !== redirectUrl.origin) {
        return;
      }

      const payload = event.data as { type?: unknown; url?: unknown } | null;
      if (!payload || typeof payload !== "object") {
        return;
      }

      if (String(payload.type ?? "").trim() !== "messly:spotify:oauth-callback") {
        return;
      }

      resolveCallbackUrl(String(payload.url ?? ""));
    };

    window.addEventListener("message", handleMessage);

    const timeoutId = window.setTimeout(() => {
      finish(() => {
        setTimeout(closePopup, 1500);
        reject(new Error("Tempo esgotado ao conectar com o Spotify. Tente novamente."));
      });
    }, SPOTIFY_POPUP_TIMEOUT_MS);

    const intervalId = window.setInterval(() => {
      if (popup.closed) {
        finish(() => reject(new Error("Conexao com Spotify cancelada.")));
        return;
      }

      let popupHref = "";
      try {
        popupHref = popup.location.href;
      } catch {
        // Ignore cross-origin reads until redirect reaches app origin.
        return;
      }

      if (!popupHref || popupHref === "about:blank") {
        return;
      }

      resolveCallbackUrl(popupHref);
    }, 350);
  });
}

function waitForSpotifyAuthCodeFromDeepLink(redirectUri: string, expectedState: string): Promise<string> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Conexao Spotify disponivel apenas no desktop."));
  }

  const api = window.electronAPI;
  const onSpotifyOAuthCallback = api?.onSpotifyOAuthCallback;
  const getPendingSpotifyOAuthCallback = api?.getPendingSpotifyOAuthCallback;
  if (
    !api ||
    typeof onSpotifyOAuthCallback !== "function" ||
    typeof getPendingSpotifyOAuthCallback !== "function"
  ) {
    return Promise.reject(new Error("Integracao de callback do Spotify indisponivel no desktop."));
  }

  const redirectUrl = new URL(redirectUri);

  return new Promise((resolve, reject) => {
    let isDone = false;
    let unsubscribe = (): void => undefined;

    const finish = (callback: () => void): void => {
      if (isDone) {
        return;
      }
      isDone = true;
      window.clearTimeout(timeoutId);
      unsubscribe();
      callback();
    };

    const handleIncomingUrl = (rawUrl: string): void => {
      let callbackUrl: URL;
      try {
        callbackUrl = new URL(String(rawUrl ?? ""));
      } catch {
        return;
      }

      if (!isSameRedirectTarget(callbackUrl, redirectUrl)) {
        return;
      }

      const authError = callbackUrl.searchParams.get("error");
      const authCode = callbackUrl.searchParams.get("code");
      const returnedState = callbackUrl.searchParams.get("state");

      if (!returnedState || returnedState !== expectedState) {
        return;
      }

      finish(() => {
        if (authError) {
          reject(new Error(`Spotify retornou erro de autenticacao: ${authError}.`));
          return;
        }
        if (!authCode) {
          reject(new Error("Nao foi possivel obter o codigo de autorizacao do Spotify."));
          return;
        }
        resolve(authCode);
      });
    };

    const timeoutId = window.setTimeout(() => {
      finish(() => {
        reject(new Error("Tempo esgotado ao conectar com o Spotify. Tente novamente."));
      });
    }, SPOTIFY_POPUP_TIMEOUT_MS);

    unsubscribe = onSpotifyOAuthCallback((payload) => {
      if (!payload?.url) {
        return;
      }
      handleIncomingUrl(payload.url);
    });

    void getPendingSpotifyOAuthCallback({ consume: true })
      .then((pending) => {
        if (!pending?.url) {
          return;
        }
        handleIncomingUrl(pending.url);
      })
      .catch(() => {
        // Ignore pending callback read failures.
      });
  });
}

async function requestSpotifyToken(body: URLSearchParams): Promise<SpotifyTokenResponse> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = (await response.json().catch(() => null)) as SpotifyTokenResponse | null;
  if (!response.ok) {
    const errorText = String(payload?.error_description ?? payload?.error ?? "").trim();
    if (errorText) {
      throw new Error(`Falha na autenticacao Spotify: ${errorText}`);
    }
    throw new Error("Falha na autenticacao Spotify.");
  }

  if (!payload?.access_token || !payload?.expires_in) {
    throw new Error("Resposta de token do Spotify invalida.");
  }

  return payload;
}

function buildTokenState(tokenPayload: SpotifyTokenResponse, previousToken: SpotifyTokenState | null): SpotifyTokenState {
  const expiresInSeconds = clampInt(tokenPayload.expires_in, 3600, 1, 24 * 60 * 60);
  const accessToken = String(tokenPayload.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("Spotify nao retornou access token.");
  }

  const refreshTokenCandidate = String(tokenPayload.refresh_token ?? "").trim();
  const refreshToken = refreshTokenCandidate || previousToken?.refreshToken || "";
  if (!refreshToken) {
    throw new Error("Spotify nao retornou refresh token.");
  }

  return {
    accessToken,
    refreshToken,
    tokenType: String(tokenPayload.token_type ?? previousToken?.tokenType ?? "Bearer").trim() || "Bearer",
    scope: String(tokenPayload.scope ?? previousToken?.scope ?? "").trim(),
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

function isTokenExpired(token: SpotifyTokenState): boolean {
  return token.expiresAt <= Date.now() + SPOTIFY_TOKEN_EXPIRY_SKEW_MS;
}

async function exchangeSpotifyCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
): Promise<SpotifyTokenState> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const payload = await requestSpotifyToken(body);
  return buildTokenState(payload, null);
}

async function refreshSpotifyAccessToken(refreshToken: string, clientId: string): Promise<SpotifyTokenState> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const payload = await requestSpotifyToken(body);
  return buildTokenState(payload, {
    accessToken: "",
    refreshToken,
    tokenType: "Bearer",
    scope: "",
    expiresAt: Date.now(),
  });
}

async function fetchSpotifyProfile(accessToken: string): Promise<SpotifyProfileSnapshot> {
  const response = await fetch(`${SPOTIFY_API_BASE_URL}/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw createSpotifyApiError("spotify_unauthorized", "Token do Spotify expirado.");
    }
    if (response.status === 429) {
      throw createSpotifyApiError("spotify_rate_limited", "Spotify limitou as requisicoes de perfil.", {
        retryAfterMs: readRetryAfterMs(response) ?? undefined,
      });
    }
    throw createSpotifyApiError("spotify_api_error", "Nao foi possivel obter o perfil do Spotify.");
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const displayName = String(payload?.display_name ?? "").trim();
  const accountId = String(payload?.id ?? "").trim();
  const externalUrls = isRecord(payload?.external_urls) ? payload?.external_urls : null;
  const accountUrlRaw = String(externalUrls?.spotify ?? "").trim();
  const accountUrl = accountUrlRaw || (accountId ? `https://open.spotify.com/user/${encodeURIComponent(accountId)}` : "");
  const accountProduct = String(payload?.product ?? "").trim().toLowerCase();

  return {
    accountName: displayName || accountId || SPOTIFY_DEFAULT_ACCOUNT_NAME,
    accountId,
    accountUrl,
    accountProduct,
  };
}

function mapSpotifyPlayback(payload: SpotifyPlayerResponse | null): SpotifyPlaybackState | null {
  if (!payload || !payload.is_playing) {
    return null;
  }

  const item = payload.item;
  if (!item || typeof item !== "object") {
    return null;
  }

  const trackTitle = String(item.name ?? "").trim();
  const artistNames = Array.isArray(item.artists)
    ? item.artists.map((artist) => String(artist?.name ?? "").trim()).filter(Boolean).join(", ")
    : "";
  const images = Array.isArray(item.album?.images) ? item.album.images : [];
  const coverUrl = String(images[0]?.url ?? "").trim();
  const trackUrl = String(item.external_urls?.spotify ?? "").trim();
  const trackId = String(item.id ?? "").trim() || String(item.uri ?? "").trim();
  const durationSeconds = clampInt(item.duration_ms ?? 0, 0, 0, 60 * 60 * 10 * 1000) / 1000;
  const progressSeconds = clampInt(payload.progress_ms ?? 0, 0, 0, durationSeconds * 1000) / 1000;

  if (!trackTitle || !artistNames || durationSeconds <= 0) {
    return null;
  }

  return {
    trackTitle,
    artistNames,
    coverUrl,
    trackUrl,
    trackId,
    durationSeconds: clampInt(durationSeconds, 0, 0, 60 * 60 * 10),
    progressSeconds: clampInt(progressSeconds, 0, 0, 60 * 60 * 10),
    isPlaying: payload.is_playing === true,
    deviceId: String(payload.device?.id ?? "").trim(),
    deviceName: String(payload.device?.name ?? "").trim(),
    shuffleEnabled: payload.shuffle_state === true,
    repeatMode:
      payload.repeat_state === "track" || payload.repeat_state === "context"
        ? payload.repeat_state
        : "off",
  };
}

async function requestPlayback(accessToken: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${SPOTIFY_API_BASE_URL}/me/player`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw createSpotifyApiError("spotify_request_aborted", "Requisicao de playback cancelada.");
    }
    throw error;
  }
}

async function fetchSpotifyPlayback(accessToken: string, signal?: AbortSignal): Promise<SpotifyPlaybackFetchResult> {
  const startedAt = Date.now();
  const response = await requestPlayback(accessToken, signal);
  const latencyMs = Math.max(0, Date.now() - startedAt);

  if (response.status === 204) {
    return {
      playback: null,
      playbackKey: "idle",
      status: "idle",
      latencyMs,
    };
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw createSpotifyApiError("spotify_unauthorized", "Token do Spotify expirado.");
    }
    if (response.status === 429) {
      throw createSpotifyApiError("spotify_rate_limited", "Spotify limitou as requisicoes de reproducao.", {
        retryAfterMs: readRetryAfterMs(response) ?? undefined,
      });
    }
    if (response.status === 403 || response.status === 404) {
      return {
        playback: null,
        playbackKey: `no-device:${response.status}`,
        status: "no_device",
        latencyMs,
      };
    }
    throw createSpotifyApiError("spotify_api_error", `Spotify respondeu com status ${response.status} ao consultar playback.`);
  }

  const payload = (await response.json().catch(() => null)) as SpotifyPlayerResponse | null;
  const playback = mapSpotifyPlayback(payload);
  return {
    playback,
    playbackKey: buildSpotifyPlaybackKey(playback),
    status: playback ? "playing" : "idle",
    latencyMs,
  };
}

async function requestSpotifyAccessTokenViaPopup(clientId: string, redirectUri: string): Promise<SpotifyTokenState> {
  if (typeof window === "undefined") {
    throw new Error("Conexao Spotify disponivel apenas no navegador.");
  }

  if (!window.crypto?.subtle || typeof window.crypto.getRandomValues !== "function") {
    throw new Error("Seu navegador nao suporta os requisitos de seguranca para o login Spotify.");
  }

  const state = generateSecureRandomString(48);
  const codeVerifier = generateSecureRandomString(96);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  // Se o redirect configurado não for http(s), usamos o fallback na raiz do app.
  const fallbackRedirectUri = buildWebFallbackRedirectUri();
  const effectiveRedirectUri =
    redirectUri.startsWith("http") || redirectUri.startsWith("https")
      ? redirectUri
      : fallbackRedirectUri;

  if (!effectiveRedirectUri) {
    throw new Error("Não foi possível resolver o redirect URI do Spotify para este ambiente.");
  }

  const authUrl = buildSpotifyAuthPopupUrl(clientId, effectiveRedirectUri, state, codeChallenge);
  const popup = openSpotifyAuthPopup(authUrl);
  if (!popup) {
    throw new Error("Nao foi possivel abrir a janela de login do Spotify. Verifique o bloqueador de pop-up.");
  }

  const authorizationCode = await waitForSpotifyAuthCode(popup, effectiveRedirectUri, state);
  return exchangeSpotifyCodeForToken(authorizationCode, codeVerifier, clientId, effectiveRedirectUri);
}

async function requestSpotifyAccessTokenViaDeepLink(clientId: string, redirectUri: string): Promise<SpotifyTokenState> {
  if (typeof window === "undefined") {
    throw new Error("Conexao Spotify disponivel apenas no desktop.");
  }

  const api = window.electronAPI;
  const openExternalUrl = api?.openExternalUrl;
  if (!openExternalUrl || !isDesktopSpotifyOAuthBridgeAvailable()) {
    throw new Error("Fluxo de callback Spotify indisponivel no desktop.");
  }

  if (!window.crypto?.subtle || typeof window.crypto.getRandomValues !== "function") {
    throw new Error("Seu ambiente nao suporta os requisitos de seguranca para o login Spotify.");
  }

  const state = generateSecureRandomString(48);
  const codeVerifier = generateSecureRandomString(96);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const authUrl = buildSpotifyAuthPopupUrl(clientId, redirectUri, state, codeChallenge);

  const openResult = await openExternalUrl({ url: authUrl });
  if (!openResult?.opened) {
    throw new Error("Nao foi possivel abrir o navegador para autenticar no Spotify.");
  }

  const authorizationCode = await waitForSpotifyAuthCodeFromDeepLink(redirectUri, state);
  return exchangeSpotifyCodeForToken(authorizationCode, codeVerifier, clientId, redirectUri);
}

async function getFreshSpotifyToken(connection: SpotifyConnectionState, clientId: string): Promise<SpotifyTokenState> {
  const currentToken = connection.token;
  if (!currentToken) {
    throw new Error("Conta Spotify conectada sem token valido.");
  }

  if (!isTokenExpired(currentToken)) {
    return currentToken;
  }

  return refreshSpotifyAccessToken(currentToken.refreshToken, clientId);
}

function startSpotifyPolling(userId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const existing = spotifyPollers.get(userId);
  if (existing) {
    existing.subscribers += 1;
    return;
  }

  const poller: SpotifyPollerState = {
    subscribers: 1,
    timerId: null,
    syncing: false,
    syncAbortController: null,
    rateLimitedUntil: readSpotifyRateLimitUntil(userId),
    rateLimitAttempt: 0,
    burstUntil: 0,
    degradedUntil: 0,
    lastSyncStartedAt: 0,
    requestTimestamps: [],
    lastPlaybackKey: buildSpotifyPlaybackKey(readSpotifyConnection(userId).playback),
    hasLoggedRateLimit: false,
    lastLogSignature: null,
    onWindowFocus: null,
    onVisibilityChange: null,
  };

  const clearScheduledSync = (): void => {
    if (poller.timerId !== null) {
      window.clearTimeout(poller.timerId);
      poller.timerId = null;
    }
  };

  const markPollerDegraded = (reason: string, windowMs: number): void => {
    poller.degradedUntil = Math.max(poller.degradedUntil, Date.now() + windowMs);
    if (poller.lastLogSignature === `degraded:${reason}`) {
      return;
    }
    poller.lastLogSignature = `degraded:${reason}`;
    logSpotifyPolling("info", "degraded", {
      userId,
      reason,
      durationMs: windowMs,
    });
  };

  const resolveNextSyncDelayMs = (): number => {
    const nowMs = Date.now();
    const isDegraded = nowMs < poller.degradedUntil;
    if (Date.now() < poller.burstUntil) {
      return SPOTIFY_PLAYBACK_TRANSITION_BURST_INTERVAL_MS;
    }

    const connection = readSpotifyConnection(userId);
    if (!connection.connected || !connection.token) {
      return SPOTIFY_PLAYBACK_DISCONNECTED_SYNC_INTERVAL_MS;
    }
    if (connection.playback && isSpotifyPlaybackStillActive(connection.playback, connection.updatedAt, nowMs)) {
      return isDegraded ? SPOTIFY_PLAYBACK_ACTIVE_DEGRADED_SYNC_INTERVAL_MS : SPOTIFY_PLAYBACK_ACTIVE_SYNC_INTERVAL_MS;
    }
    return isDegraded ? SPOTIFY_PLAYBACK_IDLE_DEGRADED_SYNC_INTERVAL_MS : SPOTIFY_PLAYBACK_IDLE_SYNC_INTERVAL_MS;
  };

  const scheduleNextSync = (delayMs?: number): void => {
    if (spotifyPollers.get(userId) !== poller || poller.subscribers <= 0) {
      return;
    }

    clearScheduledSync();
    const nowMs = Date.now();
    // FIX: rate limit
    // Always respect both the local limiter and any active Spotify cooldown before scheduling.
    const nextDelayMs = Math.max(
      250,
      Math.round(delayMs ?? resolveNextSyncDelayMs()),
      getPollerRateWindowDelayMs(poller, nowMs),
      poller.rateLimitedUntil > nowMs ? poller.rateLimitedUntil - nowMs : 0,
    );
    poller.timerId = window.setTimeout(() => {
      poller.timerId = null;
      void runSync();
    }, nextDelayMs);
  };

  const requestImmediateSync = (): void => {
    const nowMs = Date.now();
    const elapsedSinceLastSync = nowMs - poller.lastSyncStartedAt;
    const interactiveGapMs = Math.max(SPOTIFY_INTERACTIVE_MIN_SYNC_GAP_MS, resolveNextSyncDelayMs());
    if (
      poller.syncing ||
      nowMs < poller.rateLimitedUntil ||
      nowMs < poller.degradedUntil ||
      elapsedSinceLastSync < interactiveGapMs
    ) {
      scheduleNextSync(Math.max(250, interactiveGapMs - elapsedSinceLastSync));
      return;
    }

    clearScheduledSync();
    void runSync();
  };

  const runSync = async (): Promise<void> => {
    // FIX: prevent overlap
    // One poller, one in-flight request. All re-entry paths bail out here.
    if (poller.syncing || spotifyPollers.get(userId) !== poller || poller.subscribers <= 0) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs < poller.rateLimitedUntil) {
      scheduleNextSync(poller.rateLimitedUntil - nowMs);
      return;
    }

    const rateWindowDelayMs = getPollerRateWindowDelayMs(poller, nowMs);
    if (rateWindowDelayMs > 0) {
      markPollerDegraded("local-rate-window", SPOTIFY_DEGRADED_MODE_WINDOW_MS);
      scheduleNextSync(rateWindowDelayMs);
      return;
    }

    poller.syncing = true;
    poller.lastSyncStartedAt = nowMs;
    reservePollerRequestSlot(poller, nowMs);
    poller.syncAbortController = new AbortController();
    let nextDelayMs: number | null = null;

    try {
      const previousConnection = readSpotifyConnection(userId);
      const syncResult = await syncSpotifyConnection(userId, {
        signal: poller.syncAbortController.signal,
      });
      poller.rateLimitedUntil = 0;
      poller.rateLimitAttempt = 0;
      writeSpotifyRateLimitUntil(userId, 0);
      if (poller.hasLoggedRateLimit) {
        logSpotifyPolling("info", "recovered", {
          userId,
        });
      }
      poller.hasLoggedRateLimit = false;
      poller.lastLogSignature = null;

      if (syncResult.latencyMs >= SPOTIFY_HIGH_LATENCY_THRESHOLD_MS) {
        markPollerDegraded("high-latency", SPOTIFY_DEGRADED_MODE_WINDOW_MS);
      }

      // FIX: dedupe fingerprint
      // Only burst on structural playback changes. Normal progress advance is interpolated locally.
      const didPlaybackTransition =
        previousConnection.connected !== syncResult.connection.connected ||
        previousConnection.showAsStatus !== syncResult.connection.showAsStatus ||
        hasRelevantPlaybackTransition(previousConnection.playback, syncResult.connection.playback);

      poller.lastPlaybackKey = syncResult.playbackKey;

      if (didPlaybackTransition) {
        poller.burstUntil = Date.now() + SPOTIFY_PLAYBACK_TRANSITION_BURST_WINDOW_MS;
        nextDelayMs = SPOTIFY_PLAYBACK_TRANSITION_CONFIRM_DELAY_MS;
      } else if (syncResult.playbackStatus !== "playing") {
        poller.burstUntil = 0;
      }
    } catch (error) {
      if (isSpotifyApiError(error) && error.code === "spotify_request_aborted") {
        return;
      }

      if (isSpotifyApiError(error) && error.code === "spotify_rate_limited") {
        const retryAfterMs = typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
          ? Math.round(error.retryAfterMs)
          : 0;
        const computedBackoffMs = computeBackoffWithJitterMs(poller.rateLimitAttempt);
        // FIX: rate limit
        // Retry-After is respected strictly on the first 429. Repeated 429s escalate through local exponential backoff.
        const cooldownMs = retryAfterMs > 0
          ? (poller.rateLimitAttempt > 0 ? Math.max(retryAfterMs, computedBackoffMs) : retryAfterMs)
          : Math.max(computedBackoffMs, SPOTIFY_RATE_LIMIT_MIN_COOLDOWN_MS);
        poller.rateLimitedUntil = Date.now() + cooldownMs;
        poller.rateLimitAttempt = Math.min(poller.rateLimitAttempt + 1, 16);
        poller.burstUntil = 0;
        poller.degradedUntil = Math.max(poller.degradedUntil, Date.now() + SPOTIFY_DEGRADED_MODE_WINDOW_MS);
        writeSpotifyRateLimitUntil(userId, poller.rateLimitedUntil);
        if (!poller.hasLoggedRateLimit) {
          logSpotifyPolling("warn", "rate-limited", {
            userId,
            retryAfterMs: retryAfterMs || undefined,
            cooldownMs,
          });
        }
        poller.hasLoggedRateLimit = true;
        nextDelayMs = cooldownMs;
      } else if (isSpotifyApiError(error) && error.code === "spotify_api_error") {
        const signature = `api:${error.message}`;
        if (poller.lastLogSignature !== signature) {
          poller.lastLogSignature = signature;
          logSpotifyPolling("warn", "api-error", {
            userId,
            message: error.message,
          });
        }
      } else if (!isAbortError(error)) {
        const signature = `unexpected:${error instanceof Error ? error.message : String(error ?? "unknown")}`;
        if (poller.lastLogSignature !== signature) {
          poller.lastLogSignature = signature;
          logSpotifyPolling("error", "unexpected-error", {
            userId,
            message: error instanceof Error ? error.message : String(error ?? "unknown"),
          });
        }
      }
    } finally {
      poller.syncAbortController = null;
      poller.syncing = false;
      if (spotifyPollers.get(userId) === poller && poller.subscribers > 0 && poller.timerId === null) {
        scheduleNextSync(nextDelayMs ?? undefined);
      }
    }
  };

  const handleWindowFocus = (): void => {
    requestImmediateSync();
  };
  const handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      return;
    }
    requestImmediateSync();
  };
  poller.onWindowFocus = handleWindowFocus;
  poller.onVisibilityChange = handleVisibilityChange;
  window.addEventListener("focus", handleWindowFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  spotifyPollers.set(userId, poller);
  void runSync();
}

function stopSpotifyPolling(userId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const existing = spotifyPollers.get(userId);
  if (!existing) {
    return;
  }

  existing.subscribers -= 1;
  if (existing.subscribers > 0) {
    return;
  }

  if (existing.timerId !== null) {
    window.clearTimeout(existing.timerId);
  }
  existing.syncAbortController?.abort();
  if (existing.onWindowFocus) {
    window.removeEventListener("focus", existing.onWindowFocus);
  }
  if (existing.onVisibilityChange) {
    document.removeEventListener("visibilitychange", existing.onVisibilityChange);
  }
  spotifyPollers.delete(userId);
}

export function isSpotifyOAuthConfigured(): boolean {
  return Boolean(getSpotifyRedirectUri());
}

export function getSpotifyOAuthRedirectUri(): string {
  return getSpotifyRedirectUri();
}

export function buildSpotifyConnectionStorageKey(userId: string | null | undefined): string {
  return `${SPOTIFY_CONNECTION_STORAGE_KEY_PREFIX}${resolveUserScope(userId)}`;
}

export function createDefaultSpotifyConnection(): SpotifyConnectionState {
  return normalizeConnection({ connected: false, updatedAt: new Date().toISOString() });
}

export function isSpotifyConnectionPremium(connection: SpotifyConnectionState | null | undefined): boolean {
  return String(connection?.accountProduct ?? "").trim().toLowerCase() === "premium";
}

export function readSpotifyConnection(userId: string | null | undefined): SpotifyConnectionState {
  if (typeof window === "undefined") {
    return createDefaultSpotifyConnection();
  }

  if (isDesktopSpotifyPresenceBridgeAvailable()) {
    bindDesktopSpotifyPresenceUpdates();
    void requestDesktopSpotifyPresenceState(resolveUserScope(userId));
  }

  try {
    const scopedUserId = resolveUserScope(userId);
    const storageKey = buildSpotifyConnectionStorageKey(scopedUserId);
    let raw = window.localStorage.getItem(storageKey);

    // Migra conexões salvas como "guest" quando o uid real fica disponível.
    if (!raw && scopedUserId !== FALLBACK_USER_SCOPE) {
      const guestKey = buildSpotifyConnectionStorageKey(FALLBACK_USER_SCOPE);
      const guestRaw = window.localStorage.getItem(guestKey);
      if (guestRaw) {
        raw = guestRaw;
        try {
          window.localStorage.setItem(storageKey, guestRaw);
          window.localStorage.removeItem(guestKey);
        } catch {
          // ignore migração
        }
      }
    }

    if (!raw) {
      return createDefaultSpotifyConnection();
    }

    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeConnection(parsed);

    // Se o playback estiver muito antigo, limpamos para evitar mostrar faixa obsoleta ao reabrir o app.
    if (normalized.playback && normalized.playback.updatedAt) {
      const updatedAtMs = new Date(normalized.playback.updatedAt).getTime();
      const ageMs = Date.now() - updatedAtMs;
      const STALE_PLAYBACK_MS = 2 * 60 * 1000; // 2 minutos
      if (!Number.isFinite(updatedAtMs) || ageMs > STALE_PLAYBACK_MS) {
        normalized.playback = null;
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(normalized));
        } catch {
          // ignore persist error
        }
      }
    }

    // Persist migration from old mock payloads that had no OAuth token.
    if (isRecord(parsed) && Boolean(parsed.connected) && !normalized.connected) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(normalized));
      } catch {
        // Ignore migration persistence errors.
      }
    }

    return normalized;
  } catch {
    return createDefaultSpotifyConnection();
  }
}

export function writeSpotifyConnection(
  userId: string | null | undefined,
  nextConnection: SpotifyConnectionState,
  options: { suppressDesktopSync?: boolean } = {},
): SpotifyConnectionState {
  const normalized = normalizeConnection(nextConnection);

  if (typeof window === "undefined") {
    return normalized;
  }

  const scopedUserId = resolveUserScope(userId);
  try {
    window.localStorage.setItem(buildSpotifyConnectionStorageKey(scopedUserId), JSON.stringify(normalized));
    if (scopedUserId !== FALLBACK_USER_SCOPE) {
      // limpa o guest antigo para evitar leituras inconsistentes
      window.localStorage.removeItem(buildSpotifyConnectionStorageKey(FALLBACK_USER_SCOPE));
    }
  } catch {
    // Ignore persistence failures.
  }

  window.dispatchEvent(
    new CustomEvent<SpotifyConnectionUpdatedDetail>(SPOTIFY_CONNECTION_UPDATED_EVENT, {
      detail: {
        userId: scopedUserId,
        connection: normalized,
      },
    }),
  );

  if (
    !options.suppressDesktopSync &&
    isDesktopSpotifyPresenceBridgeAvailable() &&
    typeof window.electronAPI?.spotifyPresenceSetVisibility === "function"
  ) {
    const scope = resolveUserScope(userId);
    const syncVisibility = window.electronAPI.spotifyPresenceSetVisibility;
    // Keep visibility preferences in sync when local-only updates happen.
    void syncVisibility({
      scope,
      showOnProfile: normalized.showOnProfile,
      showAsStatus: normalized.showAsStatus,
    }).catch(() => undefined);
  }

  return normalized;
}

function hasMatchingSpotifyIdentity(
  left: SpotifyConnectionState,
  right: SpotifyConnectionState,
): boolean {
  const leftAccountId = String(left.accountId ?? "").trim();
  const rightAccountId = String(right.accountId ?? "").trim();
  if (leftAccountId && rightAccountId) {
    return leftAccountId === rightAccountId;
  }

  const leftAccountUrl = String(left.accountUrl ?? "").trim();
  const rightAccountUrl = String(right.accountUrl ?? "").trim();
  if (leftAccountUrl && rightAccountUrl) {
    return leftAccountUrl === rightAccountUrl;
  }

  const leftAccountName = String(left.accountName ?? "").trim().toLowerCase();
  const rightAccountName = String(right.accountName ?? "").trim().toLowerCase();
  return Boolean(leftAccountName) && leftAccountName === rightAccountName;
}

function readStoredSpotifyConnectionEntries(): Array<{ scope: string; connection: SpotifyConnectionState }> {
  if (typeof window === "undefined") {
    return [];
  }

  const entries: Array<{ scope: string; connection: SpotifyConnectionState }> = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = String(window.localStorage.key(index) ?? "").trim();
      if (!storageKey.startsWith(SPOTIFY_CONNECTION_STORAGE_KEY_PREFIX)) {
        continue;
      }

      const scope = storageKey.slice(SPOTIFY_CONNECTION_STORAGE_KEY_PREFIX.length).trim();
      if (!scope) {
        continue;
      }

      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        continue;
      }

      const connection = normalizeConnection(JSON.parse(raw) as unknown);
      entries.push({ scope, connection });
    }
  } catch {
    return entries;
  }

  return entries;
}

function findMatchingOAuthConnectionAcrossScopes(
  targetScope: string,
  targetIdentity: SpotifyConnectionState,
): SpotifyConnectionState | null {
  const candidates = readStoredSpotifyConnectionEntries()
    .filter(({ scope, connection }) =>
      scope !== targetScope &&
      connection.connected &&
      (Boolean(connection.token) || connection.authState === "oauth") &&
      hasMatchingSpotifyIdentity(connection, targetIdentity)
    )
    .sort((left, right) => Date.parse(right.connection.updatedAt) - Date.parse(left.connection.updatedAt));

  return candidates[0]?.connection ?? null;
}

export function serializeSpotifyConnectionForProfile(
  connection: SpotifyConnectionState | null | undefined,
): PersistedSpotifyConnectionState | null {
  const normalized = normalizeConnection(connection);
  if (!normalized.connected) {
    return null;
  }

  return {
    v: 1,
    provider: "spotify",
    authState: "detached",
    connected: true,
    accountName: normalized.accountName || SPOTIFY_DEFAULT_ACCOUNT_NAME,
    accountId: normalized.accountId,
    accountUrl: normalized.accountUrl,
    showOnProfile: normalized.showOnProfile,
    showAsStatus: normalized.showAsStatus,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  };
}

export function hydrateSpotifyConnectionFromProfile(
  userId: string | null | undefined,
  persistedConnection: unknown,
): SpotifyConnectionState {
  const scopedUserId = resolveUserScope(userId);
  const currentConnection = readSpotifyConnection(scopedUserId);

  if (!persistedConnection) {
    if (!currentConnection.connected || currentConnection.authState === "oauth" || currentConnection.token) {
      return currentConnection;
    }
    return writeSpotifyConnection(scopedUserId, createDefaultSpotifyConnection());
  }

  const normalizedPersistedConnection = normalizeConnection({
    ...(isRecord(persistedConnection) ? persistedConnection : {}),
    connected: true,
    authState: "detached",
  });

  if (!normalizedPersistedConnection.connected) {
    if (!currentConnection.connected) {
      return currentConnection;
    }
    return writeSpotifyConnection(scopedUserId, createDefaultSpotifyConnection());
  }

  const runtimeSourceConnection =
    currentConnection.connected &&
      (Boolean(currentConnection.token) || currentConnection.authState === "oauth" || isDesktopSpotifyPresenceBridgeAvailable()) &&
      hasMatchingSpotifyIdentity(currentConnection, normalizedPersistedConnection)
      ? currentConnection
      : findMatchingOAuthConnectionAcrossScopes(scopedUserId, normalizedPersistedConnection);

  const runtimeHasLiveOAuth = Boolean(
    runtimeSourceConnection &&
      (runtimeSourceConnection.token || runtimeSourceConnection.authState === "oauth"),
  );
  const shouldPreserveLocalRuntime = Boolean(
    runtimeSourceConnection?.connected && runtimeHasLiveOAuth,
  );

  const nextConnection = shouldPreserveLocalRuntime
    ? normalizeConnection({
        ...normalizedPersistedConnection,
        authState: runtimeSourceConnection?.authState ?? normalizedPersistedConnection.authState,
        playback: runtimeSourceConnection?.playback ?? null,
        token: runtimeSourceConnection?.token ?? null,
        updatedAt: runtimeSourceConnection?.updatedAt ?? normalizedPersistedConnection.updatedAt,
      })
    : normalizedPersistedConnection;

  if (buildSpotifyConnectionFingerprint(currentConnection) === buildSpotifyConnectionFingerprint(nextConnection)) {
    return currentConnection;
  }

  return writeSpotifyConnection(scopedUserId, nextConnection);
}

function clearSpotifyPlaybackState(
  userId: string,
  connection: SpotifyConnectionState,
  overrides: Partial<SpotifyConnectionState> = {},
): SpotifyConnectionState {
  return writeSpotifyConnection(
    userId,
    normalizeConnection({
      ...connection,
      ...overrides,
      connected: true,
      playback: null,
      updatedAt: new Date().toISOString(),
    }),
  );
}

function persistSpotifyRateLimitedState(
  userId: string,
  connection: SpotifyConnectionState,
  overrides: Partial<SpotifyConnectionState> = {},
): SpotifyConnectionState {
  if (!connection.playback || !isSpotifyPlaybackStillActive(connection.playback, connection.updatedAt)) {
    return clearSpotifyPlaybackState(userId, connection, overrides);
  }

  return writeSpotifyConnection(
    userId,
    normalizeConnection({
      ...connection,
      ...overrides,
      connected: true,
    }),
  );
}

export async function connectSpotifyOAuth(userId: string | null | undefined): Promise<SpotifyConnectionState> {
  const scopedUserId = resolveUserScope(userId);
  const { redirectUri: fallbackRedirectUri } = ensureSpotifyOAuthConfig();
  const currentConnection = readSpotifyConnection(scopedUserId);
  const showOnProfile = currentConnection.connected ? currentConnection.showOnProfile : true;
  const showAsStatus = currentConnection.connected ? currentConnection.showAsStatus : true;
  const useDesktopDeepLink = isDesktopSpotifyOAuthBridgeAvailable();

  const beginResponse = await invokeSpotifyConnectionsEdge<
    {
      action: "begin_oauth";
      clientContext: "web" | "desktop";
    },
    SpotifyEdgeBeginOauthResponse
  >({
    action: "begin_oauth",
    clientContext: useDesktopDeepLink ? "desktop" : "web",
  });

  const begin = parseSpotifyEdgeBeginResponse(beginResponse);
  const effectiveRedirectUri = begin.redirectUri || fallbackRedirectUri;

  let authorizationCode = "";
  if (useDesktopDeepLink) {
    if (typeof window === "undefined" || typeof window.electronAPI?.openExternalUrl !== "function") {
      throw new Error("Integracao de navegador externo indisponivel no desktop.");
    }
    await window.electronAPI.openExternalUrl({ url: begin.authorizeUrl });
    authorizationCode = await waitForSpotifyAuthCodeFromDeepLink("messly://callback", begin.state);
  } else {
    const popup = openSpotifyAuthPopup(begin.authorizeUrl);
    if (!popup) {
      throw new Error("Nao foi possivel abrir a janela de autenticacao do Spotify.");
    }
    authorizationCode = await waitForSpotifyAuthCode(popup, effectiveRedirectUri, begin.state);
  }

  const completedResponse = await invokeSpotifyConnectionsEdge<
    {
      action: "complete_oauth";
      code: string;
      state: string;
      showOnProfile: boolean;
      showAsStatus: boolean;
    },
    SpotifyEdgeConnectionResponse
  >({
    action: "complete_oauth",
    code: authorizationCode,
    state: begin.state,
    showOnProfile,
    showAsStatus,
  });

  const nextConnection = normalizeSpotifyEdgeConnection(completedResponse?.connection ?? null);
  return writeSpotifyConnection(scopedUserId, nextConnection);
}

export async function disconnectSpotifyOAuth(userId: string | null | undefined): Promise<SpotifyConnectionState> {
  const scopedUserId = resolveUserScope(userId);
  const response = await invokeSpotifyConnectionsEdge<
    {
      action: "disconnect";
    },
    SpotifyEdgeConnectionResponse
  >({
    action: "disconnect",
  });
  const nextConnection = normalizeSpotifyEdgeConnection(response?.connection ?? createDefaultSpotifyConnection());
  return writeSpotifyConnection(scopedUserId, nextConnection);
}

export async function setSpotifyConnectionVisibility(
  userId: string | null | undefined,
  patch: {
    showOnProfile?: boolean;
    showAsStatus?: boolean;
  },
): Promise<SpotifyConnectionState> {
  const scopedUserId = resolveUserScope(userId);
  const currentConnection = readSpotifyConnection(scopedUserId);
  if (!currentConnection.connected) {
    return currentConnection;
  }
  const response = await invokeSpotifyConnectionsEdge<
    {
      action: "set_visibility";
      showOnProfile?: boolean;
      showAsStatus?: boolean;
    },
    SpotifyEdgeConnectionResponse
  >({
    action: "set_visibility",
    ...(typeof patch.showOnProfile === "boolean" ? { showOnProfile: patch.showOnProfile } : {}),
    ...(typeof patch.showAsStatus === "boolean" ? { showAsStatus: patch.showAsStatus } : {}),
  });

  const nextConnection = normalizeSpotifyEdgeConnection(response?.connection ?? currentConnection);
  return writeSpotifyConnection(scopedUserId, nextConnection);
}

export async function syncSpotifyConnection(
  userId: string | null | undefined,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<SpotifySyncResult> {
  const scopedUserId = resolveUserScope(userId);
  if (isDesktopSpotifyPresenceBridgeAvailable() && typeof window !== "undefined") {
    bindDesktopSpotifyPresenceUpdates();
    const pollOnceInMain = window.electronAPI?.spotifyPresencePollOnce;
    const getStateInMain = window.electronAPI?.spotifyPresenceGetState;
    const before = readSpotifyConnection(scopedUserId);
    if (typeof pollOnceInMain === "function") {
      try {
        const polledConnection = await pollOnceInMain({ scope: scopedUserId });
        const next = applyDesktopConnectionSnapshot(scopedUserId, polledConnection, {
          suppressDesktopSync: true,
        });
        return {
          connection: next,
          playbackKey: buildSpotifyPlaybackKey(next.playback),
          playbackStatus: next.playback?.isPlaying ? "playing" : next.playback ? "idle" : "no_device",
          latencyMs: 0,
          didConnectionChange: buildSpotifyConnectionFingerprint(before) !== buildSpotifyConnectionFingerprint(next),
        };
      } catch {
        // Fallback to current main snapshot.
      }
    }
    if (typeof getStateInMain === "function") {
      const state = await getStateInMain({ scope: scopedUserId });
      const next = applyDesktopConnectionSnapshot(scopedUserId, state?.connection ?? null, {
        suppressDesktopSync: true,
      });
      return {
        connection: next,
        playbackKey: buildSpotifyPlaybackKey(next.playback),
        playbackStatus: next.playback?.isPlaying ? "playing" : next.playback ? "idle" : "no_device",
        latencyMs: 0,
        didConnectionChange: buildSpotifyConnectionFingerprint(before) !== buildSpotifyConnectionFingerprint(next),
      };
    }
    const current = readSpotifyConnection(scopedUserId);
    return {
      connection: current,
      playbackKey: buildSpotifyPlaybackKey(current.playback),
      playbackStatus: current.playback?.isPlaying ? "playing" : current.playback ? "idle" : "no_device",
      latencyMs: 0,
      didConnectionChange: false,
    };
  }

  const rateLimitedUntil = readSpotifyRateLimitUntil(scopedUserId);
  const currentConnection = readSpotifyConnection(scopedUserId);

  if (rateLimitedUntil > Date.now()) {
    if (
      currentConnection.connected &&
      currentConnection.playback &&
      !isSpotifyPlaybackStillActive(currentConnection.playback, currentConnection.updatedAt)
    ) {
      return {
        connection: clearSpotifyPlaybackState(scopedUserId, currentConnection),
        playbackKey: "idle",
        playbackStatus: "idle",
        latencyMs: 0,
        didConnectionChange: true,
      };
    }
    throw createSpotifyApiError("spotify_rate_limited", "Spotify em cooldown temporario.", {
      retryAfterMs: rateLimitedUntil - Date.now(),
    });
  }

  try {
    const response = await invokeSpotifyConnectionsEdge<
      {
        action: "sync";
      },
      SpotifyEdgeSyncResponse
    >(
      {
        action: "sync",
      },
      {
        signal: options.signal,
        timeoutMs: 12_000,
      },
    );

    const nextConnection = normalizeSpotifyEdgeConnection(response?.connection ?? currentConnection);
    const didConnectionChange =
      buildSpotifyConnectionFingerprint(currentConnection) !== buildSpotifyConnectionFingerprint(nextConnection);
    const persistedConnection = didConnectionChange
      ? writeSpotifyConnection(scopedUserId, nextConnection)
      : currentConnection;

    return {
      connection: persistedConnection,
      playbackKey: buildSpotifyPlaybackKey(persistedConnection.playback),
      playbackStatus: persistedConnection.playback?.isPlaying ? "playing" : persistedConnection.playback ? "idle" : "no_device",
      latencyMs: 0,
      didConnectionChange,
    };
  } catch (error) {
    if (isSpotifyApiError(error) && error.code === "spotify_rate_limited") {
      const persistedConnection = persistSpotifyRateLimitedState(scopedUserId, currentConnection);
      throw Object.assign(error, {
        persistedConnection,
      });
    }

    if (isSpotifyApiError(error) && error.code === "spotify_unauthorized") {
      const disconnected = writeSpotifyConnection(scopedUserId, createDefaultSpotifyConnection());
      return {
        connection: disconnected,
        playbackKey: "idle",
        playbackStatus: "idle",
        latencyMs: 0,
        didConnectionChange: true,
      };
    }

    throw error;
  }
}

export function subscribeSpotifyConnection(
  userId: string | null | undefined,
  listener: (connection: SpotifyConnectionState) => void,
  options: {
    enablePolling?: boolean;
  } = {},
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const scopedUserId = resolveUserScope(userId);
  const storageKey = buildSpotifyConnectionStorageKey(scopedUserId);
  const shouldEnablePolling = options.enablePolling === true;
  const useDesktopBridge = isDesktopSpotifyPresenceBridgeAvailable();

  if (useDesktopBridge) {
    bindDesktopSpotifyPresenceUpdates();
    void requestDesktopSpotifyPresenceState(scopedUserId);
  }

  if (shouldEnablePolling && !useDesktopBridge) {
    startSpotifyPolling(scopedUserId);
  }
  if (shouldEnablePolling && useDesktopBridge) {
    const runtime = getSpotifyDesktopBridgeRuntimeState();
    const currentCount = runtime.pollingSubscribersByScope.get(scopedUserId) ?? 0;
    runtime.pollingSubscribersByScope.set(scopedUserId, currentCount + 1);
    const startInMain = window.electronAPI?.spotifyPresenceStart;
    if (typeof startInMain === "function") {
      void startInMain({ scope: scopedUserId })
        .then((response) => {
          applyDesktopConnectionSnapshot(scopedUserId, response?.connection ?? null, {
            suppressDesktopSync: true,
          });
          runtime.scopeSnapshots.set(scopedUserId, {
            fetchedAt: Date.now(),
            requestedAt: Date.now(),
          });
        })
        .catch(() => undefined);
    }
  }

  const handleCustomEvent = (event: Event): void => {
    const detail = (event as CustomEvent<SpotifyConnectionUpdatedDetail>).detail;
    if (!detail || resolveUserScope(detail.userId) !== scopedUserId) {
      return;
    }
    listener(normalizeConnection(detail.connection));
  };

  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== storageKey) {
      return;
    }
    listener(readSpotifyConnection(scopedUserId));
  };

  window.addEventListener(SPOTIFY_CONNECTION_UPDATED_EVENT, handleCustomEvent as EventListener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(SPOTIFY_CONNECTION_UPDATED_EVENT, handleCustomEvent as EventListener);
    window.removeEventListener("storage", handleStorage);
    if (shouldEnablePolling && !useDesktopBridge) {
      stopSpotifyPolling(scopedUserId);
    }
    if (shouldEnablePolling && useDesktopBridge) {
      const runtime = getSpotifyDesktopBridgeRuntimeState();
      const currentCount = runtime.pollingSubscribersByScope.get(scopedUserId) ?? 0;
      const nextCount = Math.max(0, currentCount - 1);
      if (nextCount === 0) {
        runtime.pollingSubscribersByScope.delete(scopedUserId);
        const stopInMain = window.electronAPI?.spotifyPresenceStop;
        if (typeof stopInMain === "function") {
          void stopInMain({ scope: scopedUserId }).catch(() => undefined);
        }
      } else {
        runtime.pollingSubscribersByScope.set(scopedUserId, nextCount);
      }
    }
  };
}

export function resolveSpotifyPlaybackProgressSeconds(
  playback: SpotifyPlaybackState | null | undefined,
  updatedAt: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!playback) {
    return 0;
  }

  const durationSecondsRaw = Number(playback.durationSeconds ?? 0);
  if (!Number.isFinite(durationSecondsRaw) || durationSecondsRaw <= 0) {
    return 0;
  }
  const durationSeconds = Math.max(0, durationSecondsRaw);

  const baseProgressRaw = Number(playback.progressSeconds ?? 0);
  const baseProgressSeconds = Number.isFinite(baseProgressRaw)
    ? Math.max(0, Math.min(durationSeconds, baseProgressRaw))
    : 0;

  let updatedAtMs: number | null = null;
  if (typeof updatedAt === "number") {
    updatedAtMs = Number.isFinite(updatedAt) ? updatedAt : null;
  } else if (updatedAt instanceof Date) {
    const candidate = updatedAt.getTime();
    updatedAtMs = Number.isFinite(candidate) ? candidate : null;
  } else if (typeof updatedAt === "string") {
    const candidate = Date.parse(updatedAt);
    updatedAtMs = Number.isFinite(candidate) ? candidate : null;
  }

  if (updatedAtMs == null) {
    return baseProgressSeconds;
  }

  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const elapsedSeconds = Math.max(0, (safeNowMs - updatedAtMs) / 1000);
  return Math.max(0, Math.min(durationSeconds, baseProgressSeconds + elapsedSeconds));
}

export function isSpotifyPlaybackStillActive(
  playback: SpotifyPlaybackState | null | undefined,
  updatedAt: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!playback) {
    return false;
  }

  let updatedAtMs: number | null = null;
  if (typeof updatedAt === "number") {
    updatedAtMs = Number.isFinite(updatedAt) ? updatedAt : null;
  } else if (updatedAt instanceof Date) {
    const candidate = updatedAt.getTime();
    updatedAtMs = Number.isFinite(candidate) ? candidate : null;
  } else if (typeof updatedAt === "string") {
    const candidate = Date.parse(updatedAt);
    updatedAtMs = Number.isFinite(candidate) ? candidate : null;
  }

  if (updatedAtMs == null) {
    return false;
  }

  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const durationSeconds = Math.max(0, Number(playback.durationSeconds ?? 0));
  const progressSeconds = Math.max(
    0,
    Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, Number(playback.progressSeconds ?? 0)),
  );

  const expiresAtMs = durationSeconds > 0
    ? updatedAtMs + Math.max(0, durationSeconds - progressSeconds) * 1000 + SPOTIFY_PLAYBACK_END_GRACE_MS
    : updatedAtMs + SPOTIFY_PLAYBACK_NO_DURATION_STALE_MS;

  return safeNowMs <= expiresAtMs;
}

export function formatSpotifyPlaybackTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}
