import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Logger } from "../logging/logger";
import { extractClientIpFromHeaders } from "../sessions/loginLocation";

const DEFAULT_VOICE_PATH = "/voice";
const VOICE_ROOM_USER_LIMIT = 2;
const VOICE_RATE_LIMIT_WINDOW_MS = 10_000;
const VOICE_RATE_LIMIT_MAX_MESSAGES = 280;

const sdpPayloadSchema = z.object({
  type: z.string().trim().min(1).max(32),
  sdp: z.string().trim().min(1).max(200_000),
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
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Map<string, VoiceConnectionContext>>();
  private readonly connections = new Map<WebSocket, VoiceConnectionContext>();
  private readonly rateWindows = new Map<string, VoiceMessageRateWindow>();

  constructor(options: VoiceSignalingServerOptions) {
    this.logger = options.logger;
    this.path = normalizePathname(options.path ?? DEFAULT_VOICE_PATH);
    this.roomUserLimit = Math.max(2, Math.min(16, Math.round(options.roomUserLimit ?? VOICE_ROOM_USER_LIMIT)));
    this.isAllowedOrigin = options.isAllowedOrigin;
    this.validateAccessToken = options.validateAccessToken ?? null;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      perMessageDeflate: false,
    });

    this.wss.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });
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
    });

    this.send(socket, {
      type: "connected",
      connectionId,
      path: this.path,
      serverTime: new Date().toISOString(),
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
        this.removeConnectionFromRoom(context, "leave");
        return;
      case "offer":
      case "answer":
      case "ice-candidate":
        this.relayPeerMessage(context, payload);
        return;
      case "mute-state":
        this.handleMuteState(context, payload.muted);
        return;
      case "speaking-state":
        this.handleSpeakingState(context, payload.speaking, payload.level);
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
      this.removeConnectionFromRoom(context, "switch_room");
    }

    const room = this.rooms.get(roomId) ?? new Map<string, VoiceConnectionContext>();
    const existingByUser = room.get(userId) ?? null;
    if (existingByUser && existingByUser.connectionId !== context.connectionId) {
      this.send(existingByUser.socket, {
        type: "replaced",
        reason: "SESSION_REPLACED",
      });
      this.safeCloseSocket(existingByUser.socket, 4009, "VOICE_SESSION_REPLACED");
      this.removeConnectionFromRoom(existingByUser, "session_replaced");
    }

    if (!room.has(userId) && room.size >= this.roomUserLimit) {
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

    const participants = Array.from(room.values()).map((participant) => ({
      userId: participant.userId ?? "",
      displayName: participant.displayName,
      muted: participant.muted,
      speaking: participant.speaking,
    } satisfies VoiceParticipantDescriptor));

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
    }

    this.logger.info("voice_room_joined", {
      roomId,
      userId,
      connectionId: context.connectionId,
      activeRoomSize: room.size,
      activeRooms: this.rooms.size,
    });
  }

  private handleMuteState(context: VoiceConnectionContext, muted: boolean): void {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.muted = muted;
    this.broadcastToRoom(context.roomId, {
      type: "participant-mute-state",
      userId: context.userId,
      muted,
    }, context.userId);
  }

  private handleSpeakingState(context: VoiceConnectionContext, speaking: boolean, level: number | undefined): void {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    context.speaking = speaking;
    this.broadcastToRoom(context.roomId, {
      type: "participant-speaking-state",
      userId: context.userId,
      speaking,
      level: typeof level === "number" ? Math.max(0, Math.min(1, level)) : undefined,
    }, context.userId);
  }

  private relayPeerMessage(
    context: VoiceConnectionContext,
    payload: z.infer<typeof offerMessageSchema> | z.infer<typeof answerMessageSchema> | z.infer<typeof iceCandidateMessageSchema>,
  ): void {
    if (!context.roomId || !context.userId) {
      this.sendError(context.socket, "NOT_IN_ROOM", "Conexao ainda nao entrou em uma sala de voz.");
      return;
    }

    const room = this.rooms.get(context.roomId);
    if (!room) {
      this.sendError(context.socket, "ROOM_NOT_FOUND", "Sala de voz nao encontrada.");
      return;
    }

    const target = room.get(payload.targetUserId);
    if (!target) {
      this.sendError(context.socket, "TARGET_NOT_FOUND", "Participante alvo nao encontrado na sala.");
      return;
    }

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
  }

  private handleSocketClose(socket: WebSocket): void {
    const context = this.connections.get(socket);
    if (!context) {
      return;
    }

    this.removeConnectionFromRoom(context, "socket_closed");
    this.connections.delete(socket);
    this.rateWindows.delete(context.connectionId);

    this.logger.debug("voice_connection_closed", {
      connectionId: context.connectionId,
      activeConnections: this.connections.size,
    });
  }

  private removeConnectionFromRoom(context: VoiceConnectionContext, reason: string): void {
    const roomId = context.roomId;
    const userId = context.userId;
    if (!roomId || !userId) {
      context.roomId = null;
      context.userId = null;
      context.displayName = "";
      context.muted = false;
      context.speaking = false;
      return;
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      context.roomId = null;
      context.userId = null;
      context.displayName = "";
      context.muted = false;
      context.speaking = false;
      return;
    }

    const existing = room.get(userId);
    if (existing?.connectionId === context.connectionId) {
      room.delete(userId);
    }

    if (room.size === 0) {
      this.rooms.delete(roomId);
    }

    context.roomId = null;
    context.userId = null;
    context.displayName = "";
    context.muted = false;
    context.speaking = false;

    this.broadcastToRoom(roomId, {
      type: "participant-left",
      userId,
      reason,
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

