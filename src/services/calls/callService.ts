import type { CallMode, CallSignalType } from "./callApi";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import {
  createRtcRuntimeConfig,
  getIceCandidateKind,
  getSelectedCandidatePairSummary,
  sanitizeIceServersForLogs,
  type RtcRuntimeConfig,
} from "./rtcConfig";

export interface CallServiceSignal {
  type: CallSignalType;
  payload: Record<string, unknown>;
}

export interface CallVoiceDiagnostics {
  averagePingMs: number | null;
  lastPingMs: number | null;
  packetLossPercent: number | null;
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
}

export interface CallServiceOptions {
  mode: CallMode;
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

interface SessionDescriptionPayload {
  type: "offer" | "answer";
  sdp: string;
}

interface IceCandidatePayload {
  candidate: RTCIceCandidateInit;
}

const DEFAULT_SCREEN_SHARE_QUALITY = "1080p60";
const DEFAULT_CALL_AUDIO_SETTINGS: Readonly<{
  inputDeviceId: string;
  inputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  vadEnabled: boolean;
  voiceFocus: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
  qosHighPriority: boolean;
  pushToTalkEnabled: boolean;
}> = {
  inputDeviceId: "",
  inputVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  vadEnabled: true,
  voiceFocus: false,
  autoSensitivity: true,
  sensitivityDb: -55,
  qosHighPriority: false,
  pushToTalkEnabled: false,
};

interface NormalizedCallAudioSettings {
  inputDeviceId: string;
  inputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  vadEnabled: boolean;
  voiceFocus: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
  qosHighPriority: boolean;
  pushToTalkEnabled: boolean;
}

type AudioContextConstructor = typeof AudioContext;
const RNNOISE_MAX_CHANNELS = 1;
let rnnoiseWasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeInputVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CALL_AUDIO_SETTINGS.inputVolume;
  }
  return clampNumber(Math.round(value), 0, 100);
}

function normalizeSensitivityDb(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CALL_AUDIO_SETTINGS.sensitivityDb;
  }
  return clampNumber(Math.round(value), -100, 0);
}

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const webkitAudioContext = (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return window.AudioContext ?? webkitAudioContext ?? null;
}

async function loadRnnoiseWasmBinary(): Promise<ArrayBuffer> {
  if (!rnnoiseWasmBinaryPromise) {
    rnnoiseWasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    }).catch((error) => {
      rnnoiseWasmBinaryPromise = null;
      throw error;
    });
  }
  return rnnoiseWasmBinaryPromise;
}

function normalizeCallAudioSettings(raw: CallAudioSettings | null | undefined): NormalizedCallAudioSettings {
  const source = raw ?? {};
  return {
    inputDeviceId:
      typeof source.inputDeviceId === "string"
        ? source.inputDeviceId.trim()
        : DEFAULT_CALL_AUDIO_SETTINGS.inputDeviceId,
    inputVolume: normalizeInputVolume(source.inputVolume),
    noiseSuppression: normalizeBoolean(source.noiseSuppression, DEFAULT_CALL_AUDIO_SETTINGS.noiseSuppression),
    echoCancellation: normalizeBoolean(source.echoCancellation, DEFAULT_CALL_AUDIO_SETTINGS.echoCancellation),
    autoGainControl: normalizeBoolean(source.autoGainControl, DEFAULT_CALL_AUDIO_SETTINGS.autoGainControl),
    vadEnabled: normalizeBoolean(source.vadEnabled, DEFAULT_CALL_AUDIO_SETTINGS.vadEnabled),
    voiceFocus: normalizeBoolean(source.voiceFocus, DEFAULT_CALL_AUDIO_SETTINGS.voiceFocus),
    autoSensitivity: normalizeBoolean(source.autoSensitivity, DEFAULT_CALL_AUDIO_SETTINGS.autoSensitivity),
    sensitivityDb: normalizeSensitivityDb(source.sensitivityDb),
    qosHighPriority: normalizeBoolean(source.qosHighPriority, DEFAULT_CALL_AUDIO_SETTINGS.qosHighPriority),
    pushToTalkEnabled: normalizeBoolean(source.pushToTalkEnabled, DEFAULT_CALL_AUDIO_SETTINGS.pushToTalkEnabled),
  };
}

export async function applyQoS(
  peerConnection: RTCPeerConnection | null | undefined,
  enabled: boolean,
): Promise<void> {
  if (!peerConnection) {
    return;
  }

  const targetPriority: RTCPriorityType = enabled ? "high" : "medium";
  const audioSenders = peerConnection.getSenders().filter((sender) => sender.track?.kind === "audio");
  if (audioSenders.length === 0) {
    console.info(`[call-qos] Nenhum sender de audio disponivel para aplicar prioridade "${targetPriority}".`);
    return;
  }

  await Promise.all(
    audioSenders.map(async (sender, index) => {
      if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") {
        console.warn("[call-qos] Navegador sem suporte para setParameters em sender de audio.");
        return;
      }

      try {
        const parameters = sender.getParameters();
        const encodings = Array.isArray(parameters.encodings) ? [...parameters.encodings] : [{}];
        if (encodings.length === 0) {
          encodings.push({});
        }

        // Ajusta prioridade do primeiro encoding de audio.
        const nextEncoding = { ...(encodings[0] ?? {}), priority: targetPriority };
        encodings[0] = nextEncoding;

        await sender.setParameters({
          ...parameters,
          encodings,
        });
        console.info(`[call-qos] Sender de audio #${index + 1} atualizado para prioridade "${targetPriority}".`);
      } catch (error) {
        console.warn(
          `[call-qos] Falha ao aplicar prioridade "${targetPriority}" em sender de audio #${index + 1}.`,
          error,
        );
      }
    }),
  );
}

function resolveVadThreshold(autoSensitivity: boolean, sensitivityDb: number): number {
  if (autoSensitivity) {
    return 0.055;
  }
  const normalizedDb = clampNumber(sensitivityDb, -100, 0);
  return 0.02 + ((normalizedDb + 100) / 100) * 0.18;
}

