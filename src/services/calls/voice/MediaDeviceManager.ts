import type { CallMode } from "../callApi";
import type { CallDebugLogger, NormalizedAudioSettings } from "./types";
import { isTrackLive } from "./types";

export interface StartScreenCaptureOptions {
  sourceId?: string | null;
  quality?: string | null;
}

interface MediaDeviceManagerOptions {
  mode: CallMode;
  initialAudioSettings: NormalizedAudioSettings;
  initialCameraEnabled: boolean;
  captureAudioTrack: (settings: NormalizedAudioSettings) => Promise<MediaStreamTrack>;
  captureCameraTrack: () => Promise<MediaStreamTrack | null>;
  captureScreenTrack: (options?: StartScreenCaptureOptions) => Promise<MediaStreamTrack>;
  onLocalStreamUpdated?: (stream: MediaStream | null) => void;
  onTrackGraphChanged?: () => void;
  onAudioTrackRecovered?: () => void;
  onError?: (error: Error) => void;
  debugLog?: CallDebugLogger;
}

const MAX_AUDIO_TRACK_RECOVERY_ATTEMPTS = 3;
const AUDIO_TRACK_RECOVERY_WINDOW_MS = 20_000;

export class MediaDeviceManager {
  private mode: CallMode;
  private audioSettings: NormalizedAudioSettings;
  private cameraEnabled: boolean;
  private micEnabled = true;
  private pushToTalkPressed = false;
  private audioTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private readonly captureAudioTrack: (settings: NormalizedAudioSettings) => Promise<MediaStreamTrack>;
  private readonly captureCameraTrack: () => Promise<MediaStreamTrack | null>;
  private readonly captureScreenTrack: (options?: StartScreenCaptureOptions) => Promise<MediaStreamTrack>;
  private readonly onLocalStreamUpdated: (stream: MediaStream | null) => void;
  private readonly onTrackGraphChanged: () => void;
  private readonly onAudioTrackRecovered: () => void;
  private readonly onError: (error: Error) => void;
  private readonly debugLog: CallDebugLogger;
  private readonly intentionallyStoppedTracks = new WeakSet<MediaStreamTrack>();
  private destroyed = false;
  private audioRecoveryPromise: Promise<void> | null = null;
  private audioRecoveryWindowStartedAtMs = 0;
  private audioRecoveryAttemptsInWindow = 0;

  constructor(options: MediaDeviceManagerOptions) {
    this.mode = options.mode;
    this.audioSettings = options.initialAudioSettings;
    this.cameraEnabled = options.initialCameraEnabled;
    this.captureAudioTrack = options.captureAudioTrack;
    this.captureCameraTrack = options.captureCameraTrack;
    this.captureScreenTrack = options.captureScreenTrack;
    this.onLocalStreamUpdated = typeof options.onLocalStreamUpdated === "function" ? options.onLocalStreamUpdated : () => {};
    this.onTrackGraphChanged = typeof options.onTrackGraphChanged === "function" ? options.onTrackGraphChanged : () => {};
    this.onAudioTrackRecovered = typeof options.onAudioTrackRecovered === "function" ? options.onAudioTrackRecovered : () => {};
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  }

  getAudioSettings(): NormalizedAudioSettings {
    return { ...this.audioSettings };
  }

