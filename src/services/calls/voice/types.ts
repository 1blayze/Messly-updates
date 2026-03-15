import type { CallMode } from "../callApi";

export type VoiceTransport = "mediasoup" | "p2p";

export type CallLifecycleState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "destroyed";

export interface VoiceSession {
  transport: VoiceTransport;
  callId: string;
  roomId: string;
  conversationId: string;
  mode: CallMode;
  role: "caller" | "callee";
  resumeToken: string | null;
  /**
   * For P2P calls (transport="p2p"), we store the latest SDP blobs so the UI can resend them on resume.
   * Mediasoup sessions do not use SDP signaling.
   */
  offerSdp?: string | null;
  answerSdp?: string | null;
}

export interface NormalizedAudioSettings {
  inputDeviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalkEnabled: boolean;
  qosHighPriority: boolean;
}

export type CallDebugLogger = (event: string, details?: Record<string, unknown>) => void;

export function toPeerConnectionState(lifecycle: CallLifecycleState): RTCPeerConnectionState {
  switch (lifecycle) {
    case "idle":
      return "new";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnecting":
      return "disconnected";
    case "destroyed":
      return "closed";
    default:
      return "new";
  }
}

export function isTrackLive(track: MediaStreamTrack | null | undefined): track is MediaStreamTrack {
  return Boolean(track && track.readyState === "live");
}
