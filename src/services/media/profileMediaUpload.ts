import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_MB,
  BANNER_ALLOWED_TYPES,
  BANNER_MAX_BYTES,
  BANNER_MAX_MB,
} from "./imageLimits";
import { MediaApiError, uploadProfileMediaProxy } from "../../api/mediaController";
import { uploadMediaAsset } from "../uploadMedia";
import { hashFile } from "../../utils/hashFile";
import { getSupabaseFunctionHeaders } from "../supabase";
import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";
import { uploadWithRetry } from "./uploadWithRetry";
import { getRuntimeAppApiUrl } from "../../config/runtimeApiConfig";
import { getApiBaseUrl, getCanonicalWebOrigin, getProfileMediaUploadUrl } from "../../config/domains";
import { authService } from "../auth";

export type ProfileMediaKind = "avatar" | "banner";

export type ProfileMediaUploadErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "DIMENSIONS_TOO_SMALL"
  | "DIMENSIONS_TOO_LARGE"
  | "INVALID_IMAGE"
  | "GIF_TOO_MANY_FRAMES";

const ELECTRON_MEDIA_UPLOAD_ERROR_PREFIX = "MEDIA_UPLOAD_ERROR::";

interface PersistedProfileMediaFields {
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  banner_url?: string | null;
}

interface UploadProfileMediaResponse {
  key: string;
  hash: string;
  size: number;
  versionedUrl?: string | null;
  strategy?: string | null;
  persistedProfile?: PersistedProfileMediaFields | null;
}

interface EdgeUploadResponse {
  key?: unknown;
  size?: unknown;
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

interface EdgePresignUploadResponse {
  url?: unknown;
  key?: unknown;
  contentType?: unknown;
  expiresIn?: unknown;
}

interface ProxyUploadProfileMediaResponse {
  uploaded?: unknown;
  kind?: unknown;
  key?: unknown;
  hash?: unknown;
  size?: unknown;
  contentType?: unknown;
  cdnUrl?: unknown;
  versionedUrl?: unknown;
  strategy?: unknown;
  persistedProfile?: unknown;
}

let r2UploadFunctionUnavailable = false;
let r2PresignFunctionUnavailable = false;
const PROFILE_MEDIA_DIAGNOSTIC_SOURCE = "profile-media-upload";

type ProfileMediaUploadLogEvent =
  | "upload start"
  | "upload endpoint"
  | "upload response"
  | "upload error"
  | "upload fallback selected"
  | "upload final strategy"
  | "upload persisted profile";

const PROFILE_MEDIA_DIAGNOSTICS_ENABLED =
  import.meta.env.DEV ||
  String(import.meta.env.VITE_MESSLY_VERBOSE_LOGS ?? "").trim().toLowerCase() === "true";

function getUploadRuntimeEnvironment():
  | "web"
  | "desktop" {
  return typeof window !== "undefined" && window.electronAPI ? "desktop" : "web";
}

function getUploadDiagnosticContext(): Record<string, unknown> {
  const origin = typeof window !== "undefined" ? String(window.location.origin ?? "").trim() || null : null;
  return {
    environment: getUploadRuntimeEnvironment(),
    origin,
    canonicalWebOrigin: getCanonicalWebOrigin(),
    apiBaseUrl: String(getApiBaseUrl() ?? "").trim() || null,
    mediaProxyUrl: String(getProfileMediaUploadUrl() ?? "").trim() || null,
  };
}

function logProfileMediaUpload(
  event: ProfileMediaUploadLogEvent,
  details: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  if (!PROFILE_MEDIA_DIAGNOSTICS_ENABLED && level === "info") {
    return;
  }
  const payload = {
    ...getUploadDiagnosticContext(),
    ...details,
  };
  try {
    const line = `[profile-media] ${event}`;
    if (level === "error") {
      console.error(line, payload);
    } else if (level === "warn") {
      console.warn(line, payload);
    } else {
      console.info(line, payload);
    }
  } catch {
    // Ignore renderer logging failures.
  }

  const logDiagnostic = typeof window !== "undefined" ? window.electronAPI?.logDiagnostic : undefined;
  if (typeof logDiagnostic === "function") {
    void logDiagnostic({
      source: PROFILE_MEDIA_DIAGNOSTIC_SOURCE,
      event,
      level,
      details: payload,
    }).catch(() => undefined);
  }
}

function isInvalidManagedMediaApiBaseUrl(valueRaw: string | null | undefined): boolean {
  const value = String(valueRaw ?? "").trim();
  if (!value) {
    return true;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }

    const hostname = parsed.hostname.trim().toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if ((hostname === "messly.site" || hostname === "www.messly.site") && (!pathname || !pathname.startsWith("/api"))) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
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
      return allowedTypes.length > 0 ? `Formato nao suportado. Use: ${allowedTypes.join(", ")}.` : "Formato nao suportado.";
    }
    case "DIMENSIONS_TOO_SMALL": {
      const minWidth = toNumberOrUndefined(details.minWidth);
      const minHeight = toNumberOrUndefined(details.minHeight);
      return minWidth && minHeight
        ? `Imagem menor que o minimo permitido (${minWidth}x${minHeight}).`
        : "Imagem menor que o minimo permitido.";
    }
    case "DIMENSIONS_TOO_LARGE": {
      const maxWidth = toNumberOrUndefined(details.maxWidth);
      const maxHeight = toNumberOrUndefined(details.maxHeight);
      return maxWidth && maxHeight
        ? `Imagem maior que o maximo permitido (${maxWidth}x${maxHeight}).`
        : "Imagem maior que o maximo permitido.";
    }
    case "GIF_TOO_MANY_FRAMES":
      return "GIF excede o limite de frames permitido.";
    case "INVALID_IMAGE":
    default:
      return "Arquivo de imagem invalido.";
  }
}

