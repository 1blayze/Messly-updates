import type {
  DomainEvent,
  MessageDeletePayload,
  MessageDispatchPayload,
  FriendRequestDispatchPayload,
  GatewayDomainEventType,
  PresenceDispatchPayload,
  SpotifyDispatchPayload,
} from "../events/eventTypes";
import type { GatewaySubscription } from "../protocol/gateway";

function parseRoutingKey(routingKey: string): GatewaySubscription | null {
  const [type, id] = routingKey.split(":", 2);
  if (!type || !id) {
    return null;
  }
  if (
    type !== "conversation" &&
    type !== "user" &&
    type !== "friends" &&
    type !== "notifications"
  ) {
    return null;
  }
  return { type, id };
}

export interface RoutingDecision {
  subscriptions: GatewaySubscription[];
}

export function resolveDispatchTargets(event: DomainEvent<GatewayDomainEventType>): RoutingDecision {
  const routingKey = event.routingKey ? parseRoutingKey(event.routingKey) : null;

  if (event.event === "FRIEND_REQUEST_CREATE" || event.event === "FRIEND_REQUEST_ACCEPT") {
    const payload = event.payload as FriendRequestDispatchPayload | undefined;
    const request = payload?.request;
    const userIds = new Set<string>();
    if (request?.requesterId) {
      userIds.add(String(request.requesterId));
    }
    if (request?.addresseeId) {
      userIds.add(String(request.addresseeId));
    }

    return {
      subscriptions: [
        ...[...userIds].map((userId) => ({ type: "user" as const, id: userId })),
        ...[...userIds].map((userId) => ({ type: "notifications" as const, id: userId })),
      ].filter((subscription) => Boolean(subscription.id)),
    };
  }

  if (event.event === "PRESENCE_UPDATE" || event.event === "SPOTIFY_UPDATE") {
    const userId =
      event.event === "PRESENCE_UPDATE"
        ? String((event.payload as PresenceDispatchPayload | null)?.presence?.userId ?? "").trim()
        : String((event.payload as SpotifyDispatchPayload | null)?.userId ?? "").trim();
    if (!userId) {
      return { subscriptions: routingKey ? [routingKey] : [] };
    }
    return {
      subscriptions: [
        { type: "user", id: userId },
        { type: "notifications", id: userId },
        { type: "friends", id: userId },
      ],
    };
  }

  if (routingKey) {
    return { subscriptions: [routingKey] };
  }

  const messagePayload = event.payload as (MessageDispatchPayload | MessageDeletePayload | undefined) & { conversationId?: unknown };
  if (
    (event.event === "MESSAGE_CREATE" || event.event === "MESSAGE_UPDATE" || event.event === "MESSAGE_DELETE") &&
    typeof messagePayload.conversationId === "string"
  ) {
    return {
      subscriptions: [{ type: "conversation", id: String(messagePayload.conversationId) }],
    };
  }

  return { subscriptions: [] };
}
