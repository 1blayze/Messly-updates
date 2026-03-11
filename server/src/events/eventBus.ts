import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolveDomainEventPriority, type GatewayDomainEventType } from "./eventTypes";
import type { DomainEvent } from "./eventTypes";

export interface EventBus {
  publish(event: DomainEvent<GatewayDomainEventType>): Promise<void>;
  subscribe(handler: (event: DomainEvent<GatewayDomainEventType>) => Promise<void> | void): () => void;
  close: () => Promise<void>;
}

function normalizeEvent(event: DomainEvent<GatewayDomainEventType>): DomainEvent<GatewayDomainEventType> {
  return {
    event: event.event,
    scopeType: event.scopeType,
    scopeId: event.scopeId,
    routingKey: event.routingKey,
    payload: event.payload,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    eventId: String(event.eventId ?? randomUUID()).trim(),
    priority: event.priority ?? resolveDomainEventPriority(event.event),
  };
}

export class InMemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  async publish(event: DomainEvent<GatewayDomainEventType>): Promise<void> {
    this.emitter.emit("event", normalizeEvent(event));
  }

  subscribe(handler: (event: DomainEvent<GatewayDomainEventType>) => Promise<void> | void): () => void {
    const wrapped = (event: DomainEvent<GatewayDomainEventType>) => {
      void handler(event);
    };

    this.emitter.on("event", wrapped);
    return () => {
      this.emitter.off("event", wrapped);
    };
  }

  async close(): Promise<void> {
    return;
  }
}

export interface RedisPubSubLike {
  publish(channel: string, payload: string): Promise<number>;
  subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>>;
}

export class RedisEventBus implements EventBus {
  private redisUnsubscribe: Promise<() => Promise<void>> | null = null;

  constructor(
    private readonly channel: string,
    private readonly redis: RedisPubSubLike,
  ) {}

  async publish(event: DomainEvent<GatewayDomainEventType>): Promise<void> {
    await this.redis.publish(this.channel, JSON.stringify(normalizeEvent(event)));
  }

  subscribe(handler: (event: DomainEvent<GatewayDomainEventType>) => Promise<void> | void): () => void {
    const cleanup = this.redis.subscribe(this.channel, (payload) => {
      try {
        const parsed = JSON.parse(payload) as DomainEvent<GatewayDomainEventType>;
        void handler(parsed);
      } catch {
        // ignore malformed pubsub payloads
      }
    });
    this.redisUnsubscribe = cleanup;

    return () => {
      void cleanup.then((release) => {
        void release();
      });
    };
  }

  async close(): Promise<void> {
    if (!this.redisUnsubscribe) {
      return;
    }
    const release = await this.redisUnsubscribe;
    this.redisUnsubscribe = null;
    await release();
  }
}
