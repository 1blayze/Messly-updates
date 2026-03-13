export type RtcpMuxPolicyValue = "require" | "negotiate";

export type IceCandidateKind = "host" | "srflx" | "relay" | "prflx" | "unknown";

export interface RtcRuntimeConfig {
  peerConnectionConfig: RTCConfiguration;
  relayFallbackEnabled: boolean;
  forceRelay: boolean;
  iceGatheringTimeoutMs: number;
  connectionTimeoutMs: number;
  verboseLogging: boolean;
}

export interface RtcSelectedCandidatePairSummary {
  localCandidateType: IceCandidateKind;
  remoteCandidateType: IceCandidateKind;
  state: string | null;
  currentRoundTripTimeMs: number | null;
  nominated: boolean;
  usesRelay: boolean;
}

interface CandidateStatShape {
  id?: string;
  type?: string;
  state?: string;
  selected?: boolean;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
}

interface TransportStatShape {
  type?: string;
  selectedCandidatePairId?: string;
}

interface IceCandidateStatShape {
  candidateType?: string;
}

function buildDefaultIceServers(): RTCIceServer[] {
  const turnUsername = String(import.meta.env.VITE_WEBRTC_TURN_USERNAME ?? "").trim();
  const turnCredential = String(import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL ?? "").trim();

  const turnServer: RTCIceServer = {
    urls: [
      "turn:turn.messly.site?transport=udp",
      "turn:turn.messly.site?transport=tcp",
    ],
  };

  if (turnUsername) {
    turnServer.username = turnUsername;
  }
  if (turnCredential) {
    turnServer.credential = turnCredential;
  }

  return [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
    turnServer,
  ];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = buildDefaultIceServers();
const DEFAULT_ICE_TRANSPORT_POLICY: RTCIceTransportPolicy = "all";
const DEFAULT_BUNDLE_POLICY: RTCBundlePolicy = "balanced";
const DEFAULT_RTCP_MUX_POLICY: RtcpMuxPolicyValue = "require";
const DEFAULT_ICE_CANDIDATE_POOL_SIZE = 8;
const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 25_000;

function parseBooleanEnv(rawValue: unknown, fallback: boolean): boolean {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntegerEnv(rawValue: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseIceServers(): RTCIceServer[] {
  const rawJson = String(import.meta.env.VITE_WEBRTC_ICE_SERVERS_JSON ?? "").trim();
  if (!rawJson) {
    return [...DEFAULT_ICE_SERVERS];
  }

  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_ICE_SERVERS];
    }

    const normalizedServers = parsed
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => {
        const typed = item as RTCIceServer;
        const urls = Array.isArray(typed.urls)
          ? typed.urls.filter((url) => typeof url === "string" && url.trim().length > 0)
          : typeof typed.urls === "string" && typed.urls.trim().length > 0
            ? typed.urls
            : null;

        if (!urls) {
          return null;
        }

        const nextServer: RTCIceServer = {
          urls,
        };

        if (typeof typed.username === "string" && typed.username.trim()) {
          nextServer.username = typed.username;
        }
        if (typeof typed.credential === "string" && typed.credential.trim()) {
          nextServer.credential = typed.credential;
        }

        return nextServer;
      })
      .filter((value): value is RTCIceServer => Boolean(value));

    if (normalizedServers.length === 0) {
      return [...DEFAULT_ICE_SERVERS];
    }

    return normalizedServers;
  } catch {
    return [...DEFAULT_ICE_SERVERS];
  }
}

function parseIceTransportPolicy(forceRelay: boolean): RTCIceTransportPolicy {
  if (forceRelay) {
    return "relay";
  }

  const rawPolicy = String(import.meta.env.VITE_WEBRTC_ICE_TRANSPORT_POLICY ?? "")
    .trim()
    .toLowerCase();

  if (rawPolicy === "relay") {
    return "relay";
  }

  if (rawPolicy === "all") {
    return "all";
  }

  return DEFAULT_ICE_TRANSPORT_POLICY;
}

