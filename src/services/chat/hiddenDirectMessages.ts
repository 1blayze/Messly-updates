import { deletePersistentValue, getPersistentValue, setPersistentValue } from "../indexedCache";

const HIDDEN_DIRECT_MESSAGES_INDEXED_DB_PREFIX = "messly:hidden-dm:indexeddb:";
const LEGACY_HIDDEN_DIRECT_MESSAGES_LOCAL_STORAGE_PREFIX = "messly:hidden-dm:";

export function normalizeHiddenDirectMessageConversationIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }

  return Array.from(
    new Set(
      ids
        .map((id) => String(id ?? "").trim())
        .filter((id) => Boolean(id)),
    ),
  );
}

export function buildHiddenDirectMessageStorageScopes(...candidates: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      candidates
        .map((id) => String(id ?? "").trim())
        .filter((id) => Boolean(id)),
    ),
  );
}

function getIndexedDbStorageKey(scope: string): string {
  return `${HIDDEN_DIRECT_MESSAGES_INDEXED_DB_PREFIX}${scope}`;
}

function getLegacyLocalStorageKey(scope: string): string {
  return `${LEGACY_HIDDEN_DIRECT_MESSAGES_LOCAL_STORAGE_PREFIX}${scope}`;
}

function readLegacyHiddenDirectMessageConversationIds(scopes: string[]): string[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  for (const scope of scopes) {
    try {
      const raw = window.localStorage.getItem(getLegacyLocalStorageKey(scope));
      if (raw == null) {
        continue;
      }

      return normalizeHiddenDirectMessageConversationIds(JSON.parse(raw) as unknown);
    } catch {
      // ignore and try next scope
    }
  }

  return null;
}

function clearLegacyHiddenDirectMessageConversationIds(scopes: string[]): void {
  if (typeof window === "undefined") {
    return;
  }

  for (const scope of scopes) {
    try {
      window.localStorage.removeItem(getLegacyLocalStorageKey(scope));
    } catch {
      // ignore legacy cleanup failures
    }
  }
}

export async function readHiddenDirectMessageConversationIds(
  candidates: Array<string | null | undefined>,
): Promise<string[]> {
  const scopes = buildHiddenDirectMessageStorageScopes(...candidates);
  if (scopes.length === 0) {
    return [];
  }

  const electronReader = window.electronAPI?.getHiddenDirectMessageConversationIds;
  if (typeof electronReader === "function") {
    try {
      const result = await electronReader({ scopes });
      return normalizeHiddenDirectMessageConversationIds(result?.conversationIds);
    } catch {
      // fall through to IndexedDB
    }
  }

  for (const scope of scopes) {
    try {
      const stored = await getPersistentValue<unknown>(getIndexedDbStorageKey(scope));
      if (stored !== null) {
        return normalizeHiddenDirectMessageConversationIds(stored);
      }
    } catch {
      // ignore and try next scope
    }
  }

  const legacyIds = readLegacyHiddenDirectMessageConversationIds(scopes);
  if (legacyIds !== null) {
    clearLegacyHiddenDirectMessageConversationIds(scopes);
    await persistHiddenDirectMessageConversationIds(legacyIds, scopes);
    return legacyIds;
  }

  return [];
}

export async function persistHiddenDirectMessageConversationIds(
  ids: string[],
  candidates: Array<string | null | undefined>,
): Promise<string[]> {
  const scopes = buildHiddenDirectMessageStorageScopes(...candidates);
  const normalizedIds = normalizeHiddenDirectMessageConversationIds(ids);
  if (scopes.length === 0) {
    return normalizedIds;
  }

  const electronWriter = window.electronAPI?.setHiddenDirectMessageConversationIds;
  if (typeof electronWriter === "function") {
    try {
      const result = await electronWriter({
        scopes,
        conversationIds: normalizedIds,
      });
      return normalizeHiddenDirectMessageConversationIds(result?.conversationIds ?? normalizedIds);
    } catch {
      // fall through to IndexedDB
    }
  }

  await Promise.all(
    scopes.map((scope) => {
      const key = getIndexedDbStorageKey(scope);
      if (normalizedIds.length === 0) {
        return deletePersistentValue(key);
      }
      return setPersistentValue(key, normalizedIds);
    }),
  );

  return normalizedIds;
}
