import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import TopBar from "../components/layout/TopBar";
import ServerRail from "../components/layout/ServerRail";
import DirectMessagesSidebar from "../components/layout/DirectMessagesSidebar";
import type { SidebarDirectMessageSelection } from "../components/layout/DirectMessagesSidebar";
import MaterialSymbolIcon from "../components/ui/MaterialSymbolIcon";
import AppSettingsView from "../components/settings/AppSettingsView";
import DirectMessageChatView, { type DirectMessageChatParticipant } from "../components/chat/DirectMessageChatView";
import msgIcon from "../assets/images/msg.png";
import { presenceController } from "../services/presence/presenceController";
import { useAuthSession } from "../auth/AuthProvider";
import type { PresenceState } from "../services/presence/presenceTypes";
import { getAvatarUrl, getNameAvatarUrl, isDefaultAvatarUrl } from "../services/cdn/mediaUrls";
import { supabase } from "../services/supabase";
import { firebaseDatabase } from "../services/firebase";
import { escapeLikePattern, normalizeEmail } from "../services/usernameAvailability";
import { friendRequestsEnabled } from "../services/friends/friendRequests";
import {
  dispatchSidebarCallHangup,
  SIDEBAR_CALL_STATE_EVENT,
  type SidebarCallStateDetail,
} from "../services/calls/callUiPresence";

type FriendsTab = "online" | "all" | "pending";
type PendingDirection = "incoming" | "outgoing";

interface FriendRequestRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  created_at: string | null;
}

interface PendingFriendCard {
  requestId: string;
  targetUserId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  direction: PendingDirection;
  createdAt: string | null;
}

interface FriendListItem {
  requestId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  presenceState: PresenceState;
  firebaseUid?: string;
}

interface UserIdentityRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_key: string | null;
  avatar_hash: string | null;
  avatar_url?: string | null;
}

interface LegacyAvatarRow {
  user_id: string;
  avatar_url: string | null;
}

interface ProfileUpdatedDetail {
  userId: string;
  display_name?: string | null;
  username?: string | null;
}

interface ConversationIdentityRow {
  id: string;
  user1_id: string;
  user2_id: string;
}

interface DirectMessageUserRow extends UserIdentityRow {
  status?: string | null;
  firebase_uid?: string | null;
  about?: string | null;
  banner_color?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  created_at?: string | null;
}

interface CachedPendingAvatarEntry {
  signature: string;
  url: string;
}

interface CachedFriendAvatarEntry {
  signature: string;
  url: string;
}

const pendingAvatarCache = new Map<string, CachedPendingAvatarEntry>();
const friendAvatarCache = new Map<string, CachedFriendAvatarEntry>();
const friendPresenceCache = new Map<string, PresenceState>();
const FRIENDS_CACHE_PREFIX = "messly:friends:";
const FRIENDS_CACHE_VERSION = 1;
const CURRENT_USER_ID_CACHE_PREFIX = "messly:current-user-id:";

interface CachedFriendsPayload {
  version: number;
  items: FriendListItem[];
}

function getPendingDisplayAvatar(displayName: string, username: string): string {
  return getNameAvatarUrl(displayName || username || "U");
}

function buildPendingAvatarSignature(userRow: UserIdentityRow | undefined, legacyBackupUrl: string): string {
  return [
    String(userRow?.avatar_key ?? "").trim(),
    String(userRow?.avatar_hash ?? "").trim().toLowerCase(),
    String(userRow?.avatar_url ?? "").trim(),
    legacyBackupUrl.trim(),
  ].join("|");
}

function getCachedPendingAvatar(userId: string, signature: string): string | null {
  const cached = pendingAvatarCache.get(userId);
  if (!cached || cached.signature !== signature) {
    return null;
  }
  return cached.url;
}

function setCachedPendingAvatar(userId: string, signature: string, url: string): void {
  pendingAvatarCache.set(userId, {
    signature,
    url,
  });
}

function arePendingCardsEqual(current: PendingFriendCard[], next: PendingFriendCard[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentCard = current[index];
    const nextCard = next[index];
    if (
      currentCard.requestId !== nextCard.requestId ||
      currentCard.targetUserId !== nextCard.targetUserId ||
      currentCard.username !== nextCard.username ||
      currentCard.displayName !== nextCard.displayName ||
      currentCard.avatarSrc !== nextCard.avatarSrc ||
      currentCard.direction !== nextCard.direction ||
      currentCard.createdAt !== nextCard.createdAt
    ) {
      return false;
    }
  }

  return true;
}

function getFriendDisplayAvatar(displayName: string, username: string): string {
  return getNameAvatarUrl(displayName || username || "U");
}

function normalizeProfileDisplayName(
  displayNameRaw: string | null | undefined,
  usernameRaw: string | null | undefined,
  fallbackRaw: string | null | undefined = "",
): string {
  const displayName = String(displayNameRaw ?? "").trim();
  if (displayName && displayName.toLowerCase() !== "nome") {
    return displayName;
  }

  const username = String(usernameRaw ?? "").trim();
  if (username && username.toLowerCase() !== "username") {
    return username;
  }

  const fallback = String(fallbackRaw ?? "").trim();
  if (fallback) {
    return fallback;
  }

  return username || "Nome";
}

function isGeneratedInlineAvatarUrl(url: string | null | undefined): boolean {
  return String(url ?? "").startsWith("data:image/svg+xml,");
}

function isFriendFallbackAvatar(url: string | null | undefined): boolean {
  return isDefaultAvatarUrl(url) || isGeneratedInlineAvatarUrl(url);
}

function buildFriendAvatarSignature(userRow: UserIdentityRow | undefined, legacyBackupUrl: string): string {
  return [
    String(userRow?.avatar_key ?? "").trim(),
    String(userRow?.avatar_hash ?? "").trim().toLowerCase(),
    String(userRow?.avatar_url ?? "").trim(),
    legacyBackupUrl.trim(),
  ].join("|");
}

function getCachedFriendAvatar(userId: string, signature: string): string | null {
  const cached = friendAvatarCache.get(userId);
  if (!cached || cached.signature !== signature) {
    return null;
  }
  return cached.url;
}

