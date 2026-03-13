import { EventEmitter } from "node:events";
import * as mediasoup from "mediasoup";
import type {
  Consumer,
  DtlsParameters,
  Producer,
  RtpCapabilities,
  Router,
  RouterRtpCapabilities,
  RtpCodecCapability,
  RtpParameters,
  WebRtcTransport,
  Worker,
} from "mediasoup/types";
import type { Logger } from "../logging/logger";

export interface MediasoupSfuConfig {
  listenIp: string;
  announcedIp: string | null;
  rtcMinPort: number;
  rtcMaxPort: number;
  enableUdp: boolean;
  enableTcp: boolean;
  preferUdp: boolean;
  initialAvailableOutgoingBitrate: number;
  maxIncomingBitrate: number;
  mediaCodecs: RtpCodecCapability[];
}

export interface SfuTransportOptions {
  id: string;
  iceParameters: WebRtcTransport["iceParameters"];
  iceCandidates: WebRtcTransport["iceCandidates"];
  dtlsParameters: WebRtcTransport["dtlsParameters"];
  sctpParameters: WebRtcTransport["sctpParameters"];
}

export interface SfuCreatePeerTransportsResult {
  routerRtpCapabilities: RouterRtpCapabilities;
  sendTransport: SfuTransportOptions;
  recvTransport: SfuTransportOptions;
}

export interface SfuProducerSnapshot {
  producerId: string;
  peerId: string;
  kind: Producer["kind"];
  appData: Record<string, unknown>;
}

export interface SfuConsumeResult {
  id: string;
  producerId: string;
  peerId: string;
  kind: Consumer["kind"];
  rtpParameters: Consumer["rtpParameters"];
  appData: Record<string, unknown>;
}

interface SfuPeerState {
  peerId: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

interface SfuRoomState {
  roomId: string;
  router: Router;
  peers: Map<string, SfuPeerState>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function cloneTransportOptions(transport: WebRtcTransport): SfuTransportOptions {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters,
  };
}

export class MediasoupSfu extends EventEmitter {
  private readonly logger: Logger;
  private readonly config: MediasoupSfuConfig;
  private worker: Worker | null = null;
  private readonly rooms = new Map<string, SfuRoomState>();

  constructor(logger: Logger, config: MediasoupSfuConfig) {
    super();
    this.logger = logger.child({ subsystem: "mediasoup-sfu" });
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.worker) {
      return;
    }

    this.worker = await mediasoup.createWorker({
      rtcMinPort: this.config.rtcMinPort,
      rtcMaxPort: this.config.rtcMaxPort,
      logLevel: "warn",
    });
    this.worker.on("died", () => {
      this.logger.error("sfu_worker_died", {});
    });
    this.logger.info("sfu_worker_started", {
      rtcMinPort: this.config.rtcMinPort,
      rtcMaxPort: this.config.rtcMaxPort,
      listenIp: this.config.listenIp,
      announcedIp: this.config.announcedIp ?? null,
    });
  }

