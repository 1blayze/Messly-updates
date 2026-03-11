import { supabase } from "../../lib/supabaseClient";
import {
  getPresenceSnapshot,
  subscribe as subscribePresenceStore,
  watchUsers as watchPresenceUsers,
} from "../presence/presenceStore";
import {
  isSpotifyConnectionPremium,
  isSpotifyPlaybackStillActive,
  readSpotifyConnection,
  subscribeSpotifyConnection,
  type SpotifyConnectionState,
  type SpotifyPlaybackState,
} from "./spotifyConnection";

export interface SpotifyListenAlongParticipant {
  userId: string;
  displayName: string;
  avatarSrc: string;
  joinedAt: string;
}

export interface SpotifyListenAlongSession {
  v: 1;
  active: boolean;
  listenerUserId: string;
  hostUserId: string;
  listenerDisplayName: string;
  listenerAvatarSrc: string;
  hostDisplayName: string;
  hostAvatarSrc: string;
  trackId: string;
  trackTitle: string;
  trackUrl: string;
  updatedAt: string;
  participants: SpotifyListenAlongParticipant[];
  endedReason: string | null;
}

export interface SpotifyListenAlongUpdatedDetail {
  listenerUserId: string;
  hostUserId: string;
  session: SpotifyListenAlongSession;
}

export type SpotifyListenAlongUnavailableReason =
  | "spotify_not_connected"
  | "spotify_premium_required"
  | "host_not_listening"
  | "invalid_session";

export interface SpotifyListenAlongAvailability {
  available: boolean;
  reason: SpotifyListenAlongUnavailableReason | null;
  connection: SpotifyConnectionState;
}

export interface JoinSpotifyListenAlongSessionOptions {
  listenerUserId: string;
  hostUserId: string;
  listenerDisplayName?: string | null;
  listenerAvatarSrc?: string | null;
  hostDisplayName?: string | null;
  hostAvatarSrc?: string | null;
  trackId?: string | null;
  trackTitle?: string | null;
  trackUrl?: string | null;
}

export type JoinSpotifyListenAlongSessionResult =
  | {
      ok: true;
      session: SpotifyListenAlongSession;
    }
  | {
      ok: false;
      reason: SpotifyListenAlongUnavailableReason;
    };

interface SpotifyListenAlongHostState {
  v: 1;
  active: boolean;
  hostUserId: string;
  hostDisplayName: string;
  hostAvatarSrc: string;
  trackId: string;
  trackTitle: string;
  trackUrl: string;
  updatedAt: string;
  participants: SpotifyListenAlongParticipant[];
}

interface ListenAlongJoinRequestPayload {
  hostUserId: string;
  hostDisplayName: string;
  hostAvatarSrc: string;
  participant: SpotifyListenAlongParticipant;
  updatedAt: string;
}

interface ListenAlongLeaveRequestPayload {
  hostUserId: string;
  participantUserId: string;
  updatedAt: string;
  reason: string | null;
}

interface ListenAlongSessionSyncPayload {
  hostUserId: string;
  hostDisplayName: string;
  hostAvatarSrc: string;
  trackId: string;
  trackTitle: string;
  trackUrl: string;
  updatedAt: string;
  participants: SpotifyListenAlongParticipant[];
}

interface ListenAlongSessionEndPayload {
  hostUserId: string;
  updatedAt: string;
  reason: string;
}

