import { z } from "zod";
import { getGatewayUrl, getSupabaseAccessToken } from "../../api/client";
import {
  attachRemoteAudioPlayback,
  captureMicrophoneStream,
  clearRemoteAudioPlayback,
  createVoiceAudioPipeline,
  removeRemoteAudioPlayback,
  setAudioTrackMuted,
  setRemoteAudioPlaybackMuted,
  stopMediaStream,
  type VoiceAudioPipelineSession,
  type VoiceInputQualityReport,
} from "./audio";
import { VoiceActivityDetector } from "./voiceDetection";

const DEFAULT_SIGNALING_PATH = "/voice";
const SIGNALING_PING_INTERVAL_MS = 5_000;
const SIGNALING_RECONNECT_BASE_DELAY_MS = 800;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 8_000;
const DIAGNOSTICS_POLL_INTERVAL_MS = 2_000;
const JOIN_RETRY_INTERVAL_MS = 2_500;
const VOICE_AUDIO_TARGET_MAX_BITRATE = 256_000;
const VOICE_AUDIO_FLOOR_MAX_BITRATE = 48_000;
const VOICE_AUDIO_STEP_UP_BITRATE = 16_000;
const VOICE_AUDIO_STEP_DOWN_SOFT_FACTOR = 0.75;
const VOICE_AUDIO_STEP_DOWN_HARD_FACTOR = 0.55;
const VOICE_AUDIO_GOOD_SAMPLE_THRESHOLD = 3;
const VOICE_AUDIO_DEGRADED_SAMPLE_THRESHOLD = 2;
const SPEAKING_LEVEL_SIGNAL_INTERVAL_MS = 120;
const LOCAL_LEVEL_UI_INTERVAL_MS = 80;
const OPUS_SAMPLE_RATE = 48_000;
const OPUS_CHANNELS = 1;
const OPUS_FRAME_DURATION = 20;
const VOICE_TARGET_LATENCY_MS = 60;
const VOICE_MAX_JITTER_MS = 30;
const VOICE_DEVICE_ID_STORAGE_KEY = "messly:voice:device-id:v1";
const ICE_RESTART_COOLDOWN_MS = 4_000;

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: DEFAULT_STUN_URLS,
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
  deafened: boolean;
  speaking: boolean;
  speakingLevel: number;
  connectionState: VoicePeerConnectionState;
}

