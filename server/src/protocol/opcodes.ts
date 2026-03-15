export const gatewayOpcodes = [
  "HELLO",
  "IDENTIFY",
  "RESUME",
  "HEARTBEAT",
  "HEARTBEAT_ACK",
  "PING",
  "PONG",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "PUBLISH",
  "DISPATCH",
  "RECONNECT",
  "INVALID_SESSION",
  "ERROR",
] as const;

export type GatewayOpcode = (typeof gatewayOpcodes)[number];

export const gatewayDispatchEvents = [
  "READY",
  "RESUMED",
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MEDIA_DELETE",
  "PRESENCE_UPDATE",
  "TYPING_START",
  "TYPING_STOP",
  "FRIEND_REQUEST_CREATE",
  "FRIEND_REQUEST_ACCEPT",
  "USER_UPDATE",
  "SPOTIFY_UPDATE",
] as const;

export type GatewayDispatchEvent = (typeof gatewayDispatchEvents)[number];

export const gatewaySubscriptionTypes = [
  "conversation",
  "user",
  "friends",
  "notifications",
  "room",
] as const;

export type GatewaySubscriptionType = (typeof gatewaySubscriptionTypes)[number];

export const gatewayPresenceStatuses = ["online", "idle", "dnd", "offline", "invisible"] as const;
export type GatewayPresenceStatus = (typeof gatewayPresenceStatuses)[number];

export const gatewayPublishEvents = [
  "PRESENCE_UPDATE",
  "TYPING_START",
  "TYPING_STOP",
  "SPOTIFY_UPDATE",
] as const;

export type GatewayPublishEvent = (typeof gatewayPublishEvents)[number];
