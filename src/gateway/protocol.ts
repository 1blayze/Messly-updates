import type {
  ConversationEntity,
  FriendRequestEntity,
  MessageEntity,
  SpotifyActivityEntity,
  UserPresenceEntity,
  UserProfileEntity,
} from "../stores/entities";

export type GatewayOpcode =
  | "HELLO"
  | "IDENTIFY"
  | "RESUME"
  | "HEARTBEAT"
  | "HEARTBEAT_ACK"
  | "PING"
  | "PONG"
  | "SUBSCRIBE"
  | "UNSUBSCRIBE"
  | "PUBLISH"
  | "DISPATCH"
  | "RECONNECT"
  | "INVALID_SESSION"
  | "ERROR";

export type GatewayDispatchEventType =
  | "READY"
  | "RESUMED"
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
  | "CALL_OFFER"
  | "CALL_ANSWER"
  | "CALL_ICE"
  | "CALL_END";

export type GatewayPublishEventType =
  | "PRESENCE_UPDATE"
  | "TYPING_START"
  | "TYPING_STOP"
  | "SPOTIFY_UPDATE"
  | "CALL_OFFER"
  | "CALL_ANSWER"
  | "CALL_ICE"
  | "CALL_END";

export type GatewaySubscriptionTopicType = "conversation" | "user" | "friends" | "notifications" | "voice" | "room";

export interface GatewaySubscription {
  type: GatewaySubscriptionTopicType;
  id: string;
}

export interface GatewayFrame<TPayload = unknown> {
  op: GatewayOpcode;
  s: number | null;
  t: GatewayDispatchEventType | GatewayPublishEventType | null;
  d: TPayload;
}

export interface GatewayHelloPayload {
  heartbeatIntervalMs: number;
  clientTimeoutMs: number;
  connectionId: string;
  instanceId: string;
  serverTime: string;
  publicUrl: string;
  resume: {
    ttlSeconds: number;
    bufferSize: number;
  };
  shard: {
    id: number;
    count: number;
  };
}

export interface GatewayIdentifyPayload {
  token: string;
  client: {
    name: string;
    version: string;
    platform: string;
    clientType: "desktop" | "web" | "mobile" | "unknown";
    deviceId?: string;
  };
  subscriptions: GatewaySubscription[];
}

export interface GatewayResumePayload {
  token: string;
  sessionId: string;
  resumeToken: string;
  seq: number;
  subscriptions?: GatewaySubscription[];
}

export interface GatewayHeartbeatPayload {
  lastSequence?: number | null;
  nonce?: string;
  sentAt?: string;
}

export interface GatewayReadyPayload {
  sessionId: string;
  resumeToken: string;
  userId: string;
  shardId: number;
  shardCount: number;
  subscriptions: GatewaySubscription[];
}

export interface GatewayInvalidSessionPayload {
  reason: string;
  canResume: boolean;
}

export interface GatewayReconnectPayload {
  reason: string;
  retryAfterMs: number;
}

export interface GatewayErrorPayload {
  code: string;
  message: string;
  retryAfterMs?: number;
  details?: unknown;
}

export interface GatewayMessageDispatchPayload {
  message: MessageEntity;
  conversation?: Partial<ConversationEntity> | null;
  profiles?: UserProfileEntity[];
}

export interface GatewayMessageDeleteDispatchPayload {
  conversationId: string;
  messageId: string;
  deletedAt: string;
}

export interface GatewayPresenceDispatchPayload {
  presence: UserPresenceEntity;
}

export interface GatewayMediaDeleteDispatchPayload {
  fileKey: string;
  deletedAt: string;
  source: "message" | "profile" | "attachment" | "cleanup" | string;
}

export interface GatewayTypingDispatchPayload {
  conversationId: string;
  userId: string;
  expiresAt: string;
}

export interface GatewayFriendRequestDispatchPayload {
  request: FriendRequestEntity;
  profiles?: UserProfileEntity[];
}

