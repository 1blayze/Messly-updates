import { z } from "zod";
import { getGatewayUrl, getSupabaseAccessToken } from "../../api/client";

const DEFAULT_SIGNALING_PATH = "/voice";
const SIGNALING_PING_INTERVAL_MS = 10_000;
const SIGNALING_RECONNECT_BASE_DELAY_MS = 1_000;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 10_000;

export type VoicePresenceConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";
export type VoiceCallSessionStatus = "IDLE" | "RINGING" | "CONNECTED" | "RECONNECTING" | "ENDED";
export type VoiceCallParticipantStatus = "RINGING" | "CONNECTED" | "DISCONNECTED";
export type VoiceCallLifecycleEvent =
  | "CALL_STARTED"
  | "CALL_RINGING"
  | "CALL_JOINED"
  | "CALL_LEFT"
  | "CALL_RECONNECTED"
  | "CALL_ENDED"
  | "CALL_STATE_UPDATED";

export interface VoiceCallSessionParticipantSnapshot {
  userId: string;
  displayName: string;
  state: VoiceCallParticipantStatus;
  joinedAt: number;
  leftAt: number | null;
  lastSeenAt: number;
  muted: boolean;
  speaking: boolean;
}

export interface VoiceCallSessionSnapshot {
  callId: string;
  roomId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  status: VoiceCallSessionStatus;
  ringExpiresAt: number | null;
  connectedAt: number | null;
  endedAt: number | null;
  endedReason: string | null;
  singleParticipantSince: number | null;
  participants: VoiceCallSessionParticipantSnapshot[];
}

export interface VoiceCallStateUpdate {
  event: VoiceCallLifecycleEvent;
  roomId: string;
  call: VoiceCallSessionSnapshot;
}

export interface VoiceCallPresenceClientOptions {
  roomId: string;
  self: {
    userId: string;
    displayName: string;
  };
  signalingUrl?: string;
  onStateUpdate?: (update: VoiceCallStateUpdate) => void;
  onConnectionStateChanged?: (state: VoicePresenceConnectionState) => void;
  onError?: (error: Error) => void;
}

const connectedSignalSchema = z.object({
  type: z.literal("connected"),
  connectionId: z.string().trim().min(1),
});

const watchingSignalSchema = z.object({
  type: z.literal("watching"),
  roomId: z.string().trim().min(1),
});

const callStateSignalSchema = z.object({
  type: z.literal("call-state"),
  event: z.enum([
    "CALL_STARTED",
    "CALL_RINGING",
    "CALL_JOINED",
    "CALL_LEFT",
    "CALL_RECONNECTED",
    "CALL_ENDED",
    "CALL_STATE_UPDATED",
  ]),
  roomId: z.string().trim().min(1),
  call: z.object({
    callId: z.string().trim().min(1),
    roomId: z.string().trim().min(1),
    createdBy: z.string().trim().min(1),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    status: z.enum(["IDLE", "RINGING", "CONNECTED", "RECONNECTING", "ENDED"]),
    ringExpiresAt: z.number().finite().nullable(),
    connectedAt: z.number().finite().nullable(),
    endedAt: z.number().finite().nullable(),
    endedReason: z.string().trim().min(1).nullable(),
    singleParticipantSince: z.number().finite().nullable(),
    participants: z.array(z.object({
      userId: z.string().trim().min(1),
      displayName: z.string().trim().min(1),
      state: z.enum(["RINGING", "CONNECTED", "DISCONNECTED"]),
      joinedAt: z.number().finite(),
      leftAt: z.number().finite().nullable(),
      lastSeenAt: z.number().finite(),
      muted: z.boolean(),
      speaking: z.boolean(),
    })),
  }),
});

const errorSignalSchema = z.object({
  type: z.literal("error"),
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
});

const pongSignalSchema = z.object({
  type: z.literal("pong"),
  timestamp: z.number().finite().optional(),
});

const replacedSignalSchema = z.object({
  type: z.literal("replaced"),
  reason: z.string().trim().optional(),
});

const inboundSignalingSchema = z.discriminatedUnion("type", [
  connectedSignalSchema,
  watchingSignalSchema,
  callStateSignalSchema,
  errorSignalSchema,
  pongSignalSchema,
  replacedSignalSchema,
]);

type InboundSignalingMessage = z.infer<typeof inboundSignalingSchema>;

function resolveVoiceSignalingUrl(explicitUrlRaw: string | null | undefined): string | null {
  const explicitUrl = String(explicitUrlRaw ?? "").trim();
  if (explicitUrl) {
    try {
      const parsedExplicit = new URL(explicitUrl);
      if (parsedExplicit.protocol === "http:") {
        parsedExplicit.protocol = "ws:";
      }
      if (parsedExplicit.protocol === "https:") {
        parsedExplicit.protocol = "wss:";
      }
      return parsedExplicit.toString();
    } catch {
      return null;
    }
  }

  const gatewayUrl = String(getGatewayUrl() ?? "").trim();
  if (!gatewayUrl) {
    return null;
  }

  try {
    const parsed = new URL(gatewayUrl);
    parsed.pathname = DEFAULT_SIGNALING_PATH;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseInboundMessage(raw: string): InboundSignalingMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return inboundSignalingSchema.parse(parsed);
  } catch {
    return null;
  }
}

