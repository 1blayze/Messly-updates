import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { GatewayEnv } from "../config/env";
import { createLogger, type Logger } from "../logging/logger";
import { GatewayMetrics } from "../metrics/gatewayMetrics";
import { RedisManager } from "../redis/client";
import { RedisRateLimiter, NoopRateLimiter, type RateLimiter } from "../redis/rateLimiter";
import { RedisLease } from "../redis/lease";
import { GatewayBus } from "../pubsub/gatewayBus";
import { DispatchPublisher } from "../pubsub/dispatchPublisher";
import { AudienceResolver } from "../pubsub/audienceResolver";
import type { GatewayBusMessage, GatewayControlBusMessage, GatewayDispatchBusMessage } from "../pubsub/messages";
import { SupabaseRealtimeBridge } from "../pubsub/databaseBridge";
import { ConnectionRegistry, type LocalGatewayConnection } from "../ws/connectionRegistry";
import { RedisSessionStore } from "../sessions/sessionStore";
import { RedisPresenceService } from "../presence/presenceService";
import { TypingCoordinator } from "../ws/typingCoordinator";
import { parseInboundFrame } from "../protocol/schemas";
import type {
  GatewayErrorPayload,
  GatewayFrame,
  GatewayHeartbeatPayload,
  GatewayHelloPayload,
  GatewayIdentifyPayload,
  GatewayInvalidSessionPayload,
  GatewayPublishPayloadMap,
  GatewayReadyPayload,
  GatewayReconnectPayload,
  GatewayResumePayload,
  GatewaySubscription,
} from "../protocol/dispatch";
import type { GatewayPublishEvent } from "../protocol/opcodes";
import { validateGatewayJwt } from "../auth/jwtValidator";
import { AuthRouter } from "../auth/router";
import { MediaRouter } from "../media/router";
import { AuthSessionManager } from "../sessions/sessionManager";
import { extractClientIpFromHeaders } from "../sessions/loginLocation";

function getInstanceId(): string {
  return String(process.env.K_REVISION ?? process.env.HOSTNAME ?? randomUUID()).trim() || randomUUID();
}

function isElectronOrigin(originRaw: string): boolean {
  const origin = String(originRaw ?? "").trim().toLowerCase();
  return origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || origin.startsWith("messly://");
}

