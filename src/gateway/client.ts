import { GatewayHeartbeat } from "./heartbeat";
import type {
  GatewayDispatchEventType,
  GatewayErrorPayload,
  GatewayFrame,
  GatewayHelloPayload,
  GatewayIdentifyPayload,
  GatewayInvalidSessionPayload,
  GatewayOpcode,
  GatewayPublishEventType,
  GatewayPublishPayloadMap,
  GatewayReadyPayload,
  GatewayReconnectPayload,
  GatewayHeartbeatPayload,
  GatewayResumePayload,
  GatewaySubscription,
} from "./protocol";
import { computeReconnectDelayMs } from "./reconnect";

export type GatewayClientStatus =
  | "idle"
  | "disabled"
  | "unauthenticated"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface GatewayClientState {
  status: GatewayClientStatus;
  sessionId: string | null;
  seq: number | null;
  latencyMs: number | null;
  reconnectAttempt: number;
  lastError: string | null;
}

interface GatewayClientOptions {
  url: string | null;
  tokenProvider: () => Promise<string | null>;
  clientInfo: GatewayIdentifyPayload["client"];
}

type StateListener = (state: GatewayClientState) => void;
type FrameListener = (frame: GatewayFrame) => void;

function parseGatewayFrame(raw: string): GatewayFrame | null {
  try {
    const parsed = JSON.parse(raw) as GatewayFrame;
    const opcode = String(parsed?.op ?? "").trim() as GatewayOpcode;
    if (!opcode) {
      return null;
    }

    return {
      op: opcode,
      s: typeof parsed?.s === "number" ? parsed.s : null,
      t: parsed?.t ?? null,
      d: parsed?.d ?? null,
    };
  } catch {
    return null;
  }
}

