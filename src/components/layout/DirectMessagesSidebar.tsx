import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import UserCard from "../UserCard/UserCard";
import Modal from "../ui/Modal";
import { useAuthSession } from "../../auth/AuthProvider";
import {
  getAvatarUrl,
  getBannerUrl,
  getDefaultAvatarUrl,
  getDefaultBannerUrl,
  getNameAvatarUrl,
  isDefaultAvatarUrl,
  isDefaultBannerUrl,
} from "../../services/cdn/mediaUrls";
import { supabase } from "../../services/supabase";
import { firebaseAuth, firebaseDatabase } from "../../services/firebase";
import { escapeLikePattern, normalizeEmail } from "../../services/usernameAvailability";
import { friendRequestsEnabled } from "../../services/friends/friendRequests";
import { preloadChatMessages } from "../../services/chat/chatApi";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import type { PresenceState } from "../../services/presence/presenceTypes";
import "../../styles/components/DirectMessagesSidebar.css";

interface SidebarIdentity {
  userId: string | null;
  displayName: string;
  username: string;
  about: string;
  bannerColor: string | null;
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
  firebaseUid?: string;
  aboutText?: string;
  bannerColor?: string | null;
  bannerKey?: string | null;
  bannerHash?: string | null;
  bannerSrc?: string;
  memberSinceAt?: string | null;
}

interface DirectMessagesSidebarProps {
  currentUserId?: string | null;
  presenceState: PresenceState;
  onChangePresence: (state: PresenceState) => void;
  onOpenSettings: () => void;
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
  banner_key?: string | null;
  banner_hash?: string | null;
}

interface ProfileUpdatedDetail {
  userId: string;
  display_name?: string | null;
  username?: string | null;
  about?: string | null;
  banner_color?: string | null;
}

interface DmUserRow {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  status?: string | null;
  firebase_uid?: string | null;
  about?: string | null;
  banner_color?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  created_at?: string | null;
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
}

interface DirectMessageItem {
  conversationId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  presenceState: PresenceState;
  firebaseUid?: string;
  aboutText?: string;
  bannerColor?: string | null;
  bannerKey?: string | null;
  bannerHash?: string | null;
  bannerSrc?: string;
  memberSinceAt?: string | null;
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
  avatarKey: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  bannerKey: string | null;
  bannerHash: string | null;
}

const SIDEBAR_IDENTITY_CACHE_PREFIX = "messly:sidebar-identity:";
const DIRECT_MESSAGES_CACHE_PREFIX = "messly:direct-messages:";
const SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX = "messly:sidebar-media:";
const DIRECT_MESSAGES_CACHE_VERSION = 5;
const DM_PRELOAD_LIMIT = 30;             
const DM_PRELOAD_HOVER_DEBOUNCE_MS = 150; 
const DM_PRELOAD_MAX_AGE_MS = 90_000;
const DM_PRELOAD_LIST_WARMUP_COUNT = 6;