function isLoopbackHttpOrigin(originRaw: string): boolean {
  try {
    const parsed = new URL(String(originRaw ?? "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
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

function normalizeHeartbeatSequence(payload: GatewayHeartbeatPayload): number | null {
  return typeof payload.lastSequence === "number" && Number.isFinite(payload.lastSequence) ? payload.lastSequence : null;
}

function toResponseBody(status: number, payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

type UpgradeSocket = Duplex;

function rejectUpgrade(socket: UpgradeSocket, status: number, payload: unknown): void {
  const body = toResponseBody(status, payload);
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${body.byteLength}\r\n\r\n`,
  );
  socket.write(body);
  socket.destroy();
}

function resolveSequence(frame: GatewayFrame): number | null {
  return typeof frame.s === "number" && Number.isFinite(frame.s) ? frame.s : null;
}

export class GatewayApplication {
  private readonly env: GatewayEnv;
  private readonly instanceId: string;
  private readonly logger: Logger;
  private readonly metrics: GatewayMetrics;
  private readonly redis: RedisManager;
  private readonly rateLimiter: RateLimiter;
  private readonly adminSupabase: SupabaseClient;
  private readonly authSessions: AuthSessionManager;
  private readonly authRouter: AuthRouter;
  private readonly mediaRouter: MediaRouter;
  private readonly audienceResolver: AudienceResolver;
  private readonly bus: GatewayBus;
  private readonly publisher: DispatchPublisher;
  private readonly bridge: SupabaseRealtimeBridge;
  private readonly sessions: RedisSessionStore;
  private readonly presence: RedisPresenceService;
  private readonly registry = new ConnectionRegistry();
  private readonly typing: TypingCoordinator;
  private readonly server = http.createServer();
  private readonly wss: WebSocketServer;
  private heartbeatSweepTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private live = true;
  private started = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly backpressureBytes: number;

  constructor(env: GatewayEnv) {
    this.env = env;
    this.instanceId = getInstanceId();
    this.logger = createLogger("gateway", env.logLevel).child({ instanceId: this.instanceId });
    this.metrics = new GatewayMetrics(this.instanceId, env.metricsEnabled);
    this.redis = new RedisManager(env, this.logger.child({ subsystem: "redis" }), this.metrics);
    this.rateLimiter = env.rateLimitEnabled ? new RedisRateLimiter(this.redis) : new NoopRateLimiter();
    this.adminSupabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    this.authSessions = new AuthSessionManager(this.adminSupabase, this.logger.child({ subsystem: "auth-sessions" }));
    this.authRouter = new AuthRouter({
      adminSupabase: this.adminSupabase,
      createPublicSupabase: () =>
        createClient(env.supabaseUrl, env.supabaseAnonKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        }),
      sessionManager: this.authSessions,
      rateLimiter: this.rateLimiter,
      env,
      logger: this.logger.child({ subsystem: "auth-http" }),
    });
    this.mediaRouter = new MediaRouter({
      adminSupabase: this.adminSupabase,
      sessionManager: this.authSessions,
      rateLimiter: this.rateLimiter,
      env,
      logger: this.logger.child({ subsystem: "media-http" }),
    });
    this.audienceResolver = new AudienceResolver(this.adminSupabase);
    this.bus = new GatewayBus(
      this.redis,
      {
        dispatchChannel: env.dispatchChannel,
        controlChannel: env.controlChannel,
      },
      this.logger.child({ subsystem: "bus" }),
      this.metrics,
    );
    this.publisher = new DispatchPublisher(this.bus, this.audienceResolver);
    this.bridge = new SupabaseRealtimeBridge(
      this.adminSupabase,
      this.publisher,
      new RedisLease(
        this.redis,
        env.bridgeLeaseKey,
        env.bridgeLeaseTtlMs,
        env.bridgeRenewIntervalMs,
        this.logger.child({ subsystem: "bridge-lease" }),
      ),
      this.logger.child({ subsystem: "realtime-bridge" }),
    );
    this.sessions = new RedisSessionStore(this.redis, env.resumeTtlSeconds, env.sessionBufferSize);
    this.presence = new RedisPresenceService(
      this.redis,
      Math.max(env.resumeTtlSeconds, Math.ceil(env.clientTimeoutMs / 1_000) * 2),
    );
    this.typing = new TypingCoordinator(this.publisher, env.typingTtlMs);
    this.backpressureBytes = env.maxPayloadBytes * 4;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: env.maxPayloadBytes,
      perMessageDeflate: false,
    });

    this.server.on("request", (request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.wss.on("connection", (socket, request) => {
      this.handleConnection(socket, request);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.redis.connect();
    await this.bus.start();
    this.bus.subscribe((message) => this.handleBusMessage(message));
    this.bridge.start();
    this.startHeartbeatSweep();

    await new Promise<void>((resolve) => {
      this.server.listen(this.env.port, this.env.host, () => resolve());
    });

    this.started = true;
    this.metrics.setReadyState(true, false);
    this.logger.info("gateway_started", {
      port: this.env.port,
      host: this.env.host,
      publicUrl: this.env.publicUrl,
    });
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      this.draining = true;
      this.metrics.setReadyState(false, true);
      this.logger.info("gateway_draining", { reason });

      this.server.close();
      const connections = this.registry.listConnections();
      await Promise.all(
        connections.map(async (connection) => {
          this.sendReconnect(connection, "SERVER_DRAINING", 1_000);
          setTimeout(() => {
            try {
              connection.socket.close(1012, "SERVER_DRAINING");
            } catch {
              // noop
            }
          }, 100);
        }),
      );

      await Promise.race([
        new Promise<void>((resolve) => {
          const startedAt = Date.now();
          const timer = setInterval(() => {
            if (this.registry.count() === 0 || Date.now() - startedAt >= this.env.drainTimeoutMs) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, this.env.drainTimeoutMs)),
      ]);

      this.heartbeatSweepTimer && clearInterval(this.heartbeatSweepTimer);
      this.wss.close();
      await this.bridge.stop();
      await this.bus.stop();
      await this.redis.close();
      this.live = false;
      this.logger.info("gateway_stopped", { reason });
    })();

    return this.shutdownPromise;
  }

  private async handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://messly.local");
    if (requestUrl.pathname !== "/gateway") {
      rejectUpgrade(socket, 404, {
        error: "not_found",
      });
      return;
    }

    if (this.draining) {
      rejectUpgrade(socket, 503, {
        error: "draining",
      });
      return;
    }

    const origin = String(request.headers.origin ?? "").trim();
    if (origin && !this.isAllowedOrigin(origin)) {
      rejectUpgrade(socket, 403, {
        error: "origin_not_allowed",
      });
      return;
    }

    const ipAddress = extractClientIpFromHeaders(request.headers, String(request.socket.remoteAddress ?? ""));
    if (!(await this.assertRateLimit(`upgrade:${ipAddress}`, 30, 60_000))) {
      rejectUpgrade(socket, 429, {
        error: "rate_limited",
      });
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wss.emit("connection", upgradedSocket, request);
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://messly.local");

    if (url.pathname === "/livez") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: this.live ? "alive" : "stopped", instanceId: this.instanceId }));
      return;
    }

    if (url.pathname === "/readyz") {
      const ready = this.isReady();
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          status: ready ? "ready" : "not_ready",
          instanceId: this.instanceId,
          draining: this.draining,
          redisReady: this.redis.isReady(),
        }),
      );
      return;
    }

    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          status: "ok",
          instanceId: this.instanceId,
          ready: this.isReady(),
          draining: this.draining,
        }),
      );
      return;
    }

    if (url.pathname === this.env.gatewayMetricsPath) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(this.metrics.getSnapshot()));
      return;
    }

    if (url.pathname === "/gateway" || url.pathname === "/gateway/") {
      response.writeHead(426, {
        "content-type": "application/json",
        "cache-control": "no-store",
        connection: "Upgrade",
        upgrade: "websocket",
      });
      response.end(
        JSON.stringify({
          error: "upgrade_required",
          message: "Use WebSocket upgrade for /gateway.",
        }),
      );
      return;
    }

    if (await this.authRouter.handle(request, response)) {
      return;
    }

    if (await this.mediaRouter.handle(request, response)) {
      return;
    }

    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        service: "messly-gateway",
        instanceId: this.instanceId,
        activeConnections: this.registry.count(),
      }),
    );
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const connectionId = randomUUID();
    const ipAddress = extractClientIpFromHeaders(request.headers, String(request.socket.remoteAddress ?? ""));
    const userAgent = String(request.headers["user-agent"] ?? "").trim() || null;
    const connection = this.registry.add({
      connectionId,
      socket,
      sessionId: null,
      userId: null,
      authSessionId: null,
      ipAddress,
      userAgent,
      client: null,
      subscriptions: [],
    });

    this.metrics.trackConnectionOpen(this.registry.count());
    this.sendFrame(socket, {
      op: "HELLO",
      s: 0,
      t: null,
      d: {
        heartbeatIntervalMs: this.env.heartbeatIntervalMs,
        clientTimeoutMs: this.env.clientTimeoutMs,
        connectionId,
        instanceId: this.instanceId,
        serverTime: new Date().toISOString(),
        publicUrl: this.env.publicUrl,
        resume: {
          ttlSeconds: this.env.resumeTtlSeconds,
          bufferSize: this.env.sessionBufferSize,
        },
        shard: {
          id: 0,
          count: 1,
        },
      } satisfies GatewayHelloPayload,
    });

    socket.on("message", (raw) => {
      void this.handleSocketMessage(connection, raw);
    });
    socket.on("close", () => {
      void this.handleSocketClose(socket);
    });
    socket.on("error", (error) => {
      this.logger.warn("ws_connection_error", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleSocketMessage(connection: LocalGatewayConnection, raw: unknown): Promise<void> {
    if (!(await this.assertRateLimit(`message:${connection.connectionId}`, 240, 60_000))) {
      this.sendError(connection.socket, {
        code: "RATE_LIMITED",
        message: "Too many gateway messages.",
        retryAfterMs: 60_000,
      });
      return;
    }

    let frame: ReturnType<typeof parseInboundFrame>;
    try {
      frame = parseInboundFrame(decodeRawMessage(raw));
    } catch (error) {
      this.metrics.trackInvalidPayload();
      this.sendError(connection.socket, {
        code: "INVALID_PAYLOAD",
        message: "Invalid gateway payload.",
        details: error instanceof z.ZodError ? error.issues : undefined,
      });
      connection.socket.close(4002, "INVALID_PAYLOAD");
      return;
    }

    switch (frame.op) {
      case "PING":
        this.sendFrame(connection.socket, {
          op: "PONG",
          s: resolveSequence(frame),
          t: null,
          d: {
            acknowledgedAt: new Date().toISOString(),
          },
        });
        return;
      case "PONG":
        return;
      case "HEARTBEAT":
        await this.handleHeartbeat(connection, frame.d as GatewayHeartbeatPayload);
        return;
      case "IDENTIFY":
        await this.handleIdentify(connection, frame.d as GatewayIdentifyPayload);
        return;
      case "RESUME":
        await this.handleResume(connection, frame.d as GatewayResumePayload);
        return;
      case "SUBSCRIBE":
        await this.handleSubscriptionReplace(
          connection,
          (frame.d as { subscriptions: GatewaySubscription[] }).subscriptions,
          "subscribe",
        );
        return;
      case "UNSUBSCRIBE":
        await this.handleSubscriptionReplace(
          connection,
          (frame.d as { subscriptions: GatewaySubscription[] }).subscriptions,
          "unsubscribe",
        );
        return;
      case "PUBLISH":
        await this.handlePublish(
          connection,
          frame.t as GatewayPublishEvent,
          frame.d as GatewayPublishPayloadMap[GatewayPublishEvent],
        );
        return;
    }
  }

  private async handleHeartbeat(connection: LocalGatewayConnection, payload: GatewayHeartbeatPayload): Promise<void> {
    if (!connection.sessionId || !connection.userId || !connection.authSessionId) {
      this.sendInvalidSession(connection.socket, {
        reason: "UNAUTHENTICATED",
        canResume: false,
      });
      return;
    }

    this.registry.touchHeartbeat(connection.connectionId);
    await this.sessions.touchHeartbeat(connection.sessionId, normalizeHeartbeatSequence(payload));
    await this.presence.touchSession(connection.sessionId);
    const sessionStillActive = await this.authSessions.touchAuthSessionId(connection.authSessionId, {
      userId: connection.userId,
      ipAddress: connection.ipAddress,
      userAgent: connection.userAgent,
      client: connection.client,
    });
    if (!sessionStillActive) {
      this.sendInvalidSession(connection.socket, {
        reason: "SESSION_REVOKED",
        canResume: false,
      });
      connection.socket.close(4001, "SESSION_REVOKED");
      return;
    }

    this.sendFrame(connection.socket, {
      op: "HEARTBEAT_ACK",
      s: normalizeHeartbeatSequence(payload),
      t: null,
      d: {
        acknowledgedAt: new Date().toISOString(),
      },
    });
  }

  private async handleIdentify(connection: LocalGatewayConnection, payload: GatewayIdentifyPayload): Promise<void> {
    if (connection.sessionId) {
      this.sendError(connection.socket, {
        code: "ALREADY_IDENTIFIED",
        message: "Connection already identified.",
      });
      return;
    }

    if (!(await this.assertRateLimit(`identify:${connection.ipAddress}`, 5, 10_000))) {
      this.sendError(connection.socket, {
        code: "RATE_LIMITED",
        message: "Too many identify attempts.",
        retryAfterMs: 10_000,
      });
      return;
    }

    const user = await this.validateToken(payload.token);
    if (!user) {
      this.metrics.trackIdentifyFailure();
      this.sendInvalidSession(connection.socket, {
        reason: "UNAUTHENTICATED",
        canResume: false,
      });
      connection.socket.close(4001, "UNAUTHENTICATED");
      return;
    }

    const subscriptions = await this.normalizeSubscriptions(user.id, payload.subscriptions);
    await this.authSessions.touchFromAccessToken({
      accessToken: payload.token,
      userId: user.id,
      ipAddress: connection.ipAddress,
      userAgent: connection.userAgent,
      client: payload.client ?? null,
    });

    const session = await this.sessions.createSession({
      userId: user.id,
      shardId: 0,
      subscriptions,
      connectionId: connection.connectionId,
      instanceId: this.instanceId,
      ipAddress: connection.ipAddress,
      authSessionId: user.authSessionId,
      userAgent: connection.userAgent,
      client: payload.client ?? null,
    });

    this.registry.attachSession(connection.connectionId, {
      sessionId: session.sessionId,
      userId: user.id,
      authSessionId: user.authSessionId,
      subscriptions,
      client: payload.client ?? null,
    });

    this.metrics.trackIdentifySuccess();
    this.sendFrame(connection.socket, {
      op: "DISPATCH",
      s: session.lastSequence,
      t: "READY",
      d: {
        sessionId: session.sessionId,
        resumeToken: session.resumeToken,
        userId: user.id,
        subscriptions,
        shardId: 0,
        shardCount: 1,
      } satisfies GatewayReadyPayload,
    });

    const aggregatedPresence = await this.presence.connectSession({
      userId: user.id,
      sessionId: session.sessionId,
      deviceId: payload.client?.deviceId ?? null,
      status: "online",
      activities: [],
      metadata: null,
    });
    await this.publisher.publishPresence({
      userId: aggregatedPresence.userId,
      status: aggregatedPresence.status,
      activities: aggregatedPresence.activities,
      lastSeen: aggregatedPresence.lastSeen,
      metadata: aggregatedPresence.metadata ?? null,
    });
  }

  private async handleResume(connection: LocalGatewayConnection, payload: GatewayResumePayload): Promise<void> {
    if (!(await this.assertRateLimit(`resume:${connection.ipAddress}`, 10, 30_000))) {
      this.sendError(connection.socket, {
        code: "RATE_LIMITED",
        message: "Too many resume attempts.",
        retryAfterMs: 30_000,
      });
      return;
    }

    const user = await this.validateToken(payload.token);
    if (!user) {
      this.metrics.trackResumeFailure();
      this.sendInvalidSession(connection.socket, {
        reason: "UNAUTHENTICATED",
        canResume: false,
      });
      return;
    }

    const resume = await this.sessions.resolveResume(payload.sessionId, payload.resumeToken, payload.seq);
    if (!resume || resume.session.userId !== user.id) {
      this.metrics.trackResumeFailure();
      this.sendInvalidSession(connection.socket, {
        reason: "INVALID_SESSION",
        canResume: false,
      });
      return;
    }

    const localExisting = this.registry.getBySessionId(payload.sessionId);
    if (localExisting && localExisting.connectionId !== connection.connectionId) {
      this.sendReconnect(localExisting, "SESSION_RESUMED_ELSEWHERE", 1_000);
      localExisting.socket.close(4009, "SESSION_RESUMED_ELSEWHERE");
    }

    if (resume.session.instanceId && resume.session.instanceId !== this.instanceId) {
      await this.bus.publish({
        kind: "control",
        control: "disconnect_session",
        sessionId: resume.session.sessionId,
        connectionId: resume.session.connectionId,
        targetInstanceId: resume.session.instanceId,
        reason: "SESSION_RESUMED_ELSEWHERE",
        retryAfterMs: 1_000,
      } satisfies GatewayControlBusMessage);
    }

    const subscriptions = await this.normalizeSubscriptions(user.id, payload.subscriptions ?? resume.session.subscriptions);
    const reboundSession = await this.sessions.bindSession(payload.sessionId, {
      connectionId: connection.connectionId,
      instanceId: this.instanceId,
      ipAddress: connection.ipAddress,
      authSessionId: user.authSessionId,
      userAgent: connection.userAgent,
      client: connection.client,
      subscriptions,
    });
    if (!reboundSession) {
      this.metrics.trackResumeFailure();
      this.sendInvalidSession(connection.socket, {
        reason: "INVALID_SESSION",
        canResume: false,
      });
      return;
    }

    this.registry.attachSession(connection.connectionId, {
      sessionId: reboundSession.sessionId,
      userId: reboundSession.userId,
      authSessionId: reboundSession.authSessionId,
      subscriptions,
      client: reboundSession.client,
    });
    this.metrics.trackResumeSuccess();

    this.sendFrame(connection.socket, {
      op: "DISPATCH",
      s: reboundSession.lastSequence,
      t: "RESUMED",
      d: {
        sessionId: reboundSession.sessionId,
        resumeToken: reboundSession.resumeToken,
        userId: reboundSession.userId,
        subscriptions,
        shardId: reboundSession.shardId,
        shardCount: 1,
      } satisfies GatewayReadyPayload,
    });

    for (const record of resume.replay) {
      this.sendFrame(connection.socket, {
        op: "DISPATCH",
        s: record.seq,
        t: record.event,
        d: record.payload,
      });
    }

    const aggregatedPresence = await this.presence.connectSession({
      userId: reboundSession.userId,
      sessionId: reboundSession.sessionId,
      deviceId: reboundSession.client?.deviceId ?? null,
      status: "online",
      activities: [],
      metadata: null,
    });
    await this.publisher.publishPresence({
      userId: aggregatedPresence.userId,
      status: aggregatedPresence.status,
      activities: aggregatedPresence.activities,
      lastSeen: aggregatedPresence.lastSeen,
      metadata: aggregatedPresence.metadata ?? null,
    });
  }

  private async handleSubscriptionReplace(
    connection: LocalGatewayConnection,
    requestedSubscriptions: GatewaySubscription[],
    mode: "subscribe" | "unsubscribe",
  ): Promise<void> {
    if (!connection.sessionId || !connection.userId) {
      this.sendInvalidSession(connection.socket, {
        reason: "UNAUTHENTICATED",
        canResume: false,
      });
      return;
    }

    const normalized = await this.normalizeSubscriptions(connection.userId, requestedSubscriptions);
    if (mode === "subscribe") {
      const unique = new Map<string, GatewaySubscription>();
      connection.subscriptions.forEach((subscription) => {
        unique.set(`${subscription.type}:${subscription.id}`, subscription);
      });
      normalized.forEach((subscription) => {
        unique.set(`${subscription.type}:${subscription.id}`, subscription);
      });
      const nextSubscriptions = [...unique.values()];
      this.registry.replaceSubscriptions(connection.connectionId, nextSubscriptions);
      await this.sessions.updateSubscriptions(connection.sessionId, nextSubscriptions);
      return;
    }

    const removal = new Set(normalized.map((subscription) => `${subscription.type}:${subscription.id}`));
    const nextSubscriptions = connection.subscriptions.filter((subscription) => {
      return !removal.has(`${subscription.type}:${subscription.id}`);
    });
    this.registry.replaceSubscriptions(connection.connectionId, nextSubscriptions);
    await this.sessions.updateSubscriptions(connection.sessionId, nextSubscriptions);
  }

  private async handlePublish(
    connection: LocalGatewayConnection,
    eventType: GatewayPublishEvent,
    payload: GatewayPublishPayloadMap[GatewayPublishEvent],
  ): Promise<void> {
    if (!connection.sessionId || !connection.userId) {
      this.sendInvalidSession(connection.socket, {
        reason: "UNAUTHENTICATED",
        canResume: false,
      });
      return;
    }

    switch (eventType) {
      case "PRESENCE_UPDATE": {
        const presencePayload = payload as GatewayPublishPayloadMap["PRESENCE_UPDATE"];
        if (!(await this.assertRateLimit(`presence:${connection.userId}`, 60, 60_000))) {
          return;
        }
        const aggregated = await this.presence.updatePresence(connection.sessionId, {
          status: presencePayload.presence.status,
          activities: presencePayload.presence.activities,
          metadata: presencePayload.presence.metadata ?? null,
        });
        if (!aggregated) {
          return;
        }
        await this.publisher.publishPresence({
          userId: aggregated.userId,
          status: aggregated.status,
          activities: aggregated.activities,
          lastSeen: aggregated.lastSeen,
          metadata: aggregated.metadata ?? null,
        });
        return;
      }
      case "SPOTIFY_UPDATE": {
        const spotifyPayload = payload as GatewayPublishPayloadMap["SPOTIFY_UPDATE"];
        if (!(await this.assertRateLimit(`spotify:${connection.userId}`, 200, 10_000))) {
          return;
        }
        const userId = String(spotifyPayload.userId ?? connection.userId).trim() || connection.userId;
        if (userId !== connection.userId) {
          return;
        }
        await this.publisher.publishSpotify(connection.userId, spotifyPayload.status, spotifyPayload.activity);
        return;
      }
      case "TYPING_START": {
        const typingPayload = payload as GatewayPublishPayloadMap["TYPING_START"];
        if (!(await this.assertRateLimit(`typing:${connection.userId}`, 60, 5_000))) {
          return;
        }
        if (!(await this.audienceResolver.canAccessConversation(connection.userId, typingPayload.conversationId))) {
          return;
        }
        await this.typing.startTyping(typingPayload.conversationId, connection.userId);
        return;
      }
      case "TYPING_STOP": {
        const typingPayload = payload as GatewayPublishPayloadMap["TYPING_STOP"];
        if (!(await this.assertRateLimit(`typing:${connection.userId}`, 60, 5_000))) {
          return;
        }
        if (!(await this.audienceResolver.canAccessConversation(connection.userId, typingPayload.conversationId))) {
          return;
        }
        await this.typing.stopTyping(typingPayload.conversationId, connection.userId);
        return;
      }
      case "CALL_OFFER":
      case "CALL_ANSWER":
      case "CALL_ICE":
      case "CALL_END": {
        const callPayload = payload as GatewayPublishPayloadMap["CALL_OFFER"];
        if (!(await this.assertRateLimit(`call:${eventType}:${connection.userId}`, 40, 5_000))) {
          return;
        }
        await this.publisher.publishCall({
          type: eventType,
          callId: callPayload.callId,
          scopeType: callPayload.scopeType,
          scopeId: callPayload.scopeId,
          fromUserId: connection.userId,
          targetUserId: callPayload.targetUserId,
          signal: callPayload.signal,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async handleSocketClose(socket: WebSocket): Promise<void> {
    const connection = this.registry.remove(socket);
    if (!connection) {
      return;
    }
    this.metrics.trackConnectionClose(this.registry.count());

    if (!connection.sessionId || !connection.userId) {
      return;
    }

    await this.sessions.markDisconnected(connection.sessionId);
    this.typing.stopAllForUser(connection.userId);
    const aggregatedPresence = await this.presence.disconnectSession(connection.userId, connection.sessionId);
    await this.publisher.publishPresence({
      userId: aggregatedPresence.userId,
      status: aggregatedPresence.status,
      activities: aggregatedPresence.activities,
      lastSeen: aggregatedPresence.lastSeen,
      metadata: aggregatedPresence.metadata ?? null,
    });
  }

  private async handleBusMessage(message: GatewayBusMessage): Promise<void> {
    if (message.kind === "control") {
      await this.handleControlMessage(message);
      return;
    }

    const targets = this.registry.matchSubscriptions(message.targets);
    if (targets.length === 0) {
      return;
    }

    this.metrics.trackFanoutDelivery(targets.length);
    await Promise.all(
      targets.map((connection) => this.sendDispatchToConnection(connection, message)),
    );
  }

  private async handleControlMessage(message: GatewayControlBusMessage): Promise<void> {
    if (message.targetInstanceId && message.targetInstanceId !== this.instanceId) {
      return;
    }
    const connection = this.registry.getBySessionId(message.sessionId);
    if (!connection) {
      return;
    }
    if (message.connectionId && connection.connectionId !== message.connectionId) {
      return;
    }
    this.sendReconnect(connection, message.reason, message.retryAfterMs);
    connection.socket.close(4010, message.reason);
  }

  private async sendDispatchToConnection(
    connection: LocalGatewayConnection,
    message: GatewayDispatchBusMessage,
  ): Promise<void> {
    if (!connection.sessionId) {
      return;
    }
    const record = await this.sessions.appendDispatchEvent({
      sessionId: connection.sessionId,
      eventId: message.eventId,
      event: message.event,
      payload: message.payload,
      occurredAt: message.occurredAt,
    });
    if (!record) {
      return;
    }

    this.sendFrame(connection.socket, {
      op: "DISPATCH",
      s: record.seq,
      t: record.event,
      d: record.payload,
    });
    this.metrics.trackDispatch();

    if (connection.socket.bufferedAmount > this.backpressureBytes) {
      this.metrics.trackBackpressure();
      this.logger.warn("ws_connection_backpressure", {
        connectionId: connection.connectionId,
        bufferedAmount: connection.socket.bufferedAmount,
      });
    }
  }

  private async normalizeSubscriptions(userId: string, subscriptions: GatewaySubscription[]): Promise<GatewaySubscription[]> {
    const unique = new Map<string, GatewaySubscription>();
    for (const subscription of subscriptions) {
      if (!subscription?.id || !subscription?.type) {
        continue;
      }
      if (subscription.type === "conversation") {
        if (!(await this.audienceResolver.canAccessConversation(userId, subscription.id))) {
          continue;
        }
      }
      unique.set(`${subscription.type}:${subscription.id}`, subscription);
    }
    return [...unique.values()];
  }

  private async validateToken(token: string): Promise<{ id: string; authSessionId: string } | null> {
    const user = await validateGatewayJwt(this.adminSupabase, token, this.authSessions);
    return user ? { id: user.id, authSessionId: user.authSessionId } : null;
  }

  private isAllowedOrigin(origin: string): boolean {
    if (this.env.allowedOrigins.includes(origin)) {
      return true;
    }
    if (this.env.allowElectronOrigin && isLoopbackHttpOrigin(origin)) {
      return true;
    }
    if (this.env.allowElectronOrigin && isElectronOrigin(origin)) {
      return true;
    }
    return false;
  }

  private async assertRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const outcome = await this.rateLimiter.consume(key, limit, windowMs);
    return outcome.allowed;
  }

  private sendReconnect(connection: LocalGatewayConnection, reason: string, retryAfterMs: number): void {
    this.metrics.trackReconnectSignal();
    this.sendFrame(connection.socket, {
      op: "RECONNECT",
      s: null,
      t: null,
      d: {
        reason,
        retryAfterMs,
      } satisfies GatewayReconnectPayload,
    });
  }

  private sendInvalidSession(socket: WebSocket, payload: GatewayInvalidSessionPayload): void {
    this.sendFrame(socket, {
      op: "INVALID_SESSION",
      s: null,
      t: null,
      d: payload,
    });
  }

  private sendError(socket: WebSocket, payload: GatewayErrorPayload): void {
    this.sendFrame(socket, {
      op: "ERROR",
      s: null,
      t: null,
      d: payload,
    });
  }

  private sendFrame(socket: WebSocket, frame: GatewayFrame): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  private startHeartbeatSweep(): void {
    const sweepIntervalMs = Math.min(5_000, this.env.heartbeatIntervalMs);
    this.heartbeatSweepTimer = setInterval(() => {
      const now = Date.now();
      this.registry.listConnections().forEach((connection) => {
        if (now - connection.lastHeartbeatAt <= this.env.clientTimeoutMs) {
          return;
        }
        this.metrics.trackHeartbeatTimeout();
        this.sendReconnect(connection, "HEARTBEAT_TIMEOUT", 1_000);
        connection.socket.close(4008, "HEARTBEAT_TIMEOUT");
      });
    }, sweepIntervalMs);
  }

  private isReady(): boolean {
    return !this.draining && this.redis.isReady();
  }
}

export async function createGatewayApplication(env: GatewayEnv): Promise<GatewayApplication> {
  const application = new GatewayApplication(env);
  await application.start();
  return application;
}
