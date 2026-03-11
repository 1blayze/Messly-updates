import IORedis from "ioredis";

export interface RedisCommandClient {
  incr(key: string): Promise<number>;
  publish(channel: string, payload: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  hset(key: string, values: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface RedisPubSubClient {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, payload: string) => void): void;
  off(event: "message", listener: (channel: string, payload: string) => void): void;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface RedisRuntimeClients {
  command: RedisCommandClient & { quit: () => Promise<unknown> };
  pubsub: RedisCommandClient & RedisPubSubClient & { quit: () => Promise<unknown> };
  close: () => Promise<void>;
}

export async function createRedisClients(url: string): Promise<RedisRuntimeClients> {
  const command = new IORedis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      return Math.min(1000 * (2 ** Math.min(times, 6)), 10_000);
    },
  });
  const pubsub = new IORedis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      return Math.min(1000 * (2 ** Math.min(times, 6)), 10_000);
    },
  });

  return {
    command,
    pubsub,
    close: async () => {
      await Promise.all([command.quit(), pubsub.quit()]);
    },
  };
}
