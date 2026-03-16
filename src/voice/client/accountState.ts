import { z } from "zod";
import { getGatewayUrl, getSupabaseAccessToken } from "../../api/client";
import type { VoiceCallSessionSnapshot } from "./presence";

const DEFAULT_SIGNALING_PATH = "/voice";
const SIGNALING_PING_INTERVAL_MS = 3_000;
const SIGNALING_RECONNECT_BASE_DELAY_MS = 800;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 8_000;

export type VoiceAccountStateConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface VoiceAccountCallStateSnapshot {
  userId: string;
  callId: string;
  roomId: string;
  callStatus: "IDLE" | "RINGING" | "CONNECTED" | "RECONNECTING" | "ENDED";
  participantState: "RINGING" | "CONNECTED" | "DISCONNECTED";
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  connectedAt: number | null;
  updatedAt: number;
}

export interface VoiceAccountAudioSessionSnapshot {
  sessionId: string;
  userId: string;
  callId: string;
  roomId: string;
  deviceId: string;
  connectedAt: number;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  connectionState: "connecting" | "connected" | "reconnecting" | "disconnected";
  lastHeartbeatAt: number;
  updatedAt: number;
}

export interface VoiceAccountCallStateUpdate {
  userId: string;
  state: VoiceAccountCallStateSnapshot | null;
  call: VoiceCallSessionSnapshot | null;
  session: VoiceAccountAudioSessionSnapshot | null;
}

export interface VoiceCallAccountStateClientOptions {
  self: {
    userId: string;
    displayName: string;
  };
  signalingUrl?: string;
  onStateUpdate?: (update: VoiceAccountCallStateUpdate) => void;
  onConnectionStateChanged?: (state: VoiceAccountStateConnectionState) => void;
  onError?: (error: Error) => void;
}

const connectedSignalSchema = z.object({
  type: z.literal("connected"),
  connectionId: z.string().trim().min(1),
});

const watchingUserCallStateSignalSchema = z.object({
  type: z.literal("watching-user-call-state"),
  userId: z.string().trim().min(1),
});

const callSnapshotSchema = z.object({
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
  participants: z.array(
    z.object({
      userId: z.string().trim().min(1),
      displayName: z.string().trim().min(1),
      state: z.enum(["RINGING", "CONNECTED", "DISCONNECTED"]),
      joinedAt: z.number().finite(),
      leftAt: z.number().finite().nullable(),
      lastSeenAt: z.number().finite(),
      muted: z.boolean(),
      deafened: z.boolean().optional().default(false),
      speaking: z.boolean(),
    }),
  ),
});

const userCallStateSignalSchema = z.object({
  type: z.literal("user-call-state"),
  userId: z.string().trim().min(1),
  state: z.object({
    userId: z.string().trim().min(1),
    callId: z.string().trim().min(1),
    roomId: z.string().trim().min(1),
    callStatus: z.enum(["IDLE", "RINGING", "CONNECTED", "RECONNECTING", "ENDED"]),
    participantState: z.enum(["RINGING", "CONNECTED", "DISCONNECTED"]),
    muted: z.boolean().optional().default(false),
    deafened: z.boolean().optional().default(false),
    speaking: z.boolean().optional().default(false),
    connectedAt: z.number().finite().nullable().optional().default(null),
    updatedAt: z.number().finite(),
  }).nullable(),
  call: callSnapshotSchema.nullable(),
});

