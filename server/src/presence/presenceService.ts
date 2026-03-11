import type { PresenceStatus } from "../events/eventTypes";

export interface PresenceSnapshot {
  userId: string;
  status: PresenceStatus;
  activities: unknown[];
  lastSeen: string;
}

export interface PresenceStore {
  upsert(snapshot: PresenceSnapshot, ttlSeconds: number): Promise<void>;
  remove(userId: string): Promise<void>;
  get(userId: string): Promise<PresenceSnapshot | null>;
}

interface InMemoryPresenceEntry {
  snapshot: PresenceSnapshot;
  expiresAt: number;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly entries = new Map<string, InMemoryPresenceEntry>();

  async upsert(snapshot: PresenceSnapshot, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    this.entries.set(snapshot.userId, {
      snapshot,
      expiresAt: now + Math.max(1, ttlSeconds) * 1_000,
    });
  }

  async remove(userId: string): Promise<void> {
    this.entries.delete(userId);
  }

  async get(userId: string): Promise<PresenceSnapshot | null> {
    const entry = this.entries.get(userId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(userId);
      return null;
    }
    return entry.snapshot;
  }
}

export class PresenceService {
  constructor(
    private readonly store: PresenceStore,
    private readonly ttlSeconds = 120,
  ) {}

  async update(snapshot: PresenceSnapshot): Promise<PresenceSnapshot> {
    const sanitized = this.sanitize(snapshot);
    await this.store.upsert(sanitized, this.ttlSeconds);
    return sanitized;
  }

  async markOffline(userId: string): Promise<PresenceSnapshot> {
    const snapshot: PresenceSnapshot = {
      userId,
      status: "offline",
      activities: [],
      lastSeen: new Date().toISOString(),
    };
    await this.store.upsert(snapshot, this.ttlSeconds);
    return snapshot;
  }

  async get(userId: string): Promise<PresenceSnapshot | null> {
    return this.store.get(userId);
  }

  async remove(userId: string): Promise<void> {
    await this.store.remove(userId);
  }

  private sanitize(snapshot: PresenceSnapshot): PresenceSnapshot {
    return {
      userId: String(snapshot.userId ?? "").trim(),
      status: snapshot.status || "online",
      activities: Array.isArray(snapshot.activities) ? snapshot.activities : [],
      lastSeen: String(snapshot.lastSeen ?? new Date().toISOString()),
    };
  }
}
