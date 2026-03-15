import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { RedisManager } from "../redis/client";
import type { Logger } from "../logging/logger";
import { extractClientIpFromHeaders } from "../sessions/loginLocation";

const DEFAULT_VOICE_PATH = "/voice";
const DEFAULT_VOICE_CLUSTER_CHANNEL = "messly:voice:cluster";
const VOICE_ROOM_USER_LIMIT = 2;
const VOICE_RATE_LIMIT_WINDOW_MS = 10_000;
const VOICE_RATE_LIMIT_MAX_MESSAGES = 280;
const VOICE_ROOM_REDIS_KEY_PREFIX = "messly:voice:room:";
const VOICE_ROOM_REDIS_TTL_SECONDS = 120;
const VOICE_DISTRIBUTED_PARTICIPANT_STALE_MS = 90_000;

const sdpPayloadSchema = z.object({
  type: z.string().trim().min(1).max(32),
  sdp: z.string().min(1).max(200_000),
});

const joinMessageSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  displayName: z.string().trim().max(120).optional(),
  accessToken: z.string().trim().min(1).max(8_000).optional(),
});

const leaveMessageSchema = z.object({
  type: z.literal("leave"),
});

const offerMessageSchema = z.object({
  type: z.literal("offer"),
  targetUserId: z.string().trim().min(1).max(128),
  sdp: sdpPayloadSchema,
});

const answerMessageSchema = z.object({
  type: z.literal("answer"),
  targetUserId: z.string().trim().min(1).max(128),
  sdp: sdpPayloadSchema,
});

const iceCandidateMessageSchema = z.object({
  type: z.literal("ice-candidate"),
  targetUserId: z.string().trim().min(1).max(128),
  candidate: z.unknown(),
});

const muteStateMessageSchema = z.object({
  type: z.literal("mute-state"),
  muted: z.boolean(),
});

const speakingStateMessageSchema = z.object({
  type: z.literal("speaking-state"),
  speaking: z.boolean(),
  level: z.number().min(0).max(1).optional(),
});

const pingMessageSchema = z.object({
  type: z.literal("ping"),
  timestamp: z.number().finite().optional(),
});

const inboundVoiceMessageSchema = z.discriminatedUnion("type", [
  joinMessageSchema,
  leaveMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
  muteStateMessageSchema,
  speakingStateMessageSchema,
  pingMessageSchema,
]);

type InboundVoiceMessage = z.infer<typeof inboundVoiceMessageSchema>;

const distributedParticipantSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(120),
  muted: z.boolean(),
  speaking: z.boolean(),
  instanceId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128),
  updatedAt: z.number().finite(),
});

