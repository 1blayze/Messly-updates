import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RtpCapabilities } from "mediasoup/types";
import type { Logger } from "../logging/logger";
import { validateGatewayJwt } from "../auth/jwtValidator";
import {
  type MediasoupSfuConfig,
  MediasoupSfu,
  type SfuCreatePeerTransportsResult,
  type SfuProducerSnapshot,
} from "../sfu/mediasoupSfu";

type UpgradeSocket = Duplex;

type VoiceMode = "audio" | "video";
type VoiceRole = "caller" | "callee";

interface VoiceFrame<TPayload = unknown> {
  op: string;
  d: TPayload;
}

interface VoiceAuthPayload {
  token: string;
  callId: string;
  conversationId: string;
  mode: VoiceMode;
  role: VoiceRole;
  roomId?: string | null;
  resumeToken?: string | null;
}

interface VoiceTransportConnectPayload {
  transportId: string;
  dtlsParameters: unknown;
}

interface VoiceProducePayload {
  transportId: string;
  kind: "audio" | "video";
  rtpParameters: unknown;
  appData?: Record<string, unknown> | null;
}

interface VoiceConsumePayload {
  transportId: string;
  producerId: string;
  rtpCapabilities: RtpCapabilities;
}

interface VoiceConsumerResumePayload {
  consumerId: string;
}

interface VoiceProducerControlPayload {
  producerId: string;
}

interface VoiceSpeakingPayload {
  speaking: boolean;
  level?: number | null;
}

interface VoiceConnection {
  connectionId: string;
  socket: WebSocket;
  authenticated: boolean;
  userId: string | null;
  callId: string | null;
  participantId: string | null;
  resumeToken: string | null;
  roomId: string | null;
}

interface VoiceParticipantStream {
  producerId: string;
  streamId: string;
  kind: "audio" | "video";
  source: "camera" | "screen" | "microphone" | "unknown";
}

interface VoiceParticipant {
  participantId: string;
  userId: string;
  role: VoiceRole;
  connected: boolean;
  speaking: boolean;
  speakingLevel: number | null;
  resumeToken: string;
  joinedAt: string;
  lastSeenAt: string;
  streams: Map<string, VoiceParticipantStream>;
}

interface VoiceCallSession {
  callId: string;
  conversationId: string;
  roomId: string;
  mode: VoiceMode;
  encryptionKey: string;
  createdAt: string;
  updatedAt: string;
  participants: Map<string, VoiceParticipant>;
}

