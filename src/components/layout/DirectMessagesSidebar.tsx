import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import UserCard from "../UserCard/UserCard";
import Modal from "../ui/Modal";
import Tooltip from "../ui/Tooltip";
import { useAuthSession } from "../../auth/AuthProvider";
import {
  getAvatarUrl,
  getBannerUrl,
  getDefaultBannerUrl,
  getNameAvatarUrl,
  isDefaultAvatarUrl,
  isDefaultBannerUrl,
} from "../../services/cdn/mediaUrls";
import { supabase } from "../../services/supabase";
import { friendRequestsEnabled } from "../../services/friends/friendRequests";
import { listFriendRequests } from "../../services/friends/friendRequestsApi";
import { useConversationsRealtime, type ConversationMessageInsertEvent } from "../../hooks/useConversationsRealtime";
import {
  FRIEND_REQUEST_BLOCKED_EVENT,
  buildFriendRequestBlockedNotice,
  dispatchFriendRequestBlockedNotice,
  evaluateFriendRequestPermission,
  queryFriendRequestTargetByUsername,
  type FriendRequestBlockedNoticeDetail,
} from "../../services/friends/friendRequestPrivacy";
import {
  preloadChatMessages,
  removeCachedInitialChatMessageByClientId,
  type ChatMessageServer,
  upsertCachedInitialChatMessages,
} from "../../services/chat/chatApi";
import {
  buildHiddenDirectMessageStorageScopes,
  persistHiddenDirectMessageConversationIds,
  readHiddenDirectMessageConversationIds,
} from "../../services/chat/hiddenDirectMessages";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import { loadPendingProfile } from "../../services/userSync";
import type { PresenceSpotifyActivity, PresenceState } from "../../services/presence/presenceTypes";
import { presenceStore } from "../../services/presence/presenceStore";
import { hydrateSpotifyConnectionFromProfile } from "../../services/connections/spotifyConnection";
import { notificationsActions } from "../../stores/notificationsSlice";
import { useAppDispatch, useAppSelector } from "../../stores/store";
import { createClientNonce } from "../../utils/ids";
import musicalIcon from "../../assets/icons/ui/musical.svg";
import starIcon from "../../assets/icons/ui/favorite.svg";
import "../../styles/components/DirectMessagesSidebar.css";

interface SidebarIdentity {
  userId: string | null;
  displayName: string;
  username: string;
  about: string;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  avatarKey: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  bannerKey: string | null;
  bannerHash: string | null;
}

export interface SidebarDirectMessageSelection {
  conversationId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  presenceState: PresenceState;
  lastMessageAt?: string | null;
  isFavorite?: boolean;
  spotifyActivity?: PresenceSpotifyActivity | null;
  firebaseUid?: string;
  aboutText?: string;
  bannerColor?: string | null;
  themePrimaryColor?: string | null;
  themeAccentColor?: string | null;
  bannerKey?: string | null;
  bannerHash?: string | null;
  bannerSrc?: string;
  memberSinceAt?: string | null;
}

interface DirectMessagesSidebarProps {
  currentUserId?: string | null;
  isWindowFocused?: boolean;
  presenceState: PresenceState;
  onChangePresence: (state: PresenceState) => void;
  onOpenSettings: (section?: "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows") => void;
  activeConversationId?: string | null;
  onSelectDirectMessage?: (dm: SidebarDirectMessageSelection) => void;
  onOpenFriends?: () => void;
  onDirectMessagesChange?: (items: SidebarDirectMessageSelection[]) => void;
}

interface AddFriendFeedbackState {
  tone: "error" | "success";
  message: string;
}

interface ProfileMediaUpdatedDetail {
  userId: string;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  banner_color?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
}

interface ProfileUpdatedDetail {
  userId: string;
  display_name?: string | null;
  username?: string | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
}

const DM_PRESENCE_DEVICE_STALE_MS = 90_000;
const DM_SPOTIFY_ACTIVITY_END_GRACE_MS = 8_000;
const DM_SPOTIFY_ACTIVITY_NO_DURATION_STALE_MS = 60_000;

interface DmUserRow {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  updated_at?: string | null;
  status?: string | null;
  firebase_uid?: string | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  created_at?: string | null;
  spotify_connection?: unknown | null;
}

interface LegacyAvatarRow {
  user_id: string;
  avatar_url: string | null;
}

interface ConversationRow {
  id: string;
  user1_id: string;
  user2_id: string;
  created_at?: string | null;
  last_activity_at?: string | null;
}

interface DirectMessageItem {
  conversationId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  presenceState: PresenceState;
  lastMessageAt: string | null;
  isFavorite: boolean;
  spotifyActivity?: PresenceSpotifyActivity | null;
  firebaseUid?: string;
  aboutText?: string;
  bannerColor?: string | null;
  themePrimaryColor?: string | null;
  themeAccentColor?: string | null;
  bannerKey?: string | null;
  bannerHash?: string | null;
  bannerSrc?: string;
  memberSinceAt?: string | null;
}

interface BroadcastChatMessageItem {
  id?: string;
  conversationId?: string;
  senderId?: string;
  clientId?: string | null;
  content?: string;
  type?: string;
  createdAt?: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  replyToId?: string | null;
  replyToSnapshot?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  attachment?: {
    fileKey: string;
    originalKey?: string | null;
    thumbKey?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
    width?: number | null;
    height?: number | null;
    thumbWidth?: number | null;
    thumbHeight?: number | null;
    codec?: string | null;
    durationMs?: number | null;
  } | null;
}

interface CachedDmAvatarEntry {
  signature: string;
  url: string;
}

interface CachedSidebarIdentity {
  userId: string | null;
  displayName: string;
  username: string;
  about: string;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  avatarKey: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  bannerKey: string | null;
  bannerHash: string | null;
}

const SIDEBAR_IDENTITY_CACHE_PREFIX = "messly:sidebar-identity:";
const DIRECT_MESSAGES_CACHE_PREFIX = "messly:direct-messages:";
const DIRECT_MESSAGES_FAVORITES_CACHE_PREFIX = "messly:direct-messages:favorites:";
const SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX = "messly:sidebar-media:";
const DIRECT_MESSAGES_CACHE_VERSION = 9;
const DM_PRELOAD_LIMIT = 30;             
const DM_PRELOAD_HOVER_DEBOUNCE_MS = 150; 
const DM_PRELOAD_MAX_AGE_MS = 90_000;
const DM_PRELOAD_LIST_WARMUP_COUNT = 6;
const DM_PRELOAD_LIST_WARMUP_ENABLED = import.meta.env.PROD;
const DM_REORDER_FLIP_DURATION_MS = 220;

function areHiddenDmConversationIdsEqual(current: string[], next: string[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) {
      return false;
    }
  }

  return true;
}


interface CachedDirectMessagesPayload {
  version: number;
  items: DirectMessageItem[];
}

interface DirectMessageContextMenuState {
  conversationId: string;
  userId: string;
  displayName: string;
  x: number;
  y: number;
}

interface FriendRequestRow {
  id?: string | null;
  requester_id?: string | null;
  addressee_id?: string | null;
  status?: string | null;
}

interface CachedSidebarResolvedMedia {
  avatarSrc: string;
  bannerSrc: string;
  updatedAt: number;
}

const dmAvatarCache = new Map<string, CachedDmAvatarEntry>();
const dmPresenceCache = new Map<string, PresenceState>();

function toSidebarSelection(dm: DirectMessageItem): SidebarDirectMessageSelection {
  const resolvedDisplayName = normalizeIdentityDisplayName(dm.displayName, dm.username, dm.username);
  return {
    conversationId: dm.conversationId,
    userId: dm.userId,
    username: dm.username,
    displayName: resolvedDisplayName,
    avatarSrc: dm.avatarSrc,
    presenceState: dm.presenceState,
    lastMessageAt: dm.lastMessageAt,
    isFavorite: dm.isFavorite,
    spotifyActivity: dm.spotifyActivity ?? null,
    firebaseUid: dm.firebaseUid,
    aboutText: dm.aboutText,
    bannerColor: dm.bannerColor ?? null,
    themePrimaryColor: dm.themePrimaryColor ?? null,
    themeAccentColor: dm.themeAccentColor ?? null,
    bannerKey: dm.bannerKey ?? null,
    bannerHash: dm.bannerHash ?? null,
    bannerSrc: dm.bannerSrc,
    memberSinceAt: dm.memberSinceAt ?? null,
  };
}

function normalizeIdentityUsername(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || DEFAULT_IDENTITY.username;
}

function normalizeIdentityDisplayName(
  displayNameRaw: string | null | undefined,
  usernameRaw: string | null | undefined,
  fallbackRaw: string | null | undefined,
): string {
  const displayName = String(displayNameRaw ?? "").trim();
  if (displayName && displayName.toLowerCase() !== DEFAULT_IDENTITY.displayName.toLowerCase()) {
    return displayName;
  }

  const username = String(usernameRaw ?? "").trim();
  if (username && username.toLowerCase() !== DEFAULT_IDENTITY.username.toLowerCase()) {
    return username;
  }

  const fallback = String(fallbackRaw ?? "").trim();
  if (fallback) {
    return fallback;
  }

  if (username) {
    return username;
  }

  return DEFAULT_IDENTITY.displayName;
}

function readSidebarIdentityCache(firebaseUid: string | null | undefined): CachedSidebarIdentity | null {
  if (!firebaseUid || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${SIDEBAR_IDENTITY_CACHE_PREFIX}${firebaseUid}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedSidebarIdentity>;
    return {
      userId: parsed.userId ?? null,
      displayName: String(parsed.displayName ?? "").trim(),
      username: String(parsed.username ?? "").trim(),
      about: String(parsed.about ?? ""),
      bannerColor: normalizeBannerColor(parsed.bannerColor) ?? null,
      themePrimaryColor: normalizeBannerColor((parsed as { themePrimaryColor?: string | null }).themePrimaryColor) ?? null,
      themeAccentColor: normalizeBannerColor((parsed as { themeAccentColor?: string | null }).themeAccentColor) ?? null,
      avatarKey: parsed.avatarKey ?? null,
      avatarHash: parsed.avatarHash ?? null,
      avatarUrl: parsed.avatarUrl ?? null,
      bannerKey: parsed.bannerKey ?? null,
      bannerHash: parsed.bannerHash ?? null,
    };
  } catch {
    return null;
  }
}

