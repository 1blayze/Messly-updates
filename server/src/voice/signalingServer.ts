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
const VOICE_CALL_SESSION_REDIS_KEY_PREFIX = "messly:voice:call-session:";
const VOICE_USER_CALL_STATE_REDIS_KEY_PREFIX = "messly:voice:user-call-state:";
const VOICE_CALL_ACTIVE_TTL_SECONDS = 1_800;
const VOICE_CALL_ENDED_TTL_SECONDS = 120;
const VOICE_CALL_RING_TIMEOUT_MS = 3 * 60_000;
const VOICE_CALL_SINGLE_PARTICIPANT_TIMEOUT_MS = 5 * 60_000;
const VOICE_CALL_DISCONNECTED_GRACE_MS = 60_000;
const VOICE_CALL_SWEEP_INTERVAL_MS = 5_000;
const VOICE_CALL_ENDED_RETENTION_MS = 120_000;

const VOICE_CALL_STATUS_VALUES = ["IDLE", "RINGING", "CONNECTED", "RECONNECTING", "ENDED"] as const;
const VOICE_CALL_PARTICIPANT_STATUS_VALUES = ["RINGING", "CONNECTED", "DISCONNECTED"] as const;
const VOICE_CALL_LIFECYCLE_EVENTS = [
  "CALL_STARTED",
  "CALL_RINGING",
  "CALL_JOINED",
  "CALL_LEFT",
  "CALL_RECONNECTED",
  "CALL_ENDED",
  "CALL_STATE_UPDATED",
] as const;
const DISTRIBUTED_PARTICIPANT_STATE_VALUES = ["CONNECTED", "DISCONNECTED"] as const;

type VoiceCallSessionStatus = (typeof VOICE_CALL_STATUS_VALUES)[number];
type VoiceCallParticipantStatus = (typeof VOICE_CALL_PARTICIPANT_STATUS_VALUES)[number];
type VoiceCallLifecycleEvent = (typeof VOICE_CALL_LIFECYCLE_EVENTS)[number];
type DistributedParticipantState = (typeof DISTRIBUTED_PARTICIPANT_STATE_VALUES)[number];

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

const watchMessageSchema = z.object({
  type: z.literal("watch"),
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
  watchMessageSchema,
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
  state: z.enum(DISTRIBUTED_PARTICIPANT_STATE_VALUES),
  disconnectedAt: z.number().finite().nullable().optional(),
  instanceId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128),
  updatedAt: z.number().finite(),
});

const callParticipantSnapshotSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(120),
  state: z.enum(VOICE_CALL_PARTICIPANT_STATUS_VALUES),
  joinedAt: z.number().finite(),
  leftAt: z.number().finite().nullable(),
  lastSeenAt: z.number().finite(),
  muted: z.boolean(),
  speaking: z.boolean(),
});

const callSnapshotSchema = z.object({
  callId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  createdBy: z.string().trim().min(1).max(128),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  status: z.enum(VOICE_CALL_STATUS_VALUES),
  ringExpiresAt: z.number().finite().nullable(),
  connectedAt: z.number().finite().nullable(),
  endedAt: z.number().finite().nullable(),
  endedReason: z.string().trim().min(1).max(64).nullable(),
  singleParticipantSince: z.number().finite().nullable(),
  participants: z.array(callParticipantSnapshotSchema).max(16),
});

type VoiceCallSessionParticipantSnapshot = z.infer<typeof callParticipantSnapshotSchema>;
type VoiceCallSessionSnapshot = z.infer<typeof callSnapshotSchema>;

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

const clusterCallStateEventSchema = z.object({
  kind: z.literal("call-state"),
  sourceInstanceId: z.string().trim().min(1).max(128),
  roomId: z.string().trim().min(1).max(128),
  event: z.enum(VOICE_CALL_LIFECYCLE_EVENTS),
  call: callSnapshotSchema,
});

