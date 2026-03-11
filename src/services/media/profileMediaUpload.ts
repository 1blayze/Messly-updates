import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_MB,
  BANNER_ALLOWED_TYPES,
  BANNER_MAX_BYTES,
  BANNER_MAX_H,
  BANNER_MAX_MB,
  BANNER_MAX_W,
  BANNER_MIN_H,
  BANNER_MIN_W,
} from "./imageLimits";
import { uploadMediaAsset } from "../uploadMedia";
import { hashFile } from "../../utils/hashFile";
import { getSupabaseFunctionHeaders } from "../supabase";
import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";
import { uploadWithRetry } from "./uploadWithRetry";
import { getRuntimeAppApiUrl } from "../../config/runtimeApiConfig";
import { getSupabaseAccessToken } from "../../api/client";

export type ProfileMediaKind = "avatar" | "banner";

export type ProfileMediaUploadErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "DIMENSIONS_TOO_SMALL"
  | "DIMENSIONS_TOO_LARGE"
  | "INVALID_IMAGE"
  | "GIF_TOO_MANY_FRAMES";

const ELECTRON_MEDIA_UPLOAD_ERROR_PREFIX = "MEDIA_UPLOAD_ERROR::";

interface UploadProfileMediaResponse {
  key: string;
  hash: string;
  size: number;
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

let r2UploadFunctionUnavailable = false;
let r2PresignFunctionUnavailable = false;

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

  if (message.includes("missing required environment variable")) {
    return true;
  }

  if (message.includes("error invoking remote method") && message.includes("media:upload-profile")) {
    return true;
  }

  return false;
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

function getProfileMediaKey(kind: ProfileMediaKind, userId: string): string {
  return kind === "avatar" ? `avatars/${userId}.webp` : `banners/${userId}.webp`;
}

function shouldSkipGatewayMediaFallback(): boolean {
  if (typeof window === "undefined" || typeof window.electronAPI === "undefined") {
    return false;
  }

  const explicitApiUrl = String(import.meta.env.VITE_MESSLY_API_URL ?? "").trim();
  if (explicitApiUrl) {
    return false;
  }

  const runtimeApiUrl = String(getRuntimeAppApiUrl() ?? "").trim();
  if (runtimeApiUrl) {
    return false;
  }

  return true;
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
    width: 1024,
    height: 410,
    quality: 0.9,
  };
}

function assertImageDimensions(kind: ProfileMediaKind, image: HTMLImageElement): void {
  if (kind === "banner") {
    if (image.naturalWidth < BANNER_MIN_W || image.naturalHeight < BANNER_MIN_H) {
      throw new ProfileMediaUploadError(
        "DIMENSIONS_TOO_SMALL",
        { minWidth: BANNER_MIN_W, minHeight: BANNER_MIN_H },
        getUploadErrorMessage("DIMENSIONS_TOO_SMALL", { minWidth: BANNER_MIN_W, minHeight: BANNER_MIN_H }),
      );
    }

    if (image.naturalWidth > BANNER_MAX_W || image.naturalHeight > BANNER_MAX_H) {
      throw new ProfileMediaUploadError(
        "DIMENSIONS_TOO_LARGE",
        { maxWidth: BANNER_MAX_W, maxHeight: BANNER_MAX_H },
        getUploadErrorMessage("DIMENSIONS_TOO_LARGE", { maxWidth: BANNER_MAX_W, maxHeight: BANNER_MAX_H }),
      );
    }
  }
}

async function normalizeProfileMedia(kind: ProfileMediaKind, file: File, userId: string): Promise<File> {
  const image = await loadImageFromFile(file);
  assertImageDimensions(kind, image);

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
    const bytes = await uploadFile.arrayBuffer();
    const accessToken = await getSupabaseAccessToken().catch(() => null);
    const uploaded = await uploadProfileMedia({
      kind,
      userId,
      bytes,
      mimeType: uploadFile.type,
      fileName: uploadFile.name,
      accessToken: accessToken || undefined,
    });

    return {
      key: uploaded.key,
      hash: uploaded.hash,
      size: uploaded.size,
    };
  } catch (error) {
    const parsedError = parseElectronProfileMediaUploadError(error);
    if (parsedError) {
      throw parsedError;
    }
    if (shouldFallbackFromElectronUploadError(error)) {
      return null;
    }
    throw error;
  }
}

