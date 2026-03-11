import type { UnknownAction } from "@reduxjs/toolkit";
import type {
  GatewayPresenceDispatchPayload,
  GatewaySpotifyDispatchPayload,
} from "../gateway/protocol";
import { presenceActions } from "../stores/presenceSlice";

export function buildPresenceUpdateActions(payload: GatewayPresenceDispatchPayload): UnknownAction[] {
  return [presenceActions.presenceUpserted(payload.presence)];
}

export function buildSpotifyUpdateActions(payload: GatewaySpotifyDispatchPayload): UnknownAction[] {
  return [
    presenceActions.presenceUpserted({
      userId: payload.userId,
      status: payload.status,
      activities: payload.activity ? [payload.activity] : [],
      lastSeen: payload.updatedAt,
      updatedAt: payload.updatedAt,
    }),
  ];
}