function parseBundlePolicy(): RTCBundlePolicy {
  const rawPolicy = String(import.meta.env.VITE_WEBRTC_BUNDLE_POLICY ?? "")
    .trim()
    .toLowerCase();

  if (rawPolicy === "max-bundle" || rawPolicy === "max-compat" || rawPolicy === "balanced") {
    return rawPolicy;
  }

  return DEFAULT_BUNDLE_POLICY;
}

function parseRtcpMuxPolicy(): RtcpMuxPolicyValue {
  const rawPolicy = String(import.meta.env.VITE_WEBRTC_RTCP_MUX_POLICY ?? "")
    .trim()
    .toLowerCase();

  if (rawPolicy === "negotiate") {
    return "negotiate";
  }

  return DEFAULT_RTCP_MUX_POLICY;
}

function parseIceCandidatePoolSize(): number {
  return parseIntegerEnv(
    import.meta.env.VITE_WEBRTC_ICE_CANDIDATE_POOL_SIZE,
    DEFAULT_ICE_CANDIDATE_POOL_SIZE,
    0,
    32,
  );
}

function parseIceGatheringTimeoutMs(): number {
  return parseIntegerEnv(
    import.meta.env.VITE_WEBRTC_ICE_GATHERING_TIMEOUT_MS,
    DEFAULT_ICE_GATHERING_TIMEOUT_MS,
    5_000,
    120_000,
  );
}

function parseConnectionTimeoutMs(): number {
  return parseIntegerEnv(
    import.meta.env.VITE_WEBRTC_CONNECTION_TIMEOUT_MS,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    5_000,
    120_000,
  );
}

export function sanitizeIceServersForLogs(servers: RTCIceServer[]): Array<Record<string, unknown>> {
  return servers.map((server) => {
    const normalizedUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = normalizedUrls
      .filter((url): url is string => typeof url === "string")
      .map((url) => {
        const trimmed = url.trim();
        if (!trimmed) {
          return trimmed;
        }

        const [protocol, rest] = trimmed.split(":", 2);
        if (!rest) {
          return trimmed;
        }

        if (protocol.toLowerCase() !== "turn" && protocol.toLowerCase() !== "turns") {
          return trimmed;
        }

        const atIndex = rest.lastIndexOf("@");
        if (atIndex <= 0) {
          return trimmed;
        }

        return `${protocol}:***${rest.slice(atIndex)}`;
      });

    return {
      urls,
      hasUsername: Boolean(server.username),
      hasCredential: Boolean(server.credential),
    };
  });
}

export function createRtcRuntimeConfig(): RtcRuntimeConfig {
  const forceRelay = parseBooleanEnv(import.meta.env.VITE_WEBRTC_FORCE_RELAY, false);
  const relayFallbackEnabled = forceRelay
    ? false
    : parseBooleanEnv(import.meta.env.VITE_WEBRTC_RELAY_FALLBACK_ENABLED, true);
  const verboseLogging = parseBooleanEnv(import.meta.env.VITE_WEBRTC_VERBOSE_LOGGING, false);

  const iceServers = parseIceServers();
  const iceTransportPolicy = parseIceTransportPolicy(forceRelay);
  const bundlePolicy = parseBundlePolicy();
  const rtcpMuxPolicy = parseRtcpMuxPolicy();

  const peerConnectionConfig: RTCConfiguration = {
    iceServers,
    iceTransportPolicy,
    bundlePolicy,
    iceCandidatePoolSize: parseIceCandidatePoolSize(),
    rtcpMuxPolicy,
  } as RTCConfiguration;

  return {
    peerConnectionConfig,
    relayFallbackEnabled,
    forceRelay,
    iceGatheringTimeoutMs: parseIceGatheringTimeoutMs(),
    connectionTimeoutMs: parseConnectionTimeoutMs(),
    verboseLogging,
  };
}

