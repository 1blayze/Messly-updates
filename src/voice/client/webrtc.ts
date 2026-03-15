import { z } from "zod";
import { getGatewayUrl, getSupabaseAccessToken } from "../../api/client";
import {
  attachRemoteAudioPlayback,
  captureMicrophoneStream,
  clearRemoteAudioPlayback,
  removeRemoteAudioPlayback,
  setAudioTrackMuted,
  stopMediaStream,
} from "./audio";
import { VoiceActivityDetector } from "./voiceDetection";

const DEFAULT_SIGNALING_PATH = "/voice";
const SIGNALING_PING_INTERVAL_MS = 5_000;
const SIGNALING_RECONNECT_BASE_DELAY_MS = 800;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 8_000;
const DIAGNOSTICS_POLL_INTERVAL_MS = 2_000;
const JOIN_RETRY_INTERVAL_MS = 2_500;
const DEFAULT_AUDIO_MAX_BITRATE = 32_000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  },
];

export type VoiceConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";
export type VoicePeerConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

export interface VoiceUserIdentity {
  userId: string;
  displayName: string;
  avatarSrc: string;
}

export interface VoiceParticipantState extends VoiceUserIdentity {
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  speakingLevel: number;
  connectionState: VoicePeerConnectionState;
}

export interface VoiceDiagnosticsPeerSnapshot {
  userId: string;
  pingMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number | null;
  inboundBitrateKbps: number | null;
  outboundBitrateKbps: number | null;
}

export interface VoiceDiagnosticsSnapshot {
  generatedAt: number;
  peers: VoiceDiagnosticsPeerSnapshot[];
}

export interface VoiceCallMediaPreferences {
  inputDeviceId?: string | null;
  outputDeviceId?: string | null;
  inputVolumePercent?: number | null;
  outputVolumePercent?: number | null;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface VoiceCallClientOptions {
  roomId: string;
  self: VoiceUserIdentity;
  peerDirectory?: Record<string, VoiceUserIdentity>;
  signalingUrl?: string;
  mediaPreferences?: VoiceCallMediaPreferences;
  onParticipantsChanged?: (participants: VoiceParticipantState[]) => void;
  onDiagnostics?: (snapshot: VoiceDiagnosticsSnapshot) => void;
  onConnectionStateChanged?: (state: VoiceConnectionState) => void;
  onError?: (error: Error) => void;
}

interface JoinedParticipant {
  userId: string;
  displayName: string;
  muted: boolean;
  speaking: boolean;
}

interface PeerStatsAccumulator {
  atMs: number;
  inboundBytes: number;
  outboundBytes: number;
}

interface PeerConnectionContext {
  userId: string;
  connection: RTCPeerConnection;
  remoteStream: MediaStream;
  pendingIceCandidates: RTCIceCandidateInit[];
  statsAccumulator: PeerStatsAccumulator | null;
}

interface PendingSpeakingState {
  speaking: boolean;
  level: number;
}

const connectedSignalSchema = z.object({
  type: z.literal("connected"),
  connectionId: z.string().trim().min(1),
});

const joinedSignalSchema = z.object({
  type: z.literal("joined"),
  roomId: z.string().trim().min(1),
  selfUserId: z.string().trim().min(1),
  participants: z.array(
    z.object({
      userId: z.string().trim().min(1),
      displayName: z.string().trim().min(1),
      muted: z.boolean(),
      speaking: z.boolean(),
    }),
  ),
});

const participantJoinedSignalSchema = z.object({
  type: z.literal("participant-joined"),
  participant: z.object({
    userId: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    muted: z.boolean(),
    speaking: z.boolean(),
  }),
});

const participantLeftSignalSchema = z.object({
  type: z.literal("participant-left"),
  userId: z.string().trim().min(1),
});

const offerSignalSchema = z.object({
  type: z.literal("offer"),
  fromUserId: z.string().trim().min(1),
  sdp: z.object({
    type: z.string().trim().min(1),
    sdp: z.string().min(1),
  }),
});

const answerSignalSchema = z.object({
  type: z.literal("answer"),
  fromUserId: z.string().trim().min(1),
  sdp: z.object({
    type: z.string().trim().min(1),
    sdp: z.string().min(1),
  }),
});

const iceSignalSchema = z.object({
  type: z.literal("ice-candidate"),
  fromUserId: z.string().trim().min(1),
  candidate: z.unknown(),
});

const muteStateSignalSchema = z.object({
  type: z.literal("participant-mute-state"),
  userId: z.string().trim().min(1),
  muted: z.boolean(),
});

const speakingStateSignalSchema = z.object({
  type: z.literal("participant-speaking-state"),
  userId: z.string().trim().min(1),
  speaking: z.boolean(),
  level: z.number().min(0).max(1).optional(),
});

const errorSignalSchema = z.object({
  type: z.literal("error"),
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
});

const replacedSignalSchema = z.object({
  type: z.literal("replaced"),
});

const pongSignalSchema = z.object({
  type: z.literal("pong"),
  timestamp: z.number().finite().optional(),
});

const inboundSignalingSchema = z.discriminatedUnion("type", [
  connectedSignalSchema,
  joinedSignalSchema,
  participantJoinedSignalSchema,
  participantLeftSignalSchema,
  offerSignalSchema,
  answerSignalSchema,
  iceSignalSchema,
  muteStateSignalSchema,
  speakingStateSignalSchema,
  errorSignalSchema,
  replacedSignalSchema,
  pongSignalSchema,
]);

type InboundSignalingMessage = z.infer<typeof inboundSignalingSchema>;

function toError(message: string, details?: unknown): Error {
  if (details == null) {
    return new Error(message);
  }
  return new Error(`${message}: ${String(details)}`);
}

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

function shouldInitiateOffer(selfUserId: string, remoteUserId: string): boolean {
  return selfUserId.localeCompare(remoteUserId) < 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toDisplayName(nameRaw: string | null | undefined, fallback: string): string {
  const normalized = String(nameRaw ?? "").trim();
  return normalized || fallback;
}

function parseInboundMessage(raw: string): InboundSignalingMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return inboundSignalingSchema.parse(parsed);
  } catch {
    return null;
  }
}

function normalizeErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error ?? "").trim() || "Falha na chamada de voz.";
}

function toRemoteSdpType(typeRaw: string): "offer" | "answer" {
  const normalized = String(typeRaw ?? "").trim().toLowerCase();
  if (normalized === "offer" || normalized === "answer") {
    return normalized;
  }
  throw new Error(`Tipo de SDP remoto invalido: ${normalized || "desconhecido"}`);
}

function canonicalizeSdpString(sdpRaw: string, stripSsrcAttributes = false): string {
  const lines = String(sdpRaw ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && /^[a-z]=/i.test(line));

  const filtered = stripSsrcAttributes
    ? lines.filter((line) => !line.startsWith("a=ssrc:") && !line.startsWith("a=ssrc-group:"))
    : lines;
  if (filtered.length === 0) {
    return "";
  }
  return `${filtered.join("\r\n")}\r\n`;
}

function normalizeMediaPreferences(preferences: VoiceCallMediaPreferences | null | undefined): Required<VoiceCallMediaPreferences> {
  const normalizedInputDeviceId = String(preferences?.inputDeviceId ?? "").trim();
  const normalizedOutputDeviceId = String(preferences?.outputDeviceId ?? "").trim();
  const requestedInputVolume = Number(preferences?.inputVolumePercent ?? 100);
  const requestedOutputVolume = Number(preferences?.outputVolumePercent ?? 100);
  const normalizedInputVolume = Number.isFinite(requestedInputVolume)
    ? Math.max(0, Math.min(100, requestedInputVolume))
    : 100;
  const normalizedOutputVolume = Number.isFinite(requestedOutputVolume)
    ? Math.max(0, Math.min(200, requestedOutputVolume))
    : 100;

  return {
    inputDeviceId: normalizedInputDeviceId,
    outputDeviceId: normalizedOutputDeviceId,
    inputVolumePercent: normalizedInputVolume,
    outputVolumePercent: normalizedOutputVolume,
    echoCancellation: preferences?.echoCancellation ?? true,
    noiseSuppression: preferences?.noiseSuppression ?? true,
    autoGainControl: preferences?.autoGainControl ?? true,
  };
}

export class VoiceCallClient {
  private readonly roomId: string;
  private readonly self: VoiceUserIdentity;
  private readonly peerDirectory = new Map<string, VoiceUserIdentity>();
  private readonly signalingUrl: string | null;
  private readonly mediaPreferences: Required<VoiceCallMediaPreferences>;
  private readonly onParticipantsChanged: ((participants: VoiceParticipantState[]) => void) | null;
  private readonly onDiagnostics: ((snapshot: VoiceDiagnosticsSnapshot) => void) | null;
  private readonly onConnectionStateChanged: ((state: VoiceConnectionState) => void) | null;
  private readonly onError: ((error: Error) => void) | null;

  private state: VoiceConnectionState = "idle";
  private joinedRoom = false;
  private localMuted = false;
  private socket: WebSocket | null = null;
  private reconnectTimerId: number | null = null;
  private reconnectAttempt = 0;
  private pingIntervalId: number | null = null;
  private diagnosticsIntervalId: number | null = null;
  private joinRetryIntervalId: number | null = null;
  private localStream: MediaStream | null = null;
  private localVoiceDetector: VoiceActivityDetector | null = null;
  private readonly participants = new Map<string, VoiceParticipantState>();
  private readonly peers = new Map<string, PeerConnectionContext>();
  private readonly remoteAudioElements = new Map<string, HTMLAudioElement>();
  private pendingSpeakingState: PendingSpeakingState | null = null;
  private lastSignalingRttMs: number | null = null;
  private leaving = false;

