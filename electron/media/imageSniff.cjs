function detectImageTypeByMagic(buffer) {
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
  const isGif = gifHeader === "GIF87a" || gifHeader === "GIF89a";
  if (isGif) {
    return { ext: "gif", mime: "image/gif" };
  }

  return null;
}

function readGifMetadata(buffer) {
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

      pointer += 10;
      pointer += localColorTableSize;
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

module.exports = {
  detectImageTypeByMagic,
  readGifMetadata,
};
