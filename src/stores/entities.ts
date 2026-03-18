import type { ChatMessageServer, ChatMessageType } from "../services/chat/chatApi";
import type { FriendRequestListRow } from "../services/friends/friendRequestsApi";
import type {
  PresenceSnapshot,
  PresenceSpotifyActivity,
  PresenceState,
} from "../services/presence/presenceTypes";
import type { ProfileRow } from "../services/profile/profileService";

export type GatewayPresenceStatus = "online" | "idle" | "dnd" | "offline" | "invisible";
export type ConversationScopeType = "dm" | "guild" | "channel";
export type MessageDeliveryState = "pending" | "sent" | "failed";

export interface SpotifyActivityEntity {
  type: "spotify";
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
  albumArtUrl: string;
  duration: number;
  progress: number;
  isPlaying: boolean;
  startedAt: number | null;
  endedAt: number | null;
  trackUrl: string | null;
  updatedAt: string;
}

export interface UserPresenceEntity {
  userId: string;
  status: GatewayPresenceStatus;
  activities: SpotifyActivityEntity[];
  lastSeen: string | null;
  updatedAt: string | null;
}

export interface UserProfileEntity {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  updatedAt: string | null;
}

export interface ConversationEntity {
  id: string;
  scopeType: ConversationScopeType;
  scopeId: string;
  participantIds: string[];
  name?: string | null;
  avatarUrl?: string | null;
  createdBy?: string | null;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  typingUserIds: string[];
  updatedAt: string | null;
}

export interface MessageEntity {
  id: string;
  conversationId: string;
  scopeType: ConversationScopeType;
  scopeId: string;
  senderId: string;
  clientId: string | null;
  content: string;
  type: ChatMessageType;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: string | null;
  payload: Record<string, unknown> | null;
  attachment: ChatMessageServer["attachment"];
  deliveryState: MessageDeliveryState;
  errorMessage: string | null;
}

export interface FriendRequestEntity {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string | null;
}

export interface NotificationEntity {
  id: string;
  eventId?: string | null;
  source?: "gateway" | "realtime" | "unknown";
  type: "message";
  conversationId: string;
  messageId: string;
  authorId: string;
  title: string;
  body: string;
  avatarUrl: string | null;
  conversationType?: "dm" | "channel" | "guild" | "unknown";
  contextLabel?: string | null;
  messageType?: ChatMessageType | null;
  attachmentMimeType?: string | null;
  attachmentCount?: number | null;
  muted?: boolean;
  createdAt: string;
  deliveredAt: string | null;
}

export function toGatewayPresenceStatus(status: PresenceState | GatewayPresenceStatus): GatewayPresenceStatus {
  if (status === "offline") {
    return "offline";
  }
  if (status === "invisible" || status === "invisivel") {
    return "invisible";
  }
  if (status === "online" || status === "idle" || status === "dnd") {
    return status;
  }
  return "offline";
}

export function mapSpotifyActivityEntity(
  activity: PresenceSpotifyActivity | null | undefined,
  updatedAtOverride?: string | null,
): SpotifyActivityEntity | null {
  if (!activity) {
    return null;
  }

  return {
    type: "spotify",
    trackId: String(activity.trackId ?? "").trim(),
    title: String(activity.trackTitle ?? "").trim(),
    artist: String(activity.artistNames ?? "").trim(),
    album: String(activity.albumTitle ?? "").trim() || null,
    albumArtUrl: String(activity.coverUrl ?? "").trim(),
    duration: Math.max(0, Math.round(Number(activity.durationSeconds ?? 0))),
    progress: Math.max(0, Math.round(Number(activity.progressSeconds ?? 0))),
    isPlaying: activity.isPlaying !== false,
    startedAt: typeof activity.startedAt === "number" ? activity.startedAt : null,
    endedAt: typeof activity.endsAt === "number" ? activity.endsAt : null,
    trackUrl: String(activity.trackUrl ?? "").trim() || null,
    updatedAt: updatedAtOverride ?? new Date(Number(activity.updatedAt ?? Date.now())).toISOString(),
  };
}

export function mapPresenceSnapshotToEntity(snapshot: PresenceSnapshot): UserPresenceEntity {
  const activities = snapshot.activities
    .map((activity) => mapSpotifyActivityEntity(activity, snapshot.updatedAt))
    .filter((activity): activity is SpotifyActivityEntity => activity !== null);

  return {
    userId: snapshot.userId,
    status: toGatewayPresenceStatus(snapshot.presenceState),
    activities,
    lastSeen: snapshot.lastSeen,
    updatedAt: snapshot.updatedAt,
  };
}

export function mapProfileRowToEntity(profile: ProfileRow): UserProfileEntity {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
    bannerUrl: profile.banner_url,
    bio: profile.bio,
    updatedAt: profile.updated_at ?? null,
  };
}

export function mapChatMessageToEntity(
  message: ChatMessageServer,
  options: {
    scopeType?: ConversationScopeType;
    scopeId?: string | null;
    deliveryState?: MessageDeliveryState;
    errorMessage?: string | null;
  } = {},
): MessageEntity {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    scopeType: options.scopeType ?? "dm",
    scopeId: options.scopeId ?? message.conversation_id,
    senderId: message.sender_id,
    clientId: message.client_id ?? null,
    content: message.content,
    type: message.type,
    createdAt: message.created_at,
    editedAt: message.edited_at ?? null,
    deletedAt: message.deleted_at ?? null,
    replyToId: message.reply_to_id ?? null,
    payload: message.payload ?? null,
    attachment: message.attachment ?? null,
    deliveryState: options.deliveryState ?? "sent",
    errorMessage: options.errorMessage ?? null,
  };
}

export function mapFriendRequestRowToEntity(row: FriendRequestListRow): FriendRequestEntity {
  return {
    id: row.id,
    requesterId: row.requester_id,
    addresseeId: row.addressee_id,
    status: row.status,
    createdAt: row.created_at ?? null,
  };
}