export class GatewayClient {
  private static readonly FAILURE_STREAK_SUSPEND_THRESHOLD = 8;
  private static readonly FAILURE_STREAK_SUSPEND_MS = 5 * 60_000;
  private readonly options: GatewayClientOptions;
  private ws: WebSocket | null = null;
  private activeSocketUrl: string | null = null;
  private heartbeat: GatewayHeartbeat | null = null;
  private reconnectTimerId: number | null = null;
  private intentionalClose = false;
  private intentionalCloseStatus: GatewayClientStatus = "closed";
  private closeHandledByForcedReconnect = false;
  private subscriptions = new Map<string, GatewaySubscription>();
  private pendingFrames: GatewayFrame[] = [];
  private stateListeners = new Set<StateListener>();
  private frameListeners = new Set<FrameListener>();
  private state: GatewayClientState = {
    status: "idle",
    sessionId: null,
    seq: null,
    latencyMs: null,
    reconnectAttempt: 0,
    lastError: null,
  };
  private pendingHeartbeatAtMs: number | null = null;
  private connectionFailureStreak = 0;
  private reconnectSuspendedUntil = 0;
  private resumeToken: string | null = null;
  private tokenHint: string | null = null;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeFrames(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  replaceSubscriptions(subscriptions: GatewaySubscription[]): void {
    this.subscriptions = new Map(
      subscriptions.map((subscription) => [`${subscription.type}:${subscription.id}`, subscription] as const),
    );
    if (this.state.status === "connected") {
      this.sendFrame({
        op: "SUBSCRIBE",
        s: this.state.seq,
        t: null,
        d: {
          subscriptions: [...this.subscriptions.values()],
        },
      });
    }
  }

  async connect(): Promise<void> {
    if (this.reconnectSuspendedUntil > Date.now()) {
      const remainingMs = this.reconnectSuspendedUntil - Date.now();
      this.updateState({
        status: "error",
        lastError: "Gateway temporariamente pausado apos falhas consecutivas.",
      });
      this.log("warn", "reconexao do gateway temporariamente suspensa", {
        remainingMs,
        reconnectAttempt: this.state.reconnectAttempt,
      });
      return;
    }

    const resolvedSocketUrl = this.normalizeSocketUrl(this.options.url);
    if (!resolvedSocketUrl) {
      this.updateState({
        status: "disabled",
        lastError: "VITE_MESSLY_GATEWAY_URL nao configurada ou invalida.",
      });
      this.log("warn", "gateway websocket url ausente/invalida", {
        configuredUrl: this.options.url ?? null,
        environment: this.getEnvironmentLabel(),
      });
      return;
    }

    const preflightToken = await this.resolveGatewayToken();
    if (!preflightToken) {
      this.stopUnauthenticated("Sessao invalida ou expirada para conectar no gateway.");
      return;
    }
    this.tokenHint = preflightToken;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log("info", "conexao websocket ja ativa/pendente", {
        url: this.activeSocketUrl,
        readyState: this.ws.readyState,
      });
      return;
    }

    this.intentionalClose = false;
    this.intentionalCloseStatus = "closed";
    this.clearReconnectTimer();
    this.activeSocketUrl = resolvedSocketUrl;

    const frontendOrigin = typeof window !== "undefined" ? window.location.origin : null;
    const frontendHostname = typeof window !== "undefined" ? window.location.hostname : null;
    try {
      const parsedGatewayUrl = new URL(resolvedSocketUrl);
      if (frontendHostname && parsedGatewayUrl.hostname === frontendHostname && parsedGatewayUrl.pathname === "/gateway") {
        this.log("warn", "gateway aponta para o mesmo host do frontend; verifique fallback SPA/proxy do Pages", {
          gatewayUrl: resolvedSocketUrl,
          frontendOrigin,
        });
      }
    } catch {
      // URL ja validada em normalizeSocketUrl; sem acao adicional.
    }

    this.updateState({
      status: this.state.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      lastError: null,
    });

    this.log("info", "abrindo websocket do gateway", {
      url: resolvedSocketUrl,
      environment: this.getEnvironmentLabel(),
      platform: this.getPlatformLabel(),
      reconnectAttempt: this.state.reconnectAttempt,
    });

    this.ws = new WebSocket(resolvedSocketUrl);
    this.ws.onopen = () => {
      this.connectionFailureStreak = 0;
      this.reconnectSuspendedUntil = 0;
      this.closeHandledByForcedReconnect = false;
      this.log("info", "websocket conectado", {
        url: resolvedSocketUrl,
      });
    };
    this.ws.onmessage = (event) => this.handleMessage(String(event.data ?? ""));
    this.ws.onclose = (event) => this.handleClose(event);
    this.ws.onerror = (event) => {
      this.updateState({
        status: "error",
        lastError: "Falha na conexao WebSocket do gateway.",
      });
      this.log("error", "erro de websocket do gateway", {
        url: resolvedSocketUrl,
        eventType: event.type,
      });
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.intentionalCloseStatus = "closed";
    this.closeHandledByForcedReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.resumeToken = null;
    this.tokenHint = null;
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.activeSocketUrl = null;
    this.updateState({
      status: "closed",
    });
  }

  async publish<TEvent extends GatewayPublishEventType>(
    eventType: TEvent,
    payload: GatewayPublishPayloadMap[TEvent],
  ): Promise<void> {
    this.sendFrame({
      op: "PUBLISH",
      s: this.state.seq,
      t: eventType,
      d: payload,
    });
  }

  getState(): GatewayClientState {
    return this.state;
  }

  updateToken(tokenRaw: string | null | undefined): void {
    const token = String(tokenRaw ?? "").trim();
    this.tokenHint = this.isLikelyJwt(token) ? token : null;
  }

  private async handleHello(payload: GatewayHelloPayload): Promise<void> {
    this.stopHeartbeat();
    this.heartbeat = new GatewayHeartbeat({
      intervalMs: payload.heartbeatIntervalMs,
      onHeartbeat: () => {
        this.pendingHeartbeatAtMs = Date.now();
        this.sendFrame({
          op: "HEARTBEAT",
          s: this.state.seq,
          t: null,
          d: {
            lastSequence: this.state.seq ?? 0,
            sentAt: new Date().toISOString(),
          } satisfies GatewayHeartbeatPayload,
        });
      },
      onTimeout: () => {
        this.forceReconnect("Heartbeat do gateway expirou.");
      },
    });
    this.heartbeat.start();

    const token = await this.resolveGatewayToken();
    if (!token) {
      this.stopUnauthenticated("Token de autenticacao ausente para o gateway.");
      return;
    }

    if (this.state.sessionId && this.resumeToken && typeof this.state.seq === "number") {
      const payloadResume: GatewayResumePayload = {
        token,
        sessionId: this.state.sessionId,
        resumeToken: this.resumeToken,
        seq: this.state.seq,
        subscriptions: [...this.subscriptions.values()],
      };
      this.sendFrame({
        op: "RESUME",
        s: this.state.seq,
        t: null,
        d: payloadResume,
      });
      return;
    }

    const identifyPayload: GatewayIdentifyPayload = {
      token,
      client: this.options.clientInfo,
      subscriptions: [...this.subscriptions.values()],
    };
    this.sendFrame({
      op: "IDENTIFY",
      s: this.state.seq,
      t: null,
      d: identifyPayload,
    });
  }

  private handleMessage(raw: string): void {
    const frame = parseGatewayFrame(raw);
    if (!frame) {
      return;
    }

    if (typeof frame.s === "number") {
      this.updateState({
        seq: frame.s,
      });
    }

    switch (frame.op) {
      case "HELLO":
        void this.handleHello(frame.d as GatewayHelloPayload);
        break;
      case "HEARTBEAT_ACK":
        this.heartbeat?.ack();
        this.connectionFailureStreak = 0;
        this.updateState({
          status: "connected",
          reconnectAttempt: 0,
          latencyMs: this.pendingHeartbeatAtMs ? Date.now() - this.pendingHeartbeatAtMs : this.state.latencyMs,
          lastError: null,
        });
        this.pendingHeartbeatAtMs = null;
        break;
      case "PING":
        this.sendFrame({
          op: "PONG",
          s: this.state.seq,
          t: null,
          d: {},
        });
        break;
      case "RECONNECT":
        this.forceReconnect(
          (frame.d as GatewayReconnectPayload | null)?.reason ?? "Gateway solicitou reconexao.",
          (frame.d as GatewayReconnectPayload | null)?.retryAfterMs ?? null,
        );
        break;
      case "INVALID_SESSION":
        this.handleInvalidSession(frame.d as GatewayInvalidSessionPayload);
        break;
      case "ERROR":
        this.handleGatewayError(frame.d as GatewayErrorPayload);
        break;
      case "DISPATCH":
        this.handleDispatchFrame(frame);
        break;
      default:
        break;
    }

    this.frameListeners.forEach((listener) => listener(frame));
  }

  private handleDispatchFrame(frame: GatewayFrame): void {
    if (frame.t === "READY" || frame.t === "RESUMED") {
      const payload = frame.d as GatewayReadyPayload;
      this.resumeToken = payload.resumeToken;
      this.updateState({
        sessionId: payload.sessionId,
        seq: typeof frame.s === "number" ? frame.s : this.state.seq,
        status: "connected",
        reconnectAttempt: 0,
        lastError: null,
      });
      this.flushPendingFrames();
      return;
    }

    if ((frame.t as GatewayDispatchEventType | null) === "PRESENCE_UPDATE") {
      this.updateState({
        status: "connected",
      });
    }
  }

  private handleClose(event?: CloseEvent): void {
    this.stopHeartbeat();
    const closeCode = typeof event?.code === "number" ? event.code : null;
    const closeReason = String(event?.reason ?? "").trim() || null;
    const closeWasClean = typeof event?.wasClean === "boolean" ? event.wasClean : null;
    const socketUrl = this.activeSocketUrl;
    this.ws = null;
    this.activeSocketUrl = null;

    this.log("warn", "websocket do gateway fechado", {
      url: socketUrl,
      code: closeCode,
      reason: closeReason,
      wasClean: closeWasClean,
      intentionalClose: this.intentionalClose,
      reconnectAttempt: this.state.reconnectAttempt,
    });

    if (this.intentionalClose) {
      this.closeHandledByForcedReconnect = false;
      this.updateState({
        status: this.intentionalCloseStatus,
      });
      this.connectionFailureStreak = 0;
      this.intentionalCloseStatus = "closed";
      return;
    }

    if (this.closeHandledByForcedReconnect) {
      this.closeHandledByForcedReconnect = false;
      return;
    }

    if (closeCode === 4001 && closeReason?.toUpperCase().includes("UNAUTHENTICATED")) {
      this.stopUnauthenticated("Sessao do gateway invalida: UNAUTHENTICATED.");
      return;
    }

    if (this.state.status !== "connected") {
      this.connectionFailureStreak += 1;
    } else {
      this.connectionFailureStreak = 1;
    }

    const fallbackCloseReason = closeCode ? `Gateway desconectado (close code ${closeCode}).` : "Gateway desconectado.";
    const reconnectReason = this.state.lastError ?? closeReason ?? fallbackCloseReason;
    this.scheduleReconnect(reconnectReason);
  }

  private sendFrame(frame: GatewayFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return;
    }

    this.pendingFrames.push(frame);
  }

