import { getCdnBaseUrl, toCdnUrl } from "../../config/domains";
import { invokeEdgeJson } from "../edge/edgeClient";
import defaultAvatarSvgRaw from "../../assets/img/default-avatar.svg?raw";

const PROFILE_AVATAR_PREFIX = "avatars/";
const PROFILE_BANNER_PREFIX = "banners/";
const ATTACHMENT_PREFIXES = ["attachments/", "messages/"] as const;
const SAFE_MEDIA_KEY_REGEX = /^[a-z0-9/_\-.]+$/i;
const SAFE_HASH_REGEX = /^[a-f0-9]{32,128}$/i;
const DEFAULT_AVATAR_BACKGROUND_COLORS = [
  "#000000",
  "#FF4DA6",
  "#8B5CF6",
  "#EF4444",
  "#3B82F6",
  "#22C55E",
] as const;
const DEFAULT_AVATAR_MARKER = "data-messly-default-avatar";
const DEFAULT_AVATAR_CANVAS_SIZE = 256;
const DEFAULT_AVATAR_ICON_SIZE_RATIO = 0.74;
const DEFAULT_AVATAR_ICON_WIDTH = DEFAULT_AVATAR_CANVAS_SIZE * DEFAULT_AVATAR_ICON_SIZE_RATIO;
const DEFAULT_AVATAR_ICON_HEIGHT = (DEFAULT_AVATAR_ICON_WIDTH * 135) / 190;
const DEFAULT_AVATAR_ICON_X = (DEFAULT_AVATAR_CANVAS_SIZE - DEFAULT_AVATAR_ICON_WIDTH) / 2;
const DEFAULT_AVATAR_ICON_Y = (DEFAULT_AVATAR_CANVAS_SIZE - DEFAULT_AVATAR_ICON_HEIGHT) / 2;
const DEFAULT_AVATAR_INNER_SVG = defaultAvatarSvgRaw
  .replace(/<svg[^>]*>/i, "")
  .replace(/<\/svg>\s*$/i, "")
  .replace(/\r?\n+/g, " ")
  .replace(/\s{2,}/g, " ")
  .trim();

