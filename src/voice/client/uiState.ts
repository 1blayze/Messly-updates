export interface VoiceCallUiSnapshot {
  callActive: boolean;
  callConnecting: boolean;
  muted: boolean;
  deafened: boolean;
}

export type VoiceCallUiCommand = "toggle-mute" | "toggle-deafen";

const VOICE_CALL_UI_STORAGE_KEY = "messly:voice-ui-controls:v1";

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

const DEFAULT_SNAPSHOT: VoiceCallUiSnapshot = {
  callActive: false,
  callConnecting: false,
  muted: storedControls.muted,
  deafened: storedControls.deafened,
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
  const nextSnapshotBase: VoiceCallUiSnapshot = {
    ...currentSnapshot,
    ...partialSnapshot,
  };
  const nextSnapshot: VoiceCallUiSnapshot = nextSnapshotBase.deafened
    ? {
        ...nextSnapshotBase,
        muted: true,
      }
    : nextSnapshotBase;
  if (isSnapshotEqual(currentSnapshot, nextSnapshot)) {
    return;
  }
  currentSnapshot = nextSnapshot;
  persistControls(currentSnapshot);
  emitSnapshot();
}

export function resetVoiceCallUiSnapshot(): void {
  const nextSnapshot: VoiceCallUiSnapshot = {
    ...currentSnapshot,
    callActive: false,
    callConnecting: false,
  };
  if (isSnapshotEqual(currentSnapshot, nextSnapshot)) {
    return;
  }
  currentSnapshot = nextSnapshot;
  persistControls(currentSnapshot);
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
