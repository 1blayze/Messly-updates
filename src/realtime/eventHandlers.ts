import type { UnknownAction } from "@reduxjs/toolkit";
import type {
  GatewayDispatchEventType,
  GatewayDispatchPayloadMap,
} from "../gateway/protocol";
import { conversationsActions } from "../stores/conversationsSlice";
import { gatewayActions } from "../stores/gatewaySlice";
import { buildFriendRequestAcceptActions, buildFriendRequestCreateActions } from "./friendEvents";
import { buildMessageCreateActions, buildMessageDeleteActions, buildMessageUpdateActions } from "./messageEvents";
import { buildPresenceUpdateActions, buildSpotifyUpdateActions } from "./presenceEvents";

export interface GatewayEventContext {
  currentUserId: string | null;
}

export function buildGatewayActions<TEvent extends GatewayDispatchEventType>(
  eventType: TEvent,
  payload: GatewayDispatchPayloadMap[TEvent],
  context: GatewayEventContext,
): UnknownAction[] {
  switch (eventType) {
    case "READY":
    case "RESUMED":
      return [
        gatewayActions.gatewaySessionUpdated({
          sessionId: (payload as GatewayDispatchPayloadMap["READY"]).sessionId,
          seq: null,
        }),
      ];
    case "MESSAGE_CREATE":
      return buildMessageCreateActions(payload as GatewayDispatchPayloadMap["MESSAGE_CREATE"], context);
    case "MESSAGE_UPDATE":
      return buildMessageUpdateActions(payload as GatewayDispatchPayloadMap["MESSAGE_UPDATE"]);
    case "MESSAGE_DELETE":
      return buildMessageDeleteActions(payload as GatewayDispatchPayloadMap["MESSAGE_DELETE"]);
    case "PRESENCE_UPDATE":
      return buildPresenceUpdateActions(payload as GatewayDispatchPayloadMap["PRESENCE_UPDATE"]);
    case "TYPING_START":
      return [
        conversationsActions.conversationTypingUpdated({
          conversationId: (payload as GatewayDispatchPayloadMap["TYPING_START"]).conversationId,
          userId: (payload as GatewayDispatchPayloadMap["TYPING_START"]).userId,
          isTyping: true,
        }),
      ];
    case "TYPING_STOP":
      return [
        conversationsActions.conversationTypingUpdated({
          conversationId: (payload as GatewayDispatchPayloadMap["TYPING_STOP"]).conversationId,
          userId: (payload as GatewayDispatchPayloadMap["TYPING_STOP"]).userId,
          isTyping: false,
        }),
      ];
    case "FRIEND_REQUEST_CREATE":
      return buildFriendRequestCreateActions(payload as GatewayDispatchPayloadMap["FRIEND_REQUEST_CREATE"]);
    case "FRIEND_REQUEST_ACCEPT":
      return buildFriendRequestAcceptActions(payload as GatewayDispatchPayloadMap["FRIEND_REQUEST_ACCEPT"]);
    case "SPOTIFY_UPDATE":
      return buildSpotifyUpdateActions(payload as GatewayDispatchPayloadMap["SPOTIFY_UPDATE"]);
    default:
      return [];
  }
}
