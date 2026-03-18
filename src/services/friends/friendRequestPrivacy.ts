import { listMutualFriendIdsForCurrentUser } from "./mutualFriends";
import { queryProfileById, queryProfileByUsername } from "../profile/profileReadApi";

export interface FriendRequestPrivacySettings {
  allowAll: boolean;
  allowFriendsOfFriends: boolean;
}

export interface FriendRequestPrivacyUserRow {
  id?: string | null;
  username?: string | null;
  display_name?: string | null;
  friend_requests_allow_all?: boolean | null;
  friend_requests_allow_friends_of_friends?: boolean | null;
}

export interface FriendRequestBlockedNoticeDetail {
  title: string;
  description: string;
}

export type FriendRequestPermissionReason = "allowed" | "disabled" | "friends_of_friends_only" | "invalid";

export const FRIEND_REQUEST_BLOCKED_EVENT = "messly:friend-request-blocked";
export const DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS: FriendRequestPrivacySettings = {
  allowAll: true,
  allowFriendsOfFriends: true,
};

const FRIEND_REQUEST_PRIVACY_SELECT_COLUMNS =
  "id,username,display_name,friend_requests_allow_all,friend_requests_allow_friends_of_friends";
const FRIEND_REQUEST_PRIVACY_SELECT_COLUMNS_FALLBACK = "id,username,display_name";

function normalizeBooleanValue(rawValue: unknown, fallback: boolean): boolean {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function normalizeDisplayName(targetUser: Partial<FriendRequestPrivacyUserRow> | null | undefined): string {
  const displayName = String(targetUser?.display_name ?? "").trim();
  if (displayName) {
    return displayName;
  }

  const username = String(targetUser?.username ?? "").trim();
  if (username) {
    return username;
  }

  return "Esse perfil";
}

export function getFriendRequestPrivacySettings(
  targetUser: Partial<FriendRequestPrivacyUserRow> | FriendRequestPrivacySettings | null | undefined,
): FriendRequestPrivacySettings {
  if (targetUser && Object.prototype.hasOwnProperty.call(targetUser, "allowAll")) {
    const settings = targetUser as FriendRequestPrivacySettings;
    return {
      allowAll: normalizeBooleanValue(settings.allowAll, DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS.allowAll),
      allowFriendsOfFriends: normalizeBooleanValue(
        settings.allowFriendsOfFriends,
        DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS.allowFriendsOfFriends,
      ),
    };
  }

  const row = (targetUser ?? {}) as Partial<FriendRequestPrivacyUserRow>;
  return {
    allowAll: normalizeBooleanValue(row.friend_requests_allow_all, DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS.allowAll),
    allowFriendsOfFriends: normalizeBooleanValue(
      row.friend_requests_allow_friends_of_friends,
      DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS.allowFriendsOfFriends,
    ),
  };
}

export async function queryFriendRequestTargetByUsername(username: string) {
  const cleanedUsername = String(username ?? "").trim().replace(/^@+/, "").toLowerCase();
  return queryProfileByUsername(cleanedUsername);
}

export async function queryFriendRequestTargetById(userId: string) {
  const normalizedUserId = String(userId ?? "").trim();
  return queryProfileById(normalizedUserId);
}

export async function evaluateFriendRequestPermission(
  requesterId: string,
  targetUser: Partial<FriendRequestPrivacyUserRow> | null | undefined,
): Promise<{
  allowed: boolean;
  reason: FriendRequestPermissionReason;
  settings: FriendRequestPrivacySettings;
}> {
  const normalizedRequesterId = String(requesterId ?? "").trim();
  const normalizedTargetId = String(targetUser?.id ?? "").trim();
  const settings = getFriendRequestPrivacySettings(targetUser);

  if (!normalizedRequesterId || !normalizedTargetId || normalizedRequesterId === normalizedTargetId) {
    return {
      allowed: false,
      reason: "invalid",
      settings,
    };
  }

  if (settings.allowAll) {
    return {
      allowed: true,
      reason: "allowed",
      settings,
    };
  }

  if (!settings.allowFriendsOfFriends) {
    return {
      allowed: false,
      reason: "disabled",
      settings,
    };
  }

  const mutualFriendIds = await listMutualFriendIdsForCurrentUser(normalizedTargetId);
  const hasMutualFriend = mutualFriendIds.length > 0;

  return {
    allowed: hasMutualFriend,
    reason: hasMutualFriend ? "allowed" : "friends_of_friends_only",
    settings,
  };
}

export function buildFriendRequestBlockedNotice(
  targetUser: Partial<FriendRequestPrivacyUserRow> | null | undefined,
  reason: Exclude<FriendRequestPermissionReason, "allowed" | "invalid">,
): FriendRequestBlockedNoticeDetail {
  const targetName = normalizeDisplayName(targetUser);

  if (reason === "friends_of_friends_only") {
    return {
      title: "Pedido indisponível",
      description: `${targetName} recebe pedidos apenas de pessoas com amizades em comum. Quando houver um contato compartilhado, o envio ficará disponível.`,
    };
  }

  return {
    title: "Pedido indisponível",
    description: `${targetName} não está recebendo novos pedidos de amizade agora. Para iniciar a conexão, essa pessoa precisará enviar o convite primeiro.`,
  };
}

export function dispatchFriendRequestBlockedNotice(detail: FriendRequestBlockedNoticeDetail): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<FriendRequestBlockedNoticeDetail>(FRIEND_REQUEST_BLOCKED_EVENT, {
      detail,
    }),
  );
}
