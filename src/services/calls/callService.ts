import { authService } from "../auth";
import { getGatewayUrl } from "../../api/client";
import { Device } from "mediasoup-client";
import type {
  Consumer,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from "mediasoup-client/types";
import type { CallMode, CallSignalType } from "./callApi";

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

interface NormalizedAudioSettings {
  inputDeviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalkEnabled: boolean;
  qosHighPriority: boolean;
}

interface VoiceSession {
  callId: string;
  roomId: string;
  conversationId: string;
  mode: CallMode;
  role: "caller" | "callee";
  resumeToken: string | null;
}

interface VoiceFrame<T = unknown> {
  op: string;
  d: T;
}

const SIGNAL_VERSION = 2;
const DEFAULT_SCREEN_SHARE_QUALITY = "1080p60";
const VOICE_REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;
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

function resolveVoiceUrl(): string | null {
  const explicit = String(import.meta.env.VITE_MESSLY_VOICE_URL ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const gateway = String(getGatewayUrl() ?? "").trim();
  if (!gateway) {
    return null;
  }
  try {
    const parsed = new URL(gateway);
    parsed.pathname = "/voice";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
    },
  }).catch(() => null);
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

async function captureScreenTrack(options?: StartScreenShareOptions): Promise<MediaStreamTrack> {
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

export class CallService {
  private readonly options: CallServiceOptions;
  private audioSettings: NormalizedAudioSettings;
  private voiceUrl: string | null;
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private socket: WebSocket | null = null;
  private readonly manualCloseSockets = new WeakSet<WebSocket>();
  private pendingReply: { op: string; resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void } | null = null;
  private requestChain: Promise<void> = Promise.resolve();
  private session: VoiceSession | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private audioProducer: Producer | null = null;
  private videoProducer: Producer | null = null;
  private consumers = new Map<string, Consumer>();
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private micEnabled = true;
  private cameraEnabled = true;
  private pushToTalkPressed = false;
  private state: RTCPeerConnectionState = "new";
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectPromise: Promise<void> | null = null;

  constructor(options: CallServiceOptions) {
    this.options = options;
    this.audioSettings = normalizeAudioSettings(options.audioSettings);
    this.voiceUrl = resolveVoiceUrl();
    this.cameraEnabled = options.mode === "video";
  }

  getLocalStream(): MediaStream | null { return this.localStream; }
  getRemoteStream(): MediaStream | null { return this.remoteStream; }
  getConnectionState(): RTCPeerConnectionState | null { return this.state; }
  isScreenSharing(): boolean { return Boolean(this.screenTrack && this.screenTrack.readyState === "live"); }

  async startAsCaller(): Promise<Record<string, unknown>> {
    if (!this.session) {
      const conversationId = toId(this.options.conversationId);
      if (!conversationId) {
        throw new Error("conversationId ausente para chamada.");
      }
      this.session = {
        callId: createSessionId("voice"),
        roomId: createSessionId("room"),
        conversationId,
        mode: this.options.mode,
        role: "caller",
        resumeToken: null,
      };
    }
    await this.ensureLocalTracks();
    await this.connectToVoice(this.session);
    await this.syncProducers();
    return buildOffer(this.session);
  }

  async startAsCallee(): Promise<void> {
    await this.ensureLocalTracks();
  }

  async handleSignal(signal: CallServiceSignal): Promise<CallServiceSignal | null> {
    if (signal.type === "offer") {
      const offer = parseOffer(toRecord(signal.payload));
      if (!offer) {
        throw new Error("Oferta de chamada invalida.");
      }
      this.session = offer;
      await this.ensureLocalTracks();
      await this.connectToVoice(offer);
      await this.syncProducers();
      return { type: "answer", payload: buildAnswer(offer) };
    }
    if (signal.type === "bye") {
      await this.close();
    }
    return null;
  }

  toggleMute(): boolean {
    this.micEnabled = !this.micEnabled;
    this.syncAudioEnabled();
    return this.micEnabled;
  }

  toggleCamera(): boolean {
    this.cameraEnabled = !this.cameraEnabled;
    void this.syncVideoProducer().catch((error) => this.emitError(error));
    this.publishLocal();
    return this.cameraEnabled;
  }

  async setQoSEnabled(enabled: boolean): Promise<void> {
    this.audioSettings = { ...this.audioSettings, qosHighPriority: enabled };
  }

  setPushToTalkEnabled(enabled: boolean): void {
    this.audioSettings = { ...this.audioSettings, pushToTalkEnabled: enabled };
    this.syncAudioEnabled();
  }

  setPushToTalkPressed(pressed: boolean): void {
    this.pushToTalkPressed = pressed;
    this.syncAudioEnabled();
  }

  async updateAudioSettings(settings: CallAudioSettings | null | undefined): Promise<void> {
    this.audioSettings = normalizeAudioSettings(settings);
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.audioTrack = await captureAudioTrack(this.audioSettings);
    this.syncAudioEnabled();
    await this.syncAudioProducer();
    this.publishLocal();
  }

  async startScreenShare(options?: StartScreenShareOptions): Promise<boolean> {
    this.screenTrack = await captureScreenTrack(options);
    this.screenTrack.onended = () => { void this.stopScreenShare(); };
    await this.syncVideoProducer();
    this.publishLocal();
    return true;
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenTrack) {
      return;
    }
    this.screenTrack.stop();
    this.screenTrack = null;
    await this.syncVideoProducer();
    this.publishLocal();
  }

  async restartIce(_reason = "manual"): Promise<boolean> {
    if (!this.session) {
      return false;
    }
    await this.reconnect();
    return true;
  }

  async getVoiceDiagnostics(): Promise<CallVoiceDiagnostics | null> {
    const state = this.state;
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
      iceConnectionState: state === "connected" ? "connected" : state === "failed" ? "failed" : "checking",
      updatedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimer();
    this.closePeerState();
    this.closeSocket(1000, "CALL_CLOSE");
    this.session = null;
    this.state = "closed";
    this.options.onConnectionStateChange?.(this.state);
    this.options.onLocalStream?.(null);
    this.options.onRemoteStream?.(null);
  }

  private async ensureLocalTracks(): Promise<void> {
    if (!this.audioTrack || this.audioTrack.readyState !== "live") {
      this.audioTrack = await captureAudioTrack(this.audioSettings);
      this.syncAudioEnabled();
    }
    if (this.options.mode === "video" && (!this.cameraTrack || this.cameraTrack.readyState !== "live")) {
      this.cameraTrack = await captureCameraTrack();
    }
    this.publishLocal();
  }

  private syncAudioEnabled(): void {
    if (!this.audioTrack) {
      return;
    }
    const enabled = this.micEnabled && (!this.audioSettings.pushToTalkEnabled || this.pushToTalkPressed);
    this.audioTrack.enabled = enabled;
  }

  private publishLocal(): void {
    const stream = new MediaStream();
    if (this.audioTrack && this.audioTrack.readyState === "live") {
      stream.addTrack(this.audioTrack);
    }
    const videoTrack = this.screenTrack ?? (this.cameraEnabled ? this.cameraTrack : null);
    if (videoTrack && videoTrack.readyState === "live") {
      stream.addTrack(videoTrack);
    }
    this.localStream = stream.getTracks().length > 0 ? stream : null;
    this.options.onLocalStream?.(this.localStream ? new MediaStream(this.localStream.getTracks()) : null);
  }

  private publishRemote(): void {
    this.options.onRemoteStream?.(this.remoteStream ? new MediaStream(this.remoteStream.getTracks()) : null);
  }

  private async connectToVoice(session: VoiceSession): Promise<void> {
    await this.ensureSocket();
    const token = String(await authService.getValidatedEdgeAccessToken() ?? "").trim();
    if (!token) {
      throw new Error("Token de autenticacao ausente para voz.");
    }
    const auth = await this.request("AUTH", {
      token,
      callId: session.callId,
      roomId: session.roomId,
      conversationId: session.conversationId,
      mode: session.mode,
      role: session.role,
      resumeToken: session.resumeToken,
    }, "AUTH_OK");

    const call = toRecord(auth.call);
    const transports = toRecord(auth.transports);
    session.resumeToken = toId(auth.resumeToken) || null;
    session.callId = toId(call.callId) || session.callId;
    session.roomId = toId(call.roomId) || session.roomId;
    session.conversationId = toId(call.conversationId) || session.conversationId;

    const routerRtpCapabilities = transports.routerRtpCapabilities as RtpCapabilities | undefined;
    const sendTransport = toRecord(transports.sendTransport);
    const recvTransport = toRecord(transports.recvTransport);
    if (!routerRtpCapabilities || !sendTransport.id || !recvTransport.id) {
      throw new Error("AUTH_OK sem informacoes de transporte.");
    }
    await this.setupDeviceAndTransports(routerRtpCapabilities, sendTransport, recvTransport);

    const producerRows = Array.isArray(auth.producers) ? auth.producers : [];
    for (const row of producerRows) {
      await this.consumeProducer(toRecord(row)).catch(() => undefined);
    }
    this.setState("connecting");
  }

  private async setupDeviceAndTransports(
    routerRtpCapabilities: RtpCapabilities,
    sendTransport: Record<string, unknown>,
    recvTransport: Record<string, unknown>,
  ): Promise<void> {
    this.closePeerState({ preserveLocalTracks: true });
    if (!this.device) {
      this.device = await Device.factory();
    }
    if (!this.device.loaded) {
      await this.device.load({ routerRtpCapabilities });
    }

    this.sendTransport = this.device.createSendTransport({
      id: String(sendTransport.id),
      iceParameters: sendTransport.iceParameters as never,
      iceCandidates: sendTransport.iceCandidates as never,
      dtlsParameters: sendTransport.dtlsParameters as never,
      sctpParameters: sendTransport.sctpParameters as never,
    });
    this.recvTransport = this.device.createRecvTransport({
      id: String(recvTransport.id),
      iceParameters: recvTransport.iceParameters as never,
      iceCandidates: recvTransport.iceCandidates as never,
      dtlsParameters: recvTransport.dtlsParameters as never,
      sctpParameters: recvTransport.sctpParameters as never,
    });

    this.sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      void this.request("TRANSPORT_CONNECT", { transportId: this.sendTransport?.id, dtlsParameters }, "TRANSPORT_CONNECTED")
        .then(() => callback())
        .catch((error) => errback(error));
    });
    this.recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      void this.request("TRANSPORT_CONNECT", { transportId: this.recvTransport?.id, dtlsParameters }, "TRANSPORT_CONNECTED")
        .then(() => callback())
        .catch((error) => errback(error));
    });
    this.sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      void this.request("PRODUCE", {
        transportId: this.sendTransport?.id,
        kind,
        rtpParameters,
        appData,
      }, "PRODUCED")
        .then((payload) => {
          const id = toId(payload.producerId);
          if (!id) {
            throw new Error("PRODUCED sem id.");
          }
          callback({ id });
        })
        .catch((error) => errback(error));
    });

    this.sendTransport.on("connectionstatechange", (state) => {
      this.setState(state === "connected" ? "connected" : state === "failed" ? "failed" : "connecting");
      if (state === "failed") {
        void this.reconnect();
      }
    });
    this.recvTransport.on("connectionstatechange", (state) => {
      this.setState(state === "connected" ? "connected" : state === "failed" ? "failed" : "connecting");
      if (state === "failed") {
        void this.reconnect();
      }
    });
  }

  private async syncProducers(): Promise<void> {
    await this.syncAudioProducer();
    await this.syncVideoProducer();
  }

  private async syncAudioProducer(): Promise<void> {
    if (!this.sendTransport || !this.audioTrack) {
      return;
    }
    if (!this.audioProducer) {
      this.audioProducer = await this.sendTransport.produce({
        track: this.audioTrack,
        appData: { source: "microphone" },
      });
    } else if (this.audioProducer.track !== this.audioTrack) {
      await this.audioProducer.replaceTrack({ track: this.audioTrack });
    }
  }

  private async syncVideoProducer(): Promise<void> {
    if (!this.sendTransport) {
      return;
    }
    const track = this.screenTrack ?? (this.cameraEnabled ? this.cameraTrack : null);
    if (!track) {
      if (this.videoProducer) {
        this.videoProducer.close();
        this.videoProducer = null;
      }
      return;
    }
    if (!this.videoProducer) {
      this.videoProducer = await this.sendTransport.produce({
        track,
        appData: { source: this.screenTrack ? "screen" : "camera" },
        encodings: this.screenTrack
          ? [{ maxBitrate: 6_000_000 }]
          : [
              { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 150_000 },
              { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 500_000 },
              { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_800_000 },
            ],
      });
      return;
    }
    if (this.videoProducer.track !== track) {
      await this.videoProducer.replaceTrack({ track });
    }
  }

  private async consumeProducer(raw: Record<string, unknown>): Promise<void> {
    if (!this.recvTransport || !this.device) {
      return;
    }
    const producerId = toId(raw.producerId);
    const kind = String(raw.kind ?? "").trim().toLowerCase();
    if (!producerId || (kind !== "audio" && kind !== "video") || this.consumers.has(producerId)) {
      return;
    }
    const created = await this.request("CONSUME", {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.recvRtpCapabilities,
    }, "CONSUMER_CREATED");
    const consumerId = toId(created.id);
    const rtpParameters = created.rtpParameters as RtpParameters | undefined;
    if (!consumerId || !rtpParameters) {
      return;
    }
    const consumer = await this.recvTransport.consume({
      id: consumerId,
      producerId,
      kind,
      rtpParameters,
      appData: toRecord(created.appData),
    });
    this.consumers.set(producerId, consumer);
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    this.remoteStream.addTrack(consumer.track);
    this.publishRemote();
    await this.request("CONSUMER_RESUME", { consumerId }, "CONSUMER_RESUMED").catch(() => undefined);
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this.voiceUrl) {
      throw new Error("Servidor de voz nao configurado.");
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.voiceUrl as string);
      this.socket = socket;
      let opened = false;
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      socket.addEventListener("open", () => {
        opened = true;
        settle(() => resolve());
      }, { once: true });
      socket.addEventListener("error", () => {
        settle(() => reject(new Error("Falha ao conectar no servidor de voz.")));
      }, { once: true });
      socket.addEventListener("message", (event) => this.onSocketMessage(String(event.data ?? "")));
      socket.addEventListener("close", () => {
        const wasManual = this.manualCloseSockets.has(socket);
        this.manualCloseSockets.delete(socket);
        if (this.socket === socket) {
          this.socket = null;
        }
        this.rejectPendingReply(new Error("Socket de voz fechado."));
        if (!opened) {
          settle(() => reject(new Error("Conexao de voz encerrada antes de abrir.")));
          return;
        }
        if (!this.disposed) {
          this.setState("disconnected");
          if (!wasManual) {
            this.scheduleReconnect("socket_close");
          }
        }
      });
    });
  }

  private onSocketMessage(raw: string): void {
    let frame: VoiceFrame | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceFrame>;
      frame = { op: String(parsed.op ?? "").trim().toUpperCase(), d: parsed.d ?? {} };
    } catch {
      return;
    }
    if (!frame || !frame.op) {
      return;
    }
    this.reconnectAttempt = 0;
    if (this.pendingReply && this.pendingReply.op === frame.op) {
      const pending = this.pendingReply;
      this.pendingReply = null;
      pending.resolve(toRecord(frame.d));
      return;
    }
    if (frame.op === "PRODUCER_ADDED") {
      void this.consumeProducer(toRecord(frame.d));
      return;
    }
    if (frame.op === "PRODUCER_REMOVED") {
      const producerId = toId(toRecord(frame.d).producerId);
      const consumer = this.consumers.get(producerId);
      if (!consumer) {
        return;
      }
      this.consumers.delete(producerId);
      consumer.close();
      this.remoteStream?.removeTrack(consumer.track);
      this.publishRemote();
    }
  }

  private request(op: string, payload: Record<string, unknown>, expectedOp: string): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Socket de voz fechado.");
      }
      if (this.pendingReply) {
        throw new Error("Resposta de voz pendente.");
      }
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!this.pendingReply || this.pendingReply.op !== expectedOp) {
            return;
          }
          this.pendingReply = null;
          reject(new Error(`Tempo limite aguardando ${expectedOp}.`));
          this.scheduleReconnect("request_timeout");
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
          this.socket?.send(JSON.stringify({ op, d: payload }));
        } catch (error) {
          clearTimeout(timeout);
          this.pendingReply = null;
          reject(error instanceof Error ? error : new Error(String(error ?? "Falha ao enviar requisicao de voz.")));
        }
      });
    };
    const next = this.requestChain.then(run, run);
    this.requestChain = next.then(() => undefined).catch(() => undefined);
    return next;
  }

  private async reconnect(): Promise<void> {
    if (!this.session || this.disposed) {
      return;
    }
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }
    this.reconnectPromise = (async () => {
      this.clearReconnectTimer();
      this.closeSocket(1012, "RECONNECT");
      await this.ensureLocalTracks();
      await this.connectToVoice(this.session as VoiceSession);
      await this.syncProducers();
      this.reconnectAttempt = 0;
    })().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private setState(next: RTCPeerConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.options.onConnectionStateChange?.(next);
  }

  private closePeerState(options?: { preserveLocalTracks?: boolean }): void {
    const preserveLocalTracks = options?.preserveLocalTracks === true;
    this.audioProducer?.close();
    this.videoProducer?.close();
    this.audioProducer = null;
    this.videoProducer = null;
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.remoteStream = null;
    this.publishRemote();
    if (!preserveLocalTracks) {
      this.audioTrack?.stop();
      this.cameraTrack?.stop();
      this.screenTrack?.stop();
      this.audioTrack = null;
      this.cameraTrack = null;
      this.screenTrack = null;
      this.publishLocal();
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(_reason: string): void {
    if (this.disposed || !this.session || this.reconnectTimer || this.reconnectPromise) {
      return;
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * (2 ** Math.min(this.reconnectAttempt, 5)), RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect().catch((error) => {
        this.emitError(error);
        this.scheduleReconnect("retry");
      });
    }, delay);
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
      // ignore close errors
    }
    if (this.socket === currentSocket) {
      this.socket = null;
    }
    this.rejectPendingReply(new Error("Socket de voz fechado."));
  }

  private emitError(error: unknown): void {
    const casted = error instanceof Error ? error : new Error(String(error ?? "Falha na chamada."));
    this.options.onError?.(casted);
  }
}