function toProfileMediaUploadCode(value: unknown): ProfileMediaUploadErrorCode | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (
    code === "FILE_TOO_LARGE"
    || code === "UNSUPPORTED_TYPE"
    || code === "DIMENSIONS_TOO_SMALL"
    || code === "DIMENSIONS_TOO_LARGE"
    || code === "INVALID_IMAGE"
    || code === "GIF_TOO_MANY_FRAMES"
  ) {
    return code;
  }
  return null;
}

function parseProfileMediaApiError(error: unknown): ProfileMediaUploadError | null {
  if (!(error instanceof MediaApiError)) {
    return null;
  }

  const code = toProfileMediaUploadCode(error.code);
  if (!code) {
    return null;
  }

  const details =
    error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : {};

  return new ProfileMediaUploadError(code, details, getUploadErrorMessage(code, details));
}

function parseElectronProfileMediaUploadError(error: unknown): ProfileMediaUploadError | null {
  const message = String(error instanceof Error ? error.message : error ?? "").trim();
  const markerIndex = message.indexOf(ELECTRON_MEDIA_UPLOAD_ERROR_PREFIX);
  if (markerIndex < 0) {
    return null;
  }

  const payloadRaw = message.slice(markerIndex + ELECTRON_MEDIA_UPLOAD_ERROR_PREFIX.length).trim();
  if (!payloadRaw) {
    return new ProfileMediaUploadError("INVALID_IMAGE", {}, "Nao foi possivel processar a imagem enviada.");
  }

  try {
    const parsed = JSON.parse(payloadRaw) as { code?: unknown; details?: unknown };
    const code = String(parsed.code ?? "").trim() as ProfileMediaUploadErrorCode;
    const details =
      parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details)
        ? (parsed.details as Record<string, unknown>)
        : {};

    if (
      code !== "FILE_TOO_LARGE"
      && code !== "UNSUPPORTED_TYPE"
      && code !== "DIMENSIONS_TOO_SMALL"
      && code !== "DIMENSIONS_TOO_LARGE"
      && code !== "INVALID_IMAGE"
      && code !== "GIF_TOO_MANY_FRAMES"
    ) {
      return new ProfileMediaUploadError("INVALID_IMAGE", details, "Nao foi possivel processar a imagem enviada.");
    }

    return new ProfileMediaUploadError(code, details, getUploadErrorMessage(code, details));
  } catch {
    return new ProfileMediaUploadError("INVALID_IMAGE", {}, "Nao foi possivel processar a imagem enviada.");
  }
}

