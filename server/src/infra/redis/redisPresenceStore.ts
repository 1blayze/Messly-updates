import type { PresenceSnapshot, PresenceStore } from "../../presence/presenceService";

export interface RedisHashClient {
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

function redisPresenceKey(userId: string): string {
  return `messly:presence:${userId}`;
}

export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: RedisHashClient) {}

  async upsert(snapshot: PresenceSnapshot, ttlSeconds: number): Promise<void> {
    await this.redis.hset(redisPresenceKey(snapshot.userId), {
      userId: snapshot.userId,
      status: snapshot.status,
      activities: JSON.stringify(snapshot.activities ?? []),
      lastSeen: snapshot.lastSeen,
    });
    await this.redis.expire(redisPresenceKey(snapshot.userId), ttlSeconds);
  }

  async remove(userId: string): Promise<void> {
    await this.redis.del(redisPresenceKey(userId));
  }

  async get(userId: string): Promise<PresenceSnapshot | null> {
    const values = await this.redis.hgetall(redisPresenceKey(userId));
    if (!values.userId) {
      return null;
    }

    return {
      userId: values.userId,
      status: (values.status as PresenceSnapshot["status"]) ?? "offline",
      activities: JSON.parse(values.activities ?? "[]"),
      lastSeen: values.lastSeen ?? new Date().toISOString(),
    };
  }
}
