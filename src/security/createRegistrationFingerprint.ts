const FINGERPRINT_NAMESPACE = "messly-registration-fingerprint-v1";

interface FingerprintSignals {
  platform: string;
  userAgent: string;
  language: string;
  timezone: string;
  screen: string;
  colorDepth: string;
  hardwareConcurrency: string;
  deviceMemory: string;
  vendor: string;
}

function collectSignals(): FingerprintSignals {
  const nav = window.navigator;
  const screen = window.screen;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const deviceMemory = (nav as Navigator & { deviceMemory?: number }).deviceMemory;

  return {
    platform: String(nav.platform ?? "").trim().toLowerCase(),
    userAgent: String(nav.userAgent ?? "").trim().toLowerCase(),
    language: String(nav.language ?? "").trim().toLowerCase(),
    timezone: String(timezone).trim().toLowerCase(),
    screen: `${Number(screen?.width ?? 0)}x${Number(screen?.height ?? 0)}`,
    colorDepth: String(Number(screen?.colorDepth ?? 0)),
    hardwareConcurrency: String(Number(nav.hardwareConcurrency ?? 0)),
    deviceMemory: Number.isFinite(Number(deviceMemory ?? NaN)) ? String(deviceMemory) : "",
    vendor: String(nav.vendor ?? "").trim().toLowerCase(),
  };
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRegistrationFingerprint(): Promise<string> {
  const signals = collectSignals();
  const serialized = JSON.stringify({
    scope: FINGERPRINT_NAMESPACE,
    ...signals,
  });

  try {
    if (window.crypto?.subtle) {
      return await sha256Hex(serialized);
    }
  } catch {
    // Fallback hash below.
  }

  return fnv1aHex(serialized);
}
