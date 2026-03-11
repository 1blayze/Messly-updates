export type PresenceState = "online" | "idle" | "dnd" | "invisivel";
export type PersistedPresenceStatus = "online" | "idle" | "dnd" | "invisible";
export type PresenceGatewayEventType =
  | "PRESENCE_UPDATE"
  | "ACTIVITY_UPDATE"
  | "SPOTIFY_UPDATE"
  | "USER_ONLINE"
  | "USER_OFFLINE";

export type PresencePlatform = "desktop" | "mobile" | "browser";

export const PRESENCE_STALE_AFTER_MS = 75_000;

export interface PresenceSpotifyActivity {
  type?: "spotify";
  provider: "spotify";
  showOnProfile?: boolean;
  trackId: string;
  trackTitle: string;
  artistNames: string;
  albumTitle?: string;
  trackUrl: string;
  coverUrl: string;
  progressSeconds: number;
  durationSeconds: number;
  isPlaying?: boolean;
  startedAt?: number;
  endsAt?: number;
  updatedAt: number;
}

export interface PresenceRecord {
  state: PresenceState;
  lastActive: number | null;
  platform: PresencePlatform;
  updatedAt: number | null;
  clientName?: string | null;
  osName?: string | null;
  locationLabel?: string | null;
  activity?: PresenceSpotifyActivity | null;
}

export interface PresenceTableRow {
  user_id: string;
  status: PersistedPresenceStatus | null;
  activities: unknown[] | null;
  last_seen: string | null;
  updated_at: string | null;
}

export interface PresenceSnapshot {
  userId: string;
  presenceState: PresenceState;
  activities: PresenceSpotifyActivity[];
  spotifyActivity: PresenceSpotifyActivity | null;
  lastSeen: string | null;
  updatedAt: string | null;
}

export interface PresenceGatewayEventPayload {
  event: PresenceGatewayEventType;
  user_id: string;
  status: PersistedPresenceStatus | null;
  activities?: unknown[] | null;
  timestamp?: string | null;
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  online: "Disponível",
  idle: "Ausente",
  dnd: "Não perturbar",
  invisivel: "Invisível",
};

export function normalizePresenceState(value: unknown): PresenceState {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return "invisivel";
  }
  if (raw === "online" || raw === "disponivel" || raw === "available") {
    return "online";
  }
  if (raw === "idle" || raw === "ausente" || raw === "away") {
    return "idle";
  }
  if (raw === "dnd" || raw === "nao perturbar" || raw === "busy") {
    return "dnd";
  }
  if (raw === "invisible" || raw === "invisivel" || raw === "hidden" || raw === "oculto") {
    return "invisivel";
  }
  return "invisivel";
}

export function toPersistedPresenceStatus(state: PresenceState): PersistedPresenceStatus {
  return state === "invisivel" ? "invisible" : state;
}

function parsePresenceTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    const candidate = value.getTime();
    return Number.isFinite(candidate) ? candidate : null;
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRoundedNonNegativeInt(value: unknown): number {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) {
    return 0;
  }
  return Math.max(0, Math.round(candidate));
}

