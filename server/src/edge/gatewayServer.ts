import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { type ServerResponse, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type GatewayDispatchEvent,
  type GatewayFrame,
  type GatewayHelloPayload,
  type GatewayIdentifyPayload,
  type GatewayReadyPayload,
  type GatewayResumePayload,
  type GatewaySubscription,
} from "../protocol/gateway";
import { validateGatewayJwt } from "../auth/jwtValidator";
import type { AuthRouter } from "../auth/router";
import type { MediaRouter } from "../media/router";
import type { DomainDispatchEnvelope } from "../events/eventTypes";
import type { RealtimeCore } from "../realtime/realtimeCore";
import { GatewayShardManager } from "../realtime/shardManager";
import type { RateLimiter } from "./rateLimiter";
import type { GatewaySession } from "./sessionManager";
import { SessionManager } from "./sessionManager";
import { ConnectionManager } from "./connectionManager";
import { GatewayMetrics } from "../infra/metrics";
import type { Logger } from "../infra/logger";
import type { AuthSessionManager, SessionClientInfo } from "../sessions/sessionManager";

interface GatewayServerOptions {
  supabase: SupabaseClient;
  realtime: RealtimeCore;
  shardManager: GatewayShardManager;
  shardCount: number;
  localShardId: number | null;
  port: number;
  heartbeatIntervalMs: number;
  metricsPath: string;
  rateLimiter: RateLimiter;
  logger?: Logger;
  metrics: GatewayMetrics;
  authSessions?: AuthSessionManager;
  authRouter?: AuthRouter;
  mediaRouter?: MediaRouter;
}

interface SocketContext {
  connectionId: string;
  socket: WebSocket;
  sessionId: string;
  userId: string;
  shardId: number;
  ipAddress: string;
  accessToken: string;
  authSessionId: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
}

interface PublishPresencePayload {
  presence: {
    userId?: string;
    status: "online" | "idle" | "dnd" | "offline" | "invisible";
    activities?: unknown[];
    lastSeen?: string;
  };
}

interface PublishSpotifyPayload {
  userId?: string;
  status: "online" | "idle" | "dnd" | "offline" | "invisible";
  activity: unknown;
}

interface PublishTypingPayload {
  conversationId: string;
}

interface PublishCallPayload {
  type: "CALL_OFFER" | "CALL_ANSWER" | "CALL_ICE" | "CALL_END";
  callId: string;
  scopeType: "voice" | "dm";
  scopeId: string;
  targetUserId: string;
  signal: Record<string, unknown> | null;
}

