import { HttpError } from "./http.ts";

const SAFE_MEDIA_KEY_REGEX = /^[a-z0-9/_\-.]+$/i;
const ALLOWED_PREFIXES = ["attachments/", "avatars/", "banners/", "messages/", "guilds/", "emojis/"] as const;
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "msi",
  "bat",
  "cmd",
  "sh",
  "ps1",
  "js",
  "mjs",
  "cjs",
  "jar",
  "apk",
  "app",
  "dmg",
  "scr",
  "com",
]);

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
]);

export function sanitizeMediaKey(rawKey: unknown): string {
  if (typeof rawKey !== "string") {
    throw new HttpError(400, "INVALID_MEDIA_KEY", "Media key inválida.");
  }

  const normalized = rawKey.trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new HttpError(400, "INVALID_MEDIA_KEY", "Media key vazia.");
  }

  if (normalized.includes("..") || normalized.includes("\\") || normalized.includes("//")) {
    throw new HttpError(400, "INVALID_MEDIA_KEY", "Media key inválida.");
  }

  if (!SAFE_MEDIA_KEY_REGEX.test(normalized)) {
    throw new HttpError(400, "INVALID_MEDIA_KEY", "Media key inválida.");
  }

  const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!hasAllowedPrefix) {
    throw new HttpError(400, "INVALID_MEDIA_KEY", "Prefixo de media key não permitido.");
  }

  return normalized;
}

export function sanitizeContentType(rawType: unknown): string {
  const normalized = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (!normalized) {
    return "application/octet-stream";
  }
  return normalized;
}

function getExtensionFromKey(key: string): string {
  const lastSegment = key.split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }
  return lastSegment.slice(dotIndex + 1).trim().toLowerCase();
}

export function assertSafeUploadType(key: string, contentType: string): void {
  const ext = getExtensionFromKey(key);
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, "DISALLOWED_EXTENSION", "Extensao de arquivo bloqueada por seguranca.");
  }

  if (contentType === "application/octet-stream") {
    throw new HttpError(400, "MISSING_CONTENT_TYPE", "content-type obrigatorio para upload.");
  }

  if (!ALLOWED_UPLOAD_MIME_TYPES.has(contentType)) {
    throw new HttpError(400, "DISALLOWED_MIME_TYPE", "Tipo MIME não permitido.", {
      mimeType: contentType,
    });
  }
}

export function parseAttachmentConversationId(key: string): string | null {
  const segments = key.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "attachments") {
    return null;
  }

  if (segments[1] === "chat") {
    return segments[2] ?? null;
  }

  return segments[1] ?? null;
}
