
import { authService } from "../auth";
import { getGatewayUrl } from "../../api/client";
import type { RtpCapabilities } from "mediasoup-client/types";
import type { CallMode, CallSignalType } from "./callApi";
import { CallSessionManager } from "./voice/CallSessionManager";
import { ConsumerManager } from "./voice/ConsumerManager";
import { MediaDeviceManager, type StartScreenCaptureOptions } from "./voice/MediaDeviceManager";
import { SerialExecutor, SequentialLock, SingleFlight } from "./voice/operationLocks";
import { ProducerManager } from "./voice/ProducerManager";
import { ReconnectManager } from "./voice/ReconnectManager";
import { TransportManager } from "./voice/TransportManager";
import type { CallDebugLogger, NormalizedAudioSettings, VoiceSession, VoiceTransport } from "./voice/types";
import { isTrackLive } from "./voice/types";

export interface CallServiceSignal {
  type: CallSignalType;
  payload: Record<string, unknown>;
}

export interface CallVoiceDiagnostics {
  averagePingMs: number | null;
  lastPingMs: number | null;
  packetLossPercent: number | null;
  connectionType: "host" | "srflx" | "relay" | "prflx" | "unknown" | null;
  localCandidateType: "host" | "srflx" | "relay" | "prflx" | "unknown" | null;
  remoteCandidateType: "host" | "srflx" | "relay" | "prflx" | "unknown" | null;
  usingRelay: boolean | null;
  outboundBitrateKbps: number | null;
  inboundBitrateKbps: number | null;
  localAudioTrackState: "live" | "muted" | "ended" | "missing";
  remoteAudioTrackState: "live" | "muted" | "ended" | "missing";
  sendingAudio: boolean | null;
  receivingAudio: boolean | null;
  remoteAudioConsumers: number;
  connectionState: RTCPeerConnectionState | null;
  iceConnectionState: RTCIceConnectionState | null;
  updatedAt: string;
}

export interface CallAudioSettings {
  inputDeviceId?: string | null;
  inputVolume?: number | null;
  noiseSuppression?: boolean | null;
  echoCancellation?: boolean | null;
  autoGainControl?: boolean | null;
  vadEnabled?: boolean | null;
  voiceFocus?: boolean | null;
  autoSensitivity?: boolean | null;
  sensitivityDb?: number | null;
  qosHighPriority?: boolean | null;
  pushToTalkEnabled?: boolean | null;
  pushToTalkBind?: string | null;
}

export interface CallServiceOptions {
  mode: CallMode;
  conversationId?: string | null;
  audioSettings?: CallAudioSettings | null;
  onSignal: (signal: CallServiceSignal) => Promise<void> | void;
  onLocalStream?: (stream: MediaStream | null) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onError?: (error: Error) => void;
}

export interface CallScreenShareSource {
  id: string;
  name: string;
  thumbnail: string | null;
  appIcon: string | null;
}

export interface StartScreenShareOptions {
  sourceId?: string | null;
  quality?: string | null;
}

interface VoiceFrame<T = unknown> {
  op: string;
  d: T;
}

const SIGNAL_VERSION = 2;
const DEFAULT_SCREEN_SHARE_QUALITY = "1080p60";
const VOICE_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_SOCKET_OPEN_TIMEOUT_MS = 8_000;
const VOICE_ENDPOINT_PROBE_TIMEOUT_MS = 3_500;
const CONSUME_RETRY_BASE_DELAY_MS = 250;
const CONSUME_RETRY_MAX_ATTEMPTS = 8;
const DEFAULT_AUDIO: NormalizedAudioSettings = {
  inputDeviceId: "",
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  pushToTalkEnabled: false,
  qosHighPriority: false,
};

function createSessionId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAudioSettings(raw: CallAudioSettings | null | undefined): NormalizedAudioSettings {
  const source = raw ?? {};
  return {
    inputDeviceId: typeof source.inputDeviceId === "string" ? source.inputDeviceId.trim() : "",
    noiseSuppression: typeof source.noiseSuppression === "boolean" ? source.noiseSuppression : DEFAULT_AUDIO.noiseSuppression,
    echoCancellation: typeof source.echoCancellation === "boolean" ? source.echoCancellation : DEFAULT_AUDIO.echoCancellation,
    autoGainControl: typeof source.autoGainControl === "boolean" ? source.autoGainControl : DEFAULT_AUDIO.autoGainControl,
    pushToTalkEnabled: typeof source.pushToTalkEnabled === "boolean" ? source.pushToTalkEnabled : DEFAULT_AUDIO.pushToTalkEnabled,
    qosHighPriority: typeof source.qosHighPriority === "boolean" ? source.qosHighPriority : DEFAULT_AUDIO.qosHighPriority,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toId(value: unknown): string {
  return String(value ?? "").trim();
}

function describeWebRtcError(error: unknown): string {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const code = typeof (error as unknown as { code?: unknown }).code === "number"
      ? Number((error as unknown as { code: number }).code)
      : null;
    const codeLabel = code != null && Number.isFinite(code) ? ` (code ${code})` : "";
    const message = String(error.message ?? "").trim();
    return `${error.name || "DOMException"}${codeLabel}${message ? `: ${message}` : ""}`.trim();
  }
  if (error instanceof Error) {
    const message = String(error.message ?? "").trim();
    return `${error.name || "Error"}${message ? `: ${message}` : ""}`.trim();
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "");
  }
}

function toCandidateAddress(candidateRaw: unknown): string {
  const candidate = toRecord(candidateRaw);
  return String(candidate.address ?? candidate.ip ?? "").trim().toLowerCase();
}

function getBrowserEstimatedRttMs(): number | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const connection = (navigator as unknown as { connection?: unknown }).connection as { rtt?: unknown } | undefined;
  const rtt = typeof connection?.rtt === "number" ? connection.rtt : null;
  if (rtt == null || !Number.isFinite(rtt) || rtt <= 0) {
    return null;
  }
  return rtt;
}

function hasNonWildcardIceCandidate(candidateListRaw: unknown): boolean {
  if (!Array.isArray(candidateListRaw) || candidateListRaw.length === 0) {
    return false;
  }

  for (const candidateRaw of candidateListRaw) {
    const address = toCandidateAddress(candidateRaw);
    if (!address) {
      continue;
    }
    if (address === "0.0.0.0" || address === "::") {
      continue;
    }
    return true;
  }

  return false;
}

function normalizeVoiceSocketUrl(valueRaw: string | null | undefined): string | null {
  const value = String(valueRaw ?? "").trim();
  if (!value) {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+\-.]*:\/\//i.test(value) ? value : `wss://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }

    parsed.search = "";
    parsed.hash = "";
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    if (!trimmedPath || trimmedPath === "/" || trimmedPath === "/gateway") {
      parsed.pathname = "/voice";
    } else {
      parsed.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveVoiceUrl(): string | null {
  const explicit = normalizeVoiceSocketUrl(import.meta.env.VITE_MESSLY_VOICE_URL);
  if (explicit) {
    return explicit;
  }
  return normalizeVoiceSocketUrl(getGatewayUrl());
}

function resolvePreferredVoiceTransport(): VoiceTransport {
  const explicit = String(import.meta.env.VITE_MESSLY_CALL_TRANSPORT ?? "").trim().toLowerCase();
  if (explicit === "mediasoup" || explicit === "sfu") {
    return "mediasoup";
  }
  if (explicit === "p2p") {
    return "p2p";
  }

  // Default behavior:
  // - P2P is the safest default across environments because it works behind typical HTTPS load balancers.
  // - Use VITE_MESSLY_CALL_TRANSPORT=mediasoup when running a gateway that exposes WebRTC transport ports.
  return "p2p";
}

function normalizeIceServer(
  raw: unknown,
  defaults: { username: string | null; credential: string | null },
): RTCIceServer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const urlsRaw = record.urls ?? record.url;
  const urls = Array.isArray(urlsRaw)
    ? urlsRaw.map((value) => String(value ?? "").trim()).filter(Boolean)
    : typeof urlsRaw === "string"
      ? [urlsRaw.trim()].filter(Boolean)
      : [];
  if (urls.length === 0) {
    return null;
  }

  const normalizedUrls = urls.filter((url) => {
    const lower = url.toLowerCase();
    if (lower.startsWith("stun:") || lower.startsWith("stuns:")) {
      // Chrome rejects STUN urls with query params like `?transport=udp`.
      return !url.includes("?");
    }
    return lower.startsWith("turn:") || lower.startsWith("turns:");
  });
  if (normalizedUrls.length === 0) {
    return null;
  }

  const username = typeof record.username === "string" ? record.username : defaults.username;
  const credential = typeof record.credential === "string" ? record.credential : defaults.credential;
  const isTurnServer = normalizedUrls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));

  const server: RTCIceServer = {
    urls: normalizedUrls,
  };
  if (isTurnServer) {
    if (username) {
      server.username = username;
    }
    if (credential) {
      server.credential = credential;
    }
  }
  return server;
}

function parseIceServersFromEnv(): RTCIceServer[] {
  const defaults = {
    username: String(import.meta.env.VITE_WEBRTC_TURN_USERNAME ?? "").trim() || null,
    credential: String(import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL ?? "").trim() || null,
  };

  const rawJson = String(import.meta.env.VITE_WEBRTC_ICE_SERVERS_JSON ?? "").trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { iceServers?: unknown }).iceServers)
          ? (parsed as { iceServers: unknown[] }).iceServers
          : [];
      const normalized = list
        .map((entry) => normalizeIceServer(entry, defaults))
        .filter((entry): entry is RTCIceServer => Boolean(entry));
      if (normalized.length > 0) {
        return normalized;
      }
    } catch {
      // Fall through to defaults.
    }
  }

  // Best-effort defaults (STUN only). For strict NATs, configure TURN via VITE_WEBRTC_ICE_SERVERS_JSON.
  return [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: ["stun:global.stun.twilio.com:3478"] },
  ];
}

