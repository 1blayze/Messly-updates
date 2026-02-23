export interface CompressImageOptions {
  maxDimension?: number;
  recompressThresholdBytes?: number;
  preferredFormat?: "image/webp" | "image/jpeg";
  minQuality?: number;
  maxQuality?: number;
  keepOriginal?: boolean;
}

export interface CompressImageResult {
  file: File;
  width: number;
  height: number;
  compressed: boolean;
  originalFile?: File;
  skippedReason?: "below-threshold" | "animated-gif";
}

export interface ThumbnailOptions {
  maxDimension?: number;
  mimeType?: "image/webp" | "image/jpeg";
  quality?: number;
  videoFrameTimeSec?: number;
}

export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

const DEFAULT_RECOMPRESS_THRESHOLD_BYTES = 300 * 1024;
const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_THUMB_DIMENSION = 480;

function getFileExtensionByMime(mimeType: string): string {
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/gif") {
    return "gif";
  }
  return "bin";
}

function replaceExtension(fileName: string, extension: string): string {
  const sanitized = fileName.trim() || `upload.${extension}`;
  const dotIndex = sanitized.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${sanitized}.${extension}`;
  }
  return `${sanitized.slice(0, dotIndex)}.${extension}`;
}

async function readArrayBuffer(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function isAnimatedGif(file: Blob): Promise<boolean> {
  const bytes = await readArrayBuffer(file);
  let frameCount = 0;

  for (let index = 0; index < bytes.length - 9; index += 1) {
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) {
      frameCount += 1;
      if (frameCount > 1) {
        return true;
      }
    }
  }

  return false;
}

async function loadImage(file: Blob): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Nao foi possivel carregar a imagem."));
    };

    image.src = objectUrl;
  });
}

function computeTargetDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const bigger = Math.max(width, height);
  if (bigger <= maxDimension) {
    return { width, height };
  }

  const scale = maxDimension / bigger;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Falha ao gerar blob da imagem."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeAdaptiveQuality(sizeBytes: number, minQuality: number, maxQuality: number): number {
  const sizeMb = sizeBytes / (1024 * 1024);
  const quality = maxQuality - sizeMb * 0.04;
  return clamp(quality, minQuality, maxQuality);
}

export async function compressImage(file: File, options: CompressImageOptions = {}): Promise<CompressImageResult> {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const thresholdBytes = options.recompressThresholdBytes ?? DEFAULT_RECOMPRESS_THRESHOLD_BYTES;
  const preferredFormat = options.preferredFormat ?? "image/webp";
  const minQuality = options.minQuality ?? 0.78;
  const maxQuality = options.maxQuality ?? 0.88;

  if (file.type === "image/gif" && (await isAnimatedGif(file))) {
    return {
      file,
      width: 0,
      height: 0,
      compressed: false,
      skippedReason: "animated-gif",
      ...(options.keepOriginal ? { originalFile: file } : {}),
    };
  }

  const { image, width, height } = await loadImage(file);
  const target = computeTargetDimensions(width, height, maxDimension);
  const requiresResize = target.width !== width || target.height !== height;
  const requiresRecompress = file.size > thresholdBytes || requiresResize;

  if (!requiresRecompress) {
    return {
      file,
      width,
      height,
      compressed: false,
      skippedReason: "below-threshold",
      ...(options.keepOriginal ? { originalFile: file } : {}),
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Falha ao inicializar canvas para compressao.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, target.width, target.height);

  const quality = computeAdaptiveQuality(file.size, minQuality, maxQuality);
  const outputBlob = await toBlob(canvas, preferredFormat, quality);

  const outputFile = new File([outputBlob], replaceExtension(file.name, getFileExtensionByMime(preferredFormat)), {
    type: preferredFormat,
    lastModified: Date.now(),
  });

  return {
    file: outputFile,
    width: target.width,
    height: target.height,
    compressed: true,
    ...(options.keepOriginal ? { originalFile: file } : {}),
  };
}

async function loadVideoFrame(file: Blob, timeSec: number): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.src = "";
    };

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const targetTime = Math.max(0, Math.min(timeSec, duration > 0 ? Math.max(0, duration - 0.05) : 0));
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      const width = Math.max(1, video.videoWidth || 1);
      const height = Math.max(1, video.videoHeight || 1);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        cleanup();
        reject(new Error("Nao foi possivel capturar frame do video."));
        return;
      }

      context.drawImage(video, 0, 0, width, height);
      cleanup();
      resolve({ canvas, width, height });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Nao foi possivel gerar thumbnail de video."));
    };

    video.src = objectUrl;
  });
}

export async function generateThumbnail(file: File | Blob, options: ThumbnailOptions = {}): Promise<ThumbnailResult> {
  const maxDimension = options.maxDimension ?? DEFAULT_THUMB_DIMENSION;
  const mimeType = options.mimeType ?? "image/webp";
  const quality = options.quality ?? 0.82;

  const sourceType = String((file as File).type ?? "").toLowerCase();

  if (sourceType.startsWith("video/")) {
    const frame = await loadVideoFrame(file, options.videoFrameTimeSec ?? 0.2);
    const target = computeTargetDimensions(frame.width, frame.height, maxDimension);

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Falha ao preparar thumbnail do video.");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(frame.canvas, 0, 0, target.width, target.height);

    const blob = await toBlob(canvas, mimeType, quality);
    return {
      blob,
      width: target.width,
      height: target.height,
      mimeType,
    };
  }

  const { image, width, height } = await loadImage(file);
  const target = computeTargetDimensions(width, height, maxDimension);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Falha ao preparar thumbnail da imagem.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, target.width, target.height);

  const blob = await toBlob(canvas, mimeType, quality);
  return {
    blob,
    width: target.width,
    height: target.height,
    mimeType,
  };
}