const voiceSessionSignalSchema = z.object({
  type: z.literal("voice-session"),
  userId: z.string().trim().min(1),
  event: z.enum([
    "VOICE_SESSION_START",
    "VOICE_SESSION_UPDATE",
    "VOICE_SESSION_RECONNECT",
    "VOICE_SESSION_END",
  ]),
  session: z.object({
    sessionId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    callId: z.string().trim().min(1),
    roomId: z.string().trim().min(1),
    deviceId: z.string().trim().min(1),
    connectedAt: z.number().finite(),
    muted: z.boolean(),
    deafened: z.boolean(),
    speaking: z.boolean(),
    connectionState: z.enum(["connecting", "connected", "reconnecting", "disconnected"]),
    lastHeartbeatAt: z.number().finite(),
    updatedAt: z.number().finite(),
  }).nullable(),
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
  watchingUserCallStateSignalSchema,
  userCallStateSignalSchema,
  voiceSessionSignalSchema,
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

export class VoiceCallAccountStateClient {
  private readonly selfUserId: string;
  private readonly selfDisplayName: string;
  private readonly signalingUrl: string | null;
  private readonly onStateUpdate: ((update: VoiceAccountCallStateUpdate) => void) | null;
  private readonly onConnectionStateChanged: ((state: VoiceAccountStateConnectionState) => void) | null;
  private readonly onError: ((error: Error) => void) | null;

  private state: VoiceAccountStateConnectionState = "idle";
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimerId: number | null = null;
  private pingIntervalId: number | null = null;
  private lastPongAtMs = 0;
  private stopRequested = false;
  private latestState: VoiceAccountCallStateUpdate | null = null;

  constructor(options: VoiceCallAccountStateClientOptions) {
    this.selfUserId = String(options.self.userId ?? "").trim();
    this.selfDisplayName = String(options.self.displayName ?? "").trim() || this.selfUserId;
    this.signalingUrl = resolveVoiceSignalingUrl(options.signalingUrl);
    this.onStateUpdate = options.onStateUpdate ?? null;
    this.onConnectionStateChanged = options.onConnectionStateChanged ?? null;
    this.onError = options.onError ?? null;
  }

  getConnectionState(): VoiceAccountStateConnectionState {
    return this.state;
  }

  getLatestState(): VoiceAccountCallStateUpdate | null {
    return this.latestState;
  }

  async start(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting" || this.state === "reconnecting") {
      return;
    }
    if (!this.selfUserId) {
      throw new Error("Usuario invalido para monitoramento global de voz.");
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
    this.lastPongAtMs = 0;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        try {
          socket.close(1000, "VOICE_ACCOUNT_WATCH_STOP");
        } catch {
          // Ignore close failures.
        }
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
        if (this.stopRequested || this.socket !== socket) {
          settled = true;
          try {
            socket.close(1000, "VOICE_ACCOUNT_WATCH_STOP");
          } catch {
            // Ignore close failures.
          }
          reject(new Error("Monitor global de voz cancelado."));
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
        reject(new Error("Falha ao conectar no monitor global de voz."));
      }, { once: true });

      socket.addEventListener("close", () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Conexao global de voz encerrada durante a inicializacao."));
      }, { once: true });
    });

    if (this.stopRequested || this.socket !== socket) {
      try {
        socket.close(1000, "VOICE_ACCOUNT_WATCH_STOP");
      } catch {
        // Ignore close failures.
      }
      throw new Error("Monitor global de voz cancelado.");
    }
    this.lastPongAtMs = Date.now();

    socket.addEventListener("message", (event) => {
      this.handleSignalingMessage(String(event.data ?? ""));
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.lastPongAtMs = 0;
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
    this.lastPongAtMs = Date.now();

    switch (payload.type) {
      case "connected":
      case "watching-user-call-state":
      case "pong":
        return;
      case "user-call-state":
        this.latestState = {
          userId: payload.userId,
          state: payload.state,
          call: payload.call,
          session: this.latestState?.userId === payload.userId ? this.latestState.session : null,
        };
        this.onStateUpdate?.(this.latestState);
        return;
      case "voice-session":
        this.latestState = {
          userId: payload.userId,
          state: this.latestState?.userId === payload.userId ? this.latestState.state : null,
          call: this.latestState?.userId === payload.userId ? this.latestState.call : null,
          session: payload.session,
        };
        this.onStateUpdate?.(this.latestState);
        return;
      case "error":
        this.onError?.(new Error(`${payload.message} (${payload.code})`));
        return;
      case "replaced":
        this.onError?.(new Error("Monitor global de voz substituido por outra sessao."));
        return;
      default:
        return;
    }
  }

  private async sendWatchSignal(): Promise<void> {
    const accessToken = await getSupabaseAccessToken().catch(() => null);
    this.sendSignal({
      type: "watch-user-call-state",
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
    this.lastPongAtMs = Date.now();
    this.sendSignal({ type: "ping", timestamp: Date.now() });
    this.pingIntervalId = window.setInterval(() => {
      this.ensureSocketHealth();
      this.sendSignal({ type: "ping", timestamp: Date.now() });
    }, SIGNALING_PING_INTERVAL_MS);
  }

  private clearPingLoop(): void {
    if (this.pingIntervalId != null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  private ensureSocketHealth(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.stopRequested) {
      return;
    }
    if (this.lastPongAtMs <= 0) {
      this.lastPongAtMs = Date.now();
      return;
    }
    const silentMs = Date.now() - this.lastPongAtMs;
    if (silentMs <= SIGNALING_PING_INTERVAL_MS * 3) {
      return;
    }
    try {
      socket.close(4001, "VOICE_ACCOUNT_WATCH_PING_TIMEOUT");
    } catch {
      // Ignore close failures.
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

  private setState(nextState: VoiceAccountStateConnectionState): void {
    if (this.state === nextState) {
      return;
    }
    this.state = nextState;
    this.onConnectionStateChanged?.(nextState);
  }
}