function writeSidebarIdentityCache(firebaseUid: string | null | undefined, identity: SidebarIdentity): void {
  if (!firebaseUid || typeof window === "undefined") {
    return;
  }

  try {
    const key = `${SIDEBAR_IDENTITY_CACHE_PREFIX}${firebaseUid}`;
    const payload: CachedSidebarIdentity = {
      userId: identity.userId,
      displayName: identity.displayName,
      username: identity.username,
      about: identity.about,
      bannerColor: identity.bannerColor,
      themePrimaryColor: identity.themePrimaryColor,
      themeAccentColor: identity.themeAccentColor,
      avatarKey: identity.avatarKey,
      avatarHash: identity.avatarHash,
      avatarUrl: identity.avatarUrl,
      bannerKey: identity.bannerKey,
      bannerHash: identity.bannerHash,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage write failures
  }
}

function normalizeActivityTimestamp(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function readFavoriteDirectMessageConversationIds(userId: string | null | undefined): string[] {
  if (!userId || typeof window === "undefined") {
    return [];
  }

  try {
    const key = `${DIRECT_MESSAGES_FAVORITES_CACHE_PREFIX}${userId}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(
      new Set(
        parsed
          .map((conversationId) => String(conversationId ?? "").trim())
          .filter((conversationId) => Boolean(conversationId)),
      ),
    );
  } catch {
    return [];
  }
}

function writeFavoriteDirectMessageConversationIds(
  userId: string | null | undefined,
  conversationIds: readonly string[],
): void {
  if (!userId || typeof window === "undefined") {
    return;
  }

  try {
    const key = `${DIRECT_MESSAGES_FAVORITES_CACHE_PREFIX}${userId}`;
    const normalizedConversationIds = Array.from(
      new Set(
        conversationIds
          .map((conversationId) => String(conversationId ?? "").trim())
          .filter((conversationId) => Boolean(conversationId)),
      ),
    );
    window.localStorage.setItem(key, JSON.stringify(normalizedConversationIds));
  } catch {
    // ignore storage write failures
  }
}

function compareDirectMessagesByPriority(left: DirectMessageItem, right: DirectMessageItem): number {
  if (left.isFavorite !== right.isFavorite) {
    return left.isFavorite ? -1 : 1;
  }

  const leftTimestamp = left.lastMessageAt ?? "";
  const rightTimestamp = right.lastMessageAt ?? "";
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp < rightTimestamp ? 1 : -1;
  }

  return left.displayName.localeCompare(right.displayName, "pt-BR", { sensitivity: "base" });
}

function sortDirectMessages(items: readonly DirectMessageItem[]): DirectMessageItem[] {
  const sorted = [...items];
  sorted.sort(compareDirectMessagesByPriority);
  return sorted;
}

function applyConversationActivityToDirectMessages(
  current: DirectMessageItem[],
  rows: ConversationRow[],
  currentUserId: string,
): {
  nextItems: DirectMessageItem[];
  missingRows: ConversationRow[];
  changed: boolean;
} {
  if (current.length === 0) {
    return {
      nextItems: [],
      missingRows: rows,
      changed: rows.length > 0,
    };
  }

  const currentByConversationId = new Map<string, DirectMessageItem>();
  current.forEach((item) => {
    currentByConversationId.set(item.conversationId, item);
  });

  const nextItems: DirectMessageItem[] = [];
  const missingRows: ConversationRow[] = [];
  let changed = current.length !== rows.length;

  rows.forEach((row) => {
    const existing = currentByConversationId.get(row.id);
    if (!existing) {
      missingRows.push(row);
      changed = true;
      return;
    }

    currentByConversationId.delete(row.id);
    const otherUserId = row.user1_id === currentUserId ? row.user2_id : row.user1_id;
    const nextLastMessageAt = normalizeActivityTimestamp(row.last_activity_at ?? row.created_at);
    if (existing.userId === otherUserId && existing.lastMessageAt === nextLastMessageAt) {
      nextItems.push(existing);
      return;
    }

    changed = true;
    nextItems.push({
      ...existing,
      userId: otherUserId,
      lastMessageAt: nextLastMessageAt,
    });
  });

  if (currentByConversationId.size > 0) {
    changed = true;
  }

  return {
    nextItems,
    missingRows,
    changed,
  };
}

function readDirectMessagesCache(userId: string | null | undefined): DirectMessageItem[] | null {
  if (!userId || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${DIRECT_MESSAGES_CACHE_PREFIX}${userId}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedDirectMessagesPayload>;
    if (parsed.version !== DIRECT_MESSAGES_CACHE_VERSION || !Array.isArray(parsed.items)) {
      return null;
    }
    const favoriteConversationIds = new Set(readFavoriteDirectMessageConversationIds(userId));
    return parsed.items
      .map((item): DirectMessageItem | null => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const casted = item as Partial<DirectMessageItem>;
        const conversationId = String(casted.conversationId ?? "").trim();
        const userIdValue = String(casted.userId ?? "").trim();
        if (!conversationId || !userIdValue) {
          return null;
        }
        const username = normalizeIdentityUsername(casted.username);
        const displayName = normalizeIdentityDisplayName(casted.displayName, username, username);
        const cachedAvatarSrc = String(casted.avatarSrc ?? "").trim();
        const avatarSrc = !cachedAvatarSrc || isDmFallbackAvatar(cachedAvatarSrc)
          ? getDmDisplayAvatar(displayName, username, userIdValue)
          : cachedAvatarSrc;
        const firebaseUid = String((casted as { firebaseUid?: string | null }).firebaseUid ?? "").trim();
        const aboutText = String((casted as { aboutText?: string | null }).aboutText ?? "").trim();
        const bannerColor = normalizeBannerColor((casted as { bannerColor?: string | null }).bannerColor) ?? null;
        const themePrimaryColor =
          normalizeBannerColor((casted as { themePrimaryColor?: string | null }).themePrimaryColor) ?? null;
        const themeAccentColor =
          normalizeBannerColor((casted as { themeAccentColor?: string | null }).themeAccentColor) ?? null;
        const bannerKey = String((casted as { bannerKey?: string | null }).bannerKey ?? "").trim() || null;
        const bannerHash = String((casted as { bannerHash?: string | null }).bannerHash ?? "").trim() || null;
        const bannerSrc = String((casted as { bannerSrc?: string | null }).bannerSrc ?? "").trim();
        const memberSinceAt = String((casted as { memberSinceAt?: string | null }).memberSinceAt ?? "").trim() || null;
        const spotifyActivity = normalizePresenceSpotifyActivity(
          (casted as { spotifyActivity?: unknown }).spotifyActivity ?? null,
        );
        const parsedItem: DirectMessageItem = {
          conversationId,
          userId: userIdValue,
          username,
          displayName,
          avatarSrc,
          presenceState: normalizePresenceState((casted as { presenceState?: unknown }).presenceState ?? null),
          lastMessageAt: normalizeActivityTimestamp(
            (casted as { lastMessageAt?: string | null }).lastMessageAt ?? null,
          ),
          isFavorite:
            favoriteConversationIds.has(conversationId) ||
            Boolean((casted as { isFavorite?: boolean }).isFavorite),
          ...(spotifyActivity ? { spotifyActivity } : {}),
          ...(firebaseUid ? { firebaseUid } : {}),
          ...(aboutText ? { aboutText } : {}),
          ...(bannerColor ? { bannerColor } : {}),
          ...(themePrimaryColor ? { themePrimaryColor } : {}),
          ...(themeAccentColor ? { themeAccentColor } : {}),
          ...(bannerKey ? { bannerKey } : {}),
          ...(bannerHash ? { bannerHash } : {}),
          ...(bannerSrc ? { bannerSrc } : {}),
          ...(memberSinceAt ? { memberSinceAt } : {}),
        };
        return parsedItem;
      })
      .filter((item): item is DirectMessageItem => item !== null);
  } catch {
    return null;
  }
}

function writeDirectMessagesCache(userId: string | null | undefined, items: DirectMessageItem[]): void {
  if (!userId || typeof window === "undefined") {
    return;
  }

  try {
    const key = `${DIRECT_MESSAGES_CACHE_PREFIX}${userId}`;
    const payload: CachedDirectMessagesPayload = {
      version: DIRECT_MESSAGES_CACHE_VERSION,
      items,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage write failures
  }
}

function mapBroadcastMessageToServerMessage(
  conversationIdRaw: string,
  message: BroadcastChatMessageItem | null | undefined,
): ChatMessageServer | null {
  const conversationId = String(conversationIdRaw ?? "").trim();
  if (!conversationId || !message) {
    return null;
  }

  const id = String(message.id ?? "").trim();
  const senderId = String(message.senderId ?? "").trim();
  const createdAt = String(message.createdAt ?? "").trim();
  if (!id || !senderId || !createdAt) {
    return null;
  }

  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    client_id: String(message.clientId ?? "").trim() || null,
    content: String(message.content ?? ""),
    type: (String(message.type ?? "text").trim() || "text") as ChatMessageServer["type"],
    created_at: createdAt,
    edited_at: String(message.editedAt ?? "").trim() || null,
    deleted_at: String(message.deletedAt ?? "").trim() || null,
    reply_to_id: String(message.replyToId ?? "").trim() || null,
    reply_to_snapshot:
      message.replyToSnapshot && typeof message.replyToSnapshot === "object" && !Array.isArray(message.replyToSnapshot)
        ? { ...message.replyToSnapshot }
        : null,
    payload:
      message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
        ? { ...message.payload }
        : null,
    attachment: message.attachment
      ? {
          fileKey: String(message.attachment.fileKey ?? "").trim(),
          originalKey: String(message.attachment.originalKey ?? "").trim() || null,
          thumbKey: String(message.attachment.thumbKey ?? "").trim() || null,
          mimeType: String(message.attachment.mimeType ?? "").trim() || null,
          fileSize: typeof message.attachment.fileSize === "number" ? message.attachment.fileSize : null,
          width: typeof message.attachment.width === "number" ? message.attachment.width : null,
          height: typeof message.attachment.height === "number" ? message.attachment.height : null,
          thumbWidth: typeof message.attachment.thumbWidth === "number" ? message.attachment.thumbWidth : null,
          thumbHeight: typeof message.attachment.thumbHeight === "number" ? message.attachment.thumbHeight : null,
          codec: String(message.attachment.codec ?? "").trim() || null,
          durationMs: typeof message.attachment.durationMs === "number" ? message.attachment.durationMs : null,
        }
      : null,
  };
}

function isInlineMediaUrl(url: string): boolean {
  return url.startsWith("data:image/");
}

function isAbsoluteMediaUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:");
}

function isCacheableMediaUrl(url: string): boolean {
  return isInlineMediaUrl(url) || isAbsoluteMediaUrl(url);
}

function readSidebarResolvedMediaCache(firebaseUid: string | null | undefined): CachedSidebarResolvedMedia | null {
  if (!firebaseUid || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX}${firebaseUid}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedSidebarResolvedMedia>;
    const avatarSrc = String(parsed.avatarSrc ?? "").trim();
    const bannerSrc = String(parsed.bannerSrc ?? "").trim();
    const updatedAtRaw = Number((parsed as { updatedAt?: unknown }).updatedAt ?? NaN);
    const updatedAt = Number.isFinite(updatedAtRaw) ? updatedAtRaw : null;
    if (!avatarSrc || !bannerSrc) {
      return null;
    }
    if (!isCacheableMediaUrl(avatarSrc) || !isCacheableMediaUrl(bannerSrc)) {
      return null;
    }
    // Reuse the last known media URLs even if stale to avoid startup flicker.
    // Fresh signed URLs are still fetched in background by the existing effects.
    return { avatarSrc, bannerSrc, updatedAt: updatedAt ?? Date.now() };
  } catch {
    return null;
  }
}

function writeSidebarResolvedMediaCache(
  firebaseUid: string | null | undefined,
  avatarSrc: string,
  bannerSrc: string,
): void {
  if (!firebaseUid || typeof window === "undefined") {
    return;
  }

  try {
    if (!isCacheableMediaUrl(avatarSrc) || !isCacheableMediaUrl(bannerSrc)) {
      return;
    }
    const key = `${SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX}${firebaseUid}`;
    const payload: CachedSidebarResolvedMedia = { avatarSrc, bannerSrc, updatedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage write failures
  }
}

function getDmDisplayAvatar(displayName: string, username: string, userId?: string | null): string {
  return getNameAvatarUrl(displayName || username || "U");
}

function isGeneratedInlineAvatarUrl(url: string | null | undefined): boolean {
  return String(url ?? "").startsWith("data:image/svg+xml,");
}

function isDmFallbackAvatar(url: string | null | undefined): boolean {
  return isDefaultAvatarUrl(url) || isGeneratedInlineAvatarUrl(url);
}

function buildDmAvatarSignature(targetUser: DmUserRow | undefined, legacyBackupUrl: string): string {
  return [
    String(targetUser?.avatar_key ?? "").trim(),
    String(targetUser?.avatar_hash ?? "").trim().toLowerCase(),
    String(targetUser?.avatar_url ?? "").trim(),
    String(targetUser?.updated_at ?? "").trim(),
    legacyBackupUrl.trim(),
  ].join("|");
}

function getCachedDmAvatar(userId: string, signature: string): string | null {
  const cached = dmAvatarCache.get(userId);
  if (!cached || cached.signature !== signature) {
    return null;
  }
  if (isDmFallbackAvatar(cached.url)) {
    return null;
  }
  return cached.url;
}

function setCachedDmAvatar(userId: string, signature: string, url: string): void {
  if (isDmFallbackAvatar(url)) {
    dmAvatarCache.delete(userId);
    return;
  }
  dmAvatarCache.set(userId, {
    signature,
    url,
  });
}

function mergeDirectMessagesWithoutAvatarDowngrade(
  current: DirectMessageItem[],
  next: DirectMessageItem[],
): DirectMessageItem[] {
  if (current.length === 0) {
    return next;
  }

  const currentByConversationId = new Map<string, DirectMessageItem>();
  current.forEach((item) => {
    currentByConversationId.set(item.conversationId, item);
  });

  return next.map((item) => {
    const currentItem = currentByConversationId.get(item.conversationId);
    if (!currentItem) {
      return item;
    }

    const mergedItem: DirectMessageItem = { ...item };
    if (mergedItem.lastMessageAt == null && currentItem.lastMessageAt != null) {
      mergedItem.lastMessageAt = currentItem.lastMessageAt;
    }
    if (!mergedItem.isFavorite && currentItem.isFavorite) {
      mergedItem.isFavorite = true;
    }
    if (isDmFallbackAvatar(item.avatarSrc) && !isDmFallbackAvatar(currentItem.avatarSrc)) {
      mergedItem.avatarSrc = currentItem.avatarSrc;
    }
    if (typeof mergedItem.spotifyActivity === "undefined" && currentItem.spotifyActivity) {
      mergedItem.spotifyActivity = currentItem.spotifyActivity;
    }
    if (!mergedItem.aboutText && currentItem.aboutText) {
      mergedItem.aboutText = currentItem.aboutText;
    }
    if (typeof mergedItem.bannerColor === "undefined" && currentItem.bannerColor) {
      mergedItem.bannerColor = currentItem.bannerColor;
    }
    if (typeof mergedItem.themePrimaryColor === "undefined" && currentItem.themePrimaryColor) {
      mergedItem.themePrimaryColor = currentItem.themePrimaryColor;
    }
    if (typeof mergedItem.themeAccentColor === "undefined" && currentItem.themeAccentColor) {
      mergedItem.themeAccentColor = currentItem.themeAccentColor;
    }
    if (typeof mergedItem.bannerKey === "undefined" && currentItem.bannerKey) {
      mergedItem.bannerKey = currentItem.bannerKey;
    }
    if (typeof mergedItem.bannerHash === "undefined" && currentItem.bannerHash) {
      mergedItem.bannerHash = currentItem.bannerHash;
    }
    if (
      typeof mergedItem.bannerSrc === "undefined" &&
      currentItem.bannerSrc &&
      (Boolean(mergedItem.bannerKey) || Boolean(mergedItem.bannerHash))
    ) {
      mergedItem.bannerSrc = currentItem.bannerSrc;
    }
    if (!mergedItem.memberSinceAt && currentItem.memberSinceAt) {
      mergedItem.memberSinceAt = currentItem.memberSinceAt;
    }

    return mergedItem;
  });
}

function areDirectMessageListsEqual(current: DirectMessageItem[], next: DirectMessageItem[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentItem = current[index];
    const nextItem = next[index];
    if (
      currentItem.conversationId !== nextItem.conversationId ||
      currentItem.userId !== nextItem.userId ||
      currentItem.username !== nextItem.username ||
      currentItem.displayName !== nextItem.displayName ||
      currentItem.avatarSrc !== nextItem.avatarSrc ||
      currentItem.presenceState !== nextItem.presenceState ||
      (currentItem.lastMessageAt ?? "") !== (nextItem.lastMessageAt ?? "") ||
      currentItem.isFavorite !== nextItem.isFavorite ||
      !areSpotifyActivitiesEqual(currentItem.spotifyActivity ?? null, nextItem.spotifyActivity ?? null) ||
      (currentItem.firebaseUid ?? "") !== (nextItem.firebaseUid ?? "") ||
      (currentItem.aboutText ?? "") !== (nextItem.aboutText ?? "") ||
      (currentItem.bannerColor ?? "") !== (nextItem.bannerColor ?? "") ||
      (currentItem.themePrimaryColor ?? "") !== (nextItem.themePrimaryColor ?? "") ||
      (currentItem.themeAccentColor ?? "") !== (nextItem.themeAccentColor ?? "") ||
      (currentItem.bannerKey ?? "") !== (nextItem.bannerKey ?? "") ||
      (currentItem.bannerHash ?? "") !== (nextItem.bannerHash ?? "") ||
      (currentItem.bannerSrc ?? "") !== (nextItem.bannerSrc ?? "") ||
      (currentItem.memberSinceAt ?? "") !== (nextItem.memberSinceAt ?? "")
    ) {
      return false;
    }
  }

  return true;
}

function normalizePresenceState(value: unknown): PresenceState {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return "invisivel";
  }
  if (raw === "online" || raw === "disponivel" || raw === "available") {
    return "online";
  }
  if (raw === "idle" || raw === "ausente" || raw === "away") {
    return "idle";
  }
  if (raw === "dnd" || raw === "nao perturbar" || raw === "busy") {
    return "dnd";
  }
  if (raw === "invisivel" || raw === "invisible") {
    return "invisivel";
  }
  return "invisivel";
}

function FavoriteStarIcon({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src={starIcon}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
    />
  );
}

interface DirectMessageListItemProps {
  dm: DirectMessageItem;
  isActive: boolean;
  unreadCount: number;
  identityUserId: string | null;
  registerItemRef: (conversationId: string, node: HTMLDivElement | null) => void;
  onActivate: (dm: DirectMessageItem) => void;
  onHide: (conversationId: string) => void;
  onOpenContextMenu: (dm: DirectMessageItem, event: ReactMouseEvent<HTMLDivElement>) => void;
  onPreloadStart: (conversationId: string) => void;
  onPreloadStop: (conversationId: string) => void;
}

const DirectMessageListItem = memo(function DirectMessageListItem({
  dm,
  isActive,
  unreadCount,
  identityUserId,
  registerItemRef,
  onActivate,
  onHide,
  onOpenContextMenu,
  onPreloadStart,
  onPreloadStop,
}: DirectMessageListItemProps) {
  const resolvedDisplayName = normalizeIdentityDisplayName(dm.displayName, dm.username, dm.username);
  const fallbackNameAvatar = getDmDisplayAvatar(resolvedDisplayName, dm.username, dm.userId);
  const safeDmAvatarSrc = (() => {
    const raw = String(dm.avatarSrc ?? "").trim();
    if (!raw || isDefaultAvatarUrl(raw)) {
      return fallbackNameAvatar;
    }
    return raw;
  })();

  return (
    <div
      ref={(node) => {
        registerItemRef(dm.conversationId, node);
      }}
      className={`friends-sidebar__dm-item${isActive ? " friends-sidebar__dm-item--active" : ""}`}
      role="listitem"
      onContextMenu={(event) => {
        onOpenContextMenu(dm, event);
      }}
      onMouseEnter={() => {
        onPreloadStart(dm.conversationId);
      }}
      onMouseLeave={() => {
        onPreloadStop(dm.conversationId);
      }}
      onFocus={() => {
        onPreloadStart(dm.conversationId);
      }}
      onBlur={() => {
        onPreloadStop(dm.conversationId);
      }}
      onClick={() => {
        onActivate(dm);
      }}
    >
      <div className="friends-sidebar__dm-avatar-wrap">
        <AvatarImage
          className="friends-sidebar__dm-avatar"
          src={safeDmAvatarSrc}
          name={resolvedDisplayName}
          alt={`Avatar de ${resolvedDisplayName}`}
          loading="lazy"
        />
        <span
          className={`friends-sidebar__dm-presence friends-sidebar__dm-presence--${dm.presenceState}`}
          aria-hidden="true"
        />
      </div>

      <button className="friends-sidebar__dm-main" type="button">
        <span className="friends-sidebar__dm-name">{resolvedDisplayName}</span>
        {dm.spotifyActivity && dm.userId !== identityUserId ? (
          <span className="friends-sidebar__dm-spotify-status">
            <img className="friends-sidebar__dm-spotify-icon" src={musicalIcon} alt="" aria-hidden="true" />
            <span className="friends-sidebar__dm-spotify-track">
              {dm.spotifyActivity.artistNames || dm.spotifyActivity.trackTitle}
            </span>
          </span>
        ) : null}
      </button>

      <div className="friends-sidebar__dm-meta">
        {unreadCount > 0 ? (
          <span className="friends-sidebar__dm-unread" aria-label={`${unreadCount} mensagens n?o lidas`}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}

        {dm.isFavorite ? (
          <Tooltip text="Favoritado" position="top" delay={90}>
            <span className="friends-sidebar__dm-favorite" aria-label="Favoritado">
              <FavoriteStarIcon className="friends-sidebar__dm-favorite-icon" />
            </span>
          </Tooltip>
        ) : (
          <button
            className="friends-sidebar__dm-close"
            type="button"
            aria-label={`Fechar DM de ${resolvedDisplayName}`}
            onClick={(event) => {
              event.stopPropagation();
              onHide(dm.conversationId);
            }}
          >
            <MaterialSymbolIcon name="close" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}, (prev, next) => (
  prev.dm === next.dm &&
  prev.isActive === next.isActive &&
  prev.unreadCount === next.unreadCount &&
  prev.identityUserId === next.identityUserId
));

function normalizePresenceSpotifyActivity(value: unknown): PresenceSpotifyActivity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const casted = value as Partial<PresenceSpotifyActivity>;
  const providerRaw = String(casted.provider ?? "spotify").trim().toLowerCase();
  if (providerRaw && providerRaw !== "spotify") {
    return null;
  }

  const trackTitle = String(casted.trackTitle ?? "").trim();
  const artistNames = String(casted.artistNames ?? "").trim();
  if (!trackTitle || !artistNames) {
    return null;
  }

  const trackId = String(casted.trackId ?? "").trim();
  const trackUrl = String(casted.trackUrl ?? "").trim();
  const coverUrl = String(casted.coverUrl ?? "").trim();
  const durationSecondsRaw = Number(casted.durationSeconds ?? 0);
  const safeDurationSeconds = Number.isFinite(durationSecondsRaw)
    ? Math.max(0, Math.round(durationSecondsRaw))
    : 0;
  const progressSecondsRaw = Number(casted.progressSeconds ?? 0);
  const safeProgressSeconds = Number.isFinite(progressSecondsRaw)
    ? Math.max(0, Math.round(progressSecondsRaw))
    : 0;
  const updatedAtRaw = Number(casted.updatedAt ?? 0);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now();
  const showOnProfile =
    typeof (casted as { showOnProfile?: unknown }).showOnProfile === "boolean"
      ? Boolean((casted as { showOnProfile?: unknown }).showOnProfile)
      : true;

  return {
    provider: "spotify",
    showOnProfile,
    trackId,
    trackTitle,
    artistNames,
    trackUrl,
    coverUrl,
    progressSeconds: safeDurationSeconds > 0 ? Math.min(safeProgressSeconds, safeDurationSeconds) : safeProgressSeconds,
    durationSeconds: safeDurationSeconds,
    updatedAt,
  };
}

function parsePresenceTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isPresenceNodeFresh(value: unknown, nowMs: number = Date.now()): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const updatedAtMs = parsePresenceTimestamp((value as { updatedAt?: unknown }).updatedAt);
  if (updatedAtMs == null) {
    return true;
  }

  return nowMs - updatedAtMs <= DM_PRESENCE_DEVICE_STALE_MS;
}

function isSpotifyActivityFresh(
  activity: PresenceSpotifyActivity | null | undefined,
  nowMs: number = Date.now(),
): activity is PresenceSpotifyActivity {
  if (!activity) {
    return false;
  }

  const updatedAtMs = parsePresenceTimestamp(activity.updatedAt);
  if (updatedAtMs == null) {
    return false;
  }

  const durationSeconds = Math.max(0, Number(activity.durationSeconds ?? 0));
  const progressSeconds = Math.max(0, Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, Number(activity.progressSeconds ?? 0)));
  const projectedEndMs =
    durationSeconds > 0
      ? updatedAtMs + Math.max(0, durationSeconds - progressSeconds) * 1000 + DM_SPOTIFY_ACTIVITY_END_GRACE_MS
      : updatedAtMs + DM_SPOTIFY_ACTIVITY_NO_DURATION_STALE_MS;

  return nowMs <= projectedEndMs;
}

function areSpotifyActivitiesEqual(
  left: PresenceSpotifyActivity | null,
  right: PresenceSpotifyActivity | null,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.provider === right.provider &&
    (left.showOnProfile ?? true) === (right.showOnProfile ?? true) &&
    left.trackId === right.trackId &&
    left.trackTitle === right.trackTitle &&
    left.artistNames === right.artistNames &&
    left.trackUrl === right.trackUrl &&
    left.coverUrl === right.coverUrl &&
    left.progressSeconds === right.progressSeconds &&
    left.durationSeconds === right.durationSeconds
  );
}

function resolvePresenceSnapshotFromRealtimeNode(
  value: unknown,
): { presenceState: PresenceState; spotifyActivity: PresenceSpotifyActivity | null } {
  if (!value || typeof value !== "object") {
    return { presenceState: "invisivel", spotifyActivity: null };
  }

  const nowMs = Date.now();

  const directStateRaw = (value as { state?: unknown }).state;
  if (directStateRaw !== undefined) {
    const directPresenceState = normalizePresenceState(directStateRaw);
    const directActivityRaw = normalizePresenceSpotifyActivity((value as { activity?: unknown }).activity ?? null);
    return {
      presenceState: isPresenceNodeFresh(value, nowMs) ? directPresenceState : "invisivel",
      spotifyActivity:
        directPresenceState === "invisivel" || !isSpotifyActivityFresh(directActivityRaw, nowMs)
          ? null
          : directActivityRaw,
    };
  }

  const devices = Object.values(value as Record<string, unknown>);
  let hasIdle = false;
  let hasOnline = false;
  let hasDnd = false;
  let bestSpotifyActivity: PresenceSpotifyActivity | null = null;

  for (const device of devices) {
    if (!isPresenceNodeFresh(device, nowMs)) {
      continue;
    }
    const state = normalizePresenceState((device as { state?: unknown } | null)?.state ?? null);
    if (state === "dnd") {
      hasDnd = true;
    }
    if (state === "online") {
      hasOnline = true;
    } else if (state === "idle") {
      hasIdle = true;
    }

    const candidateActivityRaw = normalizePresenceSpotifyActivity(
      (device as { activity?: unknown } | null)?.activity ?? null,
    );
    const candidateActivity = isSpotifyActivityFresh(candidateActivityRaw, nowMs) ? candidateActivityRaw : null;
    if (!candidateActivity || state === "invisivel") {
      continue;
    }

    if (!bestSpotifyActivity || candidateActivity.updatedAt > bestSpotifyActivity.updatedAt) {
      bestSpotifyActivity = candidateActivity;
    }
  }

  const resolvedPresenceState: PresenceState = hasDnd
    ? "dnd"
    : hasOnline
      ? "online"
      : hasIdle
        ? "idle"
        : "invisivel";

  if (resolvedPresenceState === "invisivel") {
    return {
      presenceState: resolvedPresenceState,
      spotifyActivity: null,
    };
  }

  if (hasOnline) {
    return {
      presenceState: resolvedPresenceState,
      spotifyActivity: bestSpotifyActivity,
    };
  }
  return {
    presenceState: resolvedPresenceState,
    spotifyActivity: bestSpotifyActivity,
  };
}

function isFriendRequestsUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: string; message?: string; details?: string };
  const code = String(candidate.code ?? "").trim().toLowerCase();
  const message = String(candidate.message ?? "").toLowerCase();
  const details = String(candidate.details ?? "").toLowerCase();
  return (
    candidate.code === "42P01" ||
    candidate.code === "PGRST205" ||
    code === "not_found" ||
    code === "function_not_found" ||
    message.includes("could not find the table") ||
    details.includes("could not find the table") ||
    message.includes("function was not found") ||
    message.includes("requested function was not found")
  );
}

async function loadLegacyAvatarMap(userIds: string[]): Promise<Map<string, string>> {
  return new Map();
}

async function ensureDirectConversation(userA: string, userB: string): Promise<void> {
  const user1Id = userA < userB ? userA : userB;
  const user2Id = userA < userB ? userB : userA;

  const { data: existingConversation, error: existingError } = await supabase
    .from("conversations")
    .select("id")
    .eq("user1_id", user1Id)
    .eq("user2_id", user2Id)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingConversation?.id) {
    return;
  }

  const { error: createError } = await supabase.from("conversations").insert({
    user1_id: user1Id,
    user2_id: user2Id,
  });

  if (createError && createError.code !== "23505") {
    throw createError;
  }
}

const DEFAULT_IDENTITY: SidebarIdentity = {
  userId: null,
  displayName: "Usuário",
  username: "usuario",
  about: "",
  bannerColor: null,
  themePrimaryColor: null,
  themeAccentColor: null,
  avatarKey: null,
  avatarHash: null,
  avatarUrl: null,
  bannerKey: null,
  bannerHash: null,
};

const USER_PROFILE_SELECT_COLUMNS =
  "id,username,display_name,email,avatar_url,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,about:bio,firebase_uid:id,created_at,updated_at";

async function queryUserById(userId: string) {
  return supabase.from("profiles").select(USER_PROFILE_SELECT_COLUMNS).eq("id", userId).limit(1).maybeSingle();
}

async function queryUserByFirebaseUid(firebaseUid: string) {
  return supabase.from("profiles").select(USER_PROFILE_SELECT_COLUMNS).eq("id", firebaseUid).limit(1).maybeSingle();
}

function deriveFallbackUsername(seed: string | null | undefined): string {
  const normalized = String(seed ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "";
  }
  if (normalized.length >= 3) {
    return normalized.slice(0, 20);
  }
  return `${normalized}user`.slice(0, 20);
}

function buildIdentityFromSession(displayName: string | null | undefined, firebaseUid: string | null | undefined): SidebarIdentity {
  const pendingProfile =
    typeof window === "undefined"
      ? null
      : (() => {
          try {
            return loadPendingProfile();
          } catch {
            return null;
          }
        })();
  const pendingForCurrentUser =
    pendingProfile && pendingProfile.firebaseUid === String(firebaseUid ?? "").trim() ? pendingProfile : null;

  const uidSeed = String(firebaseUid ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  const resolvedUsername =
    deriveFallbackUsername(pendingForCurrentUser?.username) ||
    deriveFallbackUsername(uidSeed ? `user_${uidSeed}` : "") ||
    DEFAULT_IDENTITY.username;
  const resolvedDisplayName =
    String(pendingForCurrentUser?.displayName ?? "").trim() ||
    String(displayName ?? "").trim() ||
    resolvedUsername ||
    DEFAULT_IDENTITY.displayName;

  return {
    userId: null,
    displayName: resolvedDisplayName,
    username: resolvedUsername,
    about: "",
    bannerColor: null,
    themePrimaryColor: null,
    themeAccentColor: null,
    avatarKey: null,
    avatarHash: null,
    avatarUrl: null,
    bannerKey: null,
    bannerHash: null,
  };
}

export default function DirectMessagesSidebar({
  currentUserId,
  isWindowFocused = true,
  presenceState,
  onChangePresence,
  onOpenSettings,
  activeConversationId = null,
  onSelectDirectMessage,
  onOpenFriends,
  onDirectMessagesChange,
}: DirectMessagesSidebarProps) {
  const dispatch = useAppDispatch();
  const { user, authReady, session } = useAuthSession();
  const sessionUid = user?.uid ?? null;
  const initialDirectMessagesCacheOwnerId = useMemo(
    () =>
      String(currentUserId ?? "").trim() ||
      String(readSidebarIdentityCache(sessionUid)?.userId ?? "").trim() ||
      null,
    [currentUserId, sessionUid],
  );
  const canPreloadMessages = authReady && Boolean(user?.uid) && Boolean(session?.access_token);
  const [identity, setIdentity] = useState<SidebarIdentity>(() => {
    const base = buildIdentityFromSession(user?.displayName, sessionUid);
    const cached = readSidebarIdentityCache(sessionUid);
    if (!cached) {
      return base;
    }
    const resolvedUsername = normalizeIdentityUsername(cached.username || base.username);
    const resolvedDisplayName = normalizeIdentityDisplayName(cached.displayName, resolvedUsername, base.displayName);
    return {
      ...base,
      userId: cached.userId ?? base.userId,
      displayName: resolvedDisplayName,
      username: resolvedUsername,
      about: String(cached.about ?? ""),
      bannerColor: normalizeBannerColor(cached.bannerColor) ?? null,
      themePrimaryColor: normalizeBannerColor(cached.themePrimaryColor) ?? null,
      themeAccentColor: normalizeBannerColor(cached.themeAccentColor) ?? null,
      avatarKey: cached.avatarKey,
      avatarHash: cached.avatarHash,
      avatarUrl: cached.avatarUrl,
      bannerKey: cached.bannerKey,
      bannerHash: cached.bannerHash,
    };
  });
  const [avatarSrc, setAvatarSrc] = useState<string>(() => {
    const cached = readSidebarResolvedMediaCache(sessionUid);
    return cached?.avatarSrc || getDmDisplayAvatar(identity.displayName, identity.username, identity.userId);
  });
  const [bannerSrc, setBannerSrc] = useState<string>(() => {
    const cached = readSidebarResolvedMediaCache(sessionUid);
    return cached?.bannerSrc || getDefaultBannerUrl();
  });
  const [isAddFriendModalOpen, setIsAddFriendModalOpen] = useState(false);
  const [friendIdentifier, setFriendIdentifier] = useState("");
  const [isAddingFriend, setIsAddingFriend] = useState(false);
  const [addFriendFeedback, setAddFriendFeedback] = useState<AddFriendFeedbackState | null>(null);
  const [friendRequestBlockedNotice, setFriendRequestBlockedNotice] = useState<FriendRequestBlockedNoticeDetail | null>(null);
  const [isFriendRequestsAvailable, setIsFriendRequestsAvailable] = useState(friendRequestsEnabled);
  const [isIdentityLoaded, setIsIdentityLoaded] = useState(false);
  const [directMessages, setDirectMessages] = useState<DirectMessageItem[]>(() => {
    if (!initialDirectMessagesCacheOwnerId) {
      return [];
    }

    return readDirectMessagesCache(initialDirectMessagesCacheOwnerId) ?? [];
  });
  const directMessagesRef = useRef<DirectMessageItem[]>(directMessages);
  const [dmContextMenu, setDmContextMenu] = useState<DirectMessageContextMenuState | null>(null);
  const dmItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dmItemPositionsRef = useRef<Map<string, number>>(new Map());
  const [hiddenDmConversationIds, setHiddenDmConversationIds] = useState<string[]>([]);
  const [isHiddenDmStateHydrated, setIsHiddenDmStateHydrated] = useState(false);
  const hiddenDmStorageCandidates = useMemo(
    () => buildHiddenDirectMessageStorageScopes(identity.userId, currentUserId, sessionUid),
    [currentUserId, identity.userId, sessionUid],
  );
  const effectiveIdentityUserId = useMemo(() => {
    const preferredUserId = String(currentUserId ?? "").trim();
    if (preferredUserId) {
      return preferredUserId;
    }

    const identityUserId = String(identity.userId ?? "").trim();
    return identityUserId || null;
  }, [currentUserId, identity.userId]);
  const conversationEntities = useAppSelector((state) => state.conversations.entities);
  const unreadCountsByConversationId = useMemo(() => {
    const next = new Map<string, number>();
    Object.entries(conversationEntities).forEach(([conversationId, conversation]) => {
      if (!conversation) {
        return;
      }
      next.set(conversationId, Math.max(0, Math.floor(Number(conversation.unreadCount ?? 0))));
    });
    return next;
  }, [conversationEntities]);

  // Recarrega DMs ocultas ao trocar de usuário.
  useEffect(() => {
    directMessagesRef.current = directMessages;
  }, [directMessages]);

  useEffect(() => {
    if (!effectiveIdentityUserId) {
      return;
    }

    writeFavoriteDirectMessageConversationIds(
      effectiveIdentityUserId,
      directMessages.filter((item) => item.isFavorite).map((item) => item.conversationId),
    );
  }, [directMessages, effectiveIdentityUserId]);

  useEffect(() => {
    let cancelled = false;
    setIsHiddenDmStateHydrated(false);

    if (hiddenDmStorageCandidates.length === 0) {
      setHiddenDmConversationIds((current) => (current.length === 0 ? current : []));
      setIsHiddenDmStateHydrated(true);
      return;
    }

    void readHiddenDirectMessageConversationIds(hiddenDmStorageCandidates)
      .then((nextHiddenIds) => {
        if (cancelled) {
          return;
        }

        setHiddenDmConversationIds((current) =>
          areHiddenDmConversationIdsEqual(current, nextHiddenIds) ? current : nextHiddenIds,
        );
        setIsHiddenDmStateHydrated(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHiddenDmConversationIds((current) => (current.length === 0 ? current : []));
        setIsHiddenDmStateHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [hiddenDmStorageCandidates]);

  // Persiste DMs ocultas.
  useEffect(() => {
    if (!isHiddenDmStateHydrated || hiddenDmStorageCandidates.length === 0) {
      return;
    }

    void persistHiddenDirectMessageConversationIds(hiddenDmConversationIds, hiddenDmStorageCandidates)
      .then((persistedIds) => {
        setHiddenDmConversationIds((current) =>
          areHiddenDmConversationIdsEqual(current, persistedIds) ? current : persistedIds,
        );
      })
      .catch(() => undefined);
  }, [hiddenDmConversationIds, hiddenDmStorageCandidates, isHiddenDmStateHydrated]);

  // Recarrega DMs ocultas ao trocar de usuário.

  // Persiste DMs ocultas.

  // Cria a conversa automaticamente quando um pedido de amizade é aceito (realtime).
  useEffect(() => {
    const uid = identity.userId;
    if (!uid) {
      return;
    }

    const channel = supabase
      .channel(`realtime:friend-requests:${uid}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "friend_requests" },
        async (payload) => {
          const eventType = String(payload?.eventType ?? "").toUpperCase();
          const row = (payload?.new ?? {}) as FriendRequestRow;
          const status = String(row.status ?? "").trim().toLowerCase();
          const requesterId = String(row.requester_id ?? "").trim();
          const addresseeId = String(row.addressee_id ?? "").trim();
          if (requesterId !== uid && addresseeId !== uid) {
            return;
          }
          const otherId = requesterId === uid ? addresseeId : requesterId;
          if (!otherId) {
            return;
          }

          // Se o request foi aceito, garante que a conversa exista.
          if (status === "accepted") {
            try {
              await ensureDirectConversation(uid, otherId);
            } catch {
              // silencioso: erros já são tratados no fluxo de conversa
            }
            return;
          }

          // Se a amizade foi desfeita (DELETE) ou voltou a não-aceita, removemos o card da DM.
          if (eventType === "DELETE" || status !== "accepted") {
            setDirectMessages((current) => current.filter((dm) => dm.userId !== otherId));
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [identity.userId]);

  const handleConversationMessageInsert = useCallback((event: ConversationMessageInsertEvent): void => {
    const normalizedCurrentUserId = String(effectiveIdentityUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      return;
    }

    const authorId = String(event.authorId ?? "").trim();
    if (!authorId || authorId === normalizedCurrentUserId) {
      return;
    }

    const conversationId = String(event.conversationId ?? "").trim();
    const messageId = String(event.messageId ?? "").trim();
    if (!conversationId || !messageId) {
      return;
    }

    const relatedDirectMessage =
      directMessagesRef.current.find((item) => item.conversationId === conversationId) ??
      directMessagesRef.current.find((item) => item.userId === authorId) ??
      null;
    const authorName =
      String(relatedDirectMessage?.displayName ?? "").trim() ||
      String(relatedDirectMessage?.username ?? "").trim() ||
      "Nova mensagem";
    const avatarUrl = String(relatedDirectMessage?.avatarSrc ?? "").trim() || null;

    dispatch(
      notificationsActions.notificationQueued({
        id: createClientNonce("notification"),
        eventId: messageId,
        source: "realtime",
        type: "message",
        conversationId,
        messageId,
        authorId,
        title: authorName,
        body: String(event.contentPreview ?? "").trim(),
        avatarUrl,
        conversationType: "dm",
        contextLabel: null,
        messageType: event.messageType ?? null,
        attachmentMimeType: event.attachmentMimeType ?? null,
        attachmentCount: event.attachmentCount,
        muted: false,
        createdAt: String(event.createdAt ?? "").trim() || new Date().toISOString(),
        deliveredAt: null,
      }),
    );

    if (import.meta.env.DEV) {
      console.debug("[notifications:realtime-fallback] queued", {
        conversationId,
        messageId,
        authorId,
      });
    }
  }, [dispatch, effectiveIdentityUserId]);

  const conversationsQuery = useConversationsRealtime(effectiveIdentityUserId, {
    onMessageInsert: handleConversationMessageInsert,
  });
  const realtimeConversations = useMemo(
    () => (conversationsQuery.data ?? []) as ConversationRow[],
    [conversationsQuery.data],
  );
  const hoverPreloadTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const normalizedActiveConversationId = String(activeConversationId ?? "").trim();
    if (!normalizedActiveConversationId) {
      return;
    }

    setHiddenDmConversationIds((current) =>
      current.includes(normalizedActiveConversationId)
        ? current.filter((conversationId) => conversationId !== normalizedActiveConversationId)
        : current,
    );
  }, [activeConversationId, directMessages]);

  const effectiveIdentityBannerColor = useMemo(() => {
    if (!isIdentityLoaded) {
      return null;
    }
    const hasBannerImageSource = Boolean(String(identity.bannerKey ?? "").trim() || String(identity.bannerHash ?? "").trim());
    if (hasBannerImageSource && isDefaultBannerUrl(String(bannerSrc ?? "").trim())) {
      return null;
    }
    return identity.bannerColor;
  }, [bannerSrc, identity.bannerColor, identity.bannerHash, identity.bannerKey, isIdentityLoaded]);

  useEffect(() => {
    const handleFriendRequestBlocked = (event: Event): void => {
      const detail = (event as CustomEvent<FriendRequestBlockedNoticeDetail>).detail;
      if (!detail) {
        return;
      }
      setFriendRequestBlockedNotice(detail);
    };

    window.addEventListener(FRIEND_REQUEST_BLOCKED_EVENT, handleFriendRequestBlocked);
    return () => {
      window.removeEventListener(FRIEND_REQUEST_BLOCKED_EVENT, handleFriendRequestBlocked);
    };
  }, []);

  const scheduleConversationPreload = useCallback((conversationId: string): void => {
    if (!canPreloadMessages) {
      return;
    }

    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    const timers = hoverPreloadTimersRef.current;
    const existingTimer = timers.get(normalizedConversationId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timerId = window.setTimeout(() => {
      timers.delete(normalizedConversationId);
      void preloadChatMessages({
        conversationId: normalizedConversationId,
        limit: DM_PRELOAD_LIMIT,
        maxAgeMs: DM_PRELOAD_MAX_AGE_MS,
      });
    }, DM_PRELOAD_HOVER_DEBOUNCE_MS);

    timers.set(normalizedConversationId, timerId);
  }, [canPreloadMessages]);

  const cancelConversationPreload = useCallback((conversationId: string): void => {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    const timers = hoverPreloadTimersRef.current;
    const existingTimer = timers.get(normalizedConversationId);
    if (!existingTimer) {
      return;
    }

    window.clearTimeout(existingTimer);
    timers.delete(normalizedConversationId);
  }, []);

  useEffect(() => {
    const base = buildIdentityFromSession(user?.displayName, sessionUid);
    const cached = readSidebarIdentityCache(sessionUid);
    if (!cached) {
      setIdentity(base);
      return;
    }
    const resolvedUsername = normalizeIdentityUsername(cached.username || base.username);
    const resolvedDisplayName = normalizeIdentityDisplayName(cached.displayName, resolvedUsername, base.displayName);

    setIdentity({
      ...base,
      userId: cached.userId ?? base.userId,
      displayName: resolvedDisplayName,
      username: resolvedUsername,
      about: String(cached.about ?? ""),
      bannerColor: normalizeBannerColor(cached.bannerColor) ?? null,
      themePrimaryColor: normalizeBannerColor(cached.themePrimaryColor) ?? null,
      themeAccentColor: normalizeBannerColor(cached.themeAccentColor) ?? null,
      avatarKey: cached.avatarKey,
      avatarHash: cached.avatarHash,
      avatarUrl: cached.avatarUrl,
      bannerKey: cached.bannerKey,
      bannerHash: cached.bannerHash,
    });
  }, [sessionUid, user?.displayName]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }
    setIdentity((current) =>
      current.userId === currentUserId
        ? current
        : {
            ...current,
            userId: currentUserId,
          },
    );
  }, [currentUserId]);

  useEffect(() => {
    const cached = readSidebarResolvedMediaCache(sessionUid);
    if (cached) {
      setAvatarSrc(cached.avatarSrc);
      setBannerSrc(cached.bannerSrc);
      return;
    }
    setAvatarSrc(getDmDisplayAvatar(identity.displayName, identity.username, identity.userId || sessionUid));
    setBannerSrc(getDefaultBannerUrl());
  }, [identity.displayName, identity.userId, identity.username, sessionUid]);

  useEffect(() => {
    const firebaseUid = sessionUid;
    if (!firebaseUid) {
      return;
    }

    const shouldPersist =
      Boolean(identity.userId) ||
      identity.displayName !== DEFAULT_IDENTITY.displayName ||
      identity.username !== DEFAULT_IDENTITY.username ||
      Boolean(identity.about) ||
      Boolean(identity.bannerColor) ||
      Boolean(identity.themePrimaryColor) ||
      Boolean(identity.themeAccentColor) ||
      Boolean(identity.avatarKey) ||
      Boolean(identity.avatarHash) ||
      Boolean(identity.bannerKey) ||
      Boolean(identity.bannerHash);

    if (!shouldPersist) {
      return;
    }

    writeSidebarIdentityCache(firebaseUid, identity);
  }, [identity, sessionUid]);

  useEffect(() => {
    const firebaseUid = sessionUid;
    const preferredUserId = currentUserId;
    if (!firebaseUid && !preferredUserId) {
      setIsIdentityLoaded(false);
      return;
    }
    const stableFirebaseUid = firebaseUid ?? null;
    const stablePreferredUserId = preferredUserId ?? null;

    let isMounted = true;
    setIsIdentityLoaded(false);

    async function loadIdentityFromDatabase(): Promise<void> {
      try {
        let data:
          | {
              id?: string | null;
              display_name?: string | null;
              username?: string | null;
              about?: string | null;
              banner_color?: string | null;
              profile_theme_primary_color?: string | null;
              profile_theme_accent_color?: string | null;
              avatar_key?: string | null;
              avatar_hash?: string | null;
              avatar_url?: string | null;
              banner_key?: string | null;
              banner_hash?: string | null;
              spotify_connection?: unknown | null;
            }
          | null = null;

        if (stablePreferredUserId) {
          const byIdResult = await queryUserById(stablePreferredUserId);
          if (byIdResult.error) {
            return;
          }
          data = byIdResult.data as typeof data;
        }

        if (!isMounted) {
          return;
        }

        if (!data && stableFirebaseUid) {
          const byUidResult = await queryUserByFirebaseUid(stableFirebaseUid);
          if (byUidResult.error) {
            return;
          }
          data = byUidResult.data as typeof data;
        }

        if (!data) {
          return;
        }
        const row = data as {
          id?: string | null;
          display_name?: string | null;
          username?: string | null;
          about?: string | null;
          banner_color?: string | null;
          profile_theme_primary_color?: string | null;
          profile_theme_accent_color?: string | null;
          avatar_key?: string | null;
          avatar_hash?: string | null;
          avatar_url?: string | null;
          banner_key?: string | null;
          banner_hash?: string | null;
          spotify_connection?: unknown | null;
        };
        if (Object.prototype.hasOwnProperty.call(row, "spotify_connection")) {
          hydrateSpotifyConnectionFromProfile(row.id ?? stablePreferredUserId ?? stableFirebaseUid, row.spotify_connection ?? null);
        }

        const resolvedUsername = normalizeIdentityUsername(row.username);
        const fallbackDisplayName = (user?.displayName ?? "").trim();
        const resolvedDisplayName = normalizeIdentityDisplayName(row.display_name, resolvedUsername, fallbackDisplayName);

        setIdentity((current) => ({
          userId: row.id ?? current.userId,
          displayName: resolvedDisplayName || current.displayName,
          username: resolvedUsername || current.username,
          about: String(row.about ?? "").trim(),
          bannerColor: normalizeBannerColor(row.banner_color) ?? null,
          themePrimaryColor: normalizeBannerColor(row.profile_theme_primary_color) ?? null,
          themeAccentColor: normalizeBannerColor(row.profile_theme_accent_color) ?? null,
          avatarKey: (row.avatar_key ?? "").trim() || null,
          avatarHash: (row.avatar_hash ?? "").trim() || null,
          avatarUrl: (row.avatar_url ?? "").trim() || null,
          bannerKey: (row.banner_key ?? "").trim() || null,
          bannerHash: (row.banner_hash ?? "").trim() || null,
        }));
      } finally {
        if (isMounted) {
          setIsIdentityLoaded(true);
        }
      }
    }

    void loadIdentityFromDatabase();

    return () => {
      isMounted = false;
    };
  }, [currentUserId, sessionUid, user?.displayName]);

  useEffect(() => {
    const handleProfileMediaUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileMediaUpdatedDetail>).detail;
      if (!detail?.userId) {
        return;
      }

      const avatarKeyTouched = Object.prototype.hasOwnProperty.call(detail, "avatar_key");
      const avatarHashTouched = Object.prototype.hasOwnProperty.call(detail, "avatar_hash");
      const avatarUrlTouched = Object.prototype.hasOwnProperty.call(detail, "avatar_url");
      const avatarRemoved =
        (avatarKeyTouched && detail.avatar_key == null) || (avatarUrlTouched && detail.avatar_url == null);
      const isIdentityMediaUpdate = String(identity.userId ?? "").trim() === detail.userId;

      setIdentity((current) => {
        if (!current.userId || current.userId !== detail.userId) {
          return current;
        }

        const next: SidebarIdentity = { ...current };

        if (Object.prototype.hasOwnProperty.call(detail, "avatar_key")) {
          next.avatarKey = detail.avatar_key ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "avatar_hash")) {
          next.avatarHash = detail.avatar_hash ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(detail, "avatar_url")) {
          next.avatarUrl = detail.avatar_url ?? null;
        }
        if ((avatarKeyTouched && detail.avatar_key == null) || (avatarUrlTouched && detail.avatar_url == null)) {
          next.avatarUrl = null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "banner_key")) {
          next.bannerKey = detail.banner_key ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "banner_hash")) {
          next.bannerHash = detail.banner_hash ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "banner_color")) {
          next.bannerColor = normalizeBannerColor(detail.banner_color) ?? null;
        }

        return next;
      });

      if (avatarRemoved && isIdentityMediaUpdate) {
        setAvatarSrc((current) => {
          const fallbackAvatar = getDmDisplayAvatar(
            identity.displayName,
            identity.username,
            identity.userId || sessionUid,
          );
          return current === fallbackAvatar ? current : fallbackAvatar;
        });
      }

      if (avatarKeyTouched || avatarHashTouched || avatarUrlTouched) {
        setDirectMessages((current) => {
          let changed = false;
          const nextItems = current.map((item) => {
            if (item.userId !== detail.userId) {
              return item;
            }

            if (!avatarRemoved) {
              return item;
            }

            const fallbackAvatar = getDmDisplayAvatar(item.displayName, item.username, item.userId);
            if (item.avatarSrc === fallbackAvatar) {
              return item;
            }

            changed = true;
            return {
              ...item,
              avatarSrc: fallbackAvatar,
            };
          });

          if (!changed) {
            return current;
          }
          if (identity.userId) {
            writeDirectMessagesCache(identity.userId, nextItems);
          }
          return nextItems;
        });

        if (!avatarRemoved && (avatarKeyTouched || avatarUrlTouched)) {
          const nextAvatarSource = avatarKeyTouched
            ? String(detail.avatar_key ?? "").trim() || null
            : (avatarUrlTouched ? String(detail.avatar_url ?? "").trim() || null : null);
          const nextAvatarHash = avatarHashTouched ? String(detail.avatar_hash ?? "").trim() || null : null;

          void getAvatarUrl(detail.userId, nextAvatarSource, nextAvatarHash).then((resolvedAvatar) => {
            const normalizedAvatar = String(resolvedAvatar ?? "").trim();
            setDirectMessages((current) => {
              let changed = false;
              const nextItems = current.map((item) => {
                if (item.userId !== detail.userId) {
                  return item;
                }

                const fallbackAvatar = getDmDisplayAvatar(item.displayName, item.username, item.userId);
                const targetAvatar = normalizedAvatar || fallbackAvatar;
                if (item.avatarSrc === targetAvatar) {
                  return item;
                }

                changed = true;
                return {
                  ...item,
                  avatarSrc: targetAvatar,
                };
              });

              if (!changed) {
                return current;
              }
              if (identity.userId) {
                writeDirectMessagesCache(identity.userId, nextItems);
              }
              return nextItems;
            });
          }).catch(() => undefined);
        }
      }

      const bannerKeyTouched = Object.prototype.hasOwnProperty.call(detail, "banner_key");
      const bannerHashTouched = Object.prototype.hasOwnProperty.call(detail, "banner_hash");
      const bannerRemoved =
        (bannerKeyTouched && detail.banner_key == null) || (bannerHashTouched && detail.banner_hash == null);

      if (bannerRemoved) {
        setBannerSrc(getDefaultBannerUrl());
      }
    };

    window.addEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    };
  }, [identity.displayName, identity.userId, identity.username, sessionUid]);

  useEffect(() => {
    const handleProfileUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileUpdatedDetail>).detail;
      if (!detail?.userId) {
        return;
      }

      setIdentity((current) => {
        if (!current.userId || current.userId !== detail.userId) {
          return current;
        }

        const nextUsername = normalizeIdentityUsername(detail.username ?? current.username);
        const nextDisplayName = normalizeIdentityDisplayName(
          detail.display_name ?? current.displayName,
          nextUsername,
          current.displayName,
        );
        const nextAbout = String(detail.about ?? current.about);
        const nextBannerColor = Object.prototype.hasOwnProperty.call(detail, "banner_color")
          ? normalizeBannerColor(detail.banner_color) ?? null
          : current.bannerColor;
        const nextThemePrimaryColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_primary_color")
          ? normalizeBannerColor(detail.profile_theme_primary_color) ?? null
          : current.themePrimaryColor;
        const nextThemeAccentColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_accent_color")
          ? normalizeBannerColor(detail.profile_theme_accent_color) ?? null
          : current.themeAccentColor;

        if (
          current.username === nextUsername &&
          current.displayName === nextDisplayName &&
          current.about === nextAbout &&
          current.bannerColor === nextBannerColor &&
          current.themePrimaryColor === nextThemePrimaryColor &&
          current.themeAccentColor === nextThemeAccentColor
        ) {
          return current;
        }

        return {
          ...current,
          username: nextUsername,
          displayName: nextDisplayName,
          about: nextAbout,
          bannerColor: nextBannerColor,
          themePrimaryColor: nextThemePrimaryColor,
          themeAccentColor: nextThemeAccentColor,
        };
      });

      setDirectMessages((current) => {
        let changed = false;
        const updated = current.map((item) => {
          if (item.userId !== detail.userId) {
            return item;
          }

          const nextUsername = normalizeIdentityUsername(detail.username ?? item.username);
          const nextDisplayName = normalizeIdentityDisplayName(detail.display_name ?? item.displayName, nextUsername, item.displayName);
          const nextAbout = Object.prototype.hasOwnProperty.call(detail, "about")
            ? String(detail.about ?? "").trim()
            : (item.aboutText ?? "");
          const nextBannerColor = Object.prototype.hasOwnProperty.call(detail, "banner_color")
            ? normalizeBannerColor(detail.banner_color) ?? null
            : item.bannerColor ?? null;
          const nextThemePrimaryColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_primary_color")
            ? normalizeBannerColor(detail.profile_theme_primary_color) ?? null
            : item.themePrimaryColor ?? null;
          const nextThemeAccentColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_accent_color")
            ? normalizeBannerColor(detail.profile_theme_accent_color) ?? null
            : item.themeAccentColor ?? null;

          if (
            item.username === nextUsername &&
            item.displayName === nextDisplayName &&
            (item.aboutText ?? "") === nextAbout &&
            (item.bannerColor ?? null) === nextBannerColor &&
            (item.themePrimaryColor ?? null) === nextThemePrimaryColor &&
            (item.themeAccentColor ?? null) === nextThemeAccentColor
          ) {
            return item;
          }

          changed = true;
          return {
            ...item,
            username: nextUsername,
            displayName: nextDisplayName,
            aboutText: nextAbout,
            bannerColor: nextBannerColor,
            themePrimaryColor: nextThemePrimaryColor,
            themeAccentColor: nextThemeAccentColor,
          };
        });

        if (!changed) {
          return current;
        }
        if (identity.userId) {
          writeDirectMessagesCache(identity.userId, updated);
        }
        return updated;
      });

    };

    window.addEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    };
  }, [identity.userId]);

  useEffect(() => {
    let isMounted = true;

    const avatarSource = identity.avatarKey ?? identity.avatarUrl;
    const hasAvatarSource = Boolean(String(avatarSource ?? "").trim());
    void getAvatarUrl(identity.userId, avatarSource, identity.avatarHash).then((url) => {
      if (isMounted) {
        const resolvedUrl =
          String(url ?? "").trim() || getDmDisplayAvatar(identity.displayName, identity.username, identity.userId || sessionUid);
        setAvatarSrc((current) => {
          if (current === resolvedUrl) {
            return current;
          }
          // Keep the last valid avatar while refreshing signed URLs.
          if (hasAvatarSource && isDefaultAvatarUrl(resolvedUrl) && !isDefaultAvatarUrl(current)) {
            return current;
          }
          return resolvedUrl;
        });
      }
    });

    return () => {
      isMounted = false;
    };
  }, [identity.avatarHash, identity.avatarKey, identity.avatarUrl, identity.displayName, identity.userId, identity.username, sessionUid]);

  useEffect(() => {
    let isMounted = true;
    const defaultBannerSrc = getDefaultBannerUrl();
    const hasBannerSource = Boolean(String(identity.bannerKey ?? "").trim());

    void getBannerUrl(identity.userId, identity.bannerKey, identity.bannerHash).then((url) => {
      if (isMounted) {
        const resolvedUrl = String(url ?? "").trim() || defaultBannerSrc;
        setBannerSrc((current) => {
          if (current === resolvedUrl) {
            return current;
          }
          if (hasBannerSource && resolvedUrl === defaultBannerSrc && current !== defaultBannerSrc) {
            return current;
          }
          return resolvedUrl;
        });
      }
    });

    return () => {
      isMounted = false;
    };
  }, [identity.bannerHash, identity.bannerKey, identity.userId]);

  useEffect(() => {
    const firebaseUid = sessionUid;
    if (!firebaseUid) {
      return;
    }
    writeSidebarResolvedMediaCache(firebaseUid, avatarSrc, bannerSrc);
  }, [avatarSrc, bannerSrc, sessionUid]);

  useEffect(() => {
    const currentUserId = effectiveIdentityUserId;
    if (!currentUserId) {
      setDirectMessages((current) => (current.length === 0 ? current : []));
      return;
    }
    const resolvedCurrentUserId = currentUserId;
    if (conversationsQuery.error) {
      return;
    }

    const cachedDirectMessages = readDirectMessagesCache(resolvedCurrentUserId);
    if (cachedDirectMessages && cachedDirectMessages.length > 0) {
      setDirectMessages((current) =>
        areDirectMessageListsEqual(current, cachedDirectMessages) ? current : cachedDirectMessages,
      );
    } else {
      setDirectMessages((current) => (current.length === 0 ? current : []));
    }

    if (conversationsQuery.isLoading && !conversationsQuery.data) {
      return;
    }

    let isMounted = true;
    let loadInFlight = false;
    let hasQueuedLoad = false;

    async function loadDirectMessages(rows: ConversationRow[]): Promise<void> {
      if (!isMounted) {
        return;
      }

      if (rows.length === 0) {
        setDirectMessages((current) => (current.length === 0 ? current : []));
        writeFavoriteDirectMessageConversationIds(resolvedCurrentUserId, []);
        writeDirectMessagesCache(resolvedCurrentUserId, []);
        return;
      }

      const favoriteConversationIdSet = new Set(readFavoriteDirectMessageConversationIds(resolvedCurrentUserId));
      const activityState = applyConversationActivityToDirectMessages(
        directMessagesRef.current,
        rows,
        resolvedCurrentUserId,
      );

      if (activityState.missingRows.length === 0) {
        if (activityState.changed) {
          setDirectMessages((current) => {
            const mergedItems = mergeDirectMessagesWithoutAvatarDowngrade(current, activityState.nextItems);
            if (areDirectMessageListsEqual(current, mergedItems)) {
              return current;
            }
            writeDirectMessagesCache(resolvedCurrentUserId, mergedItems);
            return mergedItems;
          });
        }
        return;
      }

      const otherUserIds = Array.from(
        new Set(
          activityState.missingRows.map((conversation) =>
            conversation.user1_id === resolvedCurrentUserId ? conversation.user2_id : conversation.user1_id,
          ),
        ),
      );

      const { data: users, error: usersError } = await supabase
        .from("profiles")
        .select(USER_PROFILE_SELECT_COLUMNS)
        .in("id", otherUserIds);

      if (usersError || !isMounted) {
        return;
      }

      const usersById = new Map<string, DmUserRow>();
      (users ?? []).forEach((row) => {
        usersById.set(row.id, row);
      });

      // Fast first paint: names + cached avatar + cached presence.
      const initialItems = activityState.missingRows.map((conversation) => {
        const otherUserId =
          conversation.user1_id === resolvedCurrentUserId ? conversation.user2_id : conversation.user1_id;
        const targetUser = usersById.get(otherUserId);
        const username = normalizeIdentityUsername(targetUser?.username);
        const displayName = normalizeIdentityDisplayName(targetUser?.display_name, username, username);
        const aboutText = String(targetUser?.about ?? "").trim();
        const bannerColor = normalizeBannerColor(targetUser?.banner_color) ?? null;
        const themePrimaryColor = normalizeBannerColor(targetUser?.profile_theme_primary_color) ?? null;
        const themeAccentColor = normalizeBannerColor(targetUser?.profile_theme_accent_color) ?? null;
        const bannerKey = String(targetUser?.banner_key ?? "").trim() || null;
        const bannerHash = String(targetUser?.banner_hash ?? "").trim() || null;
        const memberSinceAt = String(targetUser?.created_at ?? "").trim() || null;
        const placeholderAvatar = getDmDisplayAvatar(displayName, username, otherUserId);
        const cachedAvatar = getCachedDmAvatar(otherUserId, buildDmAvatarSignature(targetUser, ""));
        const presenceSnapshot = presenceStore.getPresenceSnapshot(otherUserId);
        const basePresence = presenceSnapshot.presenceState;
        const cachedPresence = dmPresenceCache.get(otherUserId) ?? basePresence;

        return {
          conversationId: conversation.id,
          userId: otherUserId,
          username,
          displayName,
          avatarSrc: cachedAvatar ?? placeholderAvatar,
          presenceState: cachedPresence,
          lastMessageAt: normalizeActivityTimestamp(conversation.last_activity_at ?? conversation.created_at),
          isFavorite: favoriteConversationIdSet.has(conversation.id),
          spotifyActivity: presenceSnapshot.spotifyActivity ?? null,
          firebaseUid: String(targetUser?.firebase_uid ?? "").trim() || undefined,
          aboutText,
          bannerColor,
          themePrimaryColor,
          themeAccentColor,
          bannerKey,
          bannerHash,
          memberSinceAt,
        } satisfies DirectMessageItem;
      });

      const initialItemsByConversationId = new Map<string, DirectMessageItem>();
      activityState.nextItems.forEach((item) => {
        initialItemsByConversationId.set(item.conversationId, item);
      });
      initialItems.forEach((item) => {
        initialItemsByConversationId.set(item.conversationId, item);
      });
      const orderedInitialItems = rows
        .map((conversation) => initialItemsByConversationId.get(conversation.id) ?? null)
        .filter((item): item is DirectMessageItem => item !== null);

      if (isMounted) {
        setDirectMessages((current) => {
          const mergedItems = mergeDirectMessagesWithoutAvatarDowngrade(current, orderedInitialItems);
          return areDirectMessageListsEqual(current, mergedItems) ? current : mergedItems;
        });
      }

      // Warm up banner URLs for the top DMs so chat profile opens instantly.
      const warmupBannerItems = orderedInitialItems
        .slice(0, DM_PRELOAD_LIST_WARMUP_COUNT)
        .filter((item) => item.bannerKey);
      if (warmupBannerItems.length > 0) {
        void Promise.allSettled(
          warmupBannerItems.map(async (item) => {
            const bannerSrc = await getBannerUrl(item.userId, item.bannerKey ?? null, item.bannerHash ?? null);
            return [item.userId, String(bannerSrc ?? "").trim()] as const;
          }),
        ).then((entries) => {
          if (!isMounted) {
            return;
          }
          const bannerSrcByUserId = new Map<string, string>();
          entries.forEach((entry) => {
            if (entry.status !== "fulfilled") {
              return;
            }
            const [userId, bannerSrc] = entry.value;
            if (!bannerSrc) {
              return;
            }
            bannerSrcByUserId.set(userId, bannerSrc);
          });
          if (bannerSrcByUserId.size === 0) {
            return;
          }

          setDirectMessages((current) => {
            let changed = false;
            const updated = current.map((item) => {
              const warmedBannerSrc = bannerSrcByUserId.get(item.userId);
              if (!warmedBannerSrc || !item.bannerKey || item.bannerSrc === warmedBannerSrc) {
                return item;
              }
              changed = true;
              return {
                ...item,
                bannerSrc: warmedBannerSrc,
              };
            });

            if (!changed) {
              return current;
            }

            writeDirectMessagesCache(resolvedCurrentUserId, updated);
            return updated;
          });
        });
      }

      const legacyAvatarMap = await loadLegacyAvatarMap(otherUserIds);

      if (!isMounted) {
        return;
      }

      const avatarEntries = await Promise.all(
        otherUserIds.map(async (otherUserId) => {
          const targetUser = usersById.get(otherUserId);
          const username = normalizeIdentityUsername(targetUser?.username);
          const displayName = normalizeIdentityDisplayName(targetUser?.display_name, username, username);
          const legacyAvatarUrl = String(targetUser?.avatar_url ?? "").trim();
          const backupAvatarUrl = legacyAvatarMap.get(otherUserId) ?? "";
          const signature = buildDmAvatarSignature(targetUser, backupAvatarUrl);

          const cachedAvatar = getCachedDmAvatar(otherUserId, signature);
          if (cachedAvatar) {
            return [otherUserId, cachedAvatar] as const;
          }

          try {
            const primaryAvatar = await getAvatarUrl(otherUserId, targetUser?.avatar_key ?? null, targetUser?.avatar_hash ?? null);
            let resolvedAvatar = primaryAvatar;
            if (isDefaultAvatarUrl(primaryAvatar)) {
              const legacySource = legacyAvatarUrl || backupAvatarUrl;
              if (legacySource) {
                const legacyResolved = await getAvatarUrl(otherUserId, legacySource, targetUser?.avatar_hash ?? null);
                resolvedAvatar = isDefaultAvatarUrl(legacyResolved)
                  ? getDmDisplayAvatar(displayName, username, otherUserId)
                  : legacyResolved;
              } else {
                resolvedAvatar = getDmDisplayAvatar(displayName, username, otherUserId);
              }
            }

            setCachedDmAvatar(otherUserId, signature, resolvedAvatar);
            return [otherUserId, resolvedAvatar] as const;
          } catch {
            const fallbackAvatar = getDmDisplayAvatar(displayName, username, otherUserId);
            setCachedDmAvatar(otherUserId, signature, fallbackAvatar);
            return [otherUserId, fallbackAvatar] as const;
          }
        }),
      );

      if (!isMounted) {
        return;
      }

      const avatarMap = new Map<string, string>(avatarEntries);
      const presenceByUserId = new Map<string, PresenceState>();
      const spotifyActivityByUserId = new Map<string, PresenceSpotifyActivity | null>();
      usersById.forEach((targetUser, otherUserId) => {
        const presenceSnapshot = presenceStore.getPresenceSnapshot(otherUserId);
        const resolvedPresence =
          dmPresenceCache.get(otherUserId) ??
          presenceSnapshot.presenceState;
        dmPresenceCache.set(otherUserId, resolvedPresence);
        presenceByUserId.set(otherUserId, resolvedPresence);
        spotifyActivityByUserId.set(otherUserId, presenceSnapshot.spotifyActivity ?? null);
      });

      const hydratedItems = orderedInitialItems.map((item) => ({
        ...item,
        avatarSrc: avatarMap.get(item.userId) ?? item.avatarSrc,
        presenceState: presenceByUserId.get(item.userId) ?? item.presenceState,
        spotifyActivity: spotifyActivityByUserId.get(item.userId) ?? item.spotifyActivity ?? null,
      }));

      if (isMounted) {
        setDirectMessages((current) => {
          const mergedItems = mergeDirectMessagesWithoutAvatarDowngrade(current, hydratedItems);
          if (!areDirectMessageListsEqual(current, mergedItems)) {
            writeDirectMessagesCache(resolvedCurrentUserId, mergedItems);
            return mergedItems;
          }
          return current;
        });
      }
    }

    async function requestLoadDirectMessages(): Promise<void> {
      if (loadInFlight) {
        hasQueuedLoad = true;
        return;
      }

      loadInFlight = true;
      try {
        do {
          hasQueuedLoad = false;
          await loadDirectMessages(realtimeConversations);
        } while (isMounted && hasQueuedLoad);
      } finally {
        loadInFlight = false;
      }
    }

    void requestLoadDirectMessages();

    return () => {
      isMounted = false;
    };
  }, [conversationsQuery.data, conversationsQuery.error, conversationsQuery.isLoading, effectiveIdentityUserId, realtimeConversations]);

  const dmRealtimeConversationKey = useMemo(
    () =>
      Array.from(
        new Set(
          directMessages
            .map((dm) => String(dm.conversationId ?? "").trim())
            .filter((conversationId) => Boolean(conversationId)),
        ),
      )
        .sort((left, right) => left.localeCompare(right))
        .join("|"),
    [directMessages],
  );

  const dmUsersRealtimeKey = useMemo(() => {
    const userIds = new Set<string>();
    const identityUserId = String(identity.userId ?? "").trim();
    if (identityUserId) {
      userIds.add(identityUserId);
    }
    directMessages.forEach((dm) => {
      const userId = String(dm.userId ?? "").trim();
      if (userId) {
        userIds.add(userId);
      }
    });
    return Array.from(userIds).sort((left, right) => left.localeCompare(right)).join("|");
  }, [directMessages, identity.userId]);

  useEffect(() => {
    if (!dmUsersRealtimeKey) {
      return;
    }

    return presenceStore.watchUsers(dmUsersRealtimeKey.split("|"));
  }, [dmUsersRealtimeKey]);

  useEffect(() => {
    if (!dmUsersRealtimeKey) {
      return;
    }

    const applyDirectMessagePresences = (): void => {
      setDirectMessages((current) => {
        let changed = false;
        const next = current.map((dm) => {
          const nextPresenceSnapshot = presenceStore.getPresenceSnapshot(dm.userId);
          const nextPresenceState = nextPresenceSnapshot.presenceState;
          const nextSpotifyActivity = nextPresenceSnapshot.spotifyActivity ?? null;
          if (
            dm.presenceState === nextPresenceState &&
            areSpotifyActivitiesEqual(dm.spotifyActivity ?? null, nextSpotifyActivity)
          ) {
            return dm;
          }

          dmPresenceCache.set(dm.userId, nextPresenceState);
          changed = true;
          return {
            ...dm,
            presenceState: nextPresenceState,
            spotifyActivity: nextSpotifyActivity,
          };
        });

        if (!changed) {
          return current;
        }

        writeDirectMessagesCache(currentUserId, next);
        return next;
      });
    };

    applyDirectMessagePresences();
    return presenceStore.subscribe(applyDirectMessagePresences);
  }, [currentUserId, dmUsersRealtimeKey]);

  useEffect(() => {
    if (!dmUsersRealtimeKey) {
      return;
    }

    const trackedUserIds = new Set(
      dmUsersRealtimeKey
        .split("|")
        .map((userId) => String(userId ?? "").trim())
        .filter((userId) => Boolean(userId)),
    );
    if (trackedUserIds.size === 0) {
      return;
    }

    const toNullableTrimmedString = (value: unknown): string | null => {
      const normalized = String(value ?? "").trim();
      return normalized || null;
    };

    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const bootstrapTimer = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      channel = supabase
        .channel(`realtime:dm-users:${identity.userId ?? "anon"}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles" },
          (payload) => {
            const nextRow =
              payload && typeof payload.new === "object" && payload.new !== null
                ? (payload.new as Record<string, unknown>)
                : null;
            if (!nextRow) {
              return;
            }

            const rowUserId = toNullableTrimmedString(nextRow.id);
            if (!rowUserId || !trackedUserIds.has(rowUserId)) {
              return;
            }

            const profileDetail: ProfileUpdatedDetail = { userId: rowUserId };
            let hasProfilePayload = false;

            if (Object.prototype.hasOwnProperty.call(nextRow, "display_name")) {
              profileDetail.display_name = toNullableTrimmedString(nextRow.display_name);
              hasProfilePayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "username")) {
              profileDetail.username = toNullableTrimmedString(nextRow.username);
              hasProfilePayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "about")) {
              profileDetail.about = toNullableTrimmedString(nextRow.about);
              hasProfilePayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "banner_color")) {
              profileDetail.banner_color = normalizeBannerColor(toNullableTrimmedString(nextRow.banner_color)) ?? null;
              hasProfilePayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "profile_theme_primary_color")) {
              profileDetail.profile_theme_primary_color =
                normalizeBannerColor(toNullableTrimmedString(nextRow.profile_theme_primary_color)) ?? null;
              hasProfilePayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "profile_theme_accent_color")) {
              profileDetail.profile_theme_accent_color =
                normalizeBannerColor(toNullableTrimmedString(nextRow.profile_theme_accent_color)) ?? null;
              hasProfilePayload = true;
            }

            if (hasProfilePayload) {
              window.dispatchEvent(new CustomEvent<ProfileUpdatedDetail>("messly:profile-updated", { detail: profileDetail }));
            }

            const mediaDetail: ProfileMediaUpdatedDetail = { userId: rowUserId };
            let hasMediaPayload = false;

            if (Object.prototype.hasOwnProperty.call(nextRow, "avatar_key")) {
              mediaDetail.avatar_key = toNullableTrimmedString(nextRow.avatar_key);
              hasMediaPayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "avatar_hash")) {
              mediaDetail.avatar_hash = toNullableTrimmedString(nextRow.avatar_hash);
              hasMediaPayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "avatar_url")) {
              mediaDetail.avatar_url = toNullableTrimmedString(nextRow.avatar_url);
              hasMediaPayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "banner_key")) {
              mediaDetail.banner_key = toNullableTrimmedString(nextRow.banner_key);
              hasMediaPayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "banner_hash")) {
              mediaDetail.banner_hash = toNullableTrimmedString(nextRow.banner_hash);
              hasMediaPayload = true;
            }
            if (Object.prototype.hasOwnProperty.call(nextRow, "banner_color")) {
              mediaDetail.banner_color = normalizeBannerColor(toNullableTrimmedString(nextRow.banner_color)) ?? null;
              hasMediaPayload = true;
            }

            if (hasMediaPayload) {
              window.dispatchEvent(
                new CustomEvent<ProfileMediaUpdatedDetail>("messly:profile-media-updated", {
                  detail: mediaDetail,
                }),
              );
            }
          },
        )
        .subscribe();
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(bootstrapTimer);
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [dmUsersRealtimeKey, identity.userId]);

  useEffect(() => {
    if (!dmRealtimeConversationKey) {
      return;
    }

    const conversationIds = dmRealtimeConversationKey.split("|").filter((conversationId) => Boolean(conversationId));
    let disposed = false;
    let channels: ReturnType<typeof supabase.channel>[] = [];
    const bootstrapTimer = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      channels = conversationIds.map((conversationId) =>
        supabase
          .channel(`dm-chat:${conversationId}`, {
            config: {
              broadcast: {
                ack: false,
                self: false,
              },
            },
          })
          .on(
            "broadcast",
            {
              event: "message",
            },
            (payload) => {
              const data = payload.payload as {
                conversationId?: string;
                message?: BroadcastChatMessageItem | null;
              } | null;
              const incomingConversationId = String(data?.conversationId ?? "").trim();
              if (!incomingConversationId || incomingConversationId !== conversationId) {
                return;
              }

              const serverMessage = mapBroadcastMessageToServerMessage(incomingConversationId, data?.message ?? null);
              if (!serverMessage) {
                return;
              }

              upsertCachedInitialChatMessages(incomingConversationId, serverMessage);
            },
          )
          .on(
            "broadcast",
            {
              event: "message_retract",
            },
            (payload) => {
              const data = payload.payload as { conversationId?: string; clientId?: string | null } | null;
              const incomingConversationId = String(data?.conversationId ?? "").trim();
              const clientId = String(data?.clientId ?? "").trim();
              if (!incomingConversationId || incomingConversationId !== conversationId || !clientId) {
                return;
              }

              removeCachedInitialChatMessageByClientId(incomingConversationId, clientId);
            },
          ),
      );

      channels.forEach((channel) => {
        void channel.subscribe();
      });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(bootstrapTimer);
      channels.forEach((channel) => {
        void supabase.removeChannel(channel);
      });
    };
  }, [dmRealtimeConversationKey]);

  const sortedDirectMessages = useMemo(
    () => sortDirectMessages(directMessages),
    [directMessages],
  );

  const visibleDirectMessages = useMemo(
    () => {
      const normalizedActiveConversationId = String(activeConversationId ?? "").trim();
      if (!isHiddenDmStateHydrated) {
        return normalizedActiveConversationId
          ? sortedDirectMessages.filter((dm) => dm.conversationId === normalizedActiveConversationId)
          : [];
      }

      return sortedDirectMessages.filter(
        (dm) =>
          dm.conversationId === normalizedActiveConversationId ||
          !hiddenDmConversationIds.includes(dm.conversationId),
      );
    },
    [activeConversationId, hiddenDmConversationIds, isHiddenDmStateHydrated, sortedDirectMessages],
  );

  const registerDmItemRef = useCallback((conversationId: string, node: HTMLDivElement | null): void => {
    if (!conversationId) {
      return;
    }
    if (node) {
      dmItemRefs.current.set(conversationId, node);
      return;
    }
    dmItemRefs.current.delete(conversationId);
  }, []);

  useLayoutEffect(() => {
    const previousPositions = dmItemPositionsRef.current;
    const nextPositions = new Map<string, number>();
    const cleanupTimers: number[] = [];

    visibleDirectMessages.forEach((dm) => {
      const element = dmItemRefs.current.get(dm.conversationId);
      if (!element) {
        return;
      }

      const nextTop = element.getBoundingClientRect().top;
      nextPositions.set(dm.conversationId, nextTop);
      const previousTop = previousPositions.get(dm.conversationId);
      if (previousTop == null) {
        return;
      }

      const deltaY = previousTop - nextTop;
      if (Math.abs(deltaY) < 1) {
        return;
      }

      element.style.transition = "none";
      element.style.transform = `translateY(${deltaY}px)`;
      element.style.zIndex = "1";
      void element.getBoundingClientRect();

      requestAnimationFrame(() => {
        element.style.transition = `transform ${DM_REORDER_FLIP_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        element.style.transform = "translateY(0)";
        cleanupTimers.push(window.setTimeout(() => {
          if (dmItemRefs.current.get(dm.conversationId) !== element) {
            return;
          }
          element.style.transition = "";
          element.style.transform = "";
          element.style.zIndex = "";
        }, DM_REORDER_FLIP_DURATION_MS + 40));
      });
    });

    dmItemPositionsRef.current = nextPositions;
    return () => {
      cleanupTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
    };
  }, [visibleDirectMessages]);

  const handleHideDirectMessage = useCallback((conversationId: string): void => {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    setHiddenDmConversationIds((current) => {
      if (current.includes(normalizedConversationId)) {
        return current;
      }
      return [...current, normalizedConversationId];
    });
    setDmContextMenu((current) => (
      current?.conversationId === normalizedConversationId ? null : current
    ));
    if (activeConversationId === normalizedConversationId) {
      onOpenFriends?.();
    }
  }, [activeConversationId, onOpenFriends]);

  const handleDirectMessageActivate = useCallback((dm: DirectMessageItem): void => {
    const normalizedConversationId = String(dm.conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    cancelConversationPreload(normalizedConversationId);
    if (canPreloadMessages) {
      void preloadChatMessages({
        conversationId: normalizedConversationId,
        limit: DM_PRELOAD_LIMIT,
        maxAgeMs: DM_PRELOAD_MAX_AGE_MS,
      });
    }
    if (dm.bannerKey) {
      void getBannerUrl(dm.userId, dm.bannerKey, dm.bannerHash ?? null);
    }

    const resolvedDisplayName = normalizeIdentityDisplayName(dm.displayName, dm.username, dm.username);
    onSelectDirectMessage?.({
      conversationId: dm.conversationId,
      userId: dm.userId,
      username: dm.username,
      displayName: resolvedDisplayName,
      avatarSrc: dm.avatarSrc,
      presenceState: dm.presenceState,
      lastMessageAt: dm.lastMessageAt,
      isFavorite: dm.isFavorite,
      spotifyActivity: dm.spotifyActivity ?? null,
      firebaseUid: dm.firebaseUid,
      aboutText: dm.aboutText,
      bannerColor: dm.bannerColor ?? null,
      themePrimaryColor: dm.themePrimaryColor ?? null,
      themeAccentColor: dm.themeAccentColor ?? null,
      bannerKey: dm.bannerKey ?? null,
      bannerHash: dm.bannerHash ?? null,
      bannerSrc: dm.bannerSrc,
      memberSinceAt: dm.memberSinceAt ?? null,
    });
  }, [canPreloadMessages, cancelConversationPreload, onSelectDirectMessage]);

  const handleOpenDirectMessageProfile = useCallback((conversationId: string): void => {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    const dm = directMessagesRef.current.find((item) => item.conversationId === normalizedConversationId);
    if (!dm) {
      return;
    }

    handleDirectMessageActivate(dm);
    setDmContextMenu(null);
  }, [handleDirectMessageActivate]);

  const toggleFavoriteDirectMessage = useCallback((conversationId: string): void => {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    setDirectMessages((current) => {
      let changed = false;
      const updated = current.map((item) => {
        if (item.conversationId !== normalizedConversationId) {
          return item;
        }
        changed = true;
        return {
          ...item,
          isFavorite: !item.isFavorite,
        };
      });

      if (!changed) {
        return current;
      }

      writeFavoriteDirectMessageConversationIds(
        effectiveIdentityUserId,
        updated.filter((item) => item.isFavorite).map((item) => item.conversationId),
      );
      writeDirectMessagesCache(effectiveIdentityUserId, updated);
      return updated;
    });
    setDmContextMenu((current) => (
      current?.conversationId === normalizedConversationId ? null : current
    ));
  }, [effectiveIdentityUserId]);

  const handleOpenDmContextMenu = useCallback((dm: DirectMessageItem, event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const nextDisplayName = normalizeIdentityDisplayName(dm.displayName, dm.username, dm.username);
    setDmContextMenu({
      conversationId: dm.conversationId,
      userId: dm.userId,
      displayName: nextDisplayName,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  useEffect(() => {
    if (!dmContextMenu) {
      return;
    }

    const closeMenu = (): void => {
      setDmContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [dmContextMenu]);

  useEffect(
    () => () => {
      hoverPreloadTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      hoverPreloadTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!onDirectMessagesChange) {
      return;
    }
    onDirectMessagesChange(sortedDirectMessages.map(toSidebarSelection));
  }, [onDirectMessagesChange, sortedDirectMessages]);

  useEffect(() => {
    if (!DM_PRELOAD_LIST_WARMUP_ENABLED) {
      return;
    }

    if (!canPreloadMessages) {
      return;
    }

    if (visibleDirectMessages.length === 0) {
      return;
    }

    const topConversationIds = visibleDirectMessages
      .slice(0, DM_PRELOAD_LIST_WARMUP_COUNT)
      .map((dm) => dm.conversationId)
      .filter((conversationId) => Boolean(String(conversationId).trim()));

    if (topConversationIds.length === 0) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void Promise.allSettled(
        topConversationIds.map((conversationId) =>
          preloadChatMessages({
            conversationId,
            limit: DM_PRELOAD_LIMIT,
            maxAgeMs: DM_PRELOAD_MAX_AGE_MS,
          }),
        ),
      );
    }, 60);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [canPreloadMessages, visibleDirectMessages]);

  const userCardAvatarSrc = isDefaultAvatarUrl(avatarSrc)
    ? getDmDisplayAvatar(identity.displayName, identity.username, identity.userId)
    : avatarSrc;

  const handleOpenAddFriendModal = useCallback((): void => {
    setIsAddFriendModalOpen(true);
    setFriendIdentifier("");
    setAddFriendFeedback(null);
  }, []);

  const handleCloseAddFriendModal = useCallback((): void => {
    if (isAddingFriend) {
      return;
    }
    setIsAddFriendModalOpen(false);
    setFriendIdentifier("");
    setAddFriendFeedback(null);
  }, [isAddingFriend]);

  const closeAddFriendModalAfterSuccess = (): void => {
    setIsAddFriendModalOpen(false);
    setFriendIdentifier("");
    setAddFriendFeedback(null);
  };

  useEffect(() => {
    const openAddFriendFromNavbar = (): void => {
      handleOpenAddFriendModal();
    };

    window.addEventListener("messly:open-add-friend-modal", openAddFriendFromNavbar as EventListener);
    return () => {
      window.removeEventListener("messly:open-add-friend-modal", openAddFriendFromNavbar as EventListener);
    };
  }, [handleOpenAddFriendModal]);

  const handleAddFriend = async (): Promise<void> => {
    const currentUserId = identity.userId;
    const rawIdentifier = friendIdentifier.trim();

    if (!currentUserId) {
      setAddFriendFeedback({
        tone: "error",
        message: "Usuário atual ainda não sincronizado.",
      });
      return;
    }

    if (!rawIdentifier) {
      setAddFriendFeedback({
        tone: "error",
        message: "Informe o nome de usuário do amigo.",
      });
      return;
    }

    setIsAddingFriend(true);
    setAddFriendFeedback(null);

    try {
      const cleanedIdentifier = rawIdentifier.replace(/^@+/, "").trim().toLowerCase();

      const { data: targetUser, error: targetError } = await queryFriendRequestTargetByUsername(cleanedIdentifier);

      if (targetError) {
        throw targetError;
      }

      if (!targetUser?.id) {
        setAddFriendFeedback({
          tone: "error",
          message: "Usuário não encontrado.",
        });
        return;
      }

      if (targetUser.id === currentUserId) {
        setAddFriendFeedback({
          tone: "error",
          message: "Você não pode adicionar a si mesmo.",
        });
        return;
      }

      if (!isFriendRequestsAvailable) {
        await ensureDirectConversation(currentUserId, targetUser.id);
        closeAddFriendModalAfterSuccess();
        return;
      }

      const [pendingRequests, acceptedRequests] = await Promise.all([
        listFriendRequests("pending"),
        listFriendRequests("accepted"),
      ]);
      const existingRequest = [...pendingRequests, ...acceptedRequests].find((request) => {
        const requesterId = String(request.requester_id ?? "").trim();
        const addresseeId = String(request.addressee_id ?? "").trim();
        return (
          (requesterId === currentUserId && addresseeId === targetUser.id) ||
          (requesterId === targetUser.id && addresseeId === currentUserId)
        );
      });

      if (existingRequest?.status === "accepted") {
        setAddFriendFeedback({
          tone: "error",
          message: "Você já é amigo dessa pessoa.",
        });
        return;
      }

      if (existingRequest?.status === "pending") {
        setAddFriendFeedback({
          tone: "error",
          message: "Já existe uma solicitação pendente entre vocês.",
        });
        return;
      }

      const permission = await evaluateFriendRequestPermission(currentUserId, targetUser);
      if (!permission.allowed) {
        if (permission.reason === "disabled" || permission.reason === "friends_of_friends_only") {
          dispatchFriendRequestBlockedNotice(buildFriendRequestBlockedNotice(targetUser, permission.reason));
        }
        return;
      }

      const { error: createRequestError } = await supabase.from("friend_requests").insert({
        requester_id: currentUserId,
        addressee_id: targetUser.id,
        status: "pending",
      });
      if (createRequestError) {
        throw createRequestError;
      }

      window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));

      const targetDisplayName = normalizeIdentityDisplayName(targetUser.display_name, targetUser.username, "usuario");
      setAddFriendFeedback({
        tone: "success",
        message: `Solicitação enviada para ${targetDisplayName}.`,
      });
      closeAddFriendModalAfterSuccess();
    } catch (error) {
      if (isFriendRequestsUnavailableError(error)) {
        setIsFriendRequestsAvailable(false);
        try {
          const cleanedIdentifier = rawIdentifier.replace(/^@+/, "").trim().toLowerCase();
          const { data: targetUser } = await queryFriendRequestTargetByUsername(cleanedIdentifier);
          if (targetUser?.id && targetUser.id !== currentUserId) {
            await ensureDirectConversation(currentUserId, targetUser.id);
            const targetDisplayName = normalizeIdentityDisplayName(targetUser.display_name, targetUser.username, "usuario");
            setAddFriendFeedback({
              tone: "success",
              message: `${targetDisplayName} adicionado com sucesso.`,
            });
            closeAddFriendModalAfterSuccess();
            return;
          }
        } catch {
          // ignore fallback error and surface generic message below
        }
        setAddFriendFeedback({
          tone: "error",
          message: "Solicitações pendentes indisponíveis; execute a migração friend_requests.",
        });
        return;
      }
      setAddFriendFeedback({
        tone: "error",
        message: "Não foi possível adicionar agora. Tente novamente.",
      });
    } finally {
      setIsAddingFriend(false);
    }
  };

  const handleOpenConversationById = useCallback((conversationId: string): void => {
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return;
    }

    const dm = directMessages.find((item) => item.conversationId === normalizedConversationId);
    if (!dm) {
      return;
    }

    setHiddenDmConversationIds((current) =>
      current.includes(normalizedConversationId)
        ? current.filter((id) => id !== normalizedConversationId)
        : current,
    );
    handleDirectMessageActivate(dm);
  }, [directMessages, handleDirectMessageActivate]);
  const isFriendsShortcutActive = !String(activeConversationId ?? "").trim();

  return (
    <>
      <aside className="friends-sidebar">
        <div className="friends-sidebar__header">
          <span className="friends-sidebar__title">Messly</span>
        </div>

        <div className="friends-sidebar__content">
          <div className="friends-sidebar__section">
            <div className="friends-sidebar__section-label friends-sidebar__section-label--large">
              Acesso rápido
            </div>
            <button
              className={`friends-sidebar__item friends-sidebar__item--friends${
                isFriendsShortcutActive ? " friends-sidebar__item--active" : ""
              }`}
              type="button"
              onClick={() => {
                onOpenFriends?.();
              }}
            >
              <MaterialSymbolIcon className="friends-sidebar__item-icon" name="group" size={18} />
              <span className="friends-sidebar__item-text">Amigos</span>
            </button>
          </div>

          <div className="friends-sidebar__section friends-sidebar__section--direct-messages">
            <div className="friends-sidebar__section-label friends-sidebar__section-label--large">
              Mensagens diretas
            </div>
            <div className="friends-sidebar__dm-list" role="list" aria-label="Mensagens diretas">
              {visibleDirectMessages.map((dm) => {
                return (
                  <DirectMessageListItem
                    key={dm.conversationId}
                    dm={dm}
                    isActive={activeConversationId === dm.conversationId}
                    unreadCount={unreadCountsByConversationId.get(dm.conversationId) ?? 0}
                    identityUserId={identity.userId}
                    registerItemRef={registerDmItemRef}
                    onActivate={handleDirectMessageActivate}
                    onHide={handleHideDirectMessage}
                    onOpenContextMenu={handleOpenDmContextMenu}
                    onPreloadStart={scheduleConversationPreload}
                    onPreloadStop={cancelConversationPreload}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {dmContextMenu ? (
          <div
            className="friends-sidebar__dm-context-menu"
            role="menu"
            aria-label={`Acoes para ${dmContextMenu.displayName}`}
            style={{
              left: Math.max(12, dmContextMenu.x),
              top: Math.max(12, dmContextMenu.y),
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="friends-sidebar__dm-context-menu-group" role="none">
              <button
                className="friends-sidebar__dm-context-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  handleOpenDirectMessageProfile(dmContextMenu.conversationId);
                }}
              >
                <span>Perfil</span>
              </button>

              <button
                className="friends-sidebar__dm-context-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  toggleFavoriteDirectMessage(dmContextMenu.conversationId);
                }}
              >
                <span>
                  {directMessagesRef.current.find((item) => item.conversationId === dmContextMenu.conversationId)?.isFavorite
                    ? "Desfavoritar usuario"
                    : "Favoritar usuario"}
                </span>
              </button>
            </div>

            <div className="friends-sidebar__dm-context-menu-divider" role="separator" />

            <div className="friends-sidebar__dm-context-menu-group" role="none">
              <button
                className="friends-sidebar__dm-context-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  handleHideDirectMessage(dmContextMenu.conversationId);
                }}
              >
                <span>Fechar mensagem direta</span>
              </button>
            </div>
          </div>
        ) : null}

        <div className="friends-sidebar__user-card-wrap">
          <UserCard
            userId={identity.userId}
            currentUserId={currentUserId}
            avatarSrc={userCardAvatarSrc}
            bannerSrc={bannerSrc}
            bannerColor={effectiveIdentityBannerColor}
            displayName={identity.displayName}
            username={identity.username}
            aboutText={identity.about}
            presenceState={presenceState}
            onChangePresence={onChangePresence}
            onOpenSettings={onOpenSettings}
            onOpenConversation={handleOpenConversationById}
          />
        </div>
      </aside>

      <Modal
        isOpen={isAddFriendModalOpen}
        title="Adicionar amigo"
        ariaLabel="Adicionar amigo"
        onClose={handleCloseAddFriendModal}
        panelClassName="friends-sidebar__add-friend-modal"
        bodyClassName="friends-sidebar__add-friend-modal-body"
        footer={
          <div className="friends-sidebar__add-friend-modal-footer">
            <button
              className="friends-sidebar__add-friend-cancel"
              type="button"
              onClick={handleCloseAddFriendModal}
              disabled={isAddingFriend}
            >
              Cancelar
            </button>
            <button
              className="friends-sidebar__add-friend-submit"
              type="button"
              onClick={() => {
                void handleAddFriend();
              }}
              disabled={isAddingFriend}
            >
              {isAddingFriend ? "Adicionando..." : "Adicionar"}
            </button>
          </div>
        }
      >
        <div className="friends-sidebar__add-friend-form">
          <p className="friends-sidebar__add-friend-description">
            Digite o nome de usuário para enviar uma solicitação e iniciar uma conversa.
          </p>
          <label className="friends-sidebar__add-friend-label" htmlFor="add-friend-input">
            Nome de usuário
          </label>
          <input
            id="add-friend-input"
            className="friends-sidebar__add-friend-input"
            type="text"
            value={friendIdentifier}
            onChange={(event) => setFriendIdentifier(event.target.value)}
            placeholder="@usuario"
            autoComplete="off"
            disabled={isAddingFriend}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAddFriend();
              }
            }}
          />
          {addFriendFeedback ? (
            <p
              className={`friends-sidebar__add-friend-feedback ${
                addFriendFeedback.tone === "error"
                  ? "friends-sidebar__add-friend-feedback--error"
                  : "friends-sidebar__add-friend-feedback--success"
              }`}
            >
              {addFriendFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(friendRequestBlockedNotice)}
        title={friendRequestBlockedNotice?.title ?? "Pedido indisponível"}
        ariaLabel="Aviso sobre pedido de amizade"
        onClose={() => setFriendRequestBlockedNotice(null)}
        panelClassName="friends-sidebar__request-blocked-modal"
        bodyClassName="friends-sidebar__request-blocked-modal-body"
        footer={
          <div className="friends-sidebar__request-blocked-footer">
            <button
              className="friends-sidebar__request-blocked-button"
              type="button"
              onClick={() => setFriendRequestBlockedNotice(null)}
            >
              Ok
            </button>
          </div>
        }
      >
        <div className="friends-sidebar__request-blocked-content">
          <p className="friends-sidebar__request-blocked-text">{friendRequestBlockedNotice?.description}</p>
        </div>
      </Modal>
    </>
  );
}


