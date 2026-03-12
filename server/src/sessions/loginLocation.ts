import type { IncomingHttpHeaders } from "node:http";

export interface LoginLocation {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  locationLabel: string | null;
}

const IP_LOOKUP_TIMEOUT_MS = 2_500;
const LOCATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const IPV6_REGEX =
  /^(?:[a-fA-F0-9]{1,4}(?::[a-fA-F0-9]{1,4}){1,7}|::1|::|[a-fA-F0-9]{1,4}::(?:[a-fA-F0-9]{1,4}:?){0,5}[a-fA-F0-9]{0,4})$/;

const locationCache = new Map<string, { value: LoginLocation; expiresAtMs: number }>();

function isValidIp(value: string): boolean {
  return IPV4_REGEX.test(value) || IPV6_REGEX.test(value);
}

function normalizeLocationField(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
  return normalized || null;
}

function buildLocationLabel(city: string | null, region: string | null, country: string | null): string | null {
  const parts = [city, region, country].filter((value, index, array): value is string => {
    if (!value) {
      return false;
    }
    return array.indexOf(value) === index;
  });

  return parts.length > 0 ? parts.join(", ") : null;
}

function normalizeIpCandidate(rawValue: string): string | null {
  let value = String(rawValue ?? "").trim();
  if (!value) {
    return null;
  }

  value = value.replace(/^for=/i, "").replace(/^"+|"+$/g, "").trim();
  value = value.split(";")[0]?.trim() ?? value;

  const bracketedIpv6Match = /^\[([a-fA-F0-9:]+)\](?::\d+)?$/.exec(value);
  if (bracketedIpv6Match?.[1]) {
    value = bracketedIpv6Match[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.replace(/:\d+$/, "");
  }

  value = value.replace(/^"+|"+$/g, "").trim();
  return isValidIp(value) ? value : null;
}

function splitHeaderValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => String(entry ?? "").split(","));
  }
  return String(value ?? "").split(",");
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (!ip || ip === "0.0.0.0") {
    return true;
  }

  if (IPV4_REGEX.test(ip)) {
    const octets = ip.split(".").map((part) => Number(part));
    if (octets[0] === 10 || octets[0] === 127) {
      return true;
    }
    if (octets[0] === 192 && octets[1] === 168) {
      return true;
    }
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return true;
    }
    if (octets[0] === 169 && octets[1] === 254) {
      return true;
    }
    return false;
  }

  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

async function fetchJsonWithTimeout(url: string, headers?: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, IP_LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lookupWithIpinfo(ip: string): Promise<LoginLocation | null> {
  const token = String(process.env.IPINFO_TOKEN ?? "").trim();
  const url = token
    ? `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`
    : `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
  const payload = (await fetchJsonWithTimeout(url)) as
    | { bogon?: boolean; city?: unknown; region?: unknown; country?: unknown }
    | null;
  if (!payload || payload.bogon) {
    return null;
  }

  const city = normalizeLocationField(payload.city, 120);
  const region = normalizeLocationField(payload.region, 120);
  const country = normalizeLocationField(payload.country, 120);
  return {
    ip,
    city,
    region,
    country,
    locationLabel: buildLocationLabel(city, region, country),
  };
}

async function lookupWithIpapi(ip: string): Promise<LoginLocation | null> {
  const key = String(process.env.IPAPI_KEY ?? "").trim();
  const url = key
    ? `https://ipapi.co/${encodeURIComponent(ip)}/json/?key=${encodeURIComponent(key)}`
    : `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const payload = (await fetchJsonWithTimeout(url)) as
    | { error?: boolean; city?: unknown; region?: unknown; country_name?: unknown }
    | null;
  if (!payload || payload.error === true) {
    return null;
  }

  const city = normalizeLocationField(payload.city, 120);
  const region = normalizeLocationField(payload.region, 120);
  const country = normalizeLocationField(payload.country_name, 120);
  return {
    ip,
    city,
    region,
    country,
    locationLabel: buildLocationLabel(city, region, country),
  };
}

function readCachedLocation(ip: string): LoginLocation | null {
  const cached = locationCache.get(ip);
  if (!cached) {
    return null;
  }

  if (cached.expiresAtMs <= Date.now()) {
    locationCache.delete(ip);
    return null;
  }

  return cached.value;
}

function writeCachedLocation(ip: string, value: LoginLocation): void {
  locationCache.set(ip, {
    value,
    expiresAtMs: Date.now() + LOCATION_CACHE_TTL_MS,
  });
}

export function extractClientIpFromHeaders(
  headers: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
  fallbackIpRaw?: string | null,
): string {
  const readHeader = (name: string): string[] => {
    if (headers instanceof Headers) {
      return splitHeaderValues(headers.get(name) ?? undefined);
    }

    const value = (headers as Record<string, string | string[] | undefined>)[name];
    return splitHeaderValues(value);
  };

  const candidates = [
    ...readHeader("cf-connecting-ip"),
    ...readHeader("x-forwarded-for"),
    ...readHeader("x-real-ip"),
    ...readHeader("x-client-ip"),
    ...readHeader("forwarded"),
  ]
    .map((value) => normalizeIpCandidate(value))
    .filter((value): value is string => Boolean(value));

  return candidates[0] ?? normalizeIpCandidate(String(fallbackIpRaw ?? "")) ?? "0.0.0.0";
}

export async function getLoginLocation(ipRaw: string): Promise<LoginLocation> {
  const ip = normalizeIpCandidate(ipRaw) ?? "0.0.0.0";
  const cached = readCachedLocation(ip);
  if (cached) {
    return cached;
  }

  if (isPrivateOrReservedIp(ip)) {
    const fallback: LoginLocation = {
      ip,
      city: null,
      region: null,
      country: null,
      locationLabel: null,
    };
    writeCachedLocation(ip, fallback);
    return fallback;
  }

  const location =
    (await lookupWithIpinfo(ip)) ??
    (await lookupWithIpapi(ip)) ?? {
      ip,
      city: null,
      region: null,
      country: null,
      locationLabel: null,
    };

  writeCachedLocation(ip, location);
  return location;
}
