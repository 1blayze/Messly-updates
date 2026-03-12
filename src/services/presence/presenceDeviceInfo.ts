import type { PresencePlatform } from "./presenceTypes";

const DEVICE_ID_STORAGE_KEY = "messly:presence:device-id";
const DEVICE_INFO_CACHE_PREFIX = "messly:presence:device-info:";
const DEVICE_INFO_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const LOCATION_REQUEST_TIMEOUT_MS = 4500;

export interface PresenceDeviceMetadata {
  platform: PresencePlatform;
  clientName: string;
  osName: string;
  locationLabel: string | null;
}

interface CachedPresenceDeviceMetadata extends PresenceDeviceMetadata {
  v: 1;
  locationSource: "ip" | "timezone" | "unknown";
  updatedAt: number;
}

function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `device-${Date.now()}-${random}`;
}

export function getOrCreatePresenceDeviceId(): string {
  if (typeof window === "undefined") {
    return "server-device";
  }

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = generateDeviceId();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return generateDeviceId();
  }
}

function getDeviceInfoCacheKey(deviceId: string): string {
  return `${DEVICE_INFO_CACHE_PREFIX}${deviceId}`;
}

function detectPresencePlatform(): PresencePlatform {
  if (typeof window !== "undefined" && window.electronAPI) {
    return "desktop";
  }

  if (typeof navigator !== "undefined" && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)) {
    return "mobile";
  }

  return "browser";
}

function detectOsName(): string {
  const electronPlatform = typeof window !== "undefined" ? String(window.electronAPI?.platform ?? "").trim() : "";
  switch (electronPlatform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      break;
  }

  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  if (/android/.test(userAgent)) {
    return "Android";
  }
  if (/ipad/.test(userAgent)) {
    return "iPadOS";
  }
  if (/iphone|ipod/.test(userAgent)) {
    return "iOS";
  }
  if (/windows nt/.test(userAgent)) {
    return "Windows";
  }
  if (/cros/.test(userAgent)) {
    return "ChromeOS";
  }
  if (/mac os x|macintosh/.test(userAgent)) {
    return "macOS";
  }
  if (/linux/.test(userAgent)) {
    return "Linux";
  }
  return "Sistema desconhecido";
}

function detectBrowserClientName(): string {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  if (/edg\//.test(userAgent)) {
    return "Edge";
  }
  if (/opr\//.test(userAgent) || /opera/.test(userAgent)) {
    return "Opera";
  }
  if (/firefox\//.test(userAgent)) {
    return "Firefox";
  }
  if (/samsungbrowser\//.test(userAgent)) {
    return "Samsung Internet";
  }
  if (/crios\//.test(userAgent) || (/chrome\//.test(userAgent) && !/edg\//.test(userAgent) && !/opr\//.test(userAgent))) {
    return "Chrome";
  }
  if (/version\//.test(userAgent) && /safari\//.test(userAgent)) {
    return "Safari";
  }
  return "Navegador";
}

function detectClientName(platform: PresencePlatform): string {
  if (typeof window !== "undefined" && window.electronAPI) {
    return "Messly Desktop";
  }

  const browserName = detectBrowserClientName();
  if (platform === "mobile" && browserName !== "Navegador") {
    return browserName;
  }

  return browserName;
}

function buildLocationLabel(cityRaw: unknown, regionRaw: unknown, countryRaw: unknown): string | null {
  const parts = [cityRaw, regionRaw, countryRaw]
    .map((value) => String(value ?? "").trim())
    .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

  return parts.length > 0 ? parts.join(", ") : null;
}

function readCachedDeviceMetadata(deviceId: string): CachedPresenceDeviceMetadata | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getDeviceInfoCacheKey(deviceId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedPresenceDeviceMetadata>;
    if (parsed.v !== 1) {
      return null;
    }
    if (parsed.platform !== "desktop" && parsed.platform !== "mobile" && parsed.platform !== "browser") {
      return null;
    }
    return {
      v: 1,
      platform: parsed.platform,
      clientName: String(parsed.clientName ?? "").trim() || detectClientName(parsed.platform),
      osName: String(parsed.osName ?? "").trim() || detectOsName(),
      locationLabel: String(parsed.locationLabel ?? "").trim() || null,
      locationSource:
        parsed.locationSource === "ip" || parsed.locationSource === "timezone" || parsed.locationSource === "unknown"
          ? parsed.locationSource
          : "unknown",
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

function writeCachedDeviceMetadata(deviceId: string, value: CachedPresenceDeviceMetadata): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(getDeviceInfoCacheKey(deviceId), JSON.stringify(value));
  } catch {
    // Ignore storage failures.
  }
}

