import { getRuntimeAppApiUrl, getRuntimeGatewayUrl } from "./runtimeApiConfig";

export const DOMAIN = "messly.site";

export const API_URL = "https://messly.site";
export const CDN_URL = "https://messly.site";
export const GATEWAY_URL = "wss://gateway.messly.site/gateway";
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

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isLocalHostname(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
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
  const explicit = normalizeGatewaySocketUrl(import.meta.env.VITE_MESSLY_GATEWAY_URL);
  if (explicit) {
    if (shouldPreferLocalGatewayDuringDev(explicit)) {
      return LOCAL_GATEWAY_WS_URL;
    }
    return explicit;
  }

  const runtimeConfigured = normalizeGatewaySocketUrl(getRuntimeGatewayUrl());
  if (runtimeConfigured) {
    if (shouldPreferLocalGatewayDuringDev(runtimeConfigured)) {
      return LOCAL_GATEWAY_WS_URL;
    }
    return runtimeConfigured;
  }

  if (typeof window !== "undefined" && isLocalHostname(window.location.hostname)) {
    return LOCAL_GATEWAY_WS_URL;
  }

  return normalizeGatewaySocketUrl(GATEWAY_URL);
}

export function toCdnUrl(fileKey: string): string {
  const normalizedKey = String(fileKey ?? "").trim().replace(/^\/+/, "");
  return `${getCdnBaseUrl()}/${normalizedKey}`;
}
