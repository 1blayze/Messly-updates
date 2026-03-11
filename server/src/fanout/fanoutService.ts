import { resolveDispatchTargets } from "../realtime/dispatchRouter";
import { GatewayShardManager } from "../realtime/shardManager";
import type { GatewayDomainEventType, DomainEvent } from "../events/eventTypes";
import { resolveDomainEventPriority } from "../events/eventTypes";

export class FanoutService {
  constructor(
    private readonly shards: GatewayShardManager,
    private readonly metrics?: {
      trackDispatchedEvent?: () => void;
    },
  ) {}

  fanout(event: DomainEvent<GatewayDomainEventType>): void {
    const routing = resolveDispatchTargets(event);
    if (!routing.subscriptions.length) {
      return;
    }

    const envelope = {
      event: event.event,
      scopeType: event.scopeType,
      scopeId: event.scopeId ?? "",
      routingKey: event.routingKey,
      payload: event.payload,
      occurredAt: event.occurredAt,
      eventId: event.eventId,
      priority: resolveDomainEventPriority(event.event),
    };

    routing.subscriptions.forEach((subscription) => {
      this.shards.fanoutAllShards(subscription, envelope);
      this.metrics?.trackDispatchedEvent?.();
    });
  }
}
