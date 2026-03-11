import { supabaseUrl } from "../../lib/supabaseClient";

let memoryRefreshToken: string | null = null;
const LEGACY_WEB_REFRESH_TOKEN_STORAGE_KEY = "messly.auth.refresh-token";

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

  return LEGACY_WEB_REFRESH_TOKEN_STORAGE_KEY;
}

const WEB_REFRESH_TOKEN_STORAGE_KEY = deriveProjectScopedRefreshTokenStorageKey();

function getAuthBridge() {
  return window.messlyAuth;
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
  const api = getAuthBridge();
  if (api?.loadRefreshToken) {
    const token = await api.loadRefreshToken();
    return typeof token === "string" && token.trim() ? token.trim() : null;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    const token = String(browserStorage.getItem(WEB_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
    if (token) {
      memoryRefreshToken = token;
      return token;
    }

    const legacyToken = String(browserStorage.getItem(LEGACY_WEB_REFRESH_TOKEN_STORAGE_KEY) ?? "").trim();
    if (legacyToken) {
      browserStorage.removeItem(LEGACY_WEB_REFRESH_TOKEN_STORAGE_KEY);
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

  const api = getAuthBridge();
  if (api?.saveRefreshToken) {
    await api.saveRefreshToken(normalizedToken);
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.setItem(WEB_REFRESH_TOKEN_STORAGE_KEY, normalizedToken);
  }

  memoryRefreshToken = normalizedToken || null;
}

export async function clearRefreshToken(): Promise<void> {
  const api = getAuthBridge();
  if (api?.clearRefreshToken) {
    await api.clearRefreshToken();
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.removeItem(WEB_REFRESH_TOKEN_STORAGE_KEY);
  }

  memoryRefreshToken = null;
}
