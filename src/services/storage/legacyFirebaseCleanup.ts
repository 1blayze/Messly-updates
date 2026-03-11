const LEGACY_FIREBASE_LOCAL_STORAGE_PREFIXES = Object.freeze(["firebase:", "__firebase__"]);
const LEGACY_FIREBASE_INDEXED_DB_NAMES = Object.freeze([
  "firebase-heartbeat-database",
  "firebaseLocalStorageDb",
]);

function isLegacyFirebaseStorageKey(rawKey: string): boolean {
  const normalizedKey = String(rawKey ?? "").trim().toLowerCase();
  if (!normalizedKey) {
    return false;
  }
  return LEGACY_FIREBASE_LOCAL_STORAGE_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix));
}

function cleanupStorageArea(area: Storage | null | undefined): void {
  if (!area) {
    return;
  }
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < area.length; index += 1) {
      const key = area.key(index);
      if (!key || !isLegacyFirebaseStorageKey(key)) {
        continue;
      }
      keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      area.removeItem(key);
    }
  } catch {}
}

function isLegacyFirebaseIndexedDbName(rawName: string): boolean {
  const normalizedName = String(rawName ?? "").trim().toLowerCase();
  if (!normalizedName) {
    return false;
  }
  if (LEGACY_FIREBASE_INDEXED_DB_NAMES.map((name) => name.toLowerCase()).includes(normalizedName)) {
    return true;
  }
  return normalizedName.startsWith("firebase");
}

function deleteIndexedDbByName(databaseName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function cleanupLegacyFirebaseIndexedDb(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }

  const databaseNames = new Set<string>(LEGACY_FIREBASE_INDEXED_DB_NAMES);
  try {
    if (typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      for (const database of databases) {
        const candidateName = String(database?.name ?? "").trim();
        if (!candidateName || !isLegacyFirebaseIndexedDbName(candidateName)) {
          continue;
        }
        databaseNames.add(candidateName);
      }
    }
  } catch {}

  for (const databaseName of databaseNames) {
    await deleteIndexedDbByName(databaseName);
  }
}

export function cleanupLegacyFirebaseArtifacts(): void {
  if (typeof window === "undefined") {
    return;
  }

  cleanupStorageArea(window.localStorage);
  cleanupStorageArea(window.sessionStorage);
  void cleanupLegacyFirebaseIndexedDb();
}

