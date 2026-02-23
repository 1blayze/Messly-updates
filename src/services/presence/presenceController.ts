import { get, onDisconnect, onValue, set, type DatabaseReference, type OnDisconnect } from "firebase/database";
import {
  createPresencePayload,
  getPresenceConnectionRef,
  getPresenceDeviceRef,
  loadPreferredPresenceState,
  savePreferredPresenceState,
} from "./presenceClient";
import { firebaseDatabaseUrl, firebasePresenceEnabled } from "../firebase";
import type { PresenceState } from "./presenceTypes";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const MIN_STATE_UPDATE_INTERVAL_MS = 10 * 1000;
const USER_DND = false;
const PINNED_STATE_KEY = "messly:presence:pinned-state";

type PresenceSubscriber = (state: PresenceState) => void;

let currentUid: string | null = null;
let preferredStateUid: string | null = null;
let deviceRef: DatabaseReference | null = null;
let disconnectRegistration: OnDisconnect | null = null;
let unsubscribeConnected: (() => void) | null = null;

let idleTimeoutId: number | null = null;
let heartbeatIntervalId: number | null = null;
let pendingWriteTimeoutId: number | null = null;

let pendingState: PresenceState | null = null;
let pendingTouchLastActive = false;
let currentState: PresenceState = "online";
let lastWriteDispatchedAt = 0;
let lastActivityAt = Date.now();
let startInvocationId = 0;
let presenceDbValidationPromise: Promise<boolean> | null = null;

const subscribers = new Set<PresenceSubscriber>();
const activityEvents: Array<keyof WindowEventMap> = ["mousemove", "keydown", "mousedown", "touchstart"];

function notifySubscribers(): void {
  subscribers.forEach((subscriber) => subscriber(currentState));
}

function isValidPresenceState(value: unknown): value is PresenceState {
  return value === "online" || value === "idle" || value === "dnd" || value === "offline";
}

function getPinnedPresenceState(): PresenceState | null {
  const raw = localStorage.getItem(PINNED_STATE_KEY);
  if (!raw) {
    return null;
  }
  return isValidPresenceState(raw) ? raw : null;
}

function setPinnedPresenceState(state: PresenceState | null): void {
  if (!state) {
    localStorage.removeItem(PINNED_STATE_KEY);
    return;
  }

  localStorage.setItem(PINNED_STATE_KEY, state);
}

function setCurrentState(nextState: PresenceState): void {
  if (currentState === nextState) {
    return;
  }

  currentState = nextState;
  notifySubscribers();
}

function getDesiredState(): PresenceState {
  if (USER_DND) {
    return "dnd";
  }

  const pinnedState = getPinnedPresenceState();
  if (pinnedState) {
    return pinnedState;
  }

  const idleForMs = Date.now() - lastActivityAt;
  return idleForMs >= IDLE_TIMEOUT_MS ? "idle" : "online";
}

async function syncPreferredPresenceStateFromFirebase(firebaseUid: string): Promise<void> {
  const preferredState = await loadPreferredPresenceState(firebaseUid);
  if (preferredState) {
    setPinnedPresenceState(preferredState);
    setCurrentState(preferredState);
  }
}

function normalizeFirebaseDatabaseUrl(url: string): string {
  return url.trim().replace(/\/+$/g, "");
}

async function validatePresenceDatabaseEndpoint(): Promise<boolean> {
  if (presenceDbValidationPromise) {
    return presenceDbValidationPromise;
  }

  presenceDbValidationPromise = (async () => {
    const normalizedBaseUrl = normalizeFirebaseDatabaseUrl(firebaseDatabaseUrl);
    return Boolean(normalizedBaseUrl);
  })();

  return presenceDbValidationPromise;
}

async function writePresence(state: PresenceState, touchLastActive: boolean): Promise<void> {
  if (!deviceRef) {
    return;
  }

  if (currentState === state && !touchLastActive) {
    return;
  }

  try {
    await set(
      deviceRef,
      createPresencePayload(state, {
        includeLastActive: touchLastActive,
      }),
    );
    setCurrentState(state);
  } catch {}
}

