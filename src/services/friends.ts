import { hydrateFriends, acceptFriendRequest, rejectFriendRequest, sendFriendRequest } from "../api/friendsApi";
import { readCachedConversations, readCachedProfiles, writeCachedConversations, writeCachedProfiles } from "../realtime/cache";
import { conversationsActions } from "../stores/conversationsSlice";
import { friendsActions } from "../stores/friendsSlice";
import { profilesActions } from "../stores/profilesSlice";
import { messlyStore } from "../stores/store";
import { messagesService } from "./messages";
import { presenceService } from "./presence";

class FriendsService {
  async start(currentUserId: string): Promise<void> {
    const [cachedProfiles, cachedConversations] = await Promise.all([
      readCachedProfiles(),
      readCachedConversations(),
    ]);

    if (cachedProfiles) {
      messlyStore.dispatch(profilesActions.profilesHydrated(Object.values(cachedProfiles)));
    }
    if (cachedConversations) {
      messlyStore.dispatch(conversationsActions.conversationsHydrated(Object.values(cachedConversations)));
    }

    const [friends] = await Promise.all([
      hydrateFriends(currentUserId),
      messagesService.hydrateConversations(currentUserId),
    ]);

    messlyStore.dispatch(
      friendsActions.friendsHydrated({
        acceptedUserIds: friends.acceptedUserIds,
        requests: friends.requests,
      }),
    );
    messlyStore.dispatch(profilesActions.profilesUpserted(friends.profiles));
    presenceService.trackUsers([currentUserId, ...friends.acceptedUserIds]);

    await Promise.all([
      writeCachedProfiles(
        Object.fromEntries(
          messlyStore
            .getState()
            .profiles.ids
            .map((id) => messlyStore.getState().profiles.entities[id])
            .filter(Boolean)
            .map((profile) => [profile.id, profile]),
        ),
      ),
      writeCachedConversations(
        Object.fromEntries(
          messlyStore
            .getState()
            .conversations.ids
            .map((id) => messlyStore.getState().conversations.entities[id])
            .filter(Boolean)
            .map((conversation) => [conversation.id, conversation]),
        ),
      ),
    ]);
  }

  async createRequest(targetUserId: string): Promise<void> {
    const request = await sendFriendRequest(targetUserId);
    messlyStore.dispatch(friendsActions.friendRequestUpserted(request));
  }

  async acceptRequest(requestId: string): Promise<void> {
    await acceptFriendRequest(requestId);
  }

  async rejectRequest(requestId: string): Promise<void> {
    await rejectFriendRequest(requestId);
  }
}

export const friendsService = new FriendsService();
