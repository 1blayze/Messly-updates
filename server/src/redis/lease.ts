import { randomUUID } from "node:crypto";
import type { RedisManager } from "./client";
import type { Logger } from "../logging/logger";

const REFRESH_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("psetex", KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export class RedisLease {
  private readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private holding = false;

  constructor(
    private readonly redis: RedisManager,
    private readonly leaseKey: string,
    private readonly ttlMs: number,
    private readonly renewIntervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(onAcquired: () => Promise<void> | void, onLost: () => Promise<void> | void): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const tick = async () => {
      if (!this.running) {
        return;
      }

      try {
        let acquired = false;
        if (!this.holding) {
          const result = await this.redis.command.set(this.leaseKey, this.token, "PX", this.ttlMs, "NX");
          acquired = result === "OK";
        } else {
          const result = await this.redis.command.eval(REFRESH_SCRIPT, 1, this.leaseKey, this.token, String(this.ttlMs));
          acquired = Number(result) === 1;
        }

        if (acquired && !this.holding) {
          this.holding = true;
          this.logger.info("redis_lease_acquired", {
            leaseKey: this.leaseKey,
          });
          await onAcquired();
        } else if (!acquired && this.holding) {
          this.holding = false;
          this.logger.warn("redis_lease_lost", {
            leaseKey: this.leaseKey,
          });
          await onLost();
        }
      } catch (error) {
        if (this.holding) {
          this.holding = false;
          await onLost();
        }
        this.logger.error("redis_lease_tick_failed", {
          leaseKey: this.leaseKey,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.running) {
          this.timer = setTimeout(() => {
            void tick();
          }, this.renewIntervalMs);
        }
      }
    };

    void tick();
  }

  async stop(onLost?: () => Promise<void> | void): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.holding) {
      return;
    }

    this.holding = false;
    await this.redis.command.eval(RELEASE_SCRIPT, 1, this.leaseKey, this.token);
    await onLost?.();
  }
}