function parseFrame(raw: unknown): GatewayFrame<unknown> | null {
  try {
    if (raw instanceof ArrayBuffer) {
      raw = Buffer.from(raw).toString("utf8");
    }
    if (ArrayBuffer.isView(raw)) {
      raw = Buffer.from(raw.buffer).toString("utf8");
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    return parsed as GatewayFrame<unknown>;
  } catch {
    return null;
  }
}

type SocketSubscriptionType = "conversation" | "user" | "friends" | "notifications" | "voice";

function normalizeSubscriptionType(type: string): SocketSubscriptionType | null {
  if (type === "conversation" || type === "user" || type === "friends" || type === "notifications" || type === "voice") {
    return type;
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class GatewayServer {
  private readonly server = http.createServer();
  private readonly wss = new WebSocketServer({ server: this.server, path: "/gateway" });
  private readonly sessions = new SessionManager();
  private readonly connections = new ConnectionManager();
  private readonly membershipCache = new Map<string, boolean>();

  constructor(private readonly options: GatewayServerOptions) {
    this.server.on("request", (request, response) => {
      void this.handleHttpRequest(request, response);
    });
  }

  start(): void {
    this.wss.on("connection", (socket, request) => {
      const ipAddress = String(request?.socket?.remoteAddress ?? "unknown");
      const userAgent = String(request?.headers["user-agent"] ?? "").trim() || null;
      const connectionId = randomUUID();
      const helloPayload: GatewayHelloPayload = {
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        connectionId,
        shardId: this.options.localShardId ?? 0,
        shardCount: this.options.shardCount,
        resumeUrl: "/gateway",
      };

      this.options.logger?.info("Nova conexao WebSocket", { connectionId, ipAddress });
      this.options.metrics.trackConnectionOpen();
      this.send(socket, {
        op: "HELLO",
        s: null,
        t: null,
        d: helloPayload,
      });

      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw, ipAddress, userAgent);
      });

      socket.on("close", () => {
        this.handleSocketClose(socket);
      });

      socket.on("error", () => {
        this.handleSocketClose(socket);
      });
    });

    this.server.listen(this.options.port, () => {
      this.options.logger?.info("Messly Gateway iniciado", { port: this.options.port });
    });
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const handledByAuthRouter = await this.options.authRouter?.handle(request, response);
    if (handledByAuthRouter) {
      return;
    }

    const handledByMediaRouter = await this.options.mediaRouter?.handle(request, response);
    if (handledByMediaRouter) {
      return;
    }

    if (request.url === this.options.metricsPath) {
      const snapshot = this.options.metrics.getSnapshot();
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot));
      return;
    }

    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        service: "messly-gateway",
        status: "ok",
        activeConnections: this.options.metrics.getSnapshot().activeConnections,
      }),
    );
  }

  private async handleSocketMessage(
    socket: WebSocket,
    raw: unknown,
    ipAddress: string,
    userAgent: string | null,
  ): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame || typeof frame.op !== "string") {
      return;
    }

    if (frame.op === "PING") {
      this.send(socket, {
        op: "PONG",
        s: frame.s,
        t: null,
        d: { acknowledgedAt: nowIso() },
      });
      return;
    }

    if (frame.op === "HEARTBEAT") {
      const context = this.getContext(socket);
      if (!context) {
        this.send(socket, {
          op: "INVALID_SESSION",
          s: frame.s,
          t: null,
          d: { reason: "UNAUTHENTICATED" },
        });
        return;
      }
      this.sessions.updateHeartbeat(context.sessionId);
      await this.options.authSessions?.touchAuthSessionId(context.authSessionId, {
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        client: context.client,
      });
      const heartbeatStart = typeof (frame.d as { startTs?: number })?.startTs === "number"
        ? (frame.d as { startTs?: number }).startTs
        : null;
      if (heartbeatStart != null) {
        this.options.metrics.trackHeartbeatAck(Math.max(0, Date.now() - heartbeatStart));
      }
      this.send(socket, {
        op: "HEARTBEAT_ACK",
        s: this.sessions.updateSeq(context.sessionId),
        t: null,
        d: { acknowledgedAt: nowIso() },
      });
      return;
    }

    if (frame.op === "IDENTIFY") {
      await this.handleIdentify(socket, frame, ipAddress, userAgent);
      return;
    }

    if (frame.op === "RESUME") {
      await this.handleResume(socket, frame, ipAddress, userAgent);
      return;
    }

    const context = this.getContext(socket);
    if (!context) {
      this.send(socket, {
        op: "INVALID_SESSION",
        s: frame.s,
        t: null,
        d: { reason: "UNAUTHENTICATED" },
      });
      return;
    }

    if (frame.op === "SUBSCRIBE" || frame.op === "UNSUBSCRIBE") {
      await this.handleSubscriptionUpdate(
        context,
        socket,
        frame.op,
        Array.isArray((frame.d as { subscriptions?: unknown[] })?.subscriptions)
          ? ((frame.d as { subscriptions?: unknown[] }).subscriptions ?? [])
          : [],
      );
      return;
    }

    if (frame.op === "PUBLISH") {
      await this.handlePublish(context, socket, frame.t, frame.d);
      return;
    }

    if (frame.op === "DISPATCH") {
      // Client must never send dispatch events directly.
      return;
    }
  }

  private async handleIdentify(
    socket: WebSocket,
    frame: GatewayFrame<unknown>,
    ipAddress: string,
    userAgent: string | null,
  ): Promise<void> {
    const payload = frame.d as GatewayIdentifyPayload;
    const allowed = await this.assertRateLimit(`identify:${ipAddress}`, 5, 10_000);
    if (!allowed) {
      this.send(socket, {
        op: "RECONNECT",
        s: null,
        t: null,
        d: { reason: "RATE_LIMITED" },
      });
      return;
    }

    const user = await this.validateToken(payload?.token);
    if (!user) {
      this.send(socket, {
        op: "INVALID_SESSION",
        s: frame.s,
        t: null,
        d: { reason: "UNAUTHENTICATED" },
      });
      return;
    }

    const subscriptions = await this.normalizeSubscriptions(user.id, payload?.subscriptions ?? []);
    const targetShard = this.options.shardManager.getShardIdForUser(user.id);
    if (!this.options.shardManager.ownsShard(targetShard)) {
      this.send(socket, {
        op: "RECONNECT",
        s: frame.s,
        t: null,
        d: {
          reason: "SHARD_MISMATCH",
          targetShard,
          localShardId: this.options.localShardId,
          shardCount: this.options.shardCount,
        },
      });
      this.connections.remove(socket);
      socket.close(4003, "MISMATCH_SHARD");
      return;
    }

    await this.options.authSessions?.touchFromAccessToken({
      accessToken: payload?.token,
      userId: user.id,
      ipAddress,
      userAgent,
      client: payload?.client ?? null,
    });

    const session = this.sessions.create(user.id, targetShard, subscriptions, ipAddress);
    this.attachSocketContext(socket, session, {
      accessToken: payload?.token,
      authSessionId: user.authSessionId,
      userAgent,
      client: payload?.client ?? null,
    });

    await this.options.realtime.publishPresence({
      userId: user.id,
      status: "online",
      activities: [],
      lastSeen: nowIso(),
    });

    this.send(socket, {
      op: "DISPATCH",
      s: this.sessions.updateSeq(session.sessionId),
      t: "READY",
      d: {
        sessionId: session.sessionId,
        userId: user.id,
        shardId: targetShard,
        shardCount: this.options.shardCount,
        subscriptions,
      } satisfies GatewayReadyPayload,
    });
  }

  private async handleResume(
    socket: WebSocket,
    frame: GatewayFrame<unknown>,
    ipAddress: string,
    userAgent: string | null,
  ): Promise<void> {
    const payload = frame.d as GatewayResumePayload;
    const user = await this.validateToken(payload?.token);
    if (!user) {
      this.send(socket, {
        op: "INVALID_SESSION",
        s: frame.s,
        t: null,
        d: { reason: "UNAUTHENTICATED" },
      });
      return;
    }

    const session = this.sessions.resume(payload?.sessionId ?? "", payload?.seq ?? 0, ipAddress);
    if (!session || session.userId !== user.id) {
      this.send(socket, {
        op: "INVALID_SESSION",
        s: frame.s,
        t: null,
        d: { reason: "INVALID_SESSION" },
      });
      return;
    }

    if (!this.options.shardManager.ownsShard(session.shardId)) {
      this.send(socket, {
        op: "RECONNECT",
        s: frame.s,
        t: null,
        d: {
          reason: "SHARD_MISMATCH",
          targetShard: session.shardId,
          localShardId: this.options.localShardId,
          shardCount: this.options.shardCount,
        },
      });
      return;
    }

    const subscriptions = await this.normalizeSubscriptions(user.id, payload?.subscriptions ?? session.subscriptions);
    this.sessions.setSubscriptions(session.sessionId, subscriptions);
    await this.options.authSessions?.touchFromAccessToken({
      accessToken: payload?.token,
      userId: user.id,
      ipAddress,
      userAgent,
      client: null,
    });
    this.attachSocketContext(socket, session, {
      accessToken: payload?.token,
      authSessionId: user.authSessionId,
      userAgent,
      client: null,
    });

    this.send(socket, {
      op: "DISPATCH",
      s: session.seq,
      t: "RESUMED",
      d: {
        sessionId: session.sessionId,
        userId: user.id,
        shardId: session.shardId,
        shardCount: this.options.shardCount,
        subscriptions,
      } satisfies GatewayReadyPayload,
    });
  }

  private async handleSubscriptionUpdate(
    context: SocketContext,
    socket: WebSocket,
    op: "SUBSCRIBE" | "UNSUBSCRIBE",
    rawSubscriptions: unknown[],
  ): Promise<void> {
    const payloadSubscriptions = rawSubscriptions.filter((subscription): subscription is GatewaySubscription => {
      if (!subscription || typeof subscription !== "object") {
        return false;
      }
      const typed = subscription as Partial<GatewaySubscription>;
      const type = normalizeSubscriptionType(String(typed.type ?? ""));
      return Boolean(type && typeof typed.id === "string" && typed.id.trim().length > 0);
    });

    const normalized = await this.normalizeSubscriptions(context.userId, payloadSubscriptions);
    if (op === "SUBSCRIBE") {
      const unique = new Map<string, GatewaySubscription>();
      this.sessions.get(context.sessionId)?.subscriptions?.forEach((subscription) => {
        unique.set(`${subscription.type}:${subscription.id}`, subscription);
      });
      normalized.forEach((subscription) => {
        unique.set(`${subscription.type}:${subscription.id}`, subscription);
      });
      this.sessions.setSubscriptions(context.sessionId, [...unique.values()]);
    } else {
      const removal = new Set(normalized.map((subscription) => `${subscription.type}:${subscription.id}`));
      const kept = this.sessions
        .get(context.sessionId)
        ?.subscriptions.filter((subscription) => !removal.has(`${subscription.type}:${subscription.id}`)) ?? [];
      this.sessions.setSubscriptions(context.sessionId, kept);
    }

    this.updateSocketSubscriptions(context, socket);
  }

  private async handlePublish(context: SocketContext, socket: WebSocket, eventType: string | null, payload: unknown): Promise<void> {
    switch (eventType) {
      case "PRESENCE_UPDATE":
        if (!(await this.assertEventRateLimit(context.userId, "presence", 60, 60_000))) {
          return;
        }
        await this.publishPresence(context, payload as PublishPresencePayload);
        return;
      case "SPOTIFY_UPDATE":
        if (!(await this.assertEventRateLimit(context.userId, "spotify", 200, 10_000))) {
          return;
        }
        await this.publishSpotify(context, payload as PublishSpotifyPayload);
        return;
      case "TYPING_START":
        if (!(await this.assertEventRateLimit(context.userId, "typing", 60, 5_000))) {
          return;
        }
        await this.publishTyping(context, payload as PublishTypingPayload, "TYPING_START");
        return;
      case "TYPING_STOP":
        if (!(await this.assertEventRateLimit(context.userId, "typing", 60, 5_000))) {
          return;
        }
        await this.publishTyping(context, payload as PublishTypingPayload, "TYPING_STOP");
        return;
      case "CALL_OFFER":
      case "CALL_ANSWER":
      case "CALL_ICE":
      case "CALL_END":
        if (!(await this.assertEventRateLimit(context.userId, `call:${eventType}`, 40, 5_000))) {
          return;
        }
        await this.publishCall(context, payload as PublishCallPayload, eventType);
        return;
      default:
        if (eventType) {
          this.options.logger?.warn("Evento de publicacao nao suportado", { eventType });
        }
        return;
    }
  }

  private async publishPresence(context: SocketContext, payload: PublishPresencePayload): Promise<void> {
    const userId = String(payload?.presence?.userId ?? context.userId).trim();
    if (!userId || userId !== context.userId) {
      return;
    }

    await this.options.realtime.publishPresence({
      userId,
      status: payload?.presence?.status ?? "online",
      activities: Array.isArray(payload?.presence?.activities) ? payload.presence.activities : [],
      lastSeen: payload?.presence?.lastSeen ?? nowIso(),
    });
  }

  private async publishSpotify(context: SocketContext, payload: PublishSpotifyPayload): Promise<void> {
    const userId = String(payload?.userId ?? context.userId).trim() || context.userId;
    if (!userId || userId !== context.userId) {
      return;
    }

    await this.options.realtime.publishSpotify(userId, payload.status, payload.activity);
  }

  private async publishTyping(
    context: SocketContext,
    payload: PublishTypingPayload,
    eventType: "TYPING_START" | "TYPING_STOP",
  ): Promise<void> {
    const conversationId = String(payload?.conversationId ?? "").trim();
    if (!conversationId) {
      return;
    }
    const canAccess = await this.canAccessConversation(context.userId, conversationId);
    if (!canAccess) {
      return;
    }

    if (eventType === "TYPING_START") {
      await this.options.realtime.typing.startTyping(conversationId, context.userId);
    } else {
      await this.options.realtime.typing.stopTyping(conversationId, context.userId);
    }
  }

  private async publishCall(context: SocketContext, payload: PublishCallPayload, eventType: string): Promise<void> {
    const targetUserId = String(payload?.targetUserId ?? "").trim();
    const callId = String(payload?.callId ?? "").trim();
    if (!targetUserId || !callId) {
      return;
    }
    await this.options.realtime.publishCallSignal({
      type: eventType as "CALL_OFFER" | "CALL_ANSWER" | "CALL_ICE" | "CALL_END",
      callId,
      scopeType: "voice",
      scopeId: String(payload.scopeId ?? ""),
      fromUserId: context.userId,
      targetUserId,
      signal: payload.signal ?? null,
      updatedAt: nowIso(),
    });
  }

  private async normalizeSubscriptions(
    userId: string,
    subscriptions: unknown[],
  ): Promise<GatewaySubscription[]> {
    const normalized = subscriptions
      .map((subscription) => {
        if (!subscription || typeof subscription !== "object") {
          return null;
        }
        const candidate = subscription as Partial<GatewaySubscription>;
        const type = normalizeSubscriptionType(String(candidate.type ?? ""));
        const id = String(candidate.id ?? "").trim();
        if (!type || !id) {
          return null;
        }
        return { type, id };
      })
      .filter((subscription): subscription is GatewaySubscription => Boolean(subscription));

    const validated: GatewaySubscription[] = [];
    const conversationIds = normalized.filter((item) => item.type === "conversation").map((item) => item.id);
    for (const subscription of normalized) {
      if (subscription.type !== "conversation") {
        validated.push(subscription);
        continue;
      }
      if (await this.canAccessConversation(userId, subscription.id)) {
        validated.push(subscription);
      }
    }

    return validated;
  }

  private async canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    const key = `${userId}:${conversationId}`;
    const cached = this.membershipCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (!conversationId) {
      this.membershipCache.set(key, false);
      return false;
    }

    const directResult = await this.options.supabase
      .from("conversations")
      .select("id,user1_id,user2_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!directResult.error && directResult.data) {
      const result = String(directResult.data.user1_id ?? "") === userId || String(directResult.data.user2_id ?? "") === userId;
      this.membershipCache.set(key, result);
      return result;
    }

    const memberResult = await this.options.supabase
      .from("conversation_members")
      .select("conversation_id,user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    const memberValue =
      !memberResult.error && memberResult.data !== null && String(memberResult.data.conversation_id ?? "") === conversationId;
    this.membershipCache.set(key, memberValue);
    return memberValue;
  }

  private attachSocketContext(
    socket: WebSocket,
    session: GatewaySession,
    authContext: {
      accessToken: string;
      authSessionId: string;
      userAgent: string | null;
      client: SessionClientInfo | null;
    },
  ): void {
    const context: SocketContext = {
      connectionId: this.getContext(socket)?.connectionId ?? randomUUID(),
      socket,
      sessionId: session.sessionId,
      userId: session.userId,
      shardId: session.shardId,
      ipAddress: session.ipAddress,
      accessToken: authContext.accessToken,
      authSessionId: authContext.authSessionId,
      userAgent: authContext.userAgent,
      client: authContext.client,
    };
    this.connections.add({
      connectionId: context.connectionId,
      socket,
      userId: context.userId,
      sessionId: context.sessionId,
      shardId: context.shardId,
      ipAddress: context.ipAddress,
      accessToken: context.accessToken,
      authSessionId: context.authSessionId,
      userAgent: context.userAgent,
      client: context.client,
    });

    this.options.shardManager.attachSession(
      {
        sessionId: session.sessionId,
        userId: session.userId,
        dispatch: (frame: DomainDispatchEnvelope<unknown>) => {
          this.send(socket, {
            op: "DISPATCH",
            s: this.sessions.updateSeq(session.sessionId),
            t: frame.event as GatewayDispatchEvent,
            d: frame.payload,
          });
        },
      },
      this.sessions.get(session.sessionId)?.subscriptions ?? [],
      session.shardId,
    );
  }

  private updateSocketSubscriptions(context: SocketContext, socket: WebSocket): void {
    const session = this.sessions.get(context.sessionId);
    if (!session) {
      return;
    }

    const shard = this.options.shardManager.getShardById(context.shardId);
    shard?.updateSubscriptions(context.sessionId, session.subscriptions);
  }

  private handleSocketClose(socket: WebSocket): void {
    const connection = this.connections.remove(socket);
    if (!connection) {
      return;
    }
    this.options.metrics.trackConnectionClose();
    this.options.shardManager.detachSession(connection.sessionId);
    const session = this.sessions.get(connection.sessionId);
    if (!session) {
      return;
    }

    const otherSessions = this.sessions.listByUserId(session.userId);
    this.sessions.drop(session.sessionId);

    const isDisconnected = !otherSessions.some((active) => active.sessionId !== session.sessionId);
    if (isDisconnected) {
      void this.options.realtime.publishPresence({
        userId: session.userId,
        status: "offline",
        activities: [],
        lastSeen: nowIso(),
      });
      this.options.logger?.info("Usuario ficou offline", {
        userId: session.userId,
        shardId: session.shardId,
      });
    }
  }

  private getContext(socket: WebSocket): SocketContext | null {
    return this.connections.get(socket);
  }

  private async validateToken(token: string): Promise<{ id: string; authSessionId: string } | null> {
    const user = await validateGatewayJwt(this.options.supabase, token, this.options.authSessions);
    return user ? { id: user.id, authSessionId: user.authSessionId } : null;
  }

  private send(socket: WebSocket, frame: GatewayFrame<unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  private async assertRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const outcome = await this.options.rateLimiter.consume(key, limit, windowMs);
    if (!outcome.allowed) {
      this.options.metrics.trackReconnectAttempt();
      return false;
    }
    return true;
  }

  private async assertEventRateLimit(
    userId: string,
    eventName: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    return this.assertRateLimit(`${eventName}:${userId}`, limit, windowMs);
  }
}
