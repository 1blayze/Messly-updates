import { supabase } from "./client";
import { listFriendRequests, type FriendRequestListRow } from "../services/friends/friendRequestsApi";
import { mapFriendRequestRowToEntity, mapProfileRowToEntity, type UserProfileEntity } from "../stores/entities";
import type { FriendRequestEntity } from "../stores/entities";

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

  const { data, error } = await supabase
    .from("profiles")
    .select("id,username,display_name,avatar_url,banner_url,bio,updated_at")
    .in("id", normalizedUserIds);

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
    listFriendRequests("accepted"),
    listFriendRequests("pending"),
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
  const { data, error } = await supabase
    .from("friend_requests")
    .insert({
      addressee_id: addresseeId,
      status: "pending",
    })
    .select("id,requester_id,addressee_id,status,created_at")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return mapFriendRequestRowToEntity(data as FriendRequestListRow);
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  const { error } = await supabase.from("friend_requests").update({ status: "accepted" }).eq("id", requestId);
  if (error) {
    throw error;
  }
}

export async function rejectFriendRequest(requestId: string): Promise<void> {
  const { error } = await supabase.from("friend_requests").update({ status: "rejected" }).eq("id", requestId);
  if (error) {
    throw error;
  }
}