function parseScreenShareQuality(raw: string | null | undefined): {
  width: number;
  height: number;
  frameRate: number;
} {
  const normalized = String(raw ?? "").trim().toLowerCase();
  switch (normalized) {
    case "480p30":
      return { width: 854, height: 480, frameRate: 30 };
    case "720p60":
      return { width: 1280, height: 720, frameRate: 60 };
    case "1080p30":
      return { width: 1920, height: 1080, frameRate: 30 };
    case "1080p60":
      return { width: 1920, height: 1080, frameRate: 60 };
    case "1440p30":
      return { width: 2560, height: 1440, frameRate: 30 };
    case "1440p60":
      return { width: 2560, height: 1440, frameRate: 60 };
    case "2160p30":
      return { width: 3840, height: 2160, frameRate: 30 };
    case "2160p60":
      return { width: 3840, height: 2160, frameRate: 60 };
    case "720p30":
    default:
      return { width: 1280, height: 720, frameRate: 30 };
  }
}

function extractSdpString(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const nested = (raw as Record<string, unknown>).sdp;
    if (typeof nested === "string") {
      return nested;
    }
  }
  return String(raw ?? "");
}

function normalizeSdp(raw: unknown): string {
  let value = extractSdpString(raw);
  if (!value) {
    return "";
  }

  const trimmedRaw = value.trim();
  if (trimmedRaw.startsWith("\"") && trimmedRaw.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmedRaw);
      if (typeof parsed === "string") {
        value = parsed;
      }
    } catch {
      // ignore
    }
  }

  if (!/[\r\n]/.test(value) && /\\[rn]/.test(value)) {
    value = value
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n");
  }

  value = value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = value
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line, index, array) => !(index === 0 && !line.trim() && array.length > 1));

  const normalized = lines.join("\r\n").trim();
  if (!normalized) {
    return "";
  }
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function stripLegacySsrcLines(sdp: string): string {
  const lines = sdp
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => {
      const normalized = line.trimStart().toLowerCase();
      return !normalized.startsWith("a=ssrc:") && !normalized.startsWith("a=ssrc-group:");
    });
  const rebuilt = lines.join("\r\n").trim();
  return rebuilt ? `${rebuilt}\r\n` : "";
}

function toSessionDescriptionPayload(raw: Record<string, unknown>, expectedType: "offer" | "answer"): SessionDescriptionPayload {
  const type = String(raw.type ?? "").trim().toLowerCase();
  const sdp = normalizeSdp(raw.sdp);
  if (type !== expectedType || !sdp) {
    throw new Error(`Invalid ${expectedType} payload.`);
  }
  if (!sdp.includes("v=0")) {
    throw new Error(`Invalid ${expectedType} payload.`);
  }
  return {
    type: expectedType,
    sdp,
  };
}

function toIceCandidatePayload(raw: Record<string, unknown>): IceCandidatePayload {
  const candidateRaw = raw.candidate;
  if (!candidateRaw || typeof candidateRaw !== "object" || Array.isArray(candidateRaw)) {
    throw new Error("Invalid ICE payload.");
  }

  return {
    candidate: candidateRaw as RTCIceCandidateInit,
  };
}

export function canSelectDesktopScreenShareSource(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI?.getScreenShareSources);
}

export async function listDesktopScreenShareSources(): Promise<CallScreenShareSource[]> {
  if (typeof window === "undefined") {
    return [];
  }
  const electronSourceApi = window.electronAPI?.getScreenShareSources;
  if (!electronSourceApi) {
    return [];
  }

  const sources = await electronSourceApi({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources
    .map((source) => ({
      id: String(source.id ?? "").trim(),
      name: String(source.name ?? "").trim() || "Tela",
      thumbnail: source.thumbnail ?? null,
      appIcon: source.appIcon ?? null,
    }))
    .filter((source) => {
      const id = source.id.toLowerCase();
      const name = source.name.toLowerCase();
      if (!id || !name) {
        return Boolean(source.id);
      }
      if (id.startsWith("window:") && (name === "messly" || name.includes("messly call"))) {
        return false;
      }
      return true;
    })
    .filter((source) => Boolean(source.id));
}

async function getScreenShareStream(options?: StartScreenShareOptions): Promise<MediaStream> {
  const quality = parseScreenShareQuality(options?.quality ?? DEFAULT_SCREEN_SHARE_QUALITY);
  const requestedSourceId = String(options?.sourceId ?? "").trim();
  const electronSourceApi = window.electronAPI?.getScreenShareSources;

  if (electronSourceApi) {
    try {
      let sourceId = requestedSourceId;
      if (!sourceId) {
        const sources = await listDesktopScreenShareSources();
        sourceId =
          sources.find((source) => source.id.startsWith("screen:"))?.id ??
          sources[0]?.id ??
          "";
      }

      if (sourceId) {
        const desktopVideoConstraints = {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxWidth: quality.width,
            maxHeight: quality.height,
            maxFrameRate: quality.frameRate,
          },
        } as unknown as MediaTrackConstraints;

        return await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: desktopVideoConstraints,
        });
      }
    } catch {
      // fallback to browser picker
    }
  }

  const displayVideoConstraints: MediaTrackConstraints = {
    width: { ideal: quality.width, max: quality.width },
    height: { ideal: quality.height, max: quality.height },
    frameRate: { ideal: quality.frameRate, max: quality.frameRate },
  };

  return navigator.mediaDevices.getDisplayMedia({
    video: displayVideoConstraints,
    audio: false,
  });
}

export class CallService {
  private readonly options: CallServiceOptions;
  private readonly rtcRuntimeConfig: RtcRuntimeConfig;
  private readonly audioSettings: NormalizedCallAudioSettings;
  private qosHighPriorityEnabled = false;
  private peerConnection: RTCPeerConnection | null = null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private localStream: MediaStream | null = null;
  private rawLocalStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private processedAudioContext: AudioContext | null = null;
  private processedAudioVadAnalyser: AnalyserNode | null = null;
  private processedAudioVadFrame: Float32Array | null = null;
  private processedAudioVadAnimationFrameId: number | null = null;
  private processedAudioRnnoiseNode: RnnoiseWorkletNode | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private relayFallbackActivated = false;
  private selectedCandidatePairLogged = false;
  private iceGatheringTimeoutId: number | null = null;
  private connectionTimeoutId: number | null = null;
  private micManuallyEnabled = true;
  private pushToTalkPressed = false;
  private disposed = false;

