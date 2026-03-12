/// <reference path="./edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";

const IP_LOOKUP_TIMEOUT_MS = 2_500;
const LOCATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const locationCache = new Map<string, { value: LoginLocation; expiresAtMs: number }>();

const ipinfoResponseSchema = z
  .object({
    bogon: z.boolean().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

const ipapiResponseSchema = z
  .object({
    error: z.boolean().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    country_name: z.string().optional(),
  })
  .passthrough();

export interface LoginLocation {
  ip: string;
  city: string;
  region: string;
  country: string;
}

const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const IPV6_REGEX =
  /^(?:[a-fA-F0-9]{1,4}(?::[a-fA-F0-9]{1,4}){1,7}|::1|::|[a-fA-F0-9]{1,4}::(?:[a-fA-F0-9]{1,4}:?){0,5}[a-fA-F0-9]{0,4})$/;

function isValidIp(value: string): boolean {
  return IPV4_REGEX.test(value) || IPV6_REGEX.test(value);
}

function normalizeLocationField(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
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

function writeCachedLocation(ip: string, location: LoginLocation): void {
  locationCache.set(ip, {
    value: location,
    expiresAtMs: Date.now() + LOCATION_CACHE_TTL_MS,
  });
}

async function fetchJsonWithTimeout(url: string, headers?: HeadersInit): Promise<unknown> {
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
  const token = String(Deno.env.get("IPINFO_TOKEN") ?? "").trim();
  const url = token
    ? `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`
    : `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
  const payload = ipinfoResponseSchema.safeParse(await fetchJsonWithTimeout(url));
  if (!payload.success || payload.data.bogon) {
    return null;
  }

  return {
    ip,
    city: normalizeLocationField(payload.data.city, 120),
    region: normalizeLocationField(payload.data.region, 120),
    country: normalizeLocationField(payload.data.country, 120),
  };
}

async function lookupWithIpapi(ip: string): Promise<LoginLocation | null> {
  const key = String(Deno.env.get("IPAPI_KEY") ?? "").trim();
  const url = key
    ? `https://ipapi.co/${encodeURIComponent(ip)}/json/?key=${encodeURIComponent(key)}`
    : `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const payload = ipapiResponseSchema.safeParse(await fetchJsonWithTimeout(url));
  if (!payload.success || payload.data.error === true) {
    return null;
  }

  return {
    ip,
    city: normalizeLocationField(payload.data.city, 120),
    region: normalizeLocationField(payload.data.region, 120),
    country: normalizeLocationField(payload.data.country_name, 120),
  };
}

export function extractClientIpFromRequest(request: Request): string {
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-forwarded-for"),
    request.headers.get("fly-client-ip"),
    request.headers.get("x-real-ip"),
    request.headers.get("x-client-ip"),
    request.headers.get("forwarded"),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => normalizeIpCandidate(value))
    .filter((value): value is string => Boolean(value));

  return candidates[0] ?? "0.0.0.0";
}

export async function getLoginLocation(ipRaw: string): Promise<LoginLocation> {
  const ip = normalizeIpCandidate(ipRaw) ?? "0.0.0.0";
  const cached = readCachedLocation(ip);
  if (cached) {
    return cached;
  }

  if (isPrivateOrReservedIp(ip)) {
    const localValue: LoginLocation = {
      ip,
      city: "",
      region: "",
      country: "",
    };
    writeCachedLocation(ip, localValue);
    return localValue;
  }

  const location =
    (await lookupWithIpinfo(ip)) ??
    (await lookupWithIpapi(ip)) ?? {
      ip,
      city: "",
      region: "",
      country: "",
    };

  writeCachedLocation(ip, location);
  return location;
}