function flushPresenceQueue(force: boolean): void {
  if (force && pendingWriteTimeoutId !== null) {
    window.clearTimeout(pendingWriteTimeoutId);
    pendingWriteTimeoutId = null;
  }

  const nextState = pendingState;
  const touchLastActive = pendingTouchLastActive;

  if (!nextState) {
    return;
  }

  const elapsed = Date.now() - lastWriteDispatchedAt;
  if (!force && elapsed < MIN_STATE_UPDATE_INTERVAL_MS) {
    if (pendingWriteTimeoutId === null) {
      pendingWriteTimeoutId = window.setTimeout(() => {
        pendingWriteTimeoutId = null;
        flushPresenceQueue(false);
      }, MIN_STATE_UPDATE_INTERVAL_MS - elapsed);
    }
    return;
  }

  pendingState = null;
  pendingTouchLastActive = false;
  lastWriteDispatchedAt = Date.now();
  void writePresence(nextState, touchLastActive);
}

function queuePresenceWrite(
  nextState: PresenceState,
  options: {
    touchLastActive?: boolean;
    force?: boolean;
  } = {},
): void {
  const touchLastActive = options.touchLastActive ?? true;
  const force = options.force ?? false;
  const hadPendingState = pendingState !== null;

  pendingState = nextState;
  pendingTouchLastActive = hadPendingState ? pendingTouchLastActive || touchLastActive : touchLastActive;

  if (force) {
    flushPresenceQueue(true);
    return;
  }

  const elapsed = Date.now() - lastWriteDispatchedAt;
  if (elapsed >= MIN_STATE_UPDATE_INTERVAL_MS && pendingWriteTimeoutId === null) {
    flushPresenceQueue(false);
    return;
  }

  if (pendingWriteTimeoutId !== null) {
    return;
  }

  pendingWriteTimeoutId = window.setTimeout(() => {
    pendingWriteTimeoutId = null;
    flushPresenceQueue(false);
  }, Math.max(0, MIN_STATE_UPDATE_INTERVAL_MS - elapsed));
}