const clusterEventSchema = z.discriminatedUnion("kind", [
  clusterParticipantJoinedEventSchema,
  clusterParticipantLeftEventSchema,
  clusterMuteStateEventSchema,
  clusterSpeakingStateEventSchema,
  clusterRelayEventSchema,
  clusterReplaceSessionEventSchema,
  clusterCallStateEventSchema,
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
  mode: VoiceConnectionMode;
  lastSeenAt: number;
  connectedAt: number;
}

type VoiceConnectionMode = "idle" | "watch" | "participant";

interface VoiceParticipantDescriptor {
  userId: string;
  displayName: string;
  muted: boolean;
  speaking: boolean;
  updatedAt: number;
}

interface VoiceSessionParticipantDescriptor extends VoiceParticipantDescriptor {
  state: DistributedParticipantState;
  disconnectedAt: number | null;
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

interface SessionActorDescriptor {
  userId: string;
  displayName: string;
}

type ReconcileCause = "join" | "leave" | "watch" | "sweep" | "system";

function normalizePathname(pathnameRaw: string | null | undefined): string {
  const normalized = String(pathnameRaw ?? "").trim().replace(/\/+$/, "");
  return normalized || "/";
}

function toRoomRedisKey(roomId: string): string {
  return `${VOICE_ROOM_REDIS_KEY_PREFIX}${roomId}`;
}

function toCallSessionRedisKey(roomId: string): string {
  return `${VOICE_CALL_SESSION_REDIS_KEY_PREFIX}${roomId}`;
}

function toUserCallStateRedisKey(userId: string): string {
  return `${VOICE_USER_CALL_STATE_REDIS_KEY_PREFIX}${userId}`;
}

function createIdleCallSnapshot(roomId: string): VoiceCallSessionSnapshot {
  const now = Date.now();
  return {
    callId: `idle:${roomId}`,
    roomId,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    status: "IDLE",
    ringExpiresAt: null,
    connectedAt: null,
    endedAt: null,
    endedReason: null,
    singleParticipantSince: null,
    participants: [],
  };
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
  private readonly roomWatchers = new Map<string, Map<string, VoiceConnectionContext>>();
  private readonly connections = new Map<WebSocket, VoiceConnectionContext>();
  private readonly rateWindows = new Map<string, VoiceMessageRateWindow>();
  private readonly callSessions = new Map<string, VoiceCallSessionSnapshot>();
  private clusterSubscribed = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepRunning = false;

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
    if (this.redis && !this.clusterSubscribed) {
      this.redis.subscriber.on("message", this.handleRedisMessage);
      await this.redis.subscriber.subscribe(this.clusterChannel);
      this.clusterSubscribed = true;
    }

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        if (this.sweepRunning) {
          return;
        }
        this.sweepRunning = true;
        void this.sweepCallSessions().finally(() => {
          this.sweepRunning = false;
        });
      }, VOICE_CALL_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  getPath(): string {
    return this.path;
  }

  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  getActiveRoomCount(): number {
    const roomIds = new Set<string>();
    for (const roomId of this.rooms.keys()) {
      roomIds.add(roomId);
    }
    for (const roomId of this.roomWatchers.keys()) {
      roomIds.add(roomId);
    }
    return roomIds.size;
  }

  close(): void {
    if (this.redis && this.clusterSubscribed) {
      this.clusterSubscribed = false;
      this.redis.subscriber.off("message", this.handleRedisMessage);
      void this.redis.subscriber.unsubscribe(this.clusterChannel).catch(() => undefined);
    }

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    for (const context of this.connections.values()) {
      this.safeCloseSocket(context.socket, 1012, "VOICE_SERVER_DRAINING");
    }
    this.connections.clear();
    this.rooms.clear();
    this.roomWatchers.clear();
    this.rateWindows.clear();
    this.callSessions.clear();
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

  private async sweepCallSessions(): Promise<void> {
    const roomIds = new Set<string>();
    for (const roomId of this.rooms.keys()) {
      roomIds.add(roomId);
    }
    for (const roomId of this.roomWatchers.keys()) {
      roomIds.add(roomId);
    }
    for (const roomId of this.callSessions.keys()) {
      roomIds.add(roomId);
    }

    const now = Date.now();
    for (const roomId of roomIds) {
      const snapshot = await this.reconcileCallSession(roomId, "sweep");
      if (snapshot.status !== "ENDED") {
        continue;
      }
      if (now - snapshot.updatedAt < VOICE_CALL_ENDED_RETENTION_MS) {
        continue;
      }
      this.callSessions.delete(roomId);
      if (this.redis) {
        await this.redis.command.del(toCallSessionRedisKey(roomId)).catch(() => undefined);
      }
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const connectionId = randomUUID();
    const ipAddress = extractClientIpFromHeaders(request.headers, String(request.socket.remoteAddress ?? ""));
    const userAgent = String(request.headers["user-agent"] ?? "").trim() || null;
    const now = Date.now();

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
      mode: "idle",
      lastSeenAt: now,
      connectedAt: now,
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

    context.lastSeenAt = Date.now();

    switch (payload.type) {
      case "watch":
        await this.handleWatch(context, payload);
        return;
      case "join":
        await this.handleJoin(context, payload);
        return;
      case "leave":
        await this.removeConnectionFromVoiceScope(context, "leave");
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
        if (context.mode === "participant" && context.roomId && context.userId) {
          await this.upsertDistributedParticipant(context, "CONNECTED");
        }
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

  private async handleWatch(context: VoiceConnectionContext, payload: z.infer<typeof watchMessageSchema>): Promise<void> {
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
      await this.removeConnectionFromVoiceScope(context, "switch_room");
    } else if (context.mode === "participant" && context.roomId === roomId) {
      await this.removeConnectionFromVoiceScope(context, "switch_to_watch");
    }

    const watchers = this.roomWatchers.get(roomId) ?? new Map<string, VoiceConnectionContext>();
    watchers.set(context.connectionId, context);
    this.roomWatchers.set(roomId, watchers);

    context.roomId = roomId;
    context.userId = userId;
    context.displayName = displayName;
    context.muted = false;
    context.speaking = false;
    context.mode = "watch";

    const snapshot = await this.reconcileCallSession(roomId, "watch");
    this.send(context.socket, {
      type: "watching",
      roomId,
      selfUserId: userId,
    });
    this.send(context.socket, {
      type: "call-state",
      event: "CALL_STATE_UPDATED",
      roomId,
      call: snapshot,
      serverTime: new Date().toISOString(),
    });
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
      await this.removeConnectionFromVoiceScope(context, "switch_room");
    } else if (context.mode === "watch" && context.roomId === roomId) {
      this.removeWatcherFromRoom(context);
      context.mode = "idle";
    }

    const room = this.rooms.get(roomId) ?? new Map<string, VoiceConnectionContext>();
    const existingByUser = room.get(userId) ?? null;
    if (existingByUser && existingByUser.connectionId !== context.connectionId) {
      this.send(existingByUser.socket, {
        type: "replaced",
        reason: "SESSION_REPLACED",
      });
      this.safeCloseSocket(existingByUser.socket, 4009, "VOICE_SESSION_REPLACED");
      await this.removeConnectionFromVoiceScope(existingByUser, "session_replaced");
    }

    const distributedParticipants = await this.listDistributedParticipants(roomId);
    const distributedExistingByUser = distributedParticipants.find(
      (participant) => participant.userId === userId && participant.state === "CONNECTED",
    ) ?? null;
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
    distributedParticipants.forEach((participant) => {
      if (participant.state === "CONNECTED") {
        roomUserIds.add(participant.userId);
      }
    });
    room.forEach((_, participantUserId) => roomUserIds.add(participantUserId));
    if (!roomUserIds.has(userId) && roomUserIds.size >= this.roomUserLimit) {
      this.sendError(context.socket, "ROOM_FULL", "Sala de voz cheia.");
      return;
    }

    const alreadyJoined = context.roomId === roomId && context.userId === userId && context.mode === "participant";
    context.roomId = roomId;
    context.userId = userId;
    context.displayName = displayName;
    context.muted = false;
    context.speaking = false;
    context.mode = "participant";
    room.set(userId, context);
    this.rooms.set(roomId, room);

    await this.upsertDistributedParticipant(context, "CONNECTED");
    const participants = await this.collectRoomParticipants(roomId);

    this.send(context.socket, {
      type: "joined",
      roomId,
      selfUserId: userId,
      participants,
      maxParticipants: this.roomUserLimit,
    });

    if (!alreadyJoined) {
      this.broadcastToParticipants(roomId, {
        type: "participant-joined",
        participant: {
          userId,
          displayName,
          muted: context.muted,
          speaking: context.speaking,
        },
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

    await this.reconcileCallSession(roomId, "join", {
      userId,
      displayName,
    });

    this.logger.info("voice_room_joined", {
      roomId,
      userId,
      connectionId: context.connectionId,
      activeRoomSize: participants.length,
      localRoomSize: room.size,
      activeRooms: this.getActiveRoomCount(),
      instanceId: this.instanceId,
    });
  }

  private async handleMuteState(context: VoiceConnectionContext, muted: boolean): Promise<void> {
    if (!context.roomId || !context.userId || context.mode !== "participant") {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.muted = muted;
    await this.upsertDistributedParticipant(context, "CONNECTED");

    this.broadcastToParticipants(context.roomId, {
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
    if (!context.roomId || !context.userId || context.mode !== "participant") {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.speaking = speaking;
    await this.upsertDistributedParticipant(context, "CONNECTED");

    const normalizedLevel = typeof level === "number" ? Math.max(0, Math.min(1, level)) : undefined;
    this.broadcastToParticipants(context.roomId, {
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
    if (!context.roomId || !context.userId || context.mode !== "participant") {
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
    void this.removeConnectionFromVoiceScope(context, "socket_closed");

    this.logger.debug("voice_connection_closed", {
      connectionId: context.connectionId,
      activeConnections: this.connections.size,
      instanceId: this.instanceId,
    });
  }

  private async removeConnectionFromVoiceScope(context: VoiceConnectionContext, reason: string): Promise<void> {
    const mode = context.mode;
    const roomId = context.roomId;
    const userId = context.userId;
    const displayName = context.displayName;
    const connectionId = context.connectionId;
    if (!roomId || !userId || mode === "idle") {
      context.mode = "idle";
      context.roomId = null;
      context.userId = null;
      context.displayName = "";
      context.muted = false;
      context.speaking = false;
      return;
    }

    if (mode === "watch") {
      this.removeWatcherFromRoom(context);
      context.mode = "idle";
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

    context.mode = "idle";
    context.roomId = null;
    context.userId = null;
    context.displayName = "";
    context.muted = false;
    context.speaking = false;

    if (!removed) {
      return;
    }

    if (reason === "socket_closed") {
      await this.markDistributedParticipantDisconnected(roomId, userId, connectionId);
    } else {
      await this.removeDistributedParticipant(roomId, userId, connectionId);
    }

    this.broadcastToParticipants(roomId, {
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

    await this.reconcileCallSession(roomId, "leave", {
      userId,
      displayName: displayName || userId,
    });
  }

  private removeWatcherFromRoom(context: VoiceConnectionContext): void {
    if (!context.roomId) {
      return;
    }
    const watchers = this.roomWatchers.get(context.roomId);
    if (!watchers) {
      return;
    }
    watchers.delete(context.connectionId);
    if (watchers.size === 0) {
      this.roomWatchers.delete(context.roomId);
    }
  }

  private broadcastToParticipants(roomId: string, payload: Record<string, unknown>, excludeUserId?: string): void {
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

  private broadcastCallStateLocal(roomId: string, event: VoiceCallLifecycleEvent, call: VoiceCallSessionSnapshot): void {
    const payload = {
      type: "call-state",
      event,
      roomId,
      call,
      serverTime: new Date().toISOString(),
    };

    const room = this.rooms.get(roomId);
    if (room) {
      for (const context of room.values()) {
        this.send(context.socket, payload);
      }
    }

    const watchers = this.roomWatchers.get(roomId);
    if (watchers) {
      for (const context of watchers.values()) {
        this.send(context.socket, payload);
      }
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

    if (payload.kind === "call-state") {
      this.callSessions.set(payload.roomId, payload.call);
      this.broadcastCallStateLocal(payload.roomId, payload.event, payload.call);
      return;
    }

    if (payload.kind === "participant-joined") {
      this.broadcastToParticipants(payload.roomId, {
        type: "participant-joined",
        participant: payload.participant,
      }, payload.excludeUserId);
      return;
    }

    if (payload.kind === "participant-left") {
      this.broadcastToParticipants(payload.roomId, {
        type: "participant-left",
        userId: payload.userId,
        reason: payload.reason,
      });
      return;
    }

    if (payload.kind === "participant-mute-state") {
      this.broadcastToParticipants(payload.roomId, {
        type: "participant-mute-state",
        userId: payload.userId,
        muted: payload.muted,
      }, payload.userId);
      return;
    }

    this.broadcastToParticipants(payload.roomId, {
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
    void this.removeConnectionFromVoiceScope(target, "session_replaced");
  }

  private async collectRoomParticipants(roomId: string): Promise<VoiceParticipantDescriptor[]> {
    const merged = new Map<string, VoiceParticipantDescriptor>();
    const now = Date.now();
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
          updatedAt: now,
        });
      }
    }

    const distributed = await this.listDistributedParticipants(roomId);
    for (const remoteParticipant of distributed) {
      if (remoteParticipant.state !== "CONNECTED") {
        continue;
      }
      if (merged.has(remoteParticipant.userId)) {
        continue;
      }
      merged.set(remoteParticipant.userId, {
        userId: remoteParticipant.userId,
        displayName: remoteParticipant.displayName,
        muted: remoteParticipant.muted,
        speaking: remoteParticipant.speaking,
        updatedAt: remoteParticipant.updatedAt,
      });
    }

    return Array.from(merged.values());
  }

  private async collectSessionParticipants(roomId: string): Promise<VoiceSessionParticipantDescriptor[]> {
    const now = Date.now();
    const merged = new Map<string, VoiceSessionParticipantDescriptor>();
    const distributed = await this.listDistributedParticipants(roomId);
    for (const participant of distributed) {
      merged.set(participant.userId, {
        userId: participant.userId,
        displayName: participant.displayName,
        muted: participant.muted,
        speaking: participant.speaking,
        state: participant.state,
        disconnectedAt: participant.disconnectedAt ?? null,
        updatedAt: participant.updatedAt,
      });
    }

    const room = this.rooms.get(roomId);
    if (room) {
      for (const participant of room.values()) {
        if (!participant.userId) {
          continue;
        }
        merged.set(participant.userId, {
          userId: participant.userId,
          displayName: participant.displayName || participant.userId,
          muted: participant.muted,
          speaking: participant.speaking,
          state: "CONNECTED",
          disconnectedAt: null,
          updatedAt: now,
        });
      }
    }

    return Array.from(merged.values());
  }

  private async upsertDistributedParticipant(
    context: VoiceConnectionContext,
    state: DistributedParticipantState,
  ): Promise<void> {
    if (!this.redis || !context.roomId || !context.userId) {
      return;
    }

    const key = toRoomRedisKey(context.roomId);
    const participant: VoiceDistributedParticipantDescriptor = {
      userId: context.userId,
      displayName: context.displayName || context.userId,
      muted: context.muted,
      speaking: context.speaking,
      state,
      disconnectedAt: state === "DISCONNECTED" ? Date.now() : null,
      instanceId: this.instanceId,
      connectionId: context.connectionId,
      updatedAt: Date.now(),
    };

    await this.redis.command.hset(key, context.userId, JSON.stringify(participant));
    await this.redis.command.expire(key, VOICE_ROOM_REDIS_TTL_SECONDS);
  }

  private async markDistributedParticipantDisconnected(roomId: string, userId: string, expectedConnectionId: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    const key = toRoomRedisKey(roomId);
    const rawCurrent = await this.redis.command.hget(key, userId).catch(() => null);
    if (!rawCurrent) {
      return;
    }

    let current: VoiceDistributedParticipantDescriptor | null = null;
    try {
      current = distributedParticipantSchema.parse(JSON.parse(rawCurrent) as unknown);
    } catch {
      current = null;
    }

    if (!current || current.connectionId !== expectedConnectionId) {
      return;
    }

    const now = Date.now();
    const next: VoiceDistributedParticipantDescriptor = {
      ...current,
      state: "DISCONNECTED",
      disconnectedAt: now,
      updatedAt: now,
    };

    await this.redis.command.hset(key, userId, JSON.stringify(next)).catch(() => undefined);
    await this.redis.command.expire(key, VOICE_ROOM_REDIS_TTL_SECONDS).catch(() => undefined);
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
      let parsed: VoiceDistributedParticipantDescriptor | null = null;
      try {
        parsed = distributedParticipantSchema.parse(JSON.parse(raw) as unknown);
      } catch {
        parsed = null;
      }

      if (!parsed) {
        staleUserIds.push(userId);
        continue;
      }

      if (parsed.state === "CONNECTED") {
        const elapsedMs = now - parsed.updatedAt;
        if (elapsedMs > VOICE_DISTRIBUTED_PARTICIPANT_STALE_MS) {
          staleUserIds.push(userId);
          continue;
        }
        if (elapsedMs > VOICE_CALL_DISCONNECTED_GRACE_MS) {
          participants.push({
            ...parsed,
            state: "DISCONNECTED",
            disconnectedAt: parsed.updatedAt,
          });
          continue;
        }
        participants.push(parsed);
        continue;
      }

      const disconnectedAt = parsed.disconnectedAt ?? parsed.updatedAt;
      if (now - disconnectedAt > VOICE_CALL_DISCONNECTED_GRACE_MS) {
        staleUserIds.push(userId);
        continue;
      }
      participants.push(parsed);
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

  private async readCallSession(roomId: string): Promise<VoiceCallSessionSnapshot | null> {
    const local = this.callSessions.get(roomId) ?? null;
    if (local) {
      return local;
    }
    if (!this.redis) {
      return null;
    }

    const raw = await this.redis.command.get(toCallSessionRedisKey(roomId)).catch(() => null);
    if (!raw) {
      return null;
    }

    try {
      const parsed = callSnapshotSchema.parse(JSON.parse(raw) as unknown);
      this.callSessions.set(roomId, parsed);
      return parsed;
    } catch {
      await this.redis.command.del(toCallSessionRedisKey(roomId)).catch(() => undefined);
      return null;
    }
  }

  private async persistUserCallStates(
    snapshot: VoiceCallSessionSnapshot,
    previousSnapshot: VoiceCallSessionSnapshot | null,
  ): Promise<void> {
    if (!this.redis) {
      return;
    }

    const operations: Array<Promise<unknown>> = [];
    const previousUserIds = (previousSnapshot?.participants ?? []).map((participant) => participant.userId);
    const currentUserIds = snapshot.participants.map((participant) => participant.userId);

    if (snapshot.status === "ENDED") {
      const endedUserIds = Array.from(new Set([...previousUserIds, ...currentUserIds]));
      for (const userId of endedUserIds) {
        operations.push(this.redis.command.del(toUserCallStateRedisKey(userId)));
      }
    } else {
      for (const participant of snapshot.participants) {
        operations.push(this.redis.command.set(
          toUserCallStateRedisKey(participant.userId),
          JSON.stringify({
            callId: snapshot.callId,
            roomId: snapshot.roomId,
            callStatus: snapshot.status,
            participantState: participant.state,
            updatedAt: snapshot.updatedAt,
          }),
          "EX",
          VOICE_CALL_ACTIVE_TTL_SECONDS,
        ));
      }
    }

    if (operations.length > 0) {
      await Promise.allSettled(operations);
    }
  }

  private async persistCallSession(snapshot: VoiceCallSessionSnapshot): Promise<void> {
    const previousSnapshot = this.callSessions.get(snapshot.roomId) ?? null;
    this.callSessions.set(snapshot.roomId, snapshot);
    if (this.redis) {
      const ttl = snapshot.status === "ENDED" ? VOICE_CALL_ENDED_TTL_SECONDS : VOICE_CALL_ACTIVE_TTL_SECONDS;
      await this.redis.command.set(
        toCallSessionRedisKey(snapshot.roomId),
        JSON.stringify(snapshot),
        "EX",
        ttl,
      ).catch(() => undefined);
    }
    await this.persistUserCallStates(snapshot, previousSnapshot);
  }

  private didCallSnapshotChange(previous: VoiceCallSessionSnapshot | null, next: VoiceCallSessionSnapshot): boolean {
    if (!previous) {
      return true;
    }
    if (
      previous.status !== next.status ||
      previous.ringExpiresAt !== next.ringExpiresAt ||
      previous.connectedAt !== next.connectedAt ||
      previous.endedAt !== next.endedAt ||
      previous.endedReason !== next.endedReason ||
      previous.singleParticipantSince !== next.singleParticipantSince
    ) {
      return true;
    }
    if (previous.participants.length !== next.participants.length) {
      return true;
    }

    for (let index = 0; index < previous.participants.length; index += 1) {
      const current = previous.participants[index];
      const upcoming = next.participants[index];
      if (!current || !upcoming) {
        return true;
      }
      if (
        current.userId !== upcoming.userId ||
        current.displayName !== upcoming.displayName ||
        current.state !== upcoming.state ||
        current.muted !== upcoming.muted ||
        current.speaking !== upcoming.speaking ||
        current.joinedAt !== upcoming.joinedAt ||
        current.leftAt !== upcoming.leftAt
      ) {
        return true;
      }
    }

    return false;
  }

  private async reconcileCallSession(
    roomId: string,
    cause: ReconcileCause,
    actor?: SessionActorDescriptor,
  ): Promise<VoiceCallSessionSnapshot> {
    const now = Date.now();
    const previous = await this.readCallSession(roomId);
    const sessionParticipants = await this.collectSessionParticipants(roomId);

    if (!previous && sessionParticipants.length === 0) {
      return createIdleCallSnapshot(roomId);
    }

    const connectedParticipants = sessionParticipants.filter((participant) => participant.state === "CONNECTED");
    const disconnectedParticipants = sessionParticipants.filter((participant) => participant.state === "DISCONNECTED");
    const shouldCreateSession =
      !previous ||
      previous.status === "ENDED" ||
      previous.status === "IDLE" ||
      previous.callId.startsWith("idle:");
    const previousStatus = previous?.status ?? "IDLE";
    const wasConnectedBefore =
      Boolean(previous && previous.connectedAt != null) ||
      previousStatus === "CONNECTED" ||
      previousStatus === "RECONNECTING";

    const seed = shouldCreateSession
      ? {
          callId: randomUUID(),
          roomId,
          createdBy: actor?.userId ?? connectedParticipants[0]?.userId ?? previous?.createdBy ?? "system",
          createdAt: now,
          updatedAt: now,
          status: "RINGING" as VoiceCallSessionStatus,
          ringExpiresAt: now + VOICE_CALL_RING_TIMEOUT_MS,
          connectedAt: null as number | null,
          endedAt: null as number | null,
          endedReason: null as string | null,
          singleParticipantSince: null as number | null,
          participants: [] as VoiceCallSessionParticipantSnapshot[],
        }
      : {
          callId: previous!.callId,
          roomId: previous!.roomId,
          createdBy: previous!.createdBy,
          createdAt: previous!.createdAt,
          updatedAt: previous!.updatedAt,
          status: previous!.status,
          ringExpiresAt: previous!.ringExpiresAt,
          connectedAt: previous!.connectedAt,
          endedAt: previous!.endedAt,
          endedReason: previous!.endedReason,
          singleParticipantSince: previous!.singleParticipantSince,
          participants: previous!.participants,
        };

    const previousByUser = new Map<string, VoiceCallSessionParticipantSnapshot>();
    for (const participant of previous?.participants ?? []) {
      previousByUser.set(participant.userId, participant);
    }

    const nextByUser = new Map<string, VoiceCallSessionParticipantSnapshot>();
    const connectedCount = connectedParticipants.length;
    const connectedStatusForSingle: VoiceCallParticipantStatus = wasConnectedBefore ? "CONNECTED" : "RINGING";
    const connectedState: VoiceCallParticipantStatus = connectedCount >= 2 ? "CONNECTED" : connectedStatusForSingle;

    for (const participant of connectedParticipants) {
      const previousParticipant = previousByUser.get(participant.userId) ?? null;
      nextByUser.set(participant.userId, {
        userId: participant.userId,
        displayName: participant.displayName || participant.userId,
        state: connectedState,
        joinedAt: previousParticipant?.joinedAt ?? now,
        leftAt: null,
        lastSeenAt: participant.updatedAt,
        muted: participant.muted,
        speaking: participant.speaking,
      });
    }

    for (const participant of disconnectedParticipants) {
      if (nextByUser.has(participant.userId)) {
        continue;
      }
      const disconnectedAt = participant.disconnectedAt ?? participant.updatedAt;
      if (now - disconnectedAt > VOICE_CALL_DISCONNECTED_GRACE_MS) {
        continue;
      }
      const previousParticipant = previousByUser.get(participant.userId) ?? null;
      nextByUser.set(participant.userId, {
        userId: participant.userId,
        displayName: participant.displayName || participant.userId,
        state: "DISCONNECTED",
        joinedAt: previousParticipant?.joinedAt ?? disconnectedAt,
        leftAt: disconnectedAt,
        lastSeenAt: participant.updatedAt,
        muted: participant.muted,
        speaking: participant.speaking,
      });
    }

    let nextStatus: VoiceCallSessionStatus;
    let ringExpiresAt = seed.ringExpiresAt;
    let connectedAt = seed.connectedAt;
    let endedAt = seed.endedAt;
    let endedReason = seed.endedReason;
    let singleParticipantSince = seed.singleParticipantSince;

    if (connectedCount >= 2) {
      nextStatus = "CONNECTED";
      connectedAt = connectedAt ?? now;
      ringExpiresAt = null;
      singleParticipantSince = null;
      endedAt = null;
      endedReason = null;
    } else if (connectedCount === 1) {
      if (wasConnectedBefore) {
        nextStatus = "RECONNECTING";
        singleParticipantSince = singleParticipantSince ?? now;
        ringExpiresAt = null;
      } else {
        nextStatus = "RINGING";
        ringExpiresAt = ringExpiresAt ?? (seed.createdAt + VOICE_CALL_RING_TIMEOUT_MS);
        singleParticipantSince = null;
      }
      endedAt = null;
      endedReason = null;
    } else if (nextByUser.size > 0) {
      if (wasConnectedBefore) {
        nextStatus = "RECONNECTING";
        singleParticipantSince = singleParticipantSince ?? now;
        ringExpiresAt = null;
        endedAt = null;
        endedReason = null;
      } else {
        // The caller disconnected before any peer was connected; end immediately.
        nextStatus = "ENDED";
        endedAt = now;
        endedReason = "NO_ACTIVE_PARTICIPANTS";
        ringExpiresAt = null;
        singleParticipantSince = null;
      }
    } else {
      nextStatus = "ENDED";
      endedAt = endedAt ?? now;
      endedReason = endedReason ?? "NO_PARTICIPANTS";
      ringExpiresAt = null;
      singleParticipantSince = null;
    }

    if (nextStatus === "RINGING" && ringExpiresAt != null && now >= ringExpiresAt) {
      nextStatus = "ENDED";
      endedAt = now;
      endedReason = "RING_TIMEOUT";
      ringExpiresAt = null;
      singleParticipantSince = null;
    }

    if (
      nextStatus === "RECONNECTING" &&
      singleParticipantSince != null &&
      now - singleParticipantSince >= VOICE_CALL_SINGLE_PARTICIPANT_TIMEOUT_MS
    ) {
      nextStatus = "ENDED";
      endedAt = now;
      endedReason = "SINGLE_PARTICIPANT_TIMEOUT";
      ringExpiresAt = null;
      singleParticipantSince = null;
    }

    if (nextStatus === "ENDED") {
      ringExpiresAt = null;
      singleParticipantSince = null;
    }

    const nextSnapshot: VoiceCallSessionSnapshot = {
      callId: seed.callId,
      roomId: seed.roomId,
      createdBy: seed.createdBy,
      createdAt: seed.createdAt,
      updatedAt: now,
      status: nextStatus,
      ringExpiresAt,
      connectedAt,
      endedAt,
      endedReason,
      singleParticipantSince,
      participants: Array.from(nextByUser.values()).sort((left, right) => left.userId.localeCompare(right.userId)),
    };

    const statusChanged = previousStatus !== nextSnapshot.status;
    const snapshotChanged = this.didCallSnapshotChange(previous, nextSnapshot);
    if (!snapshotChanged && cause === "sweep") {
      return previous ?? nextSnapshot;
    }

    await this.persistCallSession(nextSnapshot);

    const events: VoiceCallLifecycleEvent[] = [];
    if (shouldCreateSession && connectedCount > 0) {
      this.logger.info("CALL_CREATED", {
        roomId,
        callId: nextSnapshot.callId,
        createdBy: nextSnapshot.createdBy,
      });
      events.push("CALL_STARTED");
    }
    if (cause === "join" && actor) {
      this.logger.info("CALL_JOINED", {
        roomId,
        callId: nextSnapshot.callId,
        userId: actor.userId,
      });
      events.push("CALL_JOINED");
    }
    if (cause === "leave" && actor) {
      this.logger.info("CALL_LEFT", {
        roomId,
        callId: nextSnapshot.callId,
        userId: actor.userId,
      });
      events.push("CALL_LEFT");
    }
    if (statusChanged) {
      if (nextSnapshot.status === "RINGING") {
        events.push("CALL_RINGING");
      }
      if (previousStatus === "RECONNECTING" && nextSnapshot.status === "CONNECTED") {
        this.logger.info("CALL_RECONNECTED", {
          roomId,
          callId: nextSnapshot.callId,
        });
        events.push("CALL_RECONNECTED");
      }
      if (nextSnapshot.status === "ENDED") {
        this.logger.info("CALL_ENDED", {
          roomId,
          callId: nextSnapshot.callId,
          reason: nextSnapshot.endedReason,
        });
        events.push("CALL_ENDED");
      }
    }
    if (statusChanged || snapshotChanged || cause === "join" || cause === "leave") {
      events.push("CALL_STATE_UPDATED");
    }

    for (const event of Array.from(new Set(events))) {
      await this.emitCallStateEvent(roomId, event, nextSnapshot);
    }

    return nextSnapshot;
  }

  private async emitCallStateEvent(
    roomId: string,
    event: VoiceCallLifecycleEvent,
    snapshot: VoiceCallSessionSnapshot,
  ): Promise<void> {
    this.broadcastCallStateLocal(roomId, event, snapshot);
    await this.publishClusterEvent({
      kind: "call-state",
      sourceInstanceId: this.instanceId,
      roomId,
      event,
      call: snapshot,
    });
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
