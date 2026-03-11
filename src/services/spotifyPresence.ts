import {
  readSpotifyConnection,
  resolveSpotifyPlaybackProgressSeconds,
  subscribeSpotifyConnection,
  syncSpotifyConnection,
  type SpotifyConnectionState,
} from "./connections/spotifyConnection";
import { presenceActions } from "../stores/presenceSlice";
import { messlyStore } from "../stores/store";
import { gatewayService } from "./gateway";
import type { SpotifyActivityEntity } from "../stores/entities";

function buildSpotifyActivity(connection: SpotifyConnectionState): SpotifyActivityEntity | null {
  if (!connection.connected || !connection.showAsStatus || !connection.playback) {
    return null;
  }

  const playback = connection.playback;
  const duration = Math.max(0, Math.round(Number(playback.durationSeconds ?? 0)));
  if (!duration) {
    return null;
  }

  const updatedAtMs = Date.parse(connection.updatedAt);
  const startedAt =
    Number.isFinite(updatedAtMs)
      ? Math.max(0, updatedAtMs - Math.round(Number(playback.progressSeconds ?? 0) * 1000))
      : null;

  return {
    type: "spotify",
    trackId: String(playback.trackId ?? "").trim(),
    title: String(playback.trackTitle ?? "").trim(),
    artist: String(playback.artistNames ?? "").trim(),
    album: null,
    albumArtUrl: String(playback.coverUrl ?? "").trim(),
    duration,
    progress: Math.max(
      0,
      Math.round(resolveSpotifyPlaybackProgressSeconds(playback, connection.updatedAt)),
    ),
    isPlaying: playback.isPlaying !== false,
    startedAt,
    endedAt: null,
    trackUrl: String(playback.trackUrl ?? "").trim() || null,
    updatedAt: connection.updatedAt,
  };
}

class SpotifyPresenceService {
  private unsubscribe: (() => void) | null = null;
  private currentUserId: string | null = null;
  private lastFingerprint = "";

  async start(currentUserId: string): Promise<void> {
    this.stop();
    this.currentUserId = currentUserId;

    const initial = readSpotifyConnection(currentUserId);
    this.applyConnection(initial);

    try {
      const result = await syncSpotifyConnection(currentUserId);
      this.applyConnection(result.connection);
    } catch {
      // Spotify sync failures are non-fatal for the realtime runtime.
    }

    this.unsubscribe = subscribeSpotifyConnection(
      currentUserId,
      (connection) => {
        this.applyConnection(connection);
      },
      {
        enablePolling: false,
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentUserId = null;
    this.lastFingerprint = "";
  }

  private applyConnection(connection: SpotifyConnectionState): void {
    if (!this.currentUserId) {
      return;
    }

    const activity = buildSpotifyActivity(connection);
    const currentPresence = messlyStore.getState().presence.entities[this.currentUserId];
    const nextPresence = {
      userId: this.currentUserId,
      status: currentPresence?.status ?? "online",
      activities: activity ? [activity] : [],
      lastSeen: currentPresence?.lastSeen ?? new Date().toISOString(),
      updatedAt: connection.updatedAt,
    } as const;

    messlyStore.dispatch(presenceActions.presenceUpserted(nextPresence));

    const fingerprint = JSON.stringify(nextPresence);
    if (fingerprint === this.lastFingerprint) {
      return;
    }
    this.lastFingerprint = fingerprint;

    void gatewayService.publish("SPOTIFY_UPDATE", {
      userId: this.currentUserId,
      status: nextPresence.status,
      activity,
    });
  }
}

export const spotifyPresenceService = new SpotifyPresenceService();
