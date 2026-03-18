import {
  acceptFriendRequest as acceptFriendRequestApi,
  createFriendRequest,
  listFriendRequests,
  rejectFriendRequest as rejectFriendRequestApi,
} from "../services/friends/friendRequestsApi";
import { mapFriendRequestRowToEntity, mapProfileRowToEntity, type UserProfileEntity } from "../stores/entities";
import type { FriendRequestEntity } from "../stores/entities";
import { queryProfilesByIds } from "../services/profile/profileReadApi";

interface ProfileLookupRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  bio: string | null;
  updated_at: string | null;
}

export interface FriendsHydrationPayload {
  acceptedUserIds: string[];
  requests: FriendRequestEntity[];
  profiles: UserProfileEntity[];
}

async function fetchProfilesByIds(userIds: string[]): Promise<UserProfileEntity[]> {
  const normalizedUserIds = [...new Set(userIds.map((userId) => String(userId ?? "").trim()).filter(Boolean))];
  if (normalizedUserIds.length === 0) {
    return [];
  }

  const { data, error } = await queryProfilesByIds(normalizedUserIds);

  if (error) {
    throw error;
  }

  return ((data ?? []) as ProfileLookupRow[]).map((row) =>
    mapProfileRowToEntity({
      id: row.id,
      email: null,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      banner_url: row.banner_url,
      bio: row.bio,
      created_at: row.updated_at ?? new Date().toISOString(),
      updated_at: row.updated_at,
    }),
  );
}

export async function hydrateFriends(currentUserId: string): Promise<FriendsHydrationPayload> {
  const [acceptedRows, pendingRows] = await Promise.all([
    listFriendRequests("accepted", currentUserId),
    listFriendRequests("pending", currentUserId),
  ]);

  const acceptedUserIds = acceptedRows
    .map((row) => {
      return row.requester_id === currentUserId ? row.addressee_id : row.requester_id;
    })
    .filter((userId) => userId !== currentUserId);

  const pendingRequests = pendingRows.map((row) => mapFriendRequestRowToEntity(row));
  const profiles = await fetchProfilesByIds([
    ...acceptedUserIds,
    ...pendingRows.flatMap((row) => [row.requester_id, row.addressee_id]),
  ]);

  return {
    acceptedUserIds,
    requests: pendingRequests,
    profiles,
  };
}

export async function sendFriendRequest(addresseeId: string): Promise<FriendRequestEntity> {
  return mapFriendRequestRowToEntity(await createFriendRequest(addresseeId));
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  await acceptFriendRequestApi(requestId);
}

export async function rejectFriendRequest(requestId: string): Promise<void> {
  await rejectFriendRequestApi(requestId);
}
