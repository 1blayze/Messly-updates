import type { CallMode, CallSignalType } from "./callApi";

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

export interface CallServiceOptions {
  mode: CallMode;
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

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
const DEFAULT_SCREEN_SHARE_QUALITY = "2160p60";

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

function parseIceServersFromEnv(): RTCIceServer[] {
  const raw = String(import.meta.env.VITE_WEBRTC_ICE_SERVERS_JSON ?? "").trim();
  if (!raw) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return DEFAULT_ICE_SERVERS;
    }

    const servers = parsed.filter((item) => item && typeof item === "object") as RTCIceServer[];
    return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
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
  private readonly iceServers: RTCIceServer[];
  private peerConnection: RTCPeerConnection | null = null;
  private videoSender: RTCRtpSender | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private disposed = false;

  constructor(options: CallServiceOptions) {
    this.options = options;
    this.iceServers = parseIceServersFromEnv();
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
    const audioTrack = this.localStream?.getAudioTracks()[0] ?? null;
    if (!audioTrack) {
      return false;
    }
    audioTrack.enabled = !audioTrack.enabled;
    return audioTrack.enabled;
  }

  toggleCamera(): boolean {
    const videoTrack = this.getCurrentVideoTrack();
    if (!videoTrack) {
      return false;
    }
    videoTrack.enabled = !videoTrack.enabled;
    return videoTrack.enabled;
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
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
      this.options.onLocalStream?.(null);
    }

    this.remoteStream = null;
    this.options.onRemoteStream?.(null);
    this.pendingRemoteCandidates = [];
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

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 8,
    });

    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.toJSON();
      if (!candidate) {
        return;
      }
      void this.options.onSignal({
        type: "ice",
        payload: {
          candidate,
        },
      });
    };

    pc.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      const [track] = event.streams[0]?.getTracks() ?? [];
      if (track) {
        this.remoteStream.addTrack(track);
      } else if (event.track) {
        this.remoteStream.addTrack(event.track);
      }
      this.options.onRemoteStream?.(this.remoteStream);
    };

    pc.onconnectionstatechange = () => {
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
    const media = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantsVideo
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          }
        : false,
    });

    this.localStream = media;
    this.cameraTrack = media.getVideoTracks()[0] ?? null;

    const pc = await this.ensurePeerConnection();
    for (const track of media.getAudioTracks()) {
      pc.addTrack(track, media);
    }
    const sender = this.getVideoSender(pc);
    await sender.replaceTrack(this.cameraTrack ?? null);

    this.publishLocalPreview();
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

  private emitError(raw: unknown): void {
    const error = raw instanceof Error ? raw : new Error(String(raw ?? "Unknown WebRTC error"));
    this.options.onError?.(error);
  }
}
