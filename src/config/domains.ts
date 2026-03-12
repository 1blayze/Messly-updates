import { getRuntimeAppApiUrl, getRuntimeGatewayUrl } from "./runtimeApiConfig";

export const DOMAIN = "messly.site";
export const WEB_ORIGIN = "https://messly.site";

export const API_URL = "https://messly.site/api";
export const CDN_URL = "https://cdn.messly.site";
export const GATEWAY_URL = "wss://gateway.messly.site/gateway";
export const ASSETS_URL = "https://messly.site";
export const PROFILE_MEDIA_PROXY_PATH = "/media/upload/profile";
const LOCAL_GATEWAY_HTTP_URL = "http://127.0.0.1:8788";
const LOCAL_GATEWAY_MEDIA_URL = "http://127.0.0.1:8788/media/public";
const LOCAL_GATEWAY_WS_URL = "ws://127.0.0.1:8788/gateway";
const DEV_API_PROXY_PATH = "/__messly_api";
const LEGACY_PUBLIC_MEDIA_ENV_KEYS = ["VITE_MEDIA_PUBLIC_BASE_URL", "VITE_R2_PUBLIC_BASE_URL"] as const;

let cachedCdnBaseUrl: string | null = null;
let cachedCdnBaseUrlInitialized = false;

function canonicalizeMesslyDomainHost(valueRaw: string): string {
  try {
    const parsed = new URL(valueRaw);
    if (parsed.hostname.toLowerCase() === "www.messly.site") {
      parsed.hostname = "messly.site";
    }
    return parsed.toString();
  } catch {
    return valueRaw;
  }
}

function normalizeUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  return canonicalizeMesslyDomainHost(normalized).replace(/\/+$/, "");
}

function normalizeApiBaseUrl(valueRaw: string | null | undefined): string | null {
  const normalized = normalizeUrl(valueRaw);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if ((hostname === "messly.site" || hostname === "www.messly.site") && (!parsed.pathname || parsed.pathname === "/")) {
      parsed.pathname = "/api";
      return parsed.toString().replace(/\/+$/, "");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function hasExplicitProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+\-.]*:\/\//i.test(value);
}

