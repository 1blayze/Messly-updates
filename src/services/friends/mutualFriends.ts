import { supabase } from "../supabase";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let hasMutualFriendRpc = true;

interface MutualFriendRow {
  friend_id?: string | null;
}

function normalizeUuid(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return UUID_REGEX.test(normalized) ? normalized : "";
}

export async function listMutualFriendIdsForCurrentUser(
  otherUserId: string | null | undefined,
): Promise<string[]> {
  if (!hasMutualFriendRpc) {
    return [];
  }

  const normalizedOtherUserId = normalizeUuid(otherUserId);
  if (!normalizedOtherUserId) {
    return [];
  }

  const { data, error } = await supabase.rpc("list_mutual_friend_ids", {
    p_other_user_id: normalizedOtherUserId,
  });

  if (error) {
    const errorCode = String((error as { code?: string | null }).code ?? "").trim().toUpperCase();
    const errorStatus = Number((error as { status?: number | string | null }).status ?? 0);
    const errorMessage = String((error as { message?: string | null }).message ?? "").toLowerCase();
    const isMissingRpc =
      errorCode === "PGRST202" ||
      errorCode === "42883" ||
      errorStatus === 404 ||
      errorMessage.includes("list_mutual_friend_ids");

    if (isMissingRpc) {
      hasMutualFriendRpc = false;
      return [];
    }
    throw error;
  }

  const rows = Array.isArray(data) ? (data as MutualFriendRow[]) : [];
  const uniqueIds = new Set<string>();
  const next: string[] = [];

  rows.forEach((row) => {
    const friendId = normalizeUuid(row?.friend_id);
    if (!friendId || friendId === normalizedOtherUserId || uniqueIds.has(friendId)) {
      return;
    }
    uniqueIds.add(friendId);
    next.push(friendId);
  });

  return next;
}
