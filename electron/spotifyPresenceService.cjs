const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_OAUTH_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
];
const SPOTIFY_OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
const SPOTIFY_TOKEN_EXPIRY_SKEW_MS = 60_000;
const SPOTIFY_POLL_PLAYING_MIN_MS = 3_000;
const SPOTIFY_POLL_PLAYING_MAX_MS = 5_000;
const SPOTIFY_POLL_PAUSED_MIN_MS = 10_000;
const SPOTIFY_POLL_PAUSED_MAX_MS = 15_000;
const SPOTIFY_POLL_OFFLINE_MIN_MS = 20_000;
const SPOTIFY_POLL_OFFLINE_MAX_MS = 60_000;
const SPOTIFY_REQUEST_TIMEOUT_MS = 12_000;
const SPOTIFY_MAX_BACKOFF_MS = 60_000;
const SPOTIFY_BASE_BACKOFF_MS = 2_000;
const SPOTIFY_STORAGE_FILE = "spotify-presence-state.json";
const SPOTIFY_BROADCAST_CHANNEL = "spotify:presence:update";
const FALLBACK_SCOPE = "guest";
const DEFAULT_SPOTIFY_ACCOUNT_NAME = "Spotify";

function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}

function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function resolveScope(rawScope) {
  const scope = normalizeString(rawScope);
  return scope || FALLBACK_SCOPE;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowIso() {
  return new Date().toISOString();
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createRandomVerifier(size = 96) {
  return toBase64Url(crypto.randomBytes(size)).slice(0, 128);
}

function createCodeChallenge(verifier) {
  return toBase64Url(crypto.createHash("sha256").update(verifier).digest());
}

function toInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : fallback;
}

function parseRetryAfterMs(headers) {
  const raw = String(headers?.get?.("retry-after") ?? "").trim();
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

function pickInterval(min, max) {
  const low = Math.max(250, Math.round(min));
  const high = Math.max(low, Math.round(max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function normalizeToken(raw, currentRefreshToken = "") {
  const casted = isRecord(raw) ? raw : {};
  const accessToken = normalizeString(casted.access_token);
  const refreshToken =
    normalizeString(casted.refresh_token) ||
    normalizeString(casted.refreshToken) ||
    normalizeString(currentRefreshToken);
  const tokenType = normalizeString(casted.token_type, "Bearer") || "Bearer";
  const scope = normalizeString(casted.scope);
  const expiresIn = clamp(toInt(casted.expires_in, 3600), 60, 60 * 60 * 24);
  if (!accessToken || !refreshToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    tokenType,
    scope,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function buildDefaultConnection() {
  return {
    v: 1,
    provider: "spotify",
    authState: "detached",
    connected: false,
    accountName: "",
    accountId: "",
    accountUrl: "",
    accountProduct: "",
    showOnProfile: false,
    showAsStatus: false,
    playback: null,
    token: null,
    updatedAt: nowIso(),
  };
}

function normalizePlayback(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  // Already-normalized playback shape (used internally across state merges).
  if (!isRecord(raw.item)) {
    const trackTitle = normalizeString(raw.trackTitle);
    const artistNames = normalizeString(raw.artistNames);
    const coverUrl = normalizeString(raw.coverUrl);
    const trackUrl = normalizeString(raw.trackUrl);
    const trackId = normalizeString(raw.trackId);
    const durationSeconds = clamp(toInt(raw.durationSeconds, 0), 0, 60 * 60 * 10);
    const progressSeconds = clamp(
      toInt(raw.progressSeconds, 0),
      0,
      durationSeconds > 0 ? durationSeconds : 60 * 60 * 10,
    );
    const repeatModeRaw = normalizeString(raw.repeatMode || raw.repeat_state).toLowerCase();
    const repeatMode = repeatModeRaw === "track" || repeatModeRaw === "context" ? repeatModeRaw : "off";

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
      isPlaying: normalizeBoolean(raw.isPlaying, normalizeBoolean(raw.is_playing, false)),
      deviceId: normalizeString(raw.deviceId),
      deviceName: normalizeString(raw.deviceName),
      shuffleEnabled: normalizeBoolean(raw.shuffleEnabled, normalizeBoolean(raw.shuffle_state, false)),
      repeatMode,
    };
  }

  const isPlaying = normalizeBoolean(raw.is_playing, false);
  const item = isRecord(raw.item) ? raw.item : null;
  if (!item) {
    return null;
  }

  const trackTitle = normalizeString(item.name);
  const trackId = normalizeString(item.id) || normalizeString(item.uri);
  const trackUrl = normalizeString(isRecord(item.external_urls) ? item.external_urls.spotify : "");
  const durationMs = clamp(toInt(item.duration_ms, 0), 0, 60 * 60 * 10 * 1000);
  const progressMs = clamp(toInt(raw.progress_ms, 0), 0, durationMs);
  const durationSeconds = Math.floor(durationMs / 1000);
  const progressSeconds = Math.floor(progressMs / 1000);

  const artistsArray = Array.isArray(item.artists) ? item.artists : [];
  const artistNames = artistsArray
    .map((entry) => (isRecord(entry) ? normalizeString(entry.name) : ""))
    .filter(Boolean)
    .join(", ");

  const album = isRecord(item.album) ? item.album : null;
  const images = Array.isArray(album?.images) ? album.images : [];
  const coverUrl = (() => {
    for (const image of images) {
      const candidate = isRecord(image) ? normalizeString(image.url) : "";
      if (candidate) {
        return candidate;
      }
    }
    return "";
  })();

  const device = isRecord(raw.device) ? raw.device : null;
  const deviceId = normalizeString(device?.id);
  const deviceName = normalizeString(device?.name);
  const repeatState = normalizeString(raw.repeat_state);
  const repeatMode = repeatState === "track" || repeatState === "context" ? repeatState : "off";

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
    isPlaying,
    deviceId,
    deviceName,
    shuffleEnabled: normalizeBoolean(raw.shuffle_state, false),
    repeatMode,
  };
}

function normalizeConnection(raw) {
  const casted = isRecord(raw) ? raw : {};
  const connected = normalizeBoolean(casted.connected, false);
  const token = casted.token;
  const normalizedToken =
    connected && isRecord(token)
      ? {
          accessToken: normalizeString(token.accessToken),
          refreshToken: normalizeString(token.refreshToken),
          tokenType: normalizeString(token.tokenType, "Bearer") || "Bearer",
          scope: normalizeString(token.scope),
          expiresAt: Math.max(0, toInt(token.expiresAt, 0)),
        }
      : null;
  const normalizedPlayback = isRecord(casted.playback) ? normalizePlayback(casted.playback) : null;

  return {
    v: 1,
    provider: "spotify",
    authState: connected ? "oauth" : "detached",
    connected,
    accountName: connected ? normalizeString(casted.accountName, DEFAULT_SPOTIFY_ACCOUNT_NAME) : "",
    accountId: connected ? normalizeString(casted.accountId) : "",
    accountUrl: connected ? normalizeString(casted.accountUrl) : "",
    accountProduct: connected ? normalizeString(casted.accountProduct).toLowerCase() : "",
    showOnProfile: connected ? normalizeBoolean(casted.showOnProfile, true) : false,
    showAsStatus: connected ? normalizeBoolean(casted.showAsStatus, true) : false,
    playback: connected ? normalizedPlayback : null,
    token: connected && normalizedToken && normalizedToken.accessToken && normalizedToken.refreshToken ? normalizedToken : null,
    updatedAt: normalizeString(casted.updatedAt, nowIso()) || nowIso(),
  };
}

function buildConnectionFingerprint(connection) {
  const normalized = normalizeConnection(connection);
  const playback = normalized.playback;
  return JSON.stringify({
    connected: normalized.connected,
    accountId: normalized.accountId,
    accountUrl: normalized.accountUrl,
    accountProduct: normalized.accountProduct,
    showOnProfile: normalized.showOnProfile,
    showAsStatus: normalized.showAsStatus,
    playback: playback
      ? {
          trackId: normalizeString(playback.trackId),
          trackTitle: normalizeString(playback.trackTitle),
          artistNames: normalizeString(playback.artistNames),
          coverUrl: normalizeString(playback.coverUrl),
          trackUrl: normalizeString(playback.trackUrl),
          progressSeconds: Math.max(0, Math.floor(toInt(playback.progressSeconds, 0))),
          durationSeconds: Math.max(0, Math.floor(toInt(playback.durationSeconds, 0))),
          isPlaying: normalizeBoolean(playback.isPlaying, false),
          deviceId: normalizeString(playback.deviceId),
          deviceName: normalizeString(playback.deviceName),
        }
      : null,
  });
}

function buildActivity(connection) {
  const normalized = normalizeConnection(connection);
  if (!normalized.connected || !normalized.showAsStatus || !normalized.playback) {
    return null;
  }
  const playback = normalized.playback;
  const updatedAtMs = Number.isFinite(Date.parse(normalized.updatedAt)) ? Date.parse(normalized.updatedAt) : Date.now();
  const progressSeconds = Math.max(0, Math.floor(toInt(playback.progressSeconds, 0)));
  const durationSeconds = Math.max(0, Math.floor(toInt(playback.durationSeconds, 0)));
  const startedAt = Math.max(0, updatedAtMs - progressSeconds * 1000);
  const endsAt = durationSeconds > 0 ? startedAt + durationSeconds * 1000 : null;

  return {
    provider: "spotify",
    trackId: normalizeString(playback.trackId),
    trackTitle: normalizeString(playback.trackTitle),
    artistNames: normalizeString(playback.artistNames),
    trackUrl: normalizeString(playback.trackUrl),
    coverUrl: normalizeString(playback.coverUrl),
    progressSeconds,
    durationSeconds,
    isPlaying: normalizeBoolean(playback.isPlaying, false),
    startedAt,
    ...(endsAt ? { endsAt } : {}),
    updatedAt: Date.now(),
    showOnProfile: normalized.showOnProfile,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SPOTIFY_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, Math.max(250, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function createSpotifyPresenceService(options = {}) {
  const app = options.app;
  const shell = options.shell;
  const safeStorage = options.safeStorage;
  const getWindows = typeof options.getWindows === "function" ? options.getWindows : () => [];
  const waitForOAuthCallback =
    typeof options.waitForOAuthCallback === "function"
      ? options.waitForOAuthCallback
      : async () => {
          throw new Error("Spotify OAuth callback bridge not available.");
        };
  let runtimeSpotifyClientId = normalizeString(process.env.VITE_SPOTIFY_CLIENT_ID);
  let runtimeSpotifyRedirectUri = normalizeString(process.env.VITE_SPOTIFY_REDIRECT_URI);
  const debugEnabled = String(process.env.MESSLY_SPOTIFY_PRESENCE_DEBUG ?? "").trim() === "1";

  const stateFilePath = (() => {
    try {
      return path.join(app.getPath("userData"), SPOTIFY_STORAGE_FILE);
    } catch {
      return path.resolve(process.cwd(), SPOTIFY_STORAGE_FILE);
    }
  })();

  const scopes = new Map();

  function log(event, details = {}) {
    if (!debugEnabled) {
      return;
    }
    const summary = Object.entries(details)
      .filter(([, value]) => value != null && value !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const message = summary ? `[spotify-main] ${event} ${summary}` : `[spotify-main] ${event}`;
    console.log(message);
  }

  function resolveOAuthConfig(overrides = {}) {
    const overrideClientId = normalizeString(overrides.clientId);
    const overrideRedirectUri = normalizeString(overrides.redirectUri);
    if (overrideClientId) {
      runtimeSpotifyClientId = overrideClientId;
    }
    if (overrideRedirectUri) {
      runtimeSpotifyRedirectUri = overrideRedirectUri;
    }
    return {
      clientId: runtimeSpotifyClientId,
      redirectUri: runtimeSpotifyRedirectUri,
    };
  }

  function readPersistedState() {
    try {
      if (!fs.existsSync(stateFilePath)) {
        return {};
      }
      const raw = fs.readFileSync(stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.scopes)) {
        return {};
      }
      return parsed.scopes;
    } catch {
      return {};
    }
  }

  function encryptToken(token) {
    if (!token || !safeStorage?.isEncryptionAvailable?.()) {
      return null;
    }
    try {
      const serialized = JSON.stringify(token);
      const encrypted = safeStorage.encryptString(serialized);
      return Buffer.from(encrypted).toString("base64");
    } catch {
      return null;
    }
  }

  function decryptToken(rawEncrypted) {
    const encrypted = normalizeString(rawEncrypted);
    if (!encrypted || !safeStorage?.isEncryptionAvailable?.()) {
      return null;
    }
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      const parsed = JSON.parse(decrypted);
      return normalizeConnection({
        connected: true,
        token: {
          accessToken: normalizeString(parsed?.accessToken),
          refreshToken: normalizeString(parsed?.refreshToken),
          tokenType: normalizeString(parsed?.tokenType, "Bearer"),
          scope: normalizeString(parsed?.scope),
          expiresAt: Math.max(0, toInt(parsed?.expiresAt, 0)),
        },
      }).token;
    } catch {
      return null;
    }
  }

  function persistStateToDisk() {
    const serializedScopes = {};
    for (const [scope, scopeState] of scopes.entries()) {
      const normalizedConnection = normalizeConnection(scopeState.connection);
      const connectionForDisk = {
        ...normalizedConnection,
        token: null,
      };
      serializedScopes[scope] = {
        connection: connectionForDisk,
        tokenEncrypted: encryptToken(scopeState.token),
        scheduler: {
          backoffAttempt: Math.max(0, toInt(scopeState.backoffAttempt, 0)),
          lastReason: normalizeString(scopeState.lastReason),
          lastRequestAt: Math.max(0, toInt(scopeState.lastRequestAt, 0)),
          lastResponseAt: Math.max(0, toInt(scopeState.lastResponseAt, 0)),
        },
      };
    }
    const payload = {
      v: 1,
      scopes: serializedScopes,
      updatedAt: nowIso(),
    };

    try {
      const tempPath = `${stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tempPath, stateFilePath);
    } catch (error) {
      log("persist-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function createScopeState(scope) {
    const normalizedScope = resolveScope(scope);
    return {
      scope: normalizedScope,
      connection: buildDefaultConnection(),
      token: null,
      subscribers: 0,
      started: false,
      pollInFlight: false,
      timerId: null,
      nextDelayMs: 0,
      backoffAttempt: 0,
      lastReason: "init",
      lastRequestAt: 0,
      lastResponseAt: 0,
      lastFingerprint: buildConnectionFingerprint(buildDefaultConnection()),
      lastError: "",
    };
  }

  function getScopeState(scope) {
    const normalizedScope = resolveScope(scope);
    const existing = scopes.get(normalizedScope);
    if (existing) {
      return existing;
    }
    const next = createScopeState(normalizedScope);
    scopes.set(normalizedScope, next);
    return next;
  }

  function loadStateFromDisk() {
    const persistedScopes = readPersistedState();
    for (const [scopeKey, rawScopeState] of Object.entries(persistedScopes)) {
      const normalizedScope = resolveScope(scopeKey);
      const scopeState = getScopeState(normalizedScope);
      if (!isRecord(rawScopeState)) {
        continue;
      }
      const connection = normalizeConnection(rawScopeState.connection);
      scopeState.connection = {
        ...connection,
        token: null,
      };
      scopeState.token = decryptToken(rawScopeState.tokenEncrypted);
      scopeState.lastFingerprint = buildConnectionFingerprint(scopeState.connection);
      const scheduler = isRecord(rawScopeState.scheduler) ? rawScopeState.scheduler : {};
      scopeState.backoffAttempt = Math.max(0, toInt(scheduler.backoffAttempt, 0));
      scopeState.lastReason = normalizeString(scheduler.lastReason, "restored");
      scopeState.lastRequestAt = Math.max(0, toInt(scheduler.lastRequestAt, 0));
      scopeState.lastResponseAt = Math.max(0, toInt(scheduler.lastResponseAt, 0));
    }
  }

  function toPublicConnection(connection) {
    const normalized = normalizeConnection(connection);
    return {
      ...normalized,
      token: null,
    };
  }

  function broadcastUpdate(scopeState, reason) {
    const payload = {
      scope: scopeState.scope,
      connection: toPublicConnection(scopeState.connection),
      activity: buildActivity(scopeState.connection),
      scheduler: {
        reason: normalizeString(reason || scopeState.lastReason || "update"),
        nextDelayMs: Math.max(0, toInt(scopeState.nextDelayMs, 0)),
        backoffAttempt: Math.max(0, toInt(scopeState.backoffAttempt, 0)),
        pollInFlight: Boolean(scopeState.pollInFlight),
        started: Boolean(scopeState.started),
        subscribers: Math.max(0, toInt(scopeState.subscribers, 0)),
        lastRequestAt: Math.max(0, toInt(scopeState.lastRequestAt, 0)),
        lastResponseAt: Math.max(0, toInt(scopeState.lastResponseAt, 0)),
        lastError: normalizeString(scopeState.lastError),
      },
    };
    const windows = getWindows();
    for (const window of windows) {
      if (!window || window.isDestroyed?.()) {
        continue;
      }
      const contents = window.webContents;
      if (!contents || contents.isDestroyed?.()) {
        continue;
      }
      contents.send(SPOTIFY_BROADCAST_CHANNEL, payload);
    }
  }

  function applyConnectionUpdate(scopeState, nextConnection, options = {}) {
    const normalizedPublic = toPublicConnection(nextConnection);
    const previousFingerprint = scopeState.lastFingerprint;
    if (Object.prototype.hasOwnProperty.call(options, "token")) {
      scopeState.token = options.token;
    }
    scopeState.connection = normalizedPublic;
    scopeState.lastFingerprint = buildConnectionFingerprint(normalizedPublic);
    persistStateToDisk();
    if (previousFingerprint !== scopeState.lastFingerprint || options.forceBroadcast) {
      broadcastUpdate(scopeState, options.reason || "state-updated");
    }
    return normalizedPublic;
  }

  function clearScheduledPoll(scopeState) {
    if (scopeState.timerId != null) {
      clearTimeout(scopeState.timerId);
      scopeState.timerId = null;
    }
  }

  function computeModeIntervalMs(mode) {
    if (mode === "playing") {
      return pickInterval(SPOTIFY_POLL_PLAYING_MIN_MS, SPOTIFY_POLL_PLAYING_MAX_MS);
    }
    if (mode === "paused") {
      return pickInterval(SPOTIFY_POLL_PAUSED_MIN_MS, SPOTIFY_POLL_PAUSED_MAX_MS);
    }
    return pickInterval(SPOTIFY_POLL_OFFLINE_MIN_MS, SPOTIFY_POLL_OFFLINE_MAX_MS);
  }

  function computeBackoffMs(attempt, retryAfterMs = 0) {
    const safeAttempt = Math.max(0, Math.min(12, toInt(attempt, 0)));
    const exponential = Math.min(SPOTIFY_MAX_BACKOFF_MS, SPOTIFY_BASE_BACKOFF_MS * (2 ** safeAttempt));
    const jitter = Math.round(exponential * (0.2 + Math.random() * 0.3));
    return Math.max(
      Math.min(SPOTIFY_MAX_BACKOFF_MS, exponential + jitter),
      Math.max(1_000, toInt(retryAfterMs, 0)),
    );
  }

  function scheduleNextPoll(scopeState, delayMs, reason) {
    if (!scopeState.started || scopeState.subscribers <= 0) {
      return;
    }
    clearScheduledPoll(scopeState);
    const nextDelayMs = clamp(toInt(delayMs, SPOTIFY_POLL_OFFLINE_MIN_MS), 250, SPOTIFY_POLL_OFFLINE_MAX_MS);
    scopeState.nextDelayMs = nextDelayMs;
    scopeState.lastReason = normalizeString(reason, "scheduled");
    scopeState.timerId = setTimeout(() => {
      scopeState.timerId = null;
      void pollOnce(scopeState.scope, "scheduled");
    }, nextDelayMs);
    log("schedule", {
      scope: scopeState.scope,
      reason: scopeState.lastReason,
      delayMs: nextDelayMs,
    });
  }

  async function requestTokenExchange(bodyParams, options = {}) {
    const body = new URLSearchParams(bodyParams);
    const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const rawJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = normalizeString(rawJson?.error_description) || normalizeString(rawJson?.error) || `HTTP ${response.status}`;
      const error = new Error(`Spotify token error: ${details}`);
      error.code = "spotify-token-error";
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers);
      throw error;
    }
    const token = normalizeToken(rawJson, normalizeString(options.currentRefreshToken));
    if (!token) {
      throw new Error("Spotify token inválido.");
    }
    return token;
  }

  async function refreshToken(scopeState) {
    if (!scopeState.token?.refreshToken) {
      throw new Error("Refresh token indisponível.");
    }
    const oauthConfig = resolveOAuthConfig();
    if (!oauthConfig.clientId) {
      throw new Error("Spotify client id não configurado.");
    }
    const nextToken = await requestTokenExchange(
      {
        grant_type: "refresh_token",
        refresh_token: scopeState.token.refreshToken,
        client_id: oauthConfig.clientId,
      },
      {
        currentRefreshToken: scopeState.token.refreshToken,
      },
    );
    scopeState.token = nextToken;
    persistStateToDisk();
    return nextToken;
  }

  async function ensureFreshAccessToken(scopeState) {
    if (!scopeState.token?.accessToken) {
      throw new Error("Spotify access token ausente.");
    }
    if (Date.now() + SPOTIFY_TOKEN_EXPIRY_SKEW_MS < scopeState.token.expiresAt) {
      return scopeState.token.accessToken;
    }
    const nextToken = await refreshToken(scopeState);
    return nextToken.accessToken;
  }

  async function requestSpotifyProfile(accessToken) {
    const response = await fetchWithTimeout(`${SPOTIFY_API_BASE_URL}/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Spotify profile HTTP ${response.status}`);
      error.code = "spotify-profile-error";
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers);
      throw error;
    }
    const accountName = normalizeString(payload?.display_name) || DEFAULT_SPOTIFY_ACCOUNT_NAME;
    const accountId = normalizeString(payload?.id);
    const accountUrl = normalizeString(isRecord(payload?.external_urls) ? payload.external_urls.spotify : "");
    const accountProduct = normalizeString(payload?.product).toLowerCase();
    return {
      accountName,
      accountId,
      accountUrl,
      accountProduct,
    };
  }

  async function requestSpotifyPlayer(accessToken) {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(`${SPOTIFY_API_BASE_URL}/me/player`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    return {
      status: response.status,
      payload,
      retryAfterMs: parseRetryAfterMs(response.headers),
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  function classifyPlayerMode(playback, status) {
    if (playback?.isPlaying) {
      return "playing";
    }
    if (status === 204 || status === 202 || playback) {
      return "paused";
    }
    return "offline";
  }

  async function pollOnce(scope, reason = "manual") {
    const scopeState = getScopeState(scope);
    if (!scopeState.started || scopeState.subscribers <= 0) {
      return toPublicConnection(scopeState.connection);
    }
    if (scopeState.pollInFlight) {
      return toPublicConnection(scopeState.connection);
    }
    if (!scopeState.connection.connected || !scopeState.token) {
      scheduleNextPoll(scopeState, computeModeIntervalMs("offline"), "offline-no-token");
      return toPublicConnection(scopeState.connection);
    }

    scopeState.pollInFlight = true;
    scopeState.lastReason = normalizeString(reason, "manual");
    scopeState.lastRequestAt = Date.now();
    let nextDelayMs = computeModeIntervalMs("offline");
    let nextReason = "offline";

    try {
      let accessToken = await ensureFreshAccessToken(scopeState);
      let playerResult = await requestSpotifyPlayer(accessToken);

      if (playerResult.status === 401) {
        try {
          const refreshedToken = await refreshToken(scopeState);
          accessToken = refreshedToken.accessToken;
          playerResult = await requestSpotifyPlayer(accessToken);
        } catch {
          const disconnected = buildDefaultConnection();
          applyConnectionUpdate(scopeState, disconnected, {
            token: null,
            reason: "auth-disconnected",
            forceBroadcast: true,
          });
          scopeState.backoffAttempt = 0;
          scopeState.lastError = "spotify-auth-expired";
          scopeState.started = false;
          clearScheduledPoll(scopeState);
          return toPublicConnection(scopeState.connection);
        }
      }

      if (playerResult.status === 429) {
        const rateError = new Error("spotify-rate-limit");
        rateError.code = "spotify-rate-limit";
        rateError.retryAfterMs = playerResult.retryAfterMs;
        throw rateError;
      }

      if (playerResult.status >= 500) {
        const serverError = new Error(`spotify-server-${playerResult.status}`);
        serverError.code = "spotify-server-error";
        serverError.status = playerResult.status;
        throw serverError;
      }

      const playback = normalizePlayback(playerResult.payload);
      const mode = classifyPlayerMode(playback, playerResult.status);

      const nextConnection = normalizeConnection({
        ...scopeState.connection,
        connected: true,
        authState: "oauth",
        playback: mode === "offline" ? null : playback,
        updatedAt: nowIso(),
      });

      applyConnectionUpdate(scopeState, nextConnection, {
        token: scopeState.token,
        reason: "poll-success",
      });
      scopeState.backoffAttempt = 0;
      scopeState.lastError = "";
      scopeState.lastResponseAt = Date.now();
      nextDelayMs = computeModeIntervalMs(mode);
      nextReason = `mode-${mode}`;
      log("poll", {
        scope: scopeState.scope,
        reason,
        mode,
        status: playerResult.status,
        latencyMs: playerResult.latencyMs,
        nextDelayMs,
      });
    } catch (error) {
      const code = normalizeString(error?.code);
      const retryAfterMs = Math.max(0, toInt(error?.retryAfterMs, 0));
      scopeState.backoffAttempt = Math.min(12, scopeState.backoffAttempt + 1);
      nextDelayMs = computeBackoffMs(scopeState.backoffAttempt, retryAfterMs);
      nextReason = `backoff-${code || "error"}`;
      scopeState.lastError =
        normalizeString(error?.message) ||
        code ||
        "spotify-poll-error";
      log("poll-error", {
        scope: scopeState.scope,
        reason,
        code: code || "unknown",
        backoffAttempt: scopeState.backoffAttempt,
        nextDelayMs,
        retryAfterMs,
      });
      if (code === "spotify-token-error" && toInt(error?.status, 0) === 401) {
        const disconnected = buildDefaultConnection();
        applyConnectionUpdate(scopeState, disconnected, {
          token: null,
          reason: "auth-invalid",
          forceBroadcast: true,
        });
        scopeState.started = false;
        clearScheduledPoll(scopeState);
      }
    } finally {
      scopeState.pollInFlight = false;
      if (scopeState.started && scopeState.subscribers > 0) {
        scheduleNextPoll(scopeState, nextDelayMs, nextReason);
      }
    }

    return toPublicConnection(scopeState.connection);
  }

  async function connect(scope, oauthOverrides = {}) {
    const oauthConfig = resolveOAuthConfig(oauthOverrides);
    if (!oauthConfig.clientId || !oauthConfig.redirectUri) {
      throw new Error("Spotify OAuth não está configurado.");
    }
    const scopeState = getScopeState(scope);
    const verifier = createRandomVerifier(96);
    const state = createRandomVerifier(32);
    const challenge = createCodeChallenge(verifier);

    const authUrl = (() => {
      const url = new URL(SPOTIFY_AUTHORIZE_URL);
      url.searchParams.set("client_id", oauthConfig.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", oauthConfig.redirectUri);
      url.searchParams.set("scope", SPOTIFY_OAUTH_SCOPES.join(" "));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("state", state);
      return url.toString();
    })();

    await shell.openExternal(authUrl);

    const callbackPayload = await waitForOAuthCallback({
      expectedState: state,
      timeoutMs: SPOTIFY_OAUTH_TIMEOUT_MS,
    });
    const callbackUrl = normalizeString(callbackPayload?.url);
    if (!callbackUrl) {
      throw new Error("Callback do Spotify não recebido.");
    }

    const parsed = new URL(callbackUrl);
    const oauthError = normalizeString(parsed.searchParams.get("error"));
    if (oauthError) {
      const message = normalizeString(parsed.searchParams.get("error_description")) || oauthError;
      throw new Error(`Spotify OAuth falhou: ${message}`);
    }
    const returnedState = normalizeString(parsed.searchParams.get("state"));
    const authCode = normalizeString(parsed.searchParams.get("code"));
    if (!authCode || returnedState !== state) {
      throw new Error("Spotify OAuth retornou código inválido.");
    }

    const token = await requestTokenExchange({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: oauthConfig.redirectUri,
      client_id: oauthConfig.clientId,
      code_verifier: verifier,
    });

    const profile = await requestSpotifyProfile(token.accessToken);
    let playback = null;
    try {
      const player = await requestSpotifyPlayer(token.accessToken);
      playback = normalizePlayback(player.payload);
    } catch {
      playback = null;
    }

    const showOnProfile = scopeState.connection.connected ? scopeState.connection.showOnProfile : true;
    const showAsStatus = scopeState.connection.connected ? scopeState.connection.showAsStatus : true;
    const nextConnection = normalizeConnection({
      connected: true,
      authState: "oauth",
      accountName: profile.accountName,
      accountId: profile.accountId,
      accountUrl: profile.accountUrl,
      accountProduct: profile.accountProduct,
      showOnProfile,
      showAsStatus,
      playback,
      updatedAt: nowIso(),
    });

    applyConnectionUpdate(scopeState, nextConnection, {
      token,
      reason: "oauth-connected",
      forceBroadcast: true,
    });

    if (scopeState.started && scopeState.subscribers > 0) {
      scheduleNextPoll(scopeState, 1_000, "connect-prime");
    }

    return {
      scope: scopeState.scope,
      connection: toPublicConnection(scopeState.connection),
      activity: buildActivity(scopeState.connection),
    };
  }

  function getState(scope) {
    const scopeState = getScopeState(scope);
    return {
      scope: scopeState.scope,
      connection: toPublicConnection(scopeState.connection),
      activity: buildActivity(scopeState.connection),
      scheduler: {
        reason: scopeState.lastReason,
        nextDelayMs: scopeState.nextDelayMs,
        backoffAttempt: scopeState.backoffAttempt,
        pollInFlight: scopeState.pollInFlight,
        started: scopeState.started,
        subscribers: scopeState.subscribers,
        lastRequestAt: scopeState.lastRequestAt,
        lastResponseAt: scopeState.lastResponseAt,
        lastError: scopeState.lastError,
      },
    };
  }

  function getDebugState(scope) {
    const scopeState = getScopeState(scope);
    const oauthConfig = resolveOAuthConfig();
    return {
      configured: Boolean(oauthConfig.clientId && oauthConfig.redirectUri),
      scope: scopeState.scope,
      connection: toPublicConnection(scopeState.connection),
      activity: buildActivity(scopeState.connection),
      scheduler: {
        reason: scopeState.lastReason,
        nextDelayMs: scopeState.nextDelayMs,
        backoffAttempt: scopeState.backoffAttempt,
        pollInFlight: scopeState.pollInFlight,
        started: scopeState.started,
        subscribers: scopeState.subscribers,
        lastRequestAt: scopeState.lastRequestAt,
        lastResponseAt: scopeState.lastResponseAt,
        lastError: scopeState.lastError,
      },
    };
  }

  function setVisibility(scope, patch = {}) {
    const scopeState = getScopeState(scope);
    if (!scopeState.connection.connected) {
      return getState(scopeState.scope);
    }
    const nextConnection = normalizeConnection({
      ...scopeState.connection,
      showOnProfile: normalizeBoolean(
        Object.prototype.hasOwnProperty.call(patch, "showOnProfile") ? patch.showOnProfile : scopeState.connection.showOnProfile,
        scopeState.connection.showOnProfile,
      ),
      showAsStatus: normalizeBoolean(
        Object.prototype.hasOwnProperty.call(patch, "showAsStatus") ? patch.showAsStatus : scopeState.connection.showAsStatus,
        scopeState.connection.showAsStatus,
      ),
      updatedAt: nowIso(),
    });
    applyConnectionUpdate(scopeState, nextConnection, {
      token: scopeState.token,
      reason: "visibility-updated",
      forceBroadcast: true,
    });
    return getState(scopeState.scope);
  }

  function disconnect(scope) {
    const scopeState = getScopeState(scope);
    clearScheduledPoll(scopeState);
    scopeState.pollInFlight = false;
    scopeState.token = null;
    scopeState.backoffAttempt = 0;
    scopeState.lastError = "";
    applyConnectionUpdate(scopeState, buildDefaultConnection(), {
      token: null,
      reason: "disconnected",
      forceBroadcast: true,
    });
    return getState(scopeState.scope);
  }

  function setTokens(scope, tokenPayload) {
    const scopeState = getScopeState(scope);
    const token = normalizeToken(tokenPayload, scopeState.token?.refreshToken ?? "");
    if (!token) {
      throw new Error("Token Spotify inválido.");
    }
    scopeState.token = token;
    persistStateToDisk();
    return getState(scopeState.scope);
  }

  async function start(scope) {
    const scopeState = getScopeState(scope);
    scopeState.subscribers += 1;
    scopeState.started = true;
    if (scopeState.connection.connected && scopeState.token) {
      scheduleNextPoll(scopeState, 250, "start");
    }
    log("start", {
      scope: scopeState.scope,
      subscribers: scopeState.subscribers,
    });
    return getState(scopeState.scope);
  }

  async function stop(scope) {
    const scopeState = getScopeState(scope);
    scopeState.subscribers = Math.max(0, scopeState.subscribers - 1);
    if (scopeState.subscribers === 0) {
      scopeState.started = false;
      clearScheduledPoll(scopeState);
    }
    log("stop", {
      scope: scopeState.scope,
      subscribers: scopeState.subscribers,
    });
    return getState(scopeState.scope);
  }

  function dispose() {
    for (const scopeState of scopes.values()) {
      clearScheduledPoll(scopeState);
      scopeState.pollInFlight = false;
      scopeState.subscribers = 0;
      scopeState.started = false;
    }
    persistStateToDisk();
  }

  loadStateFromDisk();

  return {
    isConfigured: () => {
      const oauthConfig = resolveOAuthConfig();
      return Boolean(oauthConfig.clientId && oauthConfig.redirectUri);
    },
    start,
    stop,
    connect,
    disconnect,
    setVisibility,
    setTokens,
    pollOnce: (scope) => pollOnce(scope, "manual"),
    getState,
    getDebugState,
    dispose,
  };
}

module.exports = {
  createSpotifyPresenceService,
  SPOTIFY_BROADCAST_CHANNEL,
};