export function getIceCandidateKindFromLine(candidateLine: string | null | undefined): IceCandidateKind {
  const normalized = String(candidateLine ?? "").trim();
  if (!normalized) {
    return "unknown";
  }

  const candidateTypeMatch = normalized.match(/\btyp\s+([a-z0-9]+)\b/i);
  const parsedType = String(candidateTypeMatch?.[1] ?? "").toLowerCase();

  if (parsedType === "host" || parsedType === "srflx" || parsedType === "relay" || parsedType === "prflx") {
    return parsedType;
  }

  return "unknown";
}

export function getIceCandidateKind(candidate: RTCIceCandidateInit | null | undefined): IceCandidateKind {
  if (!candidate) {
    return "unknown";
  }

  if (typeof candidate.candidate === "string") {
    return getIceCandidateKindFromLine(candidate.candidate);
  }

  return "unknown";
}

function normalizeCandidateTypeLabel(rawCandidateType: unknown): IceCandidateKind {
  const normalized = String(rawCandidateType ?? "").trim().toLowerCase();
  if (normalized === "host" || normalized === "srflx" || normalized === "relay" || normalized === "prflx") {
    return normalized;
  }
  return "unknown";
}

export async function getSelectedCandidatePairSummary(
  peerConnection: RTCPeerConnection,
): Promise<RtcSelectedCandidatePairSummary | null> {
  const report = await peerConnection.getStats();

  let selectedCandidatePairId = "";
  let selectedPair: CandidateStatShape | null = null;

  report.forEach((entry) => {
    const stat = entry as RTCStats & TransportStatShape;
    if (String(stat.type ?? "") !== "transport") {
      return;
    }
    const pairId = String(stat.selectedCandidatePairId ?? "").trim();
    if (pairId) {
      selectedCandidatePairId = pairId;
    }
  });

  if (selectedCandidatePairId) {
    const entry = report.get(selectedCandidatePairId) as (RTCStats & CandidateStatShape) | undefined;
    if (entry && String(entry.type ?? "") === "candidate-pair") {
      selectedPair = entry;
    }
  }

  if (!selectedPair) {
    report.forEach((entry) => {
      const stat = entry as RTCStats & CandidateStatShape;
      if (String(stat.type ?? "") !== "candidate-pair") {
        return;
      }
      const selected = Boolean(stat.selected);
      const nominated = Boolean(stat.nominated);
      const succeeded = String(stat.state ?? "").toLowerCase() === "succeeded";
      if (selected || nominated || succeeded) {
        selectedPair = stat;
      }
    });
  }

  if (!selectedPair) {
    return null;
  }

  const localCandidate = selectedPair.localCandidateId
    ? (report.get(selectedPair.localCandidateId) as (RTCStats & IceCandidateStatShape) | undefined)
    : undefined;
  const remoteCandidate = selectedPair.remoteCandidateId
    ? (report.get(selectedPair.remoteCandidateId) as (RTCStats & IceCandidateStatShape) | undefined)
    : undefined;

  const localCandidateType = normalizeCandidateTypeLabel(localCandidate?.candidateType);
  const remoteCandidateType = normalizeCandidateTypeLabel(remoteCandidate?.candidateType);
  const roundTripTimeSeconds =
    typeof selectedPair.currentRoundTripTime === "number" && Number.isFinite(selectedPair.currentRoundTripTime)
      ? selectedPair.currentRoundTripTime
      : null;

  return {
    localCandidateType,
    remoteCandidateType,
    state: String(selectedPair.state ?? "").trim() || null,
    currentRoundTripTimeMs: roundTripTimeSeconds != null ? Math.max(0, roundTripTimeSeconds * 1000) : null,
    nominated: Boolean(selectedPair.nominated),
    usesRelay: localCandidateType === "relay" || remoteCandidateType === "relay",
  };
}