  constructor(options: CallServiceOptions) {
    this.options = options;
    this.rtcRuntimeConfig = createRtcRuntimeConfig();
    this.audioSettings = normalizeCallAudioSettings(options.audioSettings);
    this.qosHighPriorityEnabled = this.audioSettings.qosHighPriority;
    this.logRtc("runtime-config", {
      iceTransportPolicy: this.rtcRuntimeConfig.peerConnectionConfig.iceTransportPolicy ?? "all",
      bundlePolicy: this.rtcRuntimeConfig.peerConnectionConfig.bundlePolicy ?? "balanced",
      rtcpMuxPolicy: (this.rtcRuntimeConfig.peerConnectionConfig as RTCConfiguration & { rtcpMuxPolicy?: string }).rtcpMuxPolicy ?? "require",
      relayFallbackEnabled: this.rtcRuntimeConfig.relayFallbackEnabled,
      forceRelay: this.rtcRuntimeConfig.forceRelay,
      iceCandidatePoolSize: this.rtcRuntimeConfig.peerConnectionConfig.iceCandidatePoolSize ?? 0,
      iceGatheringTimeoutMs: this.rtcRuntimeConfig.iceGatheringTimeoutMs,
      connectionTimeoutMs: this.rtcRuntimeConfig.connectionTimeoutMs,
      iceServers: sanitizeIceServersForLogs(this.rtcRuntimeConfig.peerConnectionConfig.iceServers ?? []),
    }, true);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getConnectionState(): RTCPeerConnectionState | null {
    return this.peerConnection?.connectionState ?? null;
  }

  isScreenSharing(): boolean {
    return Boolean(this.screenTrack && this.screenTrack.readyState === "live");
  }

  async getVoiceDiagnostics(): Promise<CallVoiceDiagnostics | null> {
    const pc = this.peerConnection;
    if (!pc) {
      return null;
    }

    const pingSamples: number[] = [];
    let lastPingMs: number | null = null;
    let packetsSentTotal = 0;
    let packetsLostTotal = 0;

    const report = await pc.getStats();
    report.forEach((entry) => {
      const stat = entry as RTCStats & {
        type?: string;
        kind?: string;
        mediaType?: string;
        currentRoundTripTime?: number;
        roundTripTime?: number;
        state?: string;
        selected?: boolean;
        nominated?: boolean;
        packetsSent?: number;
        packetsLost?: number;
      };

      const type = String(stat.type ?? "");

      if (type === "candidate-pair") {
        const isSelected = Boolean(stat.selected) || String(stat.state ?? "").toLowerCase() === "succeeded";
        if (!isSelected) {
          return;
        }
        if (typeof stat.currentRoundTripTime === "number" && Number.isFinite(stat.currentRoundTripTime)) {
          const pingMs = Math.max(0, stat.currentRoundTripTime * 1000);
          pingSamples.push(pingMs);
          lastPingMs = pingMs;
          return;
        }
        if (typeof stat.roundTripTime === "number" && Number.isFinite(stat.roundTripTime)) {
          const pingMs = Math.max(0, stat.roundTripTime * 1000);
          pingSamples.push(pingMs);
          lastPingMs = pingMs;
          return;
        }
        return;
      }

      const mediaKind = String(stat.kind ?? stat.mediaType ?? "").toLowerCase();
      if (mediaKind !== "audio") {
        return;
      }

      if (type === "outbound-rtp" && typeof stat.packetsSent === "number" && Number.isFinite(stat.packetsSent)) {
        packetsSentTotal += Math.max(0, stat.packetsSent);
      }

      if ((type === "remote-inbound-rtp" || type === "inbound-rtp") && typeof stat.packetsLost === "number" && Number.isFinite(stat.packetsLost)) {
        packetsLostTotal += Math.max(0, stat.packetsLost);
      }
    });

    const averagePingMs = pingSamples.length > 0
      ? pingSamples.reduce((total, value) => total + value, 0) / pingSamples.length
      : lastPingMs;

    const denominator = packetsSentTotal + packetsLostTotal;
    const packetLossPercent = denominator > 0
      ? (packetsLostTotal / denominator) * 100
      : null;

    return {
      averagePingMs: averagePingMs ?? null,
      lastPingMs,
      packetLossPercent,
      updatedAt: new Date().toISOString(),
    };
  }

  async startAsCaller(): Promise<Record<string, unknown>> {
    const pc = await this.ensurePeerConnection();
    await this.ensureLocalMedia();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return {
      type: "offer",
      sdp: offer.sdp ?? "",
    };
  }

  async startAsCallee(): Promise<void> {
    await this.ensurePeerConnection();
    await this.ensureLocalMedia();
  }

  async handleSignal(signal: CallServiceSignal): Promise<CallServiceSignal | null> {
    if (this.disposed) {
      return null;
    }

    try {
      if (signal.type === "offer") {
        const payload = toSessionDescriptionPayload(signal.payload, "offer");
        const answerPayload = await this.acceptOffer(payload);
        return {
          type: "answer",
          payload: answerPayload,
        };
      }

      if (signal.type === "answer") {
        const payload = toSessionDescriptionPayload(signal.payload, "answer");
        await this.applyAnswer(payload);
        return null;
      }

      if (signal.type === "ice") {
        const payload = toIceCandidatePayload(signal.payload);
        await this.applyIceCandidate(payload.candidate);
        return null;
      }

      return null;
    } catch (error) {
      this.emitError(error);
      throw error;
    }
  }

  toggleMute(): boolean {
    this.micManuallyEnabled = !this.micManuallyEnabled;
    this.syncOutgoingAudioTrackState();
    return this.micManuallyEnabled;
  }

  toggleCamera(): boolean {
    const videoTrack = this.getCurrentVideoTrack();
    if (!videoTrack) {
      return false;
    }
    videoTrack.enabled = !videoTrack.enabled;
    return videoTrack.enabled;
  }

  async setQoSEnabled(enabled: boolean): Promise<void> {
    const nextEnabled = Boolean(enabled);
    this.audioSettings.qosHighPriority = nextEnabled;
    if (this.qosHighPriorityEnabled === nextEnabled) {
      return;
    }
    this.qosHighPriorityEnabled = nextEnabled;

    if (!this.peerConnection) {
      return;
    }

    await applyQoS(this.peerConnection, this.qosHighPriorityEnabled);
  }

  setPushToTalkEnabled(enabled: boolean): void {
    this.audioSettings.pushToTalkEnabled = Boolean(enabled);
    if (!this.audioSettings.pushToTalkEnabled) {
      this.pushToTalkPressed = false;
    }
    this.syncOutgoingAudioTrackState();
  }

  setPushToTalkPressed(pressed: boolean): void {
    this.pushToTalkPressed = Boolean(pressed);
    this.syncOutgoingAudioTrackState();
  }

  async updateAudioSettings(nextSettings: CallAudioSettings | null | undefined): Promise<void> {
    const next = normalizeCallAudioSettings(nextSettings);
    const previous = { ...this.audioSettings };

    Object.assign(this.audioSettings, next);

    const qosChanged = previous.qosHighPriority !== next.qosHighPriority;
    const pushToTalkChanged = previous.pushToTalkEnabled !== next.pushToTalkEnabled;
    const captureChanged =
      previous.inputDeviceId !== next.inputDeviceId ||
      previous.noiseSuppression !== next.noiseSuppression ||
      previous.echoCancellation !== next.echoCancellation ||
      previous.autoGainControl !== next.autoGainControl;
    const processingChanged =
      previous.inputVolume !== next.inputVolume ||
      previous.vadEnabled !== next.vadEnabled ||
      previous.voiceFocus !== next.voiceFocus ||
      previous.autoSensitivity !== next.autoSensitivity ||
      previous.sensitivityDb !== next.sensitivityDb;

    if (pushToTalkChanged && !next.pushToTalkEnabled) {
      this.pushToTalkPressed = false;
    }
    this.syncOutgoingAudioTrackState();

    if (qosChanged) {
      await this.setQoSEnabled(next.qosHighPriority);
    }

    if (!this.localStream || !this.peerConnection || (!captureChanged && !processingChanged)) {
      return;
    }

    await this.rebuildLocalAudioTrack(captureChanged);
  }

  async startScreenShare(options?: StartScreenShareOptions): Promise<boolean> {
    const pc = await this.ensurePeerConnection();
    const videoSender = this.getVideoSender(pc);

    const displayStream = await getScreenShareStream(options);

    const nextScreenTrack = displayStream.getVideoTracks()[0] ?? null;
    if (!nextScreenTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      return false;
    }

    this.screenTrack = nextScreenTrack;
    this.screenTrack.onended = () => {
      void this.stopScreenShare();
    };

    await videoSender.replaceTrack(nextScreenTrack);
    this.publishLocalPreview();
    return true;
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenTrack) {
      return;
    }

    const previousScreenTrack = this.screenTrack;
    this.screenTrack = null;
    previousScreenTrack.onended = null;

    const cameraTrack = this.cameraTrack;
    const pc = this.peerConnection;
    if (pc) {
      const sender = this.getVideoSender(pc);
      await sender.replaceTrack(cameraTrack ?? null);
    }

    previousScreenTrack.stop();
    this.publishLocalPreview();
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    try {
      await this.stopScreenShare();
    } catch {
      // ignore
    }

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onicecandidateerror = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.onicegatheringstatechange = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    const currentLocalStream = this.localStream;
    if (currentLocalStream) {
      currentLocalStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
      this.options.onLocalStream?.(null);
    }

    if (this.rawLocalStream && this.rawLocalStream !== currentLocalStream) {
      this.rawLocalStream.getTracks().forEach((track) => track.stop());
    }
    this.rawLocalStream = null;

    this.stopProcessedAudioVadLoop();
    if (this.processedAudioRnnoiseNode) {
      this.processedAudioRnnoiseNode.destroy();
      this.processedAudioRnnoiseNode = null;
    }
    if (this.processedAudioVadAnalyser) {
      this.processedAudioVadAnalyser.disconnect();
      this.processedAudioVadAnalyser = null;
    }
    this.processedAudioVadFrame = null;

    if (this.processedAudioContext) {
      const currentAudioContext = this.processedAudioContext;
      this.processedAudioContext = null;
      void currentAudioContext.close().catch(() => {
        // ignore
      });
    }

    this.remoteStream = null;
    this.options.onRemoteStream?.(null);
    this.pendingRemoteCandidates = [];
    this.relayFallbackActivated = false;
    this.selectedCandidatePairLogged = false;
    this.clearRtcTimers();
    this.audioSender = null;
    this.cameraTrack = null;
    this.videoSender = null;
  }