export interface GatewayUserUpdateDispatchPayload {
  user: Partial<UserProfileEntity> & {
    id: string;
  };
}

export interface GatewaySpotifyDispatchPayload {
  userId: string;
  status: UserPresenceEntity["status"];
  activity: SpotifyActivityEntity | null;
  updatedAt: string;
}

export interface GatewayCallDispatchPayload {
  type: "CALL_OFFER" | "CALL_ANSWER" | "CALL_ICE" | "CALL_END";
  callId: string;
  scopeType: "voice" | "dm" | "room";
  scopeId: string;
  fromUserId: string;
  targetUserId: string;
  signal: Record<string, unknown> | null;
  updatedAt: string;
}

export interface GatewayPublishPresencePayload {
  presence: {
    status: UserPresenceEntity["status"];
    activities: unknown[];
    metadata?: Record<string, unknown> | null;
  };
}

export interface GatewayPublishTypingPayload {
  conversationId: string;
}

export interface GatewayPublishSpotifyPayload {
  userId?: string;
  status: UserPresenceEntity["status"];
  activity: SpotifyActivityEntity | null;
}

export interface GatewayPublishCallPayload {
  callId: string;
  scopeType: "voice" | "dm" | "room";
  scopeId: string;
  targetUserId: string;
  signal: Record<string, unknown> | null;
}

export interface GatewayDispatchPayloadMap {
  READY: GatewayReadyPayload;
  RESUMED: GatewayReadyPayload;
  MESSAGE_CREATE: GatewayMessageDispatchPayload;
  MESSAGE_UPDATE: GatewayMessageDispatchPayload;
  MESSAGE_DELETE: GatewayMessageDeleteDispatchPayload;
  MEDIA_DELETE: GatewayMediaDeleteDispatchPayload;
  PRESENCE_UPDATE: GatewayPresenceDispatchPayload;
  TYPING_START: GatewayTypingDispatchPayload;
  TYPING_STOP: GatewayTypingDispatchPayload;
  FRIEND_REQUEST_CREATE: GatewayFriendRequestDispatchPayload;
  FRIEND_REQUEST_ACCEPT: GatewayFriendRequestDispatchPayload;
  USER_UPDATE: GatewayUserUpdateDispatchPayload;
  SPOTIFY_UPDATE: GatewaySpotifyDispatchPayload;
  CALL_OFFER: GatewayCallDispatchPayload;
  CALL_ANSWER: GatewayCallDispatchPayload;
  CALL_ICE: GatewayCallDispatchPayload;
  CALL_END: GatewayCallDispatchPayload;
}

export interface GatewayPublishPayloadMap {
  PRESENCE_UPDATE: GatewayPublishPresencePayload;
  TYPING_START: GatewayPublishTypingPayload;
  TYPING_STOP: GatewayPublishTypingPayload;
  SPOTIFY_UPDATE: GatewayPublishSpotifyPayload;
  CALL_OFFER: GatewayPublishCallPayload;
  CALL_ANSWER: GatewayPublishCallPayload;
  CALL_ICE: GatewayPublishCallPayload;
  CALL_END: GatewayPublishCallPayload;
}

export function isGatewayDispatchEventType(value: unknown): value is GatewayDispatchEventType {
  switch (value) {
    case "READY":
    case "RESUMED":
    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE":
    case "MESSAGE_DELETE":
    case "MEDIA_DELETE":
    case "PRESENCE_UPDATE":
    case "TYPING_START":
    case "TYPING_STOP":
    case "FRIEND_REQUEST_CREATE":
    case "FRIEND_REQUEST_ACCEPT":
    case "USER_UPDATE":
    case "SPOTIFY_UPDATE":
    case "CALL_OFFER":
    case "CALL_ANSWER":
    case "CALL_ICE":
    case "CALL_END":
      return true;
    default:
      return false;
  }
}
