import { createHash } from "node:crypto";
import sharp from "sharp";

const BYTE_PER_MB = 1024 * 1024;
const IMAGE_MAX_INPUT_PIXELS = 48e6;

const AVATAR_MAX_BYTES = 2 * BYTE_PER_MB;
const BANNER_MAX_BYTES = 5 * BYTE_PER_MB;

const AVATAR_TARGET_WIDTH = 512;
const AVATAR_TARGET_HEIGHT = 512;
const AVATAR_GIF_MAX_FRAMES = 60;

const BANNER_MIN_W = 600;
const BANNER_MIN_H = 240;
const BANNER_TARGET_WIDTH = 600;
const BANNER_TARGET_HEIGHT = 240;
const BANNER_MAX_W = 3000;
const BANNER_MAX_H = 1200;

const AVATAR_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const BANNER_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

type ProfileMediaKind = "avatar" | "banner";
type AllowedMimeType = (typeof AVATAR_ALLOWED_TYPES)[number];

interface ProcessedProfileMediaAssetInternal {
  buffer: Buffer;
  contentType: string;
  ext: string;
  hash: string;
  size: number;
}

interface DetectedImageType {
  ext: "png" | "jpg" | "webp" | "gif";
  mime: AllowedMimeType;
}

interface GifMetadata {
  width: number;
  height: number;
  frames: number;
}

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

function createProcessorError(code: string, details: Record<string, unknown> = {}): ProfileMediaProcessorError {
  return new ProfileMediaProcessorError(code, details, getUploadErrorMessage(code, details));
}

function getHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function detectImageTypeByMagic(buffer: Buffer): DetectedImageType | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) {
    return { ext: "png", mime: "image/png" };
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) {
    return { ext: "jpg", mime: "image/jpeg" };
  }

  const isWebp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (isWebp) {
    return { ext: "webp", mime: "image/webp" };
  }

  const gifHeader = buffer.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { ext: "gif", mime: "image/gif" };
  }

  return null;
}

function readGifMetadata(buffer: Buffer): GifMetadata | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 13) {
    return null;
  }

  const header = buffer.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") {
    return null;
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) {
    return null;
  }

  const packedField = buffer[10];
  const hasGlobalColorTable = (packedField & 0x80) !== 0;
  const globalColorTableSize = hasGlobalColorTable ? 3 * (1 << ((packedField & 0x07) + 1)) : 0;

  let pointer = 13 + globalColorTableSize;
  let frameCount = 0;

  while (pointer < buffer.length) {
    const blockId = buffer[pointer];

    if (blockId === 0x3b) {
      break;
    }

    if (blockId === 0x2c) {
      if (pointer + 10 > buffer.length) {
        return null;
      }

      frameCount += 1;

      const imagePackedField = buffer[pointer + 9];
      const hasLocalColorTable = (imagePackedField & 0x80) !== 0;
      const localColorTableSize = hasLocalColorTable ? 3 * (1 << ((imagePackedField & 0x07) + 1)) : 0;

      pointer += 10 + localColorTableSize;
      if (pointer >= buffer.length) {
        return null;
      }

      pointer += 1;
      while (pointer < buffer.length) {
        const dataBlockSize = buffer[pointer];
        pointer += 1;
        if (dataBlockSize === 0) {
          break;
        }
        pointer += dataBlockSize;
      }
      continue;
    }

    if (blockId === 0x21) {
      pointer += 2;
      while (pointer < buffer.length) {
        const extensionSize = buffer[pointer];
        pointer += 1;
        if (extensionSize === 0) {
          break;
        }
        pointer += extensionSize;
      }
      continue;
    }

    return null;
  }

  return {
    width,
    height,
    frames: frameCount,
  };
}

function invalidImage(allowedTypes: readonly string[]): ProfileMediaProcessorError {
  return createProcessorError("INVALID_IMAGE", { allowedTypes: [...allowedTypes] });
}

function assertAvatarByteLimit(buffer: Buffer): void {
  if (!buffer.length || buffer.length > AVATAR_MAX_BYTES) {
    throw createProcessorError("FILE_TOO_LARGE", {
      maxMb: Math.round(AVATAR_MAX_BYTES / BYTE_PER_MB),
    });
  }
}

function assertBannerByteLimit(buffer: Buffer): void {
  if (!buffer.length || buffer.length > BANNER_MAX_BYTES) {
    throw createProcessorError("FILE_TOO_LARGE", {
      maxMb: Math.round(BANNER_MAX_BYTES / BYTE_PER_MB),
    });
  }
}