  private async acceptOffer(offer: SessionDescriptionPayload): Promise<Record<string, unknown>> {
    const pc = await this.ensurePeerConnection();
    await this.ensureLocalMedia();
    await this.setRemoteDescriptionSafe(pc, offer);
    await this.flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return {
      type: "answer",
      sdp: answer.sdp ?? "",
    };
  }

  private async applyAnswer(answer: SessionDescriptionPayload): Promise<void> {
    const pc = await this.ensurePeerConnection();
    const normalizedAnswerSdp = normalizeSdp(answer.sdp);
    if (!normalizedAnswerSdp) {
      return;
    }

    const answerDescription: SessionDescriptionPayload = {
      type: "answer",
      sdp: normalizedAnswerSdp,
    };

    // Ignore late/duplicated answers when negotiation already completed.
    if (pc.signalingState !== "have-local-offer") {
      if (pc.signalingState === "stable") {
        const currentRemoteSdp = normalizeSdp(pc.currentRemoteDescription?.sdp ?? "");
        if (currentRemoteSdp && currentRemoteSdp === normalizedAnswerSdp) {
          return;
        }
        // A stale answer can arrive after a newer offer/answer completed.
        return;
      }
      return;
    }

    try {
      await this.setRemoteDescriptionSafe(pc, answerDescription);
    } catch (error) {
      const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
      const calledInWrongState = message.includes("called in wrong state");
      const signalingState = String(pc.signalingState ?? "").toLowerCase();
      if (calledInWrongState && signalingState === "stable") {
        const currentRemoteSdp = normalizeSdp(pc.currentRemoteDescription?.sdp ?? "");
        if (!currentRemoteSdp || currentRemoteSdp === normalizedAnswerSdp) {
          return;
        }
      }
      throw error;
    }
    await this.flushPendingCandidates();
  }