export interface VoiceServerOptions {
  supabase: SupabaseClient;
  logger: Logger;
  maxPayloadBytes: number;
  sfuConfig: MediasoupSfuConfig;
  participantResumeTtlMs?: number;
  emptyCallTtlMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function decodeRawMessage(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return Buffer.from(String(raw ?? ""), "utf8").toString("utf8");
}

function parseFrame(raw: string): VoiceFrame | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceFrame>;
    const op = String(parsed?.op ?? "").trim().toUpperCase();
    if (!op) {
      return null;
    }
    return {
      op,
      d: parsed?.d ?? {},
    };
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toSafeToken(value: unknown): string {
  return String(value ?? "").trim();
}

function toSafeId(value: unknown, maxLength = 128): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function toVoiceMode(value: unknown): VoiceMode {
  return String(value ?? "").trim().toLowerCase() === "video" ? "video" : "audio";
}

function toVoiceRole(value: unknown): VoiceRole {
  return String(value ?? "").trim().toLowerCase() === "callee" ? "callee" : "caller";
}

function toVoiceAuthPayload(value: unknown): VoiceAuthPayload | null {
  const record = toRecord(value);
  const token = toSafeToken(record.token);
  const callId = toSafeId(record.callId);
  const conversationId = toSafeId(record.conversationId);
  if (!token || !callId || !conversationId) {
    return null;
  }
  return {
    token,
    callId,
    conversationId,
    mode: toVoiceMode(record.mode),
    role: toVoiceRole(record.role),
    roomId: toSafeId(record.roomId) || null,
    resumeToken: toSafeId(record.resumeToken, 256) || null,
  };
}

function toTransportConnectPayload(value: unknown): VoiceTransportConnectPayload | null {
  const record = toRecord(value);
  const transportId = toSafeId(record.transportId, 256);
  const dtlsParameters = record.dtlsParameters;
  if (!transportId || !dtlsParameters || typeof dtlsParameters !== "object") {
    return null;
  }
  return {
    transportId,
    dtlsParameters,
  };
}

function toProducePayload(value: unknown): VoiceProducePayload | null {
  const record = toRecord(value);
  const transportId = toSafeId(record.transportId, 256);
  const kind = String(record.kind ?? "").trim().toLowerCase();
  if (!transportId || (kind !== "audio" && kind !== "video")) {
    return null;
  }
  const rtpParameters = record.rtpParameters;
  if (!rtpParameters || typeof rtpParameters !== "object") {
    return null;
  }
  const appData = record.appData && typeof record.appData === "object" ? (record.appData as Record<string, unknown>) : null;
  return {
    transportId,
    kind,
    rtpParameters,
    appData,
  };
}

function toConsumePayload(value: unknown): VoiceConsumePayload | null {
  const record = toRecord(value);
  const transportId = toSafeId(record.transportId, 256);
  const producerId = toSafeId(record.producerId, 256);
  const rtpCapabilities = record.rtpCapabilities;
  if (!transportId || !producerId || !rtpCapabilities || typeof rtpCapabilities !== "object") {
    return null;
  }
  return {
    transportId,
    producerId,
    rtpCapabilities: rtpCapabilities as RtpCapabilities,
  };
}

function toConsumerResumePayload(value: unknown): VoiceConsumerResumePayload | null {
  const record = toRecord(value);
  const consumerId = toSafeId(record.consumerId, 256);
  if (!consumerId) {
    return null;
  }
  return {
    consumerId,
  };
}

function toProducerControlPayload(value: unknown): VoiceProducerControlPayload | null {
  const record = toRecord(value);
  const producerId = toSafeId(record.producerId, 256);
  if (!producerId) {
    return null;
  }
  return {
    producerId,
  };
}

function toSpeakingPayload(value: unknown): VoiceSpeakingPayload | null {
  const record = toRecord(value);
  const speakingRaw = record.speaking;
  if (typeof speakingRaw !== "boolean") {
    return null;
  }
  const levelRaw = Number(record.level ?? 0);
  const level = Number.isFinite(levelRaw) ? Math.max(0, Math.min(1, levelRaw)) : null;
  return {
    speaking: speakingRaw,
    level,
  };
}

function parseSource(value: unknown): VoiceParticipantStream["source"] {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "camera" || normalized === "screen" || normalized === "microphone") {
    return normalized;
  }
  return "unknown";
}

function randomEncryptionKey(): string {
  return randomBytes(32).toString("base64url");
}

