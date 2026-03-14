import type { Consumer, Device, RtpParameters, Transport } from "mediasoup-client/types";
import type { CallDebugLogger } from "./types";

export interface ConsumerRequestFn {
  (op: string, payload: Record<string, unknown>, expectedOp: string): Promise<Record<string, unknown>>;
}

interface ConsumerManagerOptions {
  request: ConsumerRequestFn;
  onRemoteStreamUpdated?: (stream: MediaStream | null) => void;
  debugLog?: CallDebugLogger;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toId(value: unknown): string {
  return String(value ?? "").trim();
}

export class ConsumerManager {
  private readonly request: ConsumerRequestFn;
  private readonly onRemoteStreamUpdated: (stream: MediaStream | null) => void;
  private readonly debugLog: CallDebugLogger;
  private readonly consumers = new Map<string, Consumer>();
  private remoteStream: MediaStream | null = null;

  constructor(options: ConsumerManagerOptions) {
    this.request = options.request;
    this.onRemoteStreamUpdated = typeof options.onRemoteStreamUpdated === "function" ? options.onRemoteStreamUpdated : () => {};
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  }

  getRemoteStream(): MediaStream | null {
    if (!this.remoteStream) {
      return null;
    }
    return new MediaStream(this.remoteStream.getTracks());
  }

  hasConsumerForProducer(producerIdRaw: unknown): boolean {
    const producerId = toId(producerIdRaw);
    if (!producerId) {
      return false;
    }
    return this.consumers.has(producerId);
  }

  getAudioConsumerCount(): number {
    let count = 0;
    for (const consumer of this.consumers.values()) {
      if (String(consumer.kind ?? "").trim().toLowerCase() === "audio") {
        count += 1;
      }
    }
    return count;
  }

  getPrimaryRemoteAudioTrack(): MediaStreamTrack | null {
    if (!this.remoteStream) {
      return null;
    }
    for (const track of this.remoteStream.getAudioTracks()) {
      if (track.readyState === "live") {
        return track;
      }
    }
    return null;
  }

  async consumeProducer(
    producerPayloadRaw: Record<string, unknown>,
    recvTransport: Transport | null,
    device: Device | null,
  ): Promise<void> {
    if (!recvTransport || recvTransport.closed || !device) {
      return;
    }

    const producerPayload = toRecord(producerPayloadRaw);
    const producerId = toId(producerPayload.producerId);
    const kind = String(producerPayload.kind ?? "").trim().toLowerCase();
    if (!producerId || (kind !== "audio" && kind !== "video") || this.consumers.has(producerId)) {
      return;
    }

    const created = await this.request("CONSUME", {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.recvRtpCapabilities,
    }, "CONSUMER_CREATED");

    const consumerId = toId(created.id);
    const rtpParameters = created.rtpParameters as RtpParameters | undefined;
    if (!consumerId || !rtpParameters) {
      return;
    }

    const consumer = await recvTransport.consume({
      id: consumerId,
      producerId,
      kind,
      rtpParameters,
      appData: toRecord(created.appData),
    });
    this.consumers.set(producerId, consumer);
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    this.remoteStream.addTrack(consumer.track);
    this.publishRemote();
    this.debugLog("consumer_created", {
      consumerId: consumer.id,
      producerId,
      kind,
    });

    consumer.track.onended = () => {
      this.debugLog("consumer_track_ended", {
        consumerId: consumer.id,
        producerId,
        kind,
      });
      this.removeConsumerByProducerId(producerId, "track-ended");
    };

    consumer.on("transportclose", () => {
      this.removeConsumerByProducerId(producerId, "transport-close");
    });

    await this.request("CONSUMER_RESUME", { consumerId }, "CONSUMER_RESUMED").catch(() => undefined);
  }

  removeProducer(producerIdRaw: unknown): void {
    const producerId = toId(producerIdRaw);
    if (!producerId) {
      return;
    }
    this.removeConsumerByProducerId(producerId, "producer-removed");
  }

  clear(reason = "clear"): void {
    for (const producerId of this.consumers.keys()) {
      this.removeConsumerByProducerId(producerId, reason);
    }
    this.consumers.clear();
    this.remoteStream = null;
    this.publishRemote();
  }

  private removeConsumerByProducerId(producerId: string, reason: string): void {
    const consumer = this.consumers.get(producerId);
    if (!consumer) {
      return;
    }
    this.consumers.delete(producerId);
    if (this.remoteStream) {
      this.remoteStream.removeTrack(consumer.track);
      if (this.remoteStream.getTracks().length === 0) {
        this.remoteStream = null;
      }
    }
    try {
      consumer.close();
    } catch {
      // Best effort.
    }
    this.debugLog("consumer_closed", {
      producerId,
      consumerId: consumer.id,
      reason,
    });
    this.publishRemote();
  }

  private publishRemote(): void {
    this.onRemoteStreamUpdated(this.remoteStream ? new MediaStream(this.remoteStream.getTracks()) : null);
  }
}