function toVoiceProbeHttpUrl(voiceUrlRaw: string): string | null {
  try {
    const parsed = new URL(voiceUrlRaw);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isCrossOriginVoiceProbe(probeUrlRaw: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const probeOrigin = new URL(probeUrlRaw).origin;
    return probeOrigin !== window.location.origin;
  } catch {
    return false;
  }
}

type VoiceEndpointProbeResult = "supported" | "unsupported" | "unknown";

async function probeVoiceEndpoint(voiceUrl: string): Promise<VoiceEndpointProbeResult> {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return "unknown";
  }

  const probeUrl = toVoiceProbeHttpUrl(voiceUrl);
  if (!probeUrl) {
    return "unknown";
  }
  if (isCrossOriginVoiceProbe(probeUrl)) {
    return "unknown";
  }

  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = window.setTimeout(() => {
    abortController?.abort();
  }, VOICE_ENDPOINT_PROBE_TIMEOUT_MS);

  try {
    const response = await window.fetch(probeUrl, {
      method: "GET",
      cache: "no-store",
      signal: abortController?.signal,
    });
    if (response.status === 426) {
      return "supported";
    }
    if (response.status === 404 || response.status === 405) {
      return "unsupported";
    }
    if (!response.ok) {
      return "unknown";
    }

    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return "unknown";
    }
    const payload = (await response.text().catch(() => "")).toLowerCase();
    if (payload.includes("\"service\":\"messly-gateway\"") || payload.includes("\"service\": \"messly-gateway\"")) {
      return "unsupported";
    }
    if (payload.includes("use websocket upgrade for /voice")) {
      return "supported";
    }
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function parseOffer(payload: Record<string, unknown>): VoiceSession | null {
  const version = Number(payload.v ?? 0);
  const transportRaw = String(payload.transport ?? "").trim().toLowerCase();
  const transport: VoiceTransport | null =
    transportRaw === "mediasoup" ? "mediasoup" : transportRaw === "p2p" ? "p2p" : null;
  if (version !== SIGNAL_VERSION || !transport) {
    return null;
  }
  const callId = toId(payload.callId);
  const roomId = toId(payload.roomId);
  const conversationId = toId(payload.conversationId);
  const mode = String(payload.mode ?? "").trim().toLowerCase() === "video" ? "video" : "audio";
  if (!callId || !roomId || !conversationId) {
    return null;
  }
  if (transport === "p2p" && !toId(payload.sdp)) {
    // P2P offers must include SDP; otherwise we can't establish the connection.
    return null;
  }
  return {
    transport,
    callId,
    roomId,
    conversationId,
    mode,
    role: "callee",
    resumeToken: null,
    offerSdp: transport === "p2p" ? toId(payload.sdp) : null,
    answerSdp: null,
  };
}

function buildOffer(session: VoiceSession): Record<string, unknown> {
  const base = {
    v: SIGNAL_VERSION,
    transport: session.transport,
    callId: session.callId,
    roomId: session.roomId,
    conversationId: session.conversationId,
    mode: session.mode,
    createdAt: new Date().toISOString(),
  };
  if (session.transport === "p2p") {
    return {
      ...base,
      sdp: String(session.offerSdp ?? "").trim(),
    };
  }
  return base;
}

function buildAnswer(session: VoiceSession): Record<string, unknown> {
  const base = {
    v: SIGNAL_VERSION,
    transport: session.transport,
    callId: session.callId,
    roomId: session.roomId,
    conversationId: session.conversationId,
    acceptedAt: new Date().toISOString(),
  };
  if (session.transport === "p2p") {
    return {
      ...base,
      sdp: String(session.answerSdp ?? "").trim(),
    };
  }
  return base;
}

async function captureAudioTrack(settings: NormalizedAudioSettings): Promise<MediaStreamTrack> {
  const baseConstraints: MediaTrackConstraints = {
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
  };

  const isOverconstrainedDeviceId = (error: unknown): boolean => {
    const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    const name = error instanceof Error ? error.name : String(record?.name ?? "").trim();
    if (name.toLowerCase() !== "overconstrainederror") {
      return false;
    }
    const constraint = String(record?.constraint ?? "").trim().toLowerCase();
    return constraint === "deviceid" || constraint === "device-id" || constraint.includes("device");
  };

  const getStream = async (useDeviceId: boolean): Promise<MediaStream> => {
    const audio: MediaTrackConstraints = useDeviceId && settings.inputDeviceId
      ? { ...baseConstraints, deviceId: { exact: settings.inputDeviceId } }
      : baseConstraints;
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  };

  let stream: MediaStream;
  try {
    stream = await getStream(true);
  } catch (error) {
    // If the saved deviceId no longer exists (USB headset unplugged, etc), retry with the default mic.
    if (settings.inputDeviceId && isOverconstrainedDeviceId(error)) {
      stream = await getStream(false);
    } else {
      throw error;
    }
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw new Error("Nao foi possivel capturar o microfone.");
  }
  return track;
}

async function captureCameraTrack(): Promise<MediaStreamTrack | null> {
  const stream = await navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    })
    .catch(() => null);
  return stream?.getVideoTracks()[0] ?? null;
}

function parseQuality(raw: string | null | undefined): { width: number; height: number; frameRate: number } {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "720p30") {
    return { width: 1280, height: 720, frameRate: 30 };
  }
  if (value === "720p60") {
    return { width: 1280, height: 720, frameRate: 60 };
  }
  if (value === "1080p30") {
    return { width: 1920, height: 1080, frameRate: 30 };
  }
  if (value === "1080p60") {
    return { width: 1920, height: 1080, frameRate: 60 };
  }
  return { width: 1920, height: 1080, frameRate: 60 };
}

export async function applyQoS(peerConnection: RTCPeerConnection | null | undefined, enabled: boolean): Promise<void> {
  if (!peerConnection) {
    return;
  }
  const priority: RTCPriorityType = enabled ? "high" : "medium";
  const senders = peerConnection.getSenders().filter((sender) => sender.track?.kind === "audio");
  await Promise.all(
    senders.map(async (sender) => {
      try {
        const parameters = sender.getParameters();
        const encodings = Array.isArray(parameters.encodings) && parameters.encodings.length > 0 ? [...parameters.encodings] : [{}];
        encodings[0] = { ...(encodings[0] ?? {}), priority };
        await sender.setParameters({ ...parameters, encodings });
      } catch {
        // Best effort.
      }
    }),
  );
}

export function canSelectDesktopScreenShareSource(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI?.getScreenShareSources);
}

export async function listDesktopScreenShareSources(): Promise<CallScreenShareSource[]> {
  const api = window.electronAPI?.getScreenShareSources;
  if (!api) {
    return [];
  }
  const sources = await api({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map((source) => ({
    id: String(source.id ?? "").trim(),
    name: String(source.name ?? "").trim() || "Tela",
    thumbnail: source.thumbnail ?? null,
    appIcon: source.appIcon ?? null,
  }));
}

async function captureScreenTrack(options?: StartScreenCaptureOptions): Promise<MediaStreamTrack> {
  const quality = parseQuality(options?.quality ?? DEFAULT_SCREEN_SHARE_QUALITY);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: quality.width, max: quality.width },
      height: { ideal: quality.height, max: quality.height },
      frameRate: { ideal: quality.frameRate, max: quality.frameRate },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("Nao foi possivel capturar a tela.");
  }
  return track;
}

function isQueueStoppedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
  return message.includes("queue stopped") || message.includes("awaitqueuestoppederror");
}

function isTrackEndedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
  return message.includes("track ended") || message.includes("invalidstateerror");
}

type CallCandidateType = "host" | "srflx" | "relay" | "prflx" | "unknown" | null;

interface VoiceStatsSnapshot {
  timestampMs: number;
  outboundBytes: number | null;
  inboundBytes: number | null;
  smoothedPingMs: number | null;
}

interface VoiceStatsValues {
  currentRttMs: number | null;
  packetLossPercent: number | null;
  outboundBytes: number | null;
  inboundBytes: number | null;
  localCandidateType: CallCandidateType;
  remoteCandidateType: CallCandidateType;
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toStatsEntries(report: unknown): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  if (!report) {
    return entries;
  }

  const maybeReport = report as {
    forEach?: (callback: (value: unknown) => void) => void;
  };
  if (typeof maybeReport.forEach === "function") {
    maybeReport.forEach((value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push(value as Record<string, unknown>);
      }
    });
    return entries;
  }

  if (Array.isArray(report)) {
    for (const value of report) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push(value as Record<string, unknown>);
      }
    }
    return entries;
  }

  if (typeof report === "object") {
    for (const value of Object.values(report as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push(value as Record<string, unknown>);
      }
    }
  }

  return entries;
}

function toCandidateType(value: unknown): CallCandidateType {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "host" || normalized === "srflx" || normalized === "relay" || normalized === "prflx") {
    return normalized;
  }
  return "unknown";
}

function isAudioRtpEntry(entry: Record<string, unknown>): boolean {
  const kind = String(entry.kind ?? entry.mediaType ?? "").trim().toLowerCase();
  return kind === "audio";
}

function resolveAudioTrackState(track: MediaStreamTrack | null | undefined): "live" | "muted" | "ended" | "missing" {
  if (!track) {
    return "missing";
  }
  if (track.readyState !== "live") {
    return "ended";
  }
  if (!track.enabled) {
    return "muted";
  }
  return "live";
}

export class CallService {
  private readonly options: CallServiceOptions;
  private audioSettings: NormalizedAudioSettings;
  private voiceUrl: string | null;
  private socket: WebSocket | null = null;
  private readonly manualCloseSockets = new WeakSet<WebSocket>();
  // P2P transport state (used when session.transport === "p2p").
  private p2pPeer: RTCPeerConnection | null = null;
  private p2pAudioTransceiver: RTCRtpTransceiver | null = null;
  private p2pVideoTransceiver: RTCRtpTransceiver | null = null;
  private p2pRemoteStream: MediaStream | null = null;
  private readonly p2pPendingLocalIce: RTCIceCandidateInit[] = [];
  private readonly p2pPendingRemoteIce: RTCIceCandidateInit[] = [];
  private readonly p2pIceServers: RTCIceServer[] = [];
  private p2pMakingOffer = false;
  private p2pIgnoreOffer = false;
  private p2pPolite = false;
  // Voice WS heartbeat/ping (signaling RTT). This is used as a ping fallback when media stats are unavailable.
  private heartbeatIntervalMs = 15_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPingStartedAtMs: number | null = null;
  private lastSignalPingMs: number | null = null;
  private pendingReply: {
    op: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
  } | null = null;
  private readonly requestExecutor = new SerialExecutor();
  private readonly connectFlight = new SingleFlight<void>();
  private readonly callGraphLock = new SequentialLock();
  private readonly debugLog: CallDebugLogger;
  private readonly sessionManager: CallSessionManager;
  private readonly transportManager: TransportManager;
  private readonly producerManager: ProducerManager;
  private readonly consumerManager: ConsumerManager;
  private readonly mediaManager: MediaDeviceManager;
  private readonly reconnectManager: ReconnectManager;
  private connectionState: RTCPeerConnectionState = "new";
  private audioProducerPaused: boolean | null = null;
  private remoteAudioWatchdog: ReturnType<typeof setTimeout> | null = null;
  private statsSnapshot: VoiceStatsSnapshot | null = null;
  private readonly consumeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly consumeRetryAttempts = new Map<string, number>();
  private disposed = false;