function setCachedFriendAvatar(userId: string, signature: string, url: string): void {
  friendAvatarCache.set(userId, {
    signature,
    url,
  });
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
  if (raw === "invisible" || raw === "oculto" || raw === "hidden") {
    // Treat invisible as active for friend-list filtering ("Disponivel").
    return "idle";
  }
  if (raw === "dnd" || raw === "nao perturbar" || raw === "busy") {
    return "dnd";
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

function getPresenceSortRank(state: PresenceState): number {
  switch (state) {
    case "online":
      return 0;
    case "idle":
      return 1;
    case "dnd":
      return 2;
    default:
      return 3;
  }
}

function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getPresenceLabel(state: PresenceState): string {
  switch (state) {
    case "online":
      return "Online";
    case "idle":
      return "Ausente";
    case "dnd":
      return "Nao perturbar";
    default:
      return "Offline";
  }
}

function isAvailablePresence(state: PresenceState): boolean {
  return state !== "offline";
}

function areFriendListsEqual(current: FriendListItem[], next: FriendListItem[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentItem = current[index];
    const nextItem = next[index];
    if (
      currentItem.requestId !== nextItem.requestId ||
      currentItem.userId !== nextItem.userId ||
      currentItem.username !== nextItem.username ||
      currentItem.displayName !== nextItem.displayName ||
      currentItem.avatarSrc !== nextItem.avatarSrc ||
      currentItem.presenceState !== nextItem.presenceState ||
      (currentItem.firebaseUid ?? "") !== (nextItem.firebaseUid ?? "")
    ) {
      return false;
    }
  }

  return true;
}

function mergeFriendsWithoutAvatarDowngrade(current: FriendListItem[], next: FriendListItem[]): FriendListItem[] {
  if (current.length === 0) {
    return next;
  }

  const currentByUserId = new Map<string, FriendListItem>();
  current.forEach((item) => {
    currentByUserId.set(item.userId, item);
  });

  return next.map((item) => {
    const currentItem = currentByUserId.get(item.userId);
    if (!currentItem) {
      return item;
    }

    if (isFriendFallbackAvatar(item.avatarSrc) && !isFriendFallbackAvatar(currentItem.avatarSrc)) {
      return {
        ...item,
        avatarSrc: currentItem.avatarSrc,
      };
    }

    return item;
  });
}

function areSidebarSelectionsEqual(
  current: SidebarDirectMessageSelection[],
  next: SidebarDirectMessageSelection[],
): boolean {
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

function getConversationIdFromHash(hashRaw: string): string | null {
  const hash = String(hashRaw ?? "").trim();
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) {
    return null;
  }

  const query = hash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  const conversationId = String(params.get("conversation") ?? "").trim();
  return conversationId || null;
}

function readFriendsCache(userId: string | null | undefined): FriendListItem[] | null {
  if (!userId || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${FRIENDS_CACHE_PREFIX}${userId}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedFriendsPayload>;
    if (parsed.version !== FRIENDS_CACHE_VERSION || !Array.isArray(parsed.items)) {
      return null;
    }

    return parsed.items
      .map((item): FriendListItem | null => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const casted = item as Partial<FriendListItem>;
        const requestId = String(casted.requestId ?? "").trim();
        const userIdValue = String(casted.userId ?? "").trim();
        if (!requestId || !userIdValue) {
          return null;
        }

        const username = String(casted.username ?? "").trim() || "username";
        const displayName = normalizeProfileDisplayName(casted.displayName, username, username);
        const avatarSrc = String(casted.avatarSrc ?? "").trim() || getFriendDisplayAvatar(displayName, username);
        const firebaseUid = String((casted as { firebaseUid?: string | null }).firebaseUid ?? "").trim();

        return {
          requestId,
          userId: userIdValue,
          username,
          displayName,
          avatarSrc,
          presenceState: normalizePresenceState((casted as { presenceState?: unknown }).presenceState ?? null),
          ...(firebaseUid ? { firebaseUid } : {}),
        };
      })
      .filter((item): item is FriendListItem => item !== null);
  } catch {
    return null;
  }
}

function writeFriendsCache(userId: string | null | undefined, items: FriendListItem[]): void {
  if (!userId || typeof window === "undefined") {
    return;
  }

  try {
    const key = `${FRIENDS_CACHE_PREFIX}${userId}`;
    const payload: CachedFriendsPayload = {
      version: FRIENDS_CACHE_VERSION,
      items,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage write failures
  }
}

function readCachedCurrentUserId(firebaseUid: string | null | undefined): string | null {
  if (!firebaseUid || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${CURRENT_USER_ID_CACHE_PREFIX}${firebaseUid}`;
    const value = String(window.localStorage.getItem(key) ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeCachedCurrentUserId(firebaseUid: string | null | undefined, userId: string | null | undefined): void {
  if (!firebaseUid || typeof window === "undefined") {
    return;
  }

  try {
    const key = `${CURRENT_USER_ID_CACHE_PREFIX}${firebaseUid}`;
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, normalizedUserId);
  } catch {
    // ignore storage write failures
  }
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

function isUserBlocksUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: string; message?: string; details?: string };
  const message = String(candidate.message ?? "").toLowerCase();
  const details = String(candidate.details ?? "").toLowerCase();
  return (
    candidate.code === "42P01" ||
    candidate.code === "PGRST205" ||
    message.includes("user_blocks") ||
    details.includes("user_blocks")
  );
}

function isUsersSchemaColumnCacheError(message: string): boolean {
  return message.includes("column of 'users' in the schema cache");
}

function isMissingAvatarUrlColumnError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("avatar_url") && normalized.includes("users");
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

async function queryCurrentUserId(firebaseUid: string, email: string | null | undefined): Promise<string | null> {
  const byUid = await supabase.from("users").select("id").eq("firebase_uid", firebaseUid).limit(1).maybeSingle();
  if (!byUid.error && byUid.data?.id) {
    return byUid.data.id as string;
  }

  if (byUid.error && !isUsersSchemaColumnCacheError(byUid.error.message ?? "")) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email ?? "");
  if (!normalizedEmail) {
    return null;
  }
  const escapedEmail = escapeLikePattern(normalizedEmail);
  const byEmail = await supabase.from("users").select("id").ilike("email", escapedEmail).limit(1).maybeSingle();
  if (byEmail.error) {
    return null;
  }
  return (byEmail.data?.id as string | undefined) ?? null;
}

async function ensureDirectConversation(userA: string, userB: string): Promise<string> {
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
    return existingConversation.id as string;
  }

  const { data: createdConversation, error: createError } = await supabase
    .from("conversations")
    .insert({
      user1_id: user1Id,
      user2_id: user2Id,
    })
    .select("id")
    .limit(1)
    .maybeSingle();

  if (createError) {
    if (createError.code === "23505") {
      const { data: retriedConversation, error: retriedError } = await supabase
        .from("conversations")
        .select("id")
        .eq("user1_id", user1Id)
        .eq("user2_id", user2Id)
        .limit(1)
        .maybeSingle();
      if (retriedError) {
        throw retriedError;
      }
      if (retriedConversation?.id) {
        return retriedConversation.id as string;
      }
    }
    throw createError;
  }

  if (!createdConversation?.id) {
    throw new Error("Nao foi possivel resolver a conversa direta.");
  }

  return createdConversation.id as string;
}

export default function AppShell() {
  const { user } = useAuthSession();
  const [presenceState, setPresenceState] = useState<PresenceState>(() => presenceController.getState());
  const [isWindowFocused, setIsWindowFocused] = useState<boolean>(() =>
    typeof document === "undefined" ? true : !document.hidden && document.hasFocus(),
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeFriendsTab, setActiveFriendsTab] = useState<FriendsTab>("online");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [friends, setFriends] = useState<FriendListItem[]>([]);
  const [hasInitializedFriends, setHasInitializedFriends] = useState(false);
  const [isFriendsLoading, setIsFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [pendingCards, setPendingCards] = useState<PendingFriendCard[]>([]);
  const [isPendingLoading, setIsPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [isFriendRequestsAvailable, setIsFriendRequestsAvailable] = useState(friendRequestsEnabled);
  const [activeFriendMenuUserId, setActiveFriendMenuUserId] = useState<string | null>(null);
  const [friendSearchTerm, setFriendSearchTerm] = useState("");
  const [activeDirectMessage, setActiveDirectMessage] = useState<SidebarDirectMessageSelection | null>(null);
  const [sidebarDirectMessages, setSidebarDirectMessages] = useState<SidebarDirectMessageSelection[]>([]);
  const [pendingNotificationConversationId, setPendingNotificationConversationId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return getConversationIdFromHash(window.location.hash);
  });
  const [callHostDirectMessage, setCallHostDirectMessage] = useState<SidebarDirectMessageSelection | null>(null);
  const [isSidebarCallActive, setIsSidebarCallActive] = useState(false);
  const [currentUserChatProfile, setCurrentUserChatProfile] = useState<DirectMessageChatParticipant | null>(null);
  const friendsRefreshInFlightRef = useRef(false);
  const friendsRefreshQueuedRef = useRef(false);
  const pendingRefreshInFlightRef = useRef(false);
  const pendingRefreshQueuedRef = useRef(false);
  const sidebarDirectMessagesByConversationId = useMemo(() => {
    const map = new Map<string, SidebarDirectMessageSelection>();
    sidebarDirectMessages.forEach((item) => {
      map.set(item.conversationId, item);
    });
    return map;
  }, [sidebarDirectMessages]);
  const handleChangePresence = (state: PresenceState): void => {
    presenceController.setPreferredState(state);
  };

  const handlePrepareForUpdateInstall = useCallback(async (): Promise<void> => {
    if (!isSidebarCallActive) {
      return;
    }
    dispatchSidebarCallHangup();
    await new Promise((resolve) => {
      window.setTimeout(resolve, 300);
    });
  }, [isSidebarCallActive]);

  const handleSidebarDirectMessagesChange = useCallback((items: SidebarDirectMessageSelection[]): void => {
    setSidebarDirectMessages((current) => (areSidebarSelectionsEqual(current, items) ? current : items));
  }, []);

  useEffect(() => {
    const updateFocusState = (): void => {
      const nextFocusState = !document.hidden && document.hasFocus();
      setIsWindowFocused(nextFocusState);
    };

    updateFocusState();
    window.addEventListener("focus", updateFocusState);
    window.addEventListener("blur", updateFocusState);
    document.addEventListener("visibilitychange", updateFocusState);

    return () => {
      window.removeEventListener("focus", updateFocusState);
      window.removeEventListener("blur", updateFocusState);
      document.removeEventListener("visibilitychange", updateFocusState);
    };
  }, []);

  useEffect(() => {
    if (!activeDirectMessage) {
      return;
    }
    setCallHostDirectMessage(activeDirectMessage);
  }, [activeDirectMessage]);

  useEffect(() => {
    const handleSidebarCallState = (event: Event): void => {
      const detail = (event as CustomEvent<SidebarCallStateDetail>).detail;
      if (!detail) {
        return;
      }

      const callActive = Boolean(detail.active);
      setIsSidebarCallActive(callActive);
      if (!callActive) {
        return;
      }

      const callConversationId = String(detail.conversationId ?? "").trim();
      if (!callConversationId) {
        return;
      }

      if (activeDirectMessage && activeDirectMessage.conversationId === callConversationId) {
        setCallHostDirectMessage(activeDirectMessage);
      }
    };

    window.addEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    return () => {
      window.removeEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    };
  }, [activeDirectMessage]);

  useEffect(() => {
    return presenceController.subscribe(setPresenceState);
  }, []);

  useEffect(() => {
    const firebaseUid = user?.uid;
    if (!firebaseUid) {
      presenceController.stop();
      return;
    }

    presenceController.start(firebaseUid);

    return () => {
      presenceController.stop();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSettingsOpen]);

  useEffect(() => {
    const firebaseUid = user?.uid;
    if (!firebaseUid) {
      setCurrentUserId(null);
      return;
    }

    const cachedUserId = readCachedCurrentUserId(firebaseUid);
    if (cachedUserId) {
      setCurrentUserId((current) => (current === cachedUserId ? current : cachedUserId));
    }

    let isMounted = true;
    void queryCurrentUserId(firebaseUid, user?.email).then((resolvedUserId) => {
      if (!isMounted) {
        return;
      }

      if (resolvedUserId) {
        writeCachedCurrentUserId(firebaseUid, resolvedUserId);
        setCurrentUserId((current) => (current === resolvedUserId ? current : resolvedUserId));
        return;
      }

      writeCachedCurrentUserId(firebaseUid, null);
      setCurrentUserId(null);
    });

    return () => {
      isMounted = false;
    };
  }, [user?.email, user?.uid]);

  useEffect(() => {
    if (!currentUserId) {
      setCurrentUserChatProfile(null);
      return;
    }

    let isMounted = true;

    const fallbackDisplayName = String(user?.displayName ?? "").trim() || "Voce";
    const fallbackUsername = "voce";
    const fallbackAvatar = getNameAvatarUrl(fallbackDisplayName || fallbackUsername || "U");

    setCurrentUserChatProfile((current) =>
      current && current.userId === currentUserId
        ? current
        : {
            userId: currentUserId,
            displayName: fallbackDisplayName,
            username: fallbackUsername,
            avatarSrc: fallbackAvatar,
            presenceState: current?.presenceState ?? "offline",
          },
    );

    void (async () => {
      try {
        const primaryResult = await supabase
          .from("users")
          .select("id,username,display_name,avatar_key,avatar_hash,avatar_url")
          .eq("id", currentUserId)
          .limit(1)
          .maybeSingle();

        let userRow = primaryResult.data as UserIdentityRow | null;
        let userError = primaryResult.error;

        if (userError && isMissingAvatarUrlColumnError(userError.message ?? "")) {
          const fallbackResult = await supabase
            .from("users")
            .select("id,username,display_name,avatar_key,avatar_hash")
            .eq("id", currentUserId)
            .limit(1)
            .maybeSingle();
          userRow = fallbackResult.data as UserIdentityRow | null;
          userError = fallbackResult.error;
        }

        if (userError) {
          return;
        }

        const username = String(userRow?.username ?? "").trim() || fallbackUsername;
        const displayName = normalizeProfileDisplayName(userRow?.display_name, username, fallbackDisplayName);
        const legacyAvatarUrl = String(userRow?.avatar_url ?? "").trim();
        const backupAvatarUrl = (await loadLegacyAvatarMap([currentUserId])).get(currentUserId) ?? "";

        let avatarSrc = fallbackAvatar;
        try {
          const primaryAvatar = await getAvatarUrl(currentUserId, userRow?.avatar_key ?? null, userRow?.avatar_hash ?? null);
          avatarSrc = primaryAvatar;
          if (isDefaultAvatarUrl(primaryAvatar)) {
            const legacySource = legacyAvatarUrl || backupAvatarUrl;
            if (legacySource) {
              const resolvedLegacyAvatar = await getAvatarUrl(currentUserId, legacySource, userRow?.avatar_hash ?? null);
              avatarSrc = isDefaultAvatarUrl(resolvedLegacyAvatar)
                ? getNameAvatarUrl(displayName || username || "U")
                : resolvedLegacyAvatar;
            } else {
              avatarSrc = getNameAvatarUrl(displayName || username || "U");
            }
          }
        } catch {
          avatarSrc = getNameAvatarUrl(displayName || username || "U");
        }

        if (!isMounted) {
          return;
        }

        setCurrentUserChatProfile({
          userId: currentUserId,
          displayName,
          username,
          avatarSrc,
          presenceState: "offline",
        });
      } catch {
        // keep fallback profile when query fails
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [currentUserId, user?.displayName]);

  useEffect(() => {
    setCurrentUserChatProfile((current) => (current ? { ...current, presenceState } : current));
  }, [presenceState]);

  useEffect(() => {
    const handleProfileUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileUpdatedDetail>).detail;
      if (!detail?.userId || detail.userId !== currentUserId) {
        return;
      }

      setCurrentUserChatProfile((current) => {
        if (!current || current.userId !== detail.userId) {
          return current;
        }

        const nextUsername = String(detail.username ?? "").trim() || current.username;
        const nextDisplayName = normalizeProfileDisplayName(detail.display_name, nextUsername, current.displayName);
        if (nextUsername === current.username && nextDisplayName === current.displayName) {
          return current;
        }

        return {
          ...current,
          username: nextUsername,
          displayName: nextDisplayName,
        };
      });
    };

    window.addEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    };
  }, [currentUserId]);

  const resolveDirectMessageByConversationId = useCallback(
    async (conversationIdRaw: string): Promise<SidebarDirectMessageSelection | null> => {
      const normalizedConversationId = String(conversationIdRaw ?? "").trim();
      if (!normalizedConversationId || !currentUserId) {
        return null;
      }

      const cached = sidebarDirectMessagesByConversationId.get(normalizedConversationId);
      if (cached) {
        return cached;
      }

      const { data: conversation, error: conversationError } = await supabase
        .from("conversations")
        .select("id,user1_id,user2_id")
        .eq("id", normalizedConversationId)
        .limit(1)
        .maybeSingle();

      if (conversationError || !conversation) {
        return null;
      }

      const typedConversation = conversation as ConversationIdentityRow;
      if (typedConversation.user1_id !== currentUserId && typedConversation.user2_id !== currentUserId) {
        return null;
      }

      const targetUserId =
        typedConversation.user1_id === currentUserId ? typedConversation.user2_id : typedConversation.user1_id;
      if (!targetUserId) {
        return null;
      }

      const userWithLegacyAvatar = await supabase
        .from("users")
        .select("id,username,display_name,avatar_key,avatar_hash,avatar_url,status,firebase_uid,about,banner_color,banner_key,banner_hash,created_at")
        .eq("id", targetUserId)
        .limit(1)
        .maybeSingle();

      let userRow = userWithLegacyAvatar.data as DirectMessageUserRow | null;
      let userError = userWithLegacyAvatar.error;

      if (userError && isMissingAvatarUrlColumnError(userError.message ?? "")) {
        const userWithoutLegacyAvatar = await supabase
          .from("users")
          .select("id,username,display_name,avatar_key,avatar_hash,status,firebase_uid,about,banner_color,banner_key,banner_hash,created_at")
          .eq("id", targetUserId)
          .limit(1)
          .maybeSingle();
        userRow = userWithoutLegacyAvatar.data as DirectMessageUserRow | null;
        userError = userWithoutLegacyAvatar.error;
      }

      if (userError || !userRow) {
        return null;
      }

      const username = String(userRow.username ?? "").trim() || "username";
      const displayName = normalizeProfileDisplayName(userRow.display_name, username, username);
      const fallbackAvatar = getFriendDisplayAvatar(displayName, username);

      let avatarSrc = fallbackAvatar;
      try {
        const primaryAvatar = await getAvatarUrl(targetUserId, userRow.avatar_key ?? null, userRow.avatar_hash ?? null);
        avatarSrc = primaryAvatar;
        if (isDefaultAvatarUrl(primaryAvatar)) {
          const legacyAvatarUrl = String(userRow.avatar_url ?? "").trim();
          if (legacyAvatarUrl) {
            const resolvedLegacyAvatar = await getAvatarUrl(targetUserId, legacyAvatarUrl, userRow.avatar_hash ?? null);
            avatarSrc = isDefaultAvatarUrl(resolvedLegacyAvatar) ? fallbackAvatar : resolvedLegacyAvatar;
          } else {
            avatarSrc = fallbackAvatar;
          }
        }
      } catch {
        avatarSrc = fallbackAvatar;
      }

      return {
        conversationId: typedConversation.id,
        userId: targetUserId,
        username,
        displayName,
        avatarSrc,
        presenceState: normalizePresenceState(userRow.status ?? null),
        firebaseUid: String(userRow.firebase_uid ?? "").trim() || undefined,
        aboutText: String(userRow.about ?? "").trim(),
        bannerColor: userRow.banner_color ?? null,
        bannerKey: userRow.banner_key ?? null,
        bannerHash: userRow.banner_hash ?? null,
        memberSinceAt: userRow.created_at ?? null,
      };
    },
    [currentUserId, sidebarDirectMessagesByConversationId],
  );

  const openDirectMessageConversationById = useCallback(
    async (conversationIdRaw: string): Promise<void> => {
      const normalizedConversationId = String(conversationIdRaw ?? "").trim();
      if (!normalizedConversationId) {
        return;
      }
      if (!currentUserId) {
        setPendingNotificationConversationId(normalizedConversationId);
        return;
      }

      const selection = await resolveDirectMessageByConversationId(normalizedConversationId);
      if (!selection) {
        return;
      }

      setActiveDirectMessage(selection);
      setPendingNotificationConversationId(null);
    },
    [currentUserId, resolveDirectMessageByConversationId],
  );

  useEffect(() => {
    const consumeHashConversation = (): void => {
      const conversationId = getConversationIdFromHash(window.location.hash);
      if (!conversationId) {
        return;
      }
      setPendingNotificationConversationId(conversationId);
    };

    consumeHashConversation();
    window.addEventListener("hashchange", consumeHashConversation);
    return () => {
      window.removeEventListener("hashchange", consumeHashConversation);
    };
  }, []);

  useEffect(() => {
    if (!pendingNotificationConversationId || !currentUserId) {
      return;
    }

    void openDirectMessageConversationById(pendingNotificationConversationId).finally(() => {
      const currentHash = window.location.hash;
      const queryIndex = currentHash.indexOf("?");
      if (queryIndex >= 0) {
        const cleanHash = currentHash.slice(0, queryIndex);
        window.history.replaceState(
          null,
          document.title,
          `${window.location.pathname}${window.location.search}${cleanHash}`,
        );
      }
      setPendingNotificationConversationId(null);
    });
  }, [currentUserId, openDirectMessageConversationById, pendingNotificationConversationId]);

  const refreshFriends = async (showLoading = false): Promise<void> => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      setFriends((current) => (current.length === 0 ? current : []));
      return;
    }

    if (friendsRefreshInFlightRef.current) {
      friendsRefreshQueuedRef.current = true;
      return;
    }

    friendsRefreshInFlightRef.current = true;
    let shouldShowLoading = showLoading;

    try {
      do {
        friendsRefreshQueuedRef.current = false;

        if (shouldShowLoading) {
          setIsFriendsLoading(true);
        }
        setFriendsError(null);

        try {
          const { data: requests, error: requestsError } = await supabase
            .from("friend_requests")
            .select("id,requester_id,addressee_id,status,created_at")
            .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`)
            .eq("status", "accepted")
            .order("created_at", { ascending: false });

          if (requestsError) {
            throw requestsError;
          }

          const typedRequests = (requests ?? []) as FriendRequestRow[];
          if (typedRequests.length === 0) {
            setFriends((current) => (current.length === 0 ? current : []));
            continue;
          }

          const friendRequestByUserId = new Map<string, string>();
          typedRequests.forEach((request) => {
            const friendId = request.requester_id === currentUserId ? request.addressee_id : request.requester_id;
            if (!friendRequestByUserId.has(friendId)) {
              friendRequestByUserId.set(friendId, request.id);
            }
          });

          const friendIds = Array.from(friendRequestByUserId.keys());

          const usersWithLegacyAvatar = await supabase
            .from("users")
            .select("id,username,display_name,avatar_key,avatar_hash,avatar_url,status,firebase_uid")
            .in("id", friendIds);

          let users = usersWithLegacyAvatar.data as (UserIdentityRow & { status?: string | null; firebase_uid?: string | null })[] | null;
          let usersError = usersWithLegacyAvatar.error;

          if (usersError && isMissingAvatarUrlColumnError(usersError.message ?? "")) {
            const usersWithoutLegacyAvatar = await supabase
              .from("users")
              .select("id,username,display_name,avatar_key,avatar_hash,status,firebase_uid")
              .in("id", friendIds);
            users = usersWithoutLegacyAvatar.data as (UserIdentityRow & { status?: string | null; firebase_uid?: string | null })[] | null;
            usersError = usersWithoutLegacyAvatar.error;
          }

          if (usersError) {
            throw usersError;
          }

          const usersById = new Map<string, (UserIdentityRow & { status?: string | null; firebase_uid?: string | null })>();
          (users ?? []).forEach((row) => {
            usersById.set(row.id, row);
          });

          const initialFriends: FriendListItem[] = [];
          friendIds.forEach((friendId) => {
            const requestId = friendRequestByUserId.get(friendId);
            if (!requestId) {
              return;
            }

            const friendRow = usersById.get(friendId);
            const username = String(friendRow?.username ?? "").trim() || "username";
            const displayName = normalizeProfileDisplayName(friendRow?.display_name, username, username);
            const avatarSignature = buildFriendAvatarSignature(friendRow, "");
            const cachedAvatar = getCachedFriendAvatar(friendId, avatarSignature);
            const fallbackPresence = normalizePresenceState(friendRow?.status ?? null);
            const resolvedPresence = friendPresenceCache.get(friendId) ?? fallbackPresence;
            friendPresenceCache.set(friendId, resolvedPresence);

            initialFriends.push({
              requestId,
              userId: friendId,
              username,
              displayName,
              avatarSrc: cachedAvatar ?? getFriendDisplayAvatar(displayName, username),
              presenceState: resolvedPresence,
              firebaseUid: String(friendRow?.firebase_uid ?? "").trim() || undefined,
            });
          });

          setFriends((current) => {
            const mergedFriends = mergeFriendsWithoutAvatarDowngrade(current, initialFriends);
            return areFriendListsEqual(current, mergedFriends) ? current : mergedFriends;
          });

          const legacyAvatarMap = await loadLegacyAvatarMap(friendIds);
          const avatarEntries = await Promise.all(
            friendIds.map(async (friendId) => {
              const friendRow = usersById.get(friendId);
              if (!friendRow) {
                return [friendId, getFriendDisplayAvatar("U", "U")] as const;
              }

              const username = String(friendRow.username ?? "").trim() || "username";
              const displayName = normalizeProfileDisplayName(friendRow.display_name, username, username);
              const legacyAvatarUrl = String(friendRow.avatar_url ?? "").trim();
              const backupAvatarUrl = legacyAvatarMap.get(friendId) ?? "";
              const avatarSignature = buildFriendAvatarSignature(friendRow, backupAvatarUrl);
              const cachedAvatar = getCachedFriendAvatar(friendId, avatarSignature);
              if (cachedAvatar) {
                return [friendId, cachedAvatar] as const;
              }

              try {
                const primaryAvatar = await getAvatarUrl(friendId, friendRow.avatar_key ?? null, friendRow.avatar_hash ?? null);
                let avatarSrc = primaryAvatar;
                if (isDefaultAvatarUrl(primaryAvatar)) {
                  const legacySource = legacyAvatarUrl || backupAvatarUrl;
                  if (legacySource) {
                    const resolvedLegacyAvatar = await getAvatarUrl(friendId, legacySource, friendRow.avatar_hash ?? null);
                    avatarSrc = isDefaultAvatarUrl(resolvedLegacyAvatar)
                      ? getFriendDisplayAvatar(displayName, username)
                      : resolvedLegacyAvatar;
                  } else {
                    avatarSrc = getFriendDisplayAvatar(displayName, username);
                  }
                }
                setCachedFriendAvatar(friendId, avatarSignature, avatarSrc);
                return [friendId, avatarSrc] as const;
              } catch {
                const fallbackAvatar = getFriendDisplayAvatar(displayName, username);
                setCachedFriendAvatar(friendId, avatarSignature, fallbackAvatar);
                return [friendId, fallbackAvatar] as const;
              }
            }),
          );

          const avatarMap = new Map<string, string>(avatarEntries);
          const hydratedFriends = initialFriends.map((friend) => ({
            ...friend,
            avatarSrc: avatarMap.get(friend.userId) ?? friend.avatarSrc,
          }));

          setFriends((current) => {
            const mergedFriends = mergeFriendsWithoutAvatarDowngrade(current, hydratedFriends);
            return areFriendListsEqual(current, mergedFriends) ? current : mergedFriends;
          });
        } catch (error) {
          if (isFriendRequestsUnavailableError(error)) {
            setIsFriendRequestsAvailable(false);
            setFriendsError("Solicitacoes de amizade indisponiveis no banco.");
            setFriends((current) => (current.length === 0 ? current : []));
            return;
          }
          setFriendsError("Nao foi possivel carregar a lista de amigos.");
          setFriends((current) => (current.length === 0 ? current : []));
        } finally {
          if (shouldShowLoading) {
            setIsFriendsLoading(false);
            shouldShowLoading = false;
          }
        }
      } while (friendsRefreshQueuedRef.current);
    } finally {
      friendsRefreshInFlightRef.current = false;
      setHasInitializedFriends(true);
    }
  };

  const refreshPendingRequests = async (showLoading = false): Promise<void> => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      setPendingCards((current) => (current.length === 0 ? current : []));
      return;
    }

    if (pendingRefreshInFlightRef.current) {
      pendingRefreshQueuedRef.current = true;
      return;
    }

    pendingRefreshInFlightRef.current = true;
    let shouldShowLoading = showLoading;

    try {
      do {
        pendingRefreshQueuedRef.current = false;

        if (shouldShowLoading) {
          setIsPendingLoading(true);
        }
        setPendingError(null);

        try {
          const { data: requests, error: requestsError } = await supabase
            .from("friend_requests")
            .select("id,requester_id,addressee_id,status,created_at")
            .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`)
            .eq("status", "pending")
            .order("created_at", { ascending: false });

          if (requestsError) {
            throw requestsError;
          }

          const typedRequests = (requests ?? []) as FriendRequestRow[];
          if (typedRequests.length === 0) {
            setPendingCards((current) => (current.length === 0 ? current : []));
            continue;
          }

          const targetIds = Array.from(
            new Set(
              typedRequests.map((request) =>
                request.requester_id === currentUserId ? request.addressee_id : request.requester_id,
              ),
            ),
          );

          const usersWithLegacyAvatar = await supabase
            .from("users")
            .select("id,username,display_name,avatar_key,avatar_hash,avatar_url")
            .in("id", targetIds);

          let users = usersWithLegacyAvatar.data as UserIdentityRow[] | null;
          let usersError = usersWithLegacyAvatar.error;

          if (usersError && isMissingAvatarUrlColumnError(usersError.message ?? "")) {
            const usersWithoutLegacyAvatar = await supabase
              .from("users")
              .select("id,username,display_name,avatar_key,avatar_hash")
              .in("id", targetIds);
            users = usersWithoutLegacyAvatar.data as UserIdentityRow[] | null;
            usersError = usersWithoutLegacyAvatar.error;
          }

          if (usersError) {
            throw usersError;
          }

          const userMap = new Map<string, UserIdentityRow>();
          ((users ?? []) as UserIdentityRow[]).forEach((userRow) => {
            userMap.set(userRow.id, userRow);
          });

          // Fast first paint with cached or generated avatars.
          const initialCards: PendingFriendCard[] = typedRequests.map((request) => {
            const targetUserId = request.requester_id === currentUserId ? request.addressee_id : request.requester_id;
            const targetUser = userMap.get(targetUserId);
            const username = (targetUser?.username ?? "").trim() || "username";
            const displayName = normalizeProfileDisplayName(targetUser?.display_name, username, username);
            const avatarSignature = buildPendingAvatarSignature(targetUser, "");
            const cachedAvatar = getCachedPendingAvatar(targetUserId, avatarSignature);

            return {
              requestId: request.id,
              targetUserId,
              username,
              displayName,
              avatarSrc: cachedAvatar ?? getPendingDisplayAvatar(displayName, username),
              direction: request.addressee_id === currentUserId ? "incoming" : "outgoing",
              createdAt: request.created_at ?? null,
            };
          });

          setPendingCards((current) => (arePendingCardsEqual(current, initialCards) ? current : initialCards));

          const legacyAvatarMap = await loadLegacyAvatarMap(targetIds);
          const avatars = await Promise.all(
            targetIds.map(async (id) => {
              const userRow = userMap.get(id);
              if (!userRow) {
                return [id, getPendingDisplayAvatar("U", "U")] as const;
              }

              const username = (userRow.username ?? "").trim() || "username";
              const displayName = normalizeProfileDisplayName(userRow.display_name, username, username);
              const legacyAvatarUrl = String(userRow.avatar_url ?? "").trim();
              const backupAvatarUrl = legacyAvatarMap.get(id) ?? "";
              const avatarSignature = buildPendingAvatarSignature(userRow, backupAvatarUrl);
              const cachedAvatar = getCachedPendingAvatar(id, avatarSignature);
              if (cachedAvatar) {
                return [id, cachedAvatar] as const;
              }

              try {
                const primaryAvatarSrc = await getAvatarUrl(id, userRow.avatar_key ?? null, userRow.avatar_hash ?? null);
                let avatarSrc = primaryAvatarSrc;
                if (isDefaultAvatarUrl(primaryAvatarSrc)) {
                  const legacySource = legacyAvatarUrl || backupAvatarUrl;
                  if (legacySource) {
                    const resolvedLegacyAvatar = await getAvatarUrl(id, legacySource, userRow.avatar_hash ?? null);
                    avatarSrc = isDefaultAvatarUrl(resolvedLegacyAvatar)
                      ? getPendingDisplayAvatar(displayName, username)
                      : resolvedLegacyAvatar;
                  } else {
                    avatarSrc = getPendingDisplayAvatar(displayName, username);
                  }
                }

                setCachedPendingAvatar(id, avatarSignature, avatarSrc);
                return [id, avatarSrc] as const;
              } catch {
                const fallbackAvatar = getPendingDisplayAvatar(displayName, username);
                setCachedPendingAvatar(id, avatarSignature, fallbackAvatar);
                return [id, fallbackAvatar] as const;
              }
            }),
          );
          const avatarMap = new Map<string, string>(avatars);

          const hydratedCards = initialCards.map((card) => ({
            ...card,
            avatarSrc: avatarMap.get(card.targetUserId) ?? card.avatarSrc,
          }));

          setPendingCards((current) => (arePendingCardsEqual(current, hydratedCards) ? current : hydratedCards));
        } catch (error) {
          if (isFriendRequestsUnavailableError(error)) {
            setIsFriendRequestsAvailable(false);
            setPendingError(null);
            setPendingCards((current) => (current.length === 0 ? current : []));
            return;
          }
          setPendingError("Nao foi possivel carregar as solicitacoes pendentes.");
          setPendingCards((current) => (current.length === 0 ? current : []));
        } finally {
          if (shouldShowLoading) {
            setIsPendingLoading(false);
            shouldShowLoading = false;
          }
        }
      } while (pendingRefreshQueuedRef.current);
    } finally {
      pendingRefreshInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!isFriendRequestsAvailable) {
      setHasInitializedFriends(false);
      setFriends([]);
      return;
    }
    if (!currentUserId) {
      setHasInitializedFriends(false);
      return;
    }
    setHasInitializedFriends(false);
    void refreshFriends(true);
  }, [currentUserId, isFriendRequestsAvailable]);

  useEffect(() => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    const cached = readFriendsCache(currentUserId);
    if (!cached || cached.length === 0) {
      return;
    }

    setHasInitializedFriends(true);
    cached.forEach((friend) => {
      friendPresenceCache.set(friend.userId, friend.presenceState);
    });

    setFriends((current) => (areFriendListsEqual(current, cached) ? current : cached));
  }, [currentUserId, isFriendRequestsAvailable]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }
    writeFriendsCache(currentUserId, friends);
  }, [currentUserId, friends]);

  useEffect(() => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshFriends(false);
    }, 30000);

    const handleVisibilityOrFocus = (): void => {
      void refreshFriends(false);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refreshFriends(false);
      }
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentUserId, isFriendRequestsAvailable]);

  const friendsPresenceSubscriptionKey = useMemo(() => {
    const uniqueEntries = new Map<string, string>();
    friends.forEach((friend) => {
      const firebaseUid = String(friend.firebaseUid ?? "").trim();
      if (!firebaseUid || uniqueEntries.has(firebaseUid)) {
        return;
      }
      uniqueEntries.set(firebaseUid, friend.userId);
    });

    return Array.from(uniqueEntries.entries())
      .sort(([uidA], [uidB]) => uidA.localeCompare(uidB))
      .map(([firebaseUid, userId]) => `${firebaseUid}:${userId}`)
      .join("|");
  }, [friends]);

  useEffect(() => {
    if (!friendsPresenceSubscriptionKey) {
      return;
    }

    const entries = friendsPresenceSubscriptionKey
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
          setFriends((current) => {
            let changed = false;
            const updated = current.map((friend) => {
              if (String(friend.firebaseUid ?? "").trim() !== firebaseUid) {
                return friend;
              }
              friendPresenceCache.set(friend.userId, nextPresence);
              if (friend.presenceState === nextPresence) {
                return friend;
              }
              changed = true;
              return {
                ...friend,
                presenceState: nextPresence,
              };
            });
            return changed ? updated : current;
          });
        },
        () => {
          // Keep last known presence during transient network issues to avoid UI flicker.
        },
      ),
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }, [friendsPresenceSubscriptionKey]);

  useEffect(() => {
    setActiveFriendMenuUserId((current) => {
      if (!current) {
        return current;
      }
      return friends.some((friend) => friend.userId === current) ? current : null;
    });
  }, [friends]);

  useEffect(() => {
    setActiveDirectMessage((current) => {
      if (!current) {
        return current;
      }

      const matchedFriend = friends.find((friend) => friend.userId === current.userId);
      if (!matchedFriend) {
        return current;
      }

      if (
        current.displayName === matchedFriend.displayName &&
        current.username === matchedFriend.username &&
        current.avatarSrc === matchedFriend.avatarSrc &&
        current.presenceState === matchedFriend.presenceState &&
        (current.firebaseUid ?? "") === (matchedFriend.firebaseUid ?? "")
      ) {
        return current;
      }

      return {
        ...current,
        displayName: matchedFriend.displayName,
        username: matchedFriend.username,
        avatarSrc: matchedFriend.avatarSrc,
        presenceState: matchedFriend.presenceState,
        firebaseUid: matchedFriend.firebaseUid,
      };
    });
  }, [friends]);

  useEffect(() => {
    if (!activeFriendMenuUserId) {
      return;
    }

    const handleOutsidePointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".main-panel__friend-menu-wrap")) {
        return;
      }
      setActiveFriendMenuUserId(null);
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setActiveFriendMenuUserId(null);
      }
    };

    window.addEventListener("mousedown", handleOutsidePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handleOutsidePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [activeFriendMenuUserId]);

  useEffect(() => {
    if (!isFriendRequestsAvailable) {
      setPendingCards([]);
      return;
    }
    void refreshPendingRequests(true);
  }, [currentUserId, isFriendRequestsAvailable]);

  useEffect(() => {
    const handleFriendRequestsChanged = (): void => {
      if (!isFriendRequestsAvailable) {
        return;
      }
      void refreshFriends(false);
      void refreshPendingRequests(false);
      setActiveFriendsTab("pending");
    };

    window.addEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
    return () => {
      window.removeEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
    };
  }, [currentUserId, isFriendRequestsAvailable]);

  useEffect(() => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshPendingRequests(false);
    }, 15000);

    const handleVisibilityOrFocus = (): void => {
      void refreshPendingRequests(false);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refreshPendingRequests(false);
      }
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentUserId, isFriendRequestsAvailable]);

  const handleAcceptRequest = async (requestId: string, targetUserId: string): Promise<void> => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }
    const { error: updateError } = await supabase.from("friend_requests").update({ status: "accepted" }).eq("id", requestId);
    if (updateError) {
      setPendingError("Nao foi possivel aceitar a solicitacao.");
      return;
    }

    try {
      await ensureDirectConversation(currentUserId, targetUserId);
    } catch {
      setPendingError("Solicitacao aceita, mas nao foi possivel abrir a conversa agora.");
    }
    void refreshFriends();
    void refreshPendingRequests();
  };

  const handleRejectRequest = async (requestId: string): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }
    const { error } = await supabase.from("friend_requests").update({ status: "rejected" }).eq("id", requestId);
    if (error) {
      setPendingError("Nao foi possivel recusar a solicitacao.");
      return;
    }
    void refreshFriends();
    void refreshPendingRequests();
  };

  const handleCancelRequest = async (requestId: string): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }
    const { error } = await supabase.from("friend_requests").delete().eq("id", requestId);
    if (error) {
      setPendingError("Nao foi possivel cancelar a solicitacao.");
      return;
    }
    void refreshFriends();
    void refreshPendingRequests();
  };

  const handleCreateConversation = async (friend: FriendListItem): Promise<void> => {
    if (!currentUserId) {
      return;
    }
    try {
      const conversationId = await ensureDirectConversation(currentUserId, friend.userId);
      setActiveDirectMessage({
        conversationId,
        userId: friend.userId,
        username: friend.username,
        displayName: friend.displayName,
        avatarSrc: friend.avatarSrc,
        presenceState: friend.presenceState,
        firebaseUid: friend.firebaseUid,
      });
    } catch {
      setFriendsError("Nao foi possivel iniciar uma conversa agora.");
    }
  };

  const handleUnfriend = async (friend: FriendListItem): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }

    setActiveFriendMenuUserId(null);

    const { error } = await supabase.from("friend_requests").delete().eq("id", friend.requestId);
    if (error) {
      setFriendsError("Nao foi possivel desfazer amizade.");
      return;
    }

    friendPresenceCache.delete(friend.userId);
    setFriends((current) => current.filter((item) => item.userId !== friend.userId));
    void refreshFriends();
    void refreshPendingRequests();
  };

  const handleAddFriendTargetUser = async (targetUserId: string): Promise<void> => {
    if (!currentUserId || !targetUserId || targetUserId === currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    const { error } = await supabase.from("friend_requests").insert({
      requester_id: currentUserId,
      addressee_id: targetUserId,
      status: "pending",
    });

    if (error) {
      const errorCode = String((error as { code?: string | null }).code ?? "");
      if (errorCode === "23505") {
        setFriendsError("Solicitacao ja enviada ou usuario ja e seu amigo.");
        return;
      }
      setFriendsError("Nao foi possivel enviar solicitacao de amizade.");
      return;
    }

    await Promise.all([refreshFriends(false), refreshPendingRequests(false)]);
    window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));
  };

  const handleBlockTargetUser = async (targetUserId: string): Promise<void> => {
    if (!currentUserId || !targetUserId || targetUserId === currentUserId) {
      return;
    }

    const { error } = await supabase.from("user_blocks").insert({
      blocker_id: currentUserId,
      blocked_id: targetUserId,
    });

    if (error) {
      const errorCode = String((error as { code?: string | null }).code ?? "");
      if (errorCode !== "23505") {
        if (isUserBlocksUnavailableError(error)) {
          setFriendsError("Bloqueio de usuario indisponivel no banco.");
        } else {
          setFriendsError("Nao foi possivel bloquear usuario.");
        }
        return;
      }
    }

    // Remove friendship and pending requests for this pair after blocking.
    const [deleteOutgoingResult, deleteIncomingResult] = await Promise.all([
      supabase
        .from("friend_requests")
        .delete()
        .eq("requester_id", currentUserId)
        .eq("addressee_id", targetUserId),
      supabase
        .from("friend_requests")
        .delete()
        .eq("requester_id", targetUserId)
        .eq("addressee_id", currentUserId),
    ]);

    if (deleteOutgoingResult.error || deleteIncomingResult.error) {
      setFriendsError("Usuario bloqueado, mas nao foi possivel limpar os vinculos de amizade.");
    }

    friendPresenceCache.delete(targetUserId);
    setFriends((current) => current.filter((item) => item.userId !== targetUserId));
    setPendingCards((current) => current.filter((card) => card.targetUserId !== targetUserId));
    setActiveFriendMenuUserId((current) => (current === targetUserId ? null : current));
    setActiveDirectMessage((current) => (current?.userId === targetUserId ? null : current));

    void refreshFriends();
    void refreshPendingRequests();
  };

  const pendingCount = isFriendRequestsAvailable ? pendingCards.length : 0;
  const sortedFriends = useMemo(() => {
    const copy = [...friends];
    copy.sort((a, b) => {
      const rankDiff = getPresenceSortRank(a.presenceState) - getPresenceSortRank(b.presenceState);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return a.displayName.localeCompare(b.displayName, "pt-BR", { sensitivity: "base" });
    });
    return copy;
  }, [friends]);
  const availableFriends = useMemo(() => sortedFriends.filter((friend) => isAvailablePresence(friend.presenceState)), [sortedFriends]);
  const allFriends = sortedFriends;
  const normalizedFriendSearchTerm = useMemo(() => normalizeSearchTerm(friendSearchTerm), [friendSearchTerm]);
  const hasFriendSearch = normalizedFriendSearchTerm.length > 0;
  const filteredAvailableFriends = useMemo(() => {
    if (!hasFriendSearch) {
      return availableFriends;
    }
    return availableFriends.filter((friend) => {
      const displayName = normalizeSearchTerm(friend.displayName);
      const username = normalizeSearchTerm(friend.username);
      return displayName.includes(normalizedFriendSearchTerm) || username.includes(normalizedFriendSearchTerm);
    });
  }, [availableFriends, hasFriendSearch, normalizedFriendSearchTerm]);
  const filteredAllFriends = useMemo(() => {
    if (!hasFriendSearch) {
      return allFriends;
    }
    return allFriends.filter((friend) => {
      const displayName = normalizeSearchTerm(friend.displayName);
      const username = normalizeSearchTerm(friend.username);
      return displayName.includes(normalizedFriendSearchTerm) || username.includes(normalizedFriendSearchTerm);
    });
  }, [allFriends, hasFriendSearch, normalizedFriendSearchTerm]);
  const visibleFriends = activeFriendsTab === "online" ? filteredAvailableFriends : filteredAllFriends;
  const canShowFriendsState = Boolean(currentUserId) && hasInitializedFriends;
  const chatViewDirectMessage = activeDirectMessage ?? (isSidebarCallActive ? callHostDirectMessage : null);
  const activeDirectMessageFriend = useMemo(() => {
    if (!chatViewDirectMessage) {
      return null;
    }

    return friends.find((friend) => friend.userId === chatViewDirectMessage.userId) ?? null;
  }, [chatViewDirectMessage, friends]);
  const isActiveDirectMessagePendingOutgoingRequest = useMemo(() => {
    if (!chatViewDirectMessage || !isFriendRequestsAvailable) {
      return false;
    }

    return pendingCards.some(
      (card) => card.targetUserId === chatViewDirectMessage.userId && card.direction === "outgoing",
    );
  }, [chatViewDirectMessage, isFriendRequestsAvailable, pendingCards]);
  const chatCurrentUser = useMemo<DirectMessageChatParticipant | null>(() => {
    if (!currentUserId) {
      return null;
    }

    const fallbackDisplayName = String(user?.displayName ?? "").trim() || "Voce";
    const displayName = currentUserChatProfile?.displayName || fallbackDisplayName;
    const username = currentUserChatProfile?.username || "voce";
    const avatarSrc = currentUserChatProfile?.avatarSrc || getNameAvatarUrl(displayName || username || "U");

    return {
      userId: currentUserId,
      displayName,
      username,
      avatarSrc,
      presenceState,
      firebaseUid: String(user?.uid ?? "").trim() || undefined,
    };
  }, [currentUserId, currentUserChatProfile, presenceState, user?.displayName, user?.uid]);
  const incomingCount = useMemo(
    () => pendingCards.filter((card) => card.direction === "incoming").length,
    [pendingCards],
  );
  const outgoingCount = pendingCount - incomingCount;

  return (
    <div className="app-shell">
      <TopBar isCallActive={isSidebarCallActive} onPrepareForUpdateInstall={handlePrepareForUpdateInstall} />
      <ServerRail />
      <DirectMessagesSidebar
        currentUserId={currentUserId}
        presenceState={presenceState}
        onChangePresence={handleChangePresence}
        onOpenSettings={() => setIsSettingsOpen(true)}
        activeConversationId={activeDirectMessage?.conversationId ?? null}
        onDirectMessagesChange={handleSidebarDirectMessagesChange}
        onSelectDirectMessage={(dm) => {
          setActiveDirectMessage(dm);
        }}
        onOpenFriends={() => {
          setActiveDirectMessage(null);
        }}
      />
      <main className={`main-panel${activeDirectMessage ? " main-panel--chat" : ""}`}>
        {!activeDirectMessage ? (
          <header className="main-panel__navbar">
            <div className="main-panel__navbar-left">
              <div className="main-panel__navbar-title">
                <MaterialSymbolIcon className="main-panel__navbar-icon" name="group" size={18} />
                <span>Amigos</span>
              </div>

              <div className="main-panel__navbar-tabs" role="tablist" aria-label="Filtros de amigos">
                <button
                  className={`main-panel__navbar-tab${activeFriendsTab === "online" ? " main-panel__navbar-tab--active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeFriendsTab === "online"}
                  onClick={() => {
                    setActiveDirectMessage(null);
                    setActiveFriendsTab("online");
                  }}
                >
                  Disponivel
                </button>
                <button
                  className={`main-panel__navbar-tab${activeFriendsTab === "all" ? " main-panel__navbar-tab--active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeFriendsTab === "all"}
                  onClick={() => {
                    setActiveDirectMessage(null);
                    setActiveFriendsTab("all");
                  }}
                >
                  Todos
                </button>
                {pendingCount > 0 ? (
                  <button
                    className={`main-panel__navbar-tab main-panel__navbar-tab--pending${
                      activeFriendsTab === "pending" ? " main-panel__navbar-tab--active" : ""
                    }`}
                    type="button"
                    role="tab"
                    aria-selected={activeFriendsTab === "pending"}
                    onClick={() => {
                      setActiveDirectMessage(null);
                      setActiveFriendsTab("pending");
                    }}
                  >
                    Pendentes
                    <span className="main-panel__navbar-tab-count">{pendingCount}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </header>
        ) : null}

        <section className={`main-panel__content${activeDirectMessage ? " main-panel__content--chat" : ""}`}>
          <div className="main-panel__workspace">
            {chatViewDirectMessage && currentUserId && chatCurrentUser ? (
              <div className={`main-panel__chat-view${activeDirectMessage ? "" : " main-panel__chat-view--hidden"}`}>
                <DirectMessageChatView
                  conversationId={chatViewDirectMessage.conversationId}
                  currentUserId={currentUserId}
                  currentUser={chatCurrentUser}
                  targetUser={{
                    userId: chatViewDirectMessage.userId,
                    username: chatViewDirectMessage.username,
                    displayName: chatViewDirectMessage.displayName,
                    avatarSrc: chatViewDirectMessage.avatarSrc,
                    presenceState: chatViewDirectMessage.presenceState,
                    firebaseUid: chatViewDirectMessage.firebaseUid,
                    aboutText: chatViewDirectMessage.aboutText,
                    bannerColor: chatViewDirectMessage.bannerColor ?? null,
                    bannerKey: chatViewDirectMessage.bannerKey ?? null,
                    bannerHash: chatViewDirectMessage.bannerHash ?? null,
                    bannerSrc: chatViewDirectMessage.bannerSrc,
                    memberSinceAt: chatViewDirectMessage.memberSinceAt ?? null,
                  }}
                  onOpenSettings={() => setIsSettingsOpen(true)}
                  isTargetFriend={Boolean(activeDirectMessageFriend)}
                  onUnfriendTarget={
                    activeDirectMessageFriend
                      ? async () => {
                          await handleUnfriend(activeDirectMessageFriend);
                        }
                      : undefined
                  }
                  onAddFriendTarget={async () => {
                    await handleAddFriendTargetUser(chatViewDirectMessage.userId);
                  }}
                  isTargetFriendRequestPending={isActiveDirectMessagePendingOutgoingRequest}
                  onBlockTarget={async () => {
                    await handleBlockTargetUser(chatViewDirectMessage.userId);
                  }}
                />
              </div>
            ) : null}

            {!activeDirectMessage && activeFriendsTab !== "pending" ? (
              <section className="main-panel__friends" aria-label="Lista de amigos">
                <div className="main-panel__friends-search">
                  <MaterialSymbolIcon className="main-panel__friends-search-icon" name="manage_search" size={18} />
                  <input
                    className="main-panel__friends-search-input"
                    type="text"
                    placeholder="Buscar"
                    value={friendSearchTerm}
                    onChange={(event) => {
                      setFriendSearchTerm(event.target.value);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Buscar amigos"
                  />
                </div>

                <header className="main-panel__friends-header">
                  <h2 className="main-panel__friends-title">
                    {activeFriendsTab === "online"
                      ? `Online - ${filteredAvailableFriends.length}`
                      : `Todos os amigos - ${filteredAllFriends.length}`}
                  </h2>
                </header>

                {canShowFriendsState && friendsError && allFriends.length === 0 ? (
                  <p className="main-panel__friends-error">{friendsError}</p>
                ) : null}
                {canShowFriendsState && !friendsError && allFriends.length === 0 && !isFriendsLoading ? (
                  <p className="main-panel__friends-empty">
                    Voce ainda nao tem amigos. Envie um pedido para comecar.
                  </p>
                ) : null}
                {canShowFriendsState && !friendsError && allFriends.length > 0 && visibleFriends.length === 0 ? (
                  <p className="main-panel__friends-empty">
                    {hasFriendSearch ? "Nenhum amigo encontrado." : "Ninguem disponivel no momento."}
                  </p>
                ) : null}

                {!friendsError && visibleFriends.length > 0 ? (
                  <div className="main-panel__friends-list">
                    {visibleFriends.map((friend) => (
                      <article key={friend.userId} className="main-panel__friend-item">
                        <div className="main-panel__friend-avatar-wrap">
                          <img
                            className="main-panel__friend-avatar"
                            src={friend.avatarSrc}
                            alt={`Avatar de ${friend.displayName}`}
                            loading="eager"
                            onError={(event) => {
                              event.currentTarget.onerror = null;
                              event.currentTarget.src = getFriendDisplayAvatar(friend.displayName, friend.username);
                            }}
                          />
                          <span
                            className={`main-panel__friend-presence main-panel__friend-presence--${friend.presenceState}`}
                            aria-hidden="true"
                          />
                        </div>

                        <div className="main-panel__friend-meta">
                          <p className="main-panel__friend-name">{friend.displayName}</p>
                          <p className="main-panel__friend-status">{getPresenceLabel(friend.presenceState)}</p>
                          <p className="main-panel__friend-username">@{friend.username}</p>
                        </div>

                        <div className="main-panel__friend-actions">
                          <button
                            className="main-panel__friend-action-btn"
                            type="button"
                            title={`Iniciar conversa com ${friend.displayName}`}
                            aria-label={`Iniciar conversa com ${friend.displayName}`}
                            onClick={() => {
                              void handleCreateConversation(friend);
                            }}
                          >
                            <img className="main-panel__friend-action-icon" src={msgIcon} alt="" aria-hidden="true" />
                          </button>

                          <div className="main-panel__friend-menu-wrap">
                            <button
                              className="main-panel__friend-action-btn"
                              type="button"
                              title={`Acoes para ${friend.displayName}`}
                              aria-label={`Acoes para ${friend.displayName}`}
                              aria-haspopup="menu"
                              aria-expanded={activeFriendMenuUserId === friend.userId}
                              onClick={() => {
                                setActiveFriendMenuUserId((current) => (current === friend.userId ? null : friend.userId));
                              }}
                            >
                              <MaterialSymbolIcon name="more_vert" size={18} />
                            </button>

                            {activeFriendMenuUserId === friend.userId ? (
                              <div className="main-panel__friend-menu" role="menu" aria-label={`Acoes de ${friend.displayName}`}>
                                <button
                                  className="main-panel__friend-menu-item main-panel__friend-menu-item--danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    void handleUnfriend(friend);
                                  }}
                                >
                                  Desfazer amizade
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {!activeDirectMessage && activeFriendsTab === "pending" ? (
              <section className="main-panel__pending" aria-label="Solicitacoes pendentes">
                <header className="main-panel__pending-header">
                  <h2 className="main-panel__pending-title">Pendentes</h2>
                  <p className="main-panel__pending-subtitle">
                    {incomingCount} recebidas - {outgoingCount} enviadas
                  </p>
                </header>

                {isPendingLoading ? <p className="main-panel__pending-empty">Carregando solicitacoes...</p> : null}
                {!isPendingLoading && pendingError ? <p className="main-panel__pending-error">{pendingError}</p> : null}
                {!isPendingLoading && !pendingError && pendingCards.length === 0 ? (
                  <p className="main-panel__pending-empty">Nenhuma solicitacao pendente no momento.</p>
                ) : null}

                {!isPendingLoading && !pendingError && pendingCards.length > 0 ? (
                  <div className="main-panel__pending-list">
                    {pendingCards.map((card) => (
                      <article key={card.requestId} className="main-panel__pending-item">
                        <img
                          className="main-panel__pending-avatar"
                          src={card.avatarSrc}
                          alt={`Avatar de ${card.displayName}`}
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.onerror = null;
                            event.currentTarget.src = getPendingDisplayAvatar(card.displayName, card.username);
                          }}
                        />

                        <div className="main-panel__pending-meta">
                          <p className="main-panel__pending-name">{card.displayName}</p>
                          <p className="main-panel__pending-username">@{card.username}</p>
                          <p className="main-panel__pending-direction">
                            {card.direction === "incoming" ? "Solicitacao recebida" : "Solicitacao enviada"}
                          </p>
                        </div>

                        <div className="main-panel__pending-actions">
                          {card.direction === "incoming" ? (
                            <>
                              <button
                                className="main-panel__pending-btn main-panel__pending-btn--accept"
                                type="button"
                                onClick={() => {
                                  void handleAcceptRequest(card.requestId, card.targetUserId);
                                }}
                              >
                                Aceitar
                              </button>
                              <button
                                className="main-panel__pending-btn main-panel__pending-btn--reject"
                                type="button"
                                onClick={() => {
                                  void handleRejectRequest(card.requestId);
                                }}
                              >
                                Recusar
                              </button>
                            </>
                          ) : (
                            <button
                              className="main-panel__pending-btn main-panel__pending-btn--cancel"
                              type="button"
                              onClick={() => {
                                void handleCancelRequest(card.requestId);
                              }}
                            >
                              Cancelar
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          {!activeDirectMessage ? (
            <aside className="main-panel__right-sidebar" aria-label="Agora no Messly">
              <h2 className="main-panel__right-title">Agora no Messly</h2>

              <div className="main-panel__right-card">
                <h3 className="main-panel__right-card-title">Nada por aqui ainda</h3>
                <p className="main-panel__right-card-text">
                  Assim que alguem iniciar uma atividade no Messly, esse painel mostra as novidades para voce.
                </p>
              </div>
            </aside>
          ) : null}
        </section>
      </main>

      {isSettingsOpen ? (
        <div
          className="app-settings-float"
          role="presentation"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="app-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Configuracoes do aplicativo"
            onClick={(event) => event.stopPropagation()}
          >
            <AppSettingsView onClose={() => setIsSettingsOpen(false)} currentUserId={currentUserId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
