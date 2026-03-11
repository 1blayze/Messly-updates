export type GatewayOp =
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
  | "INVALID_SESSION";

export type GatewayDispatchEvent =
  | "READY"
  | "RESUMED"
  | "MESSAGE_BATCH"
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
  | "CALL_END"
  | "CALL_SIGNAL";

export interface GatewayFrame<TPayload = unknown> {
  op: GatewayOp;
  s: number | null;
  t: string | null;
  d: TPayload;
}

export interface GatewaySubscription {
  type: "conversation" | "user" | "friends" | "notifications" | "voice";
  id: string;
}

export interface GatewayHelloPayload {
  heartbeatIntervalMs: number;
  connectionId: string;
  shardId: number;
  shardCount: number;
  resumeUrl: string;
}

export interface GatewayIdentifyPayload {
  token: string;
  client: {
    name: "messly-desktop" | "messly-electron" | string;
    version: string;
    platform: string;
  };
  subscriptions: GatewaySubscription[];
}

export interface GatewayResumePayload {
  token: string;
  sessionId: string;
  seq: number;
  subscriptions?: GatewaySubscription[];
}

export interface GatewayReadyPayload {
  sessionId: string;
  userId: string;
  shardId: number;
  shardCount: number;
  subscriptions: GatewaySubscription[];
}

export interface GatewayDispatchEnvelope<TPayload> {
  eventId: string;
  event: GatewayDispatchEvent;
  scopeType: "dm" | "guild" | "channel" | "voice";
  scopeId: string;
  payload: TPayload;
  occurredAt: string;
  priority: "high" | "medium" | "low";
}

export interface GatewayDispatchBatchPayload {
  events: Array<GatewayDispatchEnvelope<unknown>>;
  droppedEventCount?: number;
}
