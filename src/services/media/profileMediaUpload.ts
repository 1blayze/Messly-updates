import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_MB,
  BANNER_ALLOWED_TYPES,
  BANNER_MAX_BYTES,
  BANNER_MAX_MB,
} from "./imageLimits";
import { getAuthenticatedEdgeHeaders } from "../auth/firebaseToken";
import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";
import { supabase } from "../supabase";
import { uploadWithRetry } from "./uploadWithRetry";

export type ProfileMediaKind = "avatar" | "banner";

export type ProfileMediaUploadErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "DIMENSIONS_TOO_SMALL"
  | "DIMENSIONS_TOO_LARGE"
  | "INVALID_IMAGE"
  | "GIF_TOO_MANY_FRAMES";

interface UploadProfileMediaResponse {
  key: string;
  hash: string;
  size: number;
}

interface ParsedUploadErrorPayload {
  code: ProfileMediaUploadErrorCode;
  details?: Record<string, unknown>;
}

interface PresignRequest {
  action: "put";
  key: string;
  contentType: string;
  fileSize: number;
}

interface PresignResponse {
  key: string;
  action: "put";
  url: string;
}

interface EdgeErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
}

const MEDIA_UPLOAD_ERROR_PREFIX = "MEDIA_UPLOAD_ERROR::";
const PROFILE_MEDIA_PREFIX_BY_KIND: Record<ProfileMediaKind, string> = {
  avatar: "avatars",
  banner: "banners",
};
const ENABLE_DIRECT_PROFILE_UPLOAD =
  String(import.meta.env.VITE_PROFILE_DIRECT_UPLOAD ?? "")
    .trim()
    .toLowerCase() === "true";

function resolveMimeType(file: File): string {
  const declaredType = file.type.trim().toLowerCase();
  if (declaredType) {
    return declaredType;
  }

  const ext = file.name.split(".").pop()?.trim().toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function getFileExtension(file: File, mimeType: string): string {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (normalizedMime === "image/webp") {
    return "webp";
  }
  if (normalizedMime === "image/png") {
    return "png";
  }
  if (normalizedMime === "image/jpeg") {
    return "jpg";
  }
  if (normalizedMime === "image/gif") {
    return "gif";
  }

  const nameExt = file.name.split(".").pop()?.trim().toLowerCase();
  return nameExt || "bin";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = await subtle.digest("SHA-256", digestInput.buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  // Browser fallback when SubtleCrypto is unavailable.
  const fallback = Math.random().toString(16).slice(2) + Date.now().toString(16);
  return fallback.padEnd(64, "0").slice(0, 64);
}

async function uploadProfileMediaViaWebStorage(
  kind: ProfileMediaKind,
  userId: string,
  file: File,
): Promise<UploadProfileMediaResponse> {
  const mimeType = resolveMimeType(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const ext = getFileExtension(file, mimeType);
  const key = `${PROFILE_MEDIA_PREFIX_BY_KIND[kind]}/${userId}/${hash}.${ext}`;

  if (ENABLE_DIRECT_PROFILE_UPLOAD) {
    try {
      const presigned = await invokeEdgeJson<PresignRequest, PresignResponse>(
        "r2-presign",
        {
          action: "put",
          key,
          contentType: mimeType,
          fileSize: file.size,
        },
        {
          retries: 1,
          timeoutMs: 18_000,
        },
      );

      if (!presigned?.url) {
        throw new Error("Falha ao obter URL de upload.");
      }

      await uploadWithRetry({
        url: presigned.url,
        file,
        contentType: mimeType,
        retries: 2,
        timeoutMs: 45_000,
      });
    } catch (error) {
      if (!shouldFallbackToEdgeProxy(error)) {
        throw error;
      }

      await uploadProfileMediaViaEdgeProxy(file, key, mimeType);
    }
  } else {
    await uploadProfileMediaViaEdgeProxy(file, key, mimeType);
  }

  return {
    key,
    hash,
    size: file.size,
  };
}

function shouldFallbackToEdgeProxy(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    return false;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
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

async function uploadProfileMediaViaEdgeProxy(file: File, key: string, mimeType: string): Promise<void> {
  const requestHeaders = {
    "Content-Type": mimeType,
    "x-media-key": key,
  };
  let functionHeaders = await getAuthenticatedEdgeHeaders(requestHeaders, { mode: "firebase" });
  let uploadResponse = await supabase.functions.invoke("r2-upload", {
    body: file,
    headers: functionHeaders,
  });

  if (uploadResponse.error && (await isInvalidJwtInvokeError(uploadResponse.error))) {
    functionHeaders = await getAuthenticatedEdgeHeaders(requestHeaders, { mode: "firebase", forceRefresh: true });
    uploadResponse = await supabase.functions.invoke("r2-upload", {
      body: file,
      headers: functionHeaders,
    });
  }

  if (uploadResponse.error && (await isInvalidJwtInvokeError(uploadResponse.error))) {
    functionHeaders = await getAuthenticatedEdgeHeaders(requestHeaders, { mode: "supabase" });
    uploadResponse = await supabase.functions.invoke("r2-upload", {
      body: file,
      headers: functionHeaders,
    });
  }

  if (uploadResponse.error) {
    const message = await extractEdgeInvokeErrorMessage(uploadResponse.error);
    throw new Error(message || "Nao foi possivel enviar o arquivo para o storage.");
  }
}

async function extractEdgeInvokeErrorMessage(error: unknown): Promise<string> {
  const fallbackMessage =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: string }).message ?? "").trim()
      : "";

  const context =
    typeof error === "object" && error !== null && "context" in error
      ? (error as { context?: unknown }).context
      : null;

  if (!(context instanceof Response)) {
    return fallbackMessage;
  }

  try {
    const parsed = (await context.clone().json()) as EdgeErrorEnvelope;
    const code = String(parsed?.error?.code ?? "").trim();
    const message = String(parsed?.error?.message ?? "").trim();

    if (message) {
      if (code) {
        return `${message} (${code})`;
      }
      return message;
    }
  } catch {
    // noop
  }

  try {
    const rawText = (await context.clone().text()).trim();
    if (rawText) {
      return rawText;
    }
  } catch {
    // noop
  }

  return fallbackMessage;
}

async function isInvalidJwtInvokeError(error: unknown): Promise<boolean> {
  const context =
    typeof error === "object" && error !== null && "context" in error
      ? (error as { context?: unknown }).context
      : null;

  if (context instanceof Response) {
    if (context.status !== 401) {
      return false;
    }

    try {
      const parsed = (await context.clone().json()) as {
        code?: string | number;
        message?: string;
        error?: { code?: string | number; message?: string };
      };
      const code = String(parsed.error?.code ?? parsed.code ?? "").toLowerCase();
      const message = String(parsed.error?.message ?? parsed.message ?? "").toLowerCase();
      return code.includes("401") || message.includes("invalid jwt") || message.includes("unauthorized");
    } catch {
      const text = (await context.clone().text()).toLowerCase();
      return text.includes("invalid jwt") || text.includes("unauthorized");
    }
  }

  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: string }).message ?? "").toLowerCase()
      : "";
  return message.includes("invalid jwt") || message.includes("unauthorized");
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getAllowedTypes(kind: ProfileMediaKind): readonly string[] {
  return kind === "avatar" ? AVATAR_ALLOWED_TYPES : BANNER_ALLOWED_TYPES;
}

