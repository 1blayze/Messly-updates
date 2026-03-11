import { GatewayHeartbeat } from "./heartbeat";
import type {
  GatewayDispatchEventType,
  GatewayFrame,
  GatewayHelloPayload,
  GatewayIdentifyPayload,
  GatewayOpcode,
  GatewayPublishEventType,
  GatewayPublishPayloadMap,
  GatewayReadyPayload,
  GatewayResumePayload,
  GatewaySubscription,
} from "./protocol";
import { computeReconnectDelayMs } from "./reconnect";

export type GatewayClientStatus =
  | "idle"
  | "disabled"
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
  private readonly options: GatewayClientOptions;
  private ws: WebSocket | null = null;
  private activeSocketUrl: string | null = null;
  private heartbeat: GatewayHeartbeat | null = null;
  private reconnectTimerId: number | null = null;
  private intentionalClose = false;
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

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log("info", "conexao websocket ja ativa/pendente", {
        url: this.activeSocketUrl,
        readyState: this.ws.readyState,
      });
      return;
    }

    this.intentionalClose = false;
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
    this.stopHeartbeat();
    this.clearReconnectTimer();
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
          d: {},
        });
      },
      onTimeout: () => {
        this.forceReconnect("Heartbeat do gateway expirou.");
      },
    });
    this.heartbeat.start();

    const token = await this.options.tokenProvider();
    if (!token) {
      this.forceReconnect("Token de autenticacao ausente para o gateway.");
      return;
    }

    if (this.state.sessionId && typeof this.state.seq === "number") {
      const payloadResume: GatewayResumePayload = {
        token,
        sessionId: this.state.sessionId,
        seq: this.state.seq,
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
        this.forceReconnect("Gateway solicitou reconexao.");
        break;
      case "INVALID_SESSION":
        this.updateState({
          sessionId: null,
          seq: null,
        });
        this.forceReconnect("Sessao do gateway invalidada.");
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
      this.updateState({
        sessionId: payload.sessionId,
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
      this.updateState({
        status: "closed",
      });
      return;
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

  private forceReconnect(reason: string): void {
    if (this.ws) {
      this.ws.close();
    }
    this.scheduleReconnect(reason);
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

  private scheduleReconnect(reason: string): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    const nextAttempt = this.state.reconnectAttempt + 1;
    const useSlowBackoff = nextAttempt >= 6;
    const normalizedAttempt = useSlowBackoff ? nextAttempt - 5 : nextAttempt;
    const delayMs = computeReconnectDelayMs({
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

  private updateState(patch: Partial<GatewayClientState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.stateListeners.forEach((listener) => listener(this.state));
  }
}
