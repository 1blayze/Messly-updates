import { getRuntimeAppApiUrl, getRuntimeGatewayUrl } from "./runtimeApiConfig";

export const DOMAIN = "messly.site";

export const API_URL = "https://messly.site";
export const CDN_URL = "https://messly.site";
export const GATEWAY_URL = "wss://messly.site";
export const ASSETS_URL = "https://messly.site";
const LOCAL_GATEWAY_HTTP_URL = "http://127.0.0.1:8788";
const LOCAL_GATEWAY_MEDIA_URL = "http://127.0.0.1:8788/media/public";
const LOCAL_GATEWAY_WS_URL = "ws://127.0.0.1:8788/gateway";
const DEV_API_PROXY_PATH = "/__messly_api";

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

function isLocalHostname(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function shouldUseDevApiProxy(baseUrlRaw: string | null | undefined): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }

  if (typeof window === "undefined" || !isLocalHostname(window.location.hostname)) {
    return false;
  }

  const normalized = normalizeUrl(baseUrlRaw);
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

export function getApiBaseUrl(): string {
  const explicit = normalizeUrl(import.meta.env.VITE_MESSLY_API_URL);
  const runtimeConfigured = getRuntimeAppApiUrl();
  const fallbackLocal =
    typeof window !== "undefined" && isLocalHostname(window.location.hostname) ? LOCAL_GATEWAY_HTTP_URL : null;
  const resolvedBaseUrl = explicit ?? runtimeConfigured ?? fallbackLocal ?? API_URL;

  if (shouldUseDevApiProxy(resolvedBaseUrl)) {
    return DEV_API_PROXY_PATH;
  }

  return resolvedBaseUrl;
}

export function getCdnBaseUrl(): string {
  const explicit = normalizeUrl(
    import.meta.env.VITE_MESSLY_CDN_URL
      ?? import.meta.env.VITE_MEDIA_PUBLIC_BASE_URL
      ?? import.meta.env.VITE_R2_PUBLIC_BASE_URL,
  );
  if (explicit) {
    return explicit;
  }

  if (typeof window !== "undefined" && isLocalHostname(window.location.hostname)) {
    return LOCAL_GATEWAY_MEDIA_URL;
  }

  return CDN_URL;
}

export function getAssetsBaseUrl(): string {
  const explicit = normalizeUrl(import.meta.env.VITE_MESSLY_ASSETS_URL);
  if (explicit) {
    return explicit;
  }

  return ASSETS_URL;
}

export function getGatewaySocketUrl(): string | null {
  const explicit = normalizeUrl(import.meta.env.VITE_MESSLY_GATEWAY_URL);
  if (explicit) {
    return explicit.endsWith("/gateway") ? explicit : `${explicit}/gateway`;
  }

  const runtimeConfigured = getRuntimeGatewayUrl();
  if (runtimeConfigured) {
    return runtimeConfigured.endsWith("/gateway") ? runtimeConfigured : `${runtimeConfigured}/gateway`;
  }

  if (typeof window !== "undefined" && isLocalHostname(window.location.hostname)) {
    return LOCAL_GATEWAY_WS_URL;
  }

  return `${GATEWAY_URL}/gateway`;
}

export function toCdnUrl(fileKey: string): string {
  const normalizedKey = String(fileKey ?? "").trim().replace(/^\/+/, "");
  return `${getCdnBaseUrl()}/${normalizedKey}`;
}
