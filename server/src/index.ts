import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { AuthRouter } from "./auth/router";
import { GatewayServer } from "./edge/gatewayServer";
import { InMemoryRateLimiter, RedisRateLimiter } from "./edge/rateLimiter";
import { InMemoryEventBus, RedisEventBus, type EventBus } from "./events/eventBus";
import { FanoutService } from "./fanout/fanoutService";
import { readGatewayEnv } from "./infra/env";
import { createLogger } from "./infra/logger";
import { GatewayMetrics } from "./infra/metrics";
import { MediaRouter } from "./media/router";
import { RedisPresenceStore } from "./infra/redis/redisPresenceStore";
import { RedisPubSubAdapter } from "./infra/redis/redisPubSubAdapter";
import { createRedisClients } from "./infra/redisClient";
import { InMemoryPresenceStore, PresenceService } from "./presence/presenceService";
import { RealtimeCore } from "./realtime/realtimeCore";
import { GatewayShardManager } from "./realtime/shardManager";
import { AuthSessionManager } from "./sessions/sessionManager";

async function buildEventBus(
  redisUrl: string,
  logger: ReturnType<typeof createLogger>,
  channel: string,
  closeHooks: Array<() => Promise<void>>,
): Promise<EventBus> {
  if (!redisUrl) {
    logger.info("Redis absent. Using in-memory event bus.");
    return new InMemoryEventBus();
  }

  const redis = await createRedisClients(redisUrl);
  closeHooks.push(redis.close);
  const adapter = new RedisPubSubAdapter(redis.command, redis.pubsub);
  return new RedisEventBus(channel, adapter);
}

async function buildPresenceStore(
  redisUrl: string,
  logger: ReturnType<typeof createLogger>,
  closeHooks: Array<() => Promise<void>>,
) {
  if (!redisUrl) {
    logger.info("Redis absent. Using in-memory presence.");
    return new InMemoryPresenceStore();
  }

  const redis = await createRedisClients(redisUrl);
  closeHooks.push(redis.close);
  return new RedisPresenceStore(redis.command);
}

async function buildRateLimiter(redisUrl: string, closeHooks: Array<() => Promise<void>>) {
  if (!redisUrl) {
    return new InMemoryRateLimiter();
  }

  const redis = await createRedisClients(redisUrl);
  closeHooks.push(redis.close);
  return new RedisRateLimiter(redis.command, "messly:rate");
}

async function bootstrap(): Promise<void> {
  const env = readGatewayEnv();
  const logger = createLogger("gateway");
  const runtimeMetrics = new GatewayMetrics(process.env.HOSTNAME ?? "messly-gateway");
  const redisCloseHooks: Array<() => Promise<void>> = [];

  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY are required.");
  }
  if (!env.supabaseAnonKey) {
    throw new Error("SUPABASE_ANON_KEY, VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY is required.");
  }
  if (!env.turnstileSecretKey) {
    const turnstileSiteKey = String(process.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();
    const isProductionRuntime = String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
    if (isProductionRuntime || turnstileSiteKey) {
      logger.warn("TURNSTILE_SECRET_KEY is empty. Signup endpoint will fail-closed until configured.");
    } else {
      logger.info("Turnstile is not configured for local dev. Signup endpoint remains fail-closed until configured.");
    }
  }

  const adminSupabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const createPublicSupabase = () =>
    createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

  const [eventBus, presenceStore, rateLimiter] = await Promise.all([
    buildEventBus(env.redisUrl, logger, env.eventBusChannel, redisCloseHooks),
    buildPresenceStore(env.redisUrl, logger, redisCloseHooks),
    buildRateLimiter(env.redisUrl, redisCloseHooks),
  ]);

  const presenceService = new PresenceService(presenceStore, env.presenceTtlSeconds);
  const shardManager = new GatewayShardManager({
    shardCount: Math.max(1, env.shardCount),
    localShardId: env.localShardIndex,
    hostAllShards: env.localShardIndex === null,
  });
  const authSessionManager = new AuthSessionManager(adminSupabase, logger);
  const authRouter = new AuthRouter({
    adminSupabase,
    createPublicSupabase,
    sessionManager: authSessionManager,
    rateLimiter,
    env,
    logger,
  });
  const mediaRouter = new MediaRouter({
    adminSupabase,
    sessionManager: authSessionManager,
    rateLimiter,
    env,
    logger,
  });
  const fanout = new FanoutService(shardManager, {
    trackDispatchedEvent: () => {
      runtimeMetrics.trackDispatchedEvent();
    },
  });

  const realtime = new RealtimeCore(eventBus, fanout, presenceService, adminSupabase, env.typingTtlMs);
  realtime.start();

  const gateway = new GatewayServer({
    supabase: adminSupabase,
    realtime,
    shardManager,
    shardCount: Math.max(1, env.shardCount),
    localShardId: env.localShardIndex,
    port: env.port,
    heartbeatIntervalMs: 15_000,
    metricsPath: env.gatewayMetricsPath,
    rateLimiter,
    metrics: runtimeMetrics,
    logger,
    authSessions: authSessionManager,
    authRouter,
    mediaRouter,
  });
  gateway.start();

  const cleanup = async () => {
    gateway.stop();
    realtime.stop();
    await eventBus.close();
    await Promise.all(redisCloseHooks.map((close) => close()));
  };

  process.on("SIGINT", () => {
    void cleanup();
  });
  process.on("SIGTERM", () => {
    void cleanup();
  });

  logger.info("Messly gateway ready", {
    port: env.port,
    shardCount: Math.max(1, env.shardCount),
    localShardId: env.localShardIndex,
    redisEnabled: Boolean(env.redisUrl),
  });
}

void bootstrap().catch((error) => {
  console.error("Failed to start gateway", error);
  process.exit(1);
});
