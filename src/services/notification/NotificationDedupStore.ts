interface NotificationDedupStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_DEDUP_TTL_MS = 5 * 60_000;
const DEFAULT_DEDUP_MAX_ENTRIES = 8_000;

export class NotificationDedupStore {
  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly entries = new Map<string, number>();

  constructor(options: NotificationDedupStoreOptions = {}) {
    this.ttlMs = Math.max(5_000, Number(options.ttlMs ?? DEFAULT_DEDUP_TTL_MS));
    this.maxEntries = Math.max(64, Number(options.maxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES));
  }

  checkAndMark(keys: readonly string[]): boolean {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      return false;
    }

    const now = Date.now();
    this.prune(now);
    for (const key of normalizedKeys) {
      if (this.entries.has(key)) {
        return true;
      }
    }

    for (const key of normalizedKeys) {
      this.entries.set(key, now);
    }
    this.prune(now);
    return false;
  }

  unmark(keys: readonly string[]): void {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      return;
    }
    for (const key of normalizedKeys) {
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private normalizeKeys(keys: readonly string[]): string[] {
    const normalized = new Set<string>();
    for (const keyRaw of keys) {
      const key = String(keyRaw ?? "").trim();
      if (!key) {
        continue;
      }
      normalized.add(key.slice(0, 256));
    }
    return [...normalized];
  }

  private prune(nowMs: number): void {
    for (const [key, createdAt] of this.entries) {
      if (nowMs - createdAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }

    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const overflow = this.entries.size - this.maxEntries;
    let removed = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      removed += 1;
      if (removed >= overflow) {
        break;
      }
    }
  }
}
