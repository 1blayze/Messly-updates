import { hashFile } from "../../utils/hashFile";
import { compressImage, generateThumbnail } from "./compression";
import { uploadMediaAsset } from "../uploadMedia";

export type AttachmentKind = "image" | "video" | "file";

export interface PreparedAttachment {
  kind: AttachmentKind;
  uploadFile: File;
  fileKey: string;
  thumbFile?: File;
  thumbKey?: string;
  originalFile?: File;
  originalKey?: string;
  mimeType: string;
  fileSize: number;
  width?: number;
  height?: number;
  thumbWidth?: number;
  thumbHeight?: number;
  codec?: string;
  durationMs?: number;
}

export interface UploadAttachmentBlobOptions {
  file: File;
  key: string;
  conversationId: string;
  contentType?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  onProgress?: (ratio: number) => void;
}

const SAFE_FILE_NAME_REGEX = /[^a-zA-Z0-9._-]/g;
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

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const ALLOWED_FILE_MIME = new Set([
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_GENERIC_BYTES = 25 * 1024 * 1024;

function isFlagEnabled(rawValue: string | undefined): boolean {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getFileExtension(fileName: string, fallback = "bin"): string {
  const segment = fileName.split(".").pop()?.trim().toLowerCase();
  return segment || fallback;
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/\s+/g, "-").replace(SAFE_FILE_NAME_REGEX, "");
  return normalized.slice(-120) || `file-${Date.now()}`;
}

function ensureSafeExtension(ext: string): void {
  if (BLOCKED_EXTENSIONS.has(ext.toLowerCase())) {
    throw new Error("Extensao de arquivo bloqueada por seguranca.");
  }
}

function detectAttachmentKind(file: File): AttachmentKind {
  const mimeType = String(file.type ?? "").trim().toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  return "file";
}

function assertAllowedMime(kind: AttachmentKind, mimeType: string): void {
  if (kind === "image" && !ALLOWED_IMAGE_MIME.has(mimeType)) {
    throw new Error("Tipo de imagem nao permitido.");
  }

  if (kind === "video" && !ALLOWED_VIDEO_MIME.has(mimeType)) {
    throw new Error("Tipo de video nao permitido.");
  }

  if (kind === "file" && !ALLOWED_FILE_MIME.has(mimeType)) {
    throw new Error("Tipo de arquivo nao permitido.");
  }
}

function assertSize(kind: AttachmentKind, size: number): void {
  if (kind === "image" && size > MAX_IMAGE_BYTES) {
    throw new Error("Imagem excede o limite permitido.");
  }

  if (kind === "video" && size > MAX_VIDEO_BYTES) {
    throw new Error("Video excede o limite permitido.");
  }

  if (kind === "file" && size > MAX_GENERIC_BYTES) {
    throw new Error("Arquivo excede o limite permitido.");
  }
}

function ensureConversationId(conversationId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    throw new Error("conversationId invalido para upload de anexo.");
  }
}

function fileFromBlob(blob: Blob, fileName: string): File {
  return new File([blob], fileName, {
    type: blob.type || "application/octet-stream",
    lastModified: Date.now(),
  });
}

function normalizePositiveDimension(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

async function buildImageKey(file: File, suffix = ".webp"): Promise<string> {
  const sha256 = await hashFile(file);
  return `messages/images/${sha256}${suffix}`;
}

async function buildVideoKey(file: File): Promise<string> {
  const sha256 = await hashFile(file);
  const ext = getFileExtension(file.name, "mp4");
  return `messages/videos/${sha256}.${ext}`;
}

async function buildFileKey(file: File): Promise<string> {
  const sha256 = await hashFile(file);
  const ext = getFileExtension(file.name, "bin");
  return `messages/files/${sha256}.${ext}`;
}

function resolveUploadKindFromKey(
  key: string,
  file: File,
): "message_image" | "message_image_preview" | "message_image_original" | "message_video" | "message_video_thumb" | "message_file" {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (normalized.startsWith("messages/images/") && normalized.endsWith(".preview.webp")) {
    return "message_image_preview";
  }
  if (normalized.startsWith("messages/images/")) {
    return "message_image";
  }
  if (normalized.startsWith("messages/videos/") && normalized.endsWith(".thumb.webp")) {
    return "message_video_thumb";
  }
  if (normalized.startsWith("messages/videos/")) {
    return "message_video";
  }
  if (normalized.startsWith("messages/files/")) {
    return file.type.startsWith("image/") ? "message_image_original" : "message_file";
  }

  throw new Error("Chave de anexo invalida para upload.");
}

export async function uploadAttachmentBlob(options: UploadAttachmentBlobOptions): Promise<void> {
  const uploadAttachment = typeof window !== "undefined" ? window.electronAPI?.uploadAttachment : undefined;
  if (uploadAttachment) {
    const bytes = await options.file.arrayBuffer();
    const result = await uploadAttachment({
      key: options.key,
      bytes,
      contentType: String(options.contentType ?? options.file.type ?? "application/octet-stream").trim()
        || "application/octet-stream",
    });
    if (String(result?.key ?? "").trim() !== options.key) {
      throw new Error("Chave de upload divergente da chave esperada.");
    }
    options.onProgress?.(1);
    return;
  }

  const uploadKind = resolveUploadKindFromKey(options.key, options.file);
  const uploaded = await uploadMediaAsset({
    kind: uploadKind,
    file: options.file,
    conversationId: options.conversationId,
    onProgress: options.onProgress,
  });

  if (uploaded.fileKey !== options.key) {
    throw new Error("Chave de upload divergente da chave esperada.");
  }
}

export async function prepareAttachmentUpload(file: File, conversationId: string): Promise<PreparedAttachment> {
  ensureConversationId(conversationId);

  const safeName = sanitizeFileName(file.name);
  const ext = getFileExtension(safeName);
  ensureSafeExtension(ext);

  const kind = detectAttachmentKind(file);
  const originalMime = String(file.type ?? "application/octet-stream").trim().toLowerCase();
  assertAllowedMime(kind, originalMime);
  assertSize(kind, file.size);

  const keepOriginal = isFlagEnabled(import.meta.env.VITE_CHAT_KEEP_ORIGINAL_UPLOADS);

  if (kind === "image") {
    const compressed = await compressImage(file, {
      maxDimension: 2048,
      recompressThresholdBytes: 300 * 1024,
      preferredFormat: "image/webp",
      keepOriginal,
    });

    const uploadFile = compressed.file;
    const fileKey = await buildImageKey(uploadFile);

    const thumbnail = await generateThumbnail(uploadFile, {
      maxDimension: 512,
      mimeType: "image/webp",
      quality: 0.82,
    });

    const thumbName = `${sanitizeFileName(uploadFile.name).replace(/\.[^.]+$/, "")}-preview.webp`;
    const thumbFile = fileFromBlob(thumbnail.blob, thumbName);
    const thumbKey = await buildImageKey(thumbFile, ".preview.webp");

    const output: PreparedAttachment = {
      kind,
      uploadFile,
      fileKey,
      thumbFile,
      thumbKey,
      mimeType: uploadFile.type || "image/webp",
      fileSize: uploadFile.size,
      width: normalizePositiveDimension(compressed.width),
      height: normalizePositiveDimension(compressed.height),
      thumbWidth: normalizePositiveDimension(thumbnail.width),
      thumbHeight: normalizePositiveDimension(thumbnail.height),
    };

    if (keepOriginal && compressed.originalFile && compressed.originalFile !== uploadFile) {
      output.originalFile = compressed.originalFile;
      output.originalKey = await buildFileKey(compressed.originalFile);
    }

    return output;
  }

  if (kind === "video") {
    const thumb = await generateThumbnail(file, {
      maxDimension: 512,
      mimeType: "image/webp",
      quality: 0.82,
      videoFrameTimeSec: 0.3,
    });

    const thumbFile = fileFromBlob(thumb.blob, `${safeName.replace(/\.[^.]+$/, "")}-thumb.webp`);

    return {
      kind,
      uploadFile: file,
      fileKey: await buildVideoKey(file),
      thumbFile,
      thumbKey: `messages/videos/${await hashFile(thumbFile)}.thumb.webp`,
      mimeType: originalMime,
      fileSize: file.size,
      thumbWidth: normalizePositiveDimension(thumb.width),
      thumbHeight: normalizePositiveDimension(thumb.height),
      codec: originalMime,
    };
  }

  return {
    kind,
    uploadFile: file,
    fileKey: await buildFileKey(file),
    mimeType: originalMime,
    fileSize: file.size,
  };
}
