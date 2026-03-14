import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import TopBar from "../components/layout/TopBar";
import ServerRail from "../components/layout/ServerRail";
import AppStartupScreen from "./AppStartupScreen";
import type { SidebarDirectMessageSelection } from "../components/layout/DirectMessagesSidebar";
import MaterialSymbolIcon from "../components/ui/MaterialSymbolIcon";
import AvatarImage from "../components/ui/AvatarImage";
import type { DirectMessageChatParticipant } from "../components/chat/DirectMessageChatView";
import msgIcon from "../assets/icons/ui/Chat.svg";
import spotifyLogo from "../assets/icons/ui/spotify.svg";
import musicalIcon from "../assets/icons/ui/musical.svg";
import { presenceController } from "../services/presence/presenceController";
import { presenceStore } from "../services/presence/presenceStore";
import { notificationNavigationCoordinator } from "../services/notification/NotificationNavigationCoordinator";
import { notificationsService } from "../services/notifications";
import { useAuthSession, type AuthUser } from "../auth/AuthProvider";
import type { PresenceSpotifyActivity, PresenceState } from "../services/presence/presenceTypes";
import {
  createDefaultSpotifyListenAlongSession,
  readSpotifyListenAlongSession,
  subscribeSpotifyListenAlongSession,
  type SpotifyListenAlongSession,
} from "../services/connections/spotifyListenAlong";
import { getAvatarUrl, getBannerUrl, getNameAvatarUrl, isDefaultAvatarUrl, isDefaultBannerUrl } from "../services/cdn/mediaUrls";
import { normalizeBannerColor } from "../services/profile/bannerColor";
import { supabase } from "../lib/supabaseClient";
import { ensureProfileForUser } from "../services/profile/profileService";
import { friendRequestsEnabled } from "../services/friends/friendRequests";
import {
  buildFriendRequestBlockedNotice,
  dispatchFriendRequestBlockedNotice,
  evaluateFriendRequestPermission,
  queryFriendRequestTargetById,
} from "../services/friends/friendRequestPrivacy";
import { listMutualFriendIdsForCurrentUser } from "../services/friends/mutualFriends";
import { useFriendRequestsRealtime } from "../hooks/useFriendRequestsRealtime";
import {
  dispatchSidebarCallHangup,
  SIDEBAR_CALL_STATE_EVENT,
  type SidebarCallStateDetail,
} from "../services/calls/callUiPresence";

type AppSettingsViewModule = typeof import("../components/settings/AppSettingsView");
type DirectMessagesSidebarModule = typeof import("../components/layout/DirectMessagesSidebar");
type UserProfilePopoverModule = typeof import("../components/UserProfilePopover/UserProfilePopover");
type DirectMessageChatViewModule = typeof import("../components/chat/DirectMessageChatView");
let appSettingsViewPreloadPromise: Promise<AppSettingsViewModule> | null = null;
let directMessagesSidebarPreloadPromise: Promise<DirectMessagesSidebarModule> | null = null;
let userProfilePopoverPreloadPromise: Promise<UserProfilePopoverModule> | null = null;
let directMessageChatViewPreloadPromise: Promise<DirectMessageChatViewModule> | null = null;

function preloadAppSettingsView(): Promise<AppSettingsViewModule> {
  if (!appSettingsViewPreloadPromise) {
    appSettingsViewPreloadPromise = import("../components/settings/AppSettingsView");
  }
  return appSettingsViewPreloadPromise;
}

function preloadDirectMessagesSidebar(): Promise<DirectMessagesSidebarModule> {
  if (!directMessagesSidebarPreloadPromise) {
    directMessagesSidebarPreloadPromise = import("../components/layout/DirectMessagesSidebar");
  }
  return directMessagesSidebarPreloadPromise;
}

function preloadUserProfilePopover(): Promise<UserProfilePopoverModule> {
  if (!userProfilePopoverPreloadPromise) {
    userProfilePopoverPreloadPromise = import("../components/UserProfilePopover/UserProfilePopover");
  }
  return userProfilePopoverPreloadPromise;
}

function preloadDirectMessageChatView(): Promise<DirectMessageChatViewModule> {
  if (!directMessageChatViewPreloadPromise) {
    directMessageChatViewPreloadPromise = import("../components/chat/DirectMessageChatView");
  }
  return directMessageChatViewPreloadPromise;
}

const AppSettingsView = lazy(preloadAppSettingsView);
const DirectMessagesSidebar = lazy(preloadDirectMessagesSidebar);
const UserProfilePopover = lazy(preloadUserProfilePopover);
const DirectMessageChatView = lazy(preloadDirectMessageChatView);

type FriendsTab = "online" | "all" | "pending";
type PendingDirection = "incoming" | "outgoing";
type NetworkBannerState = "online" | "invisivel" | "reconnecting" | "restored";
type SettingsSection = "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows";

const PRESENCE_DEVICE_STALE_MS = 90_000;
const SPOTIFY_ACTIVITY_END_GRACE_MS = 8_000;
const SPOTIFY_ACTIVITY_NO_DURATION_STALE_MS = 60_000;
const SETTINGS_AUTO_OPEN_SECTION_KEY = "messly:settings:auto-open-section";

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

interface PendingProfileModalState {
  userId: string;
  displayName: string;
  username: string;
  avatarSrc: string;
  bannerSrc: string;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  aboutText: string;
  presenceState: PresenceState;
  memberSinceLabel: string;
  spotifyActivity?: PresenceSpotifyActivity | null;
}

interface FriendListItem {
  requestId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
  presenceState: PresenceState;
  spotifyActivity?: PresenceSpotifyActivity | null;
  firebaseUid?: string;
}

interface UserIdentityRow {
  id: string;
  username: string | null;
  display_name: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  updated_at?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  banner_color?: string | null;
  status?: string | null;
  firebase_uid?: string | null;
}

interface LegacyAvatarRow {
  user_id: string;
  avatar_url: string | null;
}

