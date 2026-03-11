export interface ClientDeviceInfo {
  device: string;
  os: string;
  userAgent: string | null;
}

function sanitizeUserAgent(rawValue: string | null): string | null {
  const value = String(rawValue ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 512);
  return value || null;
}

function detectOs(userAgent: string): string {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes("windows nt")) {
    return "Windows";
  }
  if (normalized.includes("android")) {
    return "Android";
  }
  if (normalized.includes("iphone") || normalized.includes("ipad") || normalized.includes("ipod")) {
    return "iOS";
  }
  if (normalized.includes("mac os x") || normalized.includes("macintosh")) {
    return "Mac";
  }
  if (normalized.includes("linux")) {
    return "Linux";
  }
  return "Unknown OS";
}

function detectDevice(userAgent: string): string {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes("electron/")) {
    return "Electron";
  }
  if (normalized.includes("edg/")) {
    return "Edge";
  }
  if (normalized.includes("opr/") || normalized.includes("opera")) {
    return "Opera";
  }
  if (normalized.includes("firefox/")) {
    return "Firefox";
  }
  if (normalized.includes("chrome/") || normalized.includes("crios/")) {
    return "Chrome";
  }
  if (normalized.includes("safari/") && normalized.includes("version/")) {
    return "Safari";
  }
  return "Browser";
}

export function getClientDeviceInfoFromRequest(request: Request): ClientDeviceInfo {
  const userAgent = sanitizeUserAgent(request.headers.get("user-agent"));
  if (!userAgent) {
    return {
      device: "Unknown Client",
      os: "Unknown OS",
      userAgent: null,
    };
  }

  return {
    device: detectDevice(userAgent),
    os: detectOs(userAgent),
    userAgent,
  };
}
