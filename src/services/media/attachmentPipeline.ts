import { invokeEdgeJson } from "../edge/edgeClient";
import { getAuthenticatedEdgeHeaders } from "../auth/firebaseToken";
import { supabase } from "../supabase";
import { compressImage, generateThumbnail } from "./compression";
import { uploadWithRetry } from "./uploadWithRetry";

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

interface PresignRequest {
  action: "get" | "put";
  key: string;
  contentType?: string;
  fileSize?: number;
  expiresSeconds?: number;
}

interface PresignResponse {
  key: string;
  action: "get" | "put";
  url: string;
  expiresIn: number;
  contentType?: string;
}

interface UploadViaEdgeResponse {
  key?: string;
  size?: number;
  contentType?: string;
}

export interface UploadAttachmentBlobOptions {
  file: File;
  key: string;
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

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_GENERIC_BYTES = 20 * 1024 * 1024;

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

function makeAttachmentKey(conversationId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `attachments/${conversationId}/${id}.${safeExt}`;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function shouldFallbackToEdgeUpload(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("network error while uploading") ||
    message.includes("failed to fetch") ||
    message.includes("err_failed") ||
    message.includes("cors") ||
    message.includes("preflight")
  );
}

function shouldFallbackFromElectronAttachmentUpload(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  const message = String(error instanceof Error ? error.message : error ?? "");
  const normalizedMessage = message.toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  const isMissingR2Env =
    normalizedMessage.includes("missing required environment variable:") &&
    (normalizedMessage.includes("r2_bucket") ||
      normalizedMessage.includes("r2_endpoint") ||
      normalizedMessage.includes("r2_access_key_id") ||
      normalizedMessage.includes("r2_secret_access_key"));

  if (isMissingR2Env) {
    return true;
  }

  return (
    normalizedMessage.includes("nosuchbucket") ||
    normalizedMessage.includes("the specified bucket does not exist") ||
    normalizedMessage.includes("no value provided for input http label: bucket")
  );
}

async function uploadAttachmentViaElectron(options: UploadAttachmentBlobOptions): Promise<boolean> {
  const handler = window.electronAPI?.uploadAttachment;
  if (!handler) {
    return false;
  }

  if (options.signal?.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }

  const bytes = new Uint8Array(await options.file.arrayBuffer());
  if (options.signal?.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }

  try {
    await handler({
      key: options.key,
      bytes,
      contentType: options.contentType,
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error ?? "");
    if (message.includes("No handler registered for 'media:upload-attachment'")) {
      return false;
    }
    if (shouldFallbackFromElectronAttachmentUpload(error)) {
      return false;
    }
    throw error;
  }

  options.onProgress?.(1);
  return true;
}

async function uploadAttachmentViaPresignedUrl(options: UploadAttachmentBlobOptions): Promise<void> {
  const signedPut = await requestPresignedUrl({
    action: "put",
    key: options.key,
    contentType: options.contentType,
    fileSize: options.file.size,
  });

  await uploadWithRetry({
    url: signedPut.url,
    file: options.file,
    contentType: options.contentType || "application/octet-stream",
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress
      ? ({ ratio }) => {
          options.onProgress?.(ratio);
        }
      : undefined,
  });
}

async function uploadAttachmentViaEdge(options: UploadAttachmentBlobOptions): Promise<void> {
  if (options.signal?.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }

  const headers = await getAuthenticatedEdgeHeaders({
    "Content-Type": options.contentType || "application/octet-stream",
    "x-media-key": options.key,
  });

  const response = await supabase.functions.invoke<UploadViaEdgeResponse>("r2-upload", {
    body: options.file,
    headers,
  });

  if (response.error) {
    throw new Error(response.error.message || "Falha ao enviar anexo.");
  }

  if (!response.data?.key) {
    throw new Error("Resposta invalida do upload.");
  }

  options.onProgress?.(1);
}

export async function uploadAttachmentBlob(options: UploadAttachmentBlobOptions): Promise<void> {
  const normalizedOptions: UploadAttachmentBlobOptions = {
    ...options,
    contentType: options.contentType || "application/octet-stream",
  };

  if (await uploadAttachmentViaElectron(normalizedOptions)) {
    return;
  }

  try {
    await uploadAttachmentViaPresignedUrl(normalizedOptions);
    return;
  } catch (error) {
    if (!shouldFallbackToEdgeUpload(error)) {
      throw error;
    }
  }

  await uploadAttachmentViaEdge(normalizedOptions);
}

export async function requestPresignedUrl(payload: PresignRequest): Promise<PresignResponse> {
  return invokeEdgeJson<PresignRequest, PresignResponse>("r2-presign", payload, {
    retries: 1,
    timeoutMs: 18_000,
  });
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
    const uploadExt = getFileExtension(uploadFile.name, "webp");
    const fileKey = makeAttachmentKey(conversationId, uploadExt);

    const thumbnail = await generateThumbnail(uploadFile, {
      maxDimension: 480,
      mimeType: "image/webp",
      quality: 0.8,
    });

    const thumbName = `${sanitizeFileName(uploadFile.name).replace(/\.[^.]+$/, "")}-thumb.webp`;
    const thumbFile = fileFromBlob(thumbnail.blob, thumbName);
    const thumbKey = makeAttachmentKey(conversationId, "webp");

    const output: PreparedAttachment = {
      kind,
      uploadFile,
      fileKey,
      thumbFile,
      thumbKey,
      mimeType: uploadFile.type || "image/webp",
      fileSize: uploadFile.size,
      width: compressed.width,
      height: compressed.height,
      thumbWidth: thumbnail.width,
      thumbHeight: thumbnail.height,
    };

    if (keepOriginal && compressed.originalFile && compressed.originalFile !== uploadFile) {
      output.originalFile = compressed.originalFile;
      output.originalKey = makeAttachmentKey(conversationId, getFileExtension(compressed.originalFile.name, ext));
    }

    return output;
  }

  if (kind === "video") {
    const thumb = await generateThumbnail(file, {
      maxDimension: 480,
      mimeType: "image/webp",
      quality: 0.8,
      videoFrameTimeSec: 0.3,
    });

    const thumbFile = fileFromBlob(thumb.blob, `${safeName.replace(/\.[^.]+$/, "")}-thumb.webp`);

    return {
      kind,
      uploadFile: file,
      fileKey: makeAttachmentKey(conversationId, getFileExtension(safeName, "mp4")),
      thumbFile,
      thumbKey: makeAttachmentKey(conversationId, "webp"),
      mimeType: originalMime,
      fileSize: file.size,
      thumbWidth: thumb.width,
      thumbHeight: thumb.height,
      codec: originalMime,
    };
  }

  return {
    kind,
    uploadFile: file,
    fileKey: makeAttachmentKey(conversationId, ext),
    mimeType: originalMime,
    fileSize: file.size,
  };
}
