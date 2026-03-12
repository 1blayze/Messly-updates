import IORedis, { type Redis } from "ioredis";
import type { GatewayEnv } from "../config/env";
import type { Logger } from "../logging/logger";
import type { GatewayMetrics } from "../metrics/gatewayMetrics";

type RedisRole = "command" | "publisher" | "subscriber";

function waitForReady(client: Redis): Promise<void> {
  if (client.status === "ready") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      client.off("ready", handleReady);
      client.off("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    client.once("ready", handleReady);
    client.once("error", handleError);
  });
}

function createRedis(role: RedisRole, env: GatewayEnv, logger: Logger, metrics: GatewayMetrics): Redis {
  const client = new IORedis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableAutoPipelining: role !== "subscriber",
    retryStrategy: (attempt) => Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000),
  });

  client.on("error", (error) => {
    metrics.trackRedisError();
    logger.error("redis_client_error", {
      redisRole: role,
      error: error.message,
    });
  });

  client.on("reconnecting", () => {
    logger.warn("redis_client_reconnecting", {
      redisRole: role,
    });
  });

  client.on("ready", () => {
    logger.info("redis_client_ready", {
      redisRole: role,
    });
  });

  client.on("end", () => {
    logger.warn("redis_client_ended", {
      redisRole: role,
    });
  });

  return client;
}

export class RedisManager {
  readonly command: Redis;
  readonly publisher: Redis;
  readonly subscriber: Redis;

  constructor(
    private readonly env: GatewayEnv,
    private readonly logger: Logger,
    private readonly metrics: GatewayMetrics,
  ) {
    this.command = createRedis("command", env, logger, metrics);
    this.publisher = createRedis("publisher", env, logger, metrics);
    this.subscriber = createRedis("subscriber", env, logger, metrics);
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.command.connect(),
      this.publisher.connect(),
      this.subscriber.connect(),
    ]);
    await Promise.all([
      waitForReady(this.command),
      waitForReady(this.publisher),
      waitForReady(this.subscriber),
    ]);
    await this.command.ping();
  }

  isReady(): boolean {
    return this.command.status === "ready" && this.publisher.status === "ready" && this.subscriber.status === "ready";
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.subscriber.quit(),
      this.publisher.quit(),
      this.command.quit(),
    ]);
  }
}