const SPOTIFY_LISTEN_ALONG_STORAGE_KEY_PREFIX = "messly:spotify-listen-along:";
const SPOTIFY_LISTEN_ALONG_HOST_STATE_PREFIX = "messly:spotify-listen-along-host:";
const SPOTIFY_LISTEN_ALONG_UPDATED_EVENT = "messly:spotify-listen-along-updated";
const SPOTIFY_LISTEN_ALONG_BROWSER_FALLBACK_DELAY_MS = 900;
const SPOTIFY_LISTEN_ALONG_SEND_TIMEOUT_MS = 3_000;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveId(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function buildSessionStorageKey(listenerUserId: string, hostUserId: string): string {
  return `${SPOTIFY_LISTEN_ALONG_STORAGE_KEY_PREFIX}${resolveId(listenerUserId)}:${resolveId(hostUserId)}`;
}

function buildHostStateStorageKey(hostUserId: string): string {
  return `${SPOTIFY_LISTEN_ALONG_HOST_STATE_PREFIX}${resolveId(hostUserId)}`;
}

function buildRealtimeChannelName(hostUserId: string): string {
  return `spotify-listen-along:${resolveId(hostUserId)}`;
}

function resolveIsoTimestamp(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return nowIso();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

function normalizeParticipant(
  value: Partial<SpotifyListenAlongParticipant> | null | undefined,
  fallbackUserId = "",
): SpotifyListenAlongParticipant {
  const userId = resolveId(value?.userId) || resolveId(fallbackUserId);
  return {
    userId,
    displayName: String(value?.displayName ?? "").trim() || "Usuario",
    avatarSrc: String(value?.avatarSrc ?? "").trim(),
    joinedAt: resolveIsoTimestamp(value?.joinedAt),
  };
}

function normalizeParticipants(
  value: unknown,
  listenerUserId = "",
  listenerDisplayName = "",
  listenerAvatarSrc = "",
): SpotifyListenAlongParticipant[] {
  const seen = new Set<string>();
  const source = Array.isArray(value) ? value : [];
  const participants = source
    .map((entry) => normalizeParticipant((entry ?? null) as Partial<SpotifyListenAlongParticipant> | null))
    .filter((participant) => {
      if (!participant.userId || seen.has(participant.userId)) {
        return false;
      }
      seen.add(participant.userId);
      return true;
    })
    .sort((left, right) => {
      const leftMs = Date.parse(left.joinedAt);
      const rightMs = Date.parse(right.joinedAt);
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      return left.userId.localeCompare(right.userId);
    });

  const normalizedListenerUserId = resolveId(listenerUserId);
  if (normalizedListenerUserId && !seen.has(normalizedListenerUserId)) {
    participants.push(
      normalizeParticipant(
        {
          userId: normalizedListenerUserId,
          displayName: listenerDisplayName,
          avatarSrc: listenerAvatarSrc,
          joinedAt: nowIso(),
        },
        normalizedListenerUserId,
      ),
    );
  }

  return participants;
}

export function createDefaultSpotifyListenAlongSession(
  listenerUserId: string | null | undefined,
  hostUserId: string | null | undefined,
): SpotifyListenAlongSession {
  return {
    v: 1,
    active: false,
    listenerUserId: resolveId(listenerUserId),
    hostUserId: resolveId(hostUserId),
    listenerDisplayName: "",
    listenerAvatarSrc: "",
    hostDisplayName: "",
    hostAvatarSrc: "",
    trackId: "",
    trackTitle: "",
    trackUrl: "",
    updatedAt: nowIso(),
    participants: [],
    endedReason: null,
  };
}

function normalizeSession(
  value: Partial<SpotifyListenAlongSession> | null | undefined,
  listenerUserId = "",
  hostUserId = "",
): SpotifyListenAlongSession {
  const fallback = createDefaultSpotifyListenAlongSession(listenerUserId, hostUserId);
  const resolvedListenerUserId = resolveId(value?.listenerUserId) || fallback.listenerUserId;
  const resolvedHostUserId = resolveId(value?.hostUserId) || fallback.hostUserId;
  const resolvedListenerDisplayName = String(value?.listenerDisplayName ?? "").trim();
  const resolvedListenerAvatarSrc = String(value?.listenerAvatarSrc ?? "").trim();

  return {
    v: 1,
    active: value?.active === true,
    listenerUserId: resolvedListenerUserId,
    hostUserId: resolvedHostUserId,
    listenerDisplayName: resolvedListenerDisplayName,
    listenerAvatarSrc: resolvedListenerAvatarSrc,
    hostDisplayName: String(value?.hostDisplayName ?? "").trim(),
    hostAvatarSrc: String(value?.hostAvatarSrc ?? "").trim(),
    trackId: String(value?.trackId ?? "").trim(),
    trackTitle: String(value?.trackTitle ?? "").trim(),
    trackUrl: String(value?.trackUrl ?? "").trim(),
    updatedAt: resolveIsoTimestamp(value?.updatedAt),
    participants: normalizeParticipants(
      value?.participants,
      resolvedListenerUserId,
      resolvedListenerDisplayName,
      resolvedListenerAvatarSrc,
    ),
    endedReason: value?.endedReason == null ? null : String(value.endedReason).trim() || null,
  };
}

function createDefaultHostState(hostUserId: string | null | undefined): SpotifyListenAlongHostState {
  return {
    v: 1,
    active: false,
    hostUserId: resolveId(hostUserId),
    hostDisplayName: "",
    hostAvatarSrc: "",
    trackId: "",
    trackTitle: "",
    trackUrl: "",
    updatedAt: nowIso(),
    participants: [],
  };
}

function normalizeHostState(
  value: Partial<SpotifyListenAlongHostState> | null | undefined,
  hostUserId = "",
): SpotifyListenAlongHostState {
  const fallback = createDefaultHostState(hostUserId);
  return {
    v: 1,
    active: value?.active === true,
    hostUserId: resolveId(value?.hostUserId) || fallback.hostUserId,
    hostDisplayName: String(value?.hostDisplayName ?? "").trim(),
    hostAvatarSrc: String(value?.hostAvatarSrc ?? "").trim(),
    trackId: String(value?.trackId ?? "").trim(),
    trackTitle: String(value?.trackTitle ?? "").trim(),
    trackUrl: String(value?.trackUrl ?? "").trim(),
    updatedAt: resolveIsoTimestamp(value?.updatedAt),
    participants: normalizeParticipants(value?.participants),
  };
}

function readStorageValue<T>(key: string): T | null {
  if (!isBrowser()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: unknown): void {
  if (!isBrowser()) {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore optional session storage failures.
  }
}

function removeStorageValue(key: string): void {
  if (!isBrowser()) {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore removal failures.
  }
}

function emitSessionUpdate(listenerUserId: string, hostUserId: string, session: SpotifyListenAlongSession): void {
  if (!isBrowser()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<SpotifyListenAlongUpdatedDetail>(SPOTIFY_LISTEN_ALONG_UPDATED_EVENT, {
      detail: {
        listenerUserId: resolveId(listenerUserId),
        hostUserId: resolveId(hostUserId),
        session,
      },
    }),
  );
}

export function readSpotifyListenAlongSession(
  listenerUserId: string | null | undefined,
  hostUserId: string | null | undefined,
): SpotifyListenAlongSession {
  const resolvedListenerUserId = resolveId(listenerUserId);
  const resolvedHostUserId = resolveId(hostUserId);
  const storageKey = buildSessionStorageKey(resolvedListenerUserId, resolvedHostUserId);
  return normalizeSession(
    readStorageValue<SpotifyListenAlongSession>(storageKey),
    resolvedListenerUserId,
    resolvedHostUserId,
  );
}

export function writeSpotifyListenAlongSession(
  listenerUserId: string | null | undefined,
  hostUserId: string | null | undefined,
  nextSession: Partial<SpotifyListenAlongSession> | null | undefined,
): SpotifyListenAlongSession {
  const resolvedListenerUserId = resolveId(listenerUserId);
  const resolvedHostUserId = resolveId(hostUserId);
  const normalizedSession = normalizeSession(nextSession, resolvedListenerUserId, resolvedHostUserId);
  const storageKey = buildSessionStorageKey(resolvedListenerUserId, resolvedHostUserId);

  const shouldRemove =
    !normalizedSession.active &&
    !normalizedSession.trackId &&
    !normalizedSession.hostDisplayName &&
    normalizedSession.participants.length === 0;

  if (shouldRemove) {
    removeStorageValue(storageKey);
  } else {
    writeStorageValue(storageKey, normalizedSession);
  }

  emitSessionUpdate(resolvedListenerUserId, resolvedHostUserId, normalizedSession);
  return normalizedSession;
}

function readSpotifyListenAlongHostState(hostUserId: string | null | undefined): SpotifyListenAlongHostState {
  const resolvedHostUserId = resolveId(hostUserId);
  const storageKey = buildHostStateStorageKey(resolvedHostUserId);
  return normalizeHostState(readStorageValue<SpotifyListenAlongHostState>(storageKey), resolvedHostUserId);
}

function writeSpotifyListenAlongHostState(
  hostUserId: string | null | undefined,
  nextState: Partial<SpotifyListenAlongHostState> | null | undefined,
): SpotifyListenAlongHostState {
  const resolvedHostUserId = resolveId(hostUserId);
  const normalizedState = normalizeHostState(nextState, resolvedHostUserId);
  const storageKey = buildHostStateStorageKey(resolvedHostUserId);

  if (!normalizedState.active || normalizedState.participants.length === 0) {
    removeStorageValue(storageKey);
    return createDefaultHostState(resolvedHostUserId);
  }

  writeStorageValue(storageKey, normalizedState);
  return normalizedState;
}

export function subscribeSpotifyListenAlongSession(
  listenerUserId: string | null | undefined,
  hostUserId: string | null | undefined,
  listener: (session: SpotifyListenAlongSession) => void,
): () => void {
  if (!isBrowser()) {
    return () => undefined;
  }

  const resolvedListenerUserId = resolveId(listenerUserId);
  const resolvedHostUserId = resolveId(hostUserId);
  const storageKey = buildSessionStorageKey(resolvedListenerUserId, resolvedHostUserId);

  const handleCustomEvent = (event: Event): void => {
    const detail = (event as CustomEvent<SpotifyListenAlongUpdatedDetail>).detail;
    if (!detail) {
      return;
    }
    if (
      resolveId(detail.listenerUserId) !== resolvedListenerUserId ||
      resolveId(detail.hostUserId) !== resolvedHostUserId
    ) {
      return;
    }
    listener(normalizeSession(detail.session, resolvedListenerUserId, resolvedHostUserId));
  };

  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== storageKey) {
      return;
    }
    listener(readSpotifyListenAlongSession(resolvedListenerUserId, resolvedHostUserId));
  };

  window.addEventListener(SPOTIFY_LISTEN_ALONG_UPDATED_EVENT, handleCustomEvent as EventListener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(SPOTIFY_LISTEN_ALONG_UPDATED_EVENT, handleCustomEvent as EventListener);
    window.removeEventListener("storage", handleStorage);
  };
}

function listStoredListenerSessions(listenerUserId: string): SpotifyListenAlongSession[] {
  if (!isBrowser()) {
    return [];
  }

  const resolvedListenerUserId = resolveId(listenerUserId);
  const prefix = `${SPOTIFY_LISTEN_ALONG_STORAGE_KEY_PREFIX}${resolvedListenerUserId}:`;
  const sessions: SpotifyListenAlongSession[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(prefix)) {
      continue;
    }

    const hostUserId = key.slice(prefix.length);
    const session = readSpotifyListenAlongSession(resolvedListenerUserId, hostUserId);
    if (!session.hostUserId) {
      continue;
    }
    sessions.push(session);
  }

  return sessions;
}