const SIGNED_URL_EXPIRES_SECONDS = 300;
const SIGNED_URL_REFRESH_BUFFER_MS = 30 * 1000;
const DEFAULT_BANNER_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 480"><rect width="1200" height="480" fill="#000"/></svg>',
)}`;
const signedMediaCache = new Map<string, { url: string; expiresAt: number }>();
const signedMediaInFlight = new Map<string, Promise<{ url: string; expiresAt: number } | null>>();
const signedMediaCacheKeyByUrl = new Map<string, string>();
const signedMediaKeyByCacheKey = new Map<string, string>();
const warmedImageUrls = new Map<string, number>();

function normalizeAvatarSeed(seedRaw: string | null | undefined): string {
  const normalized = String(seedRaw ?? "").trim().toLowerCase();
  return normalized || "default-avatar";
}

function hashAvatarSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getDefaultAvatarBackgroundColor(seedRaw: string | null | undefined): string {
  const seed = normalizeAvatarSeed(seedRaw);
  const index = hashAvatarSeed(seed) % DEFAULT_AVATAR_BACKGROUND_COLORS.length;
  return DEFAULT_AVATAR_BACKGROUND_COLORS[index] ?? DEFAULT_AVATAR_BACKGROUND_COLORS[0];
}

function buildDefaultAvatarUrl(seedRaw: string | null | undefined): string {
  const backgroundColor = getDefaultAvatarBackgroundColor(seedRaw);
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" ${DEFAULT_AVATAR_MARKER}="1" viewBox="0 0 ${DEFAULT_AVATAR_CANVAS_SIZE} ${DEFAULT_AVATAR_CANVAS_SIZE}"><rect width="${DEFAULT_AVATAR_CANVAS_SIZE}" height="${DEFAULT_AVATAR_CANVAS_SIZE}" rx="${DEFAULT_AVATAR_CANVAS_SIZE / 2}" ry="${DEFAULT_AVATAR_CANVAS_SIZE / 2}" fill="${backgroundColor}" shape-rendering="geometricPrecision"/><svg x="${DEFAULT_AVATAR_ICON_X}" y="${DEFAULT_AVATAR_ICON_Y}" width="${DEFAULT_AVATAR_ICON_WIDTH}" height="${DEFAULT_AVATAR_ICON_HEIGHT}" viewBox="0 0 190 135" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${DEFAULT_AVATAR_INNER_SVG}</svg></svg>`,
  )}`;
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

function hasExplicitPublicMediaBaseUrl(): boolean {
  return Boolean(
    String(
      import.meta.env.VITE_MESSLY_CDN_URL
        ?? import.meta.env.VITE_MEDIA_PUBLIC_BASE_URL
        ?? import.meta.env.VITE_R2_PUBLIC_BASE_URL
        ?? "",
    ).trim(),
  );
}

function shouldUsePublicCdn(): boolean {
  if (hasExplicitPublicMediaBaseUrl()) {
    return true;
  }

  if (typeof window === "undefined") {
    return true;
  }

  if (typeof window.electronAPI !== "undefined") {
    return false;
  }

  const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  return true;
}

function clearSignedMediaCacheEntry(cacheKey: string): void {
  const previous = signedMediaCache.get(cacheKey);
  if (previous?.url) {
    signedMediaCacheKeyByUrl.delete(previous.url);
  }
  signedMediaCache.delete(cacheKey);
  signedMediaKeyByCacheKey.delete(cacheKey);
}

function trackSignedMediaCacheEntry(cacheKey: string, mediaKey: string, entry: { url: string; expiresAt: number }): void {
  const previous = signedMediaCache.get(cacheKey);
  if (previous?.url && previous.url !== entry.url) {
    signedMediaCacheKeyByUrl.delete(previous.url);
  }
  signedMediaCache.set(cacheKey, entry);
  signedMediaKeyByCacheKey.set(cacheKey, mediaKey);
  signedMediaCacheKeyByUrl.set(entry.url, cacheKey);
}

function getCachedSignedUrl(cacheKey: string): string | null {
  const cached = signedMediaCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt - SIGNED_URL_REFRESH_BUFFER_MS <= Date.now()) {
    clearSignedMediaCacheEntry(cacheKey);
    return null;
  }

  return cached.url;
}

function warmImageUrl(rawUrl: string | null | undefined): void {
  const url = String(rawUrl ?? "").trim();
  if (!url || typeof Image === "undefined" || url.startsWith("data:") || url.startsWith("blob:")) {
    return;
  }

  const now = Date.now();
  const warmedAt = warmedImageUrls.get(url) ?? 0;
  if (now - warmedAt < 60_000) {
    return;
  }
  warmedImageUrls.set(url, now);

  try {
    const image = new Image();
    image.decoding = "async";
    image.loading = "eager";
    image.src = url;
    if (typeof image.decode === "function") {
      void image.decode().catch(() => undefined);
    }
  } catch {
    // noop
  }
}

async function fetchSignedMediaUrlFromElectron(mediaKey: string): Promise<{ url: string; expiresAt: number } | null> {
  const getSignedMediaUrl = window.electronAPI?.getSignedMediaUrl;
  if (!getSignedMediaUrl) {
    return null;
  }

  try {
    const signed = await getSignedMediaUrl({
      key: mediaKey,
      expiresSeconds: SIGNED_URL_EXPIRES_SECONDS,
    });

    if (signed?.url) {
      return {
        url: signed.url,
        expiresAt: signed.expiresAt || Date.now() + SIGNED_URL_EXPIRES_SECONDS * 1000,
      };
    }
  } catch {
    // noop
  }

  return null;
}

async function fetchSignedMediaUrlFromEdge(mediaKey: string): Promise<{ url: string; expiresAt: number } | null> {
  try {
    const data = await invokeEdgeJson<{ key: string; action: "get" }, { url?: string; expiresIn?: number }>(
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
  } catch {
    // noop
  }

  return null;
}

async function fetchSignedMediaUrl(
  mediaKey: string,
  options?: {
    preferEdge?: boolean;
  },
): Promise<{ url: string; expiresAt: number } | null> {
  const inFlight = signedMediaInFlight.get(mediaKey);
  if (inFlight) {
    return inFlight;
  }

  const preferEdge = options?.preferEdge === true;
  const request = (async () => {
    if (preferEdge) {
      const edgeSigned = await fetchSignedMediaUrlFromEdge(mediaKey);
      if (edgeSigned) {
        return edgeSigned;
      }
      return fetchSignedMediaUrlFromElectron(mediaKey);
    }

    const electronSigned = await fetchSignedMediaUrlFromElectron(mediaKey);
    if (electronSigned) {
      return electronSigned;
    }

    return fetchSignedMediaUrlFromEdge(mediaKey);
  })();

  signedMediaInFlight.set(mediaKey, request);
  try {
    return await request;
  } finally {
    if (signedMediaInFlight.get(mediaKey) === request) {
      signedMediaInFlight.delete(mediaKey);
    }
  }
}

async function resolveMediaUrl(mediaKeyRaw: string | null | undefined, mediaHashRaw?: string | null): Promise<string> {
  const absoluteMediaUrl = sanitizeAbsoluteMediaUrl(mediaKeyRaw);
  if (absoluteMediaUrl) {
    return appendHashToUrl(absoluteMediaUrl, sanitizeMediaHash(mediaHashRaw));
  }

  const safeKey = sanitizeMediaKey(mediaKeyRaw);
  if (!safeKey) {
    return "";
  }

  const safeHash = sanitizeMediaHash(mediaHashRaw);
  if (shouldUsePublicCdn()) {
    return appendHashToUrl(toCdnUrl(safeKey), safeHash);
  }

  const cacheKey = safeHash ? `${safeKey}:${safeHash}` : safeKey;
  const cached = getCachedSignedUrl(cacheKey);
  if (cached) {
    warmImageUrl(cached);
    return cached;
  }

  const signed = await fetchSignedMediaUrl(safeKey);
  if (!signed) {
    return appendHashToUrl(`${getCdnBaseUrl()}/${safeKey}`, safeHash);
  }

  trackSignedMediaCacheEntry(cacheKey, safeKey, signed);
  warmImageUrl(signed.url);
  return signed.url;
}

export async function refreshFailedSignedMediaUrl(rawUrl: string | null | undefined): Promise<string | null> {
  const normalizedUrl = sanitizeAbsoluteMediaUrl(rawUrl);
  if (!normalizedUrl || shouldUsePublicCdn()) {
    return null;
  }

  const cacheKey = signedMediaCacheKeyByUrl.get(normalizedUrl);
  if (!cacheKey) {
    return null;
  }

  const mediaKey = sanitizeMediaKey(signedMediaKeyByCacheKey.get(cacheKey) ?? cacheKey.split(":")[0] ?? null);
  if (!mediaKey) {
    clearSignedMediaCacheEntry(cacheKey);
    return null;
  }

  clearSignedMediaCacheEntry(cacheKey);
  signedMediaInFlight.delete(mediaKey);

  const refreshed = await fetchSignedMediaUrl(mediaKey, { preferEdge: true });
  if (!refreshed) {
    return null;
  }

  trackSignedMediaCacheEntry(cacheKey, mediaKey, refreshed);
  warmImageUrl(refreshed.url);
  return refreshed.url;
}

export function getDefaultAvatarUrl(seed?: string | null): string {
  return buildDefaultAvatarUrl(seed);
}

export function isDefaultAvatarUrl(url: string | null | undefined): boolean {
  return String(url ?? "").includes(DEFAULT_AVATAR_MARKER);
}

export function getNameAvatarUrl(seed: string): string {
  return buildDefaultAvatarUrl(seed);
}

export function getDefaultBannerUrl(): string {
  return DEFAULT_BANNER_PLACEHOLDER;
}

export function isDefaultBannerUrl(url: string | null | undefined): boolean {
  return String(url ?? "") === DEFAULT_BANNER_PLACEHOLDER;
}

export async function getAvatarUrl(
  userId: string | null | undefined,
  avatarKey: string | null | undefined,
  avatarHash: string | null | undefined,
): Promise<string> {
  const safeKey = sanitizeMediaKey(avatarKey);
  if (!safeKey || !safeKey.startsWith(PROFILE_AVATAR_PREFIX)) {
    return getDefaultAvatarUrl(userId);
  }

  return resolveMediaUrl(safeKey, avatarHash);
}

export async function getBannerUrl(
  _userId: string | null | undefined,
  bannerKey: string | null | undefined,
  bannerHash: string | null | undefined,
): Promise<string> {
  const safeKey = sanitizeMediaKey(bannerKey);
  if (!safeKey || !safeKey.startsWith(PROFILE_BANNER_PREFIX)) {
    return DEFAULT_BANNER_PLACEHOLDER;
  }

  return resolveMediaUrl(safeKey, bannerHash);
}

export async function getAttachmentUrl(mediaKeyOrUrl: string | null | undefined): Promise<string> {
  const absoluteMediaUrl = sanitizeAbsoluteMediaUrl(mediaKeyOrUrl);
  if (absoluteMediaUrl) {
    return absoluteMediaUrl;
  }

  const safeKey = sanitizeMediaKey(mediaKeyOrUrl);
  if (!safeKey || !ATTACHMENT_PREFIXES.some((prefix) => safeKey.startsWith(prefix))) {
    return String(mediaKeyOrUrl ?? "");
  }

  return resolveMediaUrl(safeKey);
}