export interface VoiceDiagnosticsPeerSnapshot {
  userId: string;
  pingMs: number | null;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number | null;
  inboundBitrateKbps: number | null;
  outboundBitrateKbps: number | null;
  connectionQuality: "excellent" | "good" | "fair" | "poor" | "unknown";
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
  sampleRate?: number | null;
  channelCount?: number | null;
  targetBitrate?: number | null;
  noiseSuppressionMode?: "off" | "webrtc" | "rnnoise";
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface VoiceCallClientOptions {
  roomId: string;
  self: VoiceUserIdentity;
  deviceId?: string | null;
  peerDirectory?: Record<string, VoiceUserIdentity>;
  signalingUrl?: string;
  mediaPreferences?: VoiceCallMediaPreferences;
  onParticipantsChanged?: (participants: VoiceParticipantState[]) => void;
  onDiagnostics?: (snapshot: VoiceDiagnosticsSnapshot) => void;
  onConnectionStateChanged?: (state: VoiceConnectionState) => void;
  onMicrophoneWarningChanged?: (warningMessage: string | null) => void;
  onError?: (error: Error) => void;
}

interface JoinedParticipant {
  userId: string;
  displayName: string;
  muted: boolean;
  deafened: boolean;
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
  audioSender: RTCRtpSender | null;
  currentMaxBitrate: number;
  goodNetworkSamples: number;
  degradedNetworkSamples: number;
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
      deafened: z.boolean().optional().default(false),
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
    deafened: z.boolean().optional().default(false),
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

const deafenStateSignalSchema = z.object({
  type: z.literal("participant-deafen-state"),
  userId: z.string().trim().min(1),
  deafened: z.boolean(),
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
  deafenStateSignalSchema,
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

function createVoiceDeviceId(): string {
  const entropy = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.round(Math.random() * 1_000_000_000)}`;
  const platform = typeof window !== "undefined" && (window as Window & { electronAPI?: unknown }).electronAPI
    ? "desktop"
    : "browser";
  return `${platform}:${entropy}`;
}

function resolveVoiceDeviceId(explicitDeviceIdRaw: string | null | undefined): string {
  const explicitDeviceId = String(explicitDeviceIdRaw ?? "").trim();
  if (explicitDeviceId) {
    return explicitDeviceId;
  }
  if (typeof window === "undefined") {
    return createVoiceDeviceId();
  }
  try {
    const current = String(window.localStorage.getItem(VOICE_DEVICE_ID_STORAGE_KEY) ?? "").trim();
    if (current) {
      return current;
    }
    const next = createVoiceDeviceId();
    window.localStorage.setItem(VOICE_DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return createVoiceDeviceId();
  }
}

function shouldInitiateOffer(selfUserId: string, remoteUserId: string): boolean {
  return selfUserId.localeCompare(remoteUserId) < 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toMilliseconds(seconds: number): number {
  return Number((seconds * 1_000).toFixed(1));
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

function parseFmtpConfig(configRaw: string): Map<string, string> {
  const params = new Map<string, string>();
  const tokens = String(configRaw ?? "")
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0) {
      params.set(token.toLowerCase(), "1");
      continue;
    }
    const key = token.slice(0, separatorIndex).trim().toLowerCase();
    const value = token.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    params.set(key, value);
  }

  return params;
}

function buildFmtpConfig(params: Map<string, string>): string {
  return Array.from(params.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

function applyOpusVoiceProfile(sdpRaw: string): string {
  const sdp = canonicalizeSdpString(sdpRaw, false);
  if (!sdp) {
    return sdp;
  }

  const lines = sdp
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);

  const opusPayloadTypes = new Set<string>();
  const opusRtpMapPattern = new RegExp(`^a=rtpmap:(\\d+)\\s+opus\\/${OPUS_SAMPLE_RATE}(?:\\/\\d+)?$`, "i");
  for (const line of lines) {
    const match = opusRtpMapPattern.exec(line);
    if (match?.[1]) {
      opusPayloadTypes.add(match[1]);
    }
  }
  if (opusPayloadTypes.size === 0) {
    return sdp;
  }

  const outputLines: string[] = [];
  const handledPayloadTypes = new Set<string>();
  let sawPtime = false;
  for (const line of lines) {
    if (line.startsWith("a=ptime:")) {
      outputLines.push(`a=ptime:${OPUS_FRAME_DURATION}`);
      sawPtime = true;
      continue;
    }

    const fmtpMatch = /^a=fmtp:(\d+)\s+(.+)$/i.exec(line);
    if (!fmtpMatch?.[1]) {
      outputLines.push(line);
      continue;
    }

    const payloadType = fmtpMatch[1];
    if (!opusPayloadTypes.has(payloadType)) {
      outputLines.push(line);
      continue;
    }

    const existing = parseFmtpConfig(fmtpMatch[2] ?? "");
    existing.set("maxaveragebitrate", String(VOICE_AUDIO_TARGET_MAX_BITRATE));
    existing.set("stereo", "0");
    existing.set("sprop-stereo", "0");
    existing.set("useinbandfec", "1");
    existing.set("usedtx", "1");
    existing.set("minptime", "10");
    existing.set("maxplaybackrate", String(OPUS_SAMPLE_RATE));
    outputLines.push(`a=fmtp:${payloadType} ${buildFmtpConfig(existing)}`);
    handledPayloadTypes.add(payloadType);
  }

  for (const payloadType of opusPayloadTypes) {
    if (handledPayloadTypes.has(payloadType)) {
      continue;
    }
    outputLines.push(
      `a=fmtp:${payloadType} maxaveragebitrate=${VOICE_AUDIO_TARGET_MAX_BITRATE};stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=1;minptime=10;maxplaybackrate=${OPUS_SAMPLE_RATE}`,
    );
  }
  if (!sawPtime) {
    outputLines.push(`a=ptime:${OPUS_FRAME_DURATION}`);
  }

  return `${outputLines.join("\r\n")}\r\n`;
}

function inferConnectionQuality(
  pingMs: number | null,
  jitterMs: number | null,
  packetLossPercent: number | null,
): "excellent" | "good" | "fair" | "poor" | "unknown" {
  const hasAnyMetric = pingMs != null || jitterMs != null || packetLossPercent != null;
  if (!hasAnyMetric) {
    return "unknown";
  }

  const normalizedPing = pingMs ?? 80;
  const normalizedJitter = jitterMs ?? 14;
  const normalizedLoss = packetLossPercent ?? 0;
  if (
    normalizedLoss <= 0.8
    && normalizedJitter <= Math.max(12, Math.round(VOICE_MAX_JITTER_MS * 0.45))
    && normalizedPing <= VOICE_TARGET_LATENCY_MS + 10
  ) {
    return "excellent";
  }
  if (
    normalizedLoss <= 2.0
    && normalizedJitter <= Math.max(20, Math.round(VOICE_MAX_JITTER_MS * 0.75))
    && normalizedPing <= VOICE_TARGET_LATENCY_MS + 45
  ) {
    return "good";
  }
  if (
    normalizedLoss <= 5.0
    && normalizedJitter <= Math.max(40, Math.round(VOICE_MAX_JITTER_MS * 1.6))
    && normalizedPing <= VOICE_TARGET_LATENCY_MS + 170
  ) {
    return "fair";
  }
  return "poor";
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
  const requestedSampleRate = Number(preferences?.sampleRate ?? OPUS_SAMPLE_RATE);
  const requestedTargetBitrate = Number(preferences?.targetBitrate ?? VOICE_AUDIO_TARGET_MAX_BITRATE);
  const normalizedSampleRate = Number.isFinite(requestedSampleRate)
    ? Math.max(16_000, Math.min(OPUS_SAMPLE_RATE, Math.round(requestedSampleRate)))
    : OPUS_SAMPLE_RATE;
  const normalizedChannelCount = OPUS_CHANNELS;
  const normalizedTargetBitrate = Number.isFinite(requestedTargetBitrate)
    ? Math.max(VOICE_AUDIO_FLOOR_MAX_BITRATE, Math.min(VOICE_AUDIO_TARGET_MAX_BITRATE, Math.round(requestedTargetBitrate)))
    : VOICE_AUDIO_TARGET_MAX_BITRATE;

  const normalizedNoiseSuppressionMode = (() => {
    const modeRaw = String(preferences?.noiseSuppressionMode ?? "").trim().toLowerCase();
    if (modeRaw === "off" || modeRaw === "webrtc" || modeRaw === "rnnoise") {
      return modeRaw as "off" | "webrtc" | "rnnoise";
    }
    if (typeof preferences?.noiseSuppression === "boolean") {
      return preferences.noiseSuppression ? "webrtc" : "off";
    }
    return "webrtc";
  })();

  return {
    inputDeviceId: normalizedInputDeviceId,
    outputDeviceId: normalizedOutputDeviceId,
    inputVolumePercent: normalizedInputVolume,
    outputVolumePercent: normalizedOutputVolume,
    sampleRate: normalizedSampleRate,
    channelCount: normalizedChannelCount,
    targetBitrate: normalizedTargetBitrate,
    noiseSuppressionMode: normalizedNoiseSuppressionMode,
    echoCancellation: preferences?.echoCancellation ?? true,
    noiseSuppression: normalizedNoiseSuppressionMode !== "off",
    autoGainControl: preferences?.autoGainControl ?? true,
  };
}

function parseIceServerUrls(urlsRaw: string | null | undefined): string[] {
  const raw = String(urlsRaw ?? "").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\n,;\s]+/g)
    .map((url) => url.trim())
    .filter((url) => Boolean(url));
}

function resolveVoiceIceServers(): RTCIceServer[] {
  const stunUrls = parseIceServerUrls(import.meta.env.VITE_VOICE_STUN_URLS);
  const turnUrls = parseIceServerUrls(import.meta.env.VITE_VOICE_TURN_URLS);
  const turnUsername = String(import.meta.env.VITE_VOICE_TURN_USERNAME ?? "").trim();
  const turnCredential = String(import.meta.env.VITE_VOICE_TURN_CREDENTIAL ?? "").trim();

  const servers: RTCIceServer[] = [];
  if (stunUrls.length > 0) {
    servers.push({
      urls: stunUrls,
    });
  } else {
    servers.push(...DEFAULT_ICE_SERVERS);
  }

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
}

const VOICE_ICE_SERVERS = resolveVoiceIceServers();

export class VoiceCallClient {
  private readonly roomId: string;
  private readonly self: VoiceUserIdentity;
  private readonly deviceId: string;
  private readonly peerDirectory = new Map<string, VoiceUserIdentity>();
  private readonly signalingUrl: string | null;
  private readonly mediaPreferences: Required<VoiceCallMediaPreferences>;
  private readonly onParticipantsChanged: ((participants: VoiceParticipantState[]) => void) | null;
  private readonly onDiagnostics: ((snapshot: VoiceDiagnosticsSnapshot) => void) | null;
  private readonly onConnectionStateChanged: ((state: VoiceConnectionState) => void) | null;
  private readonly onMicrophoneWarningChanged: ((warningMessage: string | null) => void) | null;
  private readonly onError: ((error: Error) => void) | null;

  private state: VoiceConnectionState = "idle";
  private joinedRoom = false;
  private localMuted = false;
  private localDeafened = false;
  private socket: WebSocket | null = null;
  private reconnectTimerId: number | null = null;
  private reconnectAttempt = 0;
  private pingIntervalId: number | null = null;
  private diagnosticsIntervalId: number | null = null;
  private joinRetryIntervalId: number | null = null;
  private capturedMicrophoneStream: MediaStream | null = null;
  private localStream: MediaStream | null = null;
  private localAudioPipeline: VoiceAudioPipelineSession | null = null;
  private localVoiceDetector: VoiceActivityDetector | null = null;
  private readonly participants = new Map<string, VoiceParticipantState>();
  private readonly peers = new Map<string, PeerConnectionContext>();
  private readonly remoteAudioElements = new Map<string, HTMLAudioElement>();
  private readonly lastIceRestartAtByPeer = new Map<string, number>();
  private pendingSpeakingState: PendingSpeakingState | null = null;
  private lastSignalingRttMs: number | null = null;
  private lastSignalingPongAtMs = 0;
  private localMicrophoneWarning: string | null = null;
  private mutedBeforeDeafen: boolean | null = null;
  private lastSpeakingLevelSignalAtMs = 0;
  private lastLocalLevelUiUpdateAtMs = 0;
  private leaving = false;

  constructor(options: VoiceCallClientOptions) {
    this.roomId = String(options.roomId ?? "").trim();
    this.deviceId = resolveVoiceDeviceId(options.deviceId);
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
    this.onMicrophoneWarningChanged = options.onMicrophoneWarningChanged ?? null;
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
      deafened: false,
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

  isDeafened(): boolean {
    return this.localDeafened;
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
      const capturedMicrophoneStream = await captureMicrophoneStream({
        echoCancellation: this.mediaPreferences.echoCancellation,
        noiseSuppressionMode: this.mediaPreferences.noiseSuppressionMode,
        noiseSuppression: this.mediaPreferences.noiseSuppressionMode !== "off",
        autoGainControl: this.mediaPreferences.autoGainControl,
        sampleRate: this.mediaPreferences.sampleRate ?? OPUS_SAMPLE_RATE,
        channelCount: this.mediaPreferences.channelCount ?? OPUS_CHANNELS,
        latency: 0,
        deviceId: this.mediaPreferences.inputDeviceId,
        inputVolumePercent: this.mediaPreferences.inputVolumePercent,
      });
      this.capturedMicrophoneStream = capturedMicrophoneStream;
      this.localAudioPipeline = await createVoiceAudioPipeline(capturedMicrophoneStream, {
        noiseSuppressionMode: this.mediaPreferences.noiseSuppressionMode,
        onQuality: (report) => {
          this.handleLocalMicrophoneQualityReport(report);
        },
      });
      this.localStream = this.localAudioPipeline.stream;
      if (this.localMicrophoneWarning) {
        this.localMicrophoneWarning = null;
        this.onMicrophoneWarningChanged?.(null);
      }
      this.applyMutedState(this.localMuted, {
        skipParticipantSync: true,
        skipSignal: true,
      });
      setAudioTrackMuted(this.localStream, this.localMuted);
      setAudioTrackMuted(this.capturedMicrophoneStream, this.localMuted);
      this.updateLocalParticipant({
        muted: this.localMuted,
        deafened: this.localDeafened,
        speaking: false,
        speakingLevel: 0,
        connectionState: "connecting",
      });
      this.localVoiceDetector = new VoiceActivityDetector(this.localStream, {
        thresholdDb: -52,
        speakingHangMs: 280,
        smoothingTimeConstant: 0.08,
        minVoiceBandRatio: 0.3,
        maxHighBandRatio: 0.56,
        maxZeroCrossingRate: 0.24,
        confidenceAttack: 0.24,
        confidenceRelease: 0.055,
        openConfidenceThreshold: 0.28,
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
          this.lastSpeakingLevelSignalAtMs = 0;
          if (this.joinedRoom) {
            this.sendSignal({
              type: "speaking-state",
              speaking,
              level: normalizedLevel,
            });
          }
        },
        onLevel: (level) => {
          const normalizedLevel = clamp(level, 0, 1);
          const now = performance.now();
          if (now - this.lastLocalLevelUiUpdateAtMs >= LOCAL_LEVEL_UI_INTERVAL_MS) {
            this.lastLocalLevelUiUpdateAtMs = now;
            this.updateLocalParticipant({
              speakingLevel: normalizedLevel,
            });
          }
          this.maybeBroadcastSpeakingLevel(normalizedLevel);
        },
      });
      await this.localVoiceDetector.start();
      await this.connectSignaling();
      this.startIntervals();
    } catch (error) {
      if (!this.leaving) {
        this.handleError(toError("Nao foi possivel iniciar chamada de voz", normalizeErrorMessage(error)));
      }
      await this.leave().catch(() => undefined);
      if (!this.leaving) {
        throw error;
      }
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
    this.lastSignalingPongAtMs = 0;
    this.mutedBeforeDeafen = null;
    this.lastSpeakingLevelSignalAtMs = 0;
    this.lastLocalLevelUiUpdateAtMs = 0;

    this.localVoiceDetector?.stop();
    this.localVoiceDetector = null;
    this.localAudioPipeline?.stop();
    this.localAudioPipeline = null;

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendSignal({ type: "leave" });
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        try {
          socket.close(1000, "VOICE_LEAVE");
        } catch {
          // Ignore close failures.
        }
      }
    }

    this.disposePeerConnections();
    clearRemoteAudioPlayback(this.remoteAudioElements);
    this.lastIceRestartAtByPeer.clear();
    stopMediaStream(this.localStream);
    this.localStream = null;
    stopMediaStream(this.capturedMicrophoneStream);
    this.capturedMicrophoneStream = null;
    if (this.localMicrophoneWarning) {
      this.localMicrophoneWarning = null;
      this.onMicrophoneWarningChanged?.(null);
    }

    this.participants.clear();
    this.participants.set(this.self.userId, {
      ...this.self,
      isLocal: true,
      muted: this.localMuted,
      deafened: this.localDeafened,
      speaking: false,
      speakingLevel: 0,
      connectionState: "idle",
    });
    this.emitParticipants();
    this.setConnectionState("closed");
  }

  private applyMutedState(
    muted: boolean,
    options?: {
      skipParticipantSync?: boolean;
      skipSignal?: boolean;
    },
  ): void {
    const nextMuted = this.localDeafened ? true : muted;
    if (this.localMuted === nextMuted) {
      return;
    }
    this.localMuted = nextMuted;
    setAudioTrackMuted(this.localStream, nextMuted);
    setAudioTrackMuted(this.capturedMicrophoneStream, nextMuted);
    if (!options?.skipParticipantSync) {
      this.updateLocalParticipant({
        muted: nextMuted,
      });
    }
    if (!options?.skipSignal && this.joinedRoom) {
      this.sendSignal({
        type: "mute-state",
        muted: nextMuted,
      });
    }
  }

  setMuted(muted: boolean): void {
    this.applyMutedState(muted);
  }

  toggleMuted(): void {
    this.setMuted(!this.localMuted);
  }

  setDeafened(deafened: boolean): void {
    if (this.localDeafened === deafened) {
      return;
    }

    if (deafened) {
      this.mutedBeforeDeafen = this.localMuted;
      this.localDeafened = true;
      setRemoteAudioPlaybackMuted(this.remoteAudioElements, true);
      this.applyMutedState(true, {
        skipParticipantSync: true,
      });
      this.updateLocalParticipant({
        muted: this.localMuted,
        deafened: true,
      });
      if (this.joinedRoom) {
        this.sendSignal({
          type: "deafen-state",
          deafened: true,
        });
      }
      return;
    }

    this.localDeafened = deafened;
    setRemoteAudioPlaybackMuted(this.remoteAudioElements, false);
    const restoreMuted = this.mutedBeforeDeafen ?? false;
    this.mutedBeforeDeafen = null;
    this.applyMutedState(restoreMuted, {
      skipParticipantSync: true,
    });
    this.updateLocalParticipant({
      muted: this.localMuted,
      deafened: false,
    });
    if (this.joinedRoom) {
      this.sendSignal({
        type: "deafen-state",
        deafened: false,
      });
    }
  }

  toggleDeafened(): void {
    this.setDeafened(!this.localDeafened);
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
        if (this.leaving || this.socket !== socket) {
          settled = true;
          try {
            socket.close(1000, "VOICE_CONNECT_CANCELLED");
          } catch {
            // Ignore close failures.
          }
          reject(new Error("Conexao de voz cancelada."));
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

      socket.addEventListener("close", () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Conexao de voz encerrada durante a inicializacao."));
      }, { once: true });
    });

    if (this.leaving || this.socket !== socket) {
      try {
        socket.close(1000, "VOICE_CONNECT_CANCELLED");
      } catch {
        // Ignore close failures.
      }
      throw new Error("Conexao de voz cancelada.");
    }
    this.lastSignalingPongAtMs = Date.now();

    socket.addEventListener("message", (event) => {
      this.handleSignalingMessage(String(event.data ?? ""));
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.joinedRoom = false;
      this.lastSignalingPongAtMs = 0;
      this.clearJoinRetryLoop();
      if (this.leaving) {
        return;
      }

      this.disposePeerConnections();
      this.markRemoteParticipantsDisconnected();
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
    this.lastSignalingPongAtMs = Date.now();

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
      case "participant-deafen-state":
        this.updateRemoteParticipant(payload.userId, {
          deafened: payload.deafened,
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
        this.lastSignalingPongAtMs = nowMs;
        const echoedAtMs = typeof payload.timestamp === "number" ? payload.timestamp : NaN;
        if (Number.isFinite(echoedAtMs)) {
          const rttMs = nowMs - echoedAtMs;
          if (rttMs >= 0 && rttMs <= 120_000) {
            const previousRttMs = this.lastSignalingRttMs;
            this.lastSignalingRttMs =
              previousRttMs == null
                ? Math.round(rttMs)
                : Math.round((previousRttMs * 0.65) + (rttMs * 0.35));
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
    this.sendSignal({
      type: "deafen-state",
      deafened: this.localDeafened,
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
        deafened: participant.deafened,
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
      deafened: participant.deafened,
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
      iceServers: VOICE_ICE_SERVERS,
      iceCandidatePoolSize: 2,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    const remoteStream = new MediaStream();
    let audioSender: RTCRtpSender | null = null;

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        const sender = connection.addTrack(track, this.localStream);
        this.configureAudioSender(connection, sender);
        if (!audioSender) {
          audioSender = sender;
        }
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
      const receiver = event.receiver as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      if ("playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = VOICE_TARGET_LATENCY_MS / 1_000;
      }
      if ("jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = VOICE_MAX_JITTER_MS / 1_000;
      }

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
        muted: this.localDeafened,
      });
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        this.lastIceRestartAtByPeer.delete(userId);
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
        void this.restartIceForPeer(userId, {
          force: true,
        });
      }
    };

    connection.oniceconnectionstatechange = () => {
      const state = connection.iceConnectionState;
      if (state === "connected" || state === "completed") {
        this.lastIceRestartAtByPeer.delete(userId);
        return;
      }
      if (state === "disconnected") {
        void this.restartIceForPeer(userId);
        return;
      }
      if (state === "failed") {
        void this.restartIceForPeer(userId, {
          force: true,
        });
      }
    };

    const peerContext: PeerConnectionContext = {
      userId,
      connection,
      remoteStream,
      pendingIceCandidates: [],
      statsAccumulator: null,
      audioSender,
      currentMaxBitrate: this.mediaPreferences.targetBitrate ?? VOICE_AUDIO_TARGET_MAX_BITRATE,
      goodNetworkSamples: 0,
      degradedNetworkSamples: 0,
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

  private async restartIceForPeer(userIdRaw: string, options?: { force?: boolean }): Promise<void> {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId || this.leaving || !this.joinedRoom) {
      return;
    }

    const peerContext = this.peers.get(userId);
    if (!peerContext) {
      return;
    }

    const now = Date.now();
    const lastRestartAt = this.lastIceRestartAtByPeer.get(userId) ?? 0;
    if (!options?.force && now - lastRestartAt < ICE_RESTART_COOLDOWN_MS) {
      return;
    }
    this.lastIceRestartAtByPeer.set(userId, now);

    const connection = peerContext.connection;
    if (connection.signalingState !== "stable") {
      return;
    }

    try {
      const restartOffer = await connection.createOffer({ iceRestart: true });
      await connection.setLocalDescription(restartOffer);
      const localOffer = this.toLocalSdpPayload(connection.localDescription);
      if (!localOffer) {
        return;
      }
      this.updateRemoteParticipant(userId, { connectionState: "connecting" });
      this.sendSignal({
        type: "offer",
        targetUserId: userId,
        sdp: localOffer,
      });
    } catch {
      // Ignore transient ICE restart failures.
    }
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
    const canonical = applyOpusVoiceProfile(description.sdp ?? "");
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
    const targetBitrate = this.mediaPreferences.targetBitrate ?? VOICE_AUDIO_TARGET_MAX_BITRATE;
    const transceiver = connection.getTransceivers().find((candidate) => candidate.sender === sender);
    if (transceiver?.setCodecPreferences && typeof RTCRtpSender !== "undefined") {
      const capabilities = RTCRtpSender.getCapabilities?.("audio")?.codecs ?? [];
      if (capabilities.length > 0) {
        const opusCodecs = capabilities.filter((codec) => codec.mimeType.toLowerCase() === "audio/opus");
        if (opusCodecs.length > 0) {
          const fallbackCodecs = capabilities.filter((codec) => codec.mimeType.toLowerCase() !== "audio/opus");
          try {
            transceiver.setCodecPreferences([...opusCodecs, ...fallbackCodecs]);
          } catch {
            // Keep browser defaults if codec preference negotiation is unsupported.
          }
        }
      }
    }

    const parameters = sender.getParameters();
    const encodings = parameters.encodings && parameters.encodings.length > 0
      ? [...parameters.encodings]
      : [{}];
    const firstEncoding = encodings[0] as RTCRtpEncodingParameters & {
      dtx?: "enabled" | "disabled";
      networkPriority?: RTCPriorityType;
      priority?: RTCPriorityType;
    };
    firstEncoding.maxBitrate = targetBitrate;
    firstEncoding.dtx = "enabled";
    firstEncoding.priority = "high";
    firstEncoding.networkPriority = "high";
    encodings[0] = firstEncoding;
    parameters.encodings = encodings;
    void sender.setParameters(parameters).catch(() => undefined);
  }

  private adjustPeerBitrate(
    peerContext: PeerConnectionContext,
    packetLossPercent: number | null,
    jitterMs: number | null,
    latencyMs: number | null,
  ): void {
    const sender = peerContext.audioSender;
    if (!sender) {
      return;
    }

    const normalizedLoss = packetLossPercent ?? 0;
    const normalizedJitter = jitterMs ?? 0;
    const normalizedLatency = latencyMs ?? 0;
    const isHardDegradation =
      normalizedLoss >= 7
      || normalizedJitter >= Math.max(55, Math.round(VOICE_MAX_JITTER_MS * 1.9))
      || normalizedLatency >= VOICE_TARGET_LATENCY_MS + 90;
    const isSoftDegradation =
      normalizedLoss >= 2.5
      || normalizedJitter >= Math.max(28, Math.round(VOICE_MAX_JITTER_MS * 1.15))
      || normalizedLatency >= VOICE_TARGET_LATENCY_MS + 35;
    const isGood =
      normalizedLoss <= 0.9
      && normalizedJitter <= Math.max(16, Math.round(VOICE_MAX_JITTER_MS * 0.55))
      && (normalizedLatency === 0 || normalizedLatency <= VOICE_TARGET_LATENCY_MS + 20);

    if (isHardDegradation || isSoftDegradation) {
      peerContext.goodNetworkSamples = 0;
      peerContext.degradedNetworkSamples += 1;
    } else if (isGood) {
      peerContext.degradedNetworkSamples = 0;
      peerContext.goodNetworkSamples += 1;
    } else {
      peerContext.degradedNetworkSamples = 0;
      peerContext.goodNetworkSamples = 0;
    }

    const targetBitrate = this.mediaPreferences.targetBitrate ?? VOICE_AUDIO_TARGET_MAX_BITRATE;
    const current = peerContext.currentMaxBitrate > 0 ? peerContext.currentMaxBitrate : targetBitrate;
    let next = current;
    if (peerContext.degradedNetworkSamples >= VOICE_AUDIO_DEGRADED_SAMPLE_THRESHOLD) {
      const factor = isHardDegradation ? VOICE_AUDIO_STEP_DOWN_HARD_FACTOR : VOICE_AUDIO_STEP_DOWN_SOFT_FACTOR;
      next = Math.round(current * factor);
      peerContext.degradedNetworkSamples = 0;
    } else if (peerContext.goodNetworkSamples >= VOICE_AUDIO_GOOD_SAMPLE_THRESHOLD) {
      next = current + VOICE_AUDIO_STEP_UP_BITRATE;
      peerContext.goodNetworkSamples = 0;
    }

    const bounded = clamp(next, VOICE_AUDIO_FLOOR_MAX_BITRATE, targetBitrate);
    if (Math.abs(bounded - current) < 4_000) {
      return;
    }

    peerContext.currentMaxBitrate = bounded;
    this.trySetSenderMaxBitrate(sender, bounded);
  }

  private trySetSenderMaxBitrate(sender: RTCRtpSender, maxBitrate: number): void {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings && parameters.encodings.length > 0
      ? [...parameters.encodings]
      : [{}];
    const firstEncoding = encodings[0] as RTCRtpEncodingParameters & {
      dtx?: "enabled" | "disabled";
      networkPriority?: RTCPriorityType;
      priority?: RTCPriorityType;
    };
    firstEncoding.maxBitrate = maxBitrate;
    firstEncoding.dtx = "enabled";
    firstEncoding.priority = "high";
    firstEncoding.networkPriority = "high";
    encodings[0] = firstEncoding;
    parameters.encodings = encodings;
    void sender.setParameters(parameters).catch(() => undefined);
  }

  private maybeBroadcastSpeakingLevel(level: number): void {
    if (!this.joinedRoom || this.localMuted) {
      return;
    }
    const localParticipant = this.participants.get(this.self.userId);
    if (!localParticipant || !localParticipant.speaking) {
      return;
    }

    const now = Date.now();
    if (now - this.lastSpeakingLevelSignalAtMs < SPEAKING_LEVEL_SIGNAL_INTERVAL_MS) {
      return;
    }
    this.lastSpeakingLevelSignalAtMs = now;
    this.sendSignal({
      type: "speaking-state",
      speaking: true,
      level: clamp(level, 0, 1),
    });
  }

  private handleLocalMicrophoneQualityReport(report: VoiceInputQualityReport): void {
    const warningMessage = String(report.warningMessage ?? "").trim() || null;
    if (this.localMicrophoneWarning !== warningMessage) {
      this.localMicrophoneWarning = warningMessage;
      this.onMicrophoneWarningChanged?.(warningMessage);
    }
  }

  private async sendJoinSignal(): Promise<void> {
    const accessToken = await getSupabaseAccessToken().catch(() => null);
    this.sendSignal({
      type: "join",
      roomId: this.roomId,
      userId: this.self.userId,
      deviceId: this.deviceId,
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
    this.lastSignalingPongAtMs = Date.now();
    this.sendSignal({
      type: "ping",
      timestamp: Date.now(),
    });

    this.pingIntervalId = window.setInterval(() => {
      this.ensureSignalingSocketHealth();
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

  private ensureSignalingSocketHealth(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.leaving) {
      return;
    }
    const nowMs = Date.now();
    if (this.lastSignalingPongAtMs <= 0) {
      this.lastSignalingPongAtMs = nowMs;
      return;
    }

    const allowedSilenceMs = SIGNALING_PING_INTERVAL_MS * 3;
    if (nowMs - this.lastSignalingPongAtMs <= allowedSilenceMs) {
      return;
    }

    try {
      socket.close(4000, "VOICE_PING_TIMEOUT");
    } catch {
      // Ignore close failures; reconnect loop will recover.
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
      let latencyMs: number | null = null;
      let jitterMs: number | null = null;
      let packetLossPercent: number | null = null;
      let inboundBytes = 0;
      let outboundBytes = 0;
      let inboundPacketsLost = 0;
      let inboundPacketsReceived = 0;
      let jitterBufferDelaySeconds = 0;
      let jitterBufferEmittedCount = 0;
      let selectedCandidatePairId: string | null = null;
      let candidatePairRttMs: number | null = null;
      let remoteInboundRttMs: number | null = null;
      let remoteOutboundRttMs: number | null = null;

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
            candidatePairRttMs = toMilliseconds(candidatePair.currentRoundTripTime);
          } else if (candidatePairRttMs == null && typeof candidatePair.currentRoundTripTime === "number") {
            candidatePairRttMs = toMilliseconds(candidatePair.currentRoundTripTime);
          }
        }

        if (report.type === "inbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const inbound = report as RTCStats & {
            bytesReceived?: number;
            jitter?: number;
            packetsLost?: number;
            packetsReceived?: number;
            jitterBufferDelay?: number;
            jitterBufferEmittedCount?: number;
          };
          inboundBytes += typeof inbound.bytesReceived === "number" ? inbound.bytesReceived : 0;
          if (typeof inbound.jitter === "number") {
            const nextJitterMs = toMilliseconds(inbound.jitter);
            jitterMs = jitterMs == null ? nextJitterMs : Math.max(jitterMs, nextJitterMs);
          }
          inboundPacketsLost += typeof inbound.packetsLost === "number" ? inbound.packetsLost : 0;
          inboundPacketsReceived += typeof inbound.packetsReceived === "number" ? inbound.packetsReceived : 0;
          jitterBufferDelaySeconds += typeof inbound.jitterBufferDelay === "number" ? inbound.jitterBufferDelay : 0;
          jitterBufferEmittedCount += typeof inbound.jitterBufferEmittedCount === "number" ? inbound.jitterBufferEmittedCount : 0;
        }

        if (report.type === "outbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const outbound = report as RTCStats & { bytesSent?: number };
          outboundBytes += typeof outbound.bytesSent === "number" ? outbound.bytesSent : 0;
        }

        if (report.type === "remote-inbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const remoteInbound = report as RTCStats & { roundTripTime?: number };
          if (typeof remoteInbound.roundTripTime === "number") {
            remoteInboundRttMs = toMilliseconds(remoteInbound.roundTripTime);
          }
        }

        if (report.type === "remote-outbound-rtp" && (report as RTCStats & { kind?: string }).kind === "audio") {
          const remoteOutbound = report as RTCStats & { roundTripTime?: number };
          if (typeof remoteOutbound.roundTripTime === "number") {
            remoteOutboundRttMs = toMilliseconds(remoteOutbound.roundTripTime);
          }
        }
      });
      if (selectedCandidatePairId) {
        const selectedPair = stats.get(selectedCandidatePairId) as (RTCStats & { currentRoundTripTime?: number }) | undefined;
        if (selectedPair && typeof selectedPair.currentRoundTripTime === "number") {
          candidatePairRttMs = toMilliseconds(selectedPair.currentRoundTripTime);
        }
      }
      const packetTotal = inboundPacketsLost + inboundPacketsReceived;
      packetLossPercent = packetTotal > 0 ? Number(((inboundPacketsLost / packetTotal) * 100).toFixed(2)) : null;
      pingMs = candidatePairRttMs ?? remoteInboundRttMs ?? remoteOutboundRttMs ?? this.lastSignalingRttMs;
      latencyMs = jitterBufferEmittedCount > 0
        ? toMilliseconds(jitterBufferDelaySeconds / jitterBufferEmittedCount)
        : (pingMs != null ? Number((pingMs / 2).toFixed(1)) : null);
      this.adjustPeerBitrate(peerContext, packetLossPercent, jitterMs, latencyMs);
      const connectionQuality = inferConnectionQuality(pingMs, jitterMs, packetLossPercent);

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
        latencyMs,
        jitterMs,
        packetLossPercent,
        inboundBitrateKbps,
        outboundBitrateKbps,
        connectionQuality,
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
    peerContext.connection.oniceconnectionstatechange = null;
    try {
      peerContext.connection.close();
    } catch {
      // Ignore close errors.
    }
    peerContext.remoteStream.getTracks().forEach((track) => track.stop());
    this.peers.delete(userId);
    this.lastIceRestartAtByPeer.delete(userId);
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
    patch: Partial<Pick<VoiceParticipantState, "muted" | "deafened" | "speaking" | "speakingLevel" | "connectionState">>,
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
    patch: Partial<Pick<VoiceParticipantState, "muted" | "deafened" | "speaking" | "speakingLevel" | "connectionState">>,
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
      deafened: patch.deafened ?? false,
      speaking: patch.speaking ?? false,
      speakingLevel: patch.speakingLevel ?? 0,
      connectionState: patch.connectionState ?? "connecting",
    });
    this.emitParticipants();
  }

  private updateRemoteParticipant(
    userIdRaw: string,
    patch: Partial<Pick<VoiceParticipantState, "muted" | "deafened" | "speaking" | "speakingLevel" | "connectionState">>,
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

  private markRemoteParticipantsDisconnected(): void {
    let changed = false;
    for (const [userId, participant] of this.participants.entries()) {
      if (userId === this.self.userId) {
        continue;
      }
      this.participants.set(userId, {
        ...participant,
        speaking: false,
        speakingLevel: 0,
        connectionState: "disconnected",
      });
      changed = true;
    }
    if (changed) {
      this.emitParticipants();
    }
  }

  private emitParticipants(): void {
    if (!this.onParticipantsChanged) {
      return;
    }
    this.onParticipantsChanged(Array.from(this.participants.values()));
  }
}