interface ProfileUpdatedDetail {
  userId: string;
  display_name?: string | null;
  username?: string | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  username_changed_at?: string | null;
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
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
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
const FRIENDS_CACHE_VERSION = 3;
const CURRENT_USER_ID_CACHE_PREFIX = "messly:current-user-id:";
const SIDEBAR_CALL_PERSIST_KEY = "messly:sidebar-call-state:v2";
const SIDEBAR_CALL_RESTORE_MAX_AGE_MS = 15 * 60_000;
const SHELL_STARTUP_MAX_BLOCK_MS = 4_000;

const PROFILE_SAFE_COLUMNS =
  "id,username,display_name,email,firebase_uid:id,avatar_url,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,about:bio,created_at,updated_at";

// Generic loose profile shape (we no longer rely on legacy Firebase columns)
type ProfileAny = any;

interface CachedFriendsPayload {
  version: number;
  items: FriendListItem[];
}

function SettingsModalFallback(): JSX.Element {
  return (
    <div className="app-settings-modal__fallback" role="status" aria-live="polite" aria-busy="true">
      <aside className="app-settings-modal__fallback-menu" aria-hidden="true">
        <span className="app-settings-modal__fallback-line app-settings-modal__fallback-line--brand" />
        <span className="app-settings-modal__fallback-line" />
        <span className="app-settings-modal__fallback-line" />
        <span className="app-settings-modal__fallback-line" />
      </aside>
      <section className="app-settings-modal__fallback-panel" aria-hidden="true">
        <span className="app-settings-modal__fallback-block app-settings-modal__fallback-block--title" />
        <span className="app-settings-modal__fallback-block" />
        <span className="app-settings-modal__fallback-block app-settings-modal__fallback-block--wide" />
      </section>
    </div>
  );
}

function PendingProfileFallback(): JSX.Element {
  return (
    <div className="main-panel__pending-profile-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="main-panel__pending-profile-skeleton-banner" />
      <div className="main-panel__pending-profile-skeleton-body">
        <span className="main-panel__pending-profile-skeleton-avatar" />
        <span className="main-panel__pending-profile-skeleton-line main-panel__pending-profile-skeleton-line--title" />
        <span className="main-panel__pending-profile-skeleton-line" />
        <span className="main-panel__pending-profile-skeleton-line main-panel__pending-profile-skeleton-line--wide" />
      </div>
    </div>
  );
}

function getPendingDisplayAvatar(displayName: string, username: string, userId?: string | null): string {
  return getNameAvatarUrl(displayName || username || "U");
}

function buildPendingAvatarSignature(userRow: UserIdentityRow | undefined, legacyBackupUrl: string): string {
  return [
    String(userRow?.avatar_key ?? "").trim(),
    String(userRow?.avatar_hash ?? "").trim().toLowerCase(),
    String(userRow?.avatar_url ?? "").trim(),
    String(userRow?.updated_at ?? "").trim(),
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

function areStringArraysEqual(current: string[], next: string[]): boolean {
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

function getFriendDisplayAvatar(displayName: string, username: string, userId?: string | null): string {
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

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toNullableTrimmedString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function toNormalizedIsoTimestamp(value: unknown): string | null {
  const raw = toNullableTrimmedString(value);
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
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
    String(userRow?.updated_at ?? "").trim(),
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
    return "invisivel";
  }
  if (raw === "online" || raw === "disponivel" || raw === "available") {
    return "online";
  }
  if (raw === "idle" || raw === "ausente" || raw === "away") {
    return "idle";
  }
  if (raw === "invisible" || raw === "oculto" || raw === "hidden") {
    return "invisivel";
  }
  if (raw === "dnd" || raw === "nao perturbar" || raw === "busy") {
    return "dnd";
  }
  return "invisivel";
}

function normalizePresenceSpotifyActivity(value: unknown): PresenceSpotifyActivity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const casted = value as Partial<PresenceSpotifyActivity>;
  const trackTitle = String(casted.trackTitle ?? "").trim();
  const artistNames = String(casted.artistNames ?? "").trim();
  if (!trackTitle || !artistNames) {
    return null;
  }
  const trackId = String(casted.trackId ?? "").trim();
  const trackUrl = String(casted.trackUrl ?? "").trim();
  const coverUrl = String(casted.coverUrl ?? "").trim();

  const durationSecondsRaw = Number(casted.durationSeconds ?? 0);
  const durationSeconds = Number.isFinite(durationSecondsRaw) ? Math.max(0, Math.round(durationSecondsRaw)) : 0;
  const progressSecondsRaw = Number(casted.progressSeconds ?? 0);
  const progressSeconds = Number.isFinite(progressSecondsRaw) ? Math.max(0, Math.round(progressSecondsRaw)) : 0;
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
    progressSeconds: durationSeconds > 0 ? Math.min(progressSeconds, durationSeconds) : progressSeconds,
    durationSeconds,
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

  return nowMs - updatedAtMs <= PRESENCE_DEVICE_STALE_MS;
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
      ? updatedAtMs + Math.max(0, durationSeconds - progressSeconds) * 1000 + SPOTIFY_ACTIVITY_END_GRACE_MS
      : updatedAtMs + SPOTIFY_ACTIVITY_NO_DURATION_STALE_MS;

  return nowMs <= projectedEndMs;
}

function areSpotifyActivitiesEqual(
  left: PresenceSpotifyActivity | null | undefined,
  right: PresenceSpotifyActivity | null | undefined,
): boolean {
  const safeLeft = left ?? null;
  const safeRight = right ?? null;
  if (!safeLeft && !safeRight) {
    return true;
  }
  if (!safeLeft || !safeRight) {
    return false;
  }
  return (
    safeLeft.provider === safeRight.provider &&
    (safeLeft.showOnProfile ?? true) === (safeRight.showOnProfile ?? true) &&
    safeLeft.trackId === safeRight.trackId &&
    safeLeft.trackTitle === safeRight.trackTitle &&
    safeLeft.artistNames === safeRight.artistNames &&
    safeLeft.trackUrl === safeRight.trackUrl &&
    safeLeft.coverUrl === safeRight.coverUrl &&
    safeLeft.progressSeconds === safeRight.progressSeconds &&
    safeLeft.durationSeconds === safeRight.durationSeconds
  );
}

function resolvePresenceFromRealtimeNode(value: unknown): PresenceState {
  if (!value || typeof value !== "object") {
    return "invisivel";
  }

  const nowMs = Date.now();

  const directStateRaw = (value as { state?: unknown }).state;
  if (directStateRaw !== undefined) {
    if (!isPresenceNodeFresh(value, nowMs)) {
      return "invisivel";
    }
    return normalizePresenceState(directStateRaw);
  }

  const devices = Object.values(value as Record<string, unknown>);
  let hasIdle = false;
  let hasOnline = false;

  for (const device of devices) {
    if (!isPresenceNodeFresh(device, nowMs)) {
      continue;
    }
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
  return "invisivel";
}

function resolveSpotifyActivityFromRealtimeNode(
  value: unknown,
  resolvedPresenceState: PresenceState,
): PresenceSpotifyActivity | null {
  if (!value || typeof value !== "object" || resolvedPresenceState === "invisivel") {
    return null;
  }

  const nowMs = Date.now();
  const directActivityCandidate = normalizePresenceSpotifyActivity((value as { activity?: unknown }).activity ?? null);
  const directActivity = isSpotifyActivityFresh(directActivityCandidate, nowMs) ? directActivityCandidate : null;
  let bestActivity = directActivity;

  const devices = Object.values(value as Record<string, unknown>);
  for (const device of devices) {
    if (!isPresenceNodeFresh(device, nowMs)) {
      continue;
    }
    const deviceState = normalizePresenceState((device as { state?: unknown } | null)?.state ?? null);
    if (deviceState === "invisivel") {
      continue;
    }
    const candidateRaw = normalizePresenceSpotifyActivity((device as { activity?: unknown } | null)?.activity ?? null);
    const candidate = isSpotifyActivityFresh(candidateRaw, nowMs) ? candidateRaw : null;
    if (!candidate) {
      continue;
    }
    if (!bestActivity || candidate.updatedAt > bestActivity.updatedAt) {
      bestActivity = candidate;
    }
  }

  return bestActivity;
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
      return "Não perturbar";
    default:
      return "Invisível";
  }
}

function formatMemberSinceDate(timestamp: string | null | undefined): string {
  const raw = String(timestamp ?? "").trim();
  if (!raw) {
    return "";
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

interface SupabaseLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
}

function resolveOpenConversationErrorMessage(error: unknown): string {
  const normalized = (error ?? null) as SupabaseLikeError | null;
  const code = String(normalized?.code ?? "").trim().toUpperCase();
  const message = String(normalized?.message ?? "").trim().toLowerCase();
  const details = String(normalized?.details ?? "").trim().toLowerCase();
  const hint = String(normalized?.hint ?? "").trim().toLowerCase();
  const status = Number(normalized?.status ?? Number.NaN);

  if (
    code === "MISSING_AUTH_TOKEN" ||
    code === "INVALID_AUTH_TOKEN" ||
    code === "INVALID_TOKEN" ||
    code === "PGRST301" ||
    message.includes("jwt") ||
    message.includes("authorization") ||
    message.includes("token")
  ) {
    return "Sessão inválida. Entre novamente para abrir a conversa.";
  }

  if (
    status === 403 ||
    code === "42501" ||
    message.includes("row-level security") ||
    details.includes("row-level security") ||
    message.includes("permission denied") ||
    hint.includes("policy")
  ) {
    return "Você não tem permissão para abrir essa conversa.";
  }

  if (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("timeout")
  ) {
    return "Falha de rede ao abrir a conversa. Tente novamente.";
  }

  return "Não foi possível abrir a conversa agora.";
}

function isAvailablePresence(state: PresenceState): boolean {
  return state !== "invisivel";
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
      !areSpotifyActivitiesEqual(currentItem.spotifyActivity, nextItem.spotifyActivity) ||
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

    if (typeof item.spotifyActivity === "undefined" && currentItem.spotifyActivity) {
      return {
        ...item,
        spotifyActivity: currentItem.spotifyActivity,
      };
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
      !areSpotifyActivitiesEqual(currentItem.spotifyActivity ?? null, nextItem.spotifyActivity ?? null) ||
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

function getConversationIdFromSearch(searchRaw: string): string | null {
  const search = String(searchRaw ?? "").trim();
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) {
    return null;
  }

  const params = new URLSearchParams(query);
  const conversationId = String(params.get("conversation") ?? "").trim();
  return conversationId || null;
}

function getConversationIdFromLocation(location: Location): string | null {
  return getConversationIdFromSearch(location.search) ?? getConversationIdFromHash(location.hash);
}

function clearConversationIdFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  const hadSearchConversation = url.searchParams.has("conversation");
  if (hadSearchConversation) {
    url.searchParams.delete("conversation");
  }

  const hashQueryIndex = url.hash.indexOf("?");
  const hadHashConversation = hashQueryIndex >= 0;
  const cleanHash = hadHashConversation ? url.hash.slice(0, hashQueryIndex) : url.hash;

  if (!hadSearchConversation && !hadHashConversation) {
    return;
  }

  const nextPath = `${url.pathname}${url.search}${cleanHash}`;
  window.history.replaceState(null, document.title, nextPath);
}

function readPersistedSidebarCallStateDetail(): SidebarCallStateDetail | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SIDEBAR_CALL_PERSIST_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { detail?: SidebarCallStateDetail } | null;
    const detail = parsed?.detail ?? null;
    if (!detail || !detail.active) {
      return null;
    }

    const conversationId = String(detail.conversationId ?? "").trim();
    if (!conversationId) {
      return null;
    }

    const updatedAtMs = Date.parse(String(detail.updatedAt ?? ""));
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > SIDEBAR_CALL_RESTORE_MAX_AGE_MS) {
      return null;
    }

    return {
      ...detail,
      conversationId,
      micEnabled: detail.micEnabled ?? true,
      soundEnabled: detail.soundEnabled ?? true,
      isPopoutOpen: detail.isPopoutOpen ?? false,
    };
  } catch {
    return null;
  }
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
        const cachedAvatarSrc = String(casted.avatarSrc ?? "").trim();
        const avatarSrc = !cachedAvatarSrc || isFriendFallbackAvatar(cachedAvatarSrc)
          ? getFriendDisplayAvatar(displayName, username, userIdValue)
          : cachedAvatarSrc;
        const firebaseUid = String((casted as { firebaseUid?: string | null }).firebaseUid ?? "").trim();
        const spotifyActivity = normalizePresenceSpotifyActivity(
          (casted as { spotifyActivity?: unknown }).spotifyActivity ?? null,
        );

        return {
          requestId,
          userId: userIdValue,
          username,
          displayName,
          avatarSrc,
          presenceState: normalizePresenceState((casted as { presenceState?: unknown }).presenceState ?? null),
          ...(spotifyActivity ? { spotifyActivity } : {}),
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
  return new Map();
}

async function queryCurrentUserId(authUser: AuthUser | null): Promise<string | null> {
  if (!authUser?.uid) {
    return null;
  }

  const cachedUserId = readCachedCurrentUserId(authUser.uid);

  try {
    const ensuredProfile = await ensureProfileForUser(authUser.raw, {
      displayName: authUser.displayName ?? authUser.email ?? undefined,
    });
    const profileId = String(ensuredProfile?.id ?? "").trim();
    if (profileId) {
      return profileId;
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[app:current-user-id:profile]", error);
    }
  }

  const byId = await supabase.from("profiles").select("id").eq("id", authUser.uid).limit(1);
  const byIdData = Array.isArray(byId.data) && byId.data.length > 0 ? byId.data[0] : null;
  if (!byId.error && byIdData?.id) {
    return byIdData.id as string;
  }

  if (byId.error && !isUsersSchemaColumnCacheError(byId.error.message ?? "")) {
    return cachedUserId;
  }

  return cachedUserId;
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
    throw new Error("Não foi possível resolver a conversa direta.");
  }

  return createdConversation.id as string;
}

export default function AppShell() {
  const queryClient = useQueryClient();
  const { user } = useAuthSession();
  const [presenceState, setPresenceState] = useState<PresenceState>(() => presenceController.getState());
  const [isWindowFocused, setIsWindowFocused] = useState<boolean>(() =>
    typeof document === "undefined" ? true : !document.hidden && document.hasFocus(),
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("account");
  const [activeFriendsTab, setActiveFriendsTab] = useState<FriendsTab>("online");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const acceptedFriendRequestsQuery = useFriendRequestsRealtime(currentUserId, "accepted");
  const pendingFriendRequestsQuery = useFriendRequestsRealtime(currentUserId, "pending");
  const acceptedFriendRequests = useMemo(
    () => (acceptedFriendRequestsQuery.data ?? []) as FriendRequestRow[],
    [acceptedFriendRequestsQuery.data],
  );
  const pendingFriendRequests = useMemo(
    () => (pendingFriendRequestsQuery.data ?? []) as FriendRequestRow[],
    [pendingFriendRequestsQuery.data],
  );
  const [friends, setFriends] = useState<FriendListItem[]>([]);
  const [hasInitializedFriends, setHasInitializedFriends] = useState(false);
  const [isFriendsLoading, setIsFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [pendingCards, setPendingCards] = useState<PendingFriendCard[]>([]);
  const [openPendingProfile, setOpenPendingProfile] = useState<PendingProfileModalState | null>(null);
  const [isPendingLoading, setIsPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [isFriendRequestsAvailable, setIsFriendRequestsAvailable] = useState(friendRequestsEnabled);
  const [activeFriendMenuUserId, setActiveFriendMenuUserId] = useState<string | null>(null);
  const [friendSearchTerm, setFriendSearchTerm] = useState("");
  const [activeDirectMessage, setActiveDirectMessage] = useState<SidebarDirectMessageSelection | null>(null);
  const [activeDirectMessageMutualFriendIds, setActiveDirectMessageMutualFriendIds] = useState<string[]>([]);
  const [sidebarDirectMessages, setSidebarDirectMessages] = useState<SidebarDirectMessageSelection[]>([]);
  const [isSidebarHydrated, setIsSidebarHydrated] = useState(false);
  const [shellStartupTimedOut, setShellStartupTimedOut] = useState(false);
  const [isInitialShellReady, setIsInitialShellReady] = useState(false);
  const [pendingNotificationConversationId, setPendingNotificationConversationId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return getConversationIdFromLocation(window.location);
  });
  const [callHostDirectMessage, setCallHostDirectMessage] = useState<SidebarDirectMessageSelection | null>(null);
  const [isSidebarCallActive, setIsSidebarCallActive] = useState(false);
  const [sidebarCallConversationId, setSidebarCallConversationId] = useState<string | null>(null);
  const [currentUserChatProfile, setCurrentUserChatProfile] = useState<DirectMessageChatParticipant | null>(null);
  const [currentUserChatProfileRefreshToken, setCurrentUserChatProfileRefreshToken] = useState(0);
  const [listenAlongSessionsByFriendId, setListenAlongSessionsByFriendId] = useState<Record<string, SpotifyListenAlongSession>>(
    {},
  );
  const [networkBannerState, setNetworkBannerState] = useState<NetworkBannerState>(() => {
    if (typeof navigator === "undefined") {
      return "online";
    }
    return navigator.onLine ? "online" : "invisivel";
  });
  const friendsRefreshInFlightRef = useRef(false);
  const friendsRefreshQueuedRef = useRef(false);
  const pendingRefreshInFlightRef = useRef(false);
  const pendingRefreshQueuedRef = useRef(false);
  const pendingProfileRequestCursorRef = useRef(0);
  const activeDirectMessageMutualFetchTokenRef = useRef(0);
  const activeDirectMessageMutualTargetUserIdRef = useRef("");
  const sidebarCallBootstrapDoneRef = useRef(false);
  const networkReconnectTimerRef = useRef<number | null>(null);
  const networkBannerHideTimerRef = useRef<number | null>(null);
  const networkOnlineRef = useRef<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const sidebarDirectMessagesByConversationId = useMemo(() => {
    const map = new Map<string, SidebarDirectMessageSelection>();
    sidebarDirectMessages.forEach((item) => {
      map.set(item.conversationId, item);
    });
    return map;
  }, [sidebarDirectMessages]);
  const isFriendsAndPendingReady =
    !isFriendRequestsAvailable || (hasInitializedFriends && !isFriendsLoading && !isPendingLoading);
  const canRevealShell = (isSidebarHydrated && isFriendsAndPendingReady) || shellStartupTimedOut;
  const friendPresenceUserIdsKey = useMemo(
    () =>
      Array.from(
        new Set(
          friends
            .map((friend) => String(friend.userId ?? "").trim())
            .filter((userId) => Boolean(userId)),
        ),
      )
        .sort((left, right) => left.localeCompare(right))
        .join("|"),
    [friends],
  );
  const handleChangePresence = (state: PresenceState): void => {
    presenceController.setPreferredState(state);
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const preload = (): void => {
      void preloadAppSettingsView();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const timeoutId = window.setTimeout(preload, 180);
    const idleId =
      typeof idleWindow.requestIdleCallback === "function"
        ? idleWindow.requestIdleCallback(preload, { timeout: 1400 })
        : null;

    return () => {
      window.clearTimeout(timeoutId);
      if (idleId !== null && typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleId);
      }
    };
  }, []);

  useEffect(() => {
    if (!openPendingProfile) {
      return;
    }

    void preloadUserProfilePopover();
  }, [openPendingProfile]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (activeDirectMessage || sidebarDirectMessages.length > 0) {
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
      };

      const preload = (): void => {
        void preloadDirectMessageChatView();
      };

      const timeoutId = window.setTimeout(preload, activeDirectMessage ? 40 : 140);
      const idleId =
        typeof idleWindow.requestIdleCallback === "function"
          ? idleWindow.requestIdleCallback(preload, { timeout: 1_600 })
          : null;

      return () => {
        window.clearTimeout(timeoutId);
        if (idleId !== null && typeof idleWindow.cancelIdleCallback === "function") {
          idleWindow.cancelIdleCallback(idleId);
        }
      };
    }

    return;
  }, [activeDirectMessage, sidebarDirectMessages.length]);