  constructor(options: VoiceCallClientOptions) {
    this.roomId = String(options.roomId ?? "").trim();
    this.self = {
      userId: String(options.self.userId ?? "").trim(),
      displayName: toDisplayName(options.self.displayName, "Voce"),
      avatarSrc: String(options.self.avatarSrc ?? "").trim(),
    };
    this.signalingUrl = resolveVoiceSignalingUrl(options.signalingUrl);
    this.mediaPreferences = normalizeMediaPreferences(options.mediaPreferences);
    this.onParticipantsChanged = options.onParticipantsChanged ?? null;
    this.onDiagnostics = options.onDiagnostics ?? null;
    this.onConnectionStateChanged = options.onConnectionStateChanged ?? null;
    this.onError = options.onError ?? null;

    if (options.peerDirectory) {
      for (const [userId, peer] of Object.entries(options.peerDirectory)) {
        const normalizedUserId = String(userId ?? "").trim();
        if (!normalizedUserId) {
          continue;
        }
        this.peerDirectory.set(normalizedUserId, {
          userId: normalizedUserId,
          displayName: toDisplayName(peer.displayName, normalizedUserId),
          avatarSrc: String(peer.avatarSrc ?? "").trim(),
        });
      }
    }

    this.peerDirectory.set(this.self.userId, this.self);
    this.participants.set(this.self.userId, {
      ...this.self,
      isLocal: true,
      muted: false,
      speaking: false,
      speakingLevel: 0,
      connectionState: "idle",
    });
    this.emitParticipants();
  }

  getConnectionState(): VoiceConnectionState {
    return this.state;
  }

  isMuted(): boolean {
    return this.localMuted;
  }

  updatePeerDirectory(entry: VoiceUserIdentity): void {
    const userId = String(entry.userId ?? "").trim();
    if (!userId) {
      return;
    }

    this.peerDirectory.set(userId, {
      userId,
      displayName: toDisplayName(entry.displayName, userId),
      avatarSrc: String(entry.avatarSrc ?? "").trim(),
    });

    const participant = this.participants.get(userId);
    if (!participant) {
      return;
    }

    this.participants.set(userId, {
      ...participant,
      displayName: toDisplayName(entry.displayName, participant.displayName || userId),
      avatarSrc: String(entry.avatarSrc ?? "").trim() || participant.avatarSrc,
    });
    this.emitParticipants();
  }

  async start(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting" || this.state === "reconnecting") {
      return;
    }

    if (!this.roomId) {
      throw new Error("Sala de voz invalida.");
    }
    if (!this.self.userId) {
      throw new Error("Usuario local invalido para chamada de voz.");
    }
    if (!this.signalingUrl) {
      throw new Error("URL de signaling de voz indisponivel.");
    }