interface CachedDirectMessagesPayload {
  version: number;
  items: DirectMessageItem[];
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
    firebaseUid: dm.firebaseUid,
    aboutText: dm.aboutText,
    bannerColor: dm.bannerColor ?? null,
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
        const avatarSrc = String(casted.avatarSrc ?? "").trim() || getDmDisplayAvatar(displayName, username);
        const firebaseUid = String((casted as { firebaseUid?: string | null }).firebaseUid ?? "").trim();
        const aboutText = String((casted as { aboutText?: string | null }).aboutText ?? "").trim();
        const bannerColor = normalizeBannerColor((casted as { bannerColor?: string | null }).bannerColor) ?? null;
        const bannerKey = String((casted as { bannerKey?: string | null }).bannerKey ?? "").trim() || null;
        const bannerHash = String((casted as { bannerHash?: string | null }).bannerHash ?? "").trim() || null;
        const bannerSrc = String((casted as { bannerSrc?: string | null }).bannerSrc ?? "").trim();
        const memberSinceAt = String((casted as { memberSinceAt?: string | null }).memberSinceAt ?? "").trim() || null;
        const parsedItem: DirectMessageItem = {
          conversationId,
          userId: userIdValue,
          username,
          displayName,
          avatarSrc,
          presenceState: normalizePresenceState((casted as { presenceState?: unknown }).presenceState ?? null),
          ...(firebaseUid ? { firebaseUid } : {}),
          ...(aboutText ? { aboutText } : {}),
          ...(bannerColor ? { bannerColor } : {}),
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

function getDmDisplayAvatar(displayName: string, username: string): string {
  return getNameAvatarUrl(displayName || username || "U");
}

function isGeneratedInlineAvatarUrl(url: string | null | undefined): boolean {
  return String(url ?? "").startsWith("data:image/svg+xml,");
}

function isDmFallbackAvatar(url: string | null | undefined): boolean {
  return isDefaultAvatarUrl(url) || isGeneratedInlineAvatarUrl(url);
}

function hasDmAvatarSource(targetUser: DmUserRow | undefined, legacyBackupUrl: string): boolean {
  const avatarKey = String(targetUser?.avatar_key ?? "").trim();
  const legacyAvatarUrl = String(targetUser?.avatar_url ?? "").trim();
  return avatarKey.length > 0 || legacyAvatarUrl.length > 0 || legacyBackupUrl.trim().length > 0;
}

function buildDmAvatarSignature(targetUser: DmUserRow | undefined, legacyBackupUrl: string): string {
  return [
    String(targetUser?.avatar_key ?? "").trim(),
    String(targetUser?.avatar_hash ?? "").trim().toLowerCase(),
    String(targetUser?.avatar_url ?? "").trim(),
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
    if (isDmFallbackAvatar(item.avatarSrc) && !isDmFallbackAvatar(currentItem.avatarSrc)) {
      mergedItem.avatarSrc = currentItem.avatarSrc;
    }
    if (!mergedItem.aboutText && currentItem.aboutText) {
      mergedItem.aboutText = currentItem.aboutText;
    }
    if (!mergedItem.bannerColor && currentItem.bannerColor) {
      mergedItem.bannerColor = currentItem.bannerColor;
    }
    if (!mergedItem.bannerKey && currentItem.bannerKey) {
      mergedItem.bannerKey = currentItem.bannerKey;
    }
    if (!mergedItem.bannerHash && currentItem.bannerHash) {
      mergedItem.bannerHash = currentItem.bannerHash;
    }
    if (!mergedItem.bannerSrc && currentItem.bannerSrc) {
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
      (currentItem.firebaseUid ?? "") !== (nextItem.firebaseUid ?? "") ||
      (currentItem.aboutText ?? "") !== (nextItem.aboutText ?? "") ||
      (currentItem.bannerColor ?? "") !== (nextItem.bannerColor ?? "") ||
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
    return "offline";
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
  if (raw === "offline" || raw === "invisible") {
    return "offline";
  }
  return "offline";
}

function resolvePresenceFromRealtimeNode(value: unknown): PresenceState {
  if (!value || typeof value !== "object") {
    return "offline";
  }

  const directStateRaw = (value as { state?: unknown }).state;
  if (directStateRaw !== undefined) {
    return normalizePresenceState(directStateRaw);
  }

  const devices = Object.values(value as Record<string, unknown>);
  let hasIdle = false;
  let hasOnline = false;

  for (const device of devices) {
    const state = normalizePresenceState((device as { state?: unknown } | null)?.state ?? null);
    if (state === "dnd") {
      return "dnd";
    }
    if (state === "online") {
      hasOnline = true;
      continue;
    }
    if (state === "idle") {
      hasIdle = true;
    }
  }

  if (hasOnline) {
    return "online";
  }
  if (hasIdle) {
    return "idle";
  }
  return "offline";
}

function isFriendRequestsUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: string; message?: string; details?: string };
  const message = String(candidate.message ?? "").toLowerCase();
  const details = String(candidate.details ?? "").toLowerCase();
  return (
    candidate.code === "42P01" ||
    candidate.code === "PGRST205" ||
    message.includes("could not find the table") ||
    details.includes("could not find the table")
  );
}

async function loadLegacyAvatarMap(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  try {
    const { data, error } = await supabase
      .from("users_legacy_media_backup")
      .select("user_id,avatar_url")
      .in("user_id", userIds);

    if (error || !data) {
      return new Map();
    }

    const map = new Map<string, string>();
    (data as LegacyAvatarRow[]).forEach((row) => {
      const url = String(row.avatar_url ?? "").trim();
      if (row.user_id && url.length > 0) {
        map.set(row.user_id, url);
      }
    });
    return map;
  } catch {
    return new Map();
  }
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
  displayName: "Nome",
  username: "username",
  about: "",
  bannerColor: null,
  avatarKey: null,
  avatarHash: null,
  avatarUrl: null,
  bannerKey: null,
  bannerHash: null,
};

const USER_PROFILE_SELECT_COLUMNS =
  "id,username,display_name,email,firebase_uid,about,banner_color,avatar_key,avatar_hash,avatar_url,banner_key,banner_hash";
const USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL =
  "id,username,display_name,email,firebase_uid,about,banner_color,avatar_key,avatar_hash,banner_key,banner_hash";
const USER_PROFILE_SELECT_COLUMNS_FALLBACK = "id,username,display_name,email,firebase_uid,about";

function isUsersSchemaColumnCacheError(message: string): boolean {
  return message.includes("column of 'users' in the schema cache");
}

function isMissingAvatarUrlColumnError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("avatar_url") && normalized.includes("users");
}

async function queryUserById(userId: string) {
  const primary = await supabase.from("users").select(USER_PROFILE_SELECT_COLUMNS).eq("id", userId).limit(1).maybeSingle();

  if (primary.error && isMissingAvatarUrlColumnError(primary.error.message ?? "")) {
    const withoutLegacyAvatar = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
    if (!withoutLegacyAvatar.error) {
      return withoutLegacyAvatar;
    }
  }

  if (primary.error && isUsersSchemaColumnCacheError(primary.error.message ?? "")) {
    return supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_FALLBACK)
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
  }