function buildBasePresenceDeviceMetadata(): PresenceDeviceMetadata {
  const platform = detectPresencePlatform();
  return {
    platform,
    clientName: detectClientName(platform),
    osName: detectOsName(),
    locationLabel: null,
  };
}

async function fetchApproximateLocationLabel(): Promise<string | null> {
  if (typeof fetch !== "function") {
    return null;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId =
    controller && typeof window !== "undefined"
      ? window.setTimeout(() => {
          controller.abort();
        }, LOCATION_REQUEST_TIMEOUT_MS)
      : null;

  try {
    const ipapiResponse = await fetch("https://ipapi.co/json/", {
      method: "GET",
      cache: "no-store",
      signal: controller?.signal,
    });

    if (ipapiResponse.ok) {
      const ipapiPayload = (await ipapiResponse.json()) as {
        error?: boolean;
        city?: unknown;
        region?: unknown;
        country_name?: unknown;
      };

      if (ipapiPayload.error !== true) {
        const ipapiLocation = buildLocationLabel(ipapiPayload.city, ipapiPayload.region, ipapiPayload.country_name);
        if (ipapiLocation) {
          return ipapiLocation;
        }
      }
    }

    const ipwhoResponse = await fetch("https://ipwho.is/?fields=success,city,region,country", {
      method: "GET",
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!ipwhoResponse.ok) {
      return null;
    }

    const payload = (await ipwhoResponse.json()) as {
      success?: boolean;
      city?: unknown;
      region?: unknown;
      country?: unknown;
    };

    if (payload.success === false) {
      return null;
    }

    return buildLocationLabel(payload.city, payload.region, payload.country);
  } catch {
    return null;
  } finally {
    if (timeoutId != null && typeof window !== "undefined") {
      window.clearTimeout(timeoutId);
    }
  }
}

export function getPresenceDeviceMetadataSnapshot(): PresenceDeviceMetadata {
  const deviceId = getOrCreatePresenceDeviceId();
  const base = buildBasePresenceDeviceMetadata();
  const cached = readCachedDeviceMetadata(deviceId);
  if (!cached || cached.locationSource === "timezone") {
    return base;
  }

  return {
    platform: base.platform,
    clientName: base.clientName,
    osName: base.osName,
    locationLabel: cached.locationLabel ?? null,
  };
}

export async function hydratePresenceDeviceMetadata(): Promise<PresenceDeviceMetadata> {
  const deviceId = getOrCreatePresenceDeviceId();
  const base = buildBasePresenceDeviceMetadata();
  const cached = readCachedDeviceMetadata(deviceId);

  if (cached && cached.locationSource !== "timezone" && Date.now() - cached.updatedAt <= DEVICE_INFO_CACHE_TTL_MS) {
    return {
      platform: base.platform,
      clientName: base.clientName,
      osName: base.osName,
      locationLabel: cached.locationLabel ?? null,
    };
  }

  const fallbackLocation = cached?.locationSource === "ip" ? cached.locationLabel ?? null : null;
  const remoteLocation = await fetchApproximateLocationLabel();
  const locationLabel = remoteLocation ?? fallbackLocation ?? null;
  const persisted: CachedPresenceDeviceMetadata = {
    v: 1,
    platform: base.platform,
    clientName: base.clientName,
    osName: base.osName,
    locationLabel,
    locationSource: remoteLocation || fallbackLocation ? "ip" : "unknown",
    updatedAt: Date.now(),
  };
  writeCachedDeviceMetadata(deviceId, persisted);

  return {
    platform: persisted.platform,
    clientName: persisted.clientName,
    osName: persisted.osName,
    locationLabel: persisted.locationLabel,
  };
}
