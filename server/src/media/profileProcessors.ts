import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const MEDIA_UPLOAD_ERROR_PREFIX = "MEDIA_UPLOAD_ERROR::";

type ProfileMediaKind = "avatar" | "banner";

interface RawProcessorErrorPayload {
  code?: unknown;
  details?: unknown;
}

interface RawProcessedProfileMediaAsset {
  buffer: Buffer;
  contentType: string;
  ext: string;
  hash: string;
  size: number;
}

interface ProcessorModule {
  processAvatarUpload?: (buffer: Buffer) => Promise<RawProcessedProfileMediaAsset>;
  processBannerUpload?: (buffer: Buffer) => Promise<RawProcessedProfileMediaAsset>;
}

const avatarProcessorModule = require("../../../electron/media/avatarUpload.cjs") as ProcessorModule;
const bannerProcessorModule = require("../../../electron/media/bannerUpload.cjs") as ProcessorModule;

export interface ProcessedProfileMediaAsset {
  buffer: Buffer;
  contentType: string;
  ext: string;
  hash: string;
  size: number;
}

export class ProfileMediaProcessorError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown>, message: string) {
    super(message);
    this.name = "ProfileMediaProcessorError";
    this.code = code;
    this.details = details;
  }
}

function getUploadErrorMessage(code: string, details: Record<string, unknown>): string {
  switch (code) {
    case "FILE_TOO_LARGE": {
      const maxMb = Number(details.maxMb ?? NaN);
      return Number.isFinite(maxMb) ? `Arquivo acima do limite de ${maxMb} MB.` : "Arquivo acima do limite permitido.";
    }
    case "UNSUPPORTED_TYPE":
      return "Formato nao suportado.";
    case "DIMENSIONS_TOO_SMALL":
      return "Imagem menor que o minimo permitido.";
    case "DIMENSIONS_TOO_LARGE":
      return "Imagem maior que o maximo permitido.";
    case "GIF_TOO_MANY_FRAMES":
      return "GIF excede o limite de frames permitido.";
    case "INVALID_IMAGE":
    default:
      return "Arquivo de imagem invalido.";
  }
}

function toRecordDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseProcessorError(error: unknown): ProfileMediaProcessorError | null {
  const message = String(error instanceof Error ? error.message : error ?? "").trim();
  if (!message.startsWith(MEDIA_UPLOAD_ERROR_PREFIX)) {
    return null;
  }

  const payloadRaw = message.slice(MEDIA_UPLOAD_ERROR_PREFIX.length).trim();
  if (!payloadRaw) {
    return new ProfileMediaProcessorError("INVALID_IMAGE", {}, "Arquivo de imagem invalido.");
  }

  try {
    const parsed = JSON.parse(payloadRaw) as RawProcessorErrorPayload;
    const code = String(parsed.code ?? "INVALID_IMAGE").trim().toUpperCase() || "INVALID_IMAGE";
    const details = toRecordDetails(parsed.details);
    return new ProfileMediaProcessorError(code, details, getUploadErrorMessage(code, details));
  } catch {
    return new ProfileMediaProcessorError("INVALID_IMAGE", {}, "Arquivo de imagem invalido.");
  }
}

export async function processProfileMediaUpload(
  kind: ProfileMediaKind,
  buffer: Buffer,
): Promise<ProcessedProfileMediaAsset> {
  try {
    const processor =
      kind === "avatar"
        ? avatarProcessorModule.processAvatarUpload
        : bannerProcessorModule.processBannerUpload;

    if (typeof processor !== "function") {
      throw new Error(`Profile media processor unavailable for kind ${kind}.`);
    }

    const processed = await processor(buffer);
    return {
      buffer: processed.buffer,
      contentType: String(processed.contentType ?? "").trim() || "application/octet-stream",
      ext: String(processed.ext ?? "").trim() || "bin",
      hash: String(processed.hash ?? "").trim().toLowerCase(),
      size: Number(processed.size ?? processed.buffer?.length ?? 0),
    };
  } catch (error) {
    const parsed = parseProcessorError(error);
    if (parsed) {
      throw parsed;
    }
    throw error;
  }
}
