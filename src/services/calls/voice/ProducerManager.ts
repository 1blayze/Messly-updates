import type { Producer, Transport } from "mediasoup-client/types";
import type { CallDebugLogger } from "./types";
import { isTrackLive } from "./types";

function isRecoverableProducerError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
  return message.includes("queue stopped") || message.includes("invalidstateerror") || message.includes("track ended");
}

export class ProducerManager {
  private audioProducer: Producer | null = null;
  private videoProducer: Producer | null = null;
  private readonly debugLog: CallDebugLogger;

  constructor(debugLog?: CallDebugLogger) {
    this.debugLog = typeof debugLog === "function" ? debugLog : () => {};
  }

  async syncAudio(sendTransport: Transport | null, audioTrack: MediaStreamTrack | null): Promise<void> {
    if (!sendTransport || sendTransport.closed) {
      this.closeAudioProducer("missing-transport");
      return;
    }

    if (!isTrackLive(audioTrack)) {
      this.closeAudioProducer("track-not-live");
      throw new Error("track ended");
    }

    if (this.audioProducer?.closed) {
      this.audioProducer = null;
    }

    if (!this.audioProducer) {
      try {
        this.audioProducer = await sendTransport.produce({
          track: audioTrack,
          appData: { source: "microphone" },
        });
        this.audioProducer.on("transportclose", () => {
          this.audioProducer = null;
        });
        this.audioProducer.on("trackended", () => {
          this.debugLog("audio_producer_track_ended", {});
        });
        this.debugLog("producer_created", {
          kind: "audio",
          producerId: this.audioProducer.id,
        });
      } catch (error) {
        if (isRecoverableProducerError(error)) {
          this.closeAudioProducer("recoverable-create-error");
        }
        throw error instanceof Error ? error : new Error(String(error ?? "Failed to create audio producer."));
      }
      return;
    }

    if (this.audioProducer.track !== audioTrack) {
      try {
        await this.audioProducer.replaceTrack({ track: audioTrack });
        this.debugLog("producer_track_replaced", {
          kind: "audio",
          producerId: this.audioProducer.id,
        });
      } catch (error) {
        if (isRecoverableProducerError(error)) {
          this.closeAudioProducer("recoverable-replace-error");
        }
        throw error instanceof Error ? error : new Error(String(error ?? "Failed to replace audio track."));
      }
    }
  }

  async syncVideo(
    sendTransport: Transport | null,
    videoTrack: MediaStreamTrack | null,
    source: "screen" | "camera",
  ): Promise<void> {
    if (!sendTransport || sendTransport.closed) {
      this.closeVideoProducer("missing-transport");
      return;
    }

    if (!isTrackLive(videoTrack)) {
      this.closeVideoProducer("track-not-live");
      return;
    }

    if (this.videoProducer?.closed) {
      this.videoProducer = null;
    }

    if (!this.videoProducer) {
      this.videoProducer = await sendTransport.produce({
        track: videoTrack,
        appData: { source },
        encodings: source === "screen"
          ? [{ maxBitrate: 6_000_000 }]
          : [
              { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 150_000 },
              { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 500_000 },
              { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_800_000 },
            ],
      });
      this.videoProducer.on("transportclose", () => {
        this.videoProducer = null;
      });
      this.videoProducer.on("trackended", () => {
        this.debugLog("video_producer_track_ended", {});
      });
      this.debugLog("producer_created", {
        kind: "video",
        source,
        producerId: this.videoProducer.id,
      });
      return;
    }

    if (this.videoProducer.track !== videoTrack) {
      await this.videoProducer.replaceTrack({ track: videoTrack });
      this.debugLog("producer_track_replaced", {
        kind: "video",
        source,
        producerId: this.videoProducer.id,
      });
    }
  }

  closeAudioProducer(reason = "manual-close"): void {
    if (!this.audioProducer) {
      return;
    }
    const producerId = this.audioProducer.id;
    try {
      this.audioProducer.close();
    } catch {
      // Best effort.
    }
    this.audioProducer = null;
    this.debugLog("producer_closed", {
      kind: "audio",
      reason,
      producerId,
    });
  }

  closeVideoProducer(reason = "manual-close"): void {
    if (!this.videoProducer) {
      return;
    }
    const producerId = this.videoProducer.id;
    try {
      this.videoProducer.close();
    } catch {
      // Best effort.
    }
    this.videoProducer = null;
    this.debugLog("producer_closed", {
      kind: "video",
      reason,
      producerId,
    });
  }

  closeAll(reason = "close-all"): void {
    this.closeAudioProducer(reason);
    this.closeVideoProducer(reason);
  }
}
