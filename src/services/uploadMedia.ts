import {
  createMediaUpload,
  proxyMediaUpload,
  type CreateMediaUploadRequest,
  type MediaUploadKind,
} from "../api/mediaController";
import { hashFile } from "../utils/hashFile";
import { uploadWithRetry } from "./media/uploadWithRetry";

export interface UploadMediaAssetInput {
  kind: MediaUploadKind;
  file: File;
  conversationId?: string | null;
  onProgress?: (ratio: number) => void;
}

export interface UploadMediaAssetResult {
  sha256: string;
  fileKey: string;
  cdnUrl: string;
  alreadyExists: boolean;
}

function shouldUseGatewayUploadProxy(kind: MediaUploadKind): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (typeof window.electronAPI !== "undefined") {
    return false;
  }

  const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    return false;
  }

  return kind === "avatar" || kind === "banner";
}

export async function createMediaUploadRequest(
  input: UploadMediaAssetInput,
  sha256?: string,
): Promise<CreateMediaUploadRequest> {
  const digest = sha256 ?? (await hashFile(input.file));
  return {
    kind: input.kind,
    sha256: digest,
    contentType: input.file.type || "application/octet-stream",
    sizeBytes: input.file.size,
    fileName: input.file.name || null,
    conversationId: input.conversationId ?? null,
  };
}

export async function uploadMediaAsset(input: UploadMediaAssetInput): Promise<UploadMediaAssetResult> {
  const sha256 = await hashFile(input.file);
  const request = await createMediaUploadRequest(input, sha256);
  const upload = await createMediaUpload(request);
  const resolvedContentType = upload.uploadHeaders["content-type"] ?? input.file.type ?? "application/octet-stream";

  if (upload.uploadUrl) {
    if (shouldUseGatewayUploadProxy(input.kind)) {
      await proxyMediaUpload({
        fileKey: upload.fileKey,
        file: input.file,
        contentType: resolvedContentType,
        onProgress: input.onProgress
          ? ({ ratio }) => {
              input.onProgress?.(ratio);
            }
          : undefined,
      });
    } else {
      await uploadWithRetry({
        url: upload.uploadUrl,
        file: input.file,
        contentType: resolvedContentType,
        retries: 2,
        timeoutMs: 60_000,
        headers: upload.uploadHeaders,
        onProgress: input.onProgress
          ? ({ ratio }) => {
              input.onProgress?.(ratio);
            }
          : undefined,
      });
    }
  } else {
    input.onProgress?.(1);
  }

  return {
    sha256,
    fileKey: upload.fileKey,
    cdnUrl: upload.cdnUrl,
    alreadyExists: upload.alreadyExists,
  };
}
