import { invokeEdgeJson } from "../edge/edgeClient";

const PROFILE_AVATAR_PREFIX = "avatars/";
const PROFILE_BANNER_PREFIX = "banners/";
const ATTACHMENT_PREFIX = "attachments/";
const SAFE_MEDIA_KEY_REGEX = /^[a-z0-9/_\-.]+$/i;
const SAFE_HASH_REGEX = /^[a-f0-9]{32,128}$/i;

const SIGNED_URL_EXPIRES_SECONDS = 300;
const SIGNED_URL_REFRESH_BUFFER_MS = 30 * 1000;
const DEFAULT_BANNER_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2b2d34" offset="0"/><stop stop-color="#343741" offset="1"/></linearGradient></defs><rect width="1200" height="480" fill="url(#g)"/></svg>',
)}`;
const DEFAULT_AVATAR_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#3a4150"/><stop offset="100%" stop-color="#252b36"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="96" r="42" fill="#d8dde8"/><path d="M52 208c0-38 34-66 76-66s76 28 76 66v8H52v-8z" fill="#d8dde8"/></svg>',
)}`;
const nameAvatarCache = new Map<string, string>();

function getFirstDisplayLetter(name: string): string {
  const normalized = name.trim().replace(/^@+/, "");
  if (!normalized) {
    return "U";
  }

  const char = normalized.charAt(0).toLocaleUpperCase();
  return char || "U";
}

interface SignedMediaCacheEntry {
  url: string;
  expiresAt: number;
}

const signedMediaCache = new Map<string, SignedMediaCacheEntry>();

function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
}

function appendHashToUrl(url: string, hash: string | null): string {
  if (!hash) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("v", hash);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${hash}`;
  }
}

function sanitizeMediaKey(rawKey: string | null | undefined): string | null {
  if (!rawKey) {
    return null;
  }

  const trimmed = rawKey.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("//")) {
    return null;
  }

  if (!SAFE_MEDIA_KEY_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function sanitizeMediaHash(rawHash: string | null | undefined): string | null {
  if (!rawHash) {
    return null;
  }

  const trimmed = rawHash.trim();
  if (!trimmed || !SAFE_HASH_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
}

function sanitizeAbsoluteMediaUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getCachedSignedUrl(cacheKey: string): string | null {
  const cached = signedMediaCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt - SIGNED_URL_REFRESH_BUFFER_MS <= Date.now()) {
    signedMediaCache.delete(cacheKey);
    return null;
  }

  return cached.url;
}

async function fetchSignedMediaUrl(mediaKey: string): Promise<SignedMediaCacheEntry | null> {
  const getSignedMediaUrl = window.electronAPI?.getSignedMediaUrl;
  if (getSignedMediaUrl) {
    try {
      const signed = await getSignedMediaUrl({
        key: mediaKey,
        expiresSeconds: SIGNED_URL_EXPIRES_SECONDS,
      });

      if (!signed?.url) {
        return null;
      }

      const expiresAt =
        typeof signed.expiresAt === "number" && Number.isFinite(signed.expiresAt)
          ? signed.expiresAt
          : Date.now() + SIGNED_URL_EXPIRES_SECONDS * 1000;

      return {
        url: signed.url,
        expiresAt,
      };
    } catch {}
  }

  try {
    const data = await invokeEdgeJson<
      { key: string; action: "get" },
      { url?: string; expiresIn?: number }
    >(
      "r2-presign",
      {
        key: mediaKey,
        action: "get",
      },
      {
        retries: 1,
        timeoutMs: 15_000,
      },
    );

    if (data?.url) {
      const expiresIn = Number(data.expiresIn ?? SIGNED_URL_EXPIRES_SECONDS);
      return {
        url: String(data.url),
        expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : SIGNED_URL_EXPIRES_SECONDS) * 1000,
      };
    }
  } catch {}

  return null;
}

async function resolveProfileMediaUrl(
  mediaKeyRaw: string | null | undefined,
  mediaHashRaw: string | null | undefined,
  requiredPrefix: string,
  fallbackUrl: string,
): Promise<string> {
  const absoluteMediaUrl = sanitizeAbsoluteMediaUrl(mediaKeyRaw);
  if (absoluteMediaUrl) {
    return appendHashToUrl(absoluteMediaUrl, sanitizeMediaHash(mediaHashRaw));
  }

  const safeKey = sanitizeMediaKey(mediaKeyRaw);
  const safeHash = sanitizeMediaHash(mediaHashRaw);

  if (!safeKey || !safeKey.startsWith(requiredPrefix)) {
    return fallbackUrl;
  }

  const cacheKey = safeHash ? `${safeKey}:${safeHash}` : safeKey;
  const cachedUrl = getCachedSignedUrl(cacheKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  const signed = await fetchSignedMediaUrl(safeKey);
  if (!signed) {
    return fallbackUrl;
  }

  signedMediaCache.set(cacheKey, signed);
  return signed.url;
}

export function getDefaultAvatarUrl(): string {
  return DEFAULT_AVATAR_PLACEHOLDER;
}

export function isDefaultAvatarUrl(url: string | null | undefined): boolean {
  return String(url ?? "") === DEFAULT_AVATAR_PLACEHOLDER;
}

export function getNameAvatarUrl(name: string): string {
  const letter = getFirstDisplayLetter(name);
  const cached = nameAvatarCache.get(letter);
  if (cached) {
    return cached;
  }

  const svg = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4f5bd5"/><stop offset="100%" stop-color="#2f3542"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" fill="#f2f3f5" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="112" font-weight="700">${letter}</text></svg>`,
  )}`;

  nameAvatarCache.set(letter, svg);
  return svg;
}

export function getDefaultBannerUrl(): string {
  return DEFAULT_BANNER_PLACEHOLDER;
}

export function isDefaultBannerUrl(url: string | null | undefined): boolean {
  return String(url ?? "") === DEFAULT_BANNER_PLACEHOLDER;
}

export async function getAvatarUrl(
  _userId: string | null | undefined,
  avatarKey: string | null | undefined,
  avatarHash: string | null | undefined,
): Promise<string> {
  return resolveProfileMediaUrl(avatarKey, avatarHash, PROFILE_AVATAR_PREFIX, DEFAULT_AVATAR_PLACEHOLDER);
}

export async function getBannerUrl(
  _userId: string | null | undefined,
  bannerKey: string | null | undefined,
  bannerHash: string | null | undefined,
): Promise<string> {
  return resolveProfileMediaUrl(bannerKey, bannerHash, PROFILE_BANNER_PREFIX, DEFAULT_BANNER_PLACEHOLDER);
}

export async function getAttachmentUrl(mediaKeyOrUrl: string | null | undefined): Promise<string> {
  const absoluteMediaUrl = sanitizeAbsoluteMediaUrl(mediaKeyOrUrl);
  if (absoluteMediaUrl) {
    return absoluteMediaUrl;
  }

  const safeKey = sanitizeMediaKey(mediaKeyOrUrl);
  if (!safeKey || !safeKey.startsWith(ATTACHMENT_PREFIX)) {
    return String(mediaKeyOrUrl ?? "");
  }

  const cachedUrl = getCachedSignedUrl(safeKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  const signed = await fetchSignedMediaUrl(safeKey);
  if (!signed) {
    return "";
  }

  signedMediaCache.set(safeKey, signed);
  return signed.url;
}