  constructor(options: CallServiceOptions) {
    this.options = options;
    this.audioSettings = normalizeAudioSettings(options.audioSettings);
    this.voiceUrl = resolveVoiceUrl();
    this.p2pIceServers.push(...parseIceServersFromEnv());

    const debugEnabled = import.meta.env.DEV || String(import.meta.env.VITE_MESSLY_CALL_DEBUG ?? "").trim() === "1";
    this.debugLog = (event, details) => {
      if (!debugEnabled) {
        return;
      }
      if (details && Object.keys(details).length > 0) {
        console.debug("[messly-call]", event, details);
      } else {
        console.debug("[messly-call]", event);
      }
    };

    this.sessionManager = new CallSessionManager({
      onPeerConnectionStateChange: (next) => {
        this.connectionState = next;
        this.options.onConnectionStateChange?.(next);
      },
      debugLog: this.debugLog,
    });

    this.transportManager = new TransportManager({
      request: (op, payload, expectedOp) => this.request(op, payload, expectedOp),
      onConnectionState: (state) => {
        this.handleTransportConnectionState(state);
      },
      onTransportFailed: () => {
        this.requestReconnect("transport-failed");
      },
      debugLog: this.debugLog,
    });

    this.producerManager = new ProducerManager(this.debugLog);
    this.consumerManager = new ConsumerManager({
      request: (op, payload, expectedOp) => this.request(op, payload, expectedOp),
      onRemoteStreamUpdated: (stream) => {
        this.debugLog("remote_stream_updated", {
          tracks: stream?.getTracks().length ?? 0,
          audioTracks: stream?.getAudioTracks().length ?? 0,
          videoTracks: stream?.getVideoTracks().length ?? 0,
        });
        this.options.onRemoteStream?.(stream);
      },
      debugLog: this.debugLog,
    });

    this.mediaManager = new MediaDeviceManager({
      mode: options.mode,
      initialAudioSettings: this.audioSettings,
      initialCameraEnabled: options.mode === "video",
      captureAudioTrack,
      captureCameraTrack,
      captureScreenTrack,
      onLocalStreamUpdated: (stream) => {
        this.options.onLocalStream?.(stream);
      },
      onTrackGraphChanged: () => {
        if (!this.isSessionActive()) {
          return;
        }
        const session = this.sessionManager.getSession();
        const sync = session?.transport === "p2p"
          ? this.syncP2pTracks("track-graph-changed")
          : this.syncProducers("track-graph-changed");
        void sync.catch((error) => {
          if (this.isRecoverableCallError(error)) {
            this.requestReconnect("track-graph-sync-failed");
            return;
          }
          this.emitError(error);
        });
      },
      onAudioTrackRecovered: () => {
        this.debugLog("track_ended", {
          kind: "audio",
          recovery: "started",
        });
        if (!this.isSessionActive()) {
          return;
        }
        const session = this.sessionManager.getSession();
        const sync = session?.transport === "p2p"
          ? this.syncP2pTracks("audio-track-recovered")
          : this.syncProducers("audio-track-recovered");
        void sync.catch((error) => {
          if (this.isRecoverableCallError(error)) {
            this.requestReconnect("audio-recovery-sync-failed");
            return;
          }
          this.emitError(error);
        });
      },
      onError: (error) => {
        this.emitError(error);
      },
      debugLog: this.debugLog,
    });

    this.reconnectManager = new ReconnectManager({
      shouldReconnect: () => this.shouldReconnect(),
      performReconnect: () => this.performReconnect(),
      onReconnectFailed: (error) => {
        this.emitError(error);
      },
      debugLog: this.debugLog,
    });

    this.options.onLocalStream?.(null);
    this.options.onRemoteStream?.(null);
  }

  getLocalStream(): MediaStream | null {
    const stream = this.mediaManager.buildLocalStream();
    return stream ? new MediaStream(stream.getTracks()) : null;
  }

  getRemoteStream(): MediaStream | null {
    const session = this.sessionManager.getSession();
    if (session?.transport === "p2p") {
      if (!this.p2pRemoteStream) {
        return null;
      }
      return new MediaStream(this.p2pRemoteStream.getTracks());
    }
    return this.consumerManager.getRemoteStream();
  }

  getConnectionState(): RTCPeerConnectionState | null {
    return this.connectionState;
  }

  isScreenSharing(): boolean {
    return this.mediaManager.isScreenSharing();
  }

  getOfferPayload(): Record<string, unknown> | null {
    const session = this.sessionManager.getSession();
    if (!session) {
      return null;
    }
    return buildOffer(session);
  }

  async startAsCaller(): Promise<Record<string, unknown>> {
    this.assertNotDisposed();

    let session = this.sessionManager.getSession();
    if (!session) {
      const conversationId = toId(this.options.conversationId);
      if (!conversationId) {
        throw new Error("conversationId ausente para chamada.");
      }
      session = {
        transport: resolvePreferredVoiceTransport(),
        callId: createSessionId("voice"),
        roomId: createSessionId("room"),
        conversationId,
        mode: this.options.mode,
        role: "caller",
        resumeToken: null,
        offerSdp: null,
        answerSdp: null,
      };
      this.sessionManager.setSession(session);
    }

    this.debugLog("call_start", {
      role: "caller",
      callId: session.callId,
      conversationId: session.conversationId,
      mode: session.mode,
      transport: session.transport,
    });

    await this.mediaManager.ensureLocalTracks();

    if (session.transport === "p2p") {
      await this.callGraphLock.runExclusive(async () => {
        this.sessionManager.transition("connecting", "call.startOutgoing.p2p");
        await this.ensureP2pPeer("call.startOutgoing");
        await this.syncP2pTracksUnsafe("call.startOutgoing");
        await this.createP2pOffer({ iceRestart: false, reason: "call.startOutgoing" });
        this.scheduleRemoteAudioWatchdog();
      });
      return buildOffer(this.requireSession());
    }

    const hasLiveVoiceSession =
      Boolean(this.socket && this.socket.readyState === WebSocket.OPEN) &&
      Boolean(this.transportManager.getSendTransport()) &&
      Boolean(this.transportManager.getRecvTransport());
    if (hasLiveVoiceSession) {
      await this.syncProducers("call.startOutgoing.reuse");
      return buildOffer(this.requireSession());
    }

    await this.connectToVoice("call.startOutgoing");
    await this.syncProducers("call.startOutgoing");

    const nextSession = this.requireSession();
    return buildOffer(nextSession);
  }

  async startAsCallee(): Promise<void> {
    this.assertNotDisposed();
    await this.mediaManager.ensureLocalTracks();
    this.debugLog("call_start", {
      role: "callee",
      mode: this.options.mode,
    });
  }

  async handleSignal(signal: CallServiceSignal): Promise<CallServiceSignal | null> {
    this.assertNotDisposed();

    if (signal.type === "offer") {
      const offer = parseOffer(toRecord(signal.payload));
      if (!offer) {
        throw new Error("Oferta de chamada invalida.");
      }

      this.sessionManager.setSession(offer);
      this.mediaManager.setMode(offer.mode);
      await this.mediaManager.ensureLocalTracks();
      if (offer.transport === "p2p") {
        await this.callGraphLock.runExclusive(async () => {
          this.sessionManager.transition("connecting", "call.handleSignal.offer.p2p");
          await this.ensureP2pPeer("call.handleSignal.offer");
          await this.syncP2pTracksUnsafe("call.handleSignal.offer");
          const sdp = toId(toRecord(signal.payload).sdp);
          if (!sdp) {
            throw new Error("Oferta P2P sem SDP.");
          }
          const createdAnswer = await this.acceptP2pOffer(sdp, "call.handleSignal.offer");
          if (!createdAnswer) {
            return;
          }
          this.scheduleRemoteAudioWatchdog();
        });
        const current = this.sessionManager.getSession();
        if (!current || current.transport !== "p2p" || !current.answerSdp) {
          return null;
        }
        return {
          type: "answer",
          payload: buildAnswer(current),
        };
      }

      await this.connectToVoice("call.handleSignal.offer");
      await this.syncProducers("call.handleSignal.offer");

      return {
        type: "answer",
        payload: buildAnswer(this.requireSession()),
      };
    }

    if (signal.type === "answer") {
      const session = this.sessionManager.getSession();
      if (session?.transport === "p2p") {
        const payload = toRecord(signal.payload);
        const sdp = toId(payload.sdp);
        if (sdp) {
          await this.callGraphLock.runExclusive(async () => {
            await this.ensureP2pPeer("call.handleSignal.answer");
            await this.acceptP2pAnswer(sdp, "call.handleSignal.answer");
          });
        }
      }
      return null;
    }

    if (signal.type === "ice") {
      const payload = toRecord(signal.payload);
      const transport = String(payload.transport ?? "").trim().toLowerCase();
      const session = this.sessionManager.getSession();
      const shouldHandleP2p = transport === "p2p" || session?.transport === "p2p";
      if (shouldHandleP2p) {
        await this.callGraphLock.runExclusive(async () => {
          if (this.sessionManager.getSession()?.transport === "p2p") {
            await this.ensureP2pPeer("call.handleSignal.ice");
          }
          await this.addP2pRemoteIceCandidate(payload, "call.handleSignal.ice");
        });
      }
      return null;
    }

    if (signal.type === "bye") {
      await this.close();
      return null;
    }

    return null;
  }