  private async setRemoteDescriptionSafe(
    pc: RTCPeerConnection,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const normalizedDescription: RTCSessionDescriptionInit = {
      type: description.type,
      sdp: normalizeSdp(description.sdp ?? ""),
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(normalizedDescription));
      return;
    } catch (primaryError) {
      const fallbackSdp = stripLegacySsrcLines(normalizedDescription.sdp ?? "");
      if (!fallbackSdp || fallbackSdp === normalizedDescription.sdp) {
        throw primaryError;
      }

      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription({
            type: normalizedDescription.type,
            sdp: fallbackSdp,
          }),
        );
      } catch {
        throw primaryError;
      }
    }
  }

  private async applyIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = await this.ensurePeerConnection();
    const candidateType = getIceCandidateKind(candidate);
    this.logRtc("remote-ice-candidate-received", {
      type: candidateType,
      hasCandidateLine: Boolean(candidate?.candidate),
    }, true);
    if (!pc.remoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.peerConnection;
    if (!pc || !pc.remoteDescription || this.pendingRemoteCandidates.length === 0) {
      return;
    }

    const pending = [...this.pendingRemoteCandidates];
    this.pendingRemoteCandidates = [];
    for (const candidate of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private async ensurePeerConnection(): Promise<RTCPeerConnection> {
    if (this.peerConnection) {
      return this.peerConnection;
    }

    const initialRtcConfiguration = { ...this.rtcRuntimeConfig.peerConnectionConfig };
    const pc = new RTCPeerConnection(initialRtcConfiguration);
    this.startRtcTimers(pc);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.toJSON();
      if (!candidate) {
        this.logRtc("local-ice-gathering-complete", {
          iceGatheringState: pc.iceGatheringState,
        }, true);
        return;
      }
      this.logRtc("local-ice-candidate-generated", {
        type: getIceCandidateKind(candidate),
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      }, true);
      void this.options.onSignal({
        type: "ice",
        payload: {
          candidate,
        },
      });
    };

    pc.onicecandidateerror = (event) => {
      const candidateError = event as Event & {
        errorCode?: number;
        errorText?: string;
        hostCandidate?: string;
        url?: string;
      };
      this.logRtc("local-ice-candidate-error", {
        errorCode: candidateError.errorCode ?? null,
        errorText: candidateError.errorText ?? null,
        hostCandidate: candidateError.hostCandidate ?? null,
        url: candidateError.url ?? null,
      }, true, "warn");
    };

    pc.onicegatheringstatechange = () => {
      this.logRtc("ice-gathering-state", {
        state: pc.iceGatheringState,
      }, true);
      if (pc.iceGatheringState === "complete") {
        this.clearIceGatheringTimeout();
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.logRtc("ice-connection-state", {
        state: pc.iceConnectionState,
      }, false);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.clearConnectionTimeout();
        void this.logSelectedCandidatePair(pc, "ice-connected");
      }
      if (pc.iceConnectionState === "failed") {
        void this.activateRelayFallback(pc, "ice-connection-failed");
      }
    };

    pc.ontrack = (event) => {
      const incomingTrack = event.track;
      if (!incomingTrack) {
        return;
      }

      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }

      const alreadyAttached = this.remoteStream
        .getTracks()
        .some((track) => track.id === incomingTrack.id);
      if (!alreadyAttached) {
        this.remoteStream.addTrack(incomingTrack);
      }

      incomingTrack.onended = () => {
        if (!this.remoteStream) {
          return;
        }

        this.remoteStream.removeTrack(incomingTrack);
        this.options.onRemoteStream?.(this.remoteStream);
      };

      this.options.onRemoteStream?.(this.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      this.logRtc("peer-connection-state", {
        state: pc.connectionState,
      }, false);
      if (pc.connectionState === "connected") {
        this.clearConnectionTimeout();
        void this.logSelectedCandidatePair(pc, "connection-connected");
      }
      if (pc.connectionState === "failed") {
        void this.activateRelayFallback(pc, "peer-connection-failed");
      }
      this.options.onConnectionStateChange?.(pc.connectionState);
    };

    this.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
    this.peerConnection = pc;
    return pc;
  }

  private async ensureLocalMedia(): Promise<void> {
    if (this.localStream) {
      return;
    }

    const wantsVideo = this.options.mode === "video";
    const capturedMedia = await this.requestLocalMediaWithFallback(wantsVideo);
    this.rawLocalStream = capturedMedia;

    const outboundStream = await this.buildOutboundLocalStream(capturedMedia);
    this.localStream = outboundStream;
    this.cameraTrack = capturedMedia.getVideoTracks()[0] ?? null;

    const pc = await this.ensurePeerConnection();
    for (const track of outboundStream.getAudioTracks()) {
      this.audioSender = pc.addTrack(track, outboundStream);
    }
    const sender = this.getVideoSender(pc);
    await sender.replaceTrack(this.cameraTrack ?? null);
    await applyQoS(pc, this.qosHighPriorityEnabled);
    this.syncOutgoingAudioTrackState();

    this.publishLocalPreview();
  }

  private getCameraConstraints(): MediaTrackConstraints {
    return {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    };
  }

  private buildAudioConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      noiseSuppression: this.audioSettings.noiseSuppression,
      echoCancellation: this.audioSettings.echoCancellation,
      autoGainControl: this.audioSettings.autoGainControl,
    };

    if (this.audioSettings.inputDeviceId) {
      constraints.deviceId = { exact: this.audioSettings.inputDeviceId };
    }

    if (this.audioSettings.voiceFocus) {
      constraints.channelCount = { ideal: 1 };
      constraints.sampleRate = { ideal: 48_000 };
    }

    return constraints;
  }

  private async requestLocalMediaWithFallback(wantsVideo: boolean): Promise<MediaStream> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Captura de audio indisponivel neste ambiente.");
    }

    const videoConstraints: MediaTrackConstraints | false = wantsVideo ? this.getCameraConstraints() : false;
    const preferredAudioConstraints = this.buildAudioConstraints();
    const audioConstraintsWithoutDevice: MediaTrackConstraints = { ...preferredAudioConstraints };
    delete audioConstraintsWithoutDevice.deviceId;

    const audioAttemptQueue: Array<MediaTrackConstraints | true> = [preferredAudioConstraints];
    if (preferredAudioConstraints.deviceId) {
      audioAttemptQueue.push(audioConstraintsWithoutDevice);
    }
    audioAttemptQueue.push(true);

    let lastError: unknown = null;
    for (const audioConstraints of audioAttemptQueue) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: videoConstraints,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Nao foi possivel capturar audio local.");
  }

  private async rebuildLocalAudioTrack(shouldRecaptureInput: boolean): Promise<void> {
    const currentLocalStream = this.localStream;
    if (!currentLocalStream) {
      return;
    }

    let currentRawAudioTrack = this.rawLocalStream?.getAudioTracks()[0] ?? null;
    let replacementAudioStream: MediaStream | null = null;

    if (shouldRecaptureInput || !currentRawAudioTrack || currentRawAudioTrack.readyState !== "live") {
      replacementAudioStream = await this.requestLocalMediaWithFallback(false);
      currentRawAudioTrack = replacementAudioStream.getAudioTracks()[0] ?? null;
    }

    const nextOutboundAudioTrack = currentRawAudioTrack
      ? await this.buildOutboundAudioTrack(new MediaStream([currentRawAudioTrack]))
      : null;
    const previousOutboundTracks = currentLocalStream.getAudioTracks();

    for (const track of previousOutboundTracks) {
      currentLocalStream.removeTrack(track);
    }
    if (nextOutboundAudioTrack) {
      currentLocalStream.addTrack(nextOutboundAudioTrack);
    }

    const pc = this.peerConnection;
    if (pc) {
      const audioSender = this.getAudioSender(pc);
      if (audioSender) {
        await audioSender.replaceTrack(nextOutboundAudioTrack ?? null);
      } else if (nextOutboundAudioTrack) {
        this.audioSender = pc.addTrack(nextOutboundAudioTrack, currentLocalStream);
      }
    }

    if (shouldRecaptureInput) {
      const currentRawStream = this.rawLocalStream;
      const previousRawAudioTracks = currentRawStream?.getAudioTracks() ?? [];
      if (currentRawStream) {
        for (const track of previousRawAudioTracks) {
          currentRawStream.removeTrack(track);
        }
        if (currentRawAudioTrack) {
          currentRawStream.addTrack(currentRawAudioTrack);
        }
      } else if (replacementAudioStream) {
        this.rawLocalStream = replacementAudioStream;
      }

      for (const track of previousRawAudioTracks) {
        if (track !== currentRawAudioTrack) {
          track.stop();
        }
      }
    }

    for (const track of previousOutboundTracks) {
      if (track !== nextOutboundAudioTrack) {
        track.stop();
      }
    }

    this.syncOutgoingAudioTrackState();
    this.publishLocalPreview();
  }

  private async buildOutboundLocalStream(capturedMedia: MediaStream): Promise<MediaStream> {
    const outboundStream = new MediaStream();
    const outboundAudioTrack = await this.buildOutboundAudioTrack(capturedMedia);
    if (outboundAudioTrack) {
      outboundStream.addTrack(outboundAudioTrack);
    }

    const outboundCameraTrack = capturedMedia.getVideoTracks()[0] ?? null;
    if (outboundCameraTrack) {
      outboundStream.addTrack(outboundCameraTrack);
    }

    return outboundStream;
  }

  private shouldBuildProcessedAudioTrack(): boolean {
    const hasManualInputGain = Math.abs(this.audioSettings.inputVolume - 100) >= 1;
    return (
      hasManualInputGain ||
      this.audioSettings.voiceFocus ||
      this.audioSettings.vadEnabled ||
      this.audioSettings.noiseSuppression
    );
  }

  private async buildOutboundAudioTrack(capturedMedia: MediaStream): Promise<MediaStreamTrack | null> {
    const rawAudioTrack = capturedMedia.getAudioTracks()[0] ?? null;
    if (!rawAudioTrack) {
      return null;
    }

    if (!this.shouldBuildProcessedAudioTrack()) {
      return rawAudioTrack;
    }

    const AudioContextCtor = resolveAudioContextConstructor();
    if (!AudioContextCtor) {
      return rawAudioTrack;
    }

    this.stopProcessedAudioVadLoop();
    this.processedAudioVadAnalyser = null;
    this.processedAudioVadFrame = null;
    if (this.processedAudioContext) {
      const currentAudioContext = this.processedAudioContext;
      this.processedAudioContext = null;
      void currentAudioContext.close().catch(() => {
        // ignore
      });
    }

    try {
      const audioContext = new AudioContextCtor();
      this.processedAudioContext = audioContext;
      this.processedAudioRnnoiseNode = null;

      const inputStream = new MediaStream([rawAudioTrack]);
      const sourceNode = audioContext.createMediaStreamSource(inputStream);
      let processingNode: AudioNode = sourceNode;

      if (this.audioSettings.noiseSuppression) {
        try {
          const rnnoiseWasmBinary = await loadRnnoiseWasmBinary();
          await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);
          const rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
            maxChannels: RNNOISE_MAX_CHANNELS,
            wasmBinary: rnnoiseWasmBinary,
          });
          this.processedAudioRnnoiseNode = rnnoiseNode;
          processingNode.connect(rnnoiseNode);
          processingNode = rnnoiseNode;
        } catch {
          this.processedAudioRnnoiseNode = null;
        }
      }

      const inputGainScale = clampNumber(this.audioSettings.inputVolume, 0, 100) / 100;
      if (Math.abs(inputGainScale - 1) >= 0.001) {
        const inputGainNode = audioContext.createGain();
        inputGainNode.gain.value = inputGainScale;
        processingNode.connect(inputGainNode);
        processingNode = inputGainNode;
      }

      if (this.audioSettings.voiceFocus) {
        const highPassNode = audioContext.createBiquadFilter();
        highPassNode.type = "highpass";
        highPassNode.frequency.value = 140;
        highPassNode.Q.value = 0.707;
        processingNode.connect(highPassNode);
        processingNode = highPassNode;

        const compressorNode = audioContext.createDynamicsCompressor();
        compressorNode.threshold.value = -24;
        compressorNode.knee.value = 24;
        compressorNode.ratio.value = 8;
        compressorNode.attack.value = 0.003;
        compressorNode.release.value = 0.25;
        processingNode.connect(compressorNode);
        processingNode = compressorNode;
      }

      const gateGainNode = audioContext.createGain();
      gateGainNode.gain.value = 1;
      processingNode.connect(gateGainNode);
      processingNode = gateGainNode;

      if (this.audioSettings.vadEnabled) {
        const vadAnalyser = audioContext.createAnalyser();
        vadAnalyser.fftSize = 2048;
        vadAnalyser.smoothingTimeConstant = 0.82;
        sourceNode.connect(vadAnalyser);
        this.processedAudioVadAnalyser = vadAnalyser;
        this.processedAudioVadFrame = new Float32Array(
          new ArrayBuffer(vadAnalyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
        );
        this.startProcessedAudioVadLoop(gateGainNode);
      }

      const outputDestination = audioContext.createMediaStreamDestination();
      processingNode.connect(outputDestination);
      await audioContext.resume().catch(() => {
        // ignore
      });
      if (audioContext.state !== "running") {
        throw new Error("AudioContext not running.");
      }

      const processedAudioTrack = outputDestination.stream.getAudioTracks()[0] ?? null;
      if (!processedAudioTrack) {
        return rawAudioTrack;
      }
      return processedAudioTrack;
    } catch {
      this.stopProcessedAudioVadLoop();
      this.processedAudioVadAnalyser = null;
      this.processedAudioVadFrame = null;
      if (this.processedAudioRnnoiseNode) {
        this.processedAudioRnnoiseNode.destroy();
        this.processedAudioRnnoiseNode = null;
      }
      if (this.processedAudioContext) {
        const currentAudioContext = this.processedAudioContext;
        this.processedAudioContext = null;
        void currentAudioContext.close().catch(() => {
          // ignore
        });
      }
      return rawAudioTrack;
    }
  }

  private startProcessedAudioVadLoop(gateGainNode: GainNode): void {
    if (typeof window === "undefined" || !this.processedAudioContext || !this.processedAudioVadAnalyser || !this.processedAudioVadFrame) {
      return;
    }

    this.stopProcessedAudioVadLoop();
    const currentAudioContext = this.processedAudioContext;
    const vadAnalyser = this.processedAudioVadAnalyser;
    const vadFrame = this.processedAudioVadFrame;
    const vadThreshold = resolveVadThreshold(this.audioSettings.autoSensitivity, this.audioSettings.sensitivityDb);

    const loop = (): void => {
      if (this.disposed || !this.processedAudioContext || !this.processedAudioVadAnalyser || !this.processedAudioVadFrame) {
        return;
      }

      vadAnalyser.getFloatTimeDomainData(vadFrame as unknown as Float32Array<ArrayBuffer>);
      let squaredSum = 0;
      for (let index = 0; index < vadFrame.length; index += 1) {
        const sample = vadFrame[index] ?? 0;
        squaredSum += sample * sample;
      }
      const rms = Math.sqrt(squaredSum / vadFrame.length);
      const speaking = rms >= vadThreshold;

      gateGainNode.gain.cancelScheduledValues(currentAudioContext.currentTime);
      gateGainNode.gain.setTargetAtTime(
        speaking ? 1 : 0.03,
        currentAudioContext.currentTime,
        speaking ? 0.015 : 0.12,
      );
      this.processedAudioVadAnimationFrameId = window.requestAnimationFrame(loop);
    };

    this.processedAudioVadAnimationFrameId = window.requestAnimationFrame(loop);
  }

  private stopProcessedAudioVadLoop(): void {
    if (typeof window === "undefined" || this.processedAudioVadAnimationFrameId == null) {
      this.processedAudioVadAnimationFrameId = null;
      return;
    }

    window.cancelAnimationFrame(this.processedAudioVadAnimationFrameId);
    this.processedAudioVadAnimationFrameId = null;
  }

  private publishLocalPreview(): void {
    if (!this.localStream) {
      this.options.onLocalStream?.(null);
      return;
    }

    const stream = new MediaStream();
    const audioTrack = this.localStream.getAudioTracks()[0] ?? null;
    const videoTrack = this.getCurrentVideoTrack();
    if (audioTrack) {
      stream.addTrack(audioTrack);
    }
    if (videoTrack) {
      stream.addTrack(videoTrack);
    }
    this.options.onLocalStream?.(stream);
  }

  private getDesiredOutgoingAudioEnabled(): boolean {
    if (!this.micManuallyEnabled) {
      return false;
    }
    if (!this.audioSettings.pushToTalkEnabled) {
      return true;
    }
    return this.pushToTalkPressed;
  }

  private syncOutgoingAudioTrackState(): void {
    const audioTrack = this.localStream?.getAudioTracks()[0] ?? null;
    if (!audioTrack) {
      return;
    }
    audioTrack.enabled = this.getDesiredOutgoingAudioEnabled();
  }

  private getCurrentVideoTrack(): MediaStreamTrack | null {
    if (this.screenTrack) {
      return this.screenTrack;
    }
    return this.cameraTrack;
  }

  private getVideoSender(pc: RTCPeerConnection): RTCRtpSender {
    if (this.videoSender) {
      return this.videoSender;
    }

    const existing = pc.getSenders().find((sender) => sender.track?.kind === "video");
    if (existing) {
      this.videoSender = existing;
      return existing;
    }

    this.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
    return this.videoSender;
  }

  private getAudioSender(pc: RTCPeerConnection): RTCRtpSender | null {
    if (this.audioSender) {
      return this.audioSender;
    }

    const existing = pc.getSenders().find((sender) => sender.track?.kind === "audio") ?? null;
    if (existing) {
      this.audioSender = existing;
    }
    return existing;
  }

  private startRtcTimers(pc: RTCPeerConnection): void {
    this.clearRtcTimers();
    if (typeof window === "undefined") {
      return;
    }

    this.iceGatheringTimeoutId = window.setTimeout(() => {
      if (this.disposed || this.peerConnection !== pc) {
        return;
      }
      if (pc.iceGatheringState === "complete") {
        return;
      }
      this.logRtc(
        "ice-gathering-timeout",
        {
          state: pc.iceGatheringState,
          timeoutMs: this.rtcRuntimeConfig.iceGatheringTimeoutMs,
        },
        false,
        "warn",
      );
    }, this.rtcRuntimeConfig.iceGatheringTimeoutMs);

    this.connectionTimeoutId = window.setTimeout(() => {
      if (this.disposed || this.peerConnection !== pc) {
        return;
      }
      const state = pc.connectionState;
      if (state === "connected" || state === "closed") {
        return;
      }
      this.logRtc(
        "connection-timeout",
        {
          state,
          timeoutMs: this.rtcRuntimeConfig.connectionTimeoutMs,
        },
        false,
        "warn",
      );
      void this.activateRelayFallback(pc, "connection-timeout");
    }, this.rtcRuntimeConfig.connectionTimeoutMs);
  }

  private clearIceGatheringTimeout(): void {
    if (typeof window === "undefined" || this.iceGatheringTimeoutId == null) {
      this.iceGatheringTimeoutId = null;
      return;
    }
    window.clearTimeout(this.iceGatheringTimeoutId);
    this.iceGatheringTimeoutId = null;
  }

  private clearConnectionTimeout(): void {
    if (typeof window === "undefined" || this.connectionTimeoutId == null) {
      this.connectionTimeoutId = null;
      return;
    }
    window.clearTimeout(this.connectionTimeoutId);
    this.connectionTimeoutId = null;
  }

  private clearRtcTimers(): void {
    this.clearIceGatheringTimeout();
    this.clearConnectionTimeout();
  }

  private async activateRelayFallback(pc: RTCPeerConnection, reason: string): Promise<void> {
    if (!this.rtcRuntimeConfig.relayFallbackEnabled) {
      return;
    }
    if (this.rtcRuntimeConfig.forceRelay) {
      return;
    }
    if (this.relayFallbackActivated) {
      return;
    }
    if (pc.signalingState === "closed") {
      return;
    }

    this.relayFallbackActivated = true;
    this.logRtc("relay-fallback-activating", {
      reason,
      signalingState: pc.signalingState,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
    }, true);

    try {
      pc.setConfiguration({
        ...this.rtcRuntimeConfig.peerConnectionConfig,
        iceTransportPolicy: "relay",
      });
    } catch (error) {
      this.logRtc("relay-fallback-set-configuration-failed", {
        reason,
        message: this.getErrorMessage(error),
      }, true, "warn");
      this.relayFallbackActivated = false;
      return;
    }

    if (pc.signalingState !== "stable") {
      this.logRtc("relay-fallback-awaiting-stable-signaling", {
        reason,
        signalingState: pc.signalingState,
      }, true);
      this.relayFallbackActivated = false;
      return;
    }

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await this.options.onSignal({
        type: "offer",
        payload: {
          type: "offer",
          sdp: offer.sdp ?? "",
        },
      });
      this.logRtc("relay-fallback-offer-sent", {
        reason,
      }, true);
    } catch (error) {
      this.logRtc("relay-fallback-offer-failed", {
        reason,
        message: this.getErrorMessage(error),
      }, true, "warn");
      this.relayFallbackActivated = false;
    }
  }

  private async logSelectedCandidatePair(pc: RTCPeerConnection, source: string): Promise<void> {
    if (this.selectedCandidatePairLogged) {
      return;
    }

    try {
      const summary = await getSelectedCandidatePairSummary(pc);
      if (!summary) {
        return;
      }
      this.selectedCandidatePairLogged = true;
      this.logRtc("selected-candidate-pair", {
        source,
        localCandidateType: summary.localCandidateType,
        remoteCandidateType: summary.remoteCandidateType,
        state: summary.state,
        nominated: summary.nominated,
        currentRoundTripTimeMs: summary.currentRoundTripTimeMs,
        usesRelay: summary.usesRelay,
      }, false);
    } catch (error) {
      this.logRtc("selected-candidate-pair-failed", {
        source,
        message: this.getErrorMessage(error),
      }, true, "warn");
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error ?? "unknown");
  }

  private logRtc(
    event: string,
    details: Record<string, unknown>,
    verboseOnly: boolean,
    level: "debug" | "info" | "warn" = "info",
  ): void {
    if (verboseOnly && !this.rtcRuntimeConfig.verboseLogging) {
      return;
    }
    const prefix = `[call-rtc] ${event}`;
    if (level === "warn") {
      console.warn(prefix, details);
      return;
    }
    if (level === "debug") {
      console.debug(prefix, details);
      return;
    }
    console.info(prefix, details);
  }

  private emitError(raw: unknown): void {
    const error = raw instanceof Error ? raw : new Error(String(raw ?? "Unknown WebRTC error"));
    this.options.onError?.(error);
  }
}
