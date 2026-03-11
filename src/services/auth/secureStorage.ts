import type { SupportedStorage } from "@supabase/supabase-js";

const memoryFallback = new Map<string, string>();

function getSecureStoreApi() {
  return window.electronAPI;
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

export async function getSecureItem(key: string): Promise<string | null> {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return null;
  }

  const api = getSecureStoreApi();
  if (api?.getSecureStoreItem) {
    const result = await api.getSecureStoreItem({ key: normalizedKey });
    return typeof result?.value === "string" ? result.value : null;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    return browserStorage.getItem(normalizedKey);
  }

  return memoryFallback.get(normalizedKey) ?? null;
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return;
  }

  const normalizedValue = String(value ?? "");
  const api = getSecureStoreApi();
  if (api?.setSecureStoreItem) {
    await api.setSecureStoreItem({
      key: normalizedKey,
      value: normalizedValue,
    });
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.setItem(normalizedKey, normalizedValue);
    return;
  }

  memoryFallback.set(normalizedKey, normalizedValue);
}

export async function removeSecureItem(key: string): Promise<void> {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return;
  }

  const api = getSecureStoreApi();
  if (api?.removeSecureStoreItem) {
    await api.removeSecureStoreItem({ key: normalizedKey });
    return;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    browserStorage.removeItem(normalizedKey);
    return;
  }

  memoryFallback.delete(normalizedKey);
}

export async function getSecureJson<TValue>(key: string): Promise<TValue | null> {
  const raw = await getSecureItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TValue;
  } catch {
    return null;
  }
}

export async function setSecureJson<TValue>(key: string, value: TValue): Promise<void> {
  await setSecureItem(key, JSON.stringify(value));
}

export const supabaseSecureStorage: SupportedStorage = {
  async getItem(key) {
    return getSecureItem(key);
  },
  async setItem(key, value) {
    await setSecureItem(key, value);
  },
  async removeItem(key) {
    await removeSecureItem(key);
  },
};