function getMaxBytes(kind: ProfileMediaKind): number {
  return kind === "avatar" ? AVATAR_MAX_BYTES : BANNER_MAX_BYTES;
}

function getMaxMb(kind: ProfileMediaKind): number {
  return kind === "avatar" ? AVATAR_MAX_MB : BANNER_MAX_MB;
}

export class ProfileMediaUploadError extends Error {
  code: ProfileMediaUploadErrorCode;
  details: Record<string, unknown>;

  constructor(code: ProfileMediaUploadErrorCode, details: Record<string, unknown>, message: string) {
    super(message);
    this.name = "ProfileMediaUploadError";
    this.code = code;
    this.details = details;
  }
}

export function isProfileMediaUploadError(error: unknown): error is ProfileMediaUploadError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ProfileMediaUploadError" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function parseUploadErrorPayload(error: unknown): ParsedUploadErrorPayload | null {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: string }).message ?? "")
      : String(error ?? "");

  if (!message.startsWith(MEDIA_UPLOAD_ERROR_PREFIX)) {
    return null;
  }

  const rawPayload = message.slice(MEDIA_UPLOAD_ERROR_PREFIX.length).trim();
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as ParsedUploadErrorPayload;
    if (!parsed || typeof parsed !== "object" || typeof parsed.code !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getUploadErrorMessage(code: ProfileMediaUploadErrorCode, details: Record<string, unknown>): string {
  switch (code) {
    case "FILE_TOO_LARGE": {
      const maxMb = toNumberOrUndefined(details.maxMb);
      return maxMb ? `Arquivo acima do limite de ${maxMb} MB.` : "Arquivo acima do limite permitido.";
    }
    case "UNSUPPORTED_TYPE": {
      const allowedTypes = Array.isArray(details.allowedTypes)
        ? details.allowedTypes.filter((value): value is string => typeof value === "string")
        : [];
      if (allowedTypes.length > 0) {
        return `Formato nao suportado. Use: ${allowedTypes.join(", ")}.`;
      }
      return "Formato nao suportado.";
    }
    case "DIMENSIONS_TOO_SMALL": {
      const minWidth = toNumberOrUndefined(details.minWidth);
      const minHeight = toNumberOrUndefined(details.minHeight);
      if (minWidth && minHeight) {
        return `Imagem menor que o minimo permitido (${minWidth}x${minHeight}).`;
      }
      return "Imagem menor que o minimo permitido.";
    }
    case "DIMENSIONS_TOO_LARGE": {
      const maxWidth = toNumberOrUndefined(details.maxWidth);
      const maxHeight = toNumberOrUndefined(details.maxHeight);
      if (maxWidth && maxHeight) {
        return `Imagem maior que o maximo permitido (${maxWidth}x${maxHeight}).`;
      }
      return "Imagem maior que o maximo permitido.";
    }
    case "GIF_TOO_MANY_FRAMES": {
      const maxFrames = toNumberOrUndefined(details.maxFrames);
      if (maxFrames) {
        return `GIF excede o limite de ${maxFrames} frames.`;
      }
      return "GIF excede o limite de frames permitido.";
    }
    case "INVALID_IMAGE":
    default:
      return "Arquivo de imagem invalido.";
  }
}

function ensureLocalConstraints(kind: ProfileMediaKind, file: File): void {
  const maxBytes = getMaxBytes(kind);
  if (file.size > maxBytes) {
    throw new ProfileMediaUploadError(
      "FILE_TOO_LARGE",
      { maxMb: getMaxMb(kind) },
      `Arquivo acima do limite de ${getMaxMb(kind)} MB.`,
    );
  }

  const declaredType = file.type.trim().toLowerCase();
  if (!declaredType) {
    return;
  }

  const allowedTypes = getAllowedTypes(kind);
  if (!allowedTypes.includes(declaredType)) {
    throw new ProfileMediaUploadError(
      "UNSUPPORTED_TYPE",
      { allowedTypes: [...allowedTypes] },
      getUploadErrorMessage("UNSUPPORTED_TYPE", { allowedTypes: [...allowedTypes] }),
    );
  }
}

function getLegacyTargetSize(kind: ProfileMediaKind): { width: number; height: number; quality: number } {
  if (kind === "avatar") {
    return {
      width: 512,
      height: 512,
      quality: 0.92,
    };
  }

  return {
    width: 1200,
    height: 480,
    quality: 0.9,
  };
}

function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (sourceRatio > targetRatio) {
    const sh = sourceHeight;
    const sw = sh * targetRatio;
    const sx = (sourceWidth - sw) / 2;
    return { sx, sy: 0, sw, sh };
  }

  const sw = sourceWidth;
  const sh = sw / targetRatio;
  const sy = (sourceHeight - sh) / 2;
  return { sx: 0, sy, sw, sh };
}

