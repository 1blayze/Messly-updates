import { Device } from "mediasoup-client";
import type { RtpCapabilities, Transport } from "mediasoup-client/types";
import type { CallDebugLogger } from "./types";

export interface VoiceSignalingRequester {
  (op: string, payload: Record<string, unknown>, expectedOp: string): Promise<Record<string, unknown>>;
}

interface TransportManagerOptions {
  request: VoiceSignalingRequester;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onTransportFailed: () => void;
  debugLog?: CallDebugLogger;
}

export class TransportManager {
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private generation = 0;
  private readonly request: VoiceSignalingRequester;
  private readonly onConnectionState: (state: RTCPeerConnectionState) => void;
  private readonly onTransportFailed: () => void;
  private readonly debugLog: CallDebugLogger;

  constructor(options: TransportManagerOptions) {
    this.request = options.request;
    this.onConnectionState = options.onConnectionState;
    this.onTransportFailed = options.onTransportFailed;
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  }

  getDevice(): Device | null {
    return this.device;
  }

  getSendTransport(): Transport | null {
    if (!this.sendTransport || this.sendTransport.closed) {
      return null;
    }
    return this.sendTransport;
  }

  getRecvTransport(): Transport | null {
    if (!this.recvTransport || this.recvTransport.closed) {
      return null;
    }
    return this.recvTransport;
  }

  async setup(
    routerRtpCapabilities: RtpCapabilities,
    sendTransportRaw: Record<string, unknown>,
    recvTransportRaw: Record<string, unknown>,
  ): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.closeTransports();

    if (!this.device) {
      this.device = await Device.factory();
      this.debugLog("device_created", {});
    }
    if (!this.device.loaded) {
      await this.device.load({ routerRtpCapabilities });
      this.debugLog("device_loaded", {});
    }

    const sendTransport = this.device.createSendTransport({
      id: String(sendTransportRaw.id),
      iceParameters: sendTransportRaw.iceParameters as never,
      iceCandidates: sendTransportRaw.iceCandidates as never,
      dtlsParameters: sendTransportRaw.dtlsParameters as never,
      sctpParameters: sendTransportRaw.sctpParameters as never,
    });
    const recvTransport = this.device.createRecvTransport({
      id: String(recvTransportRaw.id),
      iceParameters: recvTransportRaw.iceParameters as never,
      iceCandidates: recvTransportRaw.iceCandidates as never,
      dtlsParameters: recvTransportRaw.dtlsParameters as never,
      sctpParameters: recvTransportRaw.sctpParameters as never,
    });

    this.sendTransport = sendTransport;
    this.recvTransport = recvTransport;
    this.debugLog("transport_created", {
      sendTransportId: sendTransport.id,
      recvTransportId: recvTransport.id,
    });

    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      if (!this.isCurrentTransport(generation, sendTransport)) {
        errback(new Error("Stale send transport."));
        return;
      }
      void this.request("TRANSPORT_CONNECT", { transportId: sendTransport.id, dtlsParameters }, "TRANSPORT_CONNECTED")
        .then(() => callback())
        .catch((error) => errback(error));
    });

    recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      if (!this.isCurrentTransport(generation, recvTransport)) {
        errback(new Error("Stale recv transport."));
        return;
      }
      void this.request("TRANSPORT_CONNECT", { transportId: recvTransport.id, dtlsParameters }, "TRANSPORT_CONNECTED")
        .then(() => callback())
        .catch((error) => errback(error));
    });

    sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      if (!this.isCurrentTransport(generation, sendTransport)) {
        errback(new Error("Stale send transport."));
        return;
      }
      void this.request("PRODUCE", {
        transportId: sendTransport.id,
        kind,
        rtpParameters,
        appData,
      }, "PRODUCED")
        .then((payload) => {
          const producerId = String(payload.producerId ?? "").trim();
          if (!producerId) {
            throw new Error("PRODUCED without producerId.");
          }
          callback({ id: producerId });
        })
        .catch((error) => errback(error));
    });

    const onConnectionStateChange = (transportType: "send" | "recv", state: string): void => {
      if (!this.isCurrentTransport(generation, transportType === "send" ? sendTransport : recvTransport)) {
        return;
      }

      const normalized = String(state ?? "").trim().toLowerCase();
      if (normalized === "connected") {
        this.onConnectionState("connected");
      } else if (normalized === "failed") {
        this.onConnectionState("failed");
        this.onTransportFailed();
      } else if (normalized === "disconnected") {
        this.onConnectionState("disconnected");
        this.onTransportFailed();
      } else {
        this.onConnectionState("connecting");
      }

      this.debugLog("transport_connection_state", {
        transport: transportType,
        state: normalized || "unknown",
      });
    };

    sendTransport.on("connectionstatechange", (state) => {
      onConnectionStateChange("send", state);
    });
    recvTransport.on("connectionstatechange", (state) => {
      onConnectionStateChange("recv", state);
    });
  }

  closeTransports(): void {
    if (this.sendTransport) {
      try {
        this.sendTransport.close();
      } catch {
        // Best effort.
      }
    }
    if (this.recvTransport) {
      try {
        this.recvTransport.close();
      } catch {
        // Best effort.
      }
    }
    this.sendTransport = null;
    this.recvTransport = null;
  }

  destroy(): void {
    this.generation += 1;
    this.closeTransports();
    this.device = null;
  }

  private isCurrentTransport(generation: number, transport: Transport): boolean {
    if (generation !== this.generation) {
      return false;
    }
    if (transport.closed) {
      return false;
    }
    return this.sendTransport === transport || this.recvTransport === transport;
  }
}
