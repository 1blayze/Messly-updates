import { gatewayRedisKeys } from "./keys";
import type { RedisManager } from "./client";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  total: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

interface InMemoryRateBucket {
  windowStart: number;
  count: number;
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

export class NoopRateLimiter implements RateLimiter {
  async consume(_key: string, limit: number): Promise<RateLimitResult> {
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: limit,
      total: 0,
    };
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisManager) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const redisKey = gatewayRedisKeys.rateLimit(key);
    const count = await this.redis.command.incr(redisKey);
    if (count === 1) {
      await this.redis.command.pexpire(redisKey, windowMs);
    }
    const ttlMs = await this.redis.command.pttl(redisKey);
    return {
      allowed: count <= limit,
      retryAfterMs: ttlMs > 0 ? ttlMs : windowMs,
      remaining: Math.max(0, limit - count),
      total: count,
    };
  }
}