  toggleMute(): boolean {
    const micEnabled = this.mediaManager.toggleMute();
    if (this.isSessionActive()) {
      void this.callGraphLock
        .runExclusive(async () => {
          const session = this.sessionManager.getSession();
          if (session?.transport === "p2p") {
            // For P2P calls we rely on track.enabled to represent mute state (silence).
            return;
          }
          await this.syncAudioProducerPauseState("toggleMute");
        })
        .catch((error) => {
          if (this.isRecoverableCallError(error)) {
            this.requestReconnect("toggle-mute-recoverable");
            return;
          }
          this.emitError(error);
        });
    }
    return micEnabled;
  }

  toggleCamera(): boolean {
    const nextEnabled = this.mediaManager.toggleCamera();
    const session = this.sessionManager.getSession();
    const sync = session?.transport === "p2p" ? this.syncP2pTracks("call.toggleCamera") : this.syncProducers("call.toggleCamera");
    void sync.catch((error) => {
      if (this.isRecoverableCallError(error)) {
        this.requestReconnect("toggle-camera-recoverable");
        return;
      }
      this.emitError(error);
    });
    return nextEnabled;
  }

  async setQoSEnabled(enabled: boolean): Promise<void> {
    this.audioSettings = { ...this.audioSettings, qosHighPriority: enabled };
  }

  setPushToTalkEnabled(enabled: boolean): void {
    this.audioSettings = { ...this.audioSettings, pushToTalkEnabled: enabled };
    this.mediaManager.setPushToTalkEnabled(enabled);
  }

  setPushToTalkPressed(pressed: boolean): void {
    this.mediaManager.setPushToTalkPressed(pressed);
  }

  async updateAudioSettings(settings: CallAudioSettings | null | undefined): Promise<void> {
    this.audioSettings = normalizeAudioSettings(settings);
    await this.mediaManager.updateAudioSettings(this.audioSettings);
    const session = this.sessionManager.getSession();
    if (session?.transport === "p2p") {
      await this.syncP2pTracks("call.updateAudioSettings");
      return;
    }
    await this.syncProducers("call.updateAudioSettings");
  }

  async startScreenShare(options?: StartScreenShareOptions): Promise<boolean> {
    await this.mediaManager.startScreenShare(options);
    const session = this.sessionManager.getSession();
    if (session?.transport === "p2p") {
      await this.syncP2pTracks("call.startScreenShare");
      return true;
    }
    await this.syncProducers("call.startScreenShare");
    return true;
  }

  async stopScreenShare(): Promise<void> {
    await this.mediaManager.stopScreenShare();
    const session = this.sessionManager.getSession();
    if (session?.transport === "p2p") {
      await this.syncP2pTracks("call.stopScreenShare");
      return;
    }
    await this.syncProducers("call.stopScreenShare");
  }

  async restartIce(reason = "manual"): Promise<boolean> {
    if (!this.sessionManager.getSession() || this.disposed) {
      return false;
    }
    await this.reconnectManager.run(`ice-restart:${reason}`);
    return true;
  }

