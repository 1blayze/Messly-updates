import { getApiBaseUrl, toCdnUrl } from "../config/domains";
import { getRuntimeAppApiUrl } from "../config/runtimeApiConfig";
import { getSupabaseAccessToken } from "./client";

export type MediaUploadKind =
  | "avatar"
  | "banner"
  | "message_image"
  | "message_image_preview"
  | "message_image_original"
  | "message_video"
  | "message_video_preview"
  | "message_video_thumb"
  | "message_file";

export interface CreateMediaUploadRequest {
  kind: MediaUploadKind;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  fileName?: string | null;
  conversationId?: string | null;
}

export interface CreateMediaUploadResponse {
  uploadUrl: string | null;
  uploadHeaders: Record<string, string>;
  fileKey: string;
  cdnUrl: string;
  alreadyExists: boolean;
  expiresInSeconds: number;
}

export interface DeleteMediaRequest {
  fileKey: string;
}

export interface DeleteMediaResponse {
  deleted: boolean;
  fileKey: string;
  reason: "deleted" | "still_referenced" | "not_found";
  references: number;
}

export interface ProxyMediaUploadOptions {
  fileKey: string;
  file: Blob;
  contentType: string;
  onProgress?: (progress: { loaded: number; total: number; ratio: number; attempt: number }) => void;
  signal?: AbortSignal;
}

export class MediaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = "MediaApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorEnvelope {
  error?:
    | {
        code?: string;
        message?: string;
        details?: unknown;
      }
    | string;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toMediaApiError(response: Response, payload: unknown): MediaApiError {
  const parsed = (payload ?? {}) as ErrorEnvelope;
  const nested = typeof parsed.error === "object" && parsed.error !== null ? parsed.error : null;
  const code = String(nested?.code ?? parsed.error ?? `HTTP_${response.status}`).trim() || `HTTP_${response.status}`;
  const message = String(nested?.message ?? "Media request failed.").trim() || "Media request failed.";
  return new MediaApiError(message, response.status, code, nested?.details);
}

function shouldForceLocalCdnUrl(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeManagedMediaFileKey(fileKeyRaw: string): string {
  const raw = String(fileKeyRaw ?? "").trim();
  if (!raw) {
    return "";
  }

  const stripPublicPrefix = (value: string): string => value.replace(/^\/?media\/public\//i, "").replace(/^\/+/, "");

  if (!raw.includes("://")) {
    return stripPublicPrefix(raw).split(/[?#]/, 1)[0] ?? "";
  }

  try {
    const parsed = new URL(raw);
    return stripPublicPrefix(parsed.pathname).trim();
  } catch {
    return stripPublicPrefix(raw).split(/[?#]/, 1)[0] ?? "";
  }
}

function shouldSkipManagedMediaDeleteRequest(): boolean {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
    const apiBase = String(getApiBaseUrl() ?? "").trim();
    if ((hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") && apiBase.startsWith("/")) {
      return true;
    }
  }

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

async function requestJson<TResponse>(method: "POST" | "DELETE", path: string, payload: unknown): Promise<TResponse> {
  const accessToken = await getSupabaseAccessToken();
  if (!accessToken) {
    throw new MediaApiError("Sessao expirada para upload de midia.", 401, "UNAUTHORIZED");
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const parsed = await parseJsonSafe(response);
    if (!response.ok) {
      throw toMediaApiError(response, parsed);
    }

    return parsed as TResponse;
  } catch (error) {
    if (error instanceof MediaApiError) {
      throw error;
    }

    throw new MediaApiError(
      error instanceof Error ? error.message : "Falha de rede ao chamar a API de midia.",
      0,
      "MEDIA_NETWORK_ERROR",
    );
  }
}

export async function createMediaUpload(payload: CreateMediaUploadRequest): Promise<CreateMediaUploadResponse> {
  const response = await requestJson<CreateMediaUploadResponse>("POST", "/media/create-upload", payload);
  return {
    ...response,
    cdnUrl: shouldForceLocalCdnUrl() ? toCdnUrl(response.fileKey) : (response.cdnUrl || toCdnUrl(response.fileKey)),
    uploadHeaders: response.uploadHeaders ?? {},
  };
}

export async function deleteMedia(payload: DeleteMediaRequest): Promise<DeleteMediaResponse> {
  const normalizedFileKey = normalizeManagedMediaFileKey(payload.fileKey);
  if (!normalizedFileKey || shouldSkipManagedMediaDeleteRequest()) {
    return {
      deleted: false,
      fileKey: normalizedFileKey,
      reason: "not_found",
      references: 0,
    };
  }

  return requestJson<DeleteMediaResponse>("DELETE", "/media", {
    ...payload,
    fileKey: normalizedFileKey,
  });
}

export async function proxyMediaUpload(options: ProxyMediaUploadOptions): Promise<void> {
  const accessToken = await getSupabaseAccessToken();
  if (!accessToken) {
    throw new MediaApiError("Sessao expirada para upload de midia.", 401, "UNAUTHORIZED");
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const total = options.file.size;
    let aborted = false;

    const abortHandler = () => {
      aborted = true;
      xhr.abort();
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    options.signal?.addEventListener("abort", abortHandler, { once: true });

    xhr.open("POST", `${getApiBaseUrl()}/media/upload-proxy?fileKey=${encodeURIComponent(options.fileKey)}`, true);
    xhr.setRequestHeader("authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("content-type", options.contentType);

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress) {
        return;
      }

      const loaded = event.loaded;
      options.onProgress({
        loaded,
        total,
        ratio: total > 0 ? loaded / total : 0,
        attempt: 1,
      });
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      reject(new MediaApiError("Falha de rede ao enviar a midia.", 0, "MEDIA_NETWORK_ERROR"));
    };

    xhr.onabort = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      if (!aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
      }
    };

    xhr.onload = async () => {
      options.signal?.removeEventListener("abort", abortHandler);
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({
          loaded: total,
          total,
          ratio: 1,
          attempt: 1,
        });
        resolve();
        return;
      }

      const payload = (() => {
        try {
          return JSON.parse(xhr.responseText) as unknown;
        } catch {
          return null;
        }
      })();

      reject(
        payload
          ? toMediaApiError(
              new Response(JSON.stringify(payload), {
                status: xhr.status || 500,
              }),
              payload,
            )
          : new MediaApiError("Falha ao enviar a midia.", xhr.status || 500, `HTTP_${xhr.status || 500}`),
      );
    };

    xhr.send(options.file);
  });
}
