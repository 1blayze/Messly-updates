export interface UploadWithRetryOptions {
  url: string;
  file: Blob;
  contentType: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  onProgress?: (progress: { loaded: number; total: number; ratio: number; attempt: number }) => void;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function shouldRetry(error: unknown, statusCode: number | null, attempt: number, retries: number): boolean {
  if (attempt >= retries) {
    return false;
  }

  if (statusCode == null) {
    return true;
  }

  if (statusCode >= 500 || statusCode === 429 || statusCode === 408) {
    return true;
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }

  return false;
}

function uploadOnce(options: UploadWithRetryOptions, attempt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let aborted = false;

    const abortHandler = () => {
      aborted = true;
      xhr.abort();
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    options.signal?.addEventListener("abort", abortHandler, { once: true });

    xhr.open("PUT", options.url, true);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("content-type", options.contentType);

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress) {
        return;
      }

      const total = event.lengthComputable ? event.total : options.file.size;
      const loaded = event.loaded;
      options.onProgress({
        loaded,
        total,
        ratio: total > 0 ? loaded / total : 0,
        attempt,
      });
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      reject(new Error("Network error while uploading."));
    };

    xhr.ontimeout = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      reject(new DOMException("Upload timeout", "TimeoutError"));
    };

    xhr.onabort = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      if (!aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
      }
    };

    xhr.onload = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      const status = xhr.status;
      if (status >= 200 && status < 300) {
        options.onProgress?.({
          loaded: options.file.size,
          total: options.file.size,
          ratio: 1,
          attempt,
        });
        resolve();
        return;
      }

      const error = new Error(`Upload failed with status ${status}.`);
      (error as Error & { statusCode?: number }).statusCode = status;
      reject(error);
    };

    xhr.send(options.file);
  });
}

export async function uploadWithRetry(options: UploadWithRetryOptions): Promise<void> {
  const retries = Number.isFinite(options.retries) ? Math.max(0, Number(options.retries)) : DEFAULT_RETRIES;
  let attempt = 0;

  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }

    try {
      await uploadOnce(options, attempt + 1);
      return;
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode ?? NaN)
          : null;

      if (!shouldRetry(error, Number.isFinite(statusCode ?? NaN) ? Number(statusCode) : null, attempt, retries)) {
        throw error;
      }

      const backoffMs = Math.min(900 * 2 ** attempt, 7_000);
      attempt += 1;
      await sleep(backoffMs);
    }
  }
}