  async getVoiceDiagnostics(): Promise<CallVoiceDiagnostics | null> {
    const state = this.connectionState;
    const iceConnectionState: RTCIceConnectionState =
      state === "connected"
        ? "connected"
        : state === "failed"
          ? "failed"
          : state === "closed"
            ? "closed"
            : "checking";

    const stats = await this.collectVoiceStats();
    const nowMs = Date.now();
    const previousSnapshot = this.statsSnapshot;
    const rawPingMs = stats.currentRttMs ?? this.lastSignalPingMs ?? null;
    const nextSmoothedPing = rawPingMs == null
      ? previousSnapshot?.smoothedPingMs ?? null
      : previousSnapshot?.smoothedPingMs == null
        ? rawPingMs
        : (previousSnapshot.smoothedPingMs * 0.75) + (rawPingMs * 0.25);

    let outboundBitrateKbps: number | null = null;
    let inboundBitrateKbps: number | null = null;
    if (previousSnapshot) {
      const elapsedMs = Math.max(1, nowMs - previousSnapshot.timestampMs);
      if (stats.outboundBytes != null && previousSnapshot.outboundBytes != null) {
        const deltaBytes = Math.max(0, stats.outboundBytes - previousSnapshot.outboundBytes);
        outboundBitrateKbps = (deltaBytes * 8) / (elapsedMs / 1_000) / 1_000;
      }
      if (stats.inboundBytes != null && previousSnapshot.inboundBytes != null) {
        const deltaBytes = Math.max(0, stats.inboundBytes - previousSnapshot.inboundBytes);
        inboundBitrateKbps = (deltaBytes * 8) / (elapsedMs / 1_000) / 1_000;
      }
    }

    this.statsSnapshot = {
      timestampMs: nowMs,
      outboundBytes: stats.outboundBytes,
      inboundBytes: stats.inboundBytes,
      smoothedPingMs: nextSmoothedPing,
    };

    const session = this.sessionManager.getSession();
    const isP2p = session?.transport === "p2p";
    const localAudioTrackState = resolveAudioTrackState(this.mediaManager.getAudioTrack());
    const remoteAudioTrack = isP2p
      ? (this.p2pRemoteStream?.getAudioTracks().find((track) => track.readyState === "live") ?? null)
      : this.consumerManager.getPrimaryRemoteAudioTrack();
    const remoteAudioTrackState = resolveAudioTrackState(remoteAudioTrack);
    const remoteAudioConsumers = isP2p
      ? (this.p2pRemoteStream?.getAudioTracks().length ?? 0)
      : this.consumerManager.getAudioConsumerCount();
    const hasActiveAudioProducer = isP2p
      ? Boolean(this.p2pAudioTransceiver?.sender?.track && this.p2pAudioTransceiver.sender.track.readyState === "live")
      : this.producerManager.hasActiveAudioProducer();
    const sendingAudio = localAudioTrackState !== "live"
      ? false
      : outboundBitrateKbps == null
        ? (hasActiveAudioProducer ? null : false)
        : outboundBitrateKbps > 0.5;
    const receivingAudio = remoteAudioTrackState !== "live"
      ? false
      : inboundBitrateKbps == null
        ? (remoteAudioConsumers > 0 ? null : false)
        : inboundBitrateKbps > 0.5;

    return {
      averagePingMs: nextSmoothedPing,
      lastPingMs: rawPingMs,
      packetLossPercent: stats.packetLossPercent,
      connectionType: stats.remoteCandidateType ?? stats.localCandidateType ?? null,
      localCandidateType: stats.localCandidateType,
      remoteCandidateType: stats.remoteCandidateType,
      usingRelay:
        stats.localCandidateType == null && stats.remoteCandidateType == null
          ? null
          : stats.localCandidateType === "relay" || stats.remoteCandidateType === "relay",
      outboundBitrateKbps,
      inboundBitrateKbps,
      localAudioTrackState,
      remoteAudioTrackState,
      sendingAudio,
      receivingAudio,
      remoteAudioConsumers,
      connectionState: state,
      iceConnectionState,
      updatedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.reconnectManager.dispose();

    await this.callGraphLock.runExclusive(async () => {
      this.sessionManager.transition("disconnecting", "call.close");
      if (this.remoteAudioWatchdog) {
        clearTimeout(this.remoteAudioWatchdog);
        this.remoteAudioWatchdog = null;
      }
      this.clearConsumeRetries();
      this.closeSocket(1000, "CALL_CLOSE");
      this.rejectPendingReply(new Error("Socket de voz fechado."));
      this.consumerManager.clear("call.close");
      this.producerManager.closeAll("call.close");
      this.disposeP2pPeer("call.close");
      this.transportManager.destroy();
      this.mediaManager.dispose();
      this.sessionManager.setSession(null);
      this.sessionManager.transition("destroyed", "call.close");
      this.statsSnapshot = null;
      this.audioProducerPaused = null;
      this.debugLog("call_ended", {
        reason: "manual-close",
      });
    });

    this.options.onLocalStream?.(null);
    this.options.onRemoteStream?.(null);
  }

  private async collectVoiceStats(): Promise<VoiceStatsValues> {
    const session = this.sessionManager.getSession();
    const isP2p = session?.transport === "p2p";
    const sendTransport = isP2p ? null : this.transportManager.getSendTransport();
    const recvTransport = isP2p ? null : this.transportManager.getRecvTransport();
    const peer = isP2p ? this.p2pPeer : null;

    const [sendStatsReport, recvStatsReport, p2pStatsReport] = await Promise.all([
      sendTransport?.getStats().catch(() => null) ?? Promise.resolve(null),
      recvTransport?.getStats().catch(() => null) ?? Promise.resolve(null),
      peer?.getStats().catch(() => null) ?? Promise.resolve(null),
    ]);

    const entries = isP2p
      ? toStatsEntries(p2pStatsReport)
      : [...toStatsEntries(sendStatsReport), ...toStatsEntries(recvStatsReport)];
    if (entries.length === 0) {
      this.debugLog("voice_stats_empty", {
        sendTransportId: sendTransport?.id ?? null,
        recvTransportId: recvTransport?.id ?? null,
        transport: isP2p ? "p2p" : "mediasoup",
      });
    }

    let outboundBytesTotal = 0;
    let outboundBytesSamples = 0;
    let inboundBytesTotal = 0;
    let inboundBytesSamples = 0;
    let packetsReceivedTotal = 0;
    let packetsLostTotal = 0;
    let hasPacketCounters = false;

    for (const entryRaw of entries) {
      const entry = toRecord(entryRaw);
      const type = String(entry.type ?? "").trim().toLowerCase();
      if (type === "outbound-rtp" && isAudioRtpEntry(entry)) {
        const bytesSent = toFiniteNumber(entry.bytesSent);
        if (bytesSent != null) {
          outboundBytesTotal += bytesSent;
          outboundBytesSamples += 1;
        }
        continue;
      }

      if (type === "inbound-rtp" && isAudioRtpEntry(entry)) {
        const bytesReceived = toFiniteNumber(entry.bytesReceived);
        if (bytesReceived != null) {
          inboundBytesTotal += bytesReceived;
          inboundBytesSamples += 1;
        }

        const packetsReceived = toFiniteNumber(entry.packetsReceived);
        const packetsLost = toFiniteNumber(entry.packetsLost);
        if (packetsReceived != null) {
          packetsReceivedTotal += Math.max(0, packetsReceived);
          hasPacketCounters = true;
        }
        if (packetsLost != null) {
          packetsLostTotal += Math.max(0, packetsLost);
          hasPacketCounters = true;
        }
      }
    }

    const candidatePairs = entries
      .map((entry) => toRecord(entry))
      .filter((entry) => String(entry.type ?? "").trim().toLowerCase() === "candidate-pair");

    const selectedPair =
      candidatePairs.find((entry) => entry.selected === true)
      ?? candidatePairs.find((entry) => entry.nominated === true && String(entry.state ?? "").trim().toLowerCase() === "succeeded")
      ?? candidatePairs.find((entry) => String(entry.state ?? "").trim().toLowerCase() === "succeeded")
      ?? null;
    if (!selectedPair) {
      this.debugLog("voice_stats_no_candidate_pair", {
        candidatePairs: candidatePairs.length,
      });
    }

    const localCandidateId = toId(selectedPair?.localCandidateId);
    const remoteCandidateId = toId(selectedPair?.remoteCandidateId);
    const localCandidate = localCandidateId
      ? entries.find(
        (entry) =>
          toId(toRecord(entry).id) === localCandidateId &&
          String(toRecord(entry).type ?? "").trim().toLowerCase() === "local-candidate",
      )
      : null;
    const remoteCandidate = remoteCandidateId
      ? entries.find(
        (entry) =>
          toId(toRecord(entry).id) === remoteCandidateId &&
          String(toRecord(entry).type ?? "").trim().toLowerCase() === "remote-candidate",
      )
      : null;

    let currentRttMs = (() => {
      const currentRoundTripTime = toFiniteNumber(selectedPair?.currentRoundTripTime);
      if (currentRoundTripTime != null) {
        return currentRoundTripTime * 1_000;
      }

      const totalRoundTripTime = toFiniteNumber(selectedPair?.totalRoundTripTime);
      const responsesReceived = toFiniteNumber(selectedPair?.responsesReceived);
      if (totalRoundTripTime != null && responsesReceived != null && responsesReceived > 0) {
        return (totalRoundTripTime / responsesReceived) * 1_000;
      }
      return null;
    })();

    if (currentRttMs == null) {
      let rttTotalMs = 0;
      let rttSamples = 0;
      for (const entryRaw of entries) {
        const entry = toRecord(entryRaw);
        if (String(entry.type ?? "").trim().toLowerCase() !== "remote-inbound-rtp" || !isAudioRtpEntry(entry)) {
          continue;
        }

        const roundTripTime = toFiniteNumber(entry.roundTripTime);
        if (roundTripTime != null) {
          rttTotalMs += roundTripTime * 1_000;
          rttSamples += 1;
          continue;
        }

        const totalRoundTripTime = toFiniteNumber(entry.totalRoundTripTime);
        const reportsReceived = toFiniteNumber(entry.reportsReceived);
        if (totalRoundTripTime != null && reportsReceived != null && reportsReceived > 0) {
          rttTotalMs += (totalRoundTripTime / reportsReceived) * 1_000;
          rttSamples += 1;
        }
      }

      if (rttSamples > 0) {
        currentRttMs = rttTotalMs / rttSamples;
      }
    }

    if (currentRttMs == null && isP2p) {
      currentRttMs = getBrowserEstimatedRttMs();
    }

    const packetLossPercent = hasPacketCounters && packetsReceivedTotal + packetsLostTotal > 0
      ? (packetsLostTotal / (packetsReceivedTotal + packetsLostTotal)) * 100
      : null;

    return {
      currentRttMs,
      packetLossPercent,
      outboundBytes: outboundBytesSamples > 0 ? outboundBytesTotal : null,
      inboundBytes: inboundBytesSamples > 0 ? inboundBytesTotal : null,
      localCandidateType: toCandidateType(toRecord(localCandidate).candidateType),
      remoteCandidateType: toCandidateType(toRecord(remoteCandidate).candidateType),
    };
  }

  private async connectToVoice(scope: string): Promise<void> {
    return this.connectFlight.run(async () => {
      await this.callGraphLock.runExclusive(async () => {
        await this.connectToVoiceUnsafe(scope);
      });
    });
  }

  private async connectToVoiceUnsafe(scope: string): Promise<void> {
    if (this.disposed) {
      throw new Error("Chamada encerrada.");
    }

    const session = this.requireSession();
    this.sessionManager.transition(
      this.sessionManager.getLifecycle() === "connected" ? "reconnecting" : "connecting",
      scope,
    );

    await this.ensureSocket();

    const token = String((await authService.getValidatedEdgeAccessToken()) ?? "").trim();
    if (!token) {
      throw new Error("Token de autenticacao ausente para voz.");
    }

    const auth = await this.request(
      "AUTH",
      {
        token,
        callId: session.callId,
        roomId: session.roomId,
        conversationId: session.conversationId,
        mode: session.mode,
        role: session.role,
        resumeToken: session.resumeToken,
      },
      "AUTH_OK",
    );

    const call = toRecord(auth.call);
    const transports = toRecord(auth.transports);
    const nextSession: VoiceSession = {
      ...session,
      resumeToken: toId(auth.resumeToken) || session.resumeToken,
      callId: toId(call.callId) || session.callId,
      roomId: toId(call.roomId) || session.roomId,
      conversationId: toId(call.conversationId) || session.conversationId,
      mode: String(call.mode ?? session.mode).trim().toLowerCase() === "video" ? "video" : "audio",
    };
    this.sessionManager.setSession(nextSession);

    const routerRtpCapabilities = transports.routerRtpCapabilities as RtpCapabilities | undefined;
    const sendTransport = toRecord(transports.sendTransport);
    const recvTransport = toRecord(transports.recvTransport);
    if (!routerRtpCapabilities || !sendTransport.id || !recvTransport.id) {
      throw new Error("AUTH_OK sem informacoes de transporte.");
    }
    const hasValidSendCandidates = hasNonWildcardIceCandidate(sendTransport.iceCandidates);
    const hasValidRecvCandidates = hasNonWildcardIceCandidate(recvTransport.iceCandidates);
    if (!hasValidSendCandidates || !hasValidRecvCandidates) {
      throw new Error(
        "Servidor de voz sem ICE publico valido. Verifique MESSLY_SFU_ANNOUNCED_IP e rede/portas UDP/TCP do SFU.",
      );
    }

    this.clearConsumeRetries();
    this.consumerManager.clear("transport-rebuild");
    this.producerManager.closeAll("transport-rebuild");
    this.transportManager.closeTransports();
    this.statsSnapshot = null;
    this.audioProducerPaused = null;

    await this.transportManager.setup(routerRtpCapabilities, sendTransport, recvTransport);
    this.scheduleRemoteAudioWatchdog();

    const producerRows = Array.isArray(auth.producers) ? auth.producers : [];
    for (const row of producerRows) {
      const producerPayload = toRecord(row);
      const producerId = toId(producerPayload.producerId);
      if (this.producerManager.hasProducerId(producerId)) {
        this.debugLog("consumer_skipped", {
          reason: "skip-own-producer",
          producerId,
        });
        continue;
      }
      try {
        await this.consumerManager.consumeProducer(
          producerPayload,
          this.transportManager.getRecvTransport(),
          this.transportManager.getDevice(),
        );
      } catch (error) {
        if (this.isProducerConsumeRaceError(error)) {
          this.debugLog("consumer_skipped", {
            reason: "initial-consume-race",
            producerId: toId(producerPayload.producerId) || null,
            message: error instanceof Error ? error.message : String(error ?? ""),
          });
          this.scheduleConsumeRetry(producerPayload, "initial-consume-race");
          continue;
        }
        throw error;
      }
    }

    this.debugLog("device_loaded", {
      scope,
      callId: nextSession.callId,
      roomId: nextSession.roomId,
    });

    await this.syncProducersUnsafe(scope);
  }

  private async syncProducers(scope: string): Promise<void> {
    if (!this.isSessionActive()) {
      return;
    }

    await this.callGraphLock.runExclusive(async () => {
      await this.syncProducersUnsafe(scope);
    });
  }

  private async syncProducersUnsafe(scope: string): Promise<void> {
    if (!this.isSessionActive()) {
      return;
    }

    const sendTransport = this.transportManager.getSendTransport();
    if (!sendTransport) {
      this.producerManager.closeAll("missing-send-transport");
      return;
    }

    let audioTrack = this.mediaManager.getAudioTrack();
    if (!audioTrack) {
      await this.mediaManager.ensureLocalTracks();
      audioTrack = this.mediaManager.getAudioTrack();
    }

    try {
      await this.producerManager.syncAudio(sendTransport, audioTrack);
      await this.syncAudioProducerPauseState(`syncAudio:${scope}`);
    } catch (error) {
      if (isTrackEndedError(error)) {
        this.debugLog("track_ended", {
          scope,
          kind: "audio",
          action: "producer-sync",
        });
        await this.mediaManager.ensureLocalTracks().catch(() => undefined);
        const recoveredTrack = this.mediaManager.getAudioTrack();
        if (isTrackLive(recoveredTrack)) {
          await this.producerManager.syncAudio(sendTransport, recoveredTrack).catch((retryError) => {
            if (isQueueStoppedError(retryError)) {
              this.requestReconnect("audio-producer-queue-stopped");
              return;
            }
            throw retryError;
          });
          await this.syncAudioProducerPauseState(`syncAudio:recovered:${scope}`);
        }
      } else if (isQueueStoppedError(error)) {
        this.requestReconnect("audio-producer-queue-stopped");
      } else {
        throw error;
      }
    }

    const videoTrack = this.mediaManager.getPreferredVideoTrack();
    const source = this.mediaManager.isScreenSharing() ? "screen" : "camera";

    try {
      await this.producerManager.syncVideo(sendTransport, videoTrack, source);
    } catch (error) {
      if (isQueueStoppedError(error) || isTrackEndedError(error)) {
        this.requestReconnect("video-producer-sync-failed");
        return;
      }
      throw error;
    }
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.voiceUrl) {
      throw new Error("Servidor de voz nao configurado.");
    }

    const endpointSupport = await probeVoiceEndpoint(this.voiceUrl);
    if (endpointSupport === "unsupported") {
      throw new Error("Servidor de voz indisponivel no gateway atual. Atualize o backend para habilitar WS /voice.");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.voiceUrl as string);
      this.socket = socket;
      let opened = false;
      let settled = false;
      let sawSocketError = false;

      const openTimeoutId = setTimeout(() => {
        try {
          socket.close(1000, "VOICE_CONNECT_TIMEOUT");
        } catch {
          // Best effort.
        }
        settle(() => reject(new Error("Tempo limite ao conectar no servidor de voz.")));
      }, VOICE_SOCKET_OPEN_TIMEOUT_MS);

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(openTimeoutId);
        fn();
      };