export class VoiceServer {
  private readonly logger: Logger;
  private readonly supabase: SupabaseClient;
  private readonly participantResumeTtlMs: number;
  private readonly emptyCallTtlMs: number;
  private readonly wss: WebSocketServer;
  private readonly sfu: MediasoupSfu;
  private readonly connections = new Map<string, VoiceConnection>();
  private readonly calls = new Map<string, VoiceCallSession>();
  private readonly membershipCache = new Map<string, boolean>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: VoiceServerOptions) {
    this.logger = options.logger.child({ subsystem: "voice-server" });
    this.supabase = options.supabase;
    this.participantResumeTtlMs = options.participantResumeTtlMs ?? 5 * 60_000;
    this.emptyCallTtlMs = options.emptyCallTtlMs ?? 15 * 60_000;
    this.sfu = new MediasoupSfu(this.logger, options.sfuConfig);
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      perMessageDeflate: false,
    });
    this.wss.on("connection", (socket) => {
      this.handleConnection(socket);
    });
    this.sfu.on("producer-removed", (event) => {
      this.handleSfuProducerRemoved(event as { roomId: string; peerId: string; producerId: string });
    });
  }

  async start(): Promise<void> {
    await this.sfu.start();
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupStaleState();
      }, 30_000);
    }
    this.logger.info("voice_server_started", {});
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close(1001, "SERVER_SHUTDOWN");
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.calls.clear();
    this.membershipCache.clear();
    this.wss.close();
    await this.sfu.close();
    this.logger.info("voice_server_stopped", {});
  }

  handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wss.emit("connection", upgradedSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const connectionId = randomUUID();
    const connection: VoiceConnection = {
      connectionId,
      socket,
      authenticated: false,
      userId: null,
      callId: null,
      participantId: null,
      resumeToken: null,
      roomId: null,
    };
    this.connections.set(connectionId, connection);

    this.send(connection, "HELLO", {
      connectionId,
      heartbeatIntervalMs: 15_000,
      serverTime: nowIso(),
    });

    socket.on("message", (raw) => {
      void this.handleMessage(connection, raw);
    });
    socket.on("close", () => {
      void this.handleSocketClose(connection);
    });
    socket.on("error", (error) => {
      this.logger.warn("voice_socket_error", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleMessage(connection: VoiceConnection, raw: unknown): Promise<void> {
    const frame = parseFrame(decodeRawMessage(raw));
    if (!frame) {
      this.sendError(connection, "INVALID_PAYLOAD", "Payload de voz invalido.");
      return;
    }

    try {
      switch (frame.op) {
        case "PING":
          this.send(connection, "PONG", {
            serverTime: nowIso(),
          });
          return;
        case "AUTH":
          await this.handleAuth(connection, frame.d);
          return;
        case "LEAVE":
          await this.handleLeave(connection);
          return;
        default:
          break;
      }

      if (!connection.authenticated || !connection.callId || !connection.participantId || !connection.roomId) {
        this.sendError(connection, "UNAUTHENTICATED", "Conexao de voz nao autenticada.");
        return;
      }

      switch (frame.op) {
        case "TRANSPORT_CONNECT":
          await this.handleTransportConnect(connection, frame.d);
          return;
        case "PRODUCE":
          await this.handleProduce(connection, frame.d);
          return;
        case "CONSUME":
          await this.handleConsume(connection, frame.d);
          return;
        case "CONSUMER_RESUME":
          await this.handleConsumerResume(connection, frame.d);
          return;
        case "PRODUCER_PAUSE":
          await this.handleProducerPause(connection, frame.d);
          return;
        case "PRODUCER_RESUME":
          await this.handleProducerResume(connection, frame.d);
          return;
        case "SPEAKING":
          await this.handleSpeaking(connection, frame.d);
          return;
        default:
          this.sendError(connection, "UNSUPPORTED_OP", `Operacao de voz nao suportada: ${frame.op}`);
      }
    } catch (error) {
      this.logger.warn("voice_message_failed", {
        connectionId: connection.connectionId,
        op: frame.op,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendError(
        connection,
        "VOICE_OPERATION_FAILED",
        error instanceof Error ? error.message : "Falha ao processar operacao de voz.",
      );
    }
  }

  private async handleAuth(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toVoiceAuthPayload(payloadRaw);
    if (!payload) {
      this.sendError(connection, "INVALID_AUTH", "Payload AUTH invalido.");
      return;
    }

    const user = await validateGatewayJwt(this.supabase, payload.token, undefined, {
      requireSession: false,
    });
    if (!user) {
      this.sendError(connection, "UNAUTHENTICATED", "Token de voz invalido ou expirado.");
      connection.socket.close(4001, "UNAUTHENTICATED");
      return;
    }

    const canAccessConversation = await this.canAccessConversation(user.id, payload.conversationId);
    if (!canAccessConversation) {
      this.sendError(connection, "FORBIDDEN", "Usuario nao tem acesso a conversa da chamada.");
      return;
    }

    const now = nowIso();
    let call = this.calls.get(payload.callId) ?? null;
    if (!call) {
      call = {
        callId: payload.callId,
        conversationId: payload.conversationId,
        roomId: toSafeId(payload.roomId ?? payload.callId, 128) || payload.callId,
        mode: payload.mode,
        encryptionKey: randomEncryptionKey(),
        createdAt: now,
        updatedAt: now,
        participants: new Map(),
      };
      this.calls.set(call.callId, call);
      this.logger.info("voice_call_created", {
        callId: call.callId,
        conversationId: call.conversationId,
        roomId: call.roomId,
        mode: call.mode,
      });
    }

    if (call.conversationId !== payload.conversationId) {
      this.sendError(connection, "CALL_MISMATCH", "Conversa da chamada nao confere.");
      return;
    }

    const existingParticipantByUser = call.participants.get(user.id);
    let participant = existingParticipantByUser ?? null;
    if (payload.resumeToken && participant && participant.resumeToken === payload.resumeToken) {
      // Resume path keeps participant identity.
    } else if (!participant) {
      participant = {
        participantId: randomUUID(),
        userId: user.id,
        role: payload.role,
        connected: false,
        speaking: false,
        speakingLevel: null,
        resumeToken: randomUUID(),
        joinedAt: now,
        lastSeenAt: now,
        streams: new Map(),
      };
      call.participants.set(user.id, participant);
    } else {
      participant.role = payload.role;
      participant.resumeToken = randomUUID();
    }

    const previousConnection = this.findActiveConnectionByParticipant(call.callId, participant.participantId);
    if (previousConnection && previousConnection.connectionId !== connection.connectionId) {
      this.send(previousConnection, "RECONNECT_REQUIRED", {
        reason: "SESSION_REPLACED",
      });
      try {
        previousConnection.socket.close(4009, "SESSION_REPLACED");
      } catch {
        // ignore
      }
    }

    participant.connected = true;
    participant.speaking = false;
    participant.speakingLevel = null;
    participant.lastSeenAt = now;
    participant.streams.clear();
    call.updatedAt = now;

    const transports = await this.sfu.createPeerTransports(call.roomId, participant.participantId);

    connection.authenticated = true;
    connection.userId = user.id;
    connection.callId = call.callId;
    connection.participantId = participant.participantId;
    connection.resumeToken = participant.resumeToken;
    connection.roomId = call.roomId;

    const participantsSnapshot = this.serializeParticipants(call);
    const producerSnapshots = this.sfu.getProducerSnapshots(call.roomId, participant.participantId);

    this.send(connection, "AUTH_OK", {
      call: {
        callId: call.callId,
        conversationId: call.conversationId,
        roomId: call.roomId,
        mode: call.mode,
        encryptionKey: call.encryptionKey,
        createdAt: call.createdAt,
        updatedAt: call.updatedAt,
      },
      participant: this.serializeParticipant(participant),
      resumeToken: participant.resumeToken,
      transports: transports,
      participants: participantsSnapshot,
      producers: producerSnapshots.map((snapshot) => this.serializeProducerSnapshot(call, snapshot)),
      reconnect: {
        participantResumeTtlMs: this.participantResumeTtlMs,
        emptyCallTtlMs: this.emptyCallTtlMs,
      },
      serverTime: now,
    });

    this.broadcastToCall(
      call.callId,
      "PARTICIPANT_JOINED",
      {
        callId: call.callId,
        participant: this.serializeParticipant(participant),
        participants: participantsSnapshot,
      },
      connection.connectionId,
    );
  }

  private async handleTransportConnect(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toTransportConnectPayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_TRANSPORT_CONNECT", "Payload de transporte invalido.");
      return;
    }
    await this.sfu.connectTransport(
      connection.roomId,
      connection.participantId,
      payload.transportId,
      payload.dtlsParameters as never,
    );
    this.send(connection, "TRANSPORT_CONNECTED", {
      transportId: payload.transportId,
    });
  }

  private async handleProduce(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toProducePayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_PRODUCE", "Payload PRODUCE invalido.");
      return;
    }
    const call = this.calls.get(connection.callId);
    if (!call) {
      this.sendError(connection, "CALL_NOT_FOUND", "Chamada de voz nao encontrada.");
      return;
    }
    const participant = this.findParticipantById(call, connection.participantId);
    if (!participant) {
      this.sendError(connection, "PARTICIPANT_NOT_FOUND", "Participante nao encontrado.");
      return;
    }

    const requestedSource = parseSource(payload.appData?.source);
    const streamId = toSafeId(payload.appData?.streamId, 128) || randomUUID();

    const producerSnapshot = await this.sfu.produce({
      roomId: connection.roomId,
      peerId: connection.participantId,
      transportId: payload.transportId,
      kind: payload.kind,
      rtpParameters: payload.rtpParameters as never,
      appData: {
        ...payload.appData,
        streamId,
        source: requestedSource,
      },
    });
    participant.streams.set(producerSnapshot.producerId, {
      producerId: producerSnapshot.producerId,
      streamId,
      kind: producerSnapshot.kind,
      source: requestedSource,
    });
    participant.lastSeenAt = nowIso();
    call.updatedAt = participant.lastSeenAt;

    this.send(connection, "PRODUCED", {
      producerId: producerSnapshot.producerId,
      streamId,
      kind: producerSnapshot.kind,
      source: requestedSource,
    });
    this.broadcastToCall(
      connection.callId,
      "PRODUCER_ADDED",
      this.serializeProducerSnapshot(call, producerSnapshot),
      connection.connectionId,
    );
  }

  private async handleConsume(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toConsumePayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_CONSUME", "Payload CONSUME invalido.");
      return;
    }
    const call = this.calls.get(connection.callId);
    if (!call) {
      this.sendError(connection, "CALL_NOT_FOUND", "Chamada de voz nao encontrada.");
      return;
    }

    const consumed = await this.sfu.consume({
      roomId: connection.roomId,
      peerId: connection.participantId,
      transportId: payload.transportId,
      producerId: payload.producerId,
      rtpCapabilities: payload.rtpCapabilities,
    });

    const ownerParticipant = this.findParticipantById(call, consumed.peerId);
    this.send(connection, "CONSUMER_CREATED", {
      id: consumed.id,
      producerId: consumed.producerId,
      participantId: consumed.peerId,
      userId: ownerParticipant?.userId ?? null,
      kind: consumed.kind,
      rtpParameters: consumed.rtpParameters,
      appData: consumed.appData,
    });
  }

  private async handleConsumerResume(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toConsumerResumePayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_CONSUMER_RESUME", "Payload CONSUMER_RESUME invalido.");
      return;
    }
    await this.sfu.resumeConsumer(connection.roomId, connection.participantId, payload.consumerId);
    this.send(connection, "CONSUMER_RESUMED", {
      consumerId: payload.consumerId,
    });
  }

  private async handleProducerPause(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toProducerControlPayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_PRODUCER_PAUSE", "Payload PRODUCER_PAUSE invalido.");
      return;
    }
    await this.sfu.pauseProducer(connection.roomId, connection.participantId, payload.producerId);
    this.send(connection, "PRODUCER_PAUSED", {
      producerId: payload.producerId,
    });
  }

  private async handleProducerResume(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toProducerControlPayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId || !connection.roomId) {
      this.sendError(connection, "INVALID_PRODUCER_RESUME", "Payload PRODUCER_RESUME invalido.");
      return;
    }
    await this.sfu.resumeProducer(connection.roomId, connection.participantId, payload.producerId);
    this.send(connection, "PRODUCER_RESUMED", {
      producerId: payload.producerId,
    });
  }

  private async handleSpeaking(connection: VoiceConnection, payloadRaw: unknown): Promise<void> {
    const payload = toSpeakingPayload(payloadRaw);
    if (!payload || !connection.callId || !connection.participantId) {
      this.sendError(connection, "INVALID_SPEAKING", "Payload SPEAKING invalido.");
      return;
    }
    const call = this.calls.get(connection.callId);
    if (!call) {
      return;
    }
    const participant = this.findParticipantById(call, connection.participantId);
    if (!participant) {
      return;
    }

    participant.speaking = payload.speaking;
    participant.speakingLevel = payload.level ?? null;
    participant.lastSeenAt = nowIso();
    call.updatedAt = participant.lastSeenAt;
    this.broadcastToCall(
      connection.callId,
      "SPEAKING",
      {
        participantId: participant.participantId,
        userId: participant.userId,
        speaking: participant.speaking,
        level: participant.speakingLevel,
      },
      null,
    );
  }

  private async handleLeave(connection: VoiceConnection): Promise<void> {
    await this.handleSocketClose(connection);
    try {
      connection.socket.close(1000, "LEFT_CALL");
    } catch {
      // ignore
    }
  }

  private async handleSocketClose(connection: VoiceConnection): Promise<void> {
    if (!this.connections.has(connection.connectionId)) {
      return;
    }
    this.connections.delete(connection.connectionId);

    if (!connection.authenticated || !connection.callId || !connection.participantId || !connection.roomId) {
      return;
    }

    const call = this.calls.get(connection.callId);
    if (!call) {
      return;
    }

    const replacementConnection = this.findActiveConnectionByParticipant(connection.callId, connection.participantId);
    if (replacementConnection && replacementConnection.connectionId !== connection.connectionId) {
      this.logger.info("voice_socket_close_ignored_replaced_connection", {
        callId: connection.callId,
        staleConnectionId: connection.connectionId,
        replacementConnectionId: replacementConnection.connectionId,
        participantId: connection.participantId,
      });
      return;
    }

    const participant = this.findParticipantById(call, connection.participantId);
    if (!participant) {
      return;
    }

    participant.connected = false;
    participant.speaking = false;
    participant.speakingLevel = null;
    participant.lastSeenAt = nowIso();
    call.updatedAt = participant.lastSeenAt;

    this.sfu.closePeer(connection.roomId, connection.participantId);

    this.broadcastToCall(
      connection.callId,
      "PARTICIPANT_LEFT",
      {
        callId: connection.callId,
        participantId: participant.participantId,
        userId: participant.userId,
        participants: this.serializeParticipants(call),
      },
      null,
    );
  }

  private handleSfuProducerRemoved(event: { roomId: string; peerId: string; producerId: string }): void {
    const call = this.findCallByRoomId(event.roomId);
    if (!call) {
      return;
    }
    const participant = this.findParticipantById(call, event.peerId);
    if (participant) {
      participant.streams.delete(event.producerId);
      participant.lastSeenAt = nowIso();
      call.updatedAt = participant.lastSeenAt;
    }
    this.broadcastToCall(call.callId, "PRODUCER_REMOVED", {
      producerId: event.producerId,
      participantId: event.peerId,
      userId: participant?.userId ?? null,
    });
  }

  private serializeParticipants(call: VoiceCallSession): Array<Record<string, unknown>> {
    return [...call.participants.values()].map((participant) => this.serializeParticipant(participant));
  }

  private serializeParticipant(participant: VoiceParticipant): Record<string, unknown> {
    return {
      participantId: participant.participantId,
      userId: participant.userId,
      role: participant.role,
      connected: participant.connected,
      speaking: participant.speaking,
      speakingLevel: participant.speakingLevel,
      joinedAt: participant.joinedAt,
      lastSeenAt: participant.lastSeenAt,
      streams: [...participant.streams.values()].map((stream) => ({
        producerId: stream.producerId,
        streamId: stream.streamId,
        kind: stream.kind,
        source: stream.source,
      })),
    };
  }

  private serializeProducerSnapshot(
    call: VoiceCallSession,
    snapshot: SfuProducerSnapshot,
  ): Record<string, unknown> {
    const participant = this.findParticipantById(call, snapshot.peerId);
    const stream = participant?.streams.get(snapshot.producerId) ?? null;
    return {
      producerId: snapshot.producerId,
      participantId: snapshot.peerId,
      userId: participant?.userId ?? null,
      kind: snapshot.kind,
      appData: snapshot.appData,
      streamId: stream?.streamId ?? (toSafeId(snapshot.appData.streamId, 128) || snapshot.producerId),
      source: stream?.source ?? parseSource(snapshot.appData.source),
    };
  }

  private send(connection: VoiceConnection, op: string, payload: unknown): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame: VoiceFrame = {
      op,
      d: payload,
    };
    connection.socket.send(JSON.stringify(frame));
  }

  private sendError(connection: VoiceConnection, code: string, message: string): void {
    this.send(connection, "ERROR", {
      code,
      message,
      timestamp: nowIso(),
    });
  }

  private broadcastToCall(
    callId: string,
    op: string,
    payload: unknown,
    excludeConnectionId: string | null = null,
  ): void {
    for (const connection of this.connections.values()) {
      if (!connection.authenticated || connection.callId !== callId) {
        continue;
      }
      if (excludeConnectionId && connection.connectionId === excludeConnectionId) {
        continue;
      }
      this.send(connection, op, payload);
    }
  }

  private findActiveConnectionByParticipant(callId: string, participantId: string): VoiceConnection | null {
    for (const connection of this.connections.values()) {
      if (!connection.authenticated) {
        continue;
      }
      if (connection.callId === callId && connection.participantId === participantId) {
        return connection;
      }
    }
    return null;
  }

  private findParticipantById(call: VoiceCallSession, participantId: string): VoiceParticipant | null {
    for (const participant of call.participants.values()) {
      if (participant.participantId === participantId) {
        return participant;
      }
    }
    return null;
  }

  private findCallByRoomId(roomId: string): VoiceCallSession | null {
    for (const call of this.calls.values()) {
      if (call.roomId === roomId) {
        return call;
      }
    }
    return null;
  }

  private cleanupStaleState(): void {
    const nowMs = Date.now();
    for (const call of this.calls.values()) {
      for (const [userId, participant] of call.participants.entries()) {
        if (participant.connected) {
          continue;
        }
        const lastSeenMs = Date.parse(participant.lastSeenAt);
        if (!Number.isFinite(lastSeenMs)) {
          continue;
        }
        if (nowMs - lastSeenMs > this.participantResumeTtlMs) {
          call.participants.delete(userId);
        }
      }

      const connectedCount = [...call.participants.values()].filter((participant) => participant.connected).length;
      if (connectedCount > 0) {
        continue;
      }

      const updatedAtMs = Date.parse(call.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        continue;
      }
      if (nowMs - updatedAtMs > this.emptyCallTtlMs) {
        this.sfu.closeRoom(call.roomId);
        this.calls.delete(call.callId);
        this.logger.info("voice_call_collected", {
          callId: call.callId,
          roomId: call.roomId,
        });
      }
    }
  }

  private async canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    const cacheKey = `${userId}:${conversationId}`;
    const cached = this.membershipCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const directResult = await this.supabase
      .from("conversations")
      .select("id,user1_id,user2_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!directResult.error && directResult.data) {
      const allowed =
        String(directResult.data.user1_id ?? "") === userId ||
        String(directResult.data.user2_id ?? "") === userId;
      this.membershipCache.set(cacheKey, allowed);
      return allowed;
    }

    const memberResult = await this.supabase
      .from("conversation_members")
      .select("conversation_id,user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    const allowed = !memberResult.error && memberResult.data != null;
    this.membershipCache.set(cacheKey, allowed);
    return allowed;
  }
}
