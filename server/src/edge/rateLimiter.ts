interface InMemoryRateBucket {
  windowStart: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  total: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

interface RedisWindowStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, InMemoryRateBucket>();

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucketStart = now - (now % windowMs);
    const current = this.buckets.get(key);

    if (!current || current.windowStart !== bucketStart) {
      this.buckets.set(key, {
        windowStart: bucketStart,
        count: 1,
      });
      return {
        allowed: true,
        retryAfterMs: windowMs,
        remaining: limit - 1,
        total: 1,
      };
    }

    current.count += 1;
    if (current.count > limit) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, windowMs - (now - current.windowStart)),
        remaining: 0,
        total: current.count,
      };
    }

    return {
      allowed: true,
      retryAfterMs: Math.max(1, windowMs - (now - current.windowStart)),
      remaining: limit - current.count,
      total: current.count,
    };
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisWindowStore,
    private readonly keyPrefix = "messly:rate-limit",
  ) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const bucket = `${this.keyPrefix}:${key}`;
    const count = await this.redis.incr(bucket);
    if (count === 1) {
      await this.redis.pexpire(bucket, windowMs);
    }

    const ttl = await this.redis.pttl(bucket);
    const retryAfterMs = ttl > 0 ? ttl : Math.floor(windowMs * 1.1);
    return {
      allowed: count <= limit,
      retryAfterMs,
      remaining: Math.max(0, limit - count),
      total: count,
    };
  }
}