  async close(): Promise<void> {
    for (const roomId of this.rooms.keys()) {
      this.closeRoom(roomId);
    }
    this.rooms.clear();
    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }
  }

  async createPeerTransports(roomId: string, peerId: string): Promise<SfuCreatePeerTransportsResult> {
    const room = await this.getOrCreateRoom(roomId);
    const peer = this.getOrCreatePeer(room, peerId);

    this.closePeerTransports(peer);

    const sendTransport = await room.router.createWebRtcTransport({
      listenIps: this.config.announcedIp
        ? [{ ip: this.config.listenIp, announcedIp: this.config.announcedIp }]
        : [this.config.listenIp],
      enableUdp: this.config.enableUdp,
      enableTcp: this.config.enableTcp,
      preferUdp: this.config.preferUdp,
      initialAvailableOutgoingBitrate: this.config.initialAvailableOutgoingBitrate,
      appData: {
        peerId,
        role: "send",
      },
    });
    await sendTransport.setMaxIncomingBitrate(this.config.maxIncomingBitrate).catch(() => undefined);

    const recvTransport = await room.router.createWebRtcTransport({
      listenIps: this.config.announcedIp
        ? [{ ip: this.config.listenIp, announcedIp: this.config.announcedIp }]
        : [this.config.listenIp],
      enableUdp: this.config.enableUdp,
      enableTcp: this.config.enableTcp,
      preferUdp: this.config.preferUdp,
      initialAvailableOutgoingBitrate: this.config.initialAvailableOutgoingBitrate,
      appData: {
        peerId,
        role: "recv",
      },
    });
    await recvTransport.setMaxIncomingBitrate(this.config.maxIncomingBitrate).catch(() => undefined);

    peer.transports.set(sendTransport.id, sendTransport);
    peer.transports.set(recvTransport.id, recvTransport);

    sendTransport.on("routerclose", () => {
      peer.transports.delete(sendTransport.id);
    });

    recvTransport.on("routerclose", () => {
      peer.transports.delete(recvTransport.id);
    });

    return {
      routerRtpCapabilities: room.router.rtpCapabilities,
      sendTransport: cloneTransportOptions(sendTransport),
      recvTransport: cloneTransportOptions(recvTransport),
    };
  }

  async connectTransport(
    roomId: string,
    peerId: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    const transport = this.getTransport(roomId, peerId, transportId);
    await transport.connect({ dtlsParameters });
  }

  async produce(input: {
    roomId: string;
    peerId: string;
    transportId: string;
    kind: Producer["kind"];
    rtpParameters: RtpParameters;
    appData?: Record<string, unknown>;
  }): Promise<SfuProducerSnapshot> {
    const room = this.getRoomOrThrow(input.roomId);
    const peer = this.getPeerOrThrow(room, input.peerId);
    const transport = this.getTransport(input.roomId, input.peerId, input.transportId);

    const producer = await transport.produce({
      kind: input.kind,
      rtpParameters: input.rtpParameters,
      appData: input.appData ?? {},
    });
    peer.producers.set(producer.id, producer);

    const removeProducer = (): void => {
      if (!peer.producers.has(producer.id)) {
        return;
      }
      peer.producers.delete(producer.id);
      this.emit("producer-removed", {
        roomId: input.roomId,
        peerId: input.peerId,
        producerId: producer.id,
      });
    };

    producer.on("transportclose", removeProducer);

    const snapshot: SfuProducerSnapshot = {
      producerId: producer.id,
      peerId: input.peerId,
      kind: producer.kind,
      appData: toRecord(producer.appData),
    };
    this.emit("producer-added", {
      roomId: input.roomId,
      ...snapshot,
    });
    return snapshot;
  }

  async consume(input: {
    roomId: string;
    peerId: string;
    transportId: string;
    producerId: string;
    rtpCapabilities: RtpCapabilities;
  }): Promise<SfuConsumeResult> {
    const room = this.getRoomOrThrow(input.roomId);
    const peer = this.getPeerOrThrow(room, input.peerId);
    const transport = this.getTransport(input.roomId, input.peerId, input.transportId);
    if (!room.router.canConsume({ producerId: input.producerId, rtpCapabilities: input.rtpCapabilities })) {
      throw new Error("Producer cannot be consumed by this peer.");
    }

    const producerOwner = this.findProducerOwner(room, input.producerId);
    if (!producerOwner) {
      throw new Error("Producer owner not found.");
    }

    const consumer = await transport.consume({
      producerId: input.producerId,
      rtpCapabilities: input.rtpCapabilities,
      paused: true,
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => {
      peer.consumers.delete(consumer.id);
    });
    consumer.on("producerclose", () => {
      peer.consumers.delete(consumer.id);
      this.emit("producer-consumer-closed", {
        roomId: input.roomId,
        peerId: input.peerId,
        producerId: input.producerId,
        consumerId: consumer.id,
      });
    });

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      peerId: producerOwner,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: toRecord(consumer.appData),
    };
  }

  async resumeConsumer(roomId: string, peerId: string, consumerId: string): Promise<void> {
    const room = this.getRoomOrThrow(roomId);
    const peer = this.getPeerOrThrow(room, peerId);
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) {
      throw new Error("Consumer not found.");
    }
    await consumer.resume();
  }

  async pauseProducer(roomId: string, peerId: string, producerId: string): Promise<void> {
    const producer = this.getProducer(roomId, peerId, producerId);
    await producer.pause();
  }

  async resumeProducer(roomId: string, peerId: string, producerId: string): Promise<void> {
    const producer = this.getProducer(roomId, peerId, producerId);
    await producer.resume();
  }

  getProducerSnapshots(roomId: string, excludedPeerId?: string): SfuProducerSnapshot[] {
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }

    const snapshots: SfuProducerSnapshot[] = [];
    for (const peer of room.peers.values()) {
      if (excludedPeerId && peer.peerId === excludedPeerId) {
        continue;
      }
      for (const producer of peer.producers.values()) {
        snapshots.push({
          producerId: producer.id,
          peerId: peer.peerId,
          kind: producer.kind,
          appData: toRecord(producer.appData),
        });
      }
    }
    return snapshots;
  }

  closePeer(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    const peer = room.peers.get(peerId);
    if (!peer) {
      return;
    }

    for (const consumer of peer.consumers.values()) {
      consumer.close();
    }
    peer.consumers.clear();

    for (const producer of peer.producers.values()) {
      const producerId = producer.id;
      producer.close();
      this.emit("producer-removed", {
        roomId,
        peerId,
        producerId,
      });
    }
    peer.producers.clear();

    this.closePeerTransports(peer);
    room.peers.delete(peerId);
    this.emit("peer-closed", {
      roomId,
      peerId,
    });
    this.pruneRoomIfEmpty(roomId);
  }

  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    for (const peerId of room.peers.keys()) {
      this.closePeer(roomId, peerId);
    }
    room.router.close();
    this.rooms.delete(roomId);
  }

  private async getOrCreateRoom(roomId: string): Promise<SfuRoomState> {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    if (!this.worker) {
      await this.start();
    }
    if (!this.worker) {
      throw new Error("SFU worker is not available.");
    }

    const router = await this.worker.createRouter({
      mediaCodecs: this.config.mediaCodecs,
    });
    const room: SfuRoomState = {
      roomId,
      router,
      peers: new Map(),
    };
    this.rooms.set(roomId, room);
    this.logger.info("sfu_room_created", {
      roomId,
    });
    return room;
  }

  private getRoomOrThrow(roomId: string): SfuRoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error("SFU room not found.");
    }
    return room;
  }

  private getOrCreatePeer(room: SfuRoomState, peerId: string): SfuPeerState {
    const existing = room.peers.get(peerId);
    if (existing) {
      return existing;
    }
    const peer: SfuPeerState = {
      peerId,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    room.peers.set(peerId, peer);
    return peer;
  }

  private getPeerOrThrow(room: SfuRoomState, peerId: string): SfuPeerState {
    const peer = room.peers.get(peerId);
    if (!peer) {
      throw new Error("SFU peer not found.");
    }
    return peer;
  }

  private getTransport(roomId: string, peerId: string, transportId: string): WebRtcTransport {
    const room = this.getRoomOrThrow(roomId);
    const peer = this.getPeerOrThrow(room, peerId);
    const transport = peer.transports.get(transportId);
    if (!transport) {
      throw new Error("Transport not found.");
    }
    return transport;
  }

  private getProducer(roomId: string, peerId: string, producerId: string): Producer {
    const room = this.getRoomOrThrow(roomId);
    const peer = this.getPeerOrThrow(room, peerId);
    const producer = peer.producers.get(producerId);
    if (!producer) {
      throw new Error("Producer not found.");
    }
    return producer;
  }

  private findProducerOwner(room: SfuRoomState, producerId: string): string | null {
    for (const peer of room.peers.values()) {
      if (peer.producers.has(producerId)) {
        return peer.peerId;
      }
    }
    return null;
  }

  private closePeerTransports(peer: SfuPeerState): void {
    for (const consumer of peer.consumers.values()) {
      consumer.close();
    }
    peer.consumers.clear();

    for (const producer of peer.producers.values()) {
      producer.close();
    }
    peer.producers.clear();

    for (const transport of peer.transports.values()) {
      transport.close();
    }
    peer.transports.clear();
  }

  private pruneRoomIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    if (room.peers.size > 0) {
      return;
    }
    room.router.close();
    this.rooms.delete(roomId);
    this.logger.info("sfu_room_closed", {
      roomId,
    });
  }
}
