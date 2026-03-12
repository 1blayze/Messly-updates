import { supabaseUrl } from "../../lib/supabaseClient";

let memoryRefreshToken: string | null = null;
const LEGACY_REFRESH_TOKEN_STORAGE_KEY = "messly.auth.refresh-token";

function deriveProjectScopedRefreshTokenStorageKey(): string {
  try {
    const parsedUrl = new URL(supabaseUrl);
    const projectRef = parsedUrl.hostname.split(".")[0]?.trim();
    if (projectRef) {
      return `messly.auth.refresh-token.${projectRef}`;
    }
  } catch {
    // Fallback to the legacy key shape below.
  }

  return LEGACY_REFRESH_TOKEN_STORAGE_KEY;
}

const PROJECT_REFRESH_TOKEN_STORAGE_KEY = deriveProjectScopedRefreshTokenStorageKey();

function getElectronSecureStoreApi():
  | {
      getSecureStoreItem: (payload: { key: string }) => Promise<{ value?: string | null } | null>;
      setSecureStoreItem: (payload: { key: string; value: string }) => Promise<unknown>;
      removeSecureStoreItem: (payload: { key: string }) => Promise<unknown>;
    }
  | null {
  const api = window.electronAPI;
  const getSecureStoreItem = api?.getSecureStoreItem;
  const setSecureStoreItem = api?.setSecureStoreItem;
  const removeSecureStoreItem = api?.removeSecureStoreItem;
  if (
    typeof getSecureStoreItem !== "function" ||
    typeof setSecureStoreItem !== "function" ||
    typeof removeSecureStoreItem !== "function"
  ) {
    return null;
  }
  return {
    getSecureStoreItem,
    setSecureStoreItem,
    removeSecureStoreItem,
  };
}

async function getElectronSecureStoreValue(keyRaw: string): Promise<string | null> {
  const key = String(keyRaw ?? "").trim();
  if (!key) {
    return null;
  }

  const api = getElectronSecureStoreApi();
  if (!api) {
    return null;
  }

  const result = await api.getSecureStoreItem({ key });
  const value = String(result?.value ?? "").trim();
  return value || null;
}

async function setElectronSecureStoreValue(keyRaw: string, valueRaw: string): Promise<void> {
  const key = String(keyRaw ?? "").trim();
  if (!key) {
    return;
  }

  const api = getElectronSecureStoreApi();
  if (!api) {
    return;
  }

  await api.setSecureStoreItem({
    key,
    value: String(valueRaw ?? ""),
  });
}

async function removeElectronSecureStoreValue(keyRaw: string): Promise<void> {
  const key = String(keyRaw ?? "").trim();
  if (!key) {
    return;
  }

  const api = getElectronSecureStoreApi();
  if (!api) {
    return;
  }

  await api.removeSecureStoreItem({ key });
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function loadRefreshToken(): Promise<string | null> {
  if (getElectronSecureStoreApi()) {
    const scopedToken = await getElectronSecureStoreValue(PROJECT_REFRESH_TOKEN_STORAGE_KEY);
    if (scopedToken) {
      memoryRefreshToken = scopedToken;
      return scopedToken;
    }

    if (PROJECT_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
      const legacyToken = await getElectronSecureStoreValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
      if (legacyToken) {
        // Migrate legacy desktop key to project-scoped key.
        await setElectronSecureStoreValue(PROJECT_REFRESH_TOKEN_STORAGE_KEY, legacyToken);
        await removeElectronSecureStoreValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
        memoryRefreshToken = legacyToken;
        return legacyToken;
      }
    }

    return memoryRefreshToken;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    const token = String(browserStorage.getItem(PROJECT_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
    if (token) {
      memoryRefreshToken = token;
      return token;
    }

    const legacyToken = String(browserStorage.getItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
    if (legacyToken) {
      browserStorage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    }
  }

  return memoryRefreshToken;
}

export async function saveRefreshToken(token: string): Promise<void> {
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken) {
    await clearRefreshToken();
    return;
  }

  if (getElectronSecureStoreApi()) {
    await setElectronSecureStoreValue(PROJECT_REFRESH_TOKEN_STORAGE_KEY, normalizedToken);
    if (PROJECT_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
      await removeElectronSecureStoreValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    }
    memoryRefreshToken = normalizedToken;
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.setItem(PROJECT_REFRESH_TOKEN_STORAGE_KEY, normalizedToken);
    if (PROJECT_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
      browserStorage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    }
  }

  memoryRefreshToken = normalizedToken || null;
}

export async function clearRefreshToken(): Promise<void> {
  if (getElectronSecureStoreApi()) {
    await removeElectronSecureStoreValue(PROJECT_REFRESH_TOKEN_STORAGE_KEY);
    if (PROJECT_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
      await removeElectronSecureStoreValue(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    }
    memoryRefreshToken = null;
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.removeItem(PROJECT_REFRESH_TOKEN_STORAGE_KEY);
    if (PROJECT_REFRESH_TOKEN_STORAGE_KEY !== LEGACY_REFRESH_TOKEN_STORAGE_KEY) {
      browserStorage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    }
  }

  memoryRefreshToken = null;
}