  return primary;
}

async function queryUserByFirebaseUid(firebaseUid: string) {
  const primary = await supabase
    .from("users")
    .select(USER_PROFILE_SELECT_COLUMNS)
    .eq("firebase_uid", firebaseUid)
    .limit(1)
    .maybeSingle();

  if (primary.error && isMissingAvatarUrlColumnError(primary.error.message ?? "")) {
    const withoutLegacyAvatar = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .eq("firebase_uid", firebaseUid)
      .limit(1)
      .maybeSingle();
    if (!withoutLegacyAvatar.error) {
      return withoutLegacyAvatar;
    }
  }

  if (primary.error && isUsersSchemaColumnCacheError(primary.error.message ?? "")) {
    return supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_FALLBACK)
      .eq("firebase_uid", firebaseUid)
      .limit(1)
      .maybeSingle();
  }

  return primary;
}

async function queryUserByEmail(email: string) {
  const escapedEmail = escapeLikePattern(email);
  const primary = await supabase
    .from("users")
    .select(USER_PROFILE_SELECT_COLUMNS)
    .ilike("email", escapedEmail)
    .limit(1)
    .maybeSingle();

  if (primary.error && isMissingAvatarUrlColumnError(primary.error.message ?? "")) {
    const withoutLegacyAvatar = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .ilike("email", escapedEmail)
      .limit(1)
      .maybeSingle();
    if (!withoutLegacyAvatar.error) {
      return withoutLegacyAvatar;
    }
  }

  if (primary.error && isUsersSchemaColumnCacheError(primary.error.message ?? "")) {
    return supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_FALLBACK)
      .ilike("email", escapedEmail)
      .limit(1)
      .maybeSingle();
  }

  return primary;
}

function buildIdentityFromSession(_email: string | null | undefined, displayName: string | null | undefined): SidebarIdentity {
  const cleanedDisplayName = displayName?.trim();
  const fallbackDisplayName = cleanedDisplayName || DEFAULT_IDENTITY.displayName;

  return {
    userId: null,
    displayName: fallbackDisplayName,
    username: DEFAULT_IDENTITY.username,
    about: "",
    bannerColor: null,
    avatarKey: null,
    avatarHash: null,
    avatarUrl: null,
    bannerKey: null,
    bannerHash: null,
  };
}

