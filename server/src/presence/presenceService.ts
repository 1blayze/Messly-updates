import type { RedisManager } from "../redis/client";
import { gatewayRedisKeys } from "../redis/keys";
import type { GatewayPresenceActivity, GatewayPresenceSnapshot } from "../protocol/dispatch";
import type { GatewayPresenceStatus } from "../protocol/opcodes";

export interface PresenceSnapshot {
  userId: string;
  status: GatewayPresenceStatus;
  activities: GatewayPresenceActivity[];
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
    await this.store.upsert(snapshot, this.ttlSeconds);
    return snapshot;
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
}

interface PresenceSessionRecord {
  userId: string;
  sessionId: string;
  deviceId: string | null;
  status: GatewayPresenceStatus;
  activities: GatewayPresenceActivity[];
  metadata: Record<string, unknown> | null;
  lastSeen: string;
  updatedAt: string;
}

interface ConnectPresenceInput {
  userId: string;
  sessionId: string;
  deviceId: string | null;
  status: GatewayPresenceStatus;
  activities: GatewayPresenceActivity[];
  metadata?: Record<string, unknown> | null;
}

const STATUS_PRIORITY: GatewayPresenceStatus[] = ["dnd", "online", "idle", "invisible", "offline"];

function safeParseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toPresenceSession(values: Record<string, string>): PresenceSessionRecord | null {
  if (!values.userId || !values.sessionId) {
    return null;
  }
  return {
    userId: values.userId,
    sessionId: values.sessionId,
    deviceId: values.deviceId || null,
    status: (values.status as GatewayPresenceStatus) ?? "offline",
    activities: safeParseJson(values.activities, []),
    metadata: safeParseJson(values.metadata, null),
    lastSeen: values.lastSeen ?? new Date().toISOString(),
    updatedAt: values.updatedAt ?? new Date().toISOString(),
  };
}

export interface AggregatedPresence extends GatewayPresenceSnapshot {
  devices: PresenceSessionRecord[];
}

export class RedisPresenceService {
  constructor(
    private readonly redis: RedisManager,
    private readonly ttlSeconds: number,
  ) {}

  async connectSession(input: ConnectPresenceInput): Promise<AggregatedPresence> {
    const now = new Date().toISOString();
    await this.redis.command.hset(gatewayRedisKeys.presenceSession(input.sessionId), {
      userId: input.userId,
      sessionId: input.sessionId,
      deviceId: input.deviceId ?? "",
      status: input.status,
      activities: JSON.stringify(input.activities),
      metadata: JSON.stringify(input.metadata ?? null),
      lastSeen: now,
      updatedAt: now,
    });
    await this.redis.command.expire(gatewayRedisKeys.presenceSession(input.sessionId), this.ttlSeconds);
    await this.redis.command.sadd(gatewayRedisKeys.presenceUserSessions(input.userId), input.sessionId);
    await this.redis.command.expire(gatewayRedisKeys.presenceUserSessions(input.userId), this.ttlSeconds);
    return this.getAggregatedPresence(input.userId);
  }

  async disconnectSession(userId: string, sessionId: string): Promise<AggregatedPresence> {
    await this.redis.command.srem(gatewayRedisKeys.presenceUserSessions(userId), sessionId);
    await this.redis.command.del(gatewayRedisKeys.presenceSession(sessionId));
    return this.getAggregatedPresence(userId);
  }

  async updatePresence(sessionId: string, patch: {
    status?: GatewayPresenceStatus;
    activities?: GatewayPresenceActivity[];
    metadata?: Record<string, unknown> | null;
  }): Promise<AggregatedPresence | null> {
    const existing = await this.redis.command.hgetall(gatewayRedisKeys.presenceSession(sessionId));
    const session = toPresenceSession(existing);
    if (!session) {
      return null;
    }

    const now = new Date().toISOString();
    await this.redis.command.hset(gatewayRedisKeys.presenceSession(sessionId), {
      status: patch.status ?? session.status,
      activities: JSON.stringify(patch.activities ?? session.activities),
      metadata: JSON.stringify(patch.metadata ?? session.metadata ?? null),
      lastSeen: now,
      updatedAt: now,
    });
    await this.redis.command.expire(gatewayRedisKeys.presenceSession(sessionId), this.ttlSeconds);
    await this.redis.command.expire(gatewayRedisKeys.presenceUserSessions(session.userId), this.ttlSeconds);
    return this.getAggregatedPresence(session.userId);
  }

  async touchSession(sessionId: string): Promise<void> {
    const existing = await this.redis.command.hgetall(gatewayRedisKeys.presenceSession(sessionId));
    const session = toPresenceSession(existing);
    if (!session) {
      return;
    }
    const now = new Date().toISOString();
    await this.redis.command.hset(gatewayRedisKeys.presenceSession(sessionId), {
      lastSeen: now,
      updatedAt: now,
    });
    await this.redis.command.expire(gatewayRedisKeys.presenceSession(sessionId), this.ttlSeconds);
    await this.redis.command.expire(gatewayRedisKeys.presenceUserSessions(session.userId), this.ttlSeconds);
  }

  async getAggregatedPresence(userId: string): Promise<AggregatedPresence> {
    const sessionIds = await this.redis.command.smembers(gatewayRedisKeys.presenceUserSessions(userId));
    const records = (
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          const values = await this.redis.command.hgetall(gatewayRedisKeys.presenceSession(sessionId));
          const session = toPresenceSession(values);
          if (!session) {
            await this.redis.command.srem(gatewayRedisKeys.presenceUserSessions(userId), sessionId);
          }
          return session;
        }),
      )
    ).filter((record): record is PresenceSessionRecord => Boolean(record));

    if (records.length === 0) {
      return {
        userId,
        status: "offline",
        activities: [],
        lastSeen: new Date().toISOString(),
        metadata: null,
        devices: [],
      };
    }

    const status = [...STATUS_PRIORITY].find((candidate) => {
      return records.some((record) => record.status === candidate);
    }) ?? "offline";
    const lastSeen = records
      .map((record) => record.lastSeen)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();

    return {
      userId,
      status,
      activities: records[0]?.activities ?? [],
      metadata: records[0]?.metadata ?? null,
      lastSeen,
      devices: records,
    };
  }
}
