import { randomUUID } from "node:crypto";
import type {
  GatewayCallDispatchPayload,
  GatewayDispatchPayloadMap,
  GatewayPresenceSnapshot,
  GatewaySubscription,
} from "../protocol/dispatch";
import type { GatewayDispatchEvent, GatewayPresenceStatus } from "../protocol/opcodes";
import type { GatewayBus } from "./gatewayBus";
import type { AudienceResolver } from "./audienceResolver";

function uniqueTargets(targets: GatewaySubscription[]): GatewaySubscription[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export class DispatchPublisher {
  constructor(
    private readonly bus: GatewayBus,
    private readonly audienceResolver: AudienceResolver,
  ) {}

  async publishDispatch<TEvent extends GatewayDispatchEvent>(input: {
    event: TEvent;
    payload: GatewayDispatchPayloadMap[TEvent];
    targets: GatewaySubscription[];
    occurredAt?: string;
    eventId?: string;
  }): Promise<void> {
    await this.bus.publish({
      kind: "dispatch",
      eventId: input.eventId ?? randomUUID(),
      event: input.event,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      targets: uniqueTargets(input.targets),
      payload: input.payload,
    });
  }

  async publishPresence(snapshot: GatewayPresenceSnapshot): Promise<void> {
    const watcherTargets = await this.audienceResolver.getPresenceWatcherTargets(snapshot.userId);
    await this.publishDispatch({
      event: "PRESENCE_UPDATE",
      payload: {
        presence: snapshot,
      },
      targets: [
        { type: "user", id: snapshot.userId },
        { type: "notifications", id: snapshot.userId },
        ...watcherTargets,
      ],
    });
  }

  async publishSpotify(userId: string, status: GatewayPresenceStatus, activity: Record<string, unknown> | null): Promise<void> {
    const watcherTargets = await this.audienceResolver.getPresenceWatcherTargets(userId);
    await this.publishDispatch({
      event: "SPOTIFY_UPDATE",
      payload: {
        userId,
        status,
        activity,
        updatedAt: new Date().toISOString(),
      },
      targets: [
        { type: "user", id: userId },
        { type: "notifications", id: userId },
        ...watcherTargets,
      ],
    });
  }

  async publishTyping(event: "TYPING_START" | "TYPING_STOP", conversationId: string, userId: string, expiresAt: string): Promise<void> {
    await this.publishDispatch({
      event,
      payload: {
        conversationId,
        userId,
        expiresAt,
      },
      targets: [{ type: "conversation", id: conversationId }],
    });
  }

  async publishCall(payload: GatewayCallDispatchPayload): Promise<void> {
    await this.publishDispatch({
      event: payload.type,
      payload,
      targets: [
        { type: "user", id: payload.targetUserId },
        { type: "notifications", id: payload.targetUserId },
        { type: "user", id: payload.fromUserId },
      ],
      occurredAt: payload.updatedAt,
    });
  }
}
