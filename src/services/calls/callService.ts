
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
import type { CallDebugLogger, NormalizedAudioSettings, VoiceSession } from "./voice/types";
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
  const transport = String(payload.transport ?? "").trim().toLowerCase();
  if (version !== SIGNAL_VERSION || transport !== "mediasoup") {
    return null;
  }
  const callId = toId(payload.callId);
  const roomId = toId(payload.roomId);
  const conversationId = toId(payload.conversationId);
  const mode = String(payload.mode ?? "").trim().toLowerCase() === "video" ? "video" : "audio";
  if (!callId || !roomId || !conversationId) {
    return null;
  }
  return {
    callId,
    roomId,
    conversationId,
    mode,
    role: "callee",
    resumeToken: null,
  };
}

function buildOffer(session: VoiceSession): Record<string, unknown> {
  return {
    v: SIGNAL_VERSION,
    transport: "mediasoup",
    callId: session.callId,
    roomId: session.roomId,
    conversationId: session.conversationId,
    mode: session.mode,
    createdAt: new Date().toISOString(),
  };
}

function buildAnswer(session: VoiceSession): Record<string, unknown> {
  return {
    v: SIGNAL_VERSION,
    transport: "mediasoup",
    callId: session.callId,
    roomId: session.roomId,
    conversationId: session.conversationId,
    acceptedAt: new Date().toISOString(),
  };
}

async function captureAudioTrack(settings: NormalizedAudioSettings): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      ...(settings.inputDeviceId ? { deviceId: { exact: settings.inputDeviceId } } : {}),
    },
    video: false,
  });
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

export class CallService {
  private readonly options: CallServiceOptions;
  private audioSettings: NormalizedAudioSettings;
  private voiceUrl: string | null;
  private socket: WebSocket | null = null;
  private readonly manualCloseSockets = new WeakSet<WebSocket>();
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
  private disposed = false;

  constructor(options: CallServiceOptions) {
    this.options = options;
    this.audioSettings = normalizeAudioSettings(options.audioSettings);
    this.voiceUrl = resolveVoiceUrl();

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
        void this.syncProducers("track-graph-changed").catch((error) => {
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
        void this.syncProducers("audio-track-recovered").catch((error) => {
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
        callId: createSessionId("voice"),
        roomId: createSessionId("room"),
        conversationId,
        mode: this.options.mode,
        role: "caller",
        resumeToken: null,
      };
      this.sessionManager.setSession(session);
    }

    this.debugLog("call_start", {
      role: "caller",
      callId: session.callId,
      conversationId: session.conversationId,
      mode: session.mode,
    });

    await this.mediaManager.ensureLocalTracks();
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
      await this.connectToVoice("call.handleSignal.offer");
      await this.syncProducers("call.handleSignal.offer");

      return {
        type: "answer",
        payload: buildAnswer(this.requireSession()),
      };
    }

    if (signal.type === "bye") {
      await this.close();
      return null;
    }

    return null;
  }

  toggleMute(): boolean {
    return this.mediaManager.toggleMute();
  }

  toggleCamera(): boolean {
    const nextEnabled = this.mediaManager.toggleCamera();
    void this.syncProducers("call.toggleCamera").catch((error) => {
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
    await this.syncProducers("call.updateAudioSettings");
  }

  async startScreenShare(options?: StartScreenShareOptions): Promise<boolean> {
    await this.mediaManager.startScreenShare(options);
    await this.syncProducers("call.startScreenShare");
    return true;
  }

  async stopScreenShare(): Promise<void> {
    await this.mediaManager.stopScreenShare();
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

    return {
      averagePingMs: null,
      lastPingMs: null,
      packetLossPercent: null,
      connectionType: null,
      localCandidateType: null,
      remoteCandidateType: null,
      usingRelay: null,
      outboundBitrateKbps: null,
      inboundBitrateKbps: null,
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
      this.closeSocket(1000, "CALL_CLOSE");
      this.rejectPendingReply(new Error("Socket de voz fechado."));
      this.consumerManager.clear("call.close");
      this.producerManager.closeAll("call.close");
      this.transportManager.destroy();
      this.mediaManager.dispose();
      this.sessionManager.setSession(null);
      this.sessionManager.transition("destroyed", "call.close");
      this.debugLog("call_ended", {
        reason: "manual-close",
      });
    });

    this.options.onLocalStream?.(null);
    this.options.onRemoteStream?.(null);
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

    this.consumerManager.clear("transport-rebuild");
    this.producerManager.closeAll("transport-rebuild");
    this.transportManager.closeTransports();

    await this.transportManager.setup(routerRtpCapabilities, sendTransport, recvTransport);

    const producerRows = Array.isArray(auth.producers) ? auth.producers : [];
    for (const row of producerRows) {
      await this.consumerManager.consumeProducer(
        toRecord(row),
        this.transportManager.getRecvTransport(),
        this.transportManager.getDevice(),
      );
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

    if (frame.op === "PRODUCER_ADDED") {
      void this.callGraphLock
        .runExclusive(async () => {
          await this.consumerManager.consumeProducer(
            toRecord(frame.d),
            this.transportManager.getRecvTransport(),
            this.transportManager.getDevice(),
          );
        })
        .catch((error) => {
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

        this.sessionManager.transition("reconnecting", "call.rejoinExisting");
        this.debugLog("reconnect_started", {
          callId: session.callId,
          conversationId: session.conversationId,
        });

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
  }

  private emitError(error: unknown): void {
    const casted = error instanceof Error ? error : new Error(String(error ?? "Falha na chamada."));
    this.options.onError?.(casted);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Chamada encerrada.");
    }
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
    );
  }
}
