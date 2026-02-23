export interface CoverTransform {
  minScale: number;
  scale: number;
  panX: number;
  panY: number;
  maxPanX: number;
  maxPanY: number;
  rotationDegrees: number;
}

export interface CoverSourceCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ExportCroppedImageInput {
  image: HTMLImageElement;
  fileName: string;
  frameWidth: number;
  frameHeight: number;
  outputWidth: number;
  outputHeight: number;
  zoom: number;
  panX: number;
  panY: number;
  rotationDegrees?: number;
  mimeType?: string;
  quality?: number;
}

function normalizeRotationDegrees(rotationDegrees: number): number {
  const normalized = rotationDegrees % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function computeRotatedBounds(width: number, height: number, radians: number): { width: number; height: number } {
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  return {
    width: width * absCos + height * absSin,
    height: width * absSin + height * absCos,
  };
}

export function resolveCoverTransform(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  zoom: number,
  panX: number,
  panY: number,
  rotationDegrees = 0,
): CoverTransform {
  const normalizedRotation = normalizeRotationDegrees(rotationDegrees);
  const radians = (normalizedRotation * Math.PI) / 180;
  const rotatedAtScaleOne = computeRotatedBounds(imageWidth, imageHeight, radians);

  const minScaleX = frameWidth / rotatedAtScaleOne.width;
  const minScaleY = frameHeight / rotatedAtScaleOne.height;
  // Minimum scale that guarantees the image fully covers the crop frame.
  const minScale = Math.max(minScaleX, minScaleY);
  const safeZoom = Number.isFinite(zoom) ? Math.min(4, Math.max(1, zoom)) : 1;
  const scale = minScale * safeZoom;

  const renderedWidth = rotatedAtScaleOne.width * scale;
  const renderedHeight = rotatedAtScaleOne.height * scale;
  const maxPanX = Math.max(0, (renderedWidth - frameWidth) / 2);
  const maxPanY = Math.max(0, (renderedHeight - frameHeight) / 2);
  const clampedPanX = Math.min(maxPanX, Math.max(-maxPanX, panX));
  const clampedPanY = Math.min(maxPanY, Math.max(-maxPanY, panY));

  return {
    minScale,
    scale,
    panX: clampedPanX,
    panY: clampedPanY,
    maxPanX,
    maxPanY,
    rotationDegrees: normalizedRotation,
  };
}

export function mapFrameToSourceCrop(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  transform: CoverTransform,
): CoverSourceCrop {
  const sx = imageWidth / 2 + (-frameWidth / 2 - transform.panX) / transform.scale;
  const sy = imageHeight / 2 + (-frameHeight / 2 - transform.panY) / transform.scale;
  const sw = frameWidth / transform.scale;
  const sh = frameHeight / transform.scale;

  return {
    sx: Math.max(0, Math.min(imageWidth - sw, sx)),
    sy: Math.max(0, Math.min(imageHeight - sh, sy)),
    sw,
    sh,
  };
}

function withExtension(fileName: string, mimeType: string): string {
  const baseName = fileName.replace(/\.[^/.]+$/, "") || "imagem";
  if (mimeType === "image/jpeg") {
    return `${baseName}.jpg`;
  }
  if (mimeType === "image/png") {
    return `${baseName}.png`;
  }
  return `${baseName}.webp`;
}

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Nao foi possivel gerar a imagem editada."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

export async function exportCroppedImage({
  image,
  fileName,
  frameWidth,
  frameHeight,
  outputWidth,
  outputHeight,
  zoom,
  panX,
  panY,
  rotationDegrees = 0,
  mimeType = "image/webp",
  quality = 0.92,
}: ExportCroppedImageInput): Promise<File> {
  const transform = resolveCoverTransform(
    image.naturalWidth,
    image.naturalHeight,
    frameWidth,
    frameHeight,
    zoom,
    panX,
    panY,
    rotationDegrees,
  );
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(outputWidth * scale);
  canvas.height = Math.round(outputHeight * scale);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Nao foi possivel preparar o editor de imagem.");
  }

  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, outputWidth, outputHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.save();
  // Keep exact crop composition by mapping frame-space transform to output-space.
  context.scale(outputWidth / frameWidth, outputHeight / frameHeight);
  context.beginPath();
  context.rect(0, 0, frameWidth, frameHeight);
  context.clip();
  context.translate(frameWidth / 2 + transform.panX, frameHeight / 2 + transform.panY);
  context.rotate((transform.rotationDegrees * Math.PI) / 180);
  context.scale(transform.scale, transform.scale);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();

  const blob = await toBlob(canvas, mimeType, quality);
  return new File([blob], withExtension(fileName, mimeType), { type: mimeType });
}