export default function DirectMessagesSidebar({
  currentUserId,
  presenceState,
  onChangePresence,
  onOpenSettings,
  activeConversationId = null,
  onSelectDirectMessage,
  onOpenFriends,
  onDirectMessagesChange,
}: DirectMessagesSidebarProps) {
  const { user } = useAuthSession();
  const sessionUid = user?.uid ?? firebaseAuth.currentUser?.uid ?? null;
  const [identity, setIdentity] = useState<SidebarIdentity>(() => {
    const base = buildIdentityFromSession(user?.email, user?.displayName);
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
      avatarKey: cached.avatarKey,
      avatarHash: cached.avatarHash,
      avatarUrl: cached.avatarUrl,
      bannerKey: cached.bannerKey,
      bannerHash: cached.bannerHash,
    };
  });
  const [avatarSrc, setAvatarSrc] = useState<string>(() => {
    const cached = readSidebarResolvedMediaCache(sessionUid);
    return cached?.avatarSrc || getDefaultAvatarUrl();
  });
  const [bannerSrc, setBannerSrc] = useState<string>(() => {
    const cached = readSidebarResolvedMediaCache(sessionUid);
    return cached?.bannerSrc || getDefaultBannerUrl();
  });
  const [isAddFriendModalOpen, setIsAddFriendModalOpen] = useState(false);
  const [friendIdentifier, setFriendIdentifier] = useState("");
  const [isAddingFriend, setIsAddingFriend] = useState(false);
  const [addFriendFeedback, setAddFriendFeedback] = useState<AddFriendFeedbackState | null>(null);
  const [isFriendRequestsAvailable, setIsFriendRequestsAvailable] = useState(friendRequestsEnabled);
  const [isIdentityLoaded, setIsIdentityLoaded] = useState(false);
  const [directMessages, setDirectMessages] = useState<DirectMessageItem[]>([]);
  const [hiddenDmConversationIds, setHiddenDmConversationIds] = useState<string[]>([]);
  const hoverPreloadTimersRef = useRef<Map<string, number>>(new Map());
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

  const scheduleConversationPreload = useCallback((conversationId: string): void => {
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
  }, []);

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
    const base = buildIdentityFromSession(user?.email, user?.displayName);
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
      avatarKey: cached.avatarKey,
      avatarHash: cached.avatarHash,
      avatarUrl: cached.avatarUrl,
      bannerKey: cached.bannerKey,
      bannerHash: cached.bannerHash,
    });
  }, [sessionUid, user?.displayName, user?.email]);

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
    setAvatarSrc(getDefaultAvatarUrl());
    setBannerSrc(getDefaultBannerUrl());
  }, [sessionUid]);

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
              avatar_key?: string | null;
              avatar_hash?: string | null;
              avatar_url?: string | null;
              banner_key?: string | null;
              banner_hash?: string | null;
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

        if (!data && stableFirebaseUid) {
          const normalizedEmail = normalizeEmail(user?.email ?? "");
          if (normalizedEmail) {
            const { data: byEmail, error: emailError } = await queryUserByEmail(normalizedEmail);

            if (emailError) {
              return;
            }

            data = byEmail;
          }
        }

        if (!data) {
          return;
        }
        const row = data;

        const resolvedUsername = normalizeIdentityUsername(row.username);
        const fallbackDisplayName = (user?.displayName ?? "").trim();
        const resolvedDisplayName = normalizeIdentityDisplayName(row.display_name, resolvedUsername, fallbackDisplayName);

        setIdentity((current) => ({
          userId: row.id ?? current.userId,
          displayName: resolvedDisplayName || current.displayName,
          username: resolvedUsername || current.username,
          about: String(row.about ?? "").trim(),
          bannerColor: normalizeBannerColor(row.banner_color) ?? null,
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
  }, [currentUserId, sessionUid, user?.email]);

  useEffect(() => {
    const handleProfileMediaUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileMediaUpdatedDetail>).detail;
      if (!detail?.userId) {
        return;
      }

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
        if (Object.prototype.hasOwnProperty.call(detail, "avatar_key") && detail.avatar_key == null) {
          next.avatarUrl = null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "banner_key")) {
          next.bannerKey = detail.banner_key ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(detail, "banner_hash")) {
          next.bannerHash = detail.banner_hash ?? null;
        }

        return next;
      });
    };

    window.addEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    };
  }, []);

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

        if (
          current.username === nextUsername &&
          current.displayName === nextDisplayName &&
          current.about === nextAbout &&
          current.bannerColor === nextBannerColor
        ) {
          return current;
        }

        return {
          ...current,
          username: nextUsername,
          displayName: nextDisplayName,
          about: nextAbout,
          bannerColor: nextBannerColor,
        };
      });

    };

    window.addEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const avatarSource = identity.avatarKey ?? identity.avatarUrl;
    const hasAvatarSource = Boolean(String(avatarSource ?? "").trim());
    void getAvatarUrl(identity.userId, avatarSource, identity.avatarHash).then((url) => {
      if (isMounted) {
        const resolvedUrl = String(url ?? "").trim() || getDefaultAvatarUrl();
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
  }, [identity.avatarHash, identity.avatarKey, identity.avatarUrl, identity.userId]);

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
    const currentUserId = identity.userId;
    if (!currentUserId) {
      setDirectMessages((current) => (current.length === 0 ? current : []));
      return;
    }

    const cachedDirectMessages = readDirectMessagesCache(currentUserId);
    if (cachedDirectMessages && cachedDirectMessages.length > 0) {
      setDirectMessages((current) =>
        areDirectMessageListsEqual(current, cachedDirectMessages) ? current : cachedDirectMessages,
      );
    }

    let isMounted = true;
    let loadInFlight = false;
    let hasQueuedLoad = false;

    async function loadDirectMessages(): Promise<void> {
      const { data: conversations, error: conversationsError } = await supabase
        .from("conversations")
        .select("id,user1_id,user2_id,created_at")
        .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
        .order("created_at", { ascending: false });

      if (conversationsError || !isMounted) {
        return;
      }

      const rows = (conversations ?? []) as ConversationRow[];
      if (rows.length === 0) {
        setDirectMessages((current) => (current.length === 0 ? current : []));
        writeDirectMessagesCache(currentUserId, []);
        return;
      }

      const otherUserIds = Array.from(
        new Set(
          rows.map((conversation) =>
            conversation.user1_id === currentUserId ? conversation.user2_id : conversation.user1_id,
          ),
        ),
      );

      const usersWithLegacyAvatar = await supabase
        .from("users")
        .select(
          "id,username,display_name,avatar_key,avatar_hash,avatar_url,status,firebase_uid,about,banner_color,banner_key,banner_hash,created_at",
        )
        .in("id", otherUserIds);

      let users = usersWithLegacyAvatar.data as DmUserRow[] | null;
      let usersError = usersWithLegacyAvatar.error;

      if (usersError && isMissingAvatarUrlColumnError(usersError.message ?? "")) {
        const usersWithoutLegacyAvatar = await supabase
          .from("users")
          .select(
            "id,username,display_name,avatar_key,avatar_hash,status,firebase_uid,about,banner_color,banner_key,banner_hash,created_at",
          )
          .in("id", otherUserIds);
        users = usersWithoutLegacyAvatar.data as DmUserRow[] | null;
        usersError = usersWithoutLegacyAvatar.error;
      }

      if (usersError && isUsersSchemaColumnCacheError(usersError.message ?? "")) {
        const usersFallback = await supabase
          .from("users")
          .select("id,username,display_name,avatar_key,avatar_hash,status,firebase_uid,about,created_at")
          .in("id", otherUserIds);
        users = usersFallback.data as DmUserRow[] | null;
        usersError = usersFallback.error;
      }

      if (usersError || !isMounted) {
        return;
      }

      const usersById = new Map<string, DmUserRow>();
      (users ?? []).forEach((row) => {
        usersById.set(row.id, row);
      });

      // Fast first paint: names + cached avatar + cached presence.
      const initialItems = rows.map((conversation) => {
        const otherUserId = conversation.user1_id === currentUserId ? conversation.user2_id : conversation.user1_id;
        const targetUser = usersById.get(otherUserId);
        const username = normalizeIdentityUsername(targetUser?.username);
        const displayName = normalizeIdentityDisplayName(targetUser?.display_name, username, username);
        const aboutText = String(targetUser?.about ?? "").trim();
        const bannerColor = normalizeBannerColor(targetUser?.banner_color) ?? null;
        const bannerKey = String(targetUser?.banner_key ?? "").trim() || null;
        const bannerHash = String(targetUser?.banner_hash ?? "").trim() || null;
        const memberSinceAt = String(targetUser?.created_at ?? "").trim() || null;
        const hasAvatarSource = hasDmAvatarSource(targetUser, "");
        const placeholderAvatar = hasAvatarSource
          ? getDefaultAvatarUrl()
          : getDmDisplayAvatar(displayName, username);
        const cachedAvatar = getCachedDmAvatar(otherUserId, buildDmAvatarSignature(targetUser, ""));
        const basePresence = normalizePresenceState(targetUser?.status ?? null);
        const cachedPresence = dmPresenceCache.get(otherUserId) ?? basePresence;

        return {
          conversationId: conversation.id,
          userId: otherUserId,
          username,
          displayName,
          avatarSrc: cachedAvatar ?? placeholderAvatar,
          presenceState: cachedPresence,
          firebaseUid: String(targetUser?.firebase_uid ?? "").trim() || undefined,
          aboutText,
          bannerColor,
          bannerKey,
          bannerHash,
          memberSinceAt,
        } satisfies DirectMessageItem;
      });

      if (isMounted) {
        setDirectMessages((current) => {
          const mergedItems = mergeDirectMessagesWithoutAvatarDowngrade(current, initialItems);
          return areDirectMessageListsEqual(current, mergedItems) ? current : mergedItems;
        });
      }

      // Warm up banner URLs for the top DMs so chat profile opens instantly.
      const warmupBannerItems = initialItems
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
              if (!warmedBannerSrc || item.bannerSrc === warmedBannerSrc) {
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

            writeDirectMessagesCache(currentUserId, updated);
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
          const hasAvatarSource = hasDmAvatarSource(targetUser, backupAvatarUrl);
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
                resolvedAvatar = isDefaultAvatarUrl(legacyResolved) ? getDmDisplayAvatar(displayName, username) : legacyResolved;
              } else {
                resolvedAvatar = getDmDisplayAvatar(displayName, username);
              }
            }

            setCachedDmAvatar(otherUserId, signature, resolvedAvatar);
            return [otherUserId, resolvedAvatar] as const;
          } catch {
            const fallbackAvatar = hasAvatarSource
              ? getDefaultAvatarUrl()
              : getDmDisplayAvatar(displayName, username);
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
      usersById.forEach((targetUser, otherUserId) => {
        const resolvedPresence =
          dmPresenceCache.get(otherUserId) ??
          normalizePresenceState(targetUser.status ?? null);
        dmPresenceCache.set(otherUserId, resolvedPresence);
        presenceByUserId.set(otherUserId, resolvedPresence);
      });

      const hydratedItems = initialItems.map((item) => ({
        ...item,
        avatarSrc: avatarMap.get(item.userId) ?? item.avatarSrc,
        presenceState: presenceByUserId.get(item.userId) ?? item.presenceState,
      }));

      if (isMounted) {
        setDirectMessages((current) => {
          const mergedItems = mergeDirectMessagesWithoutAvatarDowngrade(current, hydratedItems);
          if (!areDirectMessageListsEqual(current, mergedItems)) {
            writeDirectMessagesCache(currentUserId, mergedItems);
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
          await loadDirectMessages();
        } while (isMounted && hasQueuedLoad);
      } finally {
        loadInFlight = false;
      }
    }

    void requestLoadDirectMessages();

    const intervalId = window.setInterval(() => {
      void requestLoadDirectMessages();
    }, 15000);

    const handleFriendRequestsChanged = (): void => {
      void requestLoadDirectMessages();
    };

    const handleWindowFocus = (): void => {
      void requestLoadDirectMessages();
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void requestLoadDirectMessages();
      }
    };

    window.addEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [identity.userId]);

  const dmPresenceSubscriptionKey = useMemo(() => {
    const uniqueEntries = new Map<string, string>();
    directMessages.forEach((dm) => {
      const firebaseUid = String(dm.firebaseUid ?? "").trim();
      if (!firebaseUid || uniqueEntries.has(firebaseUid)) {
        return;
      }
      uniqueEntries.set(firebaseUid, dm.userId);
    });

    return Array.from(uniqueEntries.entries())
      .sort(([uidA], [uidB]) => uidA.localeCompare(uidB))
      .map(([firebaseUid, userId]) => `${firebaseUid}:${userId}`)
      .join("|");
  }, [directMessages]);

  useEffect(() => {
    if (!dmPresenceSubscriptionKey) {
      return;
    }

    const entries = dmPresenceSubscriptionKey
      .split("|")
      .map((token) => {
        const separatorIndex = token.lastIndexOf(":");
        if (separatorIndex <= 0) {
          return null;
        }
        return {
          firebaseUid: token.slice(0, separatorIndex),
          userId: token.slice(separatorIndex + 1),
        };
      })
      .filter((entry): entry is { firebaseUid: string; userId: string } => entry !== null);

    const unsubscribers = entries.map(({ firebaseUid }) =>
      onValue(
        ref(firebaseDatabase, `presence/${firebaseUid}`),
        (snapshot) => {
          if (!snapshot.exists()) {
            // Transient empty snapshots can happen; keep last known state to avoid flicker.
            return;
          }
          const nextPresence = resolvePresenceFromRealtimeNode(snapshot.val());
          setDirectMessages((current) => {
            let changed = false;
            const updated = current.map((item) => {
              const itemFirebaseUid = String(item.firebaseUid ?? "").trim();
              if (itemFirebaseUid !== firebaseUid) {
                return item;
              }
              dmPresenceCache.set(item.userId, nextPresence);
              if (item.presenceState === nextPresence) {
                return item;
              }
              changed = true;
              return {
                ...item,
                presenceState: nextPresence,
              };
            });

            if (!changed) {
              return current;
            }

            writeDirectMessagesCache(identity.userId, updated);
            return updated;
          });
        },
        () => {
          const nextPresence: PresenceState = "offline";
          setDirectMessages((current) => {
            let changed = false;
            const updated = current.map((item) => {
              const itemFirebaseUid = String(item.firebaseUid ?? "").trim();
              if (itemFirebaseUid !== firebaseUid) {
                return item;
              }
              dmPresenceCache.set(item.userId, nextPresence);
              if (item.presenceState === nextPresence) {
                return item;
              }
              changed = true;
              return {
                ...item,
                presenceState: nextPresence,
              };
            });

            if (!changed) {
              return current;
            }

            writeDirectMessagesCache(identity.userId, updated);
            return updated;
          });
        },
      ),
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }, [dmPresenceSubscriptionKey, identity.userId]);

  const visibleDirectMessages = useMemo(
    () => directMessages.filter((dm) => !hiddenDmConversationIds.includes(dm.conversationId)),
    [directMessages, hiddenDmConversationIds],
  );

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
    onDirectMessagesChange(directMessages.map(toSidebarSelection));
  }, [directMessages, onDirectMessagesChange]);

  useEffect(() => {
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
  }, [visibleDirectMessages]);

  const userCardAvatarSrc = isDefaultAvatarUrl(avatarSrc)
    ? getNameAvatarUrl(identity.displayName || identity.username || "U")
    : avatarSrc;

  const handleOpenAddFriendModal = (): void => {
    setIsAddFriendModalOpen(true);
    setFriendIdentifier("");
    setAddFriendFeedback(null);
  };

  const handleCloseAddFriendModal = (): void => {
    if (isAddingFriend) {
      return;
    }
    setIsAddFriendModalOpen(false);
    setFriendIdentifier("");
    setAddFriendFeedback(null);
  };

  const handleAddFriend = async (): Promise<void> => {
    const currentUserId = identity.userId;
    const rawIdentifier = friendIdentifier.trim();

    if (!currentUserId) {
      setAddFriendFeedback({
        tone: "error",
        message: "Usuario atual ainda nao sincronizado.",
      });
      return;
    }

    if (!rawIdentifier) {
      setAddFriendFeedback({
        tone: "error",
        message: "Informe o username do amigo.",
      });
      return;
    }

    setIsAddingFriend(true);
    setAddFriendFeedback(null);

    try {
      const cleanedIdentifier = rawIdentifier.replace(/^@+/, "").trim();
      const escapedIdentifier = escapeLikePattern(cleanedIdentifier);

      const { data: targetUser, error: targetError } = await supabase
        .from("users")
        .select("id,username,display_name,email")
        .ilike("username", escapedIdentifier)
        .limit(1)
        .maybeSingle();

      if (targetError) {
        throw targetError;
      }

      if (!targetUser?.id) {
        setAddFriendFeedback({
          tone: "error",
          message: "Usuario nao encontrado.",
        });
        return;
      }

      if (targetUser.id === currentUserId) {
        setAddFriendFeedback({
          tone: "error",
          message: "Voce nao pode adicionar a si mesmo.",
        });
        return;
      }

      if (!isFriendRequestsAvailable) {
        await ensureDirectConversation(currentUserId, targetUser.id);
        const targetDisplayName = normalizeIdentityDisplayName(targetUser.display_name, targetUser.username, "usuario");
        setAddFriendFeedback({
          tone: "success",
          message: `${targetDisplayName} adicionado com sucesso.`,
        });
        setFriendIdentifier("");
        return;
      }

      const pairFilter = `and(requester_id.eq.${currentUserId},addressee_id.eq.${targetUser.id}),and(requester_id.eq.${targetUser.id},addressee_id.eq.${currentUserId})`;
      const { data: existingRequest, error: existingRequestError } = await supabase
        .from("friend_requests")
        .select("id,status")
        .or(pairFilter)
        .in("status", ["pending", "accepted"])
        .limit(1)
        .maybeSingle();

      if (existingRequestError) {
        throw existingRequestError;
      }

      if (existingRequest?.status === "accepted") {
        setAddFriendFeedback({
          tone: "error",
          message: "Voce ja e amigo dessa pessoa.",
        });
        return;
      }

      if (existingRequest?.status === "pending") {
        setAddFriendFeedback({
          tone: "error",
          message: "Ja existe uma solicitacao pendente entre voces.",
        });
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
        message: `Solicitacao enviada para ${targetDisplayName}.`,
      });
      setFriendIdentifier("");
    } catch (error) {
      if (isFriendRequestsUnavailableError(error)) {
        setIsFriendRequestsAvailable(false);
        try {
          const cleanedIdentifier = rawIdentifier.replace(/^@+/, "").trim();
          const escapedIdentifier = escapeLikePattern(cleanedIdentifier);
          const { data: targetUser } = await supabase
            .from("users")
            .select("id,username,display_name")
            .ilike("username", escapedIdentifier)
            .limit(1)
            .maybeSingle();
          if (targetUser?.id && targetUser.id !== currentUserId) {
            await ensureDirectConversation(currentUserId, targetUser.id);
            const targetDisplayName = normalizeIdentityDisplayName(targetUser.display_name, targetUser.username, "usuario");
            setAddFriendFeedback({
              tone: "success",
              message: `${targetDisplayName} adicionado com sucesso.`,
            });
            setFriendIdentifier("");
            return;
          }
        } catch {
          // ignore fallback error and surface generic message below
        }
        setAddFriendFeedback({
          tone: "error",
          message: "Solicitacoes pendentes indisponiveis; rode a migracao friend_requests.",
        });
        return;
      }
      setAddFriendFeedback({
        tone: "error",
        message: "Nao foi possivel adicionar agora. Tente novamente.",
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

    cancelConversationPreload(normalizedConversationId);
    void preloadChatMessages({
      conversationId: normalizedConversationId,
      limit: DM_PRELOAD_LIMIT,
      maxAgeMs: DM_PRELOAD_MAX_AGE_MS,
    });
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
      firebaseUid: dm.firebaseUid,
      aboutText: dm.aboutText,
      bannerColor: dm.bannerColor ?? null,
      bannerKey: dm.bannerKey ?? null,
      bannerHash: dm.bannerHash ?? null,
      bannerSrc: dm.bannerSrc,
      memberSinceAt: dm.memberSinceAt ?? null,
    });
  }, [cancelConversationPreload, directMessages, onSelectDirectMessage]);

  return (
    <>
      <aside className="friends-sidebar">
        <div className="friends-sidebar__header">
          <span className="friends-sidebar__title">Messly</span>
          <div className="friends-sidebar__header-actions">
            <button
              className="friends-sidebar__action-button"
              type="button"
              aria-label="Adicionar amigo"
              onClick={handleOpenAddFriendModal}
            >
              <MaterialSymbolIcon name="person_add" size={18} />
            </button>
          </div>
        </div>

        <div className="friends-sidebar__content">
          <div className="friends-sidebar__section">
            <div className="friends-sidebar__section-label friends-sidebar__section-label--large">
              Acesso rapido
            </div>
            <button
              className="friends-sidebar__item friends-sidebar__item--active friends-sidebar__item--friends"
              type="button"
              onClick={() => {
                onOpenFriends?.();
              }}
            >
              <MaterialSymbolIcon className="friends-sidebar__item-icon" name="group" size={18} />
              <span className="friends-sidebar__item-text">Amigos</span>
            </button>
          </div>

          <div className="friends-sidebar__section">
            <div className="friends-sidebar__section-label friends-sidebar__section-label--large">
              Mensagens diretas
            </div>
            <div className="friends-sidebar__dm-list" role="list" aria-label="Mensagens diretas">
              {visibleDirectMessages.map((dm) => {
                const resolvedDisplayName = normalizeIdentityDisplayName(dm.displayName, dm.username, dm.username);
                const fallbackNameAvatar = getNameAvatarUrl(resolvedDisplayName);
                const safeDmAvatarSrc = (() => {
                  const raw = String(dm.avatarSrc ?? "").trim();
                  if (!raw || isDefaultAvatarUrl(raw)) {
                    return fallbackNameAvatar;
                  }
                  return raw;
                })();
                return (
                  <div
                    key={dm.conversationId}
                    className={`friends-sidebar__dm-item${
                      activeConversationId === dm.conversationId ? " friends-sidebar__dm-item--active" : ""
                    }`}
                    role="listitem"
                    onMouseEnter={() => {
                      scheduleConversationPreload(dm.conversationId);
                    }}
                    onMouseLeave={() => {
                      cancelConversationPreload(dm.conversationId);
                    }}
                    onFocus={() => {
                      scheduleConversationPreload(dm.conversationId);
                    }}
                    onBlur={() => {
                      cancelConversationPreload(dm.conversationId);
                    }}
                    onClick={() => {
                      cancelConversationPreload(dm.conversationId);
                      void preloadChatMessages({
                        conversationId: dm.conversationId,
                        limit: DM_PRELOAD_LIMIT,
                        maxAgeMs: DM_PRELOAD_MAX_AGE_MS,
                      });
                      if (dm.bannerKey) {
                        void getBannerUrl(dm.userId, dm.bannerKey, dm.bannerHash ?? null);
                      }
                      onSelectDirectMessage?.({
                        conversationId: dm.conversationId,
                        userId: dm.userId,
                        username: dm.username,
                        displayName: resolvedDisplayName,
                        avatarSrc: safeDmAvatarSrc,
                        presenceState: dm.presenceState,
                        firebaseUid: dm.firebaseUid,
                        aboutText: dm.aboutText,
                        bannerColor: dm.bannerColor ?? null,
                        bannerKey: dm.bannerKey ?? null,
                        bannerHash: dm.bannerHash ?? null,
                        bannerSrc: dm.bannerSrc,
                        memberSinceAt: dm.memberSinceAt ?? null,
                      });
                    }}
                  >
                    <div className="friends-sidebar__dm-avatar-wrap">
                      <img
                        className="friends-sidebar__dm-avatar"
                        src={safeDmAvatarSrc}
                        alt={`Avatar de ${resolvedDisplayName}`}
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.onerror = null;
                          event.currentTarget.src = fallbackNameAvatar;
                        }}
                      />
                      <span
                        className={`friends-sidebar__dm-presence friends-sidebar__dm-presence--${dm.presenceState}`}
                        aria-hidden="true"
                      />
                    </div>
                    <button className="friends-sidebar__dm-main" type="button">
                      <span className="friends-sidebar__dm-name">{resolvedDisplayName}</span>
                    </button>
                    <button
                      className="friends-sidebar__dm-close"
                      type="button"
                      aria-label={`Fechar DM de ${resolvedDisplayName}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setHiddenDmConversationIds((current) => {
                          if (current.includes(dm.conversationId)) {
                            return current;
                          }
                          return [...current, dm.conversationId];
                        });
                        if (activeConversationId === dm.conversationId) {
                          onOpenFriends?.();
                        }
                      }}
                    >
                      <MaterialSymbolIcon name="close" size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="friends-sidebar__user-card-wrap">
          <UserCard
            userId={identity.userId}
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
            Digite o username para enviar um pedido e iniciar uma conversa direta.
          </p>
          <label className="friends-sidebar__add-friend-label" htmlFor="add-friend-input">
            Username
          </label>
          <input
            id="add-friend-input"
            className="friends-sidebar__add-friend-input"
            type="text"
            value={friendIdentifier}
            onChange={(event) => setFriendIdentifier(event.target.value)}
            placeholder="@username"
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
    </>
  );
}
