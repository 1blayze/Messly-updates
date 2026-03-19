export interface VoiceCallUiSnapshot {
  callActive: boolean;
  callConnecting: boolean;
  muted: boolean;
  deafened: boolean;
  connectionState: VoiceCallUiConnectionState;
  stage: VoiceCallUiStage;
  peerDisplayName: string;
  peerAvatarSrc: string;
  diagnostics: VoiceCallUiDiagnosticsSummary;
}

export type VoiceCallUiCommand = "toggle-mute" | "toggle-deafen";
export type VoiceCallUiConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";
export type VoiceCallUiStage = "IDLE" | "RINGING" | "CONNECTED" | "RECONNECTING" | "ENDED";

export interface VoiceCallUiDiagnosticsSummary {
  pingAverageMs: number | null;
  lastPingMs: number | null;
  packetLossPercent: number | null;
  sendingAudioKbps: number | null;
  receivingAudioKbps: number | null;
  localTrackActive: boolean;
  remoteTrackActive: boolean;
  remoteStreams: number;
}

const VOICE_CALL_UI_STORAGE_KEY = "messly:voice-ui-controls:v1";
const VOICE_CALL_UI_SYNC_STORAGE_KEY = "messly:voice-ui-sync:v1";
const VOICE_CALL_UI_COMMAND_STORAGE_KEY = "messly:voice-ui-command:v1";
const VOICE_CALL_UI_BROADCAST_CHANNEL_NAME = "messly:voice-ui:v1";
const VOICE_CALL_UI_MAX_SYNC_AGE_MS = 30_000;

type VoiceUiSyncKind = "snapshot" | "command";

interface VoiceUiSyncEnvelopeBase {
  kind: VoiceUiSyncKind;
  sourceId: string;
  sentAt: number;
}

interface VoiceUiSnapshotSyncEnvelope extends VoiceUiSyncEnvelopeBase {
  kind: "snapshot";
  snapshot: VoiceCallUiSnapshot;
}

interface VoiceUiCommandSyncEnvelope extends VoiceUiSyncEnvelopeBase {
  kind: "command";
  command: VoiceCallUiCommand;
}

type VoiceUiSyncEnvelope = VoiceUiSnapshotSyncEnvelope | VoiceUiCommandSyncEnvelope;

function createVoiceUiSourceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.round(Math.random() * 1_000_000_000)}`;
}

const voiceUiSourceId = createVoiceUiSourceId();
const voiceUiBroadcastChannel =
  typeof window !== "undefined" && typeof BroadcastChannel === "function"
    ? new BroadcastChannel(VOICE_CALL_UI_BROADCAST_CHANNEL_NAME)
    : null;

function readStoredControls(): Pick<VoiceCallUiSnapshot, "muted" | "deafened"> {
  if (typeof window === "undefined") {
    return {
      muted: false,
      deafened: false,
    };
  }

  try {
    const raw = window.localStorage.getItem(VOICE_CALL_UI_STORAGE_KEY);
    if (!raw) {
      return {
        muted: false,
        deafened: false,
      };
    }
    const parsed = JSON.parse(raw) as Partial<Pick<VoiceCallUiSnapshot, "muted" | "deafened">>;
    const deafened = Boolean(parsed.deafened);
    return {
      muted: deafened ? true : Boolean(parsed.muted),
      deafened,
    };
  } catch {
    return {
      muted: false,
      deafened: false,
    };
  }
}

function persistControls(snapshot: VoiceCallUiSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      VOICE_CALL_UI_STORAGE_KEY,
      JSON.stringify({
        muted: snapshot.muted,
        deafened: snapshot.deafened,
      }),
    );
  } catch {
    // Ignore storage write failures.
  }
}

const storedControls = readStoredControls();
const DEFAULT_DIAGNOSTICS_SUMMARY: VoiceCallUiDiagnosticsSummary = {
  pingAverageMs: null,
  lastPingMs: null,
  packetLossPercent: null,
  sendingAudioKbps: null,
  receivingAudioKbps: null,
  localTrackActive: false,
  remoteTrackActive: false,
  remoteStreams: 0,
};

const DEFAULT_SNAPSHOT: VoiceCallUiSnapshot = {
  callActive: false,
  callConnecting: false,
  muted: storedControls.muted,
  deafened: storedControls.deafened,
  connectionState: "idle",
  stage: "IDLE",
  peerDisplayName: "",
  peerAvatarSrc: "",
  diagnostics: { ...DEFAULT_DIAGNOSTICS_SUMMARY },
};

let currentSnapshot: VoiceCallUiSnapshot = { ...DEFAULT_SNAPSHOT };

const snapshotListeners = new Set<(snapshot: VoiceCallUiSnapshot) => void>();
const commandListeners = new Set<(command: VoiceCallUiCommand) => void>();

function isSnapshotEqual(left: VoiceCallUiSnapshot, right: VoiceCallUiSnapshot): boolean {
  const leftDiagnostics = left.diagnostics;
  const rightDiagnostics = right.diagnostics;
  return (
    left.callActive === right.callActive &&
    left.callConnecting === right.callConnecting &&
    left.muted === right.muted &&
    left.deafened === right.deafened &&
    left.connectionState === right.connectionState &&
    left.stage === right.stage &&
    left.peerDisplayName === right.peerDisplayName &&
    left.peerAvatarSrc === right.peerAvatarSrc &&
    leftDiagnostics.pingAverageMs === rightDiagnostics.pingAverageMs &&
    leftDiagnostics.lastPingMs === rightDiagnostics.lastPingMs &&
    leftDiagnostics.packetLossPercent === rightDiagnostics.packetLossPercent &&
    leftDiagnostics.sendingAudioKbps === rightDiagnostics.sendingAudioKbps &&
    leftDiagnostics.receivingAudioKbps === rightDiagnostics.receivingAudioKbps &&
    leftDiagnostics.localTrackActive === rightDiagnostics.localTrackActive &&
    leftDiagnostics.remoteTrackActive === rightDiagnostics.remoteTrackActive &&
    leftDiagnostics.remoteStreams === rightDiagnostics.remoteStreams
  );
}

function emitSnapshot(): void {
  const next = { ...currentSnapshot };
  for (const listener of snapshotListeners) {
    listener(next);
  }
}

function normalizeFiniteNumber(value: unknown): number | null {
  const casted = Number(value);
  if (!Number.isFinite(casted)) {
    return null;
  }
  return casted;
}

function normalizeSnapshot(snapshot: Partial<VoiceCallUiSnapshot>): VoiceCallUiSnapshot {
  const deafened = Boolean(snapshot.deafened);
  const connectionStateRaw = String(snapshot.connectionState ?? "").trim().toLowerCase();
  const connectionState: VoiceCallUiConnectionState =
    connectionStateRaw === "connecting" ||
    connectionStateRaw === "connected" ||
    connectionStateRaw === "reconnecting" ||
    connectionStateRaw === "closed"
      ? connectionStateRaw
      : "idle";

  const stageRaw = String(snapshot.stage ?? "").trim().toUpperCase();
  const stage: VoiceCallUiStage =
    stageRaw === "RINGING" ||
    stageRaw === "CONNECTED" ||
    stageRaw === "RECONNECTING" ||
    stageRaw === "ENDED"
      ? stageRaw
      : "IDLE";

  const diagnosticsRaw = snapshot.diagnostics ?? DEFAULT_DIAGNOSTICS_SUMMARY;
  const remoteStreamsCasted = Number(diagnosticsRaw.remoteStreams ?? 0);
  const remoteStreams = Number.isFinite(remoteStreamsCasted)
    ? Math.max(0, Math.round(remoteStreamsCasted))
    : 0;

  return {
    callActive: Boolean(snapshot.callActive),
    callConnecting: Boolean(snapshot.callConnecting),
    muted: deafened ? true : Boolean(snapshot.muted),
    deafened,
    connectionState,
    stage,
    peerDisplayName: String(snapshot.peerDisplayName ?? "").trim(),
    peerAvatarSrc: String(snapshot.peerAvatarSrc ?? "").trim(),
    diagnostics: {
      pingAverageMs: normalizeFiniteNumber(diagnosticsRaw.pingAverageMs),
      lastPingMs: normalizeFiniteNumber(diagnosticsRaw.lastPingMs),
      packetLossPercent: normalizeFiniteNumber(diagnosticsRaw.packetLossPercent),
      sendingAudioKbps: normalizeFiniteNumber(diagnosticsRaw.sendingAudioKbps),
      receivingAudioKbps: normalizeFiniteNumber(diagnosticsRaw.receivingAudioKbps),
      localTrackActive: Boolean(diagnosticsRaw.localTrackActive),
      remoteTrackActive: Boolean(diagnosticsRaw.remoteTrackActive),
      remoteStreams,
    },
  };
}

function isVoiceCallUiCommand(commandRaw: unknown): commandRaw is VoiceCallUiCommand {
  return commandRaw === "toggle-mute" || commandRaw === "toggle-deafen";
}

function isVoiceCallUiSnapshotShape(value: unknown): value is VoiceCallUiSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<VoiceCallUiSnapshot>;
  return (
    typeof candidate.callActive === "boolean" &&
    typeof candidate.callConnecting === "boolean" &&
    typeof candidate.muted === "boolean" &&
    typeof candidate.deafened === "boolean"
  );
}

function parseVoiceUiSyncEnvelope(payloadRaw: unknown): VoiceUiSyncEnvelope | null {
  if (!payloadRaw || typeof payloadRaw !== "object") {
    return null;
  }

  const payload = payloadRaw as Partial<VoiceUiSyncEnvelope>;
  const kind = payload.kind;
  const sourceId = String(payload.sourceId ?? "").trim();
  const sentAt = Number(payload.sentAt ?? 0);
  if (!sourceId || !Number.isFinite(sentAt) || sentAt <= 0) {
    return null;
  }

  if (kind === "snapshot") {
    if (!isVoiceCallUiSnapshotShape(payload.snapshot)) {
      return null;
    }
    return {
      kind: "snapshot",
      sourceId,
      sentAt,
      snapshot: normalizeSnapshot(payload.snapshot),
    };
  }

  if (kind === "command") {
    if (!isVoiceCallUiCommand(payload.command)) {
      return null;
    }
    return {
      kind: "command",
      sourceId,
      sentAt,
      command: payload.command,
    };
  }

  return null;
}

function emitCommandLocally(command: VoiceCallUiCommand): void {
  for (const listener of commandListeners) {
    listener(command);
  }
}

function applySnapshot(nextSnapshotRaw: VoiceCallUiSnapshot, options?: { broadcast?: boolean }): void {
  const nextSnapshot = normalizeSnapshot(nextSnapshotRaw);
  if (isSnapshotEqual(currentSnapshot, nextSnapshot)) {
    return;
  }
  currentSnapshot = nextSnapshot;
  persistControls(currentSnapshot);
  emitSnapshot();

  if (options?.broadcast) {
    broadcastVoiceUiEnvelope({
      kind: "snapshot",
      sourceId: voiceUiSourceId,
      sentAt: Date.now(),
      snapshot: currentSnapshot,
    });
  }
}

function handleIncomingVoiceUiEnvelope(envelope: VoiceUiSyncEnvelope): void {
  if (envelope.sourceId === voiceUiSourceId) {
    return;
  }
  if (Date.now() - envelope.sentAt > VOICE_CALL_UI_MAX_SYNC_AGE_MS) {
    return;
  }

  if (envelope.kind === "snapshot") {
    applySnapshot(envelope.snapshot, {
      broadcast: false,
    });
    return;
  }

  emitCommandLocally(envelope.command);
}

function broadcastVoiceUiEnvelope(envelope: VoiceUiSyncEnvelope): void {
  if (typeof window === "undefined") {
    return;
  }

  if (voiceUiBroadcastChannel) {
    try {
      voiceUiBroadcastChannel.postMessage(envelope);
    } catch {
      // Ignore transient cross-tab messaging failures.
    }
    return;
  }

  const storageKey = envelope.kind === "snapshot"
    ? VOICE_CALL_UI_SYNC_STORAGE_KEY
    : VOICE_CALL_UI_COMMAND_STORAGE_KEY;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    // Ignore storage write failures.
  }
}

function initializeVoiceUiSyncBridge(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (voiceUiBroadcastChannel) {
    voiceUiBroadcastChannel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const envelope = parseVoiceUiSyncEnvelope(event.data);
      if (!envelope) {
        return;
      }
      handleIncomingVoiceUiEnvelope(envelope);
    });
    return;
  }

  window.addEventListener("storage", (event) => {
    if (
      event.key !== VOICE_CALL_UI_SYNC_STORAGE_KEY &&
      event.key !== VOICE_CALL_UI_COMMAND_STORAGE_KEY
    ) {
      return;
    }
    if (!event.newValue) {
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue) as unknown;
      const envelope = parseVoiceUiSyncEnvelope(parsed);
      if (!envelope) {
        return;
      }
      handleIncomingVoiceUiEnvelope(envelope);
    } catch {
      // Ignore malformed cross-tab payloads.
    }
  });
}

initializeVoiceUiSyncBridge();

export function getVoiceCallUiSnapshot(): VoiceCallUiSnapshot {
  return { ...currentSnapshot };
}

export function publishVoiceCallUiSnapshot(partialSnapshot: Partial<VoiceCallUiSnapshot>): void {
  const nextSnapshot: VoiceCallUiSnapshot = {
    ...currentSnapshot,
    ...partialSnapshot,
  };
  applySnapshot(nextSnapshot, {
    broadcast: true,
  });
}

export function resetVoiceCallUiSnapshot(): void {
  const nextSnapshot: VoiceCallUiSnapshot = {
    ...currentSnapshot,
    callActive: false,
    callConnecting: false,
    connectionState: "idle",
    stage: "IDLE",
    peerDisplayName: "",
    peerAvatarSrc: "",
    diagnostics: { ...DEFAULT_DIAGNOSTICS_SUMMARY },
  };
  applySnapshot(nextSnapshot, {
    broadcast: true,
  });
}

export function subscribeVoiceCallUiSnapshot(
  listener: (snapshot: VoiceCallUiSnapshot) => void,
): () => void {
  snapshotListeners.add(listener);
  listener({ ...currentSnapshot });
  return () => {
    snapshotListeners.delete(listener);
  };
}

export function emitVoiceCallUiCommand(command: VoiceCallUiCommand): void {
  emitCommandLocally(command);
  broadcastVoiceUiEnvelope({
    kind: "command",
    sourceId: voiceUiSourceId,
    sentAt: Date.now(),
    command,
  });
}

export function subscribeVoiceCallUiCommand(
  listener: (command: VoiceCallUiCommand) => void,
): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}