async function processStaticAvatar(buffer: Buffer, detectedMime: AllowedMimeType): Promise<ProcessedProfileMediaAssetInternal> {
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (!metadata.width || !metadata.height) {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (
    detectedMime === "image/webp" &&
    metadata.width === AVATAR_TARGET_WIDTH &&
    metadata.height === AVATAR_TARGET_HEIGHT &&
    (metadata.pages == null || metadata.pages <= 1)
  ) {
    return {
      buffer,
      contentType: "image/webp",
      ext: "webp",
      hash: getHash(buffer),
      size: buffer.length,
    };
  }

  let normalized;
  try {
    normalized = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
      .rotate()
      .resize(AVATAR_TARGET_WIDTH, AVATAR_TARGET_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      .webp({
        quality: 90,
        effort: 4,
      })
      .toBuffer();
  } catch {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (!normalized.length || normalized.length > AVATAR_MAX_BYTES) {
    throw createProcessorError("FILE_TOO_LARGE", {
      maxMb: Math.round(AVATAR_MAX_BYTES / BYTE_PER_MB),
    });
  }

  return {
    buffer: normalized,
    contentType: "image/webp",
    ext: "webp",
    hash: getHash(normalized),
    size: normalized.length,
  };
}

function processGifAvatar(buffer: Buffer): ProcessedProfileMediaAssetInternal {
  const gifMetadata = readGifMetadata(buffer);
  if (!gifMetadata) {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (gifMetadata.frames < 1) {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (gifMetadata.frames > AVATAR_GIF_MAX_FRAMES) {
    throw createProcessorError("GIF_TOO_MANY_FRAMES", {
      maxFrames: AVATAR_GIF_MAX_FRAMES,
    });
  }

  return {
    buffer,
    contentType: "image/gif",
    ext: "gif",
    hash: getHash(buffer),
    size: buffer.length,
  };
}

async function processAvatarUpload(buffer: Buffer): Promise<ProcessedProfileMediaAssetInternal> {
  assertAvatarByteLimit(buffer);

  const detectedType = detectImageTypeByMagic(buffer);
  if (!detectedType) {
    throw invalidImage(AVATAR_ALLOWED_TYPES);
  }

  if (!AVATAR_ALLOWED_TYPES.includes(detectedType.mime)) {
    throw createProcessorError("UNSUPPORTED_TYPE", {
      allowedTypes: [...AVATAR_ALLOWED_TYPES],
    });
  }

  if (detectedType.mime === "image/gif") {
    return processGifAvatar(buffer);
  }

  return processStaticAvatar(buffer, detectedType.mime);
}

async function processBannerUpload(buffer: Buffer): Promise<ProcessedProfileMediaAssetInternal> {
  assertBannerByteLimit(buffer);

  const detectedType = detectImageTypeByMagic(buffer);
  if (!detectedType) {
    throw invalidImage(BANNER_ALLOWED_TYPES);
  }

  if (!BANNER_ALLOWED_TYPES.includes(detectedType.mime)) {
    throw createProcessorError("UNSUPPORTED_TYPE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  if (detectedType.mime === "image/gif") {
    const gifMeta = readGifMetadata(buffer);
    if (!gifMeta?.width || !gifMeta?.height) {
      throw invalidImage(BANNER_ALLOWED_TYPES);
    }

    if (gifMeta.width < BANNER_MIN_W || gifMeta.height < BANNER_MIN_H) {
      throw createProcessorError("DIMENSIONS_TOO_SMALL", {
        minWidth: BANNER_MIN_W,
        minHeight: BANNER_MIN_H,
      });
    }

    if (gifMeta.width > BANNER_MAX_W || gifMeta.height > BANNER_MAX_H) {
      throw createProcessorError("DIMENSIONS_TOO_LARGE", {
        maxWidth: BANNER_MAX_W,
        maxHeight: BANNER_MAX_H,
      });
    }

    return {
      buffer,
      contentType: "image/gif",
      ext: "gif",
      hash: getHash(buffer),
      size: buffer.length,
    };
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw invalidImage(BANNER_ALLOWED_TYPES);
  }

  if (!metadata.width || !metadata.height) {
    throw invalidImage(BANNER_ALLOWED_TYPES);
  }

  if (metadata.width < BANNER_MIN_W || metadata.height < BANNER_MIN_H) {
    throw createProcessorError("DIMENSIONS_TOO_SMALL", {
      minWidth: BANNER_MIN_W,
      minHeight: BANNER_MIN_H,
    });
  }

  if (metadata.width > BANNER_MAX_W || metadata.height > BANNER_MAX_H) {
    throw createProcessorError("DIMENSIONS_TOO_LARGE", {
      maxWidth: BANNER_MAX_W,
      maxHeight: BANNER_MAX_H,
    });
  }

  let normalized;
  try {
    normalized = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
      .rotate()
      .resize(BANNER_TARGET_WIDTH, BANNER_TARGET_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      .webp({
        quality: 90,
        effort: 4,
      })
      .toBuffer();
  } catch {
    throw invalidImage(BANNER_ALLOWED_TYPES);
  }

  if (!normalized.length || normalized.length > BANNER_MAX_BYTES) {
    throw createProcessorError("FILE_TOO_LARGE", {
      maxMb: Math.round(BANNER_MAX_BYTES / BYTE_PER_MB),
    });
  }

  return {
    buffer: normalized,
    contentType: "image/webp",
    ext: "webp",
    hash: getHash(normalized),
    size: normalized.length,
  };
}

export async function processProfileMediaUpload(
  kind: ProfileMediaKind,
  buffer: Buffer,
): Promise<ProcessedProfileMediaAsset> {
  try {
    const processed = kind === "avatar" ? await processAvatarUpload(buffer) : await processBannerUpload(buffer);
    return {
      buffer: processed.buffer,
      contentType: String(processed.contentType ?? "").trim() || "application/octet-stream",
      ext: String(processed.ext ?? "").trim() || "bin",
      hash: String(processed.hash ?? "").trim().toLowerCase(),
      size: Number(processed.size ?? processed.buffer?.length ?? 0),
    };
  } catch (error) {
    if (error instanceof ProfileMediaProcessorError) {
      throw error;
    }
    throw error;
  }
}