  setMode(mode: CallMode): void {
    this.mode = mode;
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  toggleMute(): boolean {
    this.micEnabled = !this.micEnabled;
    this.syncAudioEnabled();
    return this.micEnabled;
  }

  setPushToTalkEnabled(enabled: boolean): void {
    this.audioSettings = { ...this.audioSettings, pushToTalkEnabled: enabled };
    this.syncAudioEnabled();
  }

  setPushToTalkPressed(pressed: boolean): void {
    this.pushToTalkPressed = pressed;
    this.syncAudioEnabled();
  }

  isCameraEnabled(): boolean {
    return this.cameraEnabled;
  }

  toggleCamera(): boolean {
    this.cameraEnabled = !this.cameraEnabled;
    this.emitTrackGraphChanged();
    return this.cameraEnabled;
  }

  async updateAudioSettings(nextSettings: NormalizedAudioSettings): Promise<void> {
    this.audioSettings = nextSettings;
    await this.replaceAudioTrack(await this.captureAudioTrack(this.audioSettings), "settings-updated");
    this.syncAudioEnabled();
    this.emitTrackGraphChanged();
  }

  async ensureLocalTracks(): Promise<void> {
    if (!isTrackLive(this.audioTrack)) {
      await this.replaceAudioTrack(await this.captureAudioTrack(this.audioSettings), "ensure-local");
      this.syncAudioEnabled();
    }

    if (this.mode === "video" && !isTrackLive(this.cameraTrack)) {
      const cameraTrack = await this.captureCameraTrack();
      await this.replaceCameraTrack(cameraTrack, "ensure-local");
    }

    this.emitTrackGraphChanged();
  }

  getAudioTrack(): MediaStreamTrack | null {
    return isTrackLive(this.audioTrack) ? this.audioTrack : null;
  }

  getPreferredVideoTrack(): MediaStreamTrack | null {
    if (isTrackLive(this.screenTrack)) {
      return this.screenTrack;
    }
    if (this.cameraEnabled && isTrackLive(this.cameraTrack)) {
      return this.cameraTrack;
    }
    return null;
  }

  isScreenSharing(): boolean {
    return isTrackLive(this.screenTrack);
  }

  async startScreenShare(options?: StartScreenCaptureOptions): Promise<boolean> {
    const screenTrack = await this.captureScreenTrack(options);
    await this.replaceScreenTrack(screenTrack, "screen-share-started");
    this.emitTrackGraphChanged();
    return true;
  }

  async stopScreenShare(): Promise<void> {
    await this.replaceScreenTrack(null, "screen-share-stopped");
    this.emitTrackGraphChanged();
  }

  buildLocalStream(): MediaStream | null {
    const stream = new MediaStream();
    if (isTrackLive(this.audioTrack)) {
      stream.addTrack(this.audioTrack);
    }
    const videoTrack = this.getPreferredVideoTrack();
    if (videoTrack) {
      stream.addTrack(videoTrack);
    }
    if (stream.getTracks().length === 0) {
      return null;
    }
    return stream;
  }

  publishLocalStream(): void {
    const stream = this.buildLocalStream();
    this.onLocalStreamUpdated(stream ? new MediaStream(stream.getTracks()) : null);
  }

  closeAllTracks(): void {
    this.stopTrack(this.audioTrack);
    this.stopTrack(this.cameraTrack);
    this.stopTrack(this.screenTrack);
    this.audioTrack = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    this.publishLocalStream();
  }

  dispose(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.closeAllTracks();
  }

  private emitTrackGraphChanged(): void {
    this.publishLocalStream();
    this.onTrackGraphChanged();
  }

  private stopTrack(track: MediaStreamTrack | null): void {
    if (!track) {
      return;
    }
    this.intentionallyStoppedTracks.add(track);
    try {
      track.onended = null;
      track.stop();
    } catch {
      // Best effort.
    }
  }

  private async replaceAudioTrack(nextTrack: MediaStreamTrack, reason: string): Promise<void> {
    this.stopTrack(this.audioTrack);
    this.audioTrack = nextTrack;
    this.audioTrack.onended = () => {
      this.handleAudioTrackEnded(nextTrack);
    };
    this.debugLog("audio_track_ready", {
      reason,
      id: nextTrack.id,
      label: nextTrack.label,
    });
  }

  private async replaceCameraTrack(nextTrack: MediaStreamTrack | null, reason: string): Promise<void> {
    this.stopTrack(this.cameraTrack);
    this.cameraTrack = nextTrack;
    if (!nextTrack) {
      return;
    }
    nextTrack.onended = () => {
      if (this.destroyed || this.intentionallyStoppedTracks.has(nextTrack)) {
        return;
      }
      this.cameraTrack = null;
      this.debugLog("camera_track_ended", {
        reason: "device-ended",
      });
      this.emitTrackGraphChanged();
    };
    this.debugLog("camera_track_ready", {
      reason,
      id: nextTrack.id,
      label: nextTrack.label,
    });
  }

  private async replaceScreenTrack(nextTrack: MediaStreamTrack | null, reason: string): Promise<void> {
    this.stopTrack(this.screenTrack);
    this.screenTrack = nextTrack;
    if (!nextTrack) {
      this.debugLog("screen_track_stopped", {
        reason,
      });
      return;
    }
    nextTrack.onended = () => {
      if (this.destroyed || this.intentionallyStoppedTracks.has(nextTrack)) {
        return;
      }
      this.screenTrack = null;
      this.debugLog("screen_track_ended", {
        reason: "device-ended",
      });
      this.emitTrackGraphChanged();
    };
    this.debugLog("screen_track_ready", {
      reason,
      id: nextTrack.id,
      label: nextTrack.label,
    });
  }

  private syncAudioEnabled(): void {
    if (!this.audioTrack) {
      return;
    }
    const enabled = this.micEnabled && (!this.audioSettings.pushToTalkEnabled || this.pushToTalkPressed);
    this.audioTrack.enabled = enabled;
    this.publishLocalStream();
  }

  private handleAudioTrackEnded(endedTrack: MediaStreamTrack): void {
    if (this.destroyed || this.intentionallyStoppedTracks.has(endedTrack)) {
      return;
    }
    if (this.audioTrack !== endedTrack) {
      return;
    }

    this.debugLog("audio_track_ended", {
      id: endedTrack.id,
      label: endedTrack.label,
    });
    void this.recoverAudioTrack();
  }

  private canRecoverAudioTrack(): boolean {
    const nowMs = Date.now();
    if (nowMs - this.audioRecoveryWindowStartedAtMs > AUDIO_TRACK_RECOVERY_WINDOW_MS) {
      this.audioRecoveryWindowStartedAtMs = nowMs;
      this.audioRecoveryAttemptsInWindow = 0;
    }
    if (this.audioRecoveryAttemptsInWindow >= MAX_AUDIO_TRACK_RECOVERY_ATTEMPTS) {
      return false;
    }
    this.audioRecoveryAttemptsInWindow += 1;
    return true;
  }

  private async recoverAudioTrack(): Promise<void> {
    if (this.audioRecoveryPromise) {
      return this.audioRecoveryPromise;
    }
    if (!this.canRecoverAudioTrack()) {
      this.debugLog("audio_track_recovery_limited", {
        attemptsInWindow: this.audioRecoveryAttemptsInWindow,
        windowMs: AUDIO_TRACK_RECOVERY_WINDOW_MS,
      });
      return;
    }

    this.audioRecoveryPromise = (async () => {
      try {
        const recoveredTrack = await this.captureAudioTrack(this.audioSettings);
        await this.replaceAudioTrack(recoveredTrack, "track-ended-recovery");
        this.syncAudioEnabled();
        this.emitTrackGraphChanged();
        this.onAudioTrackRecovered();
      } catch (error) {
        const casted = error instanceof Error ? error : new Error(String(error ?? "Failed to recover audio track."));
        this.onError(casted);
      }
    })().finally(() => {
      this.audioRecoveryPromise = null;
    });

    return this.audioRecoveryPromise;
  }
}