function extractSpotifyTrackId(trackId: string | null | undefined, trackUrl: string | null | undefined = ""): string {
  const normalizedTrackId = String(trackId ?? "").trim();
  if (normalizedTrackId) {
    return normalizedTrackId;
  }

  const normalizedTrackUrl = String(trackUrl ?? "").trim();
  if (!normalizedTrackUrl) {
    return "";
  }

  const spotifyUriMatch = normalizedTrackUrl.match(/^spotify:track:([A-Za-z0-9]+)$/i);
  if (spotifyUriMatch?.[1]) {
    return spotifyUriMatch[1];
  }

  const openSpotifyMatch = normalizedTrackUrl.match(/spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (openSpotifyMatch?.[1]) {
    return openSpotifyMatch[1];
  }

  return "";
}

function buildSpotifyTrackLinks(
  trackId: string | null | undefined,
  trackUrl: string | null | undefined = "",
): {
  spotifyUri: string;
  webUrl: string;
} {
  const resolvedTrackId = extractSpotifyTrackId(trackId, trackUrl);
  const spotifyUri = resolvedTrackId ? `spotify:track:${resolvedTrackId}` : "";
  const fallbackTrackUrl = String(trackUrl ?? "").trim();
  const webUrl = resolvedTrackId
    ? `https://open.spotify.com/track/${encodeURIComponent(resolvedTrackId)}`
    : fallbackTrackUrl;
  return {
    spotifyUri,
    webUrl,
  };
}

export async function openSpotifyTrackIntent(
  trackId: string | null | undefined,
  trackUrl: string | null | undefined = "",
): Promise<boolean> {
  const links = buildSpotifyTrackLinks(trackId, trackUrl);
  if (!links.spotifyUri && !links.webUrl) {
    return false;
  }

  const openExternalUrl = window.electronAPI?.openExternalUrl;
  if (typeof openExternalUrl === "function") {
    if (links.spotifyUri) {
      try {
        const result = await openExternalUrl({ url: links.spotifyUri });
        if (result?.opened) {
          return true;
        }
      } catch {
        // Fall through to the web URL.
      }
    }

    if (links.webUrl) {
      try {
        const result = await openExternalUrl({ url: links.webUrl });
        return result?.opened === true;
      } catch {
        return false;
      }
    }

    return false;
  }

  if (!isBrowser()) {
    return false;
  }

  let fallbackTimerId: number | null = null;
  let visibilityHandled = false;

  const handleVisibilityChange = (): void => {
    if (document.visibilityState !== "hidden") {
      return;
    }
    visibilityHandled = true;
    if (fallbackTimerId !== null) {
      window.clearTimeout(fallbackTimerId);
      fallbackTimerId = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (links.webUrl) {
    fallbackTimerId = window.setTimeout(() => {
      if (!visibilityHandled) {
        window.open(links.webUrl, "_blank", "noopener,noreferrer");
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, SPOTIFY_LISTEN_ALONG_BROWSER_FALLBACK_DELAY_MS);
  }

  if (links.spotifyUri) {
    const anchor = document.createElement("a");
    anchor.href = links.spotifyUri;
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
  }

  document.removeEventListener("visibilitychange", handleVisibilityChange);
  if (fallbackTimerId !== null) {
    window.clearTimeout(fallbackTimerId);
  }
  if (links.webUrl) {
    window.open(links.webUrl, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}

function resolveCurrentPlayback(connection: SpotifyConnectionState): SpotifyPlaybackState | null {
  if (!connection.connected || !connection.showOnProfile || !connection.playback) {
    return null;
  }
  if (connection.playback.isPlaying === false) {
    return null;
  }
  if (!isSpotifyPlaybackStillActive(connection.playback, connection.updatedAt)) {
    return null;
  }
  return connection.playback;
}

export function getSpotifyListenAlongAvailability(
  listenerUserId: string | null | undefined,
): SpotifyListenAlongAvailability {
  const connection = readSpotifyConnection(listenerUserId);
  if (!connection.connected) {
    return {
      available: false,
      reason: "spotify_not_connected",
      connection,
    };
  }
  if (!isSpotifyConnectionPremium(connection)) {
    return {
      available: false,
      reason: "spotify_premium_required",
      connection,
    };
  }
  return {
    available: true,
    reason: null,
    connection,
  };
}

export function resolveSpotifyListenAlongFailureMessage(
  reason: SpotifyListenAlongUnavailableReason,
): string {
  switch (reason) {
    case "spotify_not_connected":
      return "Conecte sua conta do Spotify para usar Ouvir junto.";
    case "spotify_premium_required":
      return "Voce precisa do Spotify Premium para usar Ouvir junto.";
    case "host_not_listening":
      return "Esse usuario nao esta ouvindo Spotify agora.";
    default:
      return "Nao foi possivel iniciar a sessao de ouvir junto.";
  }
}

async function withBroadcastChannel<T>(
  hostUserId: string,
  callback: (channel: ReturnType<typeof supabase.channel>) => Promise<T>,
): Promise<T> {
  const channel = supabase.channel(`${buildRealtimeChannelName(hostUserId)}:${Math.random().toString(36).slice(2)}`, {
    config: {
      broadcast: {
        ack: false,
        self: false,
      },
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("listen-along-broadcast-timeout"));
      }, SPOTIFY_LISTEN_ALONG_SEND_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (settled) {
          return;
        }
        if (status === "SUBSCRIBED") {
          settled = true;
          window.clearTimeout(timeoutId);
          resolve();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          settled = true;
          window.clearTimeout(timeoutId);
          reject(new Error(`listen-along-broadcast-${status.toLowerCase()}`));
        }
      });
    });

    return await callback(channel);
  } finally {
    void supabase.removeChannel(channel);
  }
}

async function sendBroadcastEvent(hostUserId: string, event: string, payload: unknown): Promise<void> {
  if (!isBrowser()) {
    return;
  }

  await withBroadcastChannel(hostUserId, async (channel) => {
    await channel.send({
      type: "broadcast",
      event,
      payload,
    });
  });
}

function buildListenerSessionFromSync(
  listenerUserId: string,
  payload: ListenAlongSessionSyncPayload,
  currentSession?: SpotifyListenAlongSession | null,
): SpotifyListenAlongSession {
  const resolvedListenerUserId = resolveId(listenerUserId);
  const matchedParticipant =
    payload.participants.find((participant) => participant.userId === resolvedListenerUserId) ?? null;

  return normalizeSession(
    {
      v: 1,
      active: Boolean(matchedParticipant),
      listenerUserId: resolvedListenerUserId,
      hostUserId: payload.hostUserId,
      listenerDisplayName: matchedParticipant?.displayName ?? currentSession?.listenerDisplayName ?? "",
      listenerAvatarSrc: matchedParticipant?.avatarSrc ?? currentSession?.listenerAvatarSrc ?? "",
      hostDisplayName: payload.hostDisplayName,
      hostAvatarSrc: payload.hostAvatarSrc,
      trackId: payload.trackId,
      trackTitle: payload.trackTitle,
      trackUrl: payload.trackUrl,
      updatedAt: payload.updatedAt,
      participants: payload.participants,
      endedReason: null,
    },
    resolvedListenerUserId,
    payload.hostUserId,
  );
}

export async function joinSpotifyListenAlongSession(
  options: JoinSpotifyListenAlongSessionOptions,
): Promise<JoinSpotifyListenAlongSessionResult> {
  const listenerUserId = resolveId(options.listenerUserId);
  const hostUserId = resolveId(options.hostUserId);
  if (!listenerUserId || !hostUserId || listenerUserId === hostUserId) {
    return {
      ok: false,
      reason: "invalid_session",
    };
  }

  const availability = getSpotifyListenAlongAvailability(listenerUserId);
  if (!availability.available && availability.reason) {
    return {
      ok: false,
      reason: availability.reason,
    };
  }

  const resolvedTrackId = extractSpotifyTrackId(options.trackId, options.trackUrl);
  const resolvedTrackTitle = String(options.trackTitle ?? "").trim();
  const resolvedTrackUrl = String(options.trackUrl ?? "").trim();
  if (!resolvedTrackId && !resolvedTrackUrl) {
    return {
      ok: false,
      reason: "host_not_listening",
    };
  }

  const participant = normalizeParticipant(
    {
      userId: listenerUserId,
      displayName: String(options.listenerDisplayName ?? "").trim(),
      avatarSrc: String(options.listenerAvatarSrc ?? "").trim(),
      joinedAt: nowIso(),
    },
    listenerUserId,
  );

  const nextSession = writeSpotifyListenAlongSession(listenerUserId, hostUserId, {
    v: 1,
    active: true,
    listenerUserId,
    hostUserId,
    listenerDisplayName: participant.displayName,
    listenerAvatarSrc: participant.avatarSrc,
    hostDisplayName: String(options.hostDisplayName ?? "").trim(),
    hostAvatarSrc: String(options.hostAvatarSrc ?? "").trim(),
    trackId: resolvedTrackId,
    trackTitle: resolvedTrackTitle,
    trackUrl: resolvedTrackUrl,
    updatedAt: nowIso(),
    participants: [participant],
    endedReason: null,
  });

  spotifyListenAlongService.markTrackOpened(hostUserId, nextSession.trackId);
  void openSpotifyTrackIntent(nextSession.trackId, nextSession.trackUrl);

  void sendBroadcastEvent(hostUserId, "join_request", {
    hostUserId,
    hostDisplayName: String(options.hostDisplayName ?? "").trim(),
    hostAvatarSrc: String(options.hostAvatarSrc ?? "").trim(),
    participant,
    updatedAt: nowIso(),
  } satisfies ListenAlongJoinRequestPayload).catch(() => undefined);

  return {
    ok: true,
    session: nextSession,
  };
}

export async function leaveSpotifyListenAlongSession(
  listenerUserId: string | null | undefined,
  hostUserId: string | null | undefined,
  options: {
    reason?: string | null;
  } = {},
): Promise<SpotifyListenAlongSession> {
  const resolvedListenerUserId = resolveId(listenerUserId);
  const resolvedHostUserId = resolveId(hostUserId);
  const currentSession = readSpotifyListenAlongSession(resolvedListenerUserId, resolvedHostUserId);
  const nextSession = writeSpotifyListenAlongSession(resolvedListenerUserId, resolvedHostUserId, {
    ...currentSession,
    active: false,
    updatedAt: nowIso(),
    endedReason: String(options.reason ?? "").trim() || null,
  });

  void sendBroadcastEvent(resolvedHostUserId, "leave_request", {
    hostUserId: resolvedHostUserId,
    participantUserId: resolvedListenerUserId,
    updatedAt: nowIso(),
    reason: nextSession.endedReason,
  } satisfies ListenAlongLeaveRequestPayload).catch(() => undefined);

  spotifyListenAlongService.clearOpenedTrack(resolvedHostUserId);
  return nextSession;
}

class SpotifyListenAlongService {
  private currentUserId: string | null = null;
  private hostChannel: ReturnType<typeof supabase.channel> | null = null;
  private hostChannelSubscribed = false;
  private listenerChannels = new Map<string, ReturnType<typeof supabase.channel>>();
  private releaseWatchedHosts: (() => void) | null = null;
  private unsubscribePresenceStore: (() => void) | null = null;
  private unsubscribeSpotifyConnection: (() => void) | null = null;
  private unsubscribeLocalSessions: (() => void) | null = null;
  private openedTrackIdsByHost = new Map<string, string>();

  start(currentUserId: string): void {
    this.stop();

    const normalizedUserId = resolveId(currentUserId);
    if (!normalizedUserId || !isBrowser()) {
      return;
    }

    this.currentUserId = normalizedUserId;
    this.bindHostChannel(normalizedUserId);
    this.unsubscribeSpotifyConnection = subscribeSpotifyConnection(
      normalizedUserId,
      (connection) => {
        void this.handleHostConnectionUpdate(connection);
      },
      {
        enablePolling: false,
      },
    );

    this.unsubscribeLocalSessions = this.subscribeToLocalSessionChanges(() => {
      this.syncListenerRuntime();
    });
    this.unsubscribePresenceStore = subscribePresenceStore(() => {
      this.handlePresenceStoreUpdate();
    });

    this.syncListenerRuntime();
    void this.handleHostConnectionUpdate(readSpotifyConnection(normalizedUserId));
  }

  stop(): void {
    this.currentUserId = null;
    this.hostChannelSubscribed = false;
    this.unsubscribeSpotifyConnection?.();
    this.unsubscribeSpotifyConnection = null;
    this.unsubscribePresenceStore?.();
    this.unsubscribePresenceStore = null;
    this.unsubscribeLocalSessions?.();
    this.unsubscribeLocalSessions = null;
    this.releaseWatchedHosts?.();
    this.releaseWatchedHosts = null;
    if (this.hostChannel) {
      void supabase.removeChannel(this.hostChannel);
      this.hostChannel = null;
    }
    this.listenerChannels.forEach((channel) => {
      void supabase.removeChannel(channel);
    });
    this.listenerChannels.clear();
    this.openedTrackIdsByHost.clear();
  }

  markTrackOpened(hostUserId: string, trackId: string): void {
    const resolvedHostUserId = resolveId(hostUserId);
    const resolvedTrackId = resolveId(trackId);
    if (!resolvedHostUserId || !resolvedTrackId) {
      return;
    }
    this.openedTrackIdsByHost.set(resolvedHostUserId, resolvedTrackId);
  }

  clearOpenedTrack(hostUserId: string): void {
    const resolvedHostUserId = resolveId(hostUserId);
    if (!resolvedHostUserId) {
      return;
    }
    this.openedTrackIdsByHost.delete(resolvedHostUserId);
  }

  private subscribeToLocalSessionChanges(listener: () => void): () => void {
    const handleCustomEvent = (event: Event): void => {
      const detail = (event as CustomEvent<SpotifyListenAlongUpdatedDetail>).detail;
      if (!detail || resolveId(detail.listenerUserId) !== this.currentUserId) {
        return;
      }
      listener();
    };

    const handleStorage = (event: StorageEvent): void => {
      if (!event.key?.startsWith(SPOTIFY_LISTEN_ALONG_STORAGE_KEY_PREFIX)) {
        return;
      }
      listener();
    };

    window.addEventListener(SPOTIFY_LISTEN_ALONG_UPDATED_EVENT, handleCustomEvent as EventListener);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(SPOTIFY_LISTEN_ALONG_UPDATED_EVENT, handleCustomEvent as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }

  private bindHostChannel(hostUserId: string): void {
    const channel = supabase.channel(buildRealtimeChannelName(hostUserId), {
      config: {
        broadcast: {
          ack: false,
          self: false,
        },
      },
    });

    channel
      .on("broadcast", { event: "join_request" }, (payload) => {
        void this.handleJoinRequest(payload.payload);
      })
      .on("broadcast", { event: "leave_request" }, (payload) => {
        void this.handleLeaveRequest(payload.payload);
      });

    this.hostChannel = channel;
    channel.subscribe((status) => {
      this.hostChannelSubscribed = status === "SUBSCRIBED";
    });
  }

  private syncListenerRuntime(): void {
    if (!this.currentUserId || !isBrowser()) {
      return;
    }

    const activeSessions = listStoredListenerSessions(this.currentUserId).filter(
      (session) => session.active && session.hostUserId && session.hostUserId !== this.currentUserId,
    );
    const activeHostIds = Array.from(
      new Set(
        activeSessions
          .map((session) => resolveId(session.hostUserId))
          .filter((hostUserId) => Boolean(hostUserId)),
      ),
    );

    this.releaseWatchedHosts?.();
    this.releaseWatchedHosts = activeHostIds.length > 0 ? watchPresenceUsers(activeHostIds) : null;

    const activeHostIdSet = new Set(activeHostIds);
    this.listenerChannels.forEach((channel, hostUserId) => {
      if (activeHostIdSet.has(hostUserId)) {
        return;
      }
      void supabase.removeChannel(channel);
      this.listenerChannels.delete(hostUserId);
      this.openedTrackIdsByHost.delete(hostUserId);
    });

    activeHostIds.forEach((hostUserId) => {
      if (this.listenerChannels.has(hostUserId)) {
        return;
      }

      const channel = supabase.channel(`${buildRealtimeChannelName(hostUserId)}:listener:${this.currentUserId}`, {
        config: {
          broadcast: {
            ack: false,
            self: false,
          },
        },
      });

      channel
        .on("broadcast", { event: "session_sync" }, (payload) => {
          this.handleSessionSync(hostUserId, payload.payload);
        })
        .on("broadcast", { event: "session_end" }, (payload) => {
          this.handleSessionEnd(hostUserId, payload.payload);
        })
        .subscribe();

      this.listenerChannels.set(hostUserId, channel);
    });
  }

  private async handleJoinRequest(payload: unknown): Promise<void> {
    if (!this.currentUserId) {
      return;
    }

    const normalized = payload as Partial<ListenAlongJoinRequestPayload> | null;
    if (!normalized || resolveId(normalized.hostUserId) !== this.currentUserId) {
      return;
    }

    const participant = normalizeParticipant(normalized.participant ?? null);
    if (!participant.userId || participant.userId === this.currentUserId) {
      return;
    }

    const connection = readSpotifyConnection(this.currentUserId);
    const playback = resolveCurrentPlayback(connection);
    if (!playback) {
      await this.endHostedSession("host_stopped");
      return;
    }

    const currentState = readSpotifyListenAlongHostState(this.currentUserId);
    const nextParticipants = normalizeParticipants([
      ...currentState.participants.filter((entry) => entry.userId !== participant.userId),
      participant,
    ]);

    const nextState = writeSpotifyListenAlongHostState(this.currentUserId, {
      v: 1,
      active: true,
      hostUserId: this.currentUserId,
      hostDisplayName: currentState.hostDisplayName || String(normalized.hostDisplayName ?? "").trim(),
      hostAvatarSrc: currentState.hostAvatarSrc || String(normalized.hostAvatarSrc ?? "").trim(),
      trackId: extractSpotifyTrackId(playback.trackId, playback.trackUrl),
      trackTitle: String(playback.trackTitle ?? "").trim(),
      trackUrl: String(playback.trackUrl ?? "").trim(),
      updatedAt: nowIso(),
      participants: nextParticipants,
    });

    await this.broadcastSessionSync(nextState);
  }

  private async handleLeaveRequest(payload: unknown): Promise<void> {
    if (!this.currentUserId) {
      return;
    }

    const normalized = payload as Partial<ListenAlongLeaveRequestPayload> | null;
    if (!normalized || resolveId(normalized.hostUserId) !== this.currentUserId) {
      return;
    }

    const participantUserId = resolveId(normalized.participantUserId);
    if (!participantUserId) {
      return;
    }

    const currentState = readSpotifyListenAlongHostState(this.currentUserId);
    const nextParticipants = currentState.participants.filter(
      (participant) => participant.userId !== participantUserId,
    );
    const nextState = writeSpotifyListenAlongHostState(this.currentUserId, {
      ...currentState,
      active: nextParticipants.length > 0,
      participants: nextParticipants,
      updatedAt: nowIso(),
    });

    if (nextParticipants.length === 0) {
      return;
    }

    await this.broadcastSessionSync(nextState);
  }

  private async handleHostConnectionUpdate(connection: SpotifyConnectionState): Promise<void> {
    if (!this.currentUserId) {
      return;
    }

    const currentState = readSpotifyListenAlongHostState(this.currentUserId);
    if (!currentState.active || currentState.participants.length === 0) {
      return;
    }

    const playback = resolveCurrentPlayback(connection);
    if (!playback) {
      await this.endHostedSession("host_stopped");
      return;
    }

    const nextTrackId = extractSpotifyTrackId(playback.trackId, playback.trackUrl);
    const nextTrackTitle = String(playback.trackTitle ?? "").trim();
    const nextTrackUrl = String(playback.trackUrl ?? "").trim();

    if (
      currentState.trackId === nextTrackId &&
      currentState.trackTitle === nextTrackTitle &&
      currentState.trackUrl === nextTrackUrl
    ) {
      return;
    }

    const nextState = writeSpotifyListenAlongHostState(this.currentUserId, {
      ...currentState,
      trackId: nextTrackId,
      trackTitle: nextTrackTitle,
      trackUrl: nextTrackUrl,
      updatedAt: nowIso(),
    });

    await this.broadcastSessionSync(nextState);
  }

  private async broadcastSessionSync(state: SpotifyListenAlongHostState): Promise<void> {
    if (!this.hostChannel || !this.hostChannelSubscribed || !state.active || state.participants.length === 0) {
      return;
    }

    const payload: ListenAlongSessionSyncPayload = {
      hostUserId: state.hostUserId,
      hostDisplayName: state.hostDisplayName,
      hostAvatarSrc: state.hostAvatarSrc,
      trackId: state.trackId,
      trackTitle: state.trackTitle,
      trackUrl: state.trackUrl,
      updatedAt: state.updatedAt,
      participants: state.participants,
    };

    await this.hostChannel.send({
      type: "broadcast",
      event: "session_sync",
      payload,
    });
  }

  private async endHostedSession(reason: string): Promise<void> {
    if (!this.currentUserId) {
      return;
    }

    const currentState = readSpotifyListenAlongHostState(this.currentUserId);
    if (!currentState.active && currentState.participants.length === 0) {
      return;
    }

    writeSpotifyListenAlongHostState(this.currentUserId, {
      ...currentState,
      active: false,
      participants: [],
      updatedAt: nowIso(),
    });

    if (!this.hostChannel || !this.hostChannelSubscribed) {
      return;
    }

    await this.hostChannel.send({
      type: "broadcast",
      event: "session_end",
      payload: {
        hostUserId: this.currentUserId,
        updatedAt: nowIso(),
        reason,
      } satisfies ListenAlongSessionEndPayload,
    });
  }

  private handleSessionSync(hostUserId: string, payload: unknown): void {
    if (!this.currentUserId) {
      return;
    }

    const normalized = payload as Partial<ListenAlongSessionSyncPayload> | null;
    if (!normalized || resolveId(normalized.hostUserId) !== resolveId(hostUserId)) {
      return;
    }

    const nextPayload: ListenAlongSessionSyncPayload = {
      hostUserId: resolveId(normalized.hostUserId),
      hostDisplayName: String(normalized.hostDisplayName ?? "").trim(),
      hostAvatarSrc: String(normalized.hostAvatarSrc ?? "").trim(),
      trackId: extractSpotifyTrackId(normalized.trackId, normalized.trackUrl),
      trackTitle: String(normalized.trackTitle ?? "").trim(),
      trackUrl: String(normalized.trackUrl ?? "").trim(),
      updatedAt: resolveIsoTimestamp(normalized.updatedAt),
      participants: normalizeParticipants(normalized.participants),
    };

    const currentSession = readSpotifyListenAlongSession(this.currentUserId, hostUserId);
    const nextSession = buildListenerSessionFromSync(this.currentUserId, nextPayload, currentSession);
    const shouldOpenTrack =
      nextSession.active &&
      Boolean(nextSession.trackId) &&
      currentSession.trackId !== nextSession.trackId &&
      this.openedTrackIdsByHost.get(hostUserId) !== nextSession.trackId;

    writeSpotifyListenAlongSession(this.currentUserId, hostUserId, nextSession);

    if (shouldOpenTrack) {
      this.markTrackOpened(hostUserId, nextSession.trackId);
      void openSpotifyTrackIntent(nextSession.trackId, nextSession.trackUrl);
    }
  }

  private handleSessionEnd(hostUserId: string, payload: unknown): void {
    if (!this.currentUserId) {
      return;
    }

    const normalized = payload as Partial<ListenAlongSessionEndPayload> | null;
    if (!normalized || resolveId(normalized.hostUserId) !== resolveId(hostUserId)) {
      return;
    }

    const currentSession = readSpotifyListenAlongSession(this.currentUserId, hostUserId);
    if (!currentSession.active) {
      return;
    }

    writeSpotifyListenAlongSession(this.currentUserId, hostUserId, {
      ...currentSession,
      active: false,
      updatedAt: resolveIsoTimestamp(normalized.updatedAt),
      endedReason: String(normalized.reason ?? "").trim() || "host_stopped",
    });
    this.clearOpenedTrack(hostUserId);
  }

  private handlePresenceStoreUpdate(): void {
    if (!this.currentUserId) {
      return;
    }

    const activeSessions = listStoredListenerSessions(this.currentUserId).filter((session) => session.active);
    activeSessions.forEach((session) => {
      const hostUserId = resolveId(session.hostUserId);
      if (!hostUserId) {
        return;
      }

      const snapshot = getPresenceSnapshot(hostUserId);
      const activity = snapshot.spotifyActivity;
      if (!activity) {
        writeSpotifyListenAlongSession(this.currentUserId, hostUserId, {
          ...session,
          active: false,
          updatedAt: nowIso(),
          endedReason: "host_stopped",
        });
        this.clearOpenedTrack(hostUserId);
        return;
      }

      const nextTrackId = extractSpotifyTrackId(activity.trackId, activity.trackUrl);
      if (
        !nextTrackId ||
        nextTrackId === session.trackId ||
        this.openedTrackIdsByHost.get(hostUserId) === nextTrackId
      ) {
        return;
      }

      const nextSession = writeSpotifyListenAlongSession(this.currentUserId, hostUserId, {
        ...session,
        trackId: nextTrackId,
        trackTitle: String(activity.trackTitle ?? "").trim(),
        trackUrl: String(activity.trackUrl ?? "").trim(),
        updatedAt: nowIso(),
        endedReason: null,
      });

      this.markTrackOpened(hostUserId, nextTrackId);
      void openSpotifyTrackIntent(nextSession.trackId, nextSession.trackUrl);
    });
  }
}

export const spotifyListenAlongService = new SpotifyListenAlongService();