  private flushPendingFrames(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.pendingFrames.length === 0) {
      return;
    }

    const pending = [...this.pendingFrames];
    this.pendingFrames = [];
    pending.forEach((frame) => {
      this.sendFrame(frame);
    });
  }

  private handleInvalidSession(payload: GatewayInvalidSessionPayload): void {
    const shouldClearSession = !payload.canResume || payload.reason === "UNAUTHENTICATED" || payload.reason === "SESSION_REVOKED";
    if (shouldClearSession) {
      this.resumeToken = null;
      this.updateState({
        sessionId: null,
        seq: 0,
      });
    }
    if (payload.reason === "UNAUTHENTICATED" || payload.reason === "SESSION_REVOKED") {
      this.stopUnauthenticated(`Sessao do gateway invalidada: ${payload.reason}.`);
      return;
    }
    this.forceReconnect(`Sessao do gateway invalidada: ${payload.reason}.`);
  }

  private handleGatewayError(payload: GatewayErrorPayload): void {
    this.updateState({
      lastError: payload.message,
    });
    if (typeof payload.retryAfterMs === "number" && payload.retryAfterMs > 0) {
      this.scheduleReconnect(payload.message, payload.retryAfterMs);
    }
  }

  private forceReconnect(reason: string, delayOverrideMs: number | null = null): void {
    if (this.ws) {
      this.closeHandledByForcedReconnect = true;
      this.ws.close();
    }
    this.scheduleReconnect(reason, delayOverrideMs);
  }

  private normalizeSocketUrl(valueRaw: string | null | undefined): string | null {
    const value = String(valueRaw ?? "").trim();
    if (!value) {
      return null;
    }

    const withProtocol = /^[a-z][a-z0-9+\-.]*:\/\//i.test(value) ? value : `wss://${value}`;

    try {
      const parsed = new URL(withProtocol);
      if (parsed.protocol === "http:") {
        parsed.protocol = "ws:";
      } else if (parsed.protocol === "https:") {
        parsed.protocol = "wss:";
      }

      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return null;
      }

      const trimmedPath = parsed.pathname.replace(/\/+$/, "");
      if (!trimmedPath || trimmedPath === "/") {
        parsed.pathname = "/gateway";
      } else {
        parsed.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (import.meta.env.PROD && (hostname === "messly.site" || hostname === "www.messly.site")) {
        parsed.hostname = "gateway.messly.site";
        parsed.port = "";
      }
      parsed.hash = "";
      parsed.search = "";

      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  private getEnvironmentLabel(): "production" | "development" {
    return import.meta.env.PROD ? "production" : "development";
  }

  private getPlatformLabel(): string {
    if (typeof window === "undefined") {
      return "unknown";
    }
    return String(window.electronAPI?.platform ?? "web");
  }

  private log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>): void {
    const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    logger(`[gateway:client] ${message}`, context);
  }

  private scheduleReconnect(reason: string, delayOverrideMs: number | null = null): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.connectionFailureStreak >= GatewayClient.FAILURE_STREAK_SUSPEND_THRESHOLD) {
      this.reconnectSuspendedUntil = Date.now() + GatewayClient.FAILURE_STREAK_SUSPEND_MS;
      this.updateState({
        status: "error",
        lastError: "Gateway indisponivel no momento. Tentaremos novamente em alguns minutos.",
      });
      this.log("warn", "gateway em modo de pausa apos falhas consecutivas", {
        reason,
        connectionFailureStreak: this.connectionFailureStreak,
        suspendedForMs: GatewayClient.FAILURE_STREAK_SUSPEND_MS,
      });
      return;
    }

    const nextAttempt = this.state.reconnectAttempt + 1;
    const useSlowBackoff = nextAttempt >= 6;
    const normalizedAttempt = useSlowBackoff ? nextAttempt - 5 : nextAttempt;
    const delayMs =
      typeof delayOverrideMs === "number" && delayOverrideMs > 0
        ? delayOverrideMs
        : computeReconnectDelayMs({
            attempt: normalizedAttempt,
            baseDelayMs: useSlowBackoff ? 30_000 : 1_000,
            maxDelayMs: useSlowBackoff ? 10 * 60_000 : 30_000,
            jitterRatio: 0.25,
          });
    const shouldShowSlowBackoffMessage = useSlowBackoff && reason.includes("WebSocket");
    const lastError = shouldShowSlowBackoffMessage
      ? "Gateway indisponivel no momento. Nova tentativa automatica em breve."
      : reason;

    this.updateState({
      status: "reconnecting",
      reconnectAttempt: nextAttempt,
      lastError,
    });
    this.log("warn", "agendando reconexao websocket", {
      reason: lastError,
      reconnectAttempt: nextAttempt,
      delayMs,
      useSlowBackoff,
      url: this.activeSocketUrl ?? this.options.url ?? null,
    });

    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;
      void this.connect();
    }, delayMs);
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
    this.pendingHeartbeatAtMs = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId != null) {
      window.clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  private async resolveGatewayToken(): Promise<string | null> {
    const provided = String(await this.options.tokenProvider() ?? "").trim();
    if (this.isLikelyJwt(provided)) {
      this.tokenHint = provided;
      return provided;
    }

    if (this.isLikelyJwt(this.tokenHint)) {
      return this.tokenHint;
    }

    return null;
  }

  private stopUnauthenticated(reason: string): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.resumeToken = null;
    this.pendingFrames = [];
    this.updateState({
      status: "unauthenticated",
      reconnectAttempt: 0,
      lastError: reason,
      sessionId: null,
      seq: 0,
    });

    if (this.ws) {
      this.intentionalClose = true;
      this.intentionalCloseStatus = "unauthenticated";
      this.closeHandledByForcedReconnect = false;
      this.ws.close(4001, "UNAUTHENTICATED");
    } else {
      this.ws = null;
      this.activeSocketUrl = null;
    }
  }

  private isLikelyJwt(tokenRaw: string | null | undefined): boolean {
    const token = String(tokenRaw ?? "").trim();
    if (!token) {
      return false;
    }
    const parts = token.split(".");
    return parts.length === 3 && parts.every((part) => part.length > 0);
  }

  private updateState(patch: Partial<GatewayClientState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.stateListeners.forEach((listener) => listener(this.state));
  }
}