  const handleOpenSettings = useCallback((section: SettingsSection = "account"): void => {
    setSettingsInitialSection(section);
    void preloadAppSettingsView();
    setIsSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || isSettingsOpen) {
      return;
    }

    const queuedSection = String(window.sessionStorage.getItem(SETTINGS_AUTO_OPEN_SECTION_KEY) ?? "")
      .trim()
      .toLowerCase();
    if (queuedSection !== "connections") {
      return;
    }

    window.sessionStorage.removeItem(SETTINGS_AUTO_OPEN_SECTION_KEY);
    handleOpenSettings("connections");
  }, [handleOpenSettings, isSettingsOpen]);

  const handleCloseSettings = useCallback((): void => {
    setIsSettingsOpen(false);
  }, []);

  const handleClosePendingProfile = useCallback((): void => {
    pendingProfileRequestCursorRef.current += 1;
    setOpenPendingProfile(null);
  }, []);

  const handleOpenPendingProfile = useCallback(async (card: PendingFriendCard): Promise<void> => {
    const requestCursor = pendingProfileRequestCursorRef.current + 1;
    pendingProfileRequestCursorRef.current = requestCursor;

    const existingDirectMessage = sidebarDirectMessages.find((dm) => dm.userId === card.targetUserId) ?? null;
    const fallbackDisplayName = String(card.displayName ?? "").trim() || "Nome";
    const fallbackUsername = String(card.username ?? "").trim() || "usuario";
    const fallbackAvatarSrc =
      String(existingDirectMessage?.avatarSrc ?? card.avatarSrc ?? "").trim()
      || getNameAvatarUrl(fallbackDisplayName || fallbackUsername);
    const seedAboutText = String(existingDirectMessage?.aboutText ?? "").trim();
    const seedMemberSinceLabel = formatMemberSinceDate(existingDirectMessage?.memberSinceAt ?? null);
    const seedBannerSrc = String(existingDirectMessage?.bannerSrc ?? "").trim();

    setOpenPendingProfile({
      userId: card.targetUserId,
      displayName: fallbackDisplayName,
      username: fallbackUsername,
      avatarSrc: fallbackAvatarSrc,
      bannerSrc: seedBannerSrc,
      bannerColor: existingDirectMessage?.bannerColor ?? null,
      themePrimaryColor: existingDirectMessage?.themePrimaryColor ?? null,
      themeAccentColor: existingDirectMessage?.themeAccentColor ?? null,
      aboutText: seedAboutText,
      presenceState: existingDirectMessage?.presenceState ?? presenceStore.getPresenceState(card.targetUserId),
      memberSinceLabel: seedMemberSinceLabel,
      spotifyActivity: existingDirectMessage?.spotifyActivity ?? presenceStore.getPresenceSnapshot(card.targetUserId).spotifyActivity ?? null,
    });

    const { data: userDataRaw, error: userError } = await supabase
      .from("profiles")
      .select(PROFILE_SAFE_COLUMNS)
      .eq("id", card.targetUserId)
      .limit(1)
      .maybeSingle();
    const userData = userDataRaw as ProfileAny | null;

    if (pendingProfileRequestCursorRef.current !== requestCursor || userError || !userData) {
      return;
    }

    const resolvedUsername = String(userData.username ?? "").trim() || fallbackUsername;
    const resolvedDisplayName = normalizeProfileDisplayName(userData.display_name, resolvedUsername, fallbackDisplayName);
    const legacyAvatarUrl = "";

    let resolvedAvatar = fallbackAvatarSrc;
    try {
      const primaryAvatar = await getAvatarUrl(card.targetUserId, userData.avatar_key ?? null, userData.avatar_hash ?? null);
      if (!isDefaultAvatarUrl(primaryAvatar)) {
        resolvedAvatar = primaryAvatar;
      } else if (legacyAvatarUrl) {
        resolvedAvatar = legacyAvatarUrl;
      }
    } catch {
      if (legacyAvatarUrl) {
        resolvedAvatar = legacyAvatarUrl;
      }
    }

    let resolvedBannerSrc = "";
    try {
      const bannerUrl = await getBannerUrl(card.targetUserId, userData.banner_key ?? null, userData.banner_hash ?? null);
      if (!isDefaultBannerUrl(bannerUrl)) {
        resolvedBannerSrc = String(bannerUrl ?? "").trim();
      }
    } catch {
      resolvedBannerSrc = "";
    }

    if (pendingProfileRequestCursorRef.current !== requestCursor) {
      return;
    }

    setOpenPendingProfile({
      userId: card.targetUserId,
      displayName: resolvedDisplayName,
      username: resolvedUsername,
      avatarSrc: resolvedAvatar,
      bannerSrc: resolvedBannerSrc,
      bannerColor: normalizeBannerColor(userData.banner_color) ?? null,
      themePrimaryColor: normalizeBannerColor(userData.profile_theme_primary_color) ?? null,
      themeAccentColor: normalizeBannerColor(userData.profile_theme_accent_color) ?? null,
      aboutText: String(userData.about ?? "").trim(),
      presenceState: presenceStore.getPresenceState(card.targetUserId),
      memberSinceLabel: formatMemberSinceDate(userData.created_at ?? null),
      spotifyActivity: presenceStore.getPresenceSnapshot(card.targetUserId).spotifyActivity ?? null,
    });
  }, [sidebarDirectMessages]);

  useEffect(() => {
    if (!openPendingProfile) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        handleClosePendingProfile();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleClosePendingProfile, openPendingProfile]);

  const handleOpenSpotifyExternal = useCallback((trackUrlRaw: string | null | undefined): void => {
    const trackUrl = String(trackUrlRaw ?? "").trim();
    if (!trackUrl) {
      return;
    }
    const openExternalUrl = window.electronAPI?.openExternalUrl;
    if (openExternalUrl) {
      void openExternalUrl({ url: trackUrl });
      return;
    }
    window.open(trackUrl, "_blank", "noopener,noreferrer");
  }, []);

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
    setIsSidebarHydrated(true);
    setSidebarDirectMessages((current) => (areSidebarSelectionsEqual(current, items) ? current : items));
  }, []);

  useEffect(() => {
    setIsSidebarHydrated(false);
    setShellStartupTimedOut(false);
    setIsInitialShellReady(false);
  }, [currentUserId]);

  useEffect(() => {
    if (isInitialShellReady || canRevealShell) {
      return;
    }
    const timerId = window.setTimeout(() => {
      setShellStartupTimedOut(true);
    }, SHELL_STARTUP_MAX_BLOCK_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [canRevealShell, isInitialShellReady]);

  useEffect(() => {
    if (isInitialShellReady || !canRevealShell) {
      return;
    }
    setIsInitialShellReady(true);
  }, [canRevealShell, isInitialShellReady]);

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
    notificationsService.setRuntimeContext({
      currentUserId,
      activeConversationId: activeDirectMessage?.conversationId ?? null,
      isWindowFocused,
    });
  }, [activeDirectMessage?.conversationId, currentUserId, isWindowFocused]);

  useEffect(() => {
    if (!isWindowFocused) {
      return;
    }
    const setWindowAttention = window.electronAPI?.setWindowAttention;
    if (typeof setWindowAttention !== "function") {
      return;
    }
    void setWindowAttention({ enabled: false });
  }, [isWindowFocused]);

  useEffect(() => {
    const browserDisconnectEvent = "off" + "line";

    const clearNetworkTimers = (): void => {
      if (networkReconnectTimerRef.current !== null) {
        window.clearTimeout(networkReconnectTimerRef.current);
        networkReconnectTimerRef.current = null;
      }
      if (networkBannerHideTimerRef.current !== null) {
        window.clearTimeout(networkBannerHideTimerRef.current);
        networkBannerHideTimerRef.current = null;
      }
    };

    const setInvisivelBanner = (): void => {
      clearNetworkTimers();
      networkOnlineRef.current = false;
      setNetworkBannerState("invisivel");
    };

    const setOnlineBannerSequence = (): void => {
      clearNetworkTimers();

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        networkOnlineRef.current = false;
        setNetworkBannerState("invisivel");
        return;
      }

      networkOnlineRef.current = true;
      setNetworkBannerState("reconnecting");

      networkReconnectTimerRef.current = window.setTimeout(() => {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          networkOnlineRef.current = false;
          setNetworkBannerState("invisivel");
          return;
        }

        setNetworkBannerState("restored");

        networkBannerHideTimerRef.current = window.setTimeout(() => {
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            networkOnlineRef.current = false;
            setNetworkBannerState("invisivel");
            return;
          }
          networkOnlineRef.current = true;
          setNetworkBannerState("online");
          networkBannerHideTimerRef.current = null;
        }, 1300);

        networkReconnectTimerRef.current = null;
      }, 850);
    };

    const syncFromNavigator = (): void => {
      if (typeof navigator === "undefined") {
        return;
      }
      const nextOnline = navigator.onLine;
      if (nextOnline === networkOnlineRef.current) {
        return;
      }
      if (nextOnline) {
        setOnlineBannerSequence();
      } else {
        setInvisivelBanner();
      }
    };

    const handleInvisivel = (): void => {
      setInvisivelBanner();
    };

    const handleOnline = (): void => {
      setOnlineBannerSequence();
    };

    window.addEventListener(browserDisconnectEvent, handleInvisivel);
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", syncFromNavigator);
    document.addEventListener("visibilitychange", syncFromNavigator);

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      networkOnlineRef.current = false;
      setNetworkBannerState("invisivel");
    }

    return () => {
      clearNetworkTimers();
      window.removeEventListener(browserDisconnectEvent, handleInvisivel);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", syncFromNavigator);
      document.removeEventListener("visibilitychange", syncFromNavigator);
    };
  }, []);

  useEffect(() => {
    if (!activeDirectMessage) {
      return;
    }
    setCallHostDirectMessage(activeDirectMessage);
  }, [activeDirectMessage]);

  useEffect(() => {
    sidebarCallBootstrapDoneRef.current = false;
  }, [currentUserId]);

  useEffect(() => {
    if (sidebarCallBootstrapDoneRef.current) {
      return;
    }
    sidebarCallBootstrapDoneRef.current = true;

    const persistedCall = readPersistedSidebarCallStateDetail();
    if (!persistedCall?.active) {
      return;
    }

    const persistedConversationId = String(persistedCall.conversationId ?? "").trim();
    if (!persistedConversationId) {
      return;
    }

    setIsSidebarCallActive(true);
    setSidebarCallConversationId(persistedConversationId);
    const cachedSelection = sidebarDirectMessagesByConversationId.get(persistedConversationId) ?? null;
    if (cachedSelection) {
      setCallHostDirectMessage(cachedSelection);
    }
  }, [sidebarDirectMessagesByConversationId]);

  useEffect(() => {
    const handleSidebarCallState = (event: Event): void => {
      const detail = (event as CustomEvent<SidebarCallStateDetail>).detail;
      if (!detail) {
        return;
      }

      const callActive = Boolean(detail.active);
      setIsSidebarCallActive(callActive);
      if (!callActive) {
        setSidebarCallConversationId(null);
        return;
      }

      const callConversationId = String(detail.conversationId ?? "").trim();
      if (!callConversationId) {
        return;
      }
      setSidebarCallConversationId(callConversationId);

      if (activeDirectMessage && activeDirectMessage.conversationId === callConversationId) {
        setCallHostDirectMessage(activeDirectMessage);
        return;
      }

      const cachedSelection = sidebarDirectMessagesByConversationId.get(callConversationId);
      if (cachedSelection) {
        setCallHostDirectMessage(cachedSelection);
      }
    };

    window.addEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    return () => {
      window.removeEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    };
  }, [activeDirectMessage, sidebarDirectMessagesByConversationId]);

  useEffect(() => {
    return presenceController.subscribe(setPresenceState);
  }, []);

  useEffect(() => {
    const firebaseUid = String(user?.uid ?? "").trim();
    if (!firebaseUid) {
      presenceController.setSpotifyConnectionScope(null);
      return;
    }

    presenceController.setSpotifyConnectionScope(currentUserId ?? firebaseUid);
  }, [currentUserId, user?.uid]);

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
    const optimisticUserId = String(cachedUserId ?? "").trim() || firebaseUid;
    setCurrentUserId((current) => (current === optimisticUserId ? current : optimisticUserId));

    let isMounted = true;
    void queryCurrentUserId(user ?? null).then((resolvedUserId) => {
      if (!isMounted) {
        return;
      }

      if (resolvedUserId) {
        writeCachedCurrentUserId(firebaseUid, resolvedUserId);
        setCurrentUserId((current) => (current === resolvedUserId ? current : resolvedUserId));
        return;
      }

      setCurrentUserId((current) => (current ? current : optimisticUserId));
    });

    return () => {
      isMounted = false;
    };
  }, [user?.displayName, user?.email, user?.uid]);

  useEffect(() => {
    if (!currentUserId) {
      setCurrentUserChatProfile(null);
      return;
    }

    let isMounted = true;

    const fallbackDisplayName = String(user?.displayName ?? "").trim() || "Você";
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
            presenceState: current?.presenceState ?? "invisivel",
          },
    );

    void (async () => {
      try {
        const { data: userRowRaw, error: userError } = await supabase
          .from("profiles")
          .select(PROFILE_SAFE_COLUMNS)
          .eq("id", currentUserId)
          .limit(1)
          .maybeSingle();
        const userRow = userRowRaw as ProfileAny | null;

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
          themePrimaryColor: normalizeBannerColor(userRow?.profile_theme_primary_color) ?? null,
          themeAccentColor: normalizeBannerColor(userRow?.profile_theme_accent_color) ?? null,
          presenceState: "invisivel",
        });
      } catch {
        // keep fallback profile when query fails
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [currentUserChatProfileRefreshToken, currentUserId, user?.displayName]);

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
        const nextThemePrimaryColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_primary_color")
          ? normalizeBannerColor(detail.profile_theme_primary_color) ?? null
          : current.themePrimaryColor ?? null;
        const nextThemeAccentColor = Object.prototype.hasOwnProperty.call(detail, "profile_theme_accent_color")
          ? normalizeBannerColor(detail.profile_theme_accent_color) ?? null
          : current.themeAccentColor ?? null;
        if (
          nextUsername === current.username &&
          nextDisplayName === current.displayName &&
          (current.themePrimaryColor ?? null) === nextThemePrimaryColor &&
          (current.themeAccentColor ?? null) === nextThemeAccentColor
        ) {
          return current;
        }

        return {
          ...current,
          username: nextUsername,
          displayName: nextDisplayName,
          themePrimaryColor: nextThemePrimaryColor,
          themeAccentColor: nextThemeAccentColor,
        };
      });
    };

    window.addEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    };
  }, [currentUserId]);

  useEffect(() => {
    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      return;
    }

    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const bootstrapTimer = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      channel = supabase
        .channel(`messly:profile-sync:${normalizedCurrentUserId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "profiles",
            filter: `id=eq.${normalizedCurrentUserId}`,
          },
          (payload) => {
            const nextRow =
              payload && typeof payload.new === "object" && payload.new !== null
                ? (payload.new as Record<string, unknown>)
                : null;
            if (!nextRow) {
              return;
            }

            const rowUserId = toNullableTrimmedString(nextRow.id);
            if (!rowUserId || rowUserId !== normalizedCurrentUserId) {
              return;
            }

            const profileDetail: ProfileUpdatedDetail = { userId: rowUserId };
            let hasProfilePayload = false;

            if (hasOwnRecordKey(nextRow, "display_name")) {
              profileDetail.display_name = toNullableTrimmedString(nextRow.display_name);
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "username")) {
              profileDetail.username = toNullableTrimmedString(nextRow.username);
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "about")) {
              profileDetail.about = toNullableTrimmedString(nextRow.about);
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "banner_color")) {
              profileDetail.banner_color = normalizeBannerColor(toNullableTrimmedString(nextRow.banner_color)) ?? null;
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "profile_theme_primary_color")) {
              profileDetail.profile_theme_primary_color =
                normalizeBannerColor(toNullableTrimmedString(nextRow.profile_theme_primary_color)) ?? null;
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "profile_theme_accent_color")) {
              profileDetail.profile_theme_accent_color =
                normalizeBannerColor(toNullableTrimmedString(nextRow.profile_theme_accent_color)) ?? null;
              hasProfilePayload = true;
            }
            if (hasOwnRecordKey(nextRow, "username_changed_at")) {
              profileDetail.username_changed_at = toNormalizedIsoTimestamp(nextRow.username_changed_at);
              hasProfilePayload = true;
            }

            if (hasProfilePayload) {
              window.dispatchEvent(new CustomEvent<ProfileUpdatedDetail>("messly:profile-updated", { detail: profileDetail }));
            }

            const mediaDetail: ProfileMediaUpdatedDetail = { userId: rowUserId };
            let hasMediaPayload = false;

            if (hasOwnRecordKey(nextRow, "avatar_key")) {
              mediaDetail.avatar_key = toNullableTrimmedString(nextRow.avatar_key);
              hasMediaPayload = true;
            }
            if (hasOwnRecordKey(nextRow, "avatar_hash")) {
              mediaDetail.avatar_hash = toNullableTrimmedString(nextRow.avatar_hash);
              hasMediaPayload = true;
            }
            if (hasOwnRecordKey(nextRow, "avatar_url")) {
              mediaDetail.avatar_url = toNullableTrimmedString(nextRow.avatar_url);
              hasMediaPayload = true;
            }
            if (hasOwnRecordKey(nextRow, "banner_key")) {
              mediaDetail.banner_key = toNullableTrimmedString(nextRow.banner_key);
              hasMediaPayload = true;
            }
            if (hasOwnRecordKey(nextRow, "banner_hash")) {
              mediaDetail.banner_hash = toNullableTrimmedString(nextRow.banner_hash);
              hasMediaPayload = true;
            }
            if (hasOwnRecordKey(nextRow, "banner_color")) {
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
  }, [currentUserId]);

  useEffect(() => {
    const handleProfileMediaUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileMediaUpdatedDetail>).detail;
      if (!detail?.userId || detail.userId !== currentUserId) {
        return;
      }

      if (
        !Object.prototype.hasOwnProperty.call(detail, "avatar_key") &&
        !Object.prototype.hasOwnProperty.call(detail, "avatar_hash") &&
        !Object.prototype.hasOwnProperty.call(detail, "avatar_url")
      ) {
        return;
      }

      setCurrentUserChatProfileRefreshToken((current) => current + 1);
    };

    window.addEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
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

      const { data: userRowRaw, error: userError } = await supabase
        .from("profiles")
        .select(PROFILE_SAFE_COLUMNS)
        .eq("id", targetUserId)
        .limit(1)
        .maybeSingle();
      const userRow = userRowRaw as ProfileAny | null;

      if (userError || !userRow) {
        return null;
      }

      const username = String(userRow.username ?? "").trim() || "username";
      const displayName = normalizeProfileDisplayName(userRow.display_name, username, username);
      const fallbackAvatar = getFriendDisplayAvatar(displayName, username, targetUserId);

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

      const presenceSnapshot = presenceStore.getPresenceSnapshot(targetUserId);

      return {
        conversationId: typedConversation.id,
        userId: targetUserId,
        username,
        displayName,
        avatarSrc,
        presenceState: presenceSnapshot.presenceState,
        spotifyActivity: presenceSnapshot.spotifyActivity ?? null,
        firebaseUid: String(userRow.firebase_uid ?? "").trim() || undefined,
        aboutText: String(userRow.about ?? "").trim(),
        bannerColor: userRow.banner_color ?? null,
        themePrimaryColor: normalizeBannerColor(userRow.profile_theme_primary_color) ?? null,
        themeAccentColor: normalizeBannerColor(userRow.profile_theme_accent_color) ?? null,
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
    if (!isSidebarCallActive) {
      return;
    }

    const callConversationId = String(sidebarCallConversationId ?? "").trim();
    if (!callConversationId || !currentUserId) {
      return;
    }

    if (callHostDirectMessage?.conversationId === callConversationId) {
      return;
    }

    const cachedSelection = sidebarDirectMessagesByConversationId.get(callConversationId);
    if (cachedSelection) {
      setCallHostDirectMessage(cachedSelection);
      return;
    }

    let cancelled = false;
    void resolveDirectMessageByConversationId(callConversationId).then((resolved) => {
      if (cancelled || !resolved) {
        return;
      }
      setCallHostDirectMessage(resolved);
    });

    return () => {
      cancelled = true;
    };
  }, [
    callHostDirectMessage?.conversationId,
    currentUserId,
    isSidebarCallActive,
    resolveDirectMessageByConversationId,
    sidebarCallConversationId,
    sidebarDirectMessagesByConversationId,
  ]);

  useEffect(() => {
    const consumeLocationConversation = (): void => {
      const conversationId = getConversationIdFromLocation(window.location);
      if (!conversationId) {
        return;
      }
      setPendingNotificationConversationId(conversationId);
    };

    consumeLocationConversation();
    window.addEventListener("hashchange", consumeLocationConversation);
    window.addEventListener("popstate", consumeLocationConversation);
    return () => {
      window.removeEventListener("hashchange", consumeLocationConversation);
      window.removeEventListener("popstate", consumeLocationConversation);
    };
  }, []);

  useEffect(() => {
    notificationNavigationCoordinator.start();
    const unsubscribe = notificationNavigationCoordinator.setOpenConversationHandler((payload) => {
      const conversationId = String(payload?.conversationId ?? "").trim();
      if (!conversationId) {
        return;
      }
      void openDirectMessageConversationById(conversationId);
    });
    notificationNavigationCoordinator.notifyRendererReady();
    return unsubscribe;
  }, [openDirectMessageConversationById]);

  useEffect(() => {
    if (!pendingNotificationConversationId || !currentUserId) {
      return;
    }

    void openDirectMessageConversationById(pendingNotificationConversationId).finally(() => {
      clearConversationIdFromLocation();
      setPendingNotificationConversationId(null);
    });
  }, [currentUserId, openDirectMessageConversationById, pendingNotificationConversationId]);

  const refreshFriends = async (typedRequests: FriendRequestRow[], showLoading = false): Promise<void> => {
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
          if (typedRequests.length === 0) {
            setFriends((current) => (current.length === 0 ? current : []));
            continue;
          }

          const friendRequestByUserId = new Map<string, string>();
          typedRequests.forEach((request) => {
            const friendId = request.requester_id === currentUserId ? request.addressee_id : request.requester_id;
            if (!friendId || friendId === currentUserId) {
              return;
            }
            if (!friendRequestByUserId.has(friendId)) {
              friendRequestByUserId.set(friendId, request.id);
            }
          });

          const friendIds = Array.from(friendRequestByUserId.keys());
          if (friendIds.length === 0) {
            setFriends((current) => (current.length === 0 ? current : []));
            continue;
          }

          const { data: usersRaw, error: usersError } = await supabase
            .from("profiles")
            .select(PROFILE_SAFE_COLUMNS)
            .in("id", friendIds);
          const users = usersRaw as ProfileAny[] | null;

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
            const friendPresenceSnapshot = presenceStore.getPresenceSnapshot(friendId);
            const fallbackPresence = friendPresenceSnapshot.presenceState;
            const fallbackSpotifyActivity = friendPresenceSnapshot.spotifyActivity;
            const resolvedPresence = friendPresenceCache.get(friendId) ?? fallbackPresence;
            friendPresenceCache.set(friendId, resolvedPresence);

            initialFriends.push({
              requestId,
              userId: friendId,
              username,
              displayName,
              avatarSrc: cachedAvatar ?? getFriendDisplayAvatar(displayName, username, friendId),
              presenceState: resolvedPresence,
              ...(fallbackSpotifyActivity ? { spotifyActivity: fallbackSpotifyActivity } : {}),
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
                return [friendId, getFriendDisplayAvatar("U", "U", friendId)] as const;
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
                      ? getFriendDisplayAvatar(displayName, username, friendId)
                      : resolvedLegacyAvatar;
                  } else {
                    avatarSrc = getFriendDisplayAvatar(displayName, username, friendId);
                  }
                }
                setCachedFriendAvatar(friendId, avatarSignature, avatarSrc);
                return [friendId, avatarSrc] as const;
              } catch {
                const fallbackAvatar = getFriendDisplayAvatar(displayName, username, friendId);
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
            setFriendsError("As solicitações de amizade estão indisponíveis no momento.");
            setFriends((current) => (current.length === 0 ? current : []));
            return;
          }
          setFriendsError("Não foi possível carregar seus amigos.");
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

  const refreshPendingRequests = async (typedRequests: FriendRequestRow[], showLoading = false): Promise<void> => {
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

          const { data: usersRaw, error: usersError } = await supabase
            .from("profiles")
            .select(PROFILE_SAFE_COLUMNS)
            .in("id", targetIds);
          const users = usersRaw as ProfileAny[] | null;

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
              avatarSrc: cachedAvatar ?? getPendingDisplayAvatar(displayName, username, targetUserId),
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
                return [id, getPendingDisplayAvatar("U", "U", id)] as const;
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
                      ? getPendingDisplayAvatar(displayName, username, id)
                      : resolvedLegacyAvatar;
                  } else {
                    avatarSrc = getPendingDisplayAvatar(displayName, username, id);
                  }
                }

                setCachedPendingAvatar(id, avatarSignature, avatarSrc);
                return [id, avatarSrc] as const;
              } catch {
                const fallbackAvatar = getPendingDisplayAvatar(displayName, username, id);
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
          setPendingError("Não foi possível carregar as solicitações pendentes.");
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
    setHasInitializedFriends(false);
    setFriends((current) => (current.length === 0 ? current : []));
    setPendingCards((current) => (current.length === 0 ? current : []));
    friendPresenceCache.clear();
  }, [currentUserId]);

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
    if (acceptedFriendRequestsQuery.error) {
      if (isFriendRequestsUnavailableError(acceptedFriendRequestsQuery.error)) {
        setIsFriendRequestsAvailable(false);
        setFriendsError("As solicitações de amizade estão indisponíveis no momento.");
        setFriends((current) => (current.length === 0 ? current : []));
        return;
      }
      setFriendsError("Não foi possível carregar seus amigos.");
      return;
    }
    void refreshFriends(acceptedFriendRequests, !hasInitializedFriends);
  }, [
    acceptedFriendRequests,
    acceptedFriendRequestsQuery.error,
    currentUserId,
    hasInitializedFriends,
    isFriendRequestsAvailable,
  ]);

  useEffect(() => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    const cached = readFriendsCache(currentUserId);
    if (!cached || cached.length === 0) {
      return;
    }

    const sanitizedCached = cached.filter((friend) => {
      const friendId = String(friend.userId ?? "").trim();
      return Boolean(friendId) && friendId !== currentUserId;
    });
    if (sanitizedCached.length === 0) {
      setFriends((current) => (current.length === 0 ? current : []));
      return;
    }

    setHasInitializedFriends(true);
    sanitizedCached.forEach((friend) => {
      friendPresenceCache.set(friend.userId, friend.presenceState);
    });

    setFriends((current) => (areFriendListsEqual(current, sanitizedCached) ? current : sanitizedCached));
  }, [currentUserId, isFriendRequestsAvailable]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }
    writeFriendsCache(currentUserId, friends);
  }, [currentUserId, friends]);

  useEffect(() => {
    if (!friendPresenceUserIdsKey) {
      return;
    }

    return presenceStore.watchUsers(friendPresenceUserIdsKey.split("|"));
  }, [friendPresenceUserIdsKey]);

  useEffect(() => {
    if (!friendPresenceUserIdsKey) {
      return;
    }

    const applyFriendPresences = (): void => {
      setFriends((current) => {
        let changed = false;
        const next = current.map((friend) => {
          const nextPresenceSnapshot = presenceStore.getPresenceSnapshot(friend.userId);
          const nextPresenceState = nextPresenceSnapshot.presenceState;
          const nextSpotifyActivity = nextPresenceSnapshot.spotifyActivity ?? null;
          if (
            friend.presenceState === nextPresenceState &&
            areSpotifyActivitiesEqual(friend.spotifyActivity ?? null, nextSpotifyActivity)
          ) {
            return friend;
          }

          friendPresenceCache.set(friend.userId, nextPresenceState);
          changed = true;
          return {
            ...friend,
            presenceState: nextPresenceState,
            spotifyActivity: nextSpotifyActivity,
          };
        });

        return changed ? next : current;
      });
    };

    applyFriendPresences();
    return presenceStore.subscribe(applyFriendPresences);
  }, [friendPresenceUserIdsKey]);

  useEffect(() => {
    const targetUserId = String(openPendingProfile?.userId ?? "").trim();
    if (!targetUserId) {
      return;
    }

    const stopWatching = presenceStore.watchUsers([targetUserId]);
    const applyOpenPendingPresence = (): void => {
      setOpenPendingProfile((current) => {
        if (!current || current.userId !== targetUserId) {
          return current;
        }

        const nextPresenceSnapshot = presenceStore.getPresenceSnapshot(targetUserId);
        const nextPresenceState = nextPresenceSnapshot.presenceState;
        const nextSpotifyActivity = nextPresenceSnapshot.spotifyActivity ?? null;
        if (
          current.presenceState === nextPresenceState &&
          areSpotifyActivitiesEqual(current.spotifyActivity ?? null, nextSpotifyActivity)
        ) {
          return current;
        }

        return {
          ...current,
          presenceState: nextPresenceState,
          spotifyActivity: nextSpotifyActivity,
        };
      });
    };

    applyOpenPendingPresence();
    const unsubscribe = presenceStore.subscribe(applyOpenPendingPresence);

    return () => {
      unsubscribe();
      stopWatching();
    };
  }, [openPendingProfile?.userId]);

  useEffect(() => {
    const targetUserId = String(activeDirectMessage?.userId ?? "").trim();
    if (!targetUserId) {
      return;
    }

    const stopWatching = presenceStore.watchUsers([targetUserId]);
    const applyActiveDirectMessagePresence = (): void => {
      setActiveDirectMessage((current) => {
        if (!current || current.userId !== targetUserId) {
          return current;
        }

        const nextPresenceSnapshot = presenceStore.getPresenceSnapshot(targetUserId);
        const nextPresenceState = nextPresenceSnapshot.presenceState;
        const nextSpotifyActivity = nextPresenceSnapshot.spotifyActivity ?? null;
        if (
          current.presenceState === nextPresenceState &&
          areSpotifyActivitiesEqual(current.spotifyActivity ?? null, nextSpotifyActivity)
        ) {
          return current;
        }

        return {
          ...current,
          presenceState: nextPresenceState,
          spotifyActivity: nextSpotifyActivity,
        };
      });
    };

    applyActiveDirectMessagePresence();
    const unsubscribe = presenceStore.subscribe(applyActiveDirectMessagePresence);

    return () => {
      unsubscribe();
      stopWatching();
    };
  }, [activeDirectMessage?.userId]);

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

      const sidebarSelection = sidebarDirectMessagesByConversationId.get(current.conversationId);
      if (!sidebarSelection) {
        return current;
      }

      return areSidebarSelectionsEqual([current], [sidebarSelection]) ? current : sidebarSelection;
    });
  }, [sidebarDirectMessagesByConversationId]);

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
        areSpotifyActivitiesEqual(current.spotifyActivity ?? null, matchedFriend.spotifyActivity ?? null) &&
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
        spotifyActivity: matchedFriend.spotifyActivity ?? null,
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
    if (!currentUserId) {
      setPendingCards((current) => (current.length === 0 ? current : []));
      return;
    }
    if (pendingFriendRequestsQuery.error) {
      if (isFriendRequestsUnavailableError(pendingFriendRequestsQuery.error)) {
        setIsFriendRequestsAvailable(false);
        setPendingError(null);
        setPendingCards((current) => (current.length === 0 ? current : []));
        return;
      }
      setPendingError("Não foi possível carregar as solicitações pendentes.");
      setPendingCards((current) => (current.length === 0 ? current : []));
      return;
    }
    void refreshPendingRequests(pendingFriendRequests, pendingFriendRequestsQuery.isLoading);
  }, [currentUserId, isFriendRequestsAvailable, pendingFriendRequests, pendingFriendRequestsQuery.error, pendingFriendRequestsQuery.isLoading]);

  useEffect(() => {
    const handleFriendRequestsChanged = (): void => {
      if (!isFriendRequestsAvailable) {
        return;
      }
      void pendingFriendRequestsQuery.refetch();
      void acceptedFriendRequestsQuery.refetch();
      void queryClient.invalidateQueries({
        queryKey: ["friend_requests", String(currentUserId ?? "").trim()],
      });
    };

    window.addEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
    return () => {
      window.removeEventListener("messly:friend-requests-changed", handleFriendRequestsChanged);
    };
  }, [
    acceptedFriendRequestsQuery,
    currentUserId,
    isFriendRequestsAvailable,
    pendingFriendRequestsQuery,
    queryClient,
  ]);

  const handleAcceptRequest = async (requestId: string, targetUserId: string): Promise<void> => {
    if (!currentUserId || !isFriendRequestsAvailable) {
      return;
    }
    const { error: updateError } = await supabase.from("friend_requests").update({ status: "accepted" }).eq("id", requestId);
    if (updateError) {
      setPendingError("Não foi possível aceitar a solicitação.");
      return;
    }

    setPendingError(null);
    setPendingCards((current) => current.filter((card) => card.requestId !== requestId));
    setOpenPendingProfile((current) => (current?.userId === targetUserId ? null : current));
    window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));

    try {
      await ensureDirectConversation(currentUserId, targetUserId);
    } catch (error) {
      setPendingError(`Solicitação aceita. ${resolveOpenConversationErrorMessage(error)}`);
    }
  };

  const handleRejectRequest = async (requestId: string): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }
    const rejectedCard = pendingCards.find((card) => card.requestId === requestId) ?? null;
    const { error } = await supabase.from("friend_requests").update({ status: "rejected" }).eq("id", requestId);
    if (error) {
      setPendingError("Não foi possível recusar a solicitação.");
      return;
    }
    setPendingError(null);
    setPendingCards((current) => current.filter((card) => card.requestId !== requestId));
    if (rejectedCard?.targetUserId) {
      setOpenPendingProfile((current) => (current?.userId === rejectedCard.targetUserId ? null : current));
    }
    window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));
  };

  const handleCancelRequest = async (requestId: string): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }
    const canceledCard = pendingCards.find((card) => card.requestId === requestId) ?? null;
    const { error } = await supabase.from("friend_requests").delete().eq("id", requestId);
    if (error) {
      setPendingError("Não foi possível cancelar a solicitação.");
      return;
    }
    setPendingError(null);
    setPendingCards((current) => current.filter((card) => card.requestId !== requestId));
    if (canceledCard?.targetUserId) {
      setOpenPendingProfile((current) => (current?.userId === canceledCard.targetUserId ? null : current));
    }
    window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));
  };

  const handleOpenPendingProfileConversation = useCallback(async (): Promise<void> => {
    if (!currentUserId || !openPendingProfile) {
      return;
    }

    try {
      const conversationId = await ensureDirectConversation(currentUserId, openPendingProfile.userId);
      setActiveDirectMessage({
        conversationId,
        userId: openPendingProfile.userId,
        username: openPendingProfile.username,
        displayName: openPendingProfile.displayName,
        avatarSrc: openPendingProfile.avatarSrc,
        presenceState: openPendingProfile.presenceState,
        aboutText: openPendingProfile.aboutText,
        bannerColor: openPendingProfile.bannerColor,
        themePrimaryColor: openPendingProfile.themePrimaryColor,
        themeAccentColor: openPendingProfile.themeAccentColor,
        bannerSrc: openPendingProfile.bannerSrc,
      });
      handleClosePendingProfile();
    } catch (error) {
      setPendingError(resolveOpenConversationErrorMessage(error));
    }
  }, [currentUserId, handleClosePendingProfile, openPendingProfile]);

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
        spotifyActivity: friend.spotifyActivity ?? null,
        firebaseUid: friend.firebaseUid,
      });
    } catch (error) {
      setFriendsError(resolveOpenConversationErrorMessage(error));
    }
  };

  const handleUnfriend = async (friend: FriendListItem): Promise<void> => {
    if (!isFriendRequestsAvailable) {
      return;
    }

    setActiveFriendMenuUserId(null);

    const { error } = await supabase.from("friend_requests").delete().eq("id", friend.requestId);
    if (error) {
      setFriendsError("Não foi possível desfazer a amizade.");
      return;
    }

    friendPresenceCache.delete(friend.userId);
    setFriends((current) => current.filter((item) => item.userId !== friend.userId));
  };

  const handleAddFriendTargetUser = async (targetUserId: string): Promise<void> => {
    if (!currentUserId || !targetUserId || targetUserId === currentUserId || !isFriendRequestsAvailable) {
      return;
    }

    try {
      const { data: targetUser, error: targetUserError } = await queryFriendRequestTargetById(targetUserId);
      if (targetUserError) {
        setFriendsError("Não foi possível verificar as permissões desse perfil.");
        throw targetUserError;
      }

      if (!targetUser?.id) {
        setFriendsError("Perfil não encontrado.");
        throw new Error("FRIEND_TARGET_NOT_FOUND");
      }

      const permission = await evaluateFriendRequestPermission(currentUserId, targetUser);
      if (!permission.allowed) {
        if (permission.reason === "disabled" || permission.reason === "friends_of_friends_only") {
          dispatchFriendRequestBlockedNotice(buildFriendRequestBlockedNotice(targetUser, permission.reason));
        }
        throw new Error(`FRIEND_REQUEST_BLOCKED_${permission.reason}`);
      }

      const { data: insertedRequest, error } = await supabase
        .from("friend_requests")
        .insert({
          requester_id: currentUserId,
          addressee_id: targetUserId,
          status: "pending",
        })
        .select("id,requester_id,addressee_id,status,created_at")
        .limit(1)
        .maybeSingle();

      if (error) {
        const errorCode = String((error as { code?: string | null }).code ?? "");
        if (errorCode === "23505") {
          setFriendsError("Esse usuário já recebeu sua solicitação ou já é seu amigo.");
          throw error;
        }
        setFriendsError("Não foi possível enviar a solicitação de amizade.");
        throw error;
      }

      const normalizedUsername = String(targetUser.username ?? "").trim() || "username";
      const normalizedDisplayName = normalizeProfileDisplayName(targetUser.display_name, normalizedUsername, normalizedUsername);
      const activeDmAvatarSrc =
        activeDirectMessage && activeDirectMessage.userId === targetUserId
          ? String(activeDirectMessage.avatarSrc ?? "").trim()
          : "";
      const fallbackAvatarSrc = getPendingDisplayAvatar(normalizedDisplayName, normalizedUsername, targetUserId);
      const requestId =
        String((insertedRequest as { id?: string | null } | null)?.id ?? "").trim() ||
        `pending:${currentUserId}:${targetUserId}`;
      const createdAt = String((insertedRequest as { created_at?: string | null } | null)?.created_at ?? "").trim() || new Date().toISOString();

      setPendingCards((current) => {
        const alreadyExists = current.some(
          (card) =>
            card.requestId === requestId ||
            (card.targetUserId === targetUserId && card.direction === "outgoing"),
        );
        if (alreadyExists) {
          return current;
        }

        return [
          {
            requestId,
            targetUserId,
            username: normalizedUsername,
            displayName: normalizedDisplayName,
            avatarSrc: activeDmAvatarSrc || fallbackAvatarSrc,
            direction: "outgoing",
            createdAt,
          },
          ...current,
        ];
      });

      window.dispatchEvent(new CustomEvent("messly:friend-requests-changed"));
    } catch (error) {
      const code = String((error as { message?: string } | null)?.message ?? "");
      if (code.startsWith("FRIEND_REQUEST_BLOCKED_")) {
        return;
      }

      if (!code || code === "FRIEND_REQUEST_SEND_FAILED") {
        setFriendsError("Não foi possível enviar a solicitação de amizade.");
      }
      throw error instanceof Error ? error : new Error("FRIEND_REQUEST_SEND_FAILED");
    }
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
          setFriendsError("Bloqueio de usuário indisponível no banco de dados.");
        } else {
          setFriendsError("Não foi possível bloquear o usuário.");
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
      setFriendsError("Usuário bloqueado, mas não foi possível atualizar a lista de amigos.");
    }

    friendPresenceCache.delete(targetUserId);
    setFriends((current) => current.filter((item) => item.userId !== targetUserId));
    setPendingCards((current) => current.filter((card) => card.targetUserId !== targetUserId));
    setActiveFriendMenuUserId((current) => (current === targetUserId ? null : current));
    setActiveDirectMessage((current) => (current?.userId === targetUserId ? null : current));
  };

  const pendingCount = isFriendRequestsAvailable ? pendingCards.length : 0;
  useEffect(() => {
    if (!isFriendRequestsAvailable) {
      return;
    }
    if (activeFriendsTab !== "pending") {
      return;
    }
    if (isPendingLoading) {
      return;
    }
    if (pendingCards.length > 0) {
      return;
    }
    setActiveFriendsTab("online");
  }, [activeFriendsTab, isFriendRequestsAvailable, isPendingLoading, pendingCards.length]);

  const sortedFriends = useMemo(() => {
    const uniqueById = new Map<string, FriendListItem>();
    friends.forEach((friend) => {
      const friendId = String(friend.userId ?? "").trim();
      if (!friendId) {
        return;
      }
      if (currentUserId && friendId === currentUserId) {
        return;
      }
      if (!uniqueById.has(friendId)) {
        uniqueById.set(friendId, friend);
      }
    });

    const copy = Array.from(uniqueById.values());
    copy.sort((a, b) => {
      const rankDiff = getPresenceSortRank(a.presenceState) - getPresenceSortRank(b.presenceState);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return a.displayName.localeCompare(b.displayName, "pt-BR", { sensitivity: "base" });
    });
    return copy;
  }, [currentUserId, friends]);
  const availableFriends = useMemo(() => sortedFriends.filter((friend) => isAvailablePresence(friend.presenceState)), [sortedFriends]);
  const allFriends = sortedFriends;
  const rightSidebarSpotifyFriends = useMemo(
    () =>
      sortedFriends.filter((friend) => {
        if (!friend.spotifyActivity) {
          return false;
        }
        if (friend.userId === currentUserId) {
          return false;
        }
        return true;
      }),
    [currentUserId, sortedFriends],
  );

  useEffect(() => {
    if (!currentUserId || rightSidebarSpotifyFriends.length === 0) {
      setListenAlongSessionsByFriendId({});
      return;
    }

    const nextSessions: Record<string, SpotifyListenAlongSession> = {};
    const unsubscribers = rightSidebarSpotifyFriends.map((friend) => {
      const applySession = (session: SpotifyListenAlongSession): void => {
        setListenAlongSessionsByFriendId((current) => {
          const currentSession = current[friend.userId];
          const normalizedSession = session;
          if (
            currentSession &&
            currentSession.active === normalizedSession.active &&
            currentSession.trackId === normalizedSession.trackId &&
            currentSession.updatedAt === normalizedSession.updatedAt &&
            currentSession.hostAvatarSrc === normalizedSession.hostAvatarSrc &&
            currentSession.listenerAvatarSrc === normalizedSession.listenerAvatarSrc
          ) {
            return current;
          }
          return {
            ...current,
            [friend.userId]: normalizedSession,
          };
        });
      };

      const initialSession = readSpotifyListenAlongSession(currentUserId, friend.userId);
      nextSessions[friend.userId] = initialSession;
      return subscribeSpotifyListenAlongSession(currentUserId, friend.userId, applySession);
    });

    setListenAlongSessionsByFriendId(nextSessions);

    return () => {
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }, [currentUserId, rightSidebarSpotifyFriends]);
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

  useEffect(() => {
    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    const normalizedTargetUserId = String(chatViewDirectMessage?.userId ?? "").trim();

    if (!normalizedCurrentUserId || !normalizedTargetUserId || normalizedTargetUserId === normalizedCurrentUserId) {
      activeDirectMessageMutualTargetUserIdRef.current = "";
      setActiveDirectMessageMutualFriendIds((current) => (current.length === 0 ? current : []));
      return;
    }

    if (activeDirectMessageMutualTargetUserIdRef.current !== normalizedTargetUserId) {
      activeDirectMessageMutualTargetUserIdRef.current = normalizedTargetUserId;
      setActiveDirectMessageMutualFriendIds((current) => (current.length === 0 ? current : []));
    }

    const requestToken = activeDirectMessageMutualFetchTokenRef.current + 1;
    activeDirectMessageMutualFetchTokenRef.current = requestToken;
    let isDisposed = false;

    const run = async (): Promise<void> => {
      try {
        const nextMutualFriendIds = await listMutualFriendIdsForCurrentUser(normalizedTargetUserId);
        if (isDisposed || activeDirectMessageMutualFetchTokenRef.current !== requestToken) {
          return;
        }

        setActiveDirectMessageMutualFriendIds((current) =>
          areStringArraysEqual(current, nextMutualFriendIds) ? current : nextMutualFriendIds,
        );
      } catch (error) {
        if (isDisposed || activeDirectMessageMutualFetchTokenRef.current !== requestToken) {
          return;
        }
        console.error("[app:mutual-friends] failed to load mutual friends", error);
        setActiveDirectMessageMutualFriendIds((current) => (current.length === 0 ? current : []));
      }
    };

    void run();

    return () => {
      isDisposed = true;
    };
  }, [chatViewDirectMessage?.userId, currentUserId, friendPresenceUserIdsKey]);

  const activeDirectMessageMutualFriends = useMemo(() => {
    if (!chatViewDirectMessage || activeDirectMessageMutualFriendIds.length === 0) {
      return [];
    }

    const mutualFriendIdSet = new Set(activeDirectMessageMutualFriendIds);

    return allFriends
      .filter((friend) => friend.userId !== chatViewDirectMessage.userId && mutualFriendIdSet.has(friend.userId))
      .map((friend) => ({
        userId: friend.userId,
        displayName: friend.displayName,
        username: friend.username,
        avatarSrc: friend.avatarSrc,
      }));
  }, [activeDirectMessageMutualFriendIds, allFriends, chatViewDirectMessage]);
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

    const fallbackDisplayName = String(user?.displayName ?? "").trim() || "Você";
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
      themePrimaryColor: currentUserChatProfile?.themePrimaryColor ?? null,
      themeAccentColor: currentUserChatProfile?.themeAccentColor ?? null,
    };
  }, [currentUserId, currentUserChatProfile, presenceState, user?.displayName, user?.uid]);
  const showNetworkBanner = networkBannerState !== "online";
  const networkBannerMeta = useMemo(() => {
    switch (networkBannerState) {
      case "invisivel":
        return {
          tone: "invisivel",
          icon: "wifi_off",
          title: "Sem internet",
          subtitle: "Tentando reconectar automaticamente...",
        } as const;
      case "reconnecting":
        return {
          tone: "reconnecting",
          icon: "sync",
          title: "Reconectando",
          subtitle: "Restabelecendo a conexão...",
        } as const;
      case "restored":
        return {
          tone: "restored",
          icon: "wifi",
          title: "Conexão restabelecida",
          subtitle: "Tudo pronto novamente.",
        } as const;
      default:
        return null;
    }
  }, [networkBannerState]);
  const isOpenPendingProfileCurrentUser = Boolean(
    openPendingProfile &&
      currentUserId &&
      openPendingProfile.userId === currentUserId,
  );

  useEffect(() => {
    if (!friendsError) {
      return;
    }
    console.error("[app:friends]", friendsError);
  }, [friendsError]);

  useEffect(() => {
    if (!pendingError) {
      return;
    }
    console.error("[app:pending]", pendingError);
  }, [pendingError]);
  const shellStartupDetailText = shellStartupTimedOut
    ? "Abrindo interface enquanto sincroniza dados"
    : !isSidebarHydrated
      ? "Carregando conversas"
      : !isFriendsAndPendingReady
        ? "Carregando amigos e pendencias"
        : "Abrindo interface";
  const shellStartupProgress = canRevealShell ? 0.99 : isSidebarHydrated ? 0.9 : 0.82;

  return (
    <div className="app-shell" data-messly-startup-surface="shell">
      {!isInitialShellReady ? (
        <AppStartupScreen
          statusText="Carregando Messly"
          detailText={shellStartupDetailText}
          progress={shellStartupProgress}
          phase="running"
        />
      ) : null}
      <TopBar
        section={activeDirectMessage ? "directMessages" : "friends"}
        isCallActive={isSidebarCallActive}
        onPrepareForUpdateInstall={handlePrepareForUpdateInstall}
      />
      <ServerRail />
      <Suspense fallback={null}>
        <DirectMessagesSidebar
          currentUserId={currentUserId}
          isWindowFocused={isWindowFocused}
          presenceState={presenceState}
          onChangePresence={handleChangePresence}
          onOpenSettings={handleOpenSettings}
          activeConversationId={activeDirectMessage?.conversationId ?? null}
          onDirectMessagesChange={handleSidebarDirectMessagesChange}
          onSelectDirectMessage={(dm) => {
            setActiveDirectMessage(dm);
          }}
          onOpenFriends={() => {
            setActiveDirectMessage(null);
          }}
        />
      </Suspense>
      <main
        className={`main-panel${activeDirectMessage ? " main-panel--chat" : ""}${
          showNetworkBanner ? " main-panel--network-status" : ""
        }`}
      >
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
                  Disponível
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
            <div className="main-panel__navbar-actions">
              <button
                className="main-panel__navbar-add-friend"
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("messly:open-add-friend-modal"));
                }}
              >
                Adicionar amigo
              </button>
            </div>
          </header>
        ) : null}

        {showNetworkBanner && networkBannerMeta ? (
          <section
            className={`main-panel__network-banner main-panel__network-banner--${networkBannerMeta.tone}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="main-panel__network-banner-dot" aria-hidden="true" />
            <MaterialSymbolIcon className="main-panel__network-banner-icon" name={networkBannerMeta.icon} size={18} />
            <div className="main-panel__network-banner-copy">
              <strong className="main-panel__network-banner-title">{networkBannerMeta.title}</strong>
              <span className="main-panel__network-banner-subtitle">{networkBannerMeta.subtitle}</span>
            </div>
          </section>
        ) : null}

        <section className={`main-panel__content${activeDirectMessage ? " main-panel__content--chat" : ""}`}>
          <div className="main-panel__workspace">
            {chatViewDirectMessage && chatCurrentUser ? (
              <div className={`main-panel__chat-view${activeDirectMessage ? "" : " main-panel__chat-view--hidden"}`}>
                <Suspense fallback={null}>
                  <DirectMessageChatView
                    conversationId={chatViewDirectMessage.conversationId}
                    currentUserId={chatCurrentUser.userId}
                    currentUser={chatCurrentUser}
                    targetUser={{
                      userId: chatViewDirectMessage.userId,
                      username: chatViewDirectMessage.username,
                      displayName: chatViewDirectMessage.displayName,
                      avatarSrc: chatViewDirectMessage.avatarSrc,
                      presenceState: chatViewDirectMessage.presenceState,
                      spotifyActivity:
                        chatViewDirectMessage.spotifyActivity ?? activeDirectMessageFriend?.spotifyActivity ?? null,
                      firebaseUid: chatViewDirectMessage.firebaseUid,
                      aboutText: chatViewDirectMessage.aboutText,
                      bannerColor: chatViewDirectMessage.bannerColor ?? null,
                      themePrimaryColor: chatViewDirectMessage.themePrimaryColor ?? null,
                      themeAccentColor: chatViewDirectMessage.themeAccentColor ?? null,
                      bannerKey: chatViewDirectMessage.bannerKey ?? null,
                      bannerHash: chatViewDirectMessage.bannerHash ?? null,
                      bannerSrc: chatViewDirectMessage.bannerSrc,
                      memberSinceAt: chatViewDirectMessage.memberSinceAt ?? null,
                    }}
                    onOpenSettings={handleOpenSettings}
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
                    mutualFriends={activeDirectMessageMutualFriends}
                    onBlockTarget={async () => {
                      await handleBlockTargetUser(chatViewDirectMessage.userId);
                    }}
                  />
                </Suspense>
              </div>
            ) : null}

            {!activeDirectMessage && activeFriendsTab !== "pending" ? (
              <section className="main-panel__friends" aria-label="Lista de amigos">
                <div className="main-panel__friends-search">
                  <MaterialSymbolIcon className="main-panel__friends-search-icon" name="search" size={18} />
                  <input
                    className="main-panel__friends-search-input"
                    type="text"
                    placeholder="Buscar amigos"
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
                      ? `Disponíveis (${filteredAvailableFriends.length})`
                      : `Todos os amigos (${filteredAllFriends.length})`}
                  </h2>
                </header>

                {canShowFriendsState && allFriends.length === 0 && !isFriendsLoading ? (
                  <p className="main-panel__friends-empty">
                    Você ainda não tem amigos. Envie uma solicitação para começar.
                  </p>
                ) : null}
                {canShowFriendsState && allFriends.length > 0 && visibleFriends.length === 0 ? (
                  <p className="main-panel__friends-empty">
                    {hasFriendSearch ? "Nenhum amigo encontrado." : "Nenhum amigo disponível no momento."}
                  </p>
                ) : null}

                {visibleFriends.length > 0 ? (
                  <div className="main-panel__friends-list">
                    {visibleFriends.map((friend) => {
                      const spotifyActivity = isSpotifyActivityFresh(friend.spotifyActivity ?? null)
                        ? friend.spotifyActivity
                        : null;
                      const spotifyStatusText = spotifyActivity
                        ? String(spotifyActivity.artistNames || spotifyActivity.trackTitle || "").trim()
                        : "";
                      const shouldShowSpotifyStatus = spotifyStatusText.length > 0;
                      return (
                        <article key={friend.userId} className="main-panel__friend-item">
                        <div className="main-panel__friend-avatar-wrap">
                          <AvatarImage
                            className="main-panel__friend-avatar"
                            src={friend.avatarSrc}
                            name={friend.displayName || friend.username}
                            alt={`Avatar de ${friend.displayName}`}
                            loading="eager"
                          />
                          <span
                            className={`main-panel__friend-presence main-panel__friend-presence--${friend.presenceState}`}
                            aria-hidden="true"
                          />
                        </div>

                        <div className="main-panel__friend-meta">
                          <p className="main-panel__friend-name">{friend.displayName}</p>
                          <p className="main-panel__friend-status">
                            {shouldShowSpotifyStatus ? (
                              <span className="main-panel__friend-spotify-status">
                                <img className="main-panel__friend-spotify-icon" src={musicalIcon} alt="" aria-hidden="true" />
                                <span className="main-panel__friend-spotify-text">{spotifyStatusText}</span>
                              </span>
                            ) : (
                              getPresenceLabel(friend.presenceState)
                            )}
                          </p>
                          <p className="main-panel__friend-username">@{friend.username}</p>
                        </div>

                        <div className="main-panel__friend-actions">
                          <button
                            className="main-panel__friend-action-btn"
                            type="button"
                            title="Mensagem"
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
                              title="Ações"
                              aria-label={`Ações para ${friend.displayName}`}
                              aria-haspopup="menu"
                              aria-expanded={activeFriendMenuUserId === friend.userId}
                              onClick={() => {
                                setActiveFriendMenuUserId((current) => (current === friend.userId ? null : friend.userId));
                              }}
                            >
                              <MaterialSymbolIcon name="more_vert" size={18} />
                            </button>

                            {activeFriendMenuUserId === friend.userId ? (
                              <div className="main-panel__friend-menu" role="menu" aria-label={`Ações de ${friend.displayName}`}>
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
                      );
                    })}
                  </div>
                ) : null}
              </section>
            ) : null}

            {!activeDirectMessage && activeFriendsTab === "pending" ? (
              <section className="main-panel__pending" aria-label="Solicitações pendentes">
                <header className="main-panel__pending-header">
                  <h2 className="main-panel__pending-title">Pendentes</h2>
                </header>

                {isPendingLoading ? <p className="main-panel__pending-empty">Carregando solicitações...</p> : null}
                {!isPendingLoading && pendingCards.length === 0 ? (
                  <p className="main-panel__pending-empty">Nenhuma solicitação pendente.</p>
                ) : null}

                {!isPendingLoading && pendingCards.length > 0 ? (
                  <div className="main-panel__pending-list">
                    {pendingCards.map((card) => (
                      <article key={card.requestId} className="main-panel__pending-item">
                        <button
                          type="button"
                          className="main-panel__pending-avatar-button"
                          onClick={() => {
                            void handleOpenPendingProfile(card);
                          }}
                          aria-label={`Abrir perfil de ${card.displayName}`}
                          title={`Abrir perfil de ${card.displayName}`}
                        >
                          <AvatarImage
                            className="main-panel__pending-avatar"
                            src={card.avatarSrc}
                            name={card.displayName || card.username}
                            alt={`Avatar de ${card.displayName}`}
                            loading="lazy"
                          />
                        </button>

                        <div className="main-panel__pending-meta">
                          <p className="main-panel__pending-name">{card.displayName}</p>
                          <p className="main-panel__pending-username">@{card.username}</p>
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

              {rightSidebarSpotifyFriends.length === 0 ? (
                <div className="main-panel__right-card">
                  <h3 className="main-panel__right-card-title">Nenhuma atividade</h3>
                  <p className="main-panel__right-card-text">As atividades dos seus amigos aparecerão aqui.</p>
                </div>
              ) : (
                <div className="main-panel__right-now-list">
                  {rightSidebarSpotifyFriends.map((friend) => {
                    const spotifyActivity = friend.spotifyActivity;
                    if (!spotifyActivity) {
                      return null;
                    }

                    const friendName = friend.displayName || friend.username;
                    const listenAlongSession =
                      listenAlongSessionsByFriendId[friend.userId] ??
                      createDefaultSpotifyListenAlongSession(currentUserId ?? "", friend.userId);
                    const isListeningTogether =
                      Boolean(currentUserId) &&
                      listenAlongSession.active &&
                      listenAlongSession.listenerUserId === (currentUserId ?? "") &&
                      listenAlongSession.hostUserId === friend.userId &&
                      listenAlongSession.trackId === spotifyActivity.trackId;

                    return (
                      <article key={friend.userId} className="main-panel__right-now-card">
                        <div className="main-panel__right-now-top">
                          <div className="main-panel__right-now-header">
                            <div className="main-panel__right-now-avatar-wrap">
                              <AvatarImage
                                className="main-panel__right-now-avatar"
                                src={friend.avatarSrc}
                                name={friendName}
                                alt={`Avatar de ${friendName}`}
                                loading="lazy"
                              />
                              <span
                                className={`main-panel__right-now-presence main-panel__right-now-presence--${friend.presenceState}`}
                                aria-hidden="true"
                              />
                            </div>
                            <div className="main-panel__right-now-header-meta">
                              <p className="main-panel__right-now-name">{friendName}</p>
                              <p className="main-panel__right-now-label">Ouvindo Spotify</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="main-panel__right-now-spotify-button"
                            onClick={() => {
                              handleOpenSpotifyExternal(spotifyActivity.trackUrl);
                            }}
                            aria-label={`Abrir ${spotifyActivity.trackTitle} no Spotify`}
                            title="Abrir no Spotify"
                          >
                            <img
                              className="main-panel__right-now-spotify-logo"
                              src={spotifyLogo}
                              alt=""
                              aria-hidden="true"
                            />
                          </button>
                        </div>

                        <div className="main-panel__right-now-content">
                          <button
                            type="button"
                            className="main-panel__right-now-cover-button"
                            onClick={() => {
                              handleOpenSpotifyExternal(spotifyActivity.trackUrl);
                            }}
                            aria-label={`Abrir ${spotifyActivity.trackTitle} no Spotify`}
                            title="Abrir no Spotify"
                          >
                            {spotifyActivity.coverUrl ? (
                              <img
                                className="main-panel__right-now-cover-image"
                                src={spotifyActivity.coverUrl}
                                alt={`Capa de ${spotifyActivity.trackTitle}`}
                                loading="lazy"
                              />
                            ) : (
                              <span className="main-panel__right-now-cover-fallback" aria-hidden="true" />
                            )}
                          </button>

                          <div className="main-panel__right-now-track-meta">
                            <button
                              type="button"
                              className="main-panel__right-now-track main-panel__right-now-link"
                              onClick={() => {
                                handleOpenSpotifyExternal(spotifyActivity.trackUrl);
                              }}
                              aria-label={`Abrir ${spotifyActivity.trackTitle} no Spotify`}
                              title="Abrir no Spotify"
                            >
                              {spotifyActivity.trackTitle}
                            </button>

                            <button
                              type="button"
                              className="main-panel__right-now-artist main-panel__right-now-link"
                              onClick={() => {
                                handleOpenSpotifyExternal(spotifyActivity.trackUrl);
                              }}
                              aria-label={`Abrir ${spotifyActivity.artistNames} no Spotify`}
                              title="Abrir no Spotify"
                            >
                              {spotifyActivity.artistNames}
                            </button>
                          </div>

                          {isListeningTogether ? (
                            <div className="main-panel__right-now-listen-along-avatars" aria-label="Ouvindo junto">
                              <AvatarImage
                                className="main-panel__right-now-listen-along-avatar"
                                src={listenAlongSession.hostAvatarSrc || friend.avatarSrc}
                                name={listenAlongSession.hostDisplayName || friendName}
                                alt={`Avatar de ${listenAlongSession.hostDisplayName || friendName}`}
                                loading="lazy"
                              />
                              <AvatarImage
                                className="main-panel__right-now-listen-along-avatar"
                                src={
                                  listenAlongSession.listenerAvatarSrc ||
                                  currentUserChatProfile?.avatarSrc ||
                                  getNameAvatarUrl(String(user?.displayName ?? "").trim() || "U")
                                }
                                name={
                                  listenAlongSession.listenerDisplayName ||
                                  currentUserChatProfile?.displayName ||
                                  String(user?.displayName ?? "").trim() ||
                                  "Você"
                                }
                                alt={`Avatar de ${
                                  listenAlongSession.listenerDisplayName ||
                                  currentUserChatProfile?.displayName ||
                                  String(user?.displayName ?? "").trim() ||
                                  "Você"
                                }`}
                                loading="lazy"
                              />
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </aside>
          ) : null}
        </section>
      </main>

      {openPendingProfile ? (
        <div className="main-panel__pending-profile-overlay" role="presentation" onClick={handleClosePendingProfile}>
          <div
            className="main-panel__pending-profile-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Perfil de ${openPendingProfile.displayName}`}
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense fallback={<PendingProfileFallback />}>
              <UserProfilePopover
                avatarSrc={openPendingProfile.avatarSrc}
                bannerSrc={openPendingProfile.bannerSrc}
                bannerColor={openPendingProfile.bannerColor}
                themePrimaryColor={openPendingProfile.themePrimaryColor}
                themeAccentColor={openPendingProfile.themeAccentColor}
                displayName={openPendingProfile.displayName}
                username={openPendingProfile.username}
                profileUserId={openPendingProfile.userId}
                aboutText={openPendingProfile.aboutText}
                spotifyActivity={openPendingProfile.spotifyActivity ?? null}
                presenceState={openPendingProfile.presenceState}
                presenceLabel={getPresenceLabel(openPendingProfile.presenceState)}
                memberSinceLabel={openPendingProfile.memberSinceLabel}
                viewMode="full"
                showActions={false}
                showEditProfileButton={isOpenPendingProfileCurrentUser}
                onMessageComposerSubmit={handleOpenPendingProfileConversation}
                onEditProfile={() => {
                  handleClosePendingProfile();
                  handleOpenSettings("profile");
                }}
                onCloseFullProfile={handleClosePendingProfile}
                onOpenSettings={handleOpenSettings}
              />
            </Suspense>
          </div>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="app-settings-float"
          role="presentation"
          onClick={handleCloseSettings}
        >
          <div
            className="app-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Configurações do aplicativo"
            onClick={(event) => event.stopPropagation()}
          >
            <Suspense fallback={<SettingsModalFallback />}>
              <AppSettingsView
                onClose={handleCloseSettings}
                currentUserId={currentUserId}
                initialSection={settingsInitialSection}
              />
            </Suspense>
          </div>
        </div>
      ) : null}
    </div>
  );
}