export class VoiceCallPresenceClient {
  private readonly roomId: string;
  private readonly selfUserId: string;
  private readonly selfDisplayName: string;
  private readonly signalingUrl: string | null;
  private readonly onStateUpdate: ((update: VoiceCallStateUpdate) => void) | null;
  private readonly onConnectionStateChanged: ((state: VoicePresenceConnectionState) => void) | null;
  private readonly onError: ((error: Error) => void) | null;

  private state: VoicePresenceConnectionState = "idle";
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimerId: number | null = null;
  private pingIntervalId: number | null = null;
  private stopRequested = false;
  private latestCallSnapshot: VoiceCallSessionSnapshot | null = null;

  constructor(options: VoiceCallPresenceClientOptions) {
    this.roomId = String(options.roomId ?? "").trim();
    this.selfUserId = String(options.self.userId ?? "").trim();
    this.selfDisplayName = String(options.self.displayName ?? "").trim() || this.selfUserId;
    this.signalingUrl = resolveVoiceSignalingUrl(options.signalingUrl);
    this.onStateUpdate = options.onStateUpdate ?? null;
    this.onConnectionStateChanged = options.onConnectionStateChanged ?? null;
    this.onError = options.onError ?? null;
  }

  getConnectionState(): VoicePresenceConnectionState {
    return this.state;
  }

  getLatestCallSnapshot(): VoiceCallSessionSnapshot | null {
    return this.latestCallSnapshot;
  }

  async start(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting" || this.state === "reconnecting") {
      return;
    }
    if (!this.roomId) {
      throw new Error("Sala de voz invalida para monitoramento.");
    }
    if (!this.selfUserId) {
      throw new Error("Usuario invalido para monitoramento de voz.");
    }
    if (!this.signalingUrl) {
      throw new Error("URL de signaling de voz indisponivel.");
    }

    this.stopRequested = false;
    this.reconnectAttempt = 0;
    this.setState("connecting");
    await this.connectSocket();
    this.startPingLoop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearReconnectTimer();
    this.clearPingLoop();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "VOICE_WATCH_STOP");
      } catch {
        // Ignore close failures.
      }
    }
    this.setState("closed");
  }

  private async connectSocket(): Promise<void> {
    if (!this.signalingUrl) {
      throw new Error("URL de signaling de voz indisponivel.");
    }

    const socket = new WebSocket(this.signalingUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, { once: true });

      socket.addEventListener("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Falha ao conectar no monitor de voz."));
      }, { once: true });
    });

    socket.addEventListener("message", (event) => {
      this.handleSignalingMessage(String(event.data ?? ""));
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.stopRequested) {
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // No-op: close flow handles reconnect.
    });

    await this.sendWatchSignal();
    this.reconnectAttempt = 0;
    this.setState("connected");
  }

  private handleSignalingMessage(raw: string): void {
    const payload = parseInboundMessage(raw);
    if (!payload) {
      return;
    }

    switch (payload.type) {
      case "connected":
      case "watching":
      case "pong":
        return;
      case "call-state":
        this.latestCallSnapshot = payload.call;
        this.onStateUpdate?.({
          event: payload.event,
          roomId: payload.roomId,
          call: payload.call,
        });
        return;
      case "error":
        this.onError?.(new Error(`${payload.message} (${payload.code})`));
        return;
      case "replaced":
        this.onError?.(new Error("Monitor de voz substituido por outra sessao."));
        return;
      default:
        return;
    }
  }

  private async sendWatchSignal(): Promise<void> {
    const accessToken = await getSupabaseAccessToken().catch(() => null);
    this.sendSignal({
      type: "watch",
      roomId: this.roomId,
      userId: this.selfUserId,
      displayName: this.selfDisplayName,
      accessToken: accessToken ?? undefined,
    });
  }

  private sendSignal(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore transient send failures while reconnecting.
    }
  }

  private startPingLoop(): void {
    this.clearPingLoop();
    this.sendSignal({ type: "ping", timestamp: Date.now() });
    this.pingIntervalId = window.setInterval(() => {
      this.sendSignal({ type: "ping", timestamp: Date.now() });
    }, SIGNALING_PING_INTERVAL_MS);
  }

  private clearPingLoop(): void {
    if (this.pingIntervalId != null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) {
      return;
    }
    this.clearReconnectTimer();
    this.setState("reconnecting");
    this.reconnectAttempt += 1;
    const delay = Math.min(
      SIGNALING_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, this.reconnectAttempt - 1),
      SIGNALING_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimerId = window.setTimeout(() => {
      void this.connectSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId != null) {
      window.clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  private setState(nextState: VoicePresenceConnectionState): void {
    if (this.state === nextState) {
      return;
    }
    this.state = nextState;
    this.onConnectionStateChanged?.(nextState);
  }
}