export function normalizePresenceSpotifyActivity(value: unknown): PresenceSpotifyActivity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const casted = value as Record<string, unknown>;
  const providerRaw = String(casted.provider ?? casted.type ?? "spotify").trim().toLowerCase();
  if (providerRaw && providerRaw !== "spotify") {
    return null;
  }

  const trackTitle = String(casted.trackTitle ?? casted.title ?? "").trim();
  const artistNames = String(casted.artistNames ?? casted.artist ?? "").trim();
  if (!trackTitle || !artistNames) {
    return null;
  }

  const durationSeconds = toRoundedNonNegativeInt(casted.durationSeconds ?? casted.duration);
  const progressSecondsRaw = toRoundedNonNegativeInt(casted.progressSeconds ?? casted.progress);
  const progressSeconds =
    durationSeconds > 0 ? Math.min(progressSecondsRaw, durationSeconds) : progressSecondsRaw;

  const updatedAt =
    parsePresenceTimestamp(casted.updatedAt ?? casted.timestamp ?? null) ??
    Date.now();
  const startedAt = parsePresenceTimestamp(casted.startedAt ?? casted.started_at ?? null) ?? undefined;
  const endsAt = parsePresenceTimestamp(casted.endsAt ?? casted.ends_at ?? null) ?? undefined;
  const isPlaying =
    typeof casted.isPlaying === "boolean"
      ? casted.isPlaying
      : typeof casted.is_playing === "boolean"
        ? casted.is_playing
        : undefined;
  const showOnProfile =
    typeof casted.showOnProfile === "boolean"
      ? casted.showOnProfile
      : typeof casted.show_on_profile === "boolean"
        ? casted.show_on_profile
        : true;

  return {
    type: "spotify",
    provider: "spotify",
    showOnProfile,
    trackId: String(casted.trackId ?? casted.track_id ?? "").trim(),
    trackTitle,
    artistNames,
    albumTitle: String(casted.albumTitle ?? casted.album ?? "").trim() || undefined,
    trackUrl: String(casted.trackUrl ?? casted.track_url ?? "").trim(),
    coverUrl: String(casted.coverUrl ?? casted.albumArtUrl ?? casted.album_art_url ?? "").trim(),
    progressSeconds,
    durationSeconds,
    ...(typeof isPlaying === "boolean" ? { isPlaying } : {}),
    ...(typeof startedAt === "number" ? { startedAt } : {}),
    ...(typeof endsAt === "number" ? { endsAt } : {}),
    updatedAt,
  };
}

export function normalizePresenceActivities(value: unknown): PresenceSpotifyActivity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizePresenceSpotifyActivity(entry))
    .filter((entry): entry is PresenceSpotifyActivity => entry !== null);
}

export function arePresenceSpotifyActivitiesEqual(
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

  return (
    safeLeft.provider === safeRight.provider &&
    (safeLeft.showOnProfile ?? true) === (safeRight.showOnProfile ?? true) &&
    safeLeft.trackId === safeRight.trackId &&
    safeLeft.trackTitle === safeRight.trackTitle &&
    safeLeft.artistNames === safeRight.artistNames &&
    (safeLeft.albumTitle ?? "") === (safeRight.albumTitle ?? "") &&
    safeLeft.trackUrl === safeRight.trackUrl &&
    safeLeft.coverUrl === safeRight.coverUrl &&
    safeLeft.progressSeconds === safeRight.progressSeconds &&
    safeLeft.durationSeconds === safeRight.durationSeconds &&
    (safeLeft.isPlaying ?? true) === (safeRight.isPlaying ?? true)
  );
}

export function resolvePresenceStateFromRow(
  row: Pick<PresenceTableRow, "status" | "updated_at" | "last_seen"> | null | undefined,
  nowMs: number = Date.now(),
): PresenceState {
  const baseState = normalizePresenceState(row?.status ?? null);
  if (baseState === "invisivel") {
    return "invisivel";
  }

  const updatedAtMs = parsePresenceTimestamp(row?.updated_at) ?? parsePresenceTimestamp(row?.last_seen);
  if (updatedAtMs == null) {
    return baseState;
  }

  return nowMs - updatedAtMs > PRESENCE_STALE_AFTER_MS ? "invisivel" : baseState;
}

export function resolvePresenceSnapshotFromRow(
  row: PresenceTableRow | null | undefined,
  nowMs: number = Date.now(),
): PresenceSnapshot {
  const userId = String(row?.user_id ?? "").trim();
  const activities = normalizePresenceActivities(row?.activities ?? []);
  const presenceState = resolvePresenceStateFromRow(row, nowMs);
  const spotifyActivity = presenceState === "invisivel" ? null : activities[0] ?? null;

  return {
    userId,
    presenceState,
    activities,
    spotifyActivity,
    lastSeen: row?.last_seen ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}