function normalizeGatewaySocketUrl(valueRaw: string | null | undefined): string | null {
  const value = String(valueRaw ?? "").trim();
  if (!value) {
    return null;
  }

  const candidate = hasExplicitProtocol(value) ? value : `wss://${value}`;

  try {
    const parsed = new URL(canonicalizeMesslyDomainHost(candidate));
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }

    parsed.search = "";
    parsed.hash = "";

    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    if (!trimmedPath || trimmedPath === "/") {
      parsed.pathname = "/gateway";
    } else {
      parsed.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "messly.site" || hostname === "www.messly.site") {
      parsed.hostname = "gateway.messly.site";
      parsed.port = "";
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function logGatewayProductionFallback(received: string, source: "explicit" | "runtime"): void {
  console.error("invalid production gateway url", {
    source,
    received,
    expected: GATEWAY_URL,
  });
}

function isLocalHostname(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isRawR2StorageHostname(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname.endsWith(".r2.dev") || hostname.endsWith(".r2.cloudflarestorage.com");
}

function isPublicMesslyGatewayHost(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "gateway.messly.site" || hostname === "messly.site" || hostname === "www.messly.site";
}

function shouldPreferLocalGatewayDuringDev(candidateUrlRaw: string | null | undefined): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  if (!isLocalHostname(window.location.hostname)) {
    return false;
  }

  const normalizedCandidate = normalizeGatewaySocketUrl(candidateUrlRaw);
  if (!normalizedCandidate) {
    return false;
  }

  try {
    const parsed = new URL(normalizedCandidate);
    return !isLocalHostname(parsed.hostname) && isPublicMesslyGatewayHost(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldRejectGatewayInProduction(candidateUrlRaw: string | null | undefined): boolean {
  if (!import.meta.env.PROD) {
    return false;
  }

  const normalizedCandidate = normalizeGatewaySocketUrl(candidateUrlRaw);
  if (!normalizedCandidate) {
    return true;
  }

  try {
    const parsed = new URL(normalizedCandidate);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "wss:") {
      return true;
    }
    if (isLocalHostname(hostname)) {
      return true;
    }
    if (hostname === "messly.site" || hostname === "www.messly.site") {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function shouldUseDevApiProxy(baseUrlRaw: string | null | undefined): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }

  if (typeof window === "undefined" || !isLocalHostname(window.location.hostname)) {
    return false;
  }

  const normalized = normalizeApiBaseUrl(baseUrlRaw);
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "messly.site" || hostname === "www.messly.site";
  } catch {
    return false;
  }
}

function shouldUseLocalGatewayFallback(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  return isLocalHostname(window.location.hostname);
}

function normalizeHttpUrl(valueRaw: string | null | undefined): string | null {
  const normalized = normalizeUrl(valueRaw);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveCdnBaseUrl(): { url: string; source: string; fallbackDetected: boolean } {
  const explicitPrimary = normalizeHttpUrl(import.meta.env.VITE_MESSLY_CDN_URL);
  if (explicitPrimary) {
    return { url: explicitPrimary, source: "VITE_MESSLY_CDN_URL", fallbackDetected: false };
  }

  for (const key of LEGACY_PUBLIC_MEDIA_ENV_KEYS) {
    const value = normalizeHttpUrl(import.meta.env[key]);
    if (value) {
      return { url: value, source: key, fallbackDetected: true };
    }
  }

  if (shouldUseLocalGatewayFallback()) {
    return { url: LOCAL_GATEWAY_MEDIA_URL, source: "local-gateway-dev-fallback", fallbackDetected: true };
  }

  return { url: CDN_URL, source: "default-cdn-constant", fallbackDetected: false };
}

function assertProductionMediaBaseUrl(url: string): void {
  const expected = "https://<custom-domain>";
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const blocked =
      parsed.protocol !== "https:" ||
      isLocalHostname(hostname) ||
      isRawR2StorageHostname(hostname);
    if (!blocked) {
      return;
    }
  } catch {
    // handled below
  }
  console.error("invalid production media base url", {
    received: url,
    expected,
  });
  throw new Error(`Invalid production media base URL: ${url}`);
}

function ensureCdnBaseUrlResolved(): string {
  if (cachedCdnBaseUrlInitialized && cachedCdnBaseUrl) {
    return cachedCdnBaseUrl;
  }

  const mode = import.meta.env.PROD ? "production" : "development";
  const resolved = resolveCdnBaseUrl();
  if (import.meta.env.PROD) {
    assertProductionMediaBaseUrl(resolved.url);
  }

  console.info("public media base url selected", {
    mode,
    source: resolved.source,
    url: resolved.url,
  });
  if (resolved.fallbackDetected) {
    console.warn("cdn fallback detected", {
      mode,
      source: resolved.source,
      url: resolved.url,
    });
  }

  try {
    const parsed = new URL(resolved.url);
    const hostname = parsed.hostname.toLowerCase();
    if (!isLocalHostname(hostname) && !isRawR2StorageHostname(hostname)) {
      console.info("custom domain active", {
        mode,
        hostname,
      });
    }
  } catch {
    // noop
  }

  cachedCdnBaseUrl = resolved.url;
  cachedCdnBaseUrlInitialized = true;
  return resolved.url;
}

export function getApiBaseUrl(): string {
  const explicit = normalizeApiBaseUrl(import.meta.env.VITE_MESSLY_API_URL);
  const runtimeConfigured = normalizeApiBaseUrl(getRuntimeAppApiUrl());
  const fallbackLocal = shouldUseLocalGatewayFallback() ? LOCAL_GATEWAY_HTTP_URL : null;
  const resolvedBaseUrl = explicit ?? runtimeConfigured ?? fallbackLocal ?? API_URL;

  if (shouldUseDevApiProxy(resolvedBaseUrl)) {
    return DEV_API_PROXY_PATH;
  }

  return resolvedBaseUrl;
}

export function getCdnBaseUrl(): string {
  return ensureCdnBaseUrlResolved();
}

export function getAssetsBaseUrl(): string {
  const explicit = normalizeUrl(import.meta.env.VITE_MESSLY_ASSETS_URL);
  if (explicit) {
    return explicit;
  }

  return ASSETS_URL;
}

export function getGatewaySocketUrl(): string | null {
  const explicit = normalizeGatewaySocketUrl(import.meta.env.VITE_MESSLY_GATEWAY_URL);
  if (explicit) {
    if (shouldRejectGatewayInProduction(explicit)) {
      logGatewayProductionFallback(explicit, "explicit");
      return normalizeGatewaySocketUrl(GATEWAY_URL);
    }
    if (shouldPreferLocalGatewayDuringDev(explicit)) {
      return LOCAL_GATEWAY_WS_URL;
    }
    return explicit;
  }

  const runtimeConfigured = normalizeGatewaySocketUrl(getRuntimeGatewayUrl());
  if (runtimeConfigured) {
    if (shouldRejectGatewayInProduction(runtimeConfigured)) {
      logGatewayProductionFallback(runtimeConfigured, "runtime");
      return normalizeGatewaySocketUrl(GATEWAY_URL);
    }
    if (shouldPreferLocalGatewayDuringDev(runtimeConfigured)) {
      return LOCAL_GATEWAY_WS_URL;
    }
    return runtimeConfigured;
  }

  if (shouldUseLocalGatewayFallback()) {
    return LOCAL_GATEWAY_WS_URL;
  }

  return normalizeGatewaySocketUrl(GATEWAY_URL);
}

export function getCanonicalWebOrigin(): string {
  return WEB_ORIGIN;
}

export function getProfileMediaUploadUrl(): string {
  return `${getApiBaseUrl()}${PROFILE_MEDIA_PROXY_PATH}`;
}

export function toCdnUrl(fileKey: string): string {
  const normalizedKey = String(fileKey ?? "").trim().replace(/^\/+/, "");
  return `${getCdnBaseUrl()}/${normalizedKey}`;
}