      socket.addEventListener(
        "open",
        () => {
          opened = true;
          this.debugLog("socket_open", {
            url: this.voiceUrl,
          });
          // Start heartbeat with the default interval; HELLO can override it later.
          this.startHeartbeat(this.heartbeatIntervalMs);
          settle(() => resolve());
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          sawSocketError = true;
        },
        { once: true },
      );

      socket.addEventListener("message", (event) => {
        this.onSocketMessage(String(event.data ?? ""));
      });

      socket.addEventListener("close", (event) => {
        const wasManual = this.manualCloseSockets.has(socket);
        this.manualCloseSockets.delete(socket);

        if (this.socket === socket) {
          this.socket = null;
        }

        this.stopHeartbeat();
        this.rejectPendingReply(new Error("Socket de voz fechado."));

        if (!opened) {
          const closeCode = Number(event.code);
          const closeReason = String(event.reason ?? "").trim();
          const closeLabel = Number.isFinite(closeCode) && closeCode > 0
            ? `codigo ${closeCode}${closeReason ? `: ${closeReason}` : ""}`
            : "erro de handshake";
          const hasHandshakeFailure = closeCode === 1006 || sawSocketError;
          const hint = hasHandshakeFailure
            ? " Verifique se o gateway suporta WS /voice e se MESSLY_ALLOWED_ORIGINS inclui este dominio."
            : "";
          settle(() => reject(new Error(`Conexao de voz encerrada antes de abrir (${closeLabel}).${hint}`)));
          return;
        }

        if (!this.disposed && !wasManual) {
          this.debugLog("socket_closed", {
            code: event.code,
            reason: String(event.reason ?? "").trim() || null,
          });
          this.requestReconnect("socket-closed");
        }
      });
    });
  }

  private onSocketMessage(raw: string): void {
    let frame: VoiceFrame | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceFrame>;
      frame = {
        op: String(parsed.op ?? "").trim().toUpperCase(),
        d: parsed.d ?? {},
      };
    } catch {
      return;
    }

    if (!frame || !frame.op) {
      return;
    }

    this.reconnectManager.resetAttempts();

    if (frame.op === "ERROR") {
      const payload = toRecord(frame.d);
      const message = toId(payload.message) || "Operacao de voz falhou.";
      const code = toId(payload.code);
      const composedMessage = code ? `${message} (${code})` : message;
      this.rejectPendingReply(new Error(composedMessage));
      return;
    }

    if (this.pendingReply && this.pendingReply.op === frame.op) {
      const pending = this.pendingReply;
      this.pendingReply = null;
      pending.resolve(toRecord(frame.d));
      return;
    }

    if (frame.op === "HELLO") {
      const payload = toRecord(frame.d);
      const heartbeatMs = toFiniteNumber(payload.heartbeatIntervalMs);
      if (heartbeatMs != null) {
        this.startHeartbeat(heartbeatMs);
      }
      this.debugLog("voice_hello", {
        heartbeatIntervalMs: heartbeatMs ?? null,
      });
      return;
    }

    if (frame.op === "PONG") {
      this.handlePong();
      return;
    }

    if (frame.op === "RECONNECT_REQUIRED") {
      this.debugLog("voice_reconnect_required", {
        reason: toId(toRecord(frame.d).reason) || null,
      });
      // Drop current transports and socket immediately to avoid sending ops with stale IDs.
      this.clearConsumeRetries();
      this.consumerManager.clear("server-reconnect-required");
      this.producerManager.closeAll("server-reconnect-required");
      this.transportManager.closeTransports();
      this.statsSnapshot = null;
      this.closeSocket(1012, "RECONNECT_REQUIRED");
      this.requestReconnect("server-reconnect-required");
      return;
    }

    if (frame.op === "PRODUCER_ADDED") {
      const producerPayload = toRecord(frame.d);
      const producerId = toId(producerPayload.producerId);
      if (this.producerManager.hasProducerId(producerId)) {
        this.debugLog("consumer_skipped", {
          reason: "skip-own-producer",
          producerId,
        });
        return;
      }

      // A producer can arrive before we finish rebuilding transports/device (especially on join/reconnect).
      // If we try to consume immediately with missing transport/device, we silently drop the producer forever.
      // Queue a retry so we eventually consume once transports are ready.
      if (!this.transportManager.getRecvTransport() || !this.transportManager.getDevice()) {
        this.debugLog("consumer_deferred", {
          reason: "missing-transport",
          producerId,
        });
        this.scheduleConsumeRetry(producerPayload, "producer-added-missing-transport");
        return;
      }

      void this.callGraphLock
        .runExclusive(async () => {
          const recvTransport = this.transportManager.getRecvTransport();
          const device = this.transportManager.getDevice();
          if (!recvTransport || !device) {
            this.scheduleConsumeRetry(producerPayload, "producer-added-missing-transport");
            return;
          }
          await this.consumerManager.consumeProducer(producerPayload, recvTransport, device);
          if (producerId && !this.consumerManager.hasConsumerForProducer(producerId)) {
            this.scheduleConsumeRetry(producerPayload, "producer-added-no-consumer");
          }
        })
        .catch((error) => {
          if (this.isProducerConsumeRaceError(error)) {
            this.debugLog("consumer_skipped", {
              reason: "producer-added-consume-race",
              producerId: toId(producerPayload.producerId) || null,
              message: error instanceof Error ? error.message : String(error ?? ""),
            });
            this.scheduleConsumeRetry(producerPayload, "producer-added-consume-race");
            return;
          }
          if (this.isRecoverableCallError(error)) {
            this.requestReconnect("producer-added-consume-failed");
            return;
          }
          this.emitError(error);
        });
      return;
    }

    if (frame.op === "PRODUCER_REMOVED") {
      const producerId = toId(toRecord(frame.d).producerId);
      if (!producerId) {
        return;
      }
      this.clearConsumeRetryForProducer(producerId);
      this.consumerManager.removeProducer(producerId);
    }
  }

  private request(op: string, payload: Record<string, unknown>, expectedOp: string): Promise<Record<string, unknown>> {
    return this.requestExecutor.enqueue(async () => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Socket de voz fechado.");
      }
      if (this.pendingReply) {
        throw new Error("Resposta de voz pendente.");
      }

      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!this.pendingReply || this.pendingReply.op !== expectedOp) {
            return;
          }
          this.pendingReply = null;
          reject(new Error(`Tempo limite aguardando ${expectedOp}.`));
          this.requestReconnect("request-timeout");
        }, VOICE_REQUEST_TIMEOUT_MS);

        this.pendingReply = {
          op: expectedOp,
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (reason) => {
            clearTimeout(timeout);
            reject(reason);
          },
        };

        try {
          this.socket?.send(
            JSON.stringify({
              op,
              d: payload,
            }),
          );
        } catch (error) {
          clearTimeout(timeout);
          this.pendingReply = null;
          reject(error instanceof Error ? error : new Error(String(error ?? "Falha ao enviar requisicao de voz.")));
        }
      });
    });
  }

  private async performReconnect(): Promise<void> {
    const session = this.sessionManager.getSession();
    if (!session || this.disposed) {
      return;
    }

    await this.connectFlight.run(async () => {
      await this.callGraphLock.runExclusive(async () => {
        if (!this.shouldReconnect()) {
          return;
        }

        if (session.transport === "p2p") {
          this.sessionManager.transition("reconnecting", "call.rejoinExisting.p2p");
          this.debugLog("reconnect_started", {
            callId: session.callId,
            conversationId: session.conversationId,
            transport: "p2p",
          });

          await this.ensureP2pPeer("call.rejoinExisting");
          await this.syncP2pTracksUnsafe("call.rejoinExisting");
          await this.createP2pOffer({ iceRestart: true, reason: "call.rejoinExisting" });
          this.scheduleRemoteAudioWatchdog();

          const offerPayload = buildOffer(this.requireSession());
          void Promise.resolve(this.options.onSignal({ type: "offer", payload: offerPayload })).catch((error) => {
            this.debugLog("p2p_signal_send_failed", {
              type: "offer",
              message: error instanceof Error ? error.message : String(error ?? ""),
            });
          });

          this.debugLog("reconnect_success", {
            callId: this.sessionManager.getSession()?.callId ?? null,
            transport: "p2p",
          });
          return;
        }

        this.sessionManager.transition("reconnecting", "call.rejoinExisting");
        this.debugLog("reconnect_started", {
          callId: session.callId,
          conversationId: session.conversationId,
        });

        this.clearConsumeRetries();
        this.closeSocket(1012, "RECONNECT");
        this.rejectPendingReply(new Error("Socket de voz fechado."));
        this.consumerManager.clear("reconnect");
        this.producerManager.closeAll("reconnect");
        this.transportManager.closeTransports();

        await this.mediaManager.ensureLocalTracks();
        await this.connectToVoiceUnsafe("call.rejoinExisting");
        await this.syncProducersUnsafe("call.rejoinExisting");

        this.debugLog("reconnect_success", {
          callId: this.sessionManager.getSession()?.callId ?? null,
        });
      });
    });
  }

  private handleTransportConnectionState(state: RTCPeerConnectionState): void {
    if (this.disposed || this.sessionManager.isDestroyed()) {
      return;
    }

    if (state === "connected") {
      this.sessionManager.transition("connected", "transport-connected");
      return;
    }

    if (state === "failed" || state === "disconnected") {
      this.requestReconnect(`transport-${state}`);
      return;
    }

    if (state === "connecting") {
      const lifecycle = this.sessionManager.getLifecycle();
      if (lifecycle === "idle" || lifecycle === "connected") {
        this.sessionManager.transition("connecting", "transport-connecting");
      }
    }
  }

  private shouldReconnect(): boolean {
    return !this.disposed && Boolean(this.sessionManager.getSession()) && this.sessionManager.canMutateCallGraph();
  }

  private requestReconnect(reason: string): void {
    if (!this.shouldReconnect()) {
      return;
    }
    this.sessionManager.transition("reconnecting", reason);
    this.reconnectManager.schedule(reason);
  }

  private scheduleConsumeRetry(producerPayloadRaw: Record<string, unknown>, reason: string): void {
    const producerPayload = toRecord(producerPayloadRaw);
    const producerId = toId(producerPayload.producerId);
    if (!producerId || this.disposed || !this.isSessionActive()) {
      return;
    }
    if (this.producerManager.hasProducerId(producerId)) {
      this.clearConsumeRetryForProducer(producerId);
      this.debugLog("consume_retry_skipped", {
        producerId,
        reason: "skip-own-producer",
      });
      return;
    }
    if (this.consumerManager.hasConsumerForProducer(producerId)) {
      this.clearConsumeRetryForProducer(producerId);
      return;
    }

    const previousAttempts = this.consumeRetryAttempts.get(producerId) ?? 0;
    if (previousAttempts >= CONSUME_RETRY_MAX_ATTEMPTS) {
      this.debugLog("consume_retry_aborted", {
        producerId,
        reason,
        attempts: previousAttempts,
      });
      this.clearConsumeRetryForProducer(producerId);
      return;
    }

    if (this.consumeRetryTimers.has(producerId)) {
      return;
    }

    const nextAttempt = previousAttempts + 1;
    this.consumeRetryAttempts.set(producerId, nextAttempt);
    const delayMs = Math.min(CONSUME_RETRY_BASE_DELAY_MS * (2 ** (nextAttempt - 1)), 3_000);
    const timer = setTimeout(() => {
      this.consumeRetryTimers.delete(producerId);
      if (this.disposed || !this.isSessionActive()) {
        return;
      }
      const recvTransport = this.transportManager.getRecvTransport();
      const device = this.transportManager.getDevice();
      if (!recvTransport || !device) {
        this.scheduleConsumeRetry(producerPayload, "consume-retry-missing-transport");
        return;
      }

      void this.callGraphLock
        .runExclusive(async () => {
          await this.consumerManager.consumeProducer(producerPayload, recvTransport, device);
        })
        .then(() => {
          this.debugLog("consume_retry_succeeded", {
            producerId,
            attempts: nextAttempt,
            reason,
          });
          this.clearConsumeRetryForProducer(producerId);
        })
        .catch((error) => {
          if (this.isProducerConsumeRaceError(error)) {
            this.debugLog("consume_retry_race", {
              producerId,
              attempts: nextAttempt,
              reason,
              message: error instanceof Error ? error.message : String(error ?? ""),
            });
            this.scheduleConsumeRetry(producerPayload, "consume-retry-race");
            return;
          }
          if (this.isRecoverableCallError(error)) {
            this.debugLog("consume_retry_recoverable_error", {
              producerId,
              attempts: nextAttempt,
              reason,
              message: error instanceof Error ? error.message : String(error ?? ""),
            });
            this.scheduleConsumeRetry(producerPayload, "consume-retry-recoverable");
            return;
          }
          this.clearConsumeRetryForProducer(producerId);
          this.emitError(error);
        });
    }, delayMs);

    this.consumeRetryTimers.set(producerId, timer);
  }

  private clearConsumeRetryForProducer(producerIdRaw: string | null | undefined): void {
    const producerId = toId(producerIdRaw);
    if (!producerId) {
      return;
    }
    const timer = this.consumeRetryTimers.get(producerId);
    if (timer) {
      clearTimeout(timer);
    }
    this.consumeRetryTimers.delete(producerId);
    this.consumeRetryAttempts.delete(producerId);
  }

  private clearConsumeRetries(): void {
    for (const timer of this.consumeRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.consumeRetryTimers.clear();
    this.consumeRetryAttempts.clear();
  }

  private scheduleRemoteAudioWatchdog(): void {
    if (this.remoteAudioWatchdog) {
      clearTimeout(this.remoteAudioWatchdog);
    }
    // Se não recebermos áudio remoto em alguns segundos, registrar diagnóstico para depurar chamadas mudas.
    this.remoteAudioWatchdog = setTimeout(() => {
      const session = this.sessionManager.getSession();
      const remoteStream = session?.transport === "p2p"
        ? (this.p2pRemoteStream ? new MediaStream(this.p2pRemoteStream.getTracks()) : null)
        : this.consumerManager.getRemoteStream();
      const audioTracks = remoteStream?.getAudioTracks() ?? [];
      const audioConsumers = session?.transport === "p2p" ? audioTracks.length : this.consumerManager.getAudioConsumerCount();
      const hasLiveAudioTrack = audioTracks.some((track) => track.readyState === "live");
      this.debugLog("voice_audio_receive_status", {
        audioConsumers,
        hasLiveAudioTrack,
        lifecycle: this.sessionManager.getLifecycle(),
      });
    }, 10_000);
  }

  private requireSession(): VoiceSession {
    const session = this.sessionManager.getSession();
    if (!session) {
      throw new Error("Sessao de chamada indisponivel.");
    }
    return session;
  }

  private isSessionActive(): boolean {
    if (this.disposed) {
      return false;
    }
    const session = this.sessionManager.getSession();
    if (!session) {
      return false;
    }
    return this.sessionManager.canMutateCallGraph();
  }

  private rejectPendingReply(error: Error): void {
    if (!this.pendingReply) {
      return;
    }
    const pending = this.pendingReply;
    this.pendingReply = null;
    pending.reject(error);
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.socket) {
      return;
    }
    const currentSocket = this.socket;
    this.manualCloseSockets.add(currentSocket);
    try {
      currentSocket.close(code, reason);
    } catch {
      // Best effort.
    }
    if (this.socket === currentSocket) {
      this.socket = null;
    }
    this.stopHeartbeat();
  }

  private emitError(error: unknown): void {
    const casted = error instanceof Error ? error : new Error(String(error ?? "Falha na chamada."));
    this.options.onError?.(casted);
  }

  /**
   * Ensures the server knows whether our microphone is muted by pausing/resuming the audio producer.
   * This helps remote peers display mute state correctly and prevents "muted but still sending RTP" scenarios.
   */
  private async syncAudioProducerPauseState(scope: string): Promise<void> {
    if (!this.isSessionActive()) {
      return;
    }
    const producerId = this.producerManager.getAudioProducerId();
    if (!producerId) {
      this.audioProducerPaused = null;
      return;
    }

    const shouldPause = !this.mediaManager.isMicEnabled();
    if (this.audioProducerPaused === shouldPause) {
      return;
    }

    this.producerManager.setAudioPaused(shouldPause, scope);

    const op = shouldPause ? "PRODUCER_PAUSE" : "PRODUCER_RESUME";
    const expectedOp = shouldPause ? "PRODUCER_PAUSED" : "PRODUCER_RESUMED";
    try {
      await this.request(op, { producerId }, expectedOp);
      this.audioProducerPaused = shouldPause;
    } catch (error) {
      // If the socket is in a bad state, reconnect and let syncProducers restore state.
      if (this.isRecoverableCallError(error)) {
        this.requestReconnect("audio-producer-pause-sync-failed");
        return;
      }
      throw error;
    }
  }

  private disposeP2pPeer(reason: string, options?: { preserveQueuedRemoteIce?: boolean }): void {
    const preserveQueuedRemoteIce = options?.preserveQueuedRemoteIce === true;
    const peer = this.p2pPeer;
    this.p2pPeer = null;
    this.p2pAudioTransceiver = null;
    this.p2pVideoTransceiver = null;
    this.p2pRemoteStream = null;
    this.p2pPendingLocalIce.length = 0;
    if (!preserveQueuedRemoteIce) {
      this.p2pPendingRemoteIce.length = 0;
    }
    this.p2pMakingOffer = false;
    this.p2pIgnoreOffer = false;

    // Clear UI stream when rebuilding peers.
    this.publishP2pRemoteStream();

    if (!peer) {
      return;
    }

    try {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.onsignalingstatechange = null;
      peer.onicegatheringstatechange = null;
    } catch {
      // Best effort.
    }

    try {
      peer.close();
    } catch {
      // Best effort.
    }

    this.debugLog("p2p_peer_closed", { reason });
  }

  private publishP2pRemoteStream(): void {
    if (this.disposed) {
      return;
    }
    const stream = this.p2pRemoteStream ? new MediaStream(this.p2pRemoteStream.getTracks()) : null;
    this.options.onRemoteStream?.(stream);
  }

  private async ensureP2pPeer(scope: string): Promise<void> {
    const session = this.sessionManager.getSession();
    if (!session || session.transport !== "p2p" || this.disposed) {
      return;
    }

    const existing = this.p2pPeer;
    if (existing && existing.connectionState !== "closed") {
      return;
    }

    // Reset any previous peer state before creating a new one.
    // Preserve queued remote ICE when we haven't created a peer yet (candidates may arrive before the offer).
    this.disposeP2pPeer("rebuild", { preserveQueuedRemoteIce: !existing });

    const peer = new RTCPeerConnection({
      iceServers: this.p2pIceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    this.p2pPeer = peer;
    this.p2pRemoteStream = new MediaStream();
    this.p2pPolite = session.role === "callee";

    // Keep m-line order stable by creating transceivers once. We'll replaceTrack later when local media changes.
    try {
      this.p2pAudioTransceiver = peer.addTransceiver("audio", { direction: "sendrecv" });
      if (session.mode === "video") {
        this.p2pVideoTransceiver = peer.addTransceiver("video", { direction: "sendrecv" });
      } else {
        this.p2pVideoTransceiver = null;
      }
    } catch {
      // Some runtimes may not support addTransceiver; we'll fall back to addTrack in syncP2pTracksUnsafe.
      this.p2pAudioTransceiver = null;
      this.p2pVideoTransceiver = null;
    }

    peer.ontrack = (event) => {
      const track = event.track;
      if (!track || this.disposed) {
        return;
      }
      if (!this.p2pRemoteStream) {
        this.p2pRemoteStream = new MediaStream();
      }
      const already = this.p2pRemoteStream.getTracks().some((existingTrack) => existingTrack.id === track.id);
      if (!already) {
        this.p2pRemoteStream.addTrack(track);
        this.debugLog("p2p_track_added", {
          kind: track.kind,
          id: track.id,
        });
        this.publishP2pRemoteStream();
      }

      track.onended = () => {
        if (!this.p2pRemoteStream) {
          return;
        }
        try {
          this.p2pRemoteStream.removeTrack(track);
        } catch {
          // ignore
        }
        if (this.p2pRemoteStream.getTracks().length === 0) {
          this.p2pRemoteStream = null;
        }
        this.debugLog("p2p_track_ended", {
          kind: track.kind,
          id: track.id,
        });
        this.publishP2pRemoteStream();
      };
    };

    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate || this.disposed) {
        return;
      }

      const current = this.sessionManager.getSession();
      if (!current) {
        return;
      }

      const payload = {
        v: SIGNAL_VERSION,
        transport: "p2p",
        callId: current.callId,
        roomId: current.roomId,
        conversationId: current.conversationId,
        candidate: candidate.toJSON ? candidate.toJSON() : { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex },
      };
      void Promise.resolve(this.options.onSignal({ type: "ice", payload })).catch(() => {
        // Best effort; keep gathering.
      });
    };

    peer.onconnectionstatechange = () => {
      this.handleP2pConnectionStateChange(`p2p:${scope}`);
    };
    peer.oniceconnectionstatechange = () => {
      this.handleP2pConnectionStateChange(`p2p-ice:${scope}`);
    };

    this.debugLog("p2p_peer_created", {
      scope,
      polite: this.p2pPolite,
      iceServers: this.p2pIceServers.length,
    });
  }

  private handleP2pConnectionStateChange(scope: string): void {
    const peer = this.p2pPeer;
    if (!peer || this.disposed || this.sessionManager.isDestroyed()) {
      return;
    }

    const state = peer.connectionState;
    this.debugLog("p2p_connection_state", { scope, state });

    if (state === "connected") {
      this.sessionManager.transition("connected", "p2p-connected");
      return;
    }

    if (state === "connecting") {
      const lifecycle = this.sessionManager.getLifecycle();
      if (lifecycle === "idle" || lifecycle === "connected") {
        this.sessionManager.transition("connecting", "p2p-connecting");
      }
      return;
    }

    if (state === "failed" || state === "disconnected") {
      this.requestReconnect(`p2p-${state}`);
    }
  }

  private async syncP2pTracks(scope: string): Promise<void> {
    if (!this.isSessionActive()) {
      return;
    }
    await this.callGraphLock.runExclusive(async () => {
      await this.syncP2pTracksUnsafe(scope);
    });
  }

  private async syncP2pTracksUnsafe(scope: string): Promise<void> {
    const session = this.sessionManager.getSession();
    const peer = this.p2pPeer;
    if (!session || session.transport !== "p2p" || !peer || peer.connectionState === "closed" || this.disposed) {
      return;
    }

    let audioTrack = this.mediaManager.getAudioTrack();
    if (!audioTrack) {
      await this.mediaManager.ensureLocalTracks();
      audioTrack = this.mediaManager.getAudioTrack();
    }

    const videoTrack = this.mediaManager.getPreferredVideoTrack();

    const replace = async (transceiver: RTCRtpTransceiver | null, track: MediaStreamTrack | null): Promise<void> => {
      if (transceiver && transceiver.sender) {
        await transceiver.sender.replaceTrack(track).catch(() => undefined);
      }
    };

    if (this.p2pAudioTransceiver) {
      await replace(this.p2pAudioTransceiver, audioTrack);
    } else if (audioTrack) {
      // Fallback for runtimes without transceivers.
      peer.addTrack(audioTrack);
    }

    if (session.mode === "video") {
      if (this.p2pVideoTransceiver) {
        await replace(this.p2pVideoTransceiver, videoTrack);
      } else if (videoTrack) {
        peer.addTrack(videoTrack);
      }
    }

    this.debugLog("p2p_tracks_synced", {
      scope,
      hasAudio: Boolean(audioTrack),
      hasVideo: Boolean(videoTrack),
    });
  }

  private async flushP2pRemoteIceCandidates(scope: string): Promise<void> {
    const peer = this.p2pPeer;
    if (!peer || this.disposed) {
      return;
    }
    if (!peer.remoteDescription) {
      return;
    }

    const pending = this.p2pPendingRemoteIce.splice(0, this.p2pPendingRemoteIce.length);
    if (pending.length === 0) {
      return;
    }

    for (const candidate of pending) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error) {
        this.debugLog("p2p_add_ice_failed", {
          scope,
          message: describeWebRtcError(error),
        });
      }
    }
  }

  private async createP2pOffer(input: { iceRestart: boolean; reason: string }): Promise<void> {
    const session = this.sessionManager.getSession();
    const peer = this.p2pPeer;
    if (!session || session.transport !== "p2p" || !peer || this.disposed) {
      return;
    }

    try {
      this.p2pMakingOffer = true;
      const offer = await peer.createOffer({ iceRestart: input.iceRestart });
      await peer.setLocalDescription(offer);
    } catch (error) {
      throw new Error(`Falha ao criar oferta P2P (${input.reason}). ${describeWebRtcError(error)}`);
    } finally {
      this.p2pMakingOffer = false;
    }

    const sdp = String(peer.localDescription?.sdp ?? "").trim();
    if (!sdp) {
      throw new Error("Falha ao gerar oferta P2P.");
    }

    this.sessionManager.mutateSession((current) => ({
      ...current,
      offerSdp: sdp,
    }));

    this.debugLog("p2p_offer_created", {
      reason: input.reason,
      iceRestart: input.iceRestart,
    });
  }

  private async acceptP2pOffer(offerSdp: string, scope: string): Promise<boolean> {
    const session = this.sessionManager.getSession();
    const peer = this.p2pPeer;
    if (!session || session.transport !== "p2p" || !peer || this.disposed) {
      return false;
    }

    const offer: RTCSessionDescriptionInit = { type: "offer", sdp: offerSdp };
    const offerCollision = this.p2pMakingOffer || peer.signalingState !== "stable";
    this.p2pIgnoreOffer = !this.p2pPolite && offerCollision;
    if (this.p2pIgnoreOffer) {
      this.debugLog("p2p_offer_ignored", { scope, reason: "collision" });
      return false;
    }

    try {
      await peer.setRemoteDescription(offer);
      await this.flushP2pRemoteIceCandidates(scope);
    } catch (error) {
      throw new Error(`Falha ao aplicar oferta P2P (${scope}). ${describeWebRtcError(error)}`);
    }

    try {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    } catch (error) {
      throw new Error(`Falha ao criar resposta P2P (${scope}). ${describeWebRtcError(error)}`);
    }

    const answerSdp = String(peer.localDescription?.sdp ?? "").trim();
    if (!answerSdp) {
      throw new Error("Falha ao gerar resposta P2P.");
    }

    this.sessionManager.mutateSession((current) => ({
      ...current,
      answerSdp,
    }));

    this.debugLog("p2p_answer_created", { scope });
    return true;
  }

  private async acceptP2pAnswer(answerSdp: string, scope: string): Promise<void> {
    const session = this.sessionManager.getSession();
    const peer = this.p2pPeer;
    if (!session || session.transport !== "p2p" || !peer || this.disposed) {
      return;
    }

    try {
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await this.flushP2pRemoteIceCandidates(scope);
      this.debugLog("p2p_answer_applied", { scope });
    } catch (error) {
      throw new Error(`Falha ao aplicar resposta P2P (${scope}). ${describeWebRtcError(error)}`);
    }
  }

  private async addP2pRemoteIceCandidate(payload: Record<string, unknown>, scope: string): Promise<void> {
    const session = this.sessionManager.getSession();
    const peer = this.p2pPeer;
    if ((session && session.transport !== "p2p") || this.disposed) {
      return;
    }

    const candidateRaw = payload.candidate;
    const candidateRecord = toRecord(candidateRaw);
    const candidateString = typeof candidateRaw === "string"
      ? candidateRaw
      : toId(candidateRecord.candidate);
    if (!candidateString) {
      return;
    }

    const init: RTCIceCandidateInit = {
      candidate: candidateString,
      sdpMid: typeof candidateRecord.sdpMid === "string" ? candidateRecord.sdpMid : undefined,
      sdpMLineIndex: typeof candidateRecord.sdpMLineIndex === "number" ? candidateRecord.sdpMLineIndex : undefined,
    };

    if (!peer || !peer.remoteDescription) {
      this.p2pPendingRemoteIce.push(init);
      this.debugLog("p2p_ice_queued", { scope, count: this.p2pPendingRemoteIce.length });
      return;
    }

    try {
      await peer.addIceCandidate(init);
    } catch (error) {
      this.debugLog("p2p_add_ice_failed", {
        scope,
        message: describeWebRtcError(error),
      });
    }
  }

  private startHeartbeat(intervalMsRaw: number): void {
    const intervalMs = Math.max(5_000, Math.min(30_000, Math.floor(Number(intervalMsRaw) || 15_000)));
    this.heartbeatIntervalMs = intervalMs;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    // Send a ping immediately and then at the configured interval.
    this.sendPing();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingPingStartedAtMs = null;
  }

  private sendPing(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // Only allow one in-flight ping at a time so we can calculate RTT without a nonce.
    if (this.pendingPingStartedAtMs != null) {
      return;
    }
    this.pendingPingStartedAtMs = performance.now();
    try {
      socket.send(JSON.stringify({ op: "PING", d: { clientTime: new Date().toISOString() } }));
    } catch {
      this.pendingPingStartedAtMs = null;
    }
  }

  private handlePong(): void {
    if (this.pendingPingStartedAtMs == null) {
      return;
    }
    const rttMs = Math.max(0, performance.now() - this.pendingPingStartedAtMs);
    this.pendingPingStartedAtMs = null;
    // Do not smooth here; smoothing is done in getVoiceDiagnostics to keep one source of truth.
    this.lastSignalPingMs = rttMs;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Chamada encerrada.");
    }
  }

  private isProducerConsumeRaceError(error: unknown): boolean {
    const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
    return (
      message.includes("producer cannot be consumed by this peer")
      || message.includes("producer owner not found")
      || message.includes("producer not found")
    );
  }

  private isRecoverableCallError(error: unknown): boolean {
    const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
    return (
      message.includes("queue stopped")
      || message.includes("track ended")
      || message.includes("invalidstateerror")
      || message.includes("socket de voz fechado")
      || message.includes("resposta de voz pendente")
      || message.includes("tempo limite aguardando")
      || message.includes("conexao de voz encerrada antes de abrir")
      || message.includes("producer cannot be consumed by this peer")
      || message.includes("producer owner not found")
      || message.includes("producer not found")
      || message.includes("transport not found")
      || message.includes("m= line") // SDP m-line mismatch; force reconnect
    );
  }
}
