import { get, ref, serverTimestamp, set, type DatabaseReference } from "firebase/database";
import { firebaseDatabase } from "../firebase";
import type { PresencePlatform, PresenceState } from "./presenceTypes";

const DEVICE_ID_STORAGE_KEY = "messly:presence:device-id";

function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `device-${Date.now()}-${random}`;
}

export function getOrCreatePresenceDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const created = generateDeviceId();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
  return created;
}

export function getPresencePlatform(): PresencePlatform {
  if (window.electronAPI) {
    return "desktop";
  }

  if (/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)) {
    return "mobile";
  }

  return "browser";
}

export function getPresenceDeviceRef(firebaseUid: string): DatabaseReference {
  return ref(firebaseDatabase, `presence/${firebaseUid}/${getOrCreatePresenceDeviceId()}`);
}

export function getPresenceConnectionRef(): DatabaseReference {
  return ref(firebaseDatabase, ".info/connected");
}

export function createPresencePayload(
  state: PresenceState,
  options: {
    includeLastActive?: boolean;
    platform?: PresencePlatform;
  } = {},
): Record<string, unknown> {
  const includeLastActive = options.includeLastActive ?? true;

  return {
    state,
    platform: options.platform ?? getPresencePlatform(),
    ...(includeLastActive ? { lastActive: serverTimestamp() } : {}),
    updatedAt: serverTimestamp(),
  };
}

export function getUserPreferredPresenceRef(firebaseUid: string): DatabaseReference {
  return ref(firebaseDatabase, `users/${firebaseUid}/preferredPresence`);
}

export async function savePreferredPresenceState(firebaseUid: string, state: PresenceState): Promise<void> {
  const ref = getUserPreferredPresenceRef(firebaseUid);
  await set(ref, {
    state,
    updatedAt: serverTimestamp(),
  });
}

export async function loadPreferredPresenceState(firebaseUid: string): Promise<PresenceState | null> {
  try {
    const ref = getUserPreferredPresenceRef(firebaseUid);
    const snapshot = await get(ref);
    if (!snapshot.exists()) {
      return null;
    }
    const data = snapshot.val();
    const state = data?.state;
    if (state === "online" || state === "idle" || state === "dnd" || state === "offline") {
      return state;
    }
    return null;
  } catch {
    return null;
  }
}
