import type { RedisPubSubLike } from "../../events/eventBus";

export interface RedisSubscriberClient {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, payload: string) => void): void;
  off(event: "message", listener: (channel: string, payload: string) => void): void;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface RedisPublisherClient {
  publish(channel: string, payload: string): Promise<number>;
}

export class RedisPubSubAdapter implements RedisPubSubLike {
  constructor(
    private readonly publisher: RedisPublisherClient,
    private readonly subscriber: RedisSubscriberClient,
  ) {}

  async publish(channel: string, payload: string): Promise<number> {
    return this.publisher.publish(channel, payload);
  }

  async subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>> {
    await this.subscriber.subscribe(channel);
    const handler = (incomingChannel: string, payload: string) => {
      if (incomingChannel !== channel) {
        return;
      }
      listener(payload);
    };

    this.subscriber.on("message", handler);

    return async () => {
      await this.subscriber.unsubscribe(channel);
      this.subscriber.off("message", handler);
    };
  }
}