    this.leaving = false;
    this.setConnectionState("connecting");
    try {
      this.localStream = await captureMicrophoneStream({
        echoCancellation: this.mediaPreferences.echoCancellation,
        noiseSuppression: this.mediaPreferences.noiseSuppression,
        autoGainControl: this.mediaPreferences.autoGainControl,
        channelCount: 1,
        deviceId: this.mediaPreferences.inputDeviceId,
        inputVolumePercent: this.mediaPreferences.inputVolumePercent,
      });
      this.localMuted = false;
      this.updateLocalParticipant({
        muted: false,
        speaking: false,
        speakingLevel: 0,
        connectionState: "connecting",
      });
      this.localVoiceDetector = new VoiceActivityDetector(this.localStream, {
        onSpeakingChange: (speaking, level) => {
          const normalizedLevel = clamp(level, 0, 1);
          this.updateLocalParticipant({
            speaking,
            speakingLevel: level,
          });
          this.pendingSpeakingState = {
            speaking,
            level: normalizedLevel,
          };
          if (this.joinedRoom) {
            this.sendSignal({
              type: "speaking-state",
              speaking,
              level: normalizedLevel,
            });
          }
        },
        onLevel: (level) => {
          const current = this.participants.get(this.self.userId);
          if (!current || !current.speaking) {
            return;
          }
          this.updateLocalParticipant({
            speakingLevel: level,
          });
        },
      });
      await this.localVoiceDetector.start();
      await this.connectSignaling();
      this.startIntervals();
    } catch (error) {
      this.handleError(toError("Nao foi possivel iniciar chamada de voz", normalizeErrorMessage(error)));
      await this.leave().catch(() => undefined);
      throw error;
    }
  }

  async leave(): Promise<void> {
    this.leaving = true;
    this.joinedRoom = false;
    this.clearReconnectTimer();
    this.clearIntervals();
    this.clearJoinRetryLoop();
    this.pendingSpeakingState = null;
    this.lastSignalingRttMs = null;

    this.localVoiceDetector?.stop();
    this.localVoiceDetector = null;

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendSignal({ type: "leave" });
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "VOICE_LEAVE");
      } catch {
        // Ignore close failures.
      }
    }

    this.disposePeerConnections();
    clearRemoteAudioPlayback(this.remoteAudioElements);
    stopMediaStream(this.localStream);
    this.localStream = null;

    this.participants.clear();
    this.participants.set(this.self.userId, {
      ...this.self,
      isLocal: true,
      muted: false,
      speaking: false,
      speakingLevel: 0,
      connectionState: "idle",
    });
    this.emitParticipants();
    this.setConnectionState("closed");
  }

  setMuted(muted: boolean): void {
    this.localMuted = muted;
    setAudioTrackMuted(this.localStream, muted);
    this.updateLocalParticipant({
      muted,
    });
    if (this.joinedRoom) {
      this.sendSignal({
        type: "mute-state",
        muted,
      });
    }
  }

  toggleMuted(): void {
    this.setMuted(!this.localMuted);
  }

  private async connectSignaling(): Promise<void> {
    if (!this.signalingUrl) {
      throw new Error("URL de signaling indisponivel.");
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
        reject(new Error("Falha ao conectar no servidor de voz."));
      }, { once: true });
    });

    socket.addEventListener("message", (event) => {
      this.handleSignalingMessage(String(event.data ?? ""));
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.joinedRoom = false;
      this.clearJoinRetryLoop();
      if (this.leaving) {
        return;
      }

      this.disposePeerConnections();
      this.clearRemoteParticipants();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // No-op: close flow handles reconnect.
    });

    this.joinedRoom = false;
    void this.sendJoinSignal();
    this.startJoinRetryLoop();
  }

  private handleSignalingMessage(raw: string): void {
    const payload = parseInboundMessage(raw);
    if (!payload) {
      return;
    }

    switch (payload.type) {
      case "connected":
        return;
      case "joined":
        this.handleJoinedRoom(payload.participants);
        return;
      case "participant-joined":
        this.handleParticipantJoined(payload.participant);
        return;
      case "participant-left":
        this.handleParticipantLeft(payload.userId);
        return;
      case "offer":
        void this.handleRemoteOffer(payload.fromUserId, payload.sdp).catch((error) => {
          this.handleError(toError("Falha ao processar offer WebRTC", normalizeErrorMessage(error)));
        });
        return;
      case "answer":
        void this.handleRemoteAnswer(payload.fromUserId, payload.sdp).catch((error) => {
          this.handleError(toError("Falha ao processar answer WebRTC", normalizeErrorMessage(error)));
        });
        return;
      case "ice-candidate":
        void this.handleRemoteIceCandidate(payload.fromUserId, payload.candidate).catch((error) => {
          this.handleError(toError("Falha ao processar ICE candidate", normalizeErrorMessage(error)));
        });
        return;
      case "participant-mute-state":
        this.updateRemoteParticipant(payload.userId, {
          muted: payload.muted,
        });
        return;
      case "participant-speaking-state":
        this.updateRemoteParticipant(payload.userId, {
          speaking: payload.speaking,
          speakingLevel: payload.level ?? (payload.speaking ? 1 : 0),
        });
        return;
      case "error":
        if (payload.code === "NOT_IN_ROOM" && !this.joinedRoom) {
          return;
        }
        this.handleError(toError(payload.message, payload.code));
        return;
      case "replaced":
        this.handleError(new Error("Outra sessao substituiu esta chamada de voz."));
        void this.leave().catch(() => undefined);
        return;
      case "pong": {
        const nowMs = Date.now();
        const echoedAtMs = typeof payload.timestamp === "number" ? payload.timestamp : NaN;
        if (Number.isFinite(echoedAtMs)) {
          const rttMs = nowMs - echoedAtMs;
          if (rttMs >= 0 && rttMs <= 120_000) {
            this.lastSignalingRttMs = Math.round(rttMs);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private handleJoinedRoom(participants: JoinedParticipant[]): void {
    this.joinedRoom = true;
    this.clearJoinRetryLoop();
    this.reconnectAttempt = 0;
    this.setConnectionState("connected");
    this.updateLocalParticipant({
      connectionState: "connected",
    });
    this.sendSignal({
      type: "mute-state",
      muted: this.localMuted,
    });
    if (this.pendingSpeakingState) {
      this.sendSignal({
        type: "speaking-state",
        speaking: this.pendingSpeakingState.speaking,
        level: this.pendingSpeakingState.level,
      });
    }

    const presentRemoteUsers = new Set<string>();
    for (const participant of participants) {
      if (!participant.userId || participant.userId === this.self.userId) {
        continue;
      }
      presentRemoteUsers.add(participant.userId);
      this.ensureRemoteParticipant(participant.userId, participant.displayName, {
        muted: participant.muted,
        speaking: participant.speaking,
        speakingLevel: participant.speaking ? 1 : 0,
      });
      this.ensurePeerConnection(participant.userId);
      if (shouldInitiateOffer(this.self.userId, participant.userId)) {
        void this.createAndSendOffer(participant.userId).catch((error) => {
          this.handleError(toError("Falha ao enviar offer WebRTC", normalizeErrorMessage(error)));
        });
      }
    }

    for (const [userId] of this.peers) {
      if (!presentRemoteUsers.has(userId)) {
        this.disposePeerConnection(userId);
        this.removeRemoteParticipant(userId);
      }
    }
  }

  private handleParticipantJoined(participant: JoinedParticipant): void {
    if (!participant.userId || participant.userId === this.self.userId) {
      return;
    }

    this.ensureRemoteParticipant(participant.userId, participant.displayName, {
      muted: participant.muted,
      speaking: participant.speaking,
      speakingLevel: participant.speaking ? 1 : 0,
      connectionState: "connecting",
    });
    this.ensurePeerConnection(participant.userId);
    if (shouldInitiateOffer(this.self.userId, participant.userId)) {
      void this.createAndSendOffer(participant.userId).catch((error) => {
        this.handleError(toError("Falha ao enviar offer WebRTC", normalizeErrorMessage(error)));
      });
    }
  }

  private handleParticipantLeft(userIdRaw: string): void {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      return;
    }
    this.disposePeerConnection(userId);
    this.removeRemoteParticipant(userId);
  }

  private async handleRemoteOffer(userIdRaw: string, descriptionRaw: { type: string; sdp: string }): Promise<void> {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      return;
    }

    const peerContext = this.ensurePeerConnection(userId);
    const connection = peerContext.connection;

    if (connection.signalingState !== "stable") {
      await connection.setLocalDescription({ type: "rollback" }).catch(() => undefined);
    }
    await this.setRemoteDescriptionWithRecovery(connection, descriptionRaw);

    await this.flushPendingIceCandidates(userId);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    const localAnswer = this.toLocalSdpPayload(connection.localDescription);
    if (!localAnswer) {
      return;
    }
    this.sendSignal({
      type: "answer",
      targetUserId: userId,
      sdp: localAnswer,
    });
  }

  private async handleRemoteAnswer(userIdRaw: string, descriptionRaw: { type: string; sdp: string }): Promise<void> {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      return;
    }

    const peerContext = this.peers.get(userId);
    if (!peerContext) {
      return;
    }

    await this.setRemoteDescriptionWithRecovery(peerContext.connection, descriptionRaw);
    await this.flushPendingIceCandidates(userId);
  }

  private async handleRemoteIceCandidate(userIdRaw: string, candidateRaw: unknown): Promise<void> {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId || !candidateRaw || typeof candidateRaw !== "object") {
      return;
    }

    const peerContext = this.ensurePeerConnection(userId);
    const candidate = candidateRaw as RTCIceCandidateInit;
    const remoteDescription = peerContext.connection.remoteDescription;

    if (!remoteDescription) {
      peerContext.pendingIceCandidates.push(candidate);
      return;
    }

    await peerContext.connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }

  private ensurePeerConnection(userId: string): PeerConnectionContext {
    const existing = this.peers.get(userId);
    if (existing) {
      return existing;
    }

    const connection = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 2,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    const remoteStream = new MediaStream();

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        const sender = connection.addTrack(track, this.localStream);
        this.configureAudioSender(connection, sender);
      }
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      this.sendSignal({
        type: "ice-candidate",
        targetUserId: userId,
        candidate: event.candidate.toJSON(),
      });
    };

    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? remoteStream;
      if (stream !== remoteStream) {
        for (const track of stream.getAudioTracks()) {
          remoteStream.addTrack(track);
        }
      } else {
        remoteStream.addTrack(event.track);
      }
      attachRemoteAudioPlayback(remoteStream, userId, this.remoteAudioElements, {
        outputDeviceId: this.mediaPreferences.outputDeviceId,
        outputVolumePercent: this.mediaPreferences.outputVolumePercent,
      });
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        this.updateRemoteParticipant(userId, { connectionState: "connected" });
        return;
      }

      if (state === "connecting" || state === "new") {
        this.updateRemoteParticipant(userId, { connectionState: "connecting" });
        return;
      }

      if (state === "disconnected") {
        this.updateRemoteParticipant(userId, { connectionState: "disconnected" });
        return;
      }

      if (state === "failed") {
        this.updateRemoteParticipant(userId, { connectionState: "failed" });
        try {
          connection.restartIce();
        } catch {
          // Ignore restart errors.
        }
      }
    };

    const peerContext: PeerConnectionContext = {
      userId,
      connection,
      remoteStream,
      pendingIceCandidates: [],
      statsAccumulator: null,
    };
    this.peers.set(userId, peerContext);
    this.updateRemoteParticipant(userId, { connectionState: "connecting" });
    return peerContext;
  }

  private async createAndSendOffer(userId: string): Promise<void> {
    const peerContext = this.ensurePeerConnection(userId);
    const connection = peerContext.connection;
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const localOffer = this.toLocalSdpPayload(connection.localDescription);
    if (!localOffer) {
      return;
    }
    this.sendSignal({
      type: "offer",
      targetUserId: userId,
      sdp: localOffer,
    });
  }

  private async setRemoteDescriptionWithRecovery(
    connection: RTCPeerConnection,
    descriptionRaw: { type: string; sdp: string },
  ): Promise<void> {
    const type = toRemoteSdpType(descriptionRaw.type);
    const canonical = canonicalizeSdpString(descriptionRaw.sdp, false);
    if (!canonical) {
      throw new Error("SDP remoto vazio.");
    }

    try {
      await connection.setRemoteDescription({
        type,
        sdp: canonical,
      });
      return;
    } catch (primaryError) {
      const withoutSsrc = canonicalizeSdpString(descriptionRaw.sdp, true);
      if (!withoutSsrc || withoutSsrc === canonical) {
        throw primaryError;
      }

      try {
        await connection.setRemoteDescription({
          type,
          sdp: withoutSsrc,
        });
        return;
      } catch {
        throw primaryError;
      }
    }
  }

  private toLocalSdpPayload(description: RTCSessionDescription | null): { type: string; sdp: string } | null {
    if (!description) {
      return null;
    }
    const canonical = canonicalizeSdpString(description.sdp ?? "", false);
    if (!canonical) {
      return null;
    }
    return {
      type: description.type,
      sdp: canonical,
    };
  }

  private async flushPendingIceCandidates(userId: string): Promise<void> {
    const peerContext = this.peers.get(userId);
    if (!peerContext || peerContext.pendingIceCandidates.length === 0) {
      return;
    }

    const pending = [...peerContext.pendingIceCandidates];
    peerContext.pendingIceCandidates = [];
    for (const candidate of pending) {
      await peerContext.connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
    }
  }

  private configureAudioSender(connection: RTCPeerConnection, sender: RTCRtpSender): void {
    const transceiver = connection.getTransceivers().find((candidate) => candidate.sender === sender);
    if (transceiver?.setCodecPreferences && typeof RTCRtpSender !== "undefined") {
      const capabilities = RTCRtpSender.getCapabilities?.("audio")?.codecs ?? [];
      if (capabilities.length > 0) {
        const opusCodecs = capabilities.filter((codec) => codec.mimeType.toLowerCase() === "audio/opus");
        if (opusCodecs.length > 0) {
          const fallbackCodecs = capabilities.filter((codec) => codec.mimeType.toLowerCase() !== "audio/opus");
          transceiver.setCodecPreferences([...opusCodecs, ...fallbackCodecs]);
        }
      }
    }

    const parameters = sender.getParameters();
    const encodings = parameters.encodings && parameters.encodings.length > 0
      ? [...parameters.encodings]
      : [{}];
    encodings[0] = {
      ...encodings[0],
      maxBitrate: DEFAULT_AUDIO_MAX_BITRATE,
    };
    parameters.encodings = encodings;
    void sender.setParameters(parameters).catch(() => undefined);
  }

  private async sendJoinSignal(): Promise<void> {
    const accessToken = await getSupabaseAccessToken().catch(() => null);
    this.sendSignal({
      type: "join",
      roomId: this.roomId,
      userId: this.self.userId,
      displayName: this.self.displayName,
      accessToken: accessToken ?? undefined,
    });
  }

  private startJoinRetryLoop(): void {
    this.clearJoinRetryLoop();
    this.joinRetryIntervalId = window.setInterval(() => {
      if (this.joinedRoom || this.leaving) {
        this.clearJoinRetryLoop();
        return;
      }
      void this.sendJoinSignal();
    }, JOIN_RETRY_INTERVAL_MS);
  }

  private clearJoinRetryLoop(): void {
    if (this.joinRetryIntervalId != null) {
      window.clearInterval(this.joinRetryIntervalId);
      this.joinRetryIntervalId = null;
    }
  }

  private sendSignal(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore send failures while reconnecting.
    }
  }

  private startIntervals(): void {
    this.clearIntervals();
    this.sendSignal({
      type: "ping",
      timestamp: Date.now(),
    });

    this.pingIntervalId = window.setInterval(() => {
      this.sendSignal({
        type: "ping",
        timestamp: Date.now(),
      });
    }, SIGNALING_PING_INTERVAL_MS);

    this.diagnosticsIntervalId = window.setInterval(() => {
      void this.collectDiagnostics();
    }, DIAGNOSTICS_POLL_INTERVAL_MS);
  }

  private clearIntervals(): void {
    if (this.pingIntervalId != null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.diagnosticsIntervalId != null) {
      window.clearInterval(this.diagnosticsIntervalId);
      this.diagnosticsIntervalId = null;
    }
  }

  private async collectDiagnostics(): Promise<void> {
    if (!this.onDiagnostics) {
      return;
    }

    const peerSnapshots: VoiceDiagnosticsPeerSnapshot[] = [];
    for (const [userId, peerContext] of this.peers.entries()) {
      const stats = await peerContext.connection.getStats().catch(() => null);
      if (!stats) {
        continue;
      }

      let pingMs: number | null = null;
      let jitterMs: number | null = null;
      let packetLossPercent: number | null = null;
      let inboundBytes = 0;
      let outboundBytes = 0;
      let selectedCandidatePairId: string | null = null;
      let candidatePairRttMs: number | null = null;
      let remoteInboundRttMs: number | null = null;

      stats.forEach((report) => {
        if (report.type === "transport") {
          const transport = report as RTCStats & { selectedCandidatePairId?: string };
          if (typeof transport.selectedCandidatePairId === "string" && transport.selectedCandidatePairId) {
            selectedCandidatePairId = transport.selectedCandidatePairId;
          }
        }

        if (report.type === "candidate-pair") {
          const candidatePair = report as RTCStats & {
            currentRoundTripTime?: number;
            selected?: boolean;
            nominated?: boolean;
            state?: string;
          };
          const isActivePair =
            candidatePair.selected === true ||
            candidatePair.nominated === true ||
            candidatePair.state === "succeeded";
          if (isActivePair && typeof candidatePair.currentRoundTripTime === "number") {
            candidatePairRttMs = Math.round(candidatePair.currentRoundTripTime * 1_000);
          }
        }

        if (report.type === "inbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const inbound = report as RTCStats & {
            bytesReceived?: number;
            jitter?: number;
            packetsLost?: number;
            packetsReceived?: number;
          };
          inboundBytes = typeof inbound.bytesReceived === "number" ? inbound.bytesReceived : inboundBytes;
          if (typeof inbound.jitter === "number") {
            jitterMs = Math.round(inbound.jitter * 1_000);
          }
          const packetsLost = typeof inbound.packetsLost === "number" ? inbound.packetsLost : 0;
          const packetsReceived = typeof inbound.packetsReceived === "number" ? inbound.packetsReceived : 0;
          const total = packetsLost + packetsReceived;
          packetLossPercent = total > 0 ? Number(((packetsLost / total) * 100).toFixed(2)) : null;
        }

        if (report.type === "outbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const outbound = report as RTCStats & { bytesSent?: number };
          outboundBytes = typeof outbound.bytesSent === "number" ? outbound.bytesSent : outboundBytes;
        }

        if (report.type === "remote-inbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const remoteInbound = report as RTCStats & { roundTripTime?: number };
          if (typeof remoteInbound.roundTripTime === "number") {
            remoteInboundRttMs = Math.round(remoteInbound.roundTripTime * 1_000);
          }
        }
      });
      if (selectedCandidatePairId) {
        const selectedPair = stats.get(selectedCandidatePairId) as (RTCStats & { currentRoundTripTime?: number }) | undefined;
        if (selectedPair && typeof selectedPair.currentRoundTripTime === "number") {
          candidatePairRttMs = Math.round(selectedPair.currentRoundTripTime * 1_000);
        }
      }
      pingMs = candidatePairRttMs ?? remoteInboundRttMs ?? this.lastSignalingRttMs;

      const nowMs = performance.now();
      let inboundBitrateKbps: number | null = null;
      let outboundBitrateKbps: number | null = null;
      if (peerContext.statsAccumulator) {
        const elapsedMs = Math.max(1, nowMs - peerContext.statsAccumulator.atMs);
        const inboundDeltaBytes = Math.max(0, inboundBytes - peerContext.statsAccumulator.inboundBytes);
        const outboundDeltaBytes = Math.max(0, outboundBytes - peerContext.statsAccumulator.outboundBytes);
        inboundBitrateKbps = Number(((inboundDeltaBytes * 8) / (elapsedMs / 1_000) / 1_000).toFixed(1));
        outboundBitrateKbps = Number(((outboundDeltaBytes * 8) / (elapsedMs / 1_000) / 1_000).toFixed(1));
      }
      peerContext.statsAccumulator = {
        atMs: nowMs,
        inboundBytes,
        outboundBytes,
      };

      peerSnapshots.push({
        userId,
        pingMs,
        jitterMs,
        packetLossPercent,
        inboundBitrateKbps,
        outboundBitrateKbps,
      });
    }

    this.onDiagnostics({
      generatedAt: Date.now(),
      peers: peerSnapshots,
    });
  }

  private scheduleReconnect(): void {
    if (this.leaving) {
      return;
    }

    this.clearReconnectTimer();
    this.setConnectionState("reconnecting");
    this.reconnectAttempt += 1;

    const backoffDelay = Math.min(
      SIGNALING_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, this.reconnectAttempt - 1),
      SIGNALING_RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectTimerId = window.setTimeout(() => {
      void this.connectSignaling().catch(() => {
        this.scheduleReconnect();
      });
    }, backoffDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId != null) {
      window.clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  private disposePeerConnection(userId: string): void {
    const peerContext = this.peers.get(userId);
    if (!peerContext) {
      return;
    }

    peerContext.connection.onicecandidate = null;
    peerContext.connection.ontrack = null;
    peerContext.connection.onconnectionstatechange = null;
    try {
      peerContext.connection.close();
    } catch {
      // Ignore close errors.
    }
    peerContext.remoteStream.getTracks().forEach((track) => track.stop());
    this.peers.delete(userId);
    removeRemoteAudioPlayback(userId, this.remoteAudioElements);
  }

  private disposePeerConnections(): void {
    for (const [userId] of this.peers) {
      this.disposePeerConnection(userId);
    }
  }

  private setConnectionState(state: VoiceConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onConnectionStateChanged?.(state);
  }

  private handleError(error: Error): void {
    this.onError?.(error);
  }

  private updateLocalParticipant(
    patch: Partial<Pick<VoiceParticipantState, "muted" | "speaking" | "speakingLevel" | "connectionState">>,
  ): void {
    const current = this.participants.get(this.self.userId);
    if (!current) {
      return;
    }

    this.participants.set(this.self.userId, {
      ...current,
      ...patch,
      isLocal: true,
    });
    this.emitParticipants();
  }

  private ensureRemoteParticipant(
    userId: string,
    displayName: string,
    patch: Partial<Pick<VoiceParticipantState, "muted" | "speaking" | "speakingLevel" | "connectionState">>,
  ): void {
    const directoryEntry = this.peerDirectory.get(userId);
    const nextIdentity: VoiceUserIdentity = directoryEntry ?? {
      userId,
      displayName: toDisplayName(displayName, userId),
      avatarSrc: "",
    };

    this.participants.set(userId, {
      userId,
      displayName: toDisplayName(nextIdentity.displayName, userId),
      avatarSrc: String(nextIdentity.avatarSrc ?? "").trim(),
      isLocal: false,
      muted: patch.muted ?? false,
      speaking: patch.speaking ?? false,
      speakingLevel: patch.speakingLevel ?? 0,
      connectionState: patch.connectionState ?? "connecting",
    });
    this.emitParticipants();
  }

  private updateRemoteParticipant(
    userIdRaw: string,
    patch: Partial<Pick<VoiceParticipantState, "muted" | "speaking" | "speakingLevel" | "connectionState">>,
  ): void {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId || userId === this.self.userId) {
      return;
    }

    const current = this.participants.get(userId);
    if (!current) {
      this.ensureRemoteParticipant(userId, userId, patch);
      return;
    }

    this.participants.set(userId, {
      ...current,
      ...patch,
      speakingLevel: patch.speakingLevel ?? current.speakingLevel,
    });
    this.emitParticipants();
  }

  private removeRemoteParticipant(userIdRaw: string): void {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId || userId === this.self.userId) {
      return;
    }
    this.participants.delete(userId);
    removeRemoteAudioPlayback(userId, this.remoteAudioElements);
    this.emitParticipants();
  }

  private clearRemoteParticipants(): void {
    for (const userId of this.participants.keys()) {
      if (userId !== this.self.userId) {
        this.participants.delete(userId);
      }
    }
    clearRemoteAudioPlayback(this.remoteAudioElements);
    this.emitParticipants();
  }

  private emitParticipants(): void {
    if (!this.onParticipantsChanged) {
      return;
    }
    this.onParticipantsChanged(Array.from(this.participants.values()));
  }
}
