import { deletePersistentValue, getPersistentValue, setPersistentValue } from "../indexedCache";
import { normalizePresenceState, type PresenceState } from "./presenceTypes";

const PRESENCE_PREFERENCE_KEY_PREFIX = "messly:presence-preference:";

function buildPresencePreferenceKey(userId: string): string {
  return `${PRESENCE_PREFERENCE_KEY_PREFIX}${userId}`;
}

export async function readPresencePreference(userId: string | null | undefined): Promise<PresenceState | null> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return null;
  }

  try {
    const stored = await getPersistentValue<unknown>(buildPresencePreferenceKey(normalizedUserId));
    if (stored == null) {
      return null;
    }
    return normalizePresenceState(stored);
  } catch {
    return null;
  }
}

export async function writePresencePreference(
  userId: string | null | undefined,
  state: PresenceState,
): Promise<PresenceState> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return state;
  }

  try {
    await setPersistentValue(buildPresencePreferenceKey(normalizedUserId), state);
  } catch {
    // ignore persistence failures and keep runtime state
  }

  return state;
}

export async function clearPresencePreference(userId: string | null | undefined): Promise<void> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return;
  }

  try {
    await deletePersistentValue(buildPresencePreferenceKey(normalizedUserId));
  } catch {
    // ignore persistence failures
  }
}