async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Nao foi possivel ler a imagem selecionada."));
    };

    image.src = objectUrl;
  });
}

async function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Nao foi possivel converter a imagem para WebP."));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}

async function encodeLegacyWebp(kind: ProfileMediaKind, file: File): Promise<Uint8Array> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Selecione um arquivo de imagem valido.");
  }

  const image = await loadImageFromFile(file);
  const { width, height, quality } = getLegacyTargetSize(kind);
  const crop = computeCoverCrop(image.naturalWidth, image.naturalHeight, width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Nao foi possivel preparar a imagem.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  const webpBlob = await canvasToWebp(canvas, quality);
  return new Uint8Array(await webpBlob.arrayBuffer());
}

export async function uploadProfileMediaAsset(
  kind: ProfileMediaKind,
  userId: string,
  file: File,
): Promise<UploadProfileMediaResponse> {
  const uploadHandler = window.electronAPI?.uploadProfileMedia;
  ensureLocalConstraints(kind, file);

  if (!uploadHandler) {
    return uploadProfileMediaViaWebStorage(kind, userId, file);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let response: UploadProfileMediaResponse;
  try {
    response = await uploadHandler({
      kind,
      userId,
      bytes,
      mimeType: file.type || undefined,
      fileName: file.name || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("Profile media payload must be WebP.")) {
      const legacyWebpBytes = await encodeLegacyWebp(kind, file);
      response = await uploadHandler({
        kind,
        userId,
        bytes: legacyWebpBytes,
        mimeType: "image/webp",
        fileName: file.name || undefined,
      });
    } else {
      if (message.includes("No handler registered for 'media:upload-profile'")) {
        throw new Error("Upload de perfil indisponivel. Reinicie o aplicativo.");
      }

      const parsed = parseUploadErrorPayload(error);
      if (parsed) {
        const details = parsed.details && typeof parsed.details === "object" ? parsed.details : {};
        throw new ProfileMediaUploadError(parsed.code, details, getUploadErrorMessage(parsed.code, details));
      }

      throw error;
    }
  }

  if (!response?.key || !response?.hash) {
    throw new Error("Resposta invalida do upload.");
  }

  return response;
}
