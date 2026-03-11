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
    if (!this.options.url) {
      this.updateState({
        status: "disabled",
        lastError: "VITE_MESSLY_GATEWAY_URL nao configurada.",
      });
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.updateState({
      status: this.state.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      lastError: null,
    });

    this.ws = new WebSocket(this.options.url);
    this.ws.onmessage = (event) => this.handleMessage(String(event.data ?? ""));
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => {
      this.updateState({
        status: "error",
        lastError: "Falha na conexao WebSocket do gateway.",
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

  private handleClose(): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.intentionalClose) {
      this.updateState({
        status: "closed",
      });
      return;
    }

    this.scheduleReconnect(this.state.lastError ?? "Gateway desconectado.");
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

  private scheduleReconnect(reason: string): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    const nextAttempt = this.state.reconnectAttempt + 1;
    const delayMs = computeReconnectDelayMs({
      attempt: nextAttempt,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
    });

    this.updateState({
      status: "reconnecting",
      reconnectAttempt: nextAttempt,
      lastError: reason,
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
