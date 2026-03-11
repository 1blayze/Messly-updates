class NotificationDedupStore {
  constructor(options = {}) {
    this.ttlMs = Math.max(5_000, Number(options.ttlMs ?? 5 * 60_000));
    this.maxEntries = Math.max(64, Number(options.maxEntries ?? 10_000));
    this.entries = new Map();
  }

  checkAndMark(keys, nowMs = Date.now()) {
    const normalizedKeys = this.normalizeKeys(keys);
    if (normalizedKeys.length === 0) {
      return false;
    }

    this.prune(nowMs);
    for (const key of normalizedKeys) {
      if (this.entries.has(key)) {
        return true;
      }
    }
    for (const key of normalizedKeys) {
      this.entries.set(key, nowMs);
    }
    this.prune(nowMs);
    return false;
  }

  clear() {
    this.entries.clear();
  }

  normalizeKeys(keys) {
    const normalized = new Set();
    if (!Array.isArray(keys)) {
      return [];
    }

    for (const keyRaw of keys) {
      const key = String(keyRaw ?? "").trim();
      if (!key) {
        continue;
      }
      normalized.add(key.slice(0, 280));
    }
    return [...normalized];
  }

  prune(nowMs) {
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

module.exports = {
  NotificationDedupStore,
};
