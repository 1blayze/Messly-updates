import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { FriendRequestEntity } from "./entities";

export interface FriendsState {
  relationships: Record<string, { userId: string; requestId: string | null; since: string | null }>;
  ids: string[];
  entities: Record<string, FriendRequestEntity>;
}

const friendRequestsAdapter = createEntityAdapter<FriendRequestEntity, string>({
  selectId: (request) => request.id,
  sortComparer: (left, right) => {
    const leftCreated = left.createdAt ?? "";
    const rightCreated = right.createdAt ?? "";
    return leftCreated < rightCreated ? 1 : leftCreated > rightCreated ? -1 : 0;
  },
});

const initialState: FriendsState = friendRequestsAdapter.getInitialState({
  relationships: {},
}) as FriendsState;

const friendsSlice = createSlice({
  name: "friends",
  initialState,
  reducers: {
    friendsHydrated(
      state,
      action: PayloadAction<{
        acceptedUserIds: string[];
        requests: FriendRequestEntity[];
      }>,
    ) {
      friendRequestsAdapter.setAll(state as EntityState<FriendRequestEntity, string>, action.payload.requests);
      state.relationships = Object.fromEntries(
        action.payload.acceptedUserIds.map((userId) => [
          userId,
          {
            userId,
            requestId: null,
            since: null,
          },
        ]),
      );
    },
    friendRequestUpserted(state, action: PayloadAction<FriendRequestEntity>) {
      const request = action.payload;
      friendRequestsAdapter.upsertOne(state as EntityState<FriendRequestEntity, string>, request);
      if (request.status === "accepted") {
        const otherUserId = request.requesterId;
        state.relationships[otherUserId] = {
          userId: otherUserId,
          requestId: request.id,
          since: request.createdAt,
        };
      }
    },
    friendAccepted(
      state,
      action: PayloadAction<{
        userId: string;
        requestId: string | null;
        since: string | null;
      }>,
    ) {
      state.relationships[action.payload.userId] = {
        userId: action.payload.userId,
        requestId: action.payload.requestId,
        since: action.payload.since,
      };
    },
    friendsReset() {
      return initialState;
    },
  },
});

export const friendsActions = friendsSlice.actions;
export const friendsReducer = friendsSlice.reducer;
export const friendRequestsAdapterSelectors = friendRequestsAdapter.getSelectors<{ friends: FriendsState }>((state) => state.friends);
