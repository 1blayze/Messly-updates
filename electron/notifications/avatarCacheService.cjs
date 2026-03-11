const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_AVATAR_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_FILES = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_500;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60_000;

function ensureHttpUrl(rawValue) {
  try {
    const parsed = new URL(String(rawValue ?? ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

class AvatarCacheService {
  constructor(options = {}) {
    this.app = options.app;
    this.nativeImage = options.nativeImage;
    this.fetchImpl = options.fetchImpl ?? global.fetch;
    this.cacheTtlMs = Math.max(60_000, Number(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
    this.maxCacheFiles = Math.max(64, Number(options.maxCacheFiles ?? DEFAULT_CACHE_MAX_FILES));
    this.requestTimeoutMs = Math.max(1_000, Number(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
    this.cleanupIntervalMs = Math.max(30_000, Number(options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS));
    this.imageSize = Math.max(32, Number(options.imageSize ?? 96));
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
    this.inFlightByKey = new Map();
    this.lastCleanupAt = 0;
    this.cacheDirPath = path.join(this.app.getPath("userData"), "notification-assets", "avatars");
  }

  async resolveAvatarPath(payload = {}) {
    const avatarUrl = ensureHttpUrl(payload.avatarUrl);
    if (!avatarUrl) {
      return null;
    }
    if (typeof this.fetchImpl !== "function" || !this.nativeImage) {
      return null;
    }

    const key = this.buildCacheKey(avatarUrl, payload);
    if (!key) {
      return null;
    }
    const filePath = path.join(this.cacheDirPath, `${key}.png`);

    const fromDisk = await this.readFreshAvatarFromDisk(filePath);
    if (fromDisk) {
      this.debugLog("avatar_cache_hit", {
        authorId: String(payload.authorId ?? "").trim() || null,
        key,
      });
      this.scheduleCleanup();
      return fromDisk;
    }

    const existingInFlight = this.inFlightByKey.get(key);
    if (existingInFlight) {
      this.debugLog("avatar_cache_inflight_reuse", {
        authorId: String(payload.authorId ?? "").trim() || null,
        key,
      });
      return existingInFlight;
    }

    const task = this.downloadAndCacheAvatar(avatarUrl, filePath, {
      key,
      authorId: String(payload.authorId ?? "").trim() || null,
    })
      .catch(() => null)
      .finally(() => {
        this.inFlightByKey.delete(key);
      });
    this.inFlightByKey.set(key, task);
    return task;
  }

  clear() {
    this.inFlightByKey.clear();
  }

  buildCacheKey(avatarUrl, payload) {
    const authorId = String(payload.authorId ?? "").trim();
    const avatarVersion = String(payload.avatarVersion ?? "").trim();
    const fingerprint = `${avatarUrl}|${authorId}|${avatarVersion}`;
    return crypto.createHash("sha1").update(fingerprint).digest("hex");
  }

  async ensureCacheDir() {
    await fs.promises.mkdir(this.cacheDirPath, { recursive: true });
  }

  async readFreshAvatarFromDisk(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (Date.now() - stat.mtimeMs > this.cacheTtlMs) {
        return null;
      }
      return filePath;
    } catch {
      return null;
    }
  }

  async downloadAndCacheAvatar(avatarUrl, filePath, context = {}) {
    const binaryImage = await this.downloadAvatarBuffer(avatarUrl);
    if (!binaryImage || binaryImage.length === 0) {
      return null;
    }

    let image;
    try {
      image = this.nativeImage.createFromBuffer(binaryImage);
    } catch {
      return null;
    }
    if (!image || image.isEmpty()) {
      return null;
    }

    const resized = image.resize({
      width: this.imageSize,
      height: this.imageSize,
      quality: "best",
    });
    const pngBuffer = resized.toPNG();
    if (!pngBuffer || pngBuffer.length === 0) {
      return null;
    }

    await this.ensureCacheDir();
    await fs.promises.writeFile(filePath, pngBuffer);
    this.debugLog("avatar_downloaded", {
      authorId: context.authorId ?? null,
      key: context.key ?? null,
      byteLength: pngBuffer.length,
    });
    this.scheduleCleanup();
    return filePath;
  }

  async downloadAvatarBuffer(avatarUrl) {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(avatarUrl, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: abortController.signal,
      });
      if (!response || !response.ok) {
        return null;
      }

      const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("image/")) {
        return null;
      }

      const contentLengthHeader = Number(response.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(contentLengthHeader) && contentLengthHeader > MAX_AVATAR_DOWNLOAD_BYTES) {
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength <= 0 || arrayBuffer.byteLength > MAX_AVATAR_DOWNLOAD_BYTES) {
        return null;
      }
      return Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  scheduleCleanup() {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
      return;
    }
    this.lastCleanupAt = now;
    void this.cleanupOldEntries();
  }

  async cleanupOldEntries() {
    try {
      await this.ensureCacheDir();
      const entries = await fs.promises.readdir(this.cacheDirPath, {
        withFileTypes: true,
      });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".png")) {
          continue;
        }
        const filePath = path.join(this.cacheDirPath, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          files.push({
            filePath,
            mtimeMs: stat.mtimeMs,
          });
        } catch {}
      }

      const expiredThreshold = Date.now() - this.cacheTtlMs;
      const expiredFiles = files.filter((file) => file.mtimeMs < expiredThreshold);
      const sortedByFreshness = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs);
      const overflowFiles =
        sortedByFreshness.length > this.maxCacheFiles
          ? sortedByFreshness.slice(this.maxCacheFiles)
          : [];

      const filesToDelete = new Set([
        ...expiredFiles.map((file) => file.filePath),
        ...overflowFiles.map((file) => file.filePath),
      ]);
      await Promise.allSettled(
        [...filesToDelete].map(async (filePath) => {
          await fs.promises.unlink(filePath);
        }),
      );
    } catch {}
  }
}

module.exports = {
  AvatarCacheService,
};