async function uploadProfileMediaViaEdgeFunction(
  kind: ProfileMediaKind,
  userId: string,
  normalizedFile: File,
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

  const mediaKey = getProfileMediaKey(kind, userId);
  const response = await fetch(`${functionBaseUrl}/r2-upload`, {
    method: "POST",
    headers: {
      ...functionHeaders,
      "x-media-key": mediaKey,
      "x-presign-expires": "300",
      "content-type": normalizedFile.type || "application/octet-stream",
    },
    body: normalizedFile,
  });

  const parsed = (await response.json().catch(() => null)) as EdgeUploadResponse | null;
  if (!response.ok) {
    if (isEdgeFunctionMissing(parsed, response.status)) {
      r2UploadFunctionUnavailable = true;
      return null;
    }

    const fallbackMessage = "Falha ao enviar imagem de perfil.";
    throw new Error(parseEdgeUploadErrorMessage(parsed, fallbackMessage));
  }

  const returnedKey = String(parsed?.key ?? "").trim() || mediaKey;
  const sha256 = await hashFile(normalizedFile);
  const uploadedSize = Number(parsed?.size ?? normalizedFile.size);

  return {
    key: returnedKey,
    hash: sha256,
    size: Number.isFinite(uploadedSize) ? uploadedSize : normalizedFile.size,
  };
}

async function uploadProfileMediaViaPresign(
  kind: ProfileMediaKind,
  userId: string,
  normalizedFile: File,
): Promise<UploadProfileMediaResponse | null> {
  if (r2PresignFunctionUnavailable) {
    return null;
  }

  const mediaKey = getProfileMediaKey(kind, userId);
  let presignResponse: EdgePresignUploadResponse;

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
        contentType: normalizedFile.type || "application/octet-stream",
        fileSize: normalizedFile.size,
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

  const contentType = String(presignResponse?.contentType ?? normalizedFile.type ?? "application/octet-stream").trim()
    || "application/octet-stream";

  await uploadWithRetry({
    url: uploadUrl,
    file: normalizedFile,
    contentType,
    retries: 2,
    timeoutMs: 60_000,
  });

  const returnedKey = String(presignResponse?.key ?? "").trim() || mediaKey;
  const sha256 = await hashFile(normalizedFile);

  return {
    key: returnedKey,
    hash: sha256,
    size: normalizedFile.size,
  };
}

export async function uploadProfileMediaAsset(
  kind: ProfileMediaKind,
  userId: string,
  file: File,
): Promise<UploadProfileMediaResponse> {
  ensureLocalConstraints(kind, file);
  if (typeof window !== "undefined" && window.electronAPI?.uploadProfileMedia) {
    const electronUpload = await uploadProfileMediaViaElectron(kind, userId, file);
    if (electronUpload) {
      return electronUpload;
    }
  }

  const normalizedFile = await normalizeProfileMedia(kind, file, userId);
  const shouldPreferEdgeBinaryUpload = typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
  if (shouldPreferEdgeBinaryUpload) {
    const edgeFirstUpload = await uploadProfileMediaViaEdgeFunction(kind, userId, normalizedFile);
    if (edgeFirstUpload) {
      return edgeFirstUpload;
    }
  }

  const presignUpload = await uploadProfileMediaViaPresign(kind, userId, normalizedFile);
  if (presignUpload) {
    return presignUpload;
  }

  const edgeUpload = await uploadProfileMediaViaEdgeFunction(kind, userId, normalizedFile);
  if (edgeUpload) {
    return edgeUpload;
  }

  if (shouldSkipGatewayMediaFallback()) {
    throw new Error(
      "Upload de imagem indisponivel: configure VITE_MESSLY_API_URL no build do desktop ou publique a Edge Function r2-presign.",
    );
  }

  const uploaded = await uploadMediaAsset({
    kind,
    file: normalizedFile,
  });

  return {
    key: uploaded.fileKey,
    hash: uploaded.sha256,
    size: normalizedFile.size,
  };
}
