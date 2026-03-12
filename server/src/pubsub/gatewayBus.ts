import type { RedisManager } from "../redis/client";
import type { Logger } from "../logging/logger";
import type { GatewayMetrics } from "../metrics/gatewayMetrics";
import type { GatewayBusMessage } from "./messages";

interface GatewayBusOptions {
  dispatchChannel: string;
  controlChannel: string;
}

type GatewayBusHandler = (message: GatewayBusMessage) => Promise<void> | void;

export class GatewayBus {
  private readonly handlers = new Set<GatewayBusHandler>();
  private readonly channels: string[];
  private started = false;
  private queueDepth = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly redis: RedisManager,
    private readonly options: GatewayBusOptions,
    private readonly logger: Logger,
    private readonly metrics: GatewayMetrics,
  ) {
    this.channels = [options.dispatchChannel, options.controlChannel];
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.redis.subscriber.on("message", (channel, payload) => {
      if (!this.channels.includes(channel)) {
        return;
      }
      this.enqueue(payload);
    });

    await this.redis.subscriber.subscribe(...this.channels);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await this.redis.subscriber.unsubscribe(...this.channels);
    this.handlers.clear();
  }

  subscribe(handler: GatewayBusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(message: GatewayBusMessage): Promise<void> {
    const channel = message.kind === "dispatch" ? this.options.dispatchChannel : this.options.controlChannel;
    const published = await this.redis.publisher.publish(channel, JSON.stringify(message));
    if (published === 0 && message.kind === "dispatch") {
      this.metrics.trackPublishFailure();
    }
  }

  private enqueue(payload: string): void {
    this.queueDepth += 1;
    this.metrics.setInternalQueueDepth(this.queueDepth);
    this.queue = this.queue
      .then(async () => {
        try {
          const message = JSON.parse(payload) as GatewayBusMessage;
          await Promise.all([...this.handlers].map((handler) => handler(message)));
        } catch (error) {
          this.logger.warn("gateway_bus_message_invalid", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        this.metrics.setInternalQueueDepth(this.queueDepth);
      });
  }
}