function clearIdleTimer(): void {
  if (idleTimeoutId !== null) {
    window.clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

function scheduleIdleTimer(): void {
  clearIdleTimer();
  if (USER_DND || getPinnedPresenceState() !== null) {
    return;
  }

  idleTimeoutId = window.setTimeout(() => {
    queuePresenceWrite("idle", { touchLastActive: true });
  }, IDLE_TIMEOUT_MS);
}

function handleUserActivity(): void {
  lastActivityAt = Date.now();
  queuePresenceWrite(getDesiredState(), { touchLastActive: true });
  scheduleIdleTimer();
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    queuePresenceWrite(getPinnedPresenceState() === "dnd" || USER_DND ? "dnd" : "idle", { touchLastActive: true });
    return;
  }

  handleUserActivity();
}

function bindActivityListeners(): void {
  activityEvents.forEach((eventName) => {
    window.addEventListener(eventName, handleUserActivity, { passive: true });
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function unbindActivityListeners(): void {
  activityEvents.forEach((eventName) => {
    window.removeEventListener(eventName, handleUserActivity);
  });
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function clearHeartbeat(): void {
  if (heartbeatIntervalId !== null) {
    window.clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

function startHeartbeat(): void {
  clearHeartbeat();
  heartbeatIntervalId = window.setInterval(() => {
    queuePresenceWrite(getDesiredState(), { touchLastActive: true });
  }, HEARTBEAT_INTERVAL_MS);
}

function setOfflineNow(): void {
  if (!deviceRef) {
    return;
  }

  void set(
    deviceRef,
    createPresencePayload("offline", {
      includeLastActive: true,
    }),
  );
}

function handleBeforeUnload(): void {
  setOfflineNow();
}

function bindLifecycleListeners(): void {
  window.addEventListener("beforeunload", handleBeforeUnload);
}

function unbindLifecycleListeners(): void {
  window.removeEventListener("beforeunload", handleBeforeUnload);
}

function watchConnectionState(): void {
  const connectedRef = getPresenceConnectionRef();

  unsubscribeConnected = onValue(connectedRef, (snapshot) => {
    if (!deviceRef || snapshot.val() !== true) {
      return;
    }

    if (disconnectRegistration) {
      void disconnectRegistration.cancel();
    }

    disconnectRegistration = onDisconnect(deviceRef);
    void disconnectRegistration.set(
      createPresencePayload("offline", {
        includeLastActive: true,
      }),
    );

    queuePresenceWrite(getDesiredState(), {
      touchLastActive: true,
      force: true,
    });
  });
}

function stopConnectionWatch(): void {
  if (unsubscribeConnected) {
    unsubscribeConnected();
    unsubscribeConnected = null;
  }
}

async function syncInitialPresenceStateFromDatabase(): Promise<void> {
  if (!deviceRef) {
    return;
  }

  try {
    const snapshot = await get(deviceRef);
    if (!snapshot.exists()) {
      return;
    }

    const stateValue = snapshot.child("state").val();
    if (stateValue === "dnd") {
      setCurrentState(stateValue);
    }
  } catch {}
}

function resetQueuesAndTimers(): void {
  clearIdleTimer();
  clearHeartbeat();

  if (pendingWriteTimeoutId !== null) {
    window.clearTimeout(pendingWriteTimeoutId);
    pendingWriteTimeoutId = null;
  }

  pendingState = null;
  pendingTouchLastActive = false;
}

function start(firebaseUid: string): void {
  if (!firebaseUid) {
    return;
  }

  preferredStateUid = firebaseUid;

  if (!firebasePresenceEnabled) {
    setCurrentState("offline");
    return;
  }

  if (currentUid === firebaseUid && deviceRef) {
    return;
  }

  const invocationId = ++startInvocationId;
  stopInternal(false);

  void (async () => {
    const isPresenceDatabaseAvailable = await validatePresenceDatabaseEndpoint();
    if (invocationId !== startInvocationId) {
      return;
    }

    if (!isPresenceDatabaseAvailable) {
      setCurrentState("offline");
      return;
    }

    currentUid = firebaseUid;
    deviceRef = getPresenceDeviceRef(firebaseUid);
    lastActivityAt = Date.now();
    lastWriteDispatchedAt = 0;
    const desiredState = getDesiredState();
    const initialState = desiredState;
    setCurrentState(initialState);

    disconnectRegistration = onDisconnect(deviceRef);
    void disconnectRegistration.set(
      createPresencePayload("offline", {
        includeLastActive: true,
      }),
    );

    bindActivityListeners();
    bindLifecycleListeners();
    watchConnectionState();
    startHeartbeat();
    void syncInitialPresenceStateFromDatabase();
    void syncPreferredPresenceStateFromFirebase(firebaseUid);

    queuePresenceWrite(initialState, {
      touchLastActive: true,
      force: true,
    });
    scheduleIdleTimer();
  })();
}

function stopInternal(invalidatePendingStart: boolean): void {
  if (invalidatePendingStart) {
    startInvocationId += 1;
  }

  unbindActivityListeners();
  unbindLifecycleListeners();
  stopConnectionWatch();
  resetQueuesAndTimers();

  if (disconnectRegistration) {
    void disconnectRegistration.cancel();
    disconnectRegistration = null;
  }

  setOfflineNow();

  currentUid = null;
  deviceRef = null;
  preferredStateUid = null;
  lastWriteDispatchedAt = 0;
  setCurrentState("offline");
}

function stop(): void {
  stopInternal(true);
}

function subscribe(subscriber: PresenceSubscriber): () => void {
  subscribers.add(subscriber);
  subscriber(currentState);

  return () => {
    subscribers.delete(subscriber);
  };
}

function getState(): PresenceState {
  return currentState;
}

function setPreferredState(nextState: PresenceState): void {
  setPinnedPresenceState(nextState);
  setCurrentState(nextState);

  const uidToUse = currentUid || preferredStateUid;
  if (uidToUse) {
    void savePreferredPresenceState(uidToUse, nextState);
  }

  if (!deviceRef || !currentUid) {
    return;
  }

  lastActivityAt = Date.now();
  queuePresenceWrite(nextState, {
    touchLastActive: true,
    force: true,
  });

  if (nextState === "online") {
    scheduleIdleTimer();
  } else {
    clearIdleTimer();
  }
}

function getPreferredState(): PresenceState | null {
  return getPinnedPresenceState();
}

export const presenceController = {
  start,
  stop,
  subscribe,
  getState,
  setPreferredState,
  getPreferredState,
};
