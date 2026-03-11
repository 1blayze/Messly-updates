/// <reference path="./edge-runtime.d.ts" />
import { HttpError } from "./http.ts";

interface UpstashResultItem {
  result: number | string | null;
  error?: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs: number;
  backend: "upstash" | "memory";
}

interface MemoryBucket {
  count: number;
  expiresAt: number;
}

const memoryBuckets = new Map<string, MemoryBucket>();
let memoryFallbackWarningLogged = false;

function getNowMs(): number {
  return Date.now();
}

function cleanupExpiredMemoryBuckets(now: number): void {
  if (memoryBuckets.size < 1500) {
    return;
  }

  for (const [key, bucket] of memoryBuckets.entries()) {
    if (bucket.expiresAt <= now) {
      memoryBuckets.delete(key);
    }
  }
}

function buildWindowKey(prefix: string, key: string, windowMs: number, now: number): {
  scopedKey: string;
  retryAfterMs: number;
} {
  const windowId = Math.floor(now / windowMs);
  const windowEnd = (windowId + 1) * windowMs;
  return {
    scopedKey: `${prefix}:${key}:${windowId}`,
    retryAfterMs: Math.max(1, windowEnd - now),
  };
}

async function consumeUpstash(
  scopedKey: string,
  windowMs: number,
): Promise<{ count: number } | null> {
  const url = (Deno.env.get("UPSTASH_REDIS_REST_URL") ?? "").trim().replace(/\/+$/, "");
  const token = (Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? "").trim();

  if (!url || !token) {
    return null;
  }

  const response = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify([
      ["INCR", scopedKey],
      ["EXPIRE", scopedKey, Math.max(1, Math.ceil(windowMs / 1000)) + 1],
    ]),
  });

  if (!response.ok) {
    throw new HttpError(502, "RATE_LIMIT_BACKEND_ERROR", "Falha no backend de rate limit.");
  }

  const payload = (await response.json()) as UpstashResultItem[];
  const counter = payload?.[0];
  if (!counter || counter.error) {
    throw new HttpError(502, "RATE_LIMIT_BACKEND_ERROR", "Resposta inválida do backend de rate limit.");
  }

  const count = Number(counter.result);
  if (!Number.isFinite(count) || count < 0) {
    throw new HttpError(502, "RATE_LIMIT_BACKEND_ERROR", "Contador de rate limit inválido.");
  }

  return { count };
}

function consumeMemory(scopedKey: string, windowMs: number): { count: number } {
  const now = getNowMs();
  cleanupExpiredMemoryBuckets(now);

  const bucket = memoryBuckets.get(scopedKey);
  if (!bucket || bucket.expiresAt <= now) {
    memoryBuckets.set(scopedKey, {
      count: 1,
      expiresAt: now + windowMs,
    });
    return { count: 1 };
  }

  bucket.count += 1;
  memoryBuckets.set(scopedKey, bucket);
  return { count: bucket.count };
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  prefix = "ratelimit",
): Promise<RateLimitDecision> {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new HttpError(500, "SERVER_CONFIG_ERROR", "Parâmetros de rate limit inválidos.");
  }

  const now = getNowMs();
  const { scopedKey, retryAfterMs } = buildWindowKey(prefix, key, windowMs, now);

  const upstashValue = await consumeUpstash(scopedKey, windowMs);
  if (upstashValue) {
    const remaining = Math.max(0, limit - upstashValue.count);
    return {
      allowed: upstashValue.count <= limit,
      remaining,
      limit,
      retryAfterMs,
      backend: "upstash",
    };
  }

  if (!memoryFallbackWarningLogged) {
    memoryFallbackWarningLogged = true;
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: "Upstash indisponível, usando rate limit em memória por instância.",
      }),
    );
  }

  const memoryValue = consumeMemory(scopedKey, windowMs);
  const remaining = Math.max(0, limit - memoryValue.count);
  return {
    allowed: memoryValue.count <= limit,
    remaining,
    limit,
    retryAfterMs,
    backend: "memory",
  };
}

export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  prefix = "ratelimit",
  details?: Record<string, unknown>,
): Promise<RateLimitDecision> {
  const decision = await consumeRateLimit(key, limit, windowMs, prefix);
  if (decision.allowed) {
    return decision;
  }

  throw new HttpError(429, "RATE_LIMITED", "Muitas requisicoes em pouco tempo.", {
    retryAfterMs: decision.retryAfterMs,
    limit: decision.limit,
    windowMs,
    backend: decision.backend,
    ...(details ?? {}),
  });
}
