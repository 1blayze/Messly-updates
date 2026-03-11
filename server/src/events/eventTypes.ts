import { randomUUID } from "node:crypto";

export type ScopeType = "dm" | "guild" | "channel" | "voice";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline" | "invisible";

export type CallSignalType = "CALL_OFFER" | "CALL_ANSWER" | "CALL_ICE" | "CALL_END";

export type GatewayDomainEventType =
  | "MESSAGE_CREATE"
  | "MESSAGE_UPDATE"
  | "MESSAGE_DELETE"
  | "MEDIA_DELETE"
  | "PRESENCE_UPDATE"
  | "TYPING_START"
  | "TYPING_STOP"
  | "FRIEND_REQUEST_CREATE"
  | "FRIEND_REQUEST_ACCEPT"
  | "USER_UPDATE"
  | "SPOTIFY_UPDATE"
  | CallSignalType
  | "CALL_SIGNAL";

export type GatewayEventPriority = "high" | "medium" | "low";

export interface DomainMessageEntity {
  id: string;
  conversationId: string;
  scopeType: ScopeType;
  scopeId: string;
  senderId: string;
  clientId: string | null;
  content: string;
  type: "text" | "system" | "media" | string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: string | null;
  payload: Record<string, unknown> | null;
  attachment: Record<string, unknown> | null;
  deliveryState: "pending" | "sent" | "failed";
  errorMessage: string | null;
}

export interface DomainPresenceActivity {
  type: string;
  [key: string]: unknown;
}

export interface DomainPresenceSnapshot {
  userId: string;
  status: PresenceStatus;
  activities: DomainPresenceActivity[];
  lastSeen: string;
}

export interface DomainProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  updatedAt: string;
}

export interface DomainConversationSummary {
  id: string;
  scopeType: ScopeType;
  scopeId: string;
}

export interface DomainFriendRequest {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: "pending" | "accepted" | "rejected" | string;
  createdAt: string;
}

export interface CallSignalPayload {
  type: CallSignalType;
  callId: string;
  scopeType: ScopeType;
  scopeId: string;
  fromUserId: string;
  targetUserId: string;
  signal: Record<string, unknown> | null;
  updatedAt: string;
}

export interface MessageDispatchPayload {
  message: DomainMessageEntity;
  conversation: DomainConversationSummary | null;
  profiles: DomainProfile[];
}

export interface MessageDeletePayload {
  conversationId: string;
  messageId: string;
  deletedAt: string;
}

export interface PresenceDispatchPayload {
  presence: DomainPresenceSnapshot;
}

export interface MediaDeleteDispatchPayload {
  fileKey: string;
  deletedAt: string;
  source: string;
}

export interface TypingDispatchPayload {
  conversationId: string;
  userId: string;
  expiresAt: string;
}

export interface FriendRequestDispatchPayload {
  request: DomainFriendRequest;
  profiles: DomainProfile[];
}

export interface UserUpdateDispatchPayload {
  user: Partial<DomainProfile> & {
    id: string;
  };
}

export interface SpotifyDispatchPayload {
  userId: string;
  status: PresenceStatus;
  activity: DomainPresenceActivity | null;
  updatedAt: string;
}

export interface DomainEventPayloadMap {
  MESSAGE_CREATE: MessageDispatchPayload;
  MESSAGE_UPDATE: MessageDispatchPayload;
  MESSAGE_DELETE: MessageDeletePayload;
  MEDIA_DELETE: MediaDeleteDispatchPayload;
  PRESENCE_UPDATE: PresenceDispatchPayload;
  TYPING_START: TypingDispatchPayload;
  TYPING_STOP: TypingDispatchPayload;
  FRIEND_REQUEST_CREATE: FriendRequestDispatchPayload;
  FRIEND_REQUEST_ACCEPT: FriendRequestDispatchPayload;
  USER_UPDATE: UserUpdateDispatchPayload;
  SPOTIFY_UPDATE: SpotifyDispatchPayload;
  CALL_OFFER: CallSignalPayload;
  CALL_ANSWER: CallSignalPayload;
  CALL_ICE: CallSignalPayload;
  CALL_END: CallSignalPayload;
  CALL_SIGNAL: CallSignalPayload;
}

export type DomainEventPayload<T extends GatewayDomainEventType> = T extends keyof DomainEventPayloadMap
  ? DomainEventPayloadMap[T]
  : unknown;

function asPriority(value: GatewayEventPriority): GatewayEventPriority {
  return value;
}

export function resolveDomainEventPriority(eventType: GatewayDomainEventType): GatewayEventPriority {
  if (eventType === "MESSAGE_CREATE" || eventType === "MESSAGE_DELETE" || eventType === "CALL_SIGNAL") {
    return asPriority("high");
  }

  if (eventType === "TYPING_START" || eventType === "TYPING_STOP") {
    return asPriority("low");
  }

  return asPriority("medium");
}

export interface DomainDispatchEnvelope<TPayload = unknown> {
  event: GatewayDomainEventType;
  scopeType?: ScopeType;
  scopeId?: string;
  routingKey: string;
  payload: TPayload;
  occurredAt: string;
  eventId: string;
  priority: GatewayEventPriority;
}

export interface DomainEvent<TEvent extends GatewayDomainEventType = GatewayDomainEventType, TPayload = unknown> {
  event: TEvent;
  scopeType?: ScopeType;
  scopeId?: string;
  routingKey: string;
  payload: TPayload;
  occurredAt: string;
  eventId: string;
  priority: GatewayEventPriority;
}

export interface EventIdentityOptions {
  eventId?: string;
  occurredAt?: string;
  priority?: GatewayEventPriority;
}

export interface EventIdentitySeed {
  eventId: string;
  occurredAt: string;
  priority: GatewayEventPriority;
}

export function normalizeEventIdentity(
  eventType: GatewayDomainEventType,
  options: EventIdentityOptions = {},
): EventIdentitySeed {
  return {
    eventId: String(options.eventId ?? randomUUID()).trim(),
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    priority: options.priority ?? resolveDomainEventPriority(eventType),
  };
}
