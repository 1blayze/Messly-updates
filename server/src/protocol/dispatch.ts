import type { GatewayDispatchEvent, GatewayPresenceStatus, GatewaySubscriptionType } from "./opcodes";

export interface GatewaySubscription {
  type: GatewaySubscriptionType;
  id: string;
}

export interface GatewayFrame<TPayload = unknown, TEvent extends string | null = string | null> {
  op: string;
  s: number | null;
  t: TEvent;
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
  subscriptions: GatewaySubscription[];
  shardId: number;
  shardCount: number;
}

export interface GatewayInvalidSessionPayload {
  reason: string;
  canResume: boolean;
}

export interface GatewayReconnectPayload {
  reason: string;
  retryAfterMs: number;
  targetInstanceId?: string;
}

export interface GatewayErrorPayload {
  code: string;
  message: string;
  retryAfterMs?: number;
  details?: unknown;
}

export interface GatewayPresenceActivity {
  type: string;
  [key: string]: unknown;
}

export interface GatewayPresenceSnapshot {
  userId: string;
  sessionId?: string | null;
  deviceId?: string | null;
  status: GatewayPresenceStatus;
  activities: GatewayPresenceActivity[];
  lastSeen: string;
  metadata?: Record<string, unknown> | null;
}

export interface GatewayPresenceDispatchPayload {
  presence: GatewayPresenceSnapshot;
}

export interface GatewayPublishPresencePayload {
  presence: {
    status: GatewayPresenceStatus;
    activities: GatewayPresenceActivity[];
    metadata?: Record<string, unknown> | null;
  };
}

export interface GatewayTypingDispatchPayload {
  conversationId: string;
  userId: string;
  expiresAt: string;
}

export interface GatewayPublishTypingPayload {
  conversationId: string;
}

export interface GatewayMessageDispatchPayload {
  message: Record<string, unknown>;
  conversation?: Record<string, unknown> | null;
  profiles?: Record<string, unknown>[];
}

export interface GatewayMessageDeleteDispatchPayload {
  conversationId: string;
  messageId: string;
  deletedAt: string;
}

export interface GatewayFriendRequestDispatchPayload {
  request: Record<string, unknown>;
  profiles?: Record<string, unknown>[];
}

export interface GatewayUserUpdateDispatchPayload {
  user: Record<string, unknown>;
}

export interface GatewaySpotifyDispatchPayload {
  userId: string;
  status: GatewayPresenceStatus;
  activity: Record<string, unknown> | null;
  updatedAt: string;
}

export interface GatewayPublishSpotifyPayload {
  userId?: string;
  status: GatewayPresenceStatus;
  activity: Record<string, unknown> | null;
}

export interface GatewayDispatchPayloadMap {
  READY: GatewayReadyPayload;
  RESUMED: GatewayReadyPayload;
  MESSAGE_CREATE: GatewayMessageDispatchPayload;
  MESSAGE_UPDATE: GatewayMessageDispatchPayload;
  MESSAGE_DELETE: GatewayMessageDeleteDispatchPayload;
  MEDIA_DELETE: {
    fileKey: string;
    deletedAt: string;
    source: string;
  };
  PRESENCE_UPDATE: GatewayPresenceDispatchPayload;
  TYPING_START: GatewayTypingDispatchPayload;
  TYPING_STOP: GatewayTypingDispatchPayload;
  FRIEND_REQUEST_CREATE: GatewayFriendRequestDispatchPayload;
  FRIEND_REQUEST_ACCEPT: GatewayFriendRequestDispatchPayload;
  USER_UPDATE: GatewayUserUpdateDispatchPayload;
  SPOTIFY_UPDATE: GatewaySpotifyDispatchPayload;
}

export interface GatewayPublishPayloadMap {
  PRESENCE_UPDATE: GatewayPublishPresencePayload;
  TYPING_START: GatewayPublishTypingPayload;
  TYPING_STOP: GatewayPublishTypingPayload;
  SPOTIFY_UPDATE: GatewayPublishSpotifyPayload;
}

export type GatewayDispatchEnvelope<TEvent extends GatewayDispatchEvent = GatewayDispatchEvent> = GatewayFrame<
  GatewayDispatchPayloadMap[TEvent],
  TEvent
> & {
  op: "DISPATCH";
};
