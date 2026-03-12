import {
  getOrCreatePresenceDeviceId,
  getPresenceDeviceMetadataSnapshot,
} from "../presence/presenceDeviceInfo";

export type SessionClientType = "desktop" | "web" | "mobile" | "unknown";
export type SessionPlatform =
  | "windows"
  | "macos"
  | "linux"
  | "browser"
  | "android"
  | "ios"
  | "unknown";

export interface SessionClientDescriptor {
  name: string;
  version: string;
  platform: SessionPlatform;
  clientType: SessionClientType;
  deviceId: string;
}

function normalizeElectronPlatform(valueRaw: string | null | undefined): SessionPlatform | null {
  const value = String(valueRaw ?? "").trim().toLowerCase();
  switch (value) {
    case "win32":
    case "windows":
      return "windows";
    case "darwin":
    case "mac":
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    default:
      return null;
  }
}

function detectMobilePlatformFromUserAgent(userAgentRaw: string): SessionPlatform {
  const userAgent = userAgentRaw.toLowerCase();
  if (userAgent.includes("android")) {
    return "android";
  }
  if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ipod")) {
    return "ios";
  }
  return "unknown";
}

export function getSessionClientType(): SessionClientType {
  const metadata = getPresenceDeviceMetadataSnapshot();
  switch (metadata.platform) {
    case "desktop":
      return "desktop";
    case "mobile":
      return "mobile";
    case "browser":
      return "web";
    default:
      return "unknown";
  }
}

export function getSessionPlatform(): SessionPlatform {
  const electronPlatform = normalizeElectronPlatform(
    typeof window !== "undefined" ? String(window.electronAPI?.platform ?? "") : "",
  );
  if (electronPlatform) {
    return electronPlatform;
  }

  const clientType = getSessionClientType();
  if (clientType === "web") {
    return "browser";
  }

  if (clientType === "mobile") {
    return detectMobilePlatformFromUserAgent(typeof navigator !== "undefined" ? navigator.userAgent : "");
  }

  return "unknown";
}

export function getSessionClientDescriptor(versionRaw: string): SessionClientDescriptor {
  const metadata = getPresenceDeviceMetadataSnapshot();
  const clientType = getSessionClientType();
  const version = String(versionRaw ?? "").trim() || "0.0.0";

  return {
    name:
      clientType === "desktop"
        ? "Messly Desktop"
        : metadata.clientName.trim() || (clientType === "web" ? "Messly Web" : "Messly"),
    version,
    platform: getSessionPlatform(),
    clientType,
    deviceId: getOrCreatePresenceDeviceId(),
  };
}
