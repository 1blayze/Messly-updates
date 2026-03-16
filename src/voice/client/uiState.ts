export interface VoiceCallUiSnapshot {
  callActive: boolean;
  callConnecting: boolean;
  muted: boolean;
  deafened: boolean;
}

export type VoiceCallUiCommand = "toggle-mute" | "toggle-deafen";

const DEFAULT_SNAPSHOT: VoiceCallUiSnapshot = {
  callActive: false,
  callConnecting: false,
  muted: false,
  deafened: false,
};

let currentSnapshot: VoiceCallUiSnapshot = { ...DEFAULT_SNAPSHOT };

const snapshotListeners = new Set<(snapshot: VoiceCallUiSnapshot) => void>();
const commandListeners = new Set<(command: VoiceCallUiCommand) => void>();

function isSnapshotEqual(left: VoiceCallUiSnapshot, right: VoiceCallUiSnapshot): boolean {
  return (
    left.callActive === right.callActive &&
    left.callConnecting === right.callConnecting &&
    left.muted === right.muted &&
    left.deafened === right.deafened
  );
}

function emitSnapshot(): void {
  const next = { ...currentSnapshot };
  for (const listener of snapshotListeners) {
    listener(next);
  }
}

export function getVoiceCallUiSnapshot(): VoiceCallUiSnapshot {
  return { ...currentSnapshot };
}

export function publishVoiceCallUiSnapshot(partialSnapshot: Partial<VoiceCallUiSnapshot>): void {
  const nextSnapshot: VoiceCallUiSnapshot = {
    ...currentSnapshot,
    ...partialSnapshot,
  };
  if (isSnapshotEqual(currentSnapshot, nextSnapshot)) {
    return;
  }
  currentSnapshot = nextSnapshot;
  emitSnapshot();
}

export function resetVoiceCallUiSnapshot(): void {
  if (isSnapshotEqual(currentSnapshot, DEFAULT_SNAPSHOT)) {
    return;
  }
  currentSnapshot = { ...DEFAULT_SNAPSHOT };
  emitSnapshot();
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
  for (const listener of commandListeners) {
    listener(command);
  }
}

export function subscribeVoiceCallUiCommand(
  listener: (command: VoiceCallUiCommand) => void,
): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}