const clusterParticipantJoinedEventSchema = z.object({
  kind: z.literal("participant-joined"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  excludeUserId: z.string().trim().min(1).max(128).optional(),
  participant: z.object({
    userId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(120),
    muted: z.boolean(),
    speaking: z.boolean(),
  }),
});

const clusterParticipantLeftEventSchema = z.object({
  kind: z.literal("participant-left"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(64),
});

const clusterMuteStateEventSchema = z.object({
  kind: z.literal("participant-mute-state"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  muted: z.boolean(),
});

const clusterSpeakingStateEventSchema = z.object({
  kind: z.literal("participant-speaking-state"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  speaking: z.boolean(),
  level: z.number().min(0).max(1).optional(),
});

const clusterRelayEventSchema = z.object({
  kind: z.literal("relay"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  targetUserId: z.string().trim().min(1).max(128),
  fromUserId: z.string().trim().min(1).max(128),
  payloadType: z.enum(["offer", "answer", "ice-candidate"]),
  sdp: sdpPayloadSchema.optional(),
  candidate: z.unknown().optional(),
});

const clusterReplaceSessionEventSchema = z.object({
  kind: z.literal("replace-session"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  targetInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128).optional(),
  reason: z.string().trim().min(1).max(64),
});

const clusterEventSchema = z.discriminatedUnion("kind", [
  clusterParticipantJoinedEventSchema,
  clusterParticipantLeftEventSchema,
  clusterMuteStateEventSchema,
  clusterSpeakingStateEventSchema,
  clusterRelayEventSchema,
  clusterReplaceSessionEventSchema,
]);

type VoiceClusterEvent = z.infer<typeof clusterEventSchema>;
type VoiceDistributedParticipantDescriptor = z.infer<typeof distributedParticipantSchema>;

interface VoiceConnectionContext {
  connectionId: string;
  socket: WebSocket;
  ipAddress: string;
  userAgent: string | null;
  roomId: string | null;
  userId: string | null;
  displayName: string;
  muted: boolean;
  speaking: boolean;
  connectedAt: number;
}

interface VoiceParticipantDescriptor {
  userId: string;
  displayName: string;
  muted: boolean;
  speaking: boolean;
}

interface VoiceSignalingServerOptions {
  logger: Logger;
  maxPayloadBytes: number;
  isAllowedOrigin: (origin: string) => boolean;
  validateAccessToken?: (token: string) => Promise<{ id: string } | null>;
  path?: string;
  roomUserLimit?: number;
  redis?: RedisManager | null;
  instanceId?: string;
  clusterChannel?: string;
}

interface HandleUpgradeOptions {
  draining: boolean;
}

interface VoiceMessageRateWindow {
  startedAt: number;
  count: number;
}

function normalizePathname(pathnameRaw: string | null | undefined): string {
  const normalized = String(pathnameRaw ?? "").trim().replace(/\/+$/, "");
  return normalized || "/";
}

function toRoomRedisKey(roomId: string): string {
  return `${VOICE_ROOM_REDIS_KEY_PREFIX}${roomId}`;
}

function rejectUpgrade(socket: Duplex, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const statusText = status === 429
    ? "Too Many Requests"
    : status === 503
      ? "Service Unavailable"
      : status === 403
        ? "Forbidden"
        : "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${body.byteLength}\r\n\r\n`,
  );
  socket.write(body);
  socket.destroy();
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

export class VoiceSignalingServer {
  private readonly logger: Logger;
  private readonly path: string;
  private readonly roomUserLimit: number;
  private readonly isAllowedOrigin: (origin: string) => boolean;
  private readonly validateAccessToken: ((token: string) => Promise<{ id: string } | null>) | null;
  private readonly redis: RedisManager | null;
  private readonly instanceId: string;
  private readonly clusterChannel: string;
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Map<string, VoiceConnectionContext>>();
  private readonly connections = new Map<WebSocket, VoiceConnectionContext>();
  private readonly rateWindows = new Map<string, VoiceMessageRateWindow>();
  private clusterSubscribed = false;

  private readonly handleRedisMessage = (channel: string, payload: string): void => {
    if (channel !== this.clusterChannel) {
      return;
    }
    this.handleClusterMessage(payload);
  };

  constructor(options: VoiceSignalingServerOptions) {
    this.logger = options.logger;
    this.path = normalizePathname(options.path ?? DEFAULT_VOICE_PATH);
    this.roomUserLimit = Math.max(2, Math.min(16, Math.round(options.roomUserLimit ?? VOICE_ROOM_USER_LIMIT)));
    this.isAllowedOrigin = options.isAllowedOrigin;
    this.validateAccessToken = options.validateAccessToken ?? null;
    this.redis = options.redis ?? null;
    this.instanceId = String(options.instanceId ?? "").trim() || randomUUID();
    this.clusterChannel = String(options.clusterChannel ?? DEFAULT_VOICE_CLUSTER_CHANNEL).trim() || DEFAULT_VOICE_CLUSTER_CHANNEL;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      perMessageDeflate: false,
    });

    this.wss.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });
  }

  async start(): Promise<void> {
    if (!this.redis || this.clusterSubscribed) {
      return;
    }

    this.redis.subscriber.on("message", this.handleRedisMessage);
    await this.redis.subscriber.subscribe(this.clusterChannel);
    this.clusterSubscribed = true;
  }

  getPath(): string {
    return this.path;
  }

  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  getActiveRoomCount(): number {
    return this.rooms.size;
  }

  close(): void {
    if (this.redis && this.clusterSubscribed) {
      this.clusterSubscribed = false;
      this.redis.subscriber.off("message", this.handleRedisMessage);
      void this.redis.subscriber.unsubscribe(this.clusterChannel).catch(() => undefined);
    }

    for (const context of this.connections.values()) {
      this.safeCloseSocket(context.socket, 1012, "VOICE_SERVER_DRAINING");
    }
    this.connections.clear();
    this.rooms.clear();
    this.rateWindows.clear();
    this.wss.close();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, options: HandleUpgradeOptions): boolean {
    const requestUrl = new URL(request.url ?? "/", "http://messly.local");
    if (normalizePathname(requestUrl.pathname) !== this.path) {
      return false;
    }

    if (options.draining) {
      rejectUpgrade(socket, 503, {
        error: "draining",
      });
      return true;
    }

    const origin = String(request.headers.origin ?? "").trim();
    if (origin && !this.isAllowedOrigin(origin)) {
      rejectUpgrade(socket, 403, {
        error: "origin_not_allowed",
      });
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wss.emit("connection", upgradedSocket, request);
    });

    return true;
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const connectionId = randomUUID();
    const ipAddress = extractClientIpFromHeaders(request.headers, String(request.socket.remoteAddress ?? ""));
    const userAgent = String(request.headers["user-agent"] ?? "").trim() || null;

    const context: VoiceConnectionContext = {
      connectionId,
      socket,
      ipAddress,
      userAgent,
      roomId: null,
      userId: null,
      displayName: "",
      muted: false,
      speaking: false,
      connectedAt: Date.now(),
    };

    this.connections.set(socket, context);
    this.logger.debug("voice_connection_opened", {
      connectionId,
      ipAddress,
      activeConnections: this.connections.size,
      instanceId: this.instanceId,
    });

    this.send(socket, {
      type: "connected",
      connectionId,
      path: this.path,
      serverTime: new Date().toISOString(),
      instanceId: this.instanceId,
    });

    socket.on("message", (raw) => {
      void this.handleSocketMessage(context, raw);
    });

    socket.on("close", () => {
      this.handleSocketClose(socket);
    });

    socket.on("error", (error) => {
      this.logger.warn("voice_connection_error", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleSocketMessage(context: VoiceConnectionContext, raw: unknown): Promise<void> {
    if (!this.assertRateLimit(context.connectionId)) {
      this.sendError(context.socket, "RATE_LIMITED", "Muitas mensagens de signaling.");
      this.safeCloseSocket(context.socket, 4008, "VOICE_RATE_LIMITED");
      return;
    }

    let payload: InboundVoiceMessage;
    try {
      const parsed = JSON.parse(decodeRawMessage(raw)) as unknown;
      payload = inboundVoiceMessageSchema.parse(parsed);
    } catch (error) {
      this.sendError(context.socket, "INVALID_PAYLOAD", "Payload de signaling invalido.");
      this.logger.warn("voice_payload_invalid", {
        connectionId: context.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    switch (payload.type) {
      case "join":
        await this.handleJoin(context, payload);
        return;
      case "leave":
        await this.removeConnectionFromRoom(context, "leave");
        return;
      case "offer":
      case "answer":
      case "ice-candidate":
        await this.relayPeerMessage(context, payload);
        return;
      case "mute-state":
        await this.handleMuteState(context, payload.muted);
        return;
      case "speaking-state":
        await this.handleSpeakingState(context, payload.speaking, payload.level);
        return;
      case "ping":
        this.send(context.socket, {
          type: "pong",
          timestamp: payload.timestamp ?? Date.now(),
          serverTime: new Date().toISOString(),
        });
        return;
      default:
        return;
    }
  }

  private async handleJoin(context: VoiceConnectionContext, payload: z.infer<typeof joinMessageSchema>): Promise<void> {
    const roomId = payload.roomId;
    const userId = payload.userId;
    const displayName = payload.displayName?.trim() || userId;

    if (this.validateAccessToken) {
      const token = String(payload.accessToken ?? "").trim();
      if (!token) {
        this.sendError(context.socket, "UNAUTHENTICATED", "Token de autenticacao ausente.");
        return;
      }

      const validated = await this.validateAccessToken(token).catch(() => null);
      if (!validated || validated.id !== userId) {
        this.sendError(context.socket, "UNAUTHENTICATED", "Token invalido para sinalizacao de voz.");
        return;
      }
    }

    if (context.roomId && context.roomId !== roomId) {
      await this.removeConnectionFromRoom(context, "switch_room");
    }

    const room = this.rooms.get(roomId) ?? new Map<string, VoiceConnectionContext>();
    const existingByUser = room.get(userId) ?? null;
    if (existingByUser && existingByUser.connectionId !== context.connectionId) {
      this.send(existingByUser.socket, {
        type: "replaced",
        reason: "SESSION_REPLACED",
      });
      this.safeCloseSocket(existingByUser.socket, 4009, "VOICE_SESSION_REPLACED");
      await this.removeConnectionFromRoom(existingByUser, "session_replaced");
    }

    const distributedParticipants = await this.listDistributedParticipants(roomId);
    const distributedExistingByUser = distributedParticipants.find((participant) => participant.userId === userId) ?? null;
    if (
      distributedExistingByUser &&
      (distributedExistingByUser.instanceId !== this.instanceId || distributedExistingByUser.connectionId !== context.connectionId)
    ) {
      await this.publishClusterEvent({
        kind: "replace-session",
        sourceInstanceId: this.instanceId,
        targetInstanceId: distributedExistingByUser.instanceId,
        roomId,
        userId,
        connectionId: distributedExistingByUser.connectionId,
        reason: "SESSION_REPLACED",
      });
    }

    const roomUserIds = new Set<string>();
    distributedParticipants.forEach((participant) => roomUserIds.add(participant.userId));
    room.forEach((_, participantUserId) => roomUserIds.add(participantUserId));
    if (!roomUserIds.has(userId) && roomUserIds.size >= this.roomUserLimit) {
      this.sendError(context.socket, "ROOM_FULL", "Sala de voz cheia.");
      return;
    }

    const alreadyJoined = context.roomId === roomId && context.userId === userId;
    context.roomId = roomId;
    context.userId = userId;
    context.displayName = displayName;
    context.muted = false;
    context.speaking = false;
    room.set(userId, context);
    this.rooms.set(roomId, room);

    await this.upsertDistributedParticipant(context);
    const participants = await this.collectRoomParticipants(roomId);

    this.send(context.socket, {
      type: "joined",
      roomId,
      selfUserId: userId,
      participants,
      maxParticipants: this.roomUserLimit,
    });

    if (!alreadyJoined) {
      this.broadcastToRoom(roomId, {
        type: "participant-joined",
        participant: {
          userId,
          displayName,
          muted: context.muted,
          speaking: context.speaking,
        } satisfies VoiceParticipantDescriptor,
      }, userId);

      await this.publishClusterEvent({
        kind: "participant-joined",
        sourceInstanceId: this.instanceId,
        roomId,
        excludeUserId: userId,
        participant: {
          userId,
          displayName,
          muted: context.muted,
          speaking: context.speaking,
        },
      });
    }

    this.logger.info("voice_room_joined", {
      roomId,
      userId,
      connectionId: context.connectionId,
      activeRoomSize: participants.length,
      localRoomSize: room.size,
      activeRooms: this.rooms.size,
      instanceId: this.instanceId,
    });
  }

  private async handleMuteState(context: VoiceConnectionContext, muted: boolean): Promise<void> {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.muted = muted;
    await this.upsertDistributedParticipant(context);

    this.broadcastToRoom(context.roomId, {
      type: "participant-mute-state",
      userId: context.userId,
      muted,
    }, context.userId);

    await this.publishClusterEvent({
      kind: "participant-mute-state",
      sourceInstanceId: this.instanceId,
      roomId: context.roomId,
      userId: context.userId,
      muted,
    });
  }

  private async handleSpeakingState(context: VoiceConnectionContext, speaking: boolean, level: number | undefined): Promise<void> {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.speaking = speaking;
    await this.upsertDistributedParticipant(context);

    const normalizedLevel = typeof level === "number" ? Math.max(0, Math.min(1, level)) : undefined;
    this.broadcastToRoom(context.roomId, {
      type: "participant-speaking-state",
      userId: context.userId,
      speaking,
      level: normalizedLevel,
    }, context.userId);

    await this.publishClusterEvent({
      kind: "participant-speaking-state",
      sourceInstanceId: this.instanceId,
      roomId: context.roomId,
      userId: context.userId,
      speaking,
      level: normalizedLevel,
    });
  }

  private async relayPeerMessage(
    context: VoiceConnectionContext,
    payload: z.infer<typeof offerMessageSchema> | z.infer<typeof answerMessageSchema> | z.infer<typeof iceCandidateMessageSchema>,
  ): Promise<void> {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    const room = this.rooms.get(context.roomId);
    const target = room?.get(payload.targetUserId);
    if (target) {
      if (payload.type === "offer") {
        this.send(target.socket, {
          type: "offer",
          fromUserId: context.userId,
          sdp: payload.sdp,
        });
        return;
      }

      if (payload.type === "answer") {
        this.send(target.socket, {
          type: "answer",
          fromUserId: context.userId,
          sdp: payload.sdp,
        });
        return;
      }

      this.send(target.socket, {
        type: "ice-candidate",
        fromUserId: context.userId,
        candidate: payload.candidate,
      });
      return;
    }

    if (!this.redis) {
      this.sendError(context.socket, "TARGET_NOT_FOUND", "Participante alvo nao encontrado na sala.");
      return;
    }

    await this.publishClusterEvent({
      kind: "relay",
      sourceInstanceId: this.instanceId,
      roomId: context.roomId,
      targetUserId: payload.targetUserId,
      fromUserId: context.userId,
      payloadType: payload.type,
      sdp: payload.type === "offer" || payload.type === "answer" ? payload.sdp : undefined,
      candidate: payload.type === "ice-candidate" ? payload.candidate : undefined,
    });
  }

  private handleSocketClose(socket: WebSocket): void {
    const context = this.connections.get(socket);
    if (!context) {
      return;
    }

    this.connections.delete(socket);
    this.rateWindows.delete(context.connectionId);
    void this.removeConnectionFromRoom(context, "socket_closed");

    this.logger.debug("voice_connection_closed", {
      connectionId: context.connectionId,
      activeConnections: this.connections.size,
      instanceId: this.instanceId,
    });
  }

  private async removeConnectionFromRoom(context: VoiceConnectionContext, reason: string): Promise<void> {
    const roomId = context.roomId;
    const userId = context.userId;
    const connectionId = context.connectionId;
    if (!roomId || !userId) {
      context.roomId = null;
      context.userId = null;
      context.displayName = "";
      context.muted = false;
      context.speaking = false;
      return;
    }

    const room = this.rooms.get(roomId);
    const removed = room?.get(userId)?.connectionId === connectionId;
    if (removed && room) {
      room.delete(userId);
      if (room.size === 0) {
        this.rooms.delete(roomId);
      }
    }

    context.roomId = null;
    context.userId = null;
    context.displayName = "";
    context.muted = false;
    context.speaking = false;

    if (!removed) {
      return;
    }

    await this.removeDistributedParticipant(roomId, userId, connectionId);

    this.broadcastToRoom(roomId, {
      type: "participant-left",
      userId,
      reason,
    });

    await this.publishClusterEvent({
      kind: "participant-left",
      sourceInstanceId: this.instanceId,
      roomId,
      userId,
      reason: String(reason).trim() || "left",
    });
  }

  private broadcastToRoom(roomId: string, payload: Record<string, unknown>, excludeUserId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    for (const [userId, context] of room.entries()) {
      if (excludeUserId && userId === excludeUserId) {
        continue;
      }
      this.send(context.socket, payload);
    }
  }

  private handleClusterMessage(payloadRaw: string): void {
    let payload: VoiceClusterEvent;
    try {
      payload = clusterEventSchema.parse(JSON.parse(payloadRaw) as unknown);
    } catch {
      return;
    }

    if (payload.kind !== "replace-session" && payload.sourceInstanceId === this.instanceId) {
      return;
    }

    if (payload.kind === "replace-session") {
      this.handleClusterReplaceSession(payload);
      return;
    }

    if (payload.kind === "relay") {
      this.handleClusterRelay(payload);
      return;
    }

    if (payload.kind === "participant-joined") {
      this.broadcastToRoom(payload.roomId, {
        type: "participant-joined",
        participant: payload.participant,
      }, payload.excludeUserId);
      return;
    }

    if (payload.kind === "participant-left") {
      this.broadcastToRoom(payload.roomId, {
        type: "participant-left",
        userId: payload.userId,
        reason: payload.reason,
      });
      return;
    }

    if (payload.kind === "participant-mute-state") {
      this.broadcastToRoom(payload.roomId, {
        type: "participant-mute-state",
        userId: payload.userId,
        muted: payload.muted,
      }, payload.userId);
      return;
    }

    this.broadcastToRoom(payload.roomId, {
      type: "participant-speaking-state",
      userId: payload.userId,
      speaking: payload.speaking,
      level: payload.level,
    }, payload.userId);
  }

  private handleClusterRelay(payload: z.infer<typeof clusterRelayEventSchema>): void {
    const target = this.rooms.get(payload.roomId)?.get(payload.targetUserId);
    if (!target) {
      return;
    }

    if (payload.payloadType === "offer" && payload.sdp) {
      this.send(target.socket, {
        type: "offer",
        fromUserId: payload.fromUserId,
        sdp: payload.sdp,
      });
      return;
    }

    if (payload.payloadType === "answer" && payload.sdp) {
      this.send(target.socket, {
        type: "answer",
        fromUserId: payload.fromUserId,
        sdp: payload.sdp,
      });
      return;
    }

    if (payload.payloadType === "ice-candidate") {
      this.send(target.socket, {
        type: "ice-candidate",
        fromUserId: payload.fromUserId,
        candidate: payload.candidate,
      });
    }
  }

  private handleClusterReplaceSession(payload: z.infer<typeof clusterReplaceSessionEventSchema>): void {
    if (payload.targetInstanceId !== this.instanceId) {
      return;
    }

    const target = this.rooms.get(payload.roomId)?.get(payload.userId);
    if (!target) {
      return;
    }
    if (payload.connectionId && target.connectionId !== payload.connectionId) {
      return;
    }

    this.send(target.socket, {
      type: "replaced",
      reason: payload.reason,
    });
    this.safeCloseSocket(target.socket, 4009, "VOICE_SESSION_REPLACED");
    void this.removeConnectionFromRoom(target, "session_replaced");
  }

  private async collectRoomParticipants(roomId: string): Promise<VoiceParticipantDescriptor[]> {
    const merged = new Map<string, VoiceParticipantDescriptor>();
    const room = this.rooms.get(roomId);
    if (room) {
      for (const localParticipant of room.values()) {
        if (!localParticipant.userId) {
          continue;
        }
        merged.set(localParticipant.userId, {
          userId: localParticipant.userId,
          displayName: localParticipant.displayName || localParticipant.userId,
          muted: localParticipant.muted,
          speaking: localParticipant.speaking,
        });
      }
    }

    const distributed = await this.listDistributedParticipants(roomId);
    for (const remoteParticipant of distributed) {
      if (merged.has(remoteParticipant.userId)) {
        continue;
      }
      merged.set(remoteParticipant.userId, {
        userId: remoteParticipant.userId,
        displayName: remoteParticipant.displayName,
        muted: remoteParticipant.muted,
        speaking: remoteParticipant.speaking,
      });
    }

    return Array.from(merged.values());
  }

  private async upsertDistributedParticipant(context: VoiceConnectionContext): Promise<void> {
    if (!this.redis || !context.roomId || !context.userId) {
      return;
    }

    const key = toRoomRedisKey(context.roomId);
    const participant: VoiceDistributedParticipantDescriptor = {
      userId: context.userId,
      displayName: context.displayName || context.userId,
      muted: context.muted,
      speaking: context.speaking,
      instanceId: this.instanceId,
      connectionId: context.connectionId,
      updatedAt: Date.now(),
    };

    await this.redis.command.hset(key, context.userId, JSON.stringify(participant));
    await this.redis.command.expire(key, VOICE_ROOM_REDIS_TTL_SECONDS);
  }

  private async listDistributedParticipants(roomId: string): Promise<VoiceDistributedParticipantDescriptor[]> {
    if (!this.redis) {
      return [];
    }

    const key = toRoomRedisKey(roomId);
    const rawMap = await this.redis.command.hgetall(key).catch(() => ({} as Record<string, string>));
    const now = Date.now();
    const staleUserIds: string[] = [];
    const participants: VoiceDistributedParticipantDescriptor[] = [];

    for (const [userId, raw] of Object.entries(rawMap)) {
      try {
        const parsed = distributedParticipantSchema.parse(JSON.parse(raw) as unknown);
        if (now - parsed.updatedAt > VOICE_DISTRIBUTED_PARTICIPANT_STALE_MS) {
          staleUserIds.push(userId);
          continue;
        }
        participants.push(parsed);
      } catch {
        staleUserIds.push(userId);
      }
    }

    if (staleUserIds.length > 0) {
      await this.redis.command.hdel(key, ...staleUserIds).catch(() => undefined);
    }

    return participants;
  }

  private async removeDistributedParticipant(roomId: string, userId: string, expectedConnectionId: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    const key = toRoomRedisKey(roomId);
    const rawCurrent = await this.redis.command.hget(key, userId).catch(() => null);
    if (!rawCurrent) {
      return;
    }

    try {
      const parsed = distributedParticipantSchema.parse(JSON.parse(rawCurrent) as unknown);
      if (parsed.connectionId !== expectedConnectionId) {
        return;
      }
    } catch {
      // Remove malformed distributed participant payloads.
    }

    await this.redis.command.hdel(key, userId).catch(() => undefined);
  }

  private async publishClusterEvent(event: VoiceClusterEvent): Promise<void> {
    if (!this.redis) {
      return;
    }

    await this.redis.publisher.publish(this.clusterChannel, JSON.stringify(event));
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, {
      type: "error",
      code,
      message,
    });
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore send failures on closing sockets.
    }
  }

  private safeCloseSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close failures.
    }
  }

  private assertRateLimit(connectionId: string): boolean {
    const now = Date.now();
    const existing = this.rateWindows.get(connectionId);
    if (!existing || now - existing.startedAt >= VOICE_RATE_LIMIT_WINDOW_MS) {
      this.rateWindows.set(connectionId, {
        startedAt: now,
        count: 1,
      });
      return true;
    }

    existing.count += 1;
    return existing.count <= VOICE_RATE_LIMIT_MAX_MESSAGES;
  }
}
