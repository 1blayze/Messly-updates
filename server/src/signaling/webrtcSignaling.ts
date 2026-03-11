import type { EventBus } from "../events/eventBus";
import { normalizeEventIdentity, type CallSignalPayload } from "../events/eventTypes";

export class WebRtcSignalingService {
  constructor(private readonly eventBus: EventBus) {}

  async dispatch(payload: CallSignalPayload): Promise<void> {
    const identity = normalizeEventIdentity(payload.type);
    await this.eventBus.publish({
      ...identity,
      event: payload.type,
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      routingKey: `user:${payload.targetUserId}`,
      payload,
      occurredAt: payload.updatedAt ?? identity.occurredAt,
    });
  }
}
