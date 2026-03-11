import type { UnknownAction } from "@reduxjs/toolkit";
import type { GatewayFriendRequestDispatchPayload } from "../gateway/protocol";
import { friendsActions } from "../stores/friendsSlice";
import { profilesActions } from "../stores/profilesSlice";

export function buildFriendRequestCreateActions(payload: GatewayFriendRequestDispatchPayload): UnknownAction[] {
  const actions: UnknownAction[] = [];
  if (payload.profiles?.length) {
    actions.push(profilesActions.profilesUpserted(payload.profiles));
  }
  actions.push(friendsActions.friendRequestUpserted(payload.request));
  return actions;
}

export function buildFriendRequestAcceptActions(payload: GatewayFriendRequestDispatchPayload): UnknownAction[] {
  const actions = buildFriendRequestCreateActions(payload);
  const acceptedProfile = payload.profiles?.find((profile) => profile.id === payload.request.requesterId);
  if (acceptedProfile) {
    actions.push(
      friendsActions.friendAccepted({
        userId: acceptedProfile.id,
        requestId: payload.request.id,
        since: payload.request.createdAt,
      }),
    );
  }
  return actions;
}