function shouldFallbackFromElectronUploadError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "").trim().toLowerCase();
  if (!message) {
    return false;
  }

  return [
    "missing required environment variable",
    "managed media upload failed",
    "profile media proxy upload failed",
    "error invoking remote method",
    "no handler registered for 'media:upload-profile'",
    "invalid app api base url",
    "network",
    "timeout",
    "fetch failed",
    "econnrefused",
    "enotfound",
    "getaddrinfo",
  ].some((pattern) => message.includes(pattern));
}

function getSupabaseFunctionsBaseUrl(): string | null {
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  if (!supabaseUrl) {
    return null;
  }

  if (import.meta.env.DEV && typeof window !== "undefined") {
    const host = String(window.location.hostname ?? "").trim().toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return "/__supabase/functions/v1";
    }
  }

  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`;
}

function isGifProfileMediaFile(file: File): boolean {
  const mimeType = String(file.type ?? "").trim().toLowerCase();
  if (mimeType === "image/gif") {
    return true;
  }

  return String(file.name ?? "").trim().toLowerCase().endsWith(".gif");
}

function inferProfileMediaMimeType(file: File): string | null {
  const declaredType = String(file.type ?? "").trim().toLowerCase();
  if (declaredType) {
    return declaredType;
  }

  const fileName = String(file.name ?? "").trim().toLowerCase();
  if (fileName.endsWith(".gif")) {
    return "image/gif";
  }
  if (fileName.endsWith(".png")) {
    return "image/png";
  }
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (fileName.endsWith(".webp")) {
    return "image/webp";
  }
  return null;
}

function withResolvedProfileMediaMimeType(file: File): File {
  const inferredType = inferProfileMediaMimeType(file);
  if (!inferredType) {
    return file;
  }

  const declaredType = String(file.type ?? "").trim().toLowerCase();
  if (declaredType === inferredType) {
    return file;
  }

  return new File([file], file.name, {
    type: inferredType,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
  });
}

function getProfileMediaExtension(file: File): string {
  const mimeType = inferProfileMediaMimeType(file) ?? "";
  if (mimeType === "image/gif") {
    return "gif";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }

  const fileName = String(file.name ?? "").trim().toLowerCase();
  if (fileName.endsWith(".gif")) {
    return "gif";
  }
  if (fileName.endsWith(".png")) {
    return "png";
  }
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
    return "jpg";
  }
  if (fileName.endsWith(".webp")) {
    return "webp";
  }

  return "webp";
}

function getProfileMediaKey(kind: ProfileMediaKind, userId: string, uploadFile: File): string {
  const extension = getProfileMediaExtension(uploadFile);
  return kind === "avatar" ? `avatars/${userId}.${extension}` : `banners/${userId}.${extension}`;
}

function shouldSkipGatewayMediaFallback(): boolean {
  if (typeof window === "undefined" || typeof window.electronAPI === "undefined") {
    return false;
  }

  const explicitApiUrl = String(import.meta.env.VITE_MESSLY_API_URL ?? "").trim();
  const runtimeApiUrl = String(getRuntimeAppApiUrl() ?? "").trim();
  const candidateApiUrl = explicitApiUrl || runtimeApiUrl;
  return isInvalidManagedMediaApiBaseUrl(candidateApiUrl);
}

function parseEdgeUploadErrorMessage(payload: unknown, fallbackMessage: string): string {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }

  const record = payload as { error?: unknown; message?: unknown };
  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object") {
    const nestedMessage = String((nestedError as { message?: unknown }).message ?? "").trim();
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  if (typeof nestedError === "string" && nestedError.trim()) {
    return nestedError.trim();
  }

  const topLevelMessage = String(record.message ?? "").trim();
  if (topLevelMessage) {
    return topLevelMessage;
  }

  return fallbackMessage;
}

function isEdgeFunctionMissing(payload: unknown, status: number): boolean {
  if (status === 404) {
    return true;
  }

  if (!payload || typeof payload !== "object") {
    return false;
  }

  const record = payload as { code?: unknown; error?: unknown };
  const directCode = String(record.code ?? "").trim().toUpperCase();
  if (directCode === "NOT_FOUND") {
    return true;
  }

  if (record.error && typeof record.error === "object") {
    const nestedCode = String((record.error as { code?: unknown }).code ?? "").trim().toUpperCase();
    if (nestedCode === "NOT_FOUND") {
      return true;
    }
  }

  return false;
}

function isEdgeFunctionUnavailableError(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    const code = String(error.code ?? "").trim().toUpperCase();
    return error.status === 404 || code === "NOT_FOUND" || code === "HTTP_404";
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const status = Number((error as { status?: unknown }).status ?? NaN);
  const code = String((error as { code?: unknown }).code ?? "").trim().toUpperCase();
  return status === 404 || code === "NOT_FOUND" || code === "HTTP_404";
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
  const allowedTypes = getAllowedTypes(kind);
  if (declaredType && !allowedTypes.includes(declaredType)) {
    throw new ProfileMediaUploadError(
      "UNSUPPORTED_TYPE",
      { allowedTypes: [...allowedTypes] },
      getUploadErrorMessage("UNSUPPORTED_TYPE", { allowedTypes: [...allowedTypes] }),
    );
  }
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
      reject(
        new ProfileMediaUploadError(
          "INVALID_IMAGE",
          {},
          "Nao foi possivel ler a imagem selecionada.",
        ),
      );
    };

    image.src = objectUrl;
  });
}

async function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new ProfileMediaUploadError("INVALID_IMAGE", {}, "Nao foi possivel converter a imagem para WebP."));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}

function getTargetSize(kind: ProfileMediaKind): { width: number; height: number; quality: number } {
  if (kind === "avatar") {
    return {
      width: 256,
      height: 256,
      quality: 0.92,
    };
  }

  return {
    width: 1200,
    height: 480,
    quality: 0.9,
  };
}

async function normalizeProfileMedia(kind: ProfileMediaKind, file: File, userId: string): Promise<File> {
  const image = await loadImageFromFile(file);

  const { width, height, quality } = getTargetSize(kind);
  const crop = computeCoverCrop(image.naturalWidth, image.naturalHeight, width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new ProfileMediaUploadError("INVALID_IMAGE", {}, "Nao foi possivel preparar a imagem.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  const webpBlob = await canvasToWebp(canvas, quality);
  return new File([webpBlob], `${userId}.webp`, {
    type: "image/webp",
    lastModified: Date.now(),
  });
}

async function uploadProfileMediaViaElectron(
  kind: ProfileMediaKind,
  userId: string,
  uploadFile: File,
): Promise<UploadProfileMediaResponse | null> {
  const uploadProfileMedia = window.electronAPI?.uploadProfileMedia;
  if (!uploadProfileMedia) {
    return null;
  }

  try {
    logProfileMediaUpload("upload start", {
      transport: "electron-ipc",
      kind,
      userId,
      fileName: uploadFile.name,
      fileSize: uploadFile.size,
      mimeType: uploadFile.type,
    });
    const bytes = await uploadFile.arrayBuffer();
    const accessToken = await authService.getCurrentAccessToken().catch(() => null);
    const uploaded = await uploadProfileMedia({
      kind,
      userId,
      bytes,
      mimeType: uploadFile.type,
      fileName: uploadFile.name,
      accessToken: accessToken || undefined,
    });

    logProfileMediaUpload("upload response", {
      transport: "electron-ipc",
      kind,
      userId,
      key: uploaded.key,
      size: uploaded.size,
      strategy: uploaded.strategy ?? "electron-ipc",
    });
    if (uploaded.persistedProfile && typeof uploaded.persistedProfile === "object") {
      logProfileMediaUpload("upload persisted profile", {
        transport: "electron-ipc",
        kind,
        userId,
        persistedProfile: uploaded.persistedProfile,
      });
    }
    logProfileMediaUpload("upload final strategy", {
      transport: "electron-ipc",
      kind,
      userId,
      strategy: uploaded.strategy ?? "electron-ipc",
    });
    const versionedUrl = typeof uploaded.versionedUrl === "string" ? uploaded.versionedUrl.trim() : "";
    if (versionedUrl) {
      if (PROFILE_MEDIA_DIAGNOSTICS_ENABLED) {
        console.info("media public url generated", {
          strategy: "profile-upload",
          transport: "electron-ipc",
          key: uploaded.key,
          url: versionedUrl,
        });
      }
    } else {
      console.warn("cdn fallback detected", {
        reason: "missing-versioned-url",
        transport: "electron-ipc",
        key: uploaded.key,
      });
    }
    return {
      key: uploaded.key,
      hash: uploaded.hash,
      size: uploaded.size,
      versionedUrl: versionedUrl || null,
      strategy: typeof uploaded.strategy === "string" ? uploaded.strategy : "electron-ipc",
      persistedProfile:
        uploaded.persistedProfile && typeof uploaded.persistedProfile === "object"
          ? (uploaded.persistedProfile as PersistedProfileMediaFields)
          : null,
    };
  } catch (error) {
    const parsedError = parseElectronProfileMediaUploadError(error);
    if (parsedError) {
      logProfileMediaUpload("upload error", {
        transport: "electron-ipc",
        kind,
        userId,
        code: parsedError.code,
        message: parsedError.message,
        details: parsedError.details,
      }, "error");
      throw parsedError;
    }

    logProfileMediaUpload("upload error", {
      transport: "electron-ipc",
      kind,
      userId,
      message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
    }, "error");

    if (shouldFallbackFromElectronUploadError(error)) {
      logProfileMediaUpload("upload response", {
        transport: "electron-ipc",
        kind,
        userId,
        fallback: "supabase-edge",
      }, "warn");
      return null;
    }
    throw error;
  }
}

async function uploadProfileMediaViaOfficialProxy(
  kind: ProfileMediaKind,
  userId: string,
  uploadFile: File,
): Promise<UploadProfileMediaResponse> {
  const endpoint = getProfileMediaUploadUrl();
  logProfileMediaUpload("upload endpoint", {
    transport: "official-profile-proxy",
    kind,
    userId,
    endpoint,
    method: "POST",
  });

  try {
    const uploaded = await uploadProfileMediaProxy({
      kind,
      file: uploadFile,
      fileName: uploadFile.name,
    }) as ProxyUploadProfileMediaResponse;

    const key = String(uploaded.key ?? "").trim();
    const hash = String(uploaded.hash ?? "").trim().toLowerCase();
    const size = Number(uploaded.size ?? uploadFile.size);
    const strategy = String(uploaded.strategy ?? "server-proxy").trim() || "server-proxy";
    const versionedUrl = String(uploaded.versionedUrl ?? uploaded.cdnUrl ?? "").trim() || null;
    const persistedProfile =
      uploaded.persistedProfile && typeof uploaded.persistedProfile === "object" && !Array.isArray(uploaded.persistedProfile)
        ? (uploaded.persistedProfile as PersistedProfileMediaFields)
        : null;
    if (versionedUrl) {
      if (PROFILE_MEDIA_DIAGNOSTICS_ENABLED) {
        console.info("media public url generated", {
          strategy: "profile-upload",
          transport: "official-profile-proxy",
          key,
          url: versionedUrl,
        });
      }
    } else {
      console.warn("cdn fallback detected", {
        reason: "missing-versioned-url",
        transport: "official-profile-proxy",
        key,
      });
    }

    logProfileMediaUpload("upload response", {
      transport: "official-profile-proxy",
      kind,
      userId,
      endpoint,
      key,
      size,
      strategy,
    });
    logProfileMediaUpload("upload final strategy", {
      transport: "official-profile-proxy",
      kind,
      userId,
      strategy,
    });
    if (persistedProfile) {
      logProfileMediaUpload("upload persisted profile", {
        transport: "official-profile-proxy",
        kind,
        userId,
        persistedProfile,
      });
    }

    return {
      key,
      hash,
      size: Number.isFinite(size) ? size : uploadFile.size,
      versionedUrl,
      strategy,
      persistedProfile,
    };
  } catch (error) {
    const parsedError = parseProfileMediaApiError(error);
    if (parsedError) {
      logProfileMediaUpload("upload error", {
        transport: "official-profile-proxy",
        kind,
        userId,
        endpoint,
        code: parsedError.code,
        message: parsedError.message,
        details: parsedError.details,
      }, "error");
      throw parsedError;
    }

    logProfileMediaUpload("upload error", {
      transport: "official-profile-proxy",
      kind,
      userId,
      endpoint,
      message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
      statusCode: error instanceof MediaApiError ? error.status : null,
      code: error instanceof MediaApiError ? error.code : null,
    }, "error");
    throw error;
  }
}

async function uploadProfileMediaViaEdgeFunction(
  kind: ProfileMediaKind,
  userId: string,
  uploadFile: File,
): Promise<UploadProfileMediaResponse | null> {
  // If presign endpoint is absent in the current project, avoid hitting
  // the legacy direct-upload function and producing duplicate 404 noise.
  if (r2PresignFunctionUnavailable) {
    return null;
  }

  if (r2UploadFunctionUnavailable) {
    return null;
  }

  const functionBaseUrl = getSupabaseFunctionsBaseUrl();
  if (!functionBaseUrl) {
    return null;
  }

  const functionHeaders = await getSupabaseFunctionHeaders({ requireAuth: true });
  if (!functionHeaders || !String(functionHeaders.authorization ?? "").trim()) {
    throw new Error("Sessao invalida ou expirada para envio de imagem.");
  }

  const mediaKey = getProfileMediaKey(kind, userId, uploadFile);
  const endpoint = `${functionBaseUrl}/r2-upload`;
  logProfileMediaUpload("upload endpoint", {
    transport: "supabase-edge-binary",
    kind,
    userId,
    endpoint,
    method: "POST",
  });
  const response = await fetch(`${functionBaseUrl}/r2-upload`, {
    method: "POST",
    headers: {
      ...functionHeaders,
      "x-media-key": mediaKey,
      "x-presign-expires": "300",
      "content-type": uploadFile.type || "application/octet-stream",
    },
    body: uploadFile,
  });

  const parsed = (await response.json().catch(() => null)) as EdgeUploadResponse | null;
  if (!response.ok) {
    if (isEdgeFunctionMissing(parsed, response.status)) {
      r2UploadFunctionUnavailable = true;
      return null;
    }

    const fallbackMessage = "Falha ao enviar imagem de perfil.";
    logProfileMediaUpload("upload error", {
      transport: "supabase-edge-binary",
      kind,
      userId,
      endpoint,
      status: response.status,
      response: parsed,
    }, "error");
    throw new Error(parseEdgeUploadErrorMessage(parsed, fallbackMessage));
  }

  const returnedKey = String(parsed?.key ?? "").trim() || mediaKey;
  const sha256 = await hashFile(uploadFile);
  const uploadedSize = Number(parsed?.size ?? uploadFile.size);
  logProfileMediaUpload("upload response", {
    transport: "supabase-edge-binary",
    kind,
    userId,
    endpoint,
    status: response.status,
    key: returnedKey,
    size: uploadedSize,
  });
  logProfileMediaUpload("upload final strategy", {
    transport: "supabase-edge-binary",
    kind,
    userId,
    strategy: "supabase-edge-binary",
  });

  return {
    key: returnedKey,
    hash: sha256,
    size: Number.isFinite(uploadedSize) ? uploadedSize : uploadFile.size,
    strategy: "supabase-edge-binary",
  };
}

async function uploadProfileMediaViaPresign(
  kind: ProfileMediaKind,
  userId: string,
  uploadFile: File,
): Promise<UploadProfileMediaResponse | null> {
  if (r2PresignFunctionUnavailable) {
    return null;
  }

  const mediaKey = getProfileMediaKey(kind, userId, uploadFile);
  let presignResponse: EdgePresignUploadResponse;
  const endpoint = `${getSupabaseFunctionsBaseUrl() ?? "unknown"}/r2-presign`;

  logProfileMediaUpload("upload endpoint", {
    transport: "supabase-presign",
    kind,
    userId,
    endpoint,
    method: "POST",
  });

  try {
    presignResponse = await invokeEdgeJson<
      {
        action: "put";
        key: string;
        contentType: string;
        fileSize: number;
        expiresSeconds: number;
      },
      EdgePresignUploadResponse
    >(
      "r2-presign",
      {
        action: "put",
        key: mediaKey,
        contentType: uploadFile.type || "application/octet-stream",
        fileSize: uploadFile.size,
        expiresSeconds: 300,
      },
      {
        requireAuth: true,
        retries: 1,
        timeoutMs: 18_000,
      },
    );
  } catch (error) {
    if (isEdgeFunctionUnavailableError(error)) {
      r2PresignFunctionUnavailable = true;
      return null;
    }
    throw error;
  }

  const uploadUrl = String(presignResponse?.url ?? "").trim();
  if (!uploadUrl) {
    throw new Error("Falha ao obter URL de upload de imagem de perfil.");
  }

  const contentType = String(presignResponse?.contentType ?? uploadFile.type ?? "application/octet-stream").trim()
    || "application/octet-stream";

  logProfileMediaUpload("upload start", {
    transport: "supabase-presign",
    kind,
    userId,
    endpoint: uploadUrl,
    method: "PUT",
    contentType,
    fileSize: uploadFile.size,
  });

  try {
    await uploadWithRetry({
      url: uploadUrl,
      file: uploadFile,
      contentType,
      retries: 1,
      timeoutMs: 60_000,
    });
  } catch (error) {
    logProfileMediaUpload("upload error", {
      transport: "supabase-presign",
      kind,
      userId,
      endpoint: uploadUrl,
      message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
    }, "error");
    throw error;
  }

  const returnedKey = String(presignResponse?.key ?? "").trim() || mediaKey;
  const sha256 = await hashFile(uploadFile);
  logProfileMediaUpload("upload response", {
    transport: "supabase-presign",
    kind,
    userId,
    endpoint: uploadUrl,
    key: returnedKey,
    size: uploadFile.size,
  });
  logProfileMediaUpload("upload final strategy", {
    transport: "supabase-presign",
    kind,
    userId,
    strategy: "supabase-presign-direct",
  });

  return {
    key: returnedKey,
    hash: sha256,
    size: uploadFile.size,
    strategy: "supabase-presign-direct",
  };
}

export async function uploadProfileMediaAsset(
  kind: ProfileMediaKind,
  userId: string,
  file: File,
): Promise<UploadProfileMediaResponse> {
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);
  const resolvedFile = withResolvedProfileMediaMimeType(file);
  ensureLocalConstraints(kind, resolvedFile);
  logProfileMediaUpload("upload start", {
    transport: isDesktopRuntime ? "desktop" : "web",
    kind,
    userId,
    fileName: resolvedFile.name,
    fileSize: resolvedFile.size,
    mimeType: resolvedFile.type,
  });

  if (isDesktopRuntime) {
    const electronUploadApi = window.electronAPI?.uploadProfileMedia;
    if (electronUploadApi) {
      const electronUpload = await uploadProfileMediaViaElectron(kind, userId, resolvedFile);
      if (electronUpload) {
        return electronUpload;
      }
    }
    logProfileMediaUpload("upload fallback selected", {
      transport: "desktop",
      kind,
      userId,
      from: "electron-ipc",
      to: "official-profile-proxy",
      reason: "electron handler unavailable or returned fallback",
    }, "warn");

    return uploadProfileMediaViaOfficialProxy(kind, userId, resolvedFile);
  }

  const uploadFile =
    isGifProfileMediaFile(resolvedFile)
      ? resolvedFile
      : await normalizeProfileMedia(kind, resolvedFile, userId);

  try {
    return await uploadProfileMediaViaOfficialProxy(kind, userId, uploadFile);
  } catch (proxyError) {
    logProfileMediaUpload("upload fallback selected", {
      transport: "web",
      kind,
      userId,
      from: "official-profile-proxy",
      to: "supabase-presign-direct",
      reason: proxyError instanceof Error ? proxyError.message : String(proxyError ?? "unknown_error"),
    }, "warn");
  }

  try {
    const presignUpload = await uploadProfileMediaViaPresign(kind, userId, uploadFile);
    if (presignUpload) {
      return presignUpload;
    }

    logProfileMediaUpload("upload fallback selected", {
      transport: "web",
      kind,
      userId,
      from: "supabase-presign-direct",
      to: "supabase-edge-binary",
      reason: "presign_unavailable",
    }, "warn");
  } catch (error) {
    logProfileMediaUpload("upload fallback selected", {
      transport: "web",
      kind,
      userId,
      from: "supabase-presign-direct",
      to: "supabase-edge-binary",
      reason: error instanceof Error ? error.message : String(error ?? "unknown_error"),
    }, "warn");
  }

  const edgeUpload = await uploadProfileMediaViaEdgeFunction(kind, userId, uploadFile);
  if (edgeUpload) {
    return edgeUpload;
  }

  if (!shouldSkipGatewayMediaFallback()) {
    logProfileMediaUpload("upload fallback selected", {
      transport: "web",
      kind,
      userId,
      from: "supabase-edge-binary",
      to: "managed-media-api",
      reason: "legacy_gateway_fallback",
    }, "warn");
    logProfileMediaUpload("upload endpoint", {
      transport: "managed-media-api",
      kind,
      userId,
      endpoint: String(getRuntimeAppApiUrl() ?? import.meta.env.VITE_MESSLY_API_URL ?? "").trim() || null,
    });
    const uploaded = await uploadMediaAsset({
      kind,
      file: uploadFile,
    });

    logProfileMediaUpload("upload response", {
      transport: "managed-media-api",
      kind,
      userId,
      key: uploaded.fileKey,
      size: uploadFile.size,
    });
    logProfileMediaUpload("upload final strategy", {
      transport: "managed-media-api",
      kind,
      userId,
      strategy: "managed-media-api",
    });
    return {
      key: uploaded.fileKey,
      hash: uploaded.sha256,
      size: uploadFile.size,
      strategy: "managed-media-api",
    };
  }

  throw new Error(kind === "avatar" ? "Falha ao enviar avatar. Tente novamente." : "Falha ao enviar banner. Tente novamente.");
}
