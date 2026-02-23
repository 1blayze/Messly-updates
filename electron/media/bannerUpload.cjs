const crypto = require("node:crypto");
const sharp = require("sharp");
const {
  BANNER_ALLOWED_TYPES,
  BANNER_MAX_BYTES,
  BANNER_MAX_H,
  BANNER_MAX_W,
  BANNER_MIN_H,
  BANNER_MIN_W,
  BANNER_TARGET_HEIGHT,
  BANNER_TARGET_WIDTH,
} = require("./imageLimits.cjs");
const { detectImageTypeByMagic } = require("./imageSniff.cjs");
const { createMediaUploadError } = require("./uploadErrors.cjs");

const IMAGE_MAX_INPUT_PIXELS = 48e6;

function getHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertBannerByteLimit(buffer) {
  if (!buffer.length || buffer.length > BANNER_MAX_BYTES) {
    throw createMediaUploadError("FILE_TOO_LARGE", {
      maxMb: Math.round(BANNER_MAX_BYTES / (1024 * 1024)),
    });
  }
}

async function processBannerUpload(buffer) {
  assertBannerByteLimit(buffer);

  const detectedType = detectImageTypeByMagic(buffer);
  if (!detectedType) {
    throw createMediaUploadError("INVALID_IMAGE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  if (!BANNER_ALLOWED_TYPES.includes(detectedType.mime)) {
    throw createMediaUploadError("UNSUPPORTED_TYPE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw createMediaUploadError("INVALID_IMAGE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  if (!metadata.width || !metadata.height) {
    throw createMediaUploadError("INVALID_IMAGE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  if (metadata.width < BANNER_MIN_W || metadata.height < BANNER_MIN_H) {
    throw createMediaUploadError("DIMENSIONS_TOO_SMALL", {
      minWidth: BANNER_MIN_W,
      minHeight: BANNER_MIN_H,
    });
  }

  if (metadata.width > BANNER_MAX_W || metadata.height > BANNER_MAX_H) {
    throw createMediaUploadError("DIMENSIONS_TOO_LARGE", {
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
    throw createMediaUploadError("INVALID_IMAGE", {
      allowedTypes: [...BANNER_ALLOWED_TYPES],
    });
  }

  if (!normalized.length || normalized.length > BANNER_MAX_BYTES) {
    throw createMediaUploadError("FILE_TOO_LARGE", {
      maxMb: Math.round(BANNER_MAX_BYTES / (1024 * 1024)),
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

module.exports = {
  processBannerUpload,
};
