import { Fragment, memo, type CSSProperties, type ChangeEvent, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gsap } from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import twemoji from "twemoji";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import Modal from "../ui/Modal";
import SpotifyIcon from "../ui/SpotifyIcon";
import Tooltip from "../ui/Tooltip";
import UserProfilePopover, { type UserProfileMutualFriendItem } from "../UserProfilePopover/UserProfilePopover";
import EmojiButton from "./EmojiButton";
import EmojiPopover from "./EmojiPopover";
import MessageDateDivider from "./MessageDateDivider";
import { getAttachmentUrl, getBannerUrl, getDefaultBannerUrl, getNameAvatarUrl, isDefaultBannerUrl } from "../../services/cdn/mediaUrls";
import {
  PRESENCE_LABELS,
  type PresenceSpotifyActivity,
  type PresenceState,
} from "../../services/presence/presenceTypes";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import { createProfileTheme } from "../../services/profile/profileTheme";
import {
  formatSpotifyPlaybackTime,
  isSpotifyPlaybackStillActive,
} from "../../services/connections/spotifyConnection";
import {
  createDefaultSpotifyListenAlongSession,
  joinSpotifyListenAlongSession,
  leaveSpotifyListenAlongSession,
  readSpotifyListenAlongSession,
  resolveSpotifyListenAlongFailureMessage,
  subscribeSpotifyListenAlongSession,
  type SpotifyListenAlongSession,
} from "../../services/connections/spotifyListenAlong";
import {
  deleteChatMessage,
  editChatMessage,
  getCachedInitialChatMessages,
  listChatMessages,
  preloadChatMessages,
  sendChatMessage,
  type ChatAttachmentMetadata,
  type ChatMessageServer,
  type MessageListCursor,
} from "../../services/chat/chatApi";
import { prepareAttachmentUpload, uploadAttachmentBlob } from "../../services/media/attachmentPipeline";
import { incrementMetric, recordLatency, reportClientError } from "../../services/observability/clientObservability";
import { supabase } from "../../services/supabase";
import VoiceCallInterface from "../../voice/ui/callInterface";
import {
  VoiceCallClient,
  type VoiceConnectionState,
  type VoiceDiagnosticsPeerSnapshot,
  type VoiceCallMediaPreferences,
  type VoiceParticipantState,
  type VoiceUserIdentity,
} from "../../voice/client/webrtc";
import {
  VoiceCallPresenceClient,
  type VoiceCallStateUpdate,
} from "../../voice/client/presence";
import {
  getVoiceCallUiSnapshot,
  publishVoiceCallUiSnapshot,
  resetVoiceCallUiSnapshot,
  subscribeVoiceCallUiCommand,
} from "../../voice/client/uiState";
import "../../styles/components/DirectMessageChat.css";

gsap.registerPlugin(ScrollToPlugin);

const headerVoiceCallIconUrl = new URL("../../assets/icons/ui/Calling.svg", import.meta.url).href;
const headerVideoOffIconUrl = new URL("../../assets/icons/ui/video-off.svg", import.meta.url).href;
const rejoinCameraIconUrl = new URL("../../assets/icons/ui/Video.svg", import.meta.url).href;
const VOICE_CALL_SIGNAL_PREFIX = "__messly_voice_call_signal__:";
const VOICE_CALL_INVITE_TTL_MS = 3 * 60_000;
const VOICE_CALL_RING_TIMEOUT_MS = 3 * 60_000;
const VOICE_CALL_SINGLE_PARTICIPANT_TIMEOUT_MS = 5 * 60_000;
const VOICE_CALL_REJOIN_FALLBACK_TTL_MS = 5 * 60_000;
const VOICE_CALL_SERVER_FALLBACK_TTL_MS = 30 * 60_000;
const AUDIO_SETTINGS_STORAGE_KEY_PREFIX = "messly:audio-settings:";

const GROUP_BREAK_MS = 5 * 60 * 1000;
const AUTO_SCROLL_THRESHOLD_PX = 120;
const SCROLL_TO_BOTTOM_DURATION_S = 0.35;
const MEDIA_GROUP_WINDOW_MS = 15 * 1000;
const MAX_VISIBLE_MEDIA_ATTACHMENTS = 5;
const INITIAL_PAGE_SIZE = 24;
const LOAD_OLDER_THRESHOLD_PX = 120;
const ACTIVE_MESSAGE_WINDOW_MAX = 96;
const ACTIVE_MESSAGE_WINDOW_TARGET = 84;
const MESSAGE_VIRTUAL_OVERSCAN = 16;
const MESSAGE_VIRTUAL_MIN_ROWS = 36;
const MESSAGE_VIRTUAL_ESTIMATED_ROW_HEIGHT = 76;
const TWEMOJI_BASE_URL = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/";
const TWEMOJI_CACHE_LIMIT = 400;
const INITIAL_MESSAGE_CACHE_TTL_MS = 5 * 60_000;
const STALE_MESSAGE_SEED_CACHE_TTL_MS = 30 * 60_000;
const TRANSIENT_MISSING_MESSAGE_RETAIN_MS = 45_000;
const INITIAL_LOADING_SKELETON_ROWS = 8;
const MESSAGE_PROFILE_POPOVER_WIDTH = 300;
const MESSAGE_PROFILE_POPOVER_MIN_HEIGHT = 240;
const MESSAGE_PROFILE_POPOVER_MAX_HEIGHT = 460;
const MESSAGE_PROFILE_POPOVER_MARGIN = 8;
const MESSAGE_PROFILE_POPOVER_GAP = 12;
const CHAT_PERF_LOG_STORAGE_KEY = "messly:chat-perf-logs";
const CHAT_PERF_DEDUPE_WINDOW_MS = 900;
const MESSAGES_SKELETON_LAYOUT: Array<{ lineWidths: Array<40 | 55 | 70>; hasAttachment?: boolean }> = [
  { lineWidths: [40, 70, 55] },
  { lineWidths: [55, 70] },
  { lineWidths: [40, 55, 70] },
  { lineWidths: [55, 70, 40], hasAttachment: true },
  { lineWidths: [40, 55] },
  { lineWidths: [55, 70, 55] },
  { lineWidths: [40, 70] },
  { lineWidths: [55, 40, 70] },
];

const twemojiHtmlCache = new Map<string, string>();
const TWEMOJI_IMAGE_TAG_PATTERN = /<img\b[^>]*class="[^"]*dm-chat__twemoji[^"]*"[^>]*>/gi;
const TWEMOJI_LINE_BREAK_PATTERN = /<br\s*\/?>/gi;
const TWEMOJI_EMPTY_ENTITY_PATTERN = /(?:&nbsp;|&#8205;|&#x200d;|&#xfe0f;)/gi;

type ParsedHexRgb = {
  red: number;
  green: number;
  blue: number;
};

function parseHexThemeColor(hexColor: string | null | undefined): ParsedHexRgb | null {
  const normalized = normalizeBannerColor(hexColor);
  if (!normalized) {
    return null;
  }

  const value = normalized.replace("#", "");
  if (value.length !== 6) {
    return null;
  }

  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return null;
  }

  return { red, green, blue };
}

function clampColorByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHexThemeColor(rgb: ParsedHexRgb): string {
  const toHex = (value: number): string => clampColorByte(value).toString(16).padStart(2, "0");
  return `#${toHex(rgb.red)}${toHex(rgb.green)}${toHex(rgb.blue)}`;
}

function mixHexThemeColors(hexA: string | null | undefined, hexB: string | null | undefined, ratioB: number): string | null {
  const rgbA = parseHexThemeColor(hexA);
  const rgbB = parseHexThemeColor(hexB);
  if (!rgbA || !rgbB) {
    return rgbToHexThemeColor(rgbA ?? rgbB ?? { red: 0, green: 0, blue: 0 });
  }

  const t = Math.max(0, Math.min(1, ratioB));
  const inv = 1 - t;
  return rgbToHexThemeColor({
    red: rgbA.red * inv + rgbB.red * t,
    green: rgbA.green * inv + rgbB.green * t,
    blue: rgbA.blue * inv + rgbB.blue * t,
  });
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string | null;
  content: string | null;
  type: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  reply_to_snapshot: unknown | null;
  payload?: Record<string, unknown> | null;
  attachments?: Array<{
    file_key: string;
    original_key?: string | null;
    thumb_key?: string | null;
    mime_type?: string | null;
    file_size?: number | null;
    width?: number | null;
    height?: number | null;
    thumb_width?: number | null;
    thumb_height?: number | null;
    codec?: string | null;
    duration_ms?: number | null;
  }> | null;
}

interface MessageReadRow {
  message_id: string;
}

interface ChatMessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string | null;
  content: string;
  type: string;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  replyToId?: string | null;
  replyToSnapshot?: ReplySnapshot | null;
  payload?: Record<string, unknown> | null;
  attachment?: ChatAttachmentMetadata | null;
  optimistic?: boolean;
  failed?: boolean;
  sendAttemptCount?: number;
}

interface ReplySnapshot {
  author_id: string;
  author_name: string;
  author_avatar?: string | null;
  snippet?: string | null;
  message_type?: string | null;
  created_at?: string | null;
}

interface ReplyTarget {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
  type: string;
  createdAt: string;
}

type DraftAttachmentKind = "image" | "video" | "file";

interface DraftAttachmentItem {
  id: string;
  file: File;
  kind: DraftAttachmentKind;
  previewUrl: string | null;
  uploadProgress?: number;
  uploadError?: string | null;
}

interface UploadedAttachmentResult {
  fileKey: string;
  originalKey?: string | null;
  thumbKey?: string | null;
  mimeType: string;
  fileSize: number;
  width?: number;
  height?: number;
  thumbWidth?: number;
  thumbHeight?: number;
  codec?: string;
  durationMs?: number;
  messageType: DraftAttachmentKind;
  publicUrl: string;
  thumbUrl?: string | null;
}

interface MediaAttachmentItem {
  messageId: string;
  type: "image" | "video";
  previewUrl: string;
  fullUrl: string;
  isLoading: boolean;
  senderName: string;
  senderAvatar: string;
  createdAt: string;
  canDelete: boolean;
}

interface MediaAttachmentGroup {
  anchorMessageId: string;
  messages: ChatMessageItem[];
  hiddenMessageIds: string[];
}

interface MessageRenderEntry {
  message: ChatMessageItem;
  showHeader: boolean;
  dateDividerLabel: string | null;
  mediaGroup: MediaAttachmentGroup | null;
  skipRender: boolean;
}

interface MessageRenderData {
  entries: MessageRenderEntry[];
  hiddenMessageAnchorMap: Map<string, string>;
}

interface MediaViewerState {
  items: MediaAttachmentItem[];
  index: number;
}

type VoiceCallSignalAction = "invite" | "cancel";
type VoiceCallUiState = "IDLE" | "RINGING" | "CONNECTED" | "RECONNECTING" | "ENDED";
type VoiceCallStartOrigin = "outgoing" | "incoming" | "rejoin" | "restore";

interface VoiceCallSignalPayload {
  version: 1;
  action: VoiceCallSignalAction;
  roomId: string;
  senderUserId: string;
  sentAt: number;
}

interface VoiceCallRejoinFallback {
  roomId: string;
  userId: string;
  displayName: string;
  avatarSrc: string;
  expiresAtMs: number;
}

function encodeVoiceCallSignal(signal: VoiceCallSignalPayload): string {
  return `${VOICE_CALL_SIGNAL_PREFIX}${JSON.stringify(signal)}`;
}

function parseVoiceCallSignalContent(contentRaw: string | null | undefined): VoiceCallSignalPayload | null {
  const content = String(contentRaw ?? "").trim();
  if (!content.startsWith(VOICE_CALL_SIGNAL_PREFIX)) {
    return null;
  }

  const payloadRaw = content.slice(VOICE_CALL_SIGNAL_PREFIX.length).trim();
  if (!payloadRaw) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadRaw) as Partial<VoiceCallSignalPayload>;
    const version = Number(parsed.version ?? 0);
    if (version !== 1) {
      return null;
    }

    const actionRaw = String(parsed.action ?? "").trim();
    if (actionRaw !== "invite" && actionRaw !== "cancel") {
      return null;
    }

    const roomId = String(parsed.roomId ?? "").trim();
    const senderUserId = String(parsed.senderUserId ?? "").trim();
    const sentAt = Number(parsed.sentAt ?? 0);
    if (!roomId || !senderUserId || !Number.isFinite(sentAt) || sentAt <= 0) {
      return null;
    }

    return {
      version: 1,
      action: actionRaw,
      roomId,
      senderUserId,
      sentAt,
    };
  } catch {
    return null;
  }
}

interface PersistedAudioSettingsSnapshot {
  v: 1;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppressionMode?: "off" | "webrtc" | "rnnoise";
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
}

function clampNumeric(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildAudioSettingsStorageKey(userIdRaw: string | null | undefined): string {
  const normalizedUserId = String(userIdRaw ?? "").trim();
  if (!normalizedUserId) {
    return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}guest`;
  }
  return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}${normalizedUserId}`;
}

function readVoiceCallMediaPreferences(userIdRaw: string | null | undefined): VoiceCallMediaPreferences {
  const fallback: VoiceCallMediaPreferences = {
    inputDeviceId: "",
    outputDeviceId: "",
    inputVolumePercent: 100,
    outputVolumePercent: 100,
    noiseSuppressionMode: "webrtc",
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storageKey = buildAudioSettingsStorageKey(userIdRaw);
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedAudioSettingsSnapshot> | null;
    if (!parsed || Number(parsed.v ?? 0) !== 1) {
      return fallback;
    }

    const inputVolumePercent = clampNumeric(Math.round(Number(parsed.inputVolume ?? 100)), 0, 100);
    const outputVolumePercent = clampNumeric(Math.round(Number(parsed.outputVolume ?? 100)), 0, 200);

    const normalizedNoiseSuppressionMode = (() => {
      const modeRaw = String(parsed.noiseSuppressionMode ?? "").trim().toLowerCase();
      if (modeRaw === "off" || modeRaw === "webrtc" || modeRaw === "rnnoise") {
        return modeRaw;
      }
      if (typeof parsed.noiseSuppression === "boolean") {
        return parsed.noiseSuppression ? "webrtc" : "off";
      }
      return "webrtc";
    })();

    return {
      inputDeviceId: String(parsed.inputDeviceId ?? "").trim(),
      outputDeviceId: String(parsed.outputDeviceId ?? "").trim(),
      inputVolumePercent,
      outputVolumePercent,
      noiseSuppressionMode: normalizedNoiseSuppressionMode,
      echoCancellation: typeof parsed.echoCancellation === "boolean" ? parsed.echoCancellation : true,
      noiseSuppression: normalizedNoiseSuppressionMode !== "off",
      autoGainControl: typeof parsed.autoGain === "boolean" ? parsed.autoGain : true,
    };
  } catch {
    return fallback;
  }
}

function buildVoiceRoomId(
  localUserIdRaw: string | null | undefined,
  remoteUserIdRaw: string | null | undefined,
  fallbackRoomIdRaw: string | null | undefined,
): string {
  const localUserId = String(localUserIdRaw ?? "").trim().toLowerCase();
  const remoteUserId = String(remoteUserIdRaw ?? "").trim().toLowerCase();
  const fallbackRoomId = String(fallbackRoomIdRaw ?? "").trim();

  if (localUserId && remoteUserId && localUserId !== remoteUserId) {
    const orderedPair = [localUserId, remoteUserId].sort((left, right) => left.localeCompare(right));
    const candidate = `dm:${orderedPair[0]}:${orderedPair[1]}`;
    if (candidate.length <= 120) {
      return candidate;
    }
  }

  return fallbackRoomId;
}

export interface DirectMessageChatParticipant {
  userId: string;
  displayName: string;
  username: string;
  avatarSrc: string;
  presenceState?: PresenceState;
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

interface MessageProfileExtra {
  bannerSrc: string;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  aboutText: string;
}

interface UserProfileExtraRow {
  banner_key?: string | null;
  banner_hash?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  created_at?: string | null;
  about?: string | null;
}

interface TargetProfileCacheEntry {
  bannerSrc: string;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  aboutText: string;
  memberSinceLabel: string;
  hasCustomBannerAsset: boolean;
}

interface DirectMessageChatViewProps {
  conversationId: string;
  currentUserId: string;
  currentUser: DirectMessageChatParticipant;
  targetUser: DirectMessageChatParticipant;
  onOpenSettings?: (section?: "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows") => void;
  isTargetFriend?: boolean;
  isTargetFriendRequestPending?: boolean;
  onUnfriendTarget?: () => void | Promise<void>;
  onAddFriendTarget?: () => void | Promise<void>;
  onBlockTarget?: () => void | Promise<void>;
  mutualFriends?: UserProfileMutualFriendItem[];
}

interface ConversationMessagesCacheEntry {
  messages: ChatMessageItem[];
  nextCursor: MessageListCursor | null;
  hasMoreBefore: boolean;
  deletedMessageIds: string[];
  attachmentUrlMap: Record<string, string>;
  attachmentThumbUrlMap: Record<string, string>;
  cachedAt: number;
}

const CONVERSATION_CACHE_TTL_MS = 120_000;
const CONVERSATION_CACHE_MAX_ENTRIES = 24;
const CONVERSATION_CACHE_MAX_MESSAGES = 120;
const CONVERSATION_CACHE_PERSIST_KEY = "messly:dm-cache:v1";
const CONVERSATION_CACHE_PERSIST_MAX_ENTRIES = 12;
const CONVERSATION_CACHE_PERSIST_MAX_MESSAGES = 36;
const USER_PROFILE_EXTRA_SELECT_VARIANTS: readonly string[] = [
  "banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,created_at,about",
  "banner_key,banner_hash,banner_color,created_at,about",
  "banner_key,banner_hash,created_at,about",
  "banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,about",
  "banner_key,banner_hash,banner_color,about",
  "banner_key,banner_hash,about",
  "banner_key,banner_hash,created_at",
  "banner_key,banner_hash",
  "profile_theme_primary_color,profile_theme_accent_color,created_at,about",
  "profile_theme_primary_color,profile_theme_accent_color,about",
  "created_at,about",
  "about",
  "created_at",
];
const USER_PROFILE_EXTRA_LIGHT_SELECT_VARIANTS: readonly string[] = [
  "banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,about",
  "banner_key,banner_hash,banner_color,about",
  "banner_key,banner_hash,about",
  "banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color",
  "banner_key,banner_hash,banner_color",
  "banner_key,banner_hash",
  "profile_theme_primary_color,profile_theme_accent_color,about",
  "about",
];
const conversationMessagesCache = new Map<string, ConversationMessagesCacheEntry>();
const targetProfileCache = new Map<string, TargetProfileCacheEntry>();
const chatPerfLastLogAt = new Map<string, number>();
let conversationCacheHydratedFromStorage = false;

function isChatPerfLogEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(CHAT_PERF_LOG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function logChatPerf(eventName: string, payload: Record<string, unknown>): void {
  if (!isChatPerfLogEnabled()) {
    return;
  }

  const conversationId = String(payload.conversationId ?? "");
  const dedupeKey = `${eventName}:${conversationId}`;
  const now = Date.now();
  const previous = chatPerfLastLogAt.get(dedupeKey) ?? 0;
  if (now - previous < CHAT_PERF_DEDUPE_WINDOW_MS) {
    return;
  }
  chatPerfLastLogAt.set(dedupeKey, now);

  console.info(`[messly-chat-perf] ${eventName}`, payload);
}

function isProfileMissingColumnError(messageRaw: string): boolean {
  const message = String(messageRaw ?? "").toLowerCase();
  if (!message.includes("column")) {
    return false;
  }
  return (
    message.includes("schema cache") ||
    message.includes("does not exist") ||
    message.includes("not found")
  );
}

function getSafeDraftAttachmentUploadErrorMessage(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error ?? "").trim();
  if (!message) {
    return "Falha no upload.";
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("missing required environment variable:") && normalized.includes("r2_")
  ) {
    return "Nao foi possivel enviar o anexo agora. Tente novamente em instantes.";
  }

  if (
    normalized.includes("nosuchbucket") ||
    normalized.includes("the specified bucket does not exist") ||
    (normalized.includes("error invoking remote method") && normalized.includes("media:upload-attachment"))
  ) {
    return "Nao foi possivel enviar o anexo agora. Tente novamente em instantes.";
  }

  return message;
}

function getOrCreateAudioCue(refObject: { current: HTMLAudioElement | null }, sourceUrl: string): HTMLAudioElement | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (!refObject.current) {
    const audioElement = new Audio(sourceUrl);
    audioElement.preload = "auto";
    refObject.current = audioElement;
  }

  return refObject.current;
}

function playAudioCue(
  refObject: { current: HTMLAudioElement | null },
  sourceUrl: string,
  options?: { loop?: boolean; restart?: boolean },
): void {
  const audioElement = getOrCreateAudioCue(refObject, sourceUrl);
  if (!audioElement) {
    return;
  }

  audioElement.loop = Boolean(options?.loop);
  if (options?.restart !== false) {
    try {
      audioElement.currentTime = 0;
    } catch {
      // Ignore seek errors when playback metadata is not ready yet.
    }
  }

  void audioElement.play().catch(() => {
    // Ignore autoplay restrictions.
  });
}

function stopAudioCue(refObject: { current: HTMLAudioElement | null }, resetPosition = false): void {
  const audioElement = refObject.current;
  if (!audioElement) {
    return;
  }

  audioElement.pause();
  audioElement.loop = false;
  if (resetPosition) {
    try {
      audioElement.currentTime = 0;
    } catch {
      // Ignore seek errors when playback metadata is not ready yet.
    }
  }
}

async function queryUserProfileExtras(
  userId: string,
  selectVariants: readonly string[],
): Promise<UserProfileExtraRow | null> {
  for (const selectColumns of selectVariants) {
    const { data, error } = await supabase.from("profiles").select(selectColumns).eq("id", userId).maybeSingle();
    if (!error) {
      return (data as UserProfileExtraRow | null) ?? null;
    }
    if (!isProfileMissingColumnError(error.message ?? "")) {
      return null;
    }
  }
  return null;
}

function cloneMessageForCache(message: ChatMessageItem): ChatMessageItem {
  return {
    ...message,
    attachment: message.attachment ? { ...message.attachment } : message.attachment ?? null,
    replyToSnapshot: message.replyToSnapshot ? { ...message.replyToSnapshot } : message.replyToSnapshot ?? null,
    payload: message.payload ? { ...message.payload } : message.payload ?? null,
  };
}

function hydrateConversationCacheFromStorage(): void {
  if (conversationCacheHydratedFromStorage) {
    return;
  }
  conversationCacheHydratedFromStorage = true;

  if (typeof window === "undefined") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(CONVERSATION_CACHE_PERSIST_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as {
      entries?: Array<{ conversationId?: string; entry?: ConversationMessagesCacheEntry }>;
    } | null;

    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const item of entries) {
      const conversationId = String(item?.conversationId ?? "").trim();
      const entry = item?.entry;
      if (!conversationId || !entry || !Array.isArray(entry.messages)) {
        continue;
      }

      conversationMessagesCache.set(conversationId, {
        messages: entry.messages.map(cloneMessageForCache),
        nextCursor: entry.nextCursor ? { ...entry.nextCursor } : null,
        hasMoreBefore: Boolean(entry.hasMoreBefore),
        deletedMessageIds: Array.isArray(entry.deletedMessageIds)
          ? entry.deletedMessageIds.filter((id): id is string => typeof id === "string")
          : [],
        attachmentUrlMap: { ...(entry.attachmentUrlMap ?? {}) },
        attachmentThumbUrlMap: { ...(entry.attachmentThumbUrlMap ?? {}) },
        cachedAt: Number.isFinite(entry.cachedAt) ? Number(entry.cachedAt) : Date.now(),
      });
    }
  } catch {}
}

function persistConversationCacheToStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const entries = Array.from(conversationMessagesCache.entries())
      .slice(-CONVERSATION_CACHE_PERSIST_MAX_ENTRIES)
      .map(([conversationId, entry]) => ({
        conversationId,
        entry: {
          messages: entry.messages
            .slice(-CONVERSATION_CACHE_PERSIST_MAX_MESSAGES)
            .map(cloneMessageForCache),
          nextCursor: entry.nextCursor ? { ...entry.nextCursor } : null,
          hasMoreBefore: entry.hasMoreBefore,
          deletedMessageIds: entry.deletedMessageIds.slice(-200),
          attachmentUrlMap: { ...entry.attachmentUrlMap },
          attachmentThumbUrlMap: { ...entry.attachmentThumbUrlMap },
          cachedAt: entry.cachedAt,
        },
      }));

    window.localStorage.setItem(CONVERSATION_CACHE_PERSIST_KEY, JSON.stringify({ entries }));
  } catch {}
}

function getConversationMessagesCache(conversationId: string): ConversationMessagesCacheEntry | null {
  hydrateConversationCacheFromStorage();

  const cached = conversationMessagesCache.get(conversationId);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > CONVERSATION_CACHE_TTL_MS) {
    conversationMessagesCache.delete(conversationId);
    return null;
  }

  conversationMessagesCache.delete(conversationId);
  conversationMessagesCache.set(conversationId, cached);

  return {
    messages: cached.messages.map(cloneMessageForCache),
    nextCursor: cached.nextCursor ? { ...cached.nextCursor } : null,
    hasMoreBefore: cached.hasMoreBefore,
    deletedMessageIds: [...cached.deletedMessageIds],
    attachmentUrlMap: { ...cached.attachmentUrlMap },
    attachmentThumbUrlMap: { ...cached.attachmentThumbUrlMap },
    cachedAt: cached.cachedAt,
  };
}

function getStaleConversationMessagesCache(
  conversationId: string,
  maxAgeMs = STALE_MESSAGE_SEED_CACHE_TTL_MS,
): ConversationMessagesCacheEntry | null {
  hydrateConversationCacheFromStorage();

  const cached = conversationMessagesCache.get(conversationId);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > Math.max(CONVERSATION_CACHE_TTL_MS, maxAgeMs)) {
    return null;
  }

  return {
    messages: cached.messages.map(cloneMessageForCache),
    nextCursor: cached.nextCursor ? { ...cached.nextCursor } : null,
    hasMoreBefore: cached.hasMoreBefore,
    deletedMessageIds: [...cached.deletedMessageIds],
    attachmentUrlMap: { ...cached.attachmentUrlMap },
    attachmentThumbUrlMap: { ...cached.attachmentThumbUrlMap },
    cachedAt: cached.cachedAt,
  };
}

function setConversationMessagesCache(
  conversationId: string,
  payload: Omit<ConversationMessagesCacheEntry, "cachedAt">,
): void {
  hydrateConversationCacheFromStorage();

  const cachedMessages = payload.messages
    .slice(-CONVERSATION_CACHE_MAX_MESSAGES)
    .map(cloneMessageForCache);
  const cachedMessageIds = new Set(cachedMessages.map((message) => message.id));

  conversationMessagesCache.delete(conversationId);
  conversationMessagesCache.set(conversationId, {
    messages: cachedMessages,
    nextCursor: payload.nextCursor ? { ...payload.nextCursor } : null,
    hasMoreBefore: payload.hasMoreBefore,
    deletedMessageIds: payload.deletedMessageIds.slice(-200),
    attachmentUrlMap: pruneAttachmentMapByMessageIds(payload.attachmentUrlMap, cachedMessageIds),
    attachmentThumbUrlMap: pruneAttachmentMapByMessageIds(payload.attachmentThumbUrlMap, cachedMessageIds),
    cachedAt: Date.now(),
  });

  while (conversationMessagesCache.size > CONVERSATION_CACHE_MAX_ENTRIES) {
    const oldestKey = conversationMessagesCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    conversationMessagesCache.delete(oldestKey);
  }

  persistConversationCacheToStorage();
}

function normalizeMessageRow(row: MessageRow): ChatMessageItem {
  const attachment = Array.isArray(row.attachments) ? row.attachments[0] : null;
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id ?? null,
    content: String(row.content ?? ""),
    type: String(row.type ?? "text"),
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    replyToId: row.reply_to_id ?? null,
    replyToSnapshot: (row.reply_to_snapshot as ReplySnapshot | null | undefined) ?? null,
    payload: payload ? { ...payload } : null,
    attachment: attachment
      ? {
          fileKey: String(attachment.file_key ?? ""),
          originalKey: attachment.original_key ?? null,
          thumbKey: attachment.thumb_key ?? null,
          mimeType: attachment.mime_type ?? null,
          fileSize: attachment.file_size ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          thumbWidth: attachment.thumb_width ?? null,
          thumbHeight: attachment.thumb_height ?? null,
          codec: attachment.codec ?? null,
          durationMs: attachment.duration_ms ?? null,
        }
      : null,
  };
}

function normalizeServerMessage(row: ChatMessageServer): ChatMessageItem {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id ?? null,
    content: String(row.content ?? ""),
    type: String(row.type ?? "text"),
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    replyToId: row.reply_to_id ?? null,
    replyToSnapshot: (row.reply_to_snapshot as ReplySnapshot | null | undefined) ?? null,
    payload: payload ? { ...payload } : null,
    attachment: row.attachment
      ? {
          fileKey: String(row.attachment.fileKey ?? ""),
          originalKey: row.attachment.originalKey ?? null,
          thumbKey: row.attachment.thumbKey ?? null,
          mimeType: row.attachment.mimeType ?? null,
          fileSize: row.attachment.fileSize ?? null,
          width: row.attachment.width ?? null,
          height: row.attachment.height ?? null,
          thumbWidth: row.attachment.thumbWidth ?? null,
          thumbHeight: row.attachment.thumbHeight ?? null,
          codec: row.attachment.codec ?? null,
          durationMs: row.attachment.durationMs ?? null,
        }
      : null,
  };
}

function isSystemMessage(message: ChatMessageItem): boolean {
  return false;
}

function isAttachmentMessage(message: ChatMessageItem): boolean {
  return message.type === "image" || message.type === "video" || message.type === "file";
}

function isVisibleChatMessage(message: ChatMessageItem): boolean {
  if (message.deletedAt) {
    return false;
  }
  if (message.type === "text" && parseVoiceCallSignalContent(message.content)) {
    return false;
  }
  return true;
}

function collectDeletedMessageIds(messages: ChatMessageItem[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.deletedAt) {
      ids.push(message.id);
    }
  }
  return ids;
}

function filterMessagesByVisibilityAndDeletedIds(
  messages: ChatMessageItem[],
  deletedMessageIds: ReadonlySet<string>,
): ChatMessageItem[] {
  if (deletedMessageIds.size === 0) {
    return messages.filter(isVisibleChatMessage);
  }

  return messages.filter((message) => !deletedMessageIds.has(message.id) && isVisibleChatMessage(message));
}

interface NormalizedMessageWindow {
  normalizedMessages: ChatMessageItem[];
  deletedIds: string[];
  visibleMessages: ChatMessageItem[];
}

function normalizeListedMessages(rows: ChatMessageServer[]): NormalizedMessageWindow {
  const normalizedMessages = sortMessages((rows ?? []).map(normalizeServerMessage));
  const deletedIds = collectDeletedMessageIds(normalizedMessages);
  const visibleMessages = normalizedMessages.filter(isVisibleChatMessage);

  return {
    normalizedMessages,
    deletedIds,
    visibleMessages,
  };
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareMessagesChronologically(a: ChatMessageItem, b: ChatMessageItem): number {
  const timeDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return a.id.localeCompare(b.id);
}

function sortMessages(messages: ChatMessageItem[]): ChatMessageItem[] {
  const sorted = [...messages];
  sorted.sort(compareMessagesChronologically);
  return sorted;
}

function shouldRetainLocalMessageDuringReload(
  message: ChatMessageItem,
  serverMessageIds: ReadonlySet<string>,
  serverClientIds: ReadonlySet<string>,
  oldestServerMessage: ChatMessageItem | null,
  nowMs: number,
): boolean {
  if (serverMessageIds.has(message.id)) {
    return false;
  }

  if (message.clientId && serverClientIds.has(message.clientId)) {
    return false;
  }

  const createdAtMs = toTimestamp(message.createdAt);
  if (createdAtMs <= 0) {
    return false;
  }

  const ageMs = nowMs - createdAtMs;
  if (ageMs > TRANSIENT_MISSING_MESSAGE_RETAIN_MS) {
    return false;
  }

  if (!oldestServerMessage) {
    return true;
  }

  const oldestServerCreatedAtMs = toTimestamp(oldestServerMessage.createdAt);
  if (oldestServerCreatedAtMs <= 0) {
    return true;
  }

  if (createdAtMs > oldestServerCreatedAtMs) {
    return true;
  }
  if (createdAtMs < oldestServerCreatedAtMs) {
    return false;
  }

  return message.id.localeCompare(oldestServerMessage.id) >= 0;
}

type MessageTrimDirection = "drop-older" | "drop-newer";

interface MessageWindowTrimResult {
  messages: ChatMessageItem[];
  droppedOlder: ChatMessageItem[];
  droppedNewer: ChatMessageItem[];
}

function trimMessagesToActiveWindow(
  messages: ChatMessageItem[],
  direction: MessageTrimDirection,
): MessageWindowTrimResult {
  if (messages.length <= ACTIVE_MESSAGE_WINDOW_MAX) {
    return {
      messages,
      droppedOlder: [],
      droppedNewer: [],
    };
  }

  const keepCount = Math.max(1, Math.min(ACTIVE_MESSAGE_WINDOW_TARGET, ACTIVE_MESSAGE_WINDOW_MAX));
  if (direction === "drop-newer") {
    const kept = messages.slice(0, keepCount);
    return {
      messages: kept,
      droppedOlder: [],
      droppedNewer: messages.slice(keepCount),
    };
  }

  const startIndex = Math.max(messages.length - keepCount, 0);
  const kept = messages.slice(startIndex);
  return {
    messages: kept,
    droppedOlder: messages.slice(0, startIndex),
    droppedNewer: [],
  };
}

function buildOlderCursorFromMessages(messages: ChatMessageItem[]): MessageListCursor | null {
  const oldestMessage = messages[0];
  if (!oldestMessage) {
    return null;
  }

  return {
    createdAt: oldestMessage.createdAt,
    id: oldestMessage.id,
  };
}

function pruneAttachmentMapByMessageIds(
  map: Record<string, string>,
  messageIds: ReadonlySet<string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [messageId, url] of Object.entries(map)) {
    if (messageIds.has(messageId)) {
      next[messageId] = url;
    }
  }
  return next;
}

function upsertMessages(current: ChatMessageItem[], incomingMessages: ChatMessageItem[]): ChatMessageItem[] {
  if (incomingMessages.length === 0) {
    return current;
  }

  const next = [...current];
  const indexById = new Map<string, number>();
  const indexByClientId = new Map<string, number>();

  next.forEach((message, index) => {
    indexById.set(message.id, index);
    if (message.clientId) {
      indexByClientId.set(message.clientId, index);
    }
  });

  for (const incoming of incomingMessages) {
    const byIdIndex = indexById.get(incoming.id);
    const byClientIdIndex = incoming.clientId ? indexByClientId.get(incoming.clientId) : undefined;
    const existingIndex = byIdIndex ?? byClientIdIndex;

    if (typeof existingIndex === "number") {
      const merged = {
        ...next[existingIndex],
        ...incoming,
      };
      next[existingIndex] = merged;
      indexById.set(merged.id, existingIndex);
      if (merged.clientId) {
        indexByClientId.set(merged.clientId, existingIndex);
      }
      continue;
    }

    next.push(incoming);
    const addedIndex = next.length - 1;
    indexById.set(incoming.id, addedIndex);
    if (incoming.clientId) {
      indexByClientId.set(incoming.clientId, addedIndex);
    }
  }

  return sortMessages(next);
}

function areFlatRecordValuesEqual(
  current: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  if (current === next) {
    return true;
  }
  if (!current || !next) {
    return !current && !next;
  }

  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) {
    return false;
  }

  for (const key of currentKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || current[key] !== next[key]) {
      return false;
    }
  }

  return true;
}

function areMessagesEqual(current: ChatMessageItem[], next: ChatMessageItem[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentItem = current[index];
    const nextItem = next[index];
    if (
      currentItem.id !== nextItem.id ||
      currentItem.conversationId !== nextItem.conversationId ||
      currentItem.senderId !== nextItem.senderId ||
      (currentItem.clientId ?? "") !== (nextItem.clientId ?? "") ||
      currentItem.content !== nextItem.content ||
      currentItem.type !== nextItem.type ||
      currentItem.createdAt !== nextItem.createdAt ||
      (currentItem.editedAt ?? "") !== (nextItem.editedAt ?? "") ||
      (currentItem.deletedAt ?? "") !== (nextItem.deletedAt ?? "") ||
      (currentItem.replyToId ?? "") !== (nextItem.replyToId ?? "") ||
      !areFlatRecordValuesEqual(
        (currentItem.replyToSnapshot as unknown as Record<string, unknown> | null | undefined) ?? null,
        (nextItem.replyToSnapshot as unknown as Record<string, unknown> | null | undefined) ?? null,
      ) ||
      !areFlatRecordValuesEqual(currentItem.payload ?? null, nextItem.payload ?? null) ||
      !areFlatRecordValuesEqual(
        (currentItem.attachment as unknown as Record<string, unknown> | null | undefined) ?? null,
        (nextItem.attachment as unknown as Record<string, unknown> | null | undefined) ?? null,
      ) ||
      Boolean(currentItem.optimistic) !== Boolean(nextItem.optimistic) ||
      Boolean(currentItem.failed) !== Boolean(nextItem.failed) ||
      Number(currentItem.sendAttemptCount ?? 0) !== Number(nextItem.sendAttemptCount ?? 0)
    ) {
      return false;
    }
  }

  return true;
}

export function shouldShowAuthorHeader(
  currentMessage: ChatMessageItem,
  previousMessage: ChatMessageItem | null,
): boolean {
  if (!previousMessage) {
    return true;
  }
  if (currentMessage.replyToId || currentMessage.replyToSnapshot) {
    return true;
  }
  if (isSystemMessage(currentMessage) || isSystemMessage(previousMessage)) {
    return true;
  }
  if (currentMessage.senderId !== previousMessage.senderId) {
    return true;
  }

  const timeDiff = Math.abs(toTimestamp(currentMessage.createdAt) - toTimestamp(previousMessage.createdAt));
  return timeDiff > GROUP_BREAK_MS;
}

function getLocalDateKey(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isSameLocalCalendarDay(leftTimestamp: string, rightTimestamp: string): boolean {
  const left = getLocalDateKey(leftTimestamp);
  const right = getLocalDateKey(rightTimestamp);
  return Boolean(left) && left === right;
}

function formatMessageDateDividerLabel(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const messageDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const nowDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((nowDayStart - messageDayStart) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) {
    return "Hoje";
  }
  if (diffDays === 1) {
    return "Ontem";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatMessageDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatMemberSinceDate(timestamp: string | null | undefined): string {
  const rawValue = String(timestamp ?? "").trim();
  if (!rawValue) {
    return "";
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatDurationLabel(durationSecondsRaw: number | null | undefined): string {
  const durationSeconds = Number(durationSecondsRaw ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return "0s";
  }

  const safeSeconds = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function createClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 version 4 bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getAttachmentKind(file: File): DraftAttachmentKind {
  const mimeType = String(file.type ?? "").trim().toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function createDraftAttachment(file: File): DraftAttachmentItem {
  const kind = getAttachmentKind(file);
  const previewUrl = kind === "image" || kind === "video" ? URL.createObjectURL(file) : null;
  return {
    id: createClientMessageId(),
    file,
    kind,
    previewUrl,
    uploadProgress: 0,
    uploadError: null,
  };
}

function revokeDraftAttachment(item: DraftAttachmentItem): void {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function sanitizeFileName(rawName: string, fallback: string): string {
  const sanitized = rawName
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(-80);
  return sanitized || fallback;
}

function formatFileSize(sizeInBytes: number): string {
  if (!Number.isFinite(sizeInBytes) || sizeInBytes <= 0) {
    return "0 B";
  }
  if (sizeInBytes < 1024) {
    return `${sizeInBytes} B`;
  }
  const sizeInKb = sizeInBytes / 1024;
  if (sizeInKb < 1024) {
    return `${sizeInKb.toFixed(sizeInKb < 10 ? 1 : 0)} KB`;
  }
  const sizeInMb = sizeInKb / 1024;
  if (sizeInMb < 1024) {
    return `${sizeInMb.toFixed(sizeInMb < 10 ? 1 : 0)} MB`;
  }
  const sizeInGb = sizeInMb / 1024;
  return `${sizeInGb.toFixed(sizeInGb < 10 ? 1 : 0)} GB`;
}

function formatUploadingAttachmentsLabel(count: number): string {
  const safeCount = Math.max(0, Math.trunc(count));
  if (safeCount === 1) {
    return "Enviando 1 arquivo";
  }
  return `Enviando ${safeCount} arquivos`;
}

function getReplySnippet(message: Pick<ChatMessageItem, "content" | "type" | "deletedAt">): string {
  if (message.deletedAt) {
    return "Mensagem excluida";
  }

  if (message.type === "image") {
    return "Imagem";
  }
  if (message.type === "video") {
    return "Video";
  }
  if (message.type === "file") {
    return "Anexo";
  }

  const text = message.content.trim();
  return text || "Mensagem";
}

function getReplyIconName(messageType: string | null | undefined, snippet: string): string | null {
  const normalizedType = String(messageType ?? "").trim().toLowerCase();
  if (normalizedType === "deleted") {
    return "reply";
  }
  if (normalizedType === "image") {
    return "image";
  }
  if (normalizedType === "video") {
    return "videocam";
  }
  if (normalizedType === "file") {
    return "description";
  }
  if (normalizedType && normalizedType !== "text") {
    return "chat";
  }

  if (snippet.trim().toLowerCase() === "mensagem excluida") {
    return "block";
  }

  return null;
}

function truncateSnippet(value: string, maxLength = 80): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toTwemojiHtml(content: string): string {
  const cached = twemojiHtmlCache.get(content);
  if (cached) {
    return cached;
  }

  const escaped = escapeHtml(content);
  const withBreaks = escaped.replace(/\r\n|\r|\n/g, "<br />");
  const parsed = twemoji.parse(withBreaks, {
    base: TWEMOJI_BASE_URL,
    folder: "svg",
    ext: ".svg",
    className: "dm-chat__twemoji",
  });

  if (twemojiHtmlCache.size > TWEMOJI_CACHE_LIMIT) {
    twemojiHtmlCache.clear();
  }
  twemojiHtmlCache.set(content, parsed);
  return parsed;
}

function getEmojiOnlyMeta(twemojiHtml: string): { isEmojiOnly: boolean; emojiCount: number } {
  const emojiMatches = twemojiHtml.match(TWEMOJI_IMAGE_TAG_PATTERN);
  const emojiCount = emojiMatches?.length ?? 0;
  if (emojiCount === 0) {
    return { isEmojiOnly: false, emojiCount: 0 };
  }

  const normalizedText = twemojiHtml
    .replace(TWEMOJI_IMAGE_TAG_PATTERN, "")
    .replace(TWEMOJI_LINE_BREAK_PATTERN, "")
    .replace(TWEMOJI_EMPTY_ENTITY_PATTERN, "")
    .replace(/\s+/g, "");

  return {
    isEmojiOnly: normalizedText.length === 0,
    emojiCount,
  };
}

function insertEmojiAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  emoji: string,
): { nextText: string; nextCursor: number } {
  const safeStart = Math.max(0, Math.min(selectionStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, text.length));
  const before = text.slice(0, safeStart);
  const after = text.slice(safeEnd);

  const nextChar = after.slice(0, 1);

  const needsSpaceAfter = after.length === 0 || (nextChar !== " " && nextChar !== "\n");

  const prefix = "";
  const suffix = needsSpaceAfter ? " " : "";
  const inserted = `${prefix}${emoji}${suffix}`;

  const nextText = `${before}${inserted}${after}`;
  const nextCursor = before.length + inserted.length;
  return { nextText, nextCursor };
}

function getFileNameFromUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const fileName = url.pathname.split("/").pop() ?? "";
    return decodeURIComponent(fileName) || "arquivo";
  } catch {
    const parts = urlValue.split("/").filter(Boolean);
    const fileName = parts.pop() ?? "";
    return decodeURIComponent(fileName) || "arquivo";
  }
}

function isMediaMessage(message: ChatMessageItem): message is ChatMessageItem & { type: "image" | "video" } {
  return message.type === "image" || message.type === "video";
}

function resolveInlineAttachmentUrl(content: string): string {
  if (content.startsWith("http://") || content.startsWith("https://")) {
    return content;
  }
  return "";
}

function shouldMergeMediaMessages(previous: ChatMessageItem, current: ChatMessageItem): boolean {
  if (!isMediaMessage(previous) || !isMediaMessage(current)) {
    return false;
  }
  if (previous.senderId !== current.senderId) {
    return false;
  }
  if (Boolean(previous.failed) || Boolean(current.failed)) {
    return false;
  }
  if (Boolean(previous.deletedAt) || Boolean(current.deletedAt)) {
    return false;
  }
  if (Boolean(previous.optimistic) || Boolean(current.optimistic)) {
    return false;
  }
  if ((previous.replyToId ?? "") !== (current.replyToId ?? "")) {
    return false;
  }
  if (!isSameLocalCalendarDay(previous.createdAt, current.createdAt)) {
    return false;
  }
  const timeDiff = Math.abs(toTimestamp(current.createdAt) - toTimestamp(previous.createdAt));
  return timeDiff <= MEDIA_GROUP_WINDOW_MS;
}

function buildMessageRenderData(messages: ChatMessageItem[]): MessageRenderData {
  const entries: MessageRenderEntry[] = messages.map((message, index) => ({
    message,
    showHeader: shouldShowAuthorHeader(message, index > 0 ? messages[index - 1] : null),
    dateDividerLabel: (() => {
      const previousMessage = index > 0 ? messages[index - 1] : null;
      if (!previousMessage || !isSameLocalCalendarDay(message.createdAt, previousMessage.createdAt)) {
        return formatMessageDateDividerLabel(message.createdAt) || null;
      }
      return null;
    })(),
    mediaGroup: null,
    skipRender: false,
  }));

  const hiddenMessageAnchorMap = new Map<string, string>();

  for (let index = 0; index < messages.length; ) {
    const anchorMessage = messages[index];
    if (!isMediaMessage(anchorMessage)) {
      index += 1;
      continue;
    }

    let lastInGroup = anchorMessage;
    const groupedMessages: ChatMessageItem[] = [anchorMessage];
    let cursor = index + 1;

    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (!isMediaMessage(candidate) || !shouldMergeMediaMessages(lastInGroup, candidate)) {
        break;
      }
      groupedMessages.push(candidate);
      lastInGroup = candidate;
      cursor += 1;
    }

    if (groupedMessages.length > 1) {
      const hiddenMessageIds = groupedMessages.slice(1).map((message) => message.id);
      entries[index] = {
        ...entries[index],
        mediaGroup: {
          anchorMessageId: anchorMessage.id,
          messages: groupedMessages,
          hiddenMessageIds,
        },
      };

      for (let hiddenIndex = index + 1; hiddenIndex < cursor; hiddenIndex += 1) {
        const hiddenMessage = messages[hiddenIndex];
        entries[hiddenIndex] = {
          ...entries[hiddenIndex],
          skipRender: true,
        };
        hiddenMessageAnchorMap.set(hiddenMessage.id, anchorMessage.id);
      }
    }

    index = cursor;
  }

  return {
    entries,
    hiddenMessageAnchorMap,
  };
}

interface MediaItemProps {
  item: MediaAttachmentItem;
  moreCount?: number;
  onOpen: () => void;
  onDelete?: () => void;
  onMediaLoaded?: () => void;
}

const MediaItem = memo(function MediaItem({ item, moreCount = 0, onOpen, onDelete, onMediaLoaded }: MediaItemProps) {
  const isVideo = item.type === "video";

  return (
    <div
      className={`dm-chat__attachment-item${isVideo ? " dm-chat__attachment-item--video" : ""}${
        item.isLoading ? " dm-chat__attachment-item--loading" : ""
      }`}
      role="button"
      tabIndex={item.isLoading ? -1 : 0}
      onClick={() => {
        if (!item.isLoading) {
          onOpen();
        }
      }}
      onKeyDown={(event) => {
        if (item.isLoading) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {!item.isLoading ? (
        item.type === "image" ? (
          <img
            src={item.previewUrl}
            alt="Imagem enviada"
            loading="lazy"
            onLoad={() => {
              onMediaLoaded?.();
            }}
            onError={() => {
              onMediaLoaded?.();
            }}
          />
        ) : item.fullUrl ? (
          <video
            src={item.fullUrl}
            poster={item.previewUrl || undefined}
            controls
            preload="metadata"
            onLoadedMetadata={() => {
              onMediaLoaded?.();
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          />
        ) : (
          <img
            src={item.previewUrl}
            alt="Thumbnail do video"
            loading="lazy"
            onLoad={() => {
              onMediaLoaded?.();
            }}
            onError={() => {
              onMediaLoaded?.();
            }}
          />
        )
      ) : (
        <div className="dm-chat__attachment-loading" />
      )}
      {item.canDelete && onDelete ? (
        <button
          type="button"
          className="dm-chat__attachment-delete-btn"
          aria-label="Excluir midia"
          title="Excluir midia"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <MaterialSymbolIcon name="delete" size={18} />
        </button>
      ) : null}
      {moreCount > 0 ? <div className="dm-chat__attachment-more-overlay">+{moreCount}</div> : null}
    </div>
  );
});

interface AttachmentGridProps {
  items: MediaAttachmentItem[];
  onOpen: (index: number) => void;
  onDelete?: (messageId: string) => void;
  onMediaLoaded?: () => void;
}

const AttachmentGrid = memo(function AttachmentGrid({ items, onOpen, onDelete, onMediaLoaded }: AttachmentGridProps) {
  const visibleItems = items.slice(0, MAX_VISIBLE_MEDIA_ATTACHMENTS);
  const hiddenCount = Math.max(items.length - visibleItems.length, 0);
  const visibleCount = Math.max(1, Math.min(visibleItems.length, MAX_VISIBLE_MEDIA_ATTACHMENTS));

  return (
    <div className={`dm-chat__attachments-grid dm-chat__attachments-grid--count-${visibleCount}`}>
      {visibleItems.map((item, index) => (
        <MediaItem
          key={item.messageId}
          item={item}
          moreCount={hiddenCount > 0 && index === visibleItems.length - 1 ? hiddenCount : 0}
          onOpen={() => onOpen(index)}
          onDelete={onDelete ? () => onDelete(item.messageId) : undefined}
          onMediaLoaded={onMediaLoaded}
        />
      ))}
    </div>
  );
});

const MessagesSkeleton = memo(function MessagesSkeleton() {
  return (
    <div className="dm-chat__messages-skeleton" role="status" aria-label="Carregando mensagens" aria-live="polite">
      {MESSAGES_SKELETON_LAYOUT.slice(0, INITIAL_LOADING_SKELETON_ROWS).map((row, index) => (
        <div key={index} className="dm-chat__sk-msg" aria-hidden="true">
          <span className="dm-chat__sk-avatar dm-chat__sk-shimmer" />
          <div className="dm-chat__sk-lines">
            {row.lineWidths.map((width, lineIndex) => (
              <span
                key={`${index}-${lineIndex}`}
                className={`dm-chat__sk-line dm-chat__sk-line--w${width} dm-chat__sk-shimmer`}
              />
            ))}
            {row.hasAttachment ? <span className="dm-chat__sk-attachment dm-chat__sk-shimmer" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
});

export default function DirectMessageChatView({
  conversationId,
  currentUserId,
  currentUser,
  targetUser,
  onOpenSettings,
  isTargetFriend = false,
  isTargetFriendRequestPending = false,
  onUnfriendTarget,
  onAddFriendTarget,
  onBlockTarget,
  mutualFriends = [],
}: DirectMessageChatViewProps) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachmentItem[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [attachmentUrlMap, setAttachmentUrlMap] = useState<Record<string, string>>({});
  const [attachmentThumbUrlMap, setAttachmentThumbUrlMap] = useState<Record<string, string>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatMessageItem | null>(null);
  const [deletingMessageIds, setDeletingMessageIds] = useState<Set<string>>(() => new Set());
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [mediaViewerState, setMediaViewerState] = useState<MediaViewerState | null>(null);
  const [isEmojiOpen, setIsEmojiOpen] = useState(false);
  const [emojiPopoverSource, setEmojiPopoverSource] = useState<"composer" | "profile">("composer");
  const [nextCursor, setNextCursor] = useState<MessageListCursor | null>(null);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [hasTrimmedNewerMessages, setHasTrimmedNewerMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [isInitialConversationLoading, setIsInitialConversationLoading] = useState(true);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [virtualViewportHeight, setVirtualViewportHeight] = useState(0);
  const [virtualFocusIndex, setVirtualFocusIndex] = useState<number | null>(null);
  const [deletedMessageIds, setDeletedMessageIds] = useState<Set<string>>(() => new Set());
  const [targetBannerSrc, setTargetBannerSrc] = useState<string>(getDefaultBannerUrl);
  const [targetBannerHasCustomAsset, setTargetBannerHasCustomAsset] = useState(false);
  const [isTargetProfileResolved, setIsTargetProfileResolved] = useState(false);
  const [targetBannerColor, setTargetBannerColor] = useState<string | null>(null);
  const [targetThemePrimaryColor, setTargetThemePrimaryColor] = useState<string | null>(null);
  const [targetThemeAccentColor, setTargetThemeAccentColor] = useState<string | null>(null);
  const [targetAboutText, setTargetAboutText] = useState<string>("");
  const [canExpandBiography, setCanExpandBiography] = useState(false);
  const [targetMemberSinceLabel, setTargetMemberSinceLabel] = useState<string>("");
  const [sidebarListenAlongSession, setSidebarListenAlongSession] = useState<SpotifyListenAlongSession>(() =>
    createDefaultSpotifyListenAlongSession("", ""),
  );
  const [openMessageProfileUserId, setOpenMessageProfileUserId] = useState<string | null>(null);
  const [isSidebarFullProfileOpen, setIsSidebarFullProfileOpen] = useState(false);
  const [isUnfriendingTarget, setIsUnfriendingTarget] = useState(false);
  const [isAddingTargetFriend, setIsAddingTargetFriend] = useState(false);
  const [isBlockingTarget, setIsBlockingTarget] = useState(false);
  const initialVoiceCallUiSnapshotRef = useRef(getVoiceCallUiSnapshot());
  const [isVoiceCallActive, setIsVoiceCallActive] = useState(false);
  const [isVoiceCallConnecting, setIsVoiceCallConnecting] = useState(false);
  const [isVoiceCallMuted, setIsVoiceCallMuted] = useState(initialVoiceCallUiSnapshotRef.current.muted);
  const [isVoiceCallDeafened, setIsVoiceCallDeafened] = useState(initialVoiceCallUiSnapshotRef.current.deafened);
  const [voiceCallUiState, setVoiceCallUiState] = useState<VoiceCallUiState>("IDLE");
  const [voiceCallParticipants, setVoiceCallParticipants] = useState<VoiceParticipantState[]>([]);
  const [voiceCallDiagnostics, setVoiceCallDiagnostics] = useState<VoiceDiagnosticsPeerSnapshot[]>([]);
  const [voiceCallConnectionState, setVoiceCallConnectionState] = useState<VoiceConnectionState>("idle");
  const [voiceCallError, setVoiceCallError] = useState<string | null>(null);
  const [voiceCallMicWarning, setVoiceCallMicWarning] = useState<string | null>(null);
  const [voiceCallStartedAtMs, setVoiceCallStartedAtMs] = useState<number | null>(null);
  const [voiceCallElapsedTick, setVoiceCallElapsedTick] = useState(0);
  const [incomingVoiceInviteFromUserId, setIncomingVoiceInviteFromUserId] = useState<string | null>(null);
  const [incomingVoiceInviteRoomId, setIncomingVoiceInviteRoomId] = useState<string | null>(null);
  const [incomingVoiceInviteExpiresAtMs, setIncomingVoiceInviteExpiresAtMs] = useState<number | null>(null);
  const [voiceCallRejoinFallback, setVoiceCallRejoinFallback] = useState<VoiceCallRejoinFallback | null>(null);
  const [headerSearchValue, setHeaderSearchValue] = useState("");
  const [headerSearchIndex, setHeaderSearchIndex] = useState(-1);
  const [messageProfilePosition, setMessageProfilePosition] = useState<{ top: number; left: number }>({
    top: MESSAGE_PROFILE_POPOVER_MARGIN,
    left: MESSAGE_PROFILE_POPOVER_MARGIN,
  });
  const [messageProfileExtrasByUserId, setMessageProfileExtrasByUserId] = useState<Record<string, MessageProfileExtra>>({});
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const profileMessageComposerInputRef = useRef<HTMLInputElement | null>(null);
  const profileMessageComposerEmojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());
  const messagesRef = useRef<ChatMessageItem[]>([]);
  const deletedMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingVirtualScrollMessageIdRef = useRef<string | null>(null);
  const forceNextAutoScrollRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const previousTailMessageIdRef = useRef<string | null>(null);
  const initialScrollDoneRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const isRestoringTrimmedWindowRef = useRef(false);
  const shouldAutoScrollAfterSendRef = useRef(false);
  const draftAttachmentsRef = useRef<DraftAttachmentItem[]>([]);
  const pendingDraftCursorRef = useRef<number | null>(null);
  const pendingProfileDraftCursorRef = useRef<number | null>(null);
  const isLoadingOlderRef = useRef(false);
  const lastSuccessfulLoadAtRef = useRef(0);
  const profileAboutRef = useRef<HTMLParagraphElement | null>(null);
  const messageProfileAnchorRef = useRef<HTMLElement | null>(null);
  const messageProfilePopoverRef = useRef<HTMLDivElement | null>(null);
  const sidebarFullProfileRef = useRef<HTMLDivElement | null>(null);
  const voiceCallClientRef = useRef<VoiceCallClient | null>(null);
  const voicePresenceClientRef = useRef<VoiceCallPresenceClient | null>(null);
  const dmRealtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const voiceSignalMessageIdsRef = useRef<Set<string>>(new Set());
  const latestVoiceSignalBySenderRef = useRef<Map<string, number>>(new Map());
  const incomingVoiceInviteFromUserIdRef = useRef<string | null>(null);
  const voiceCallParticipantsRef = useRef<VoiceParticipantState[]>([]);
  const activeVoiceRoomIdRef = useRef<string>("");
  const activeVoiceSessionTokenRef = useRef<symbol | null>(null);
  const hadRemoteParticipantInSessionRef = useRef(false);
  const isVoiceCallActiveRef = useRef(false);
  const isVoiceCallConnectingRef = useRef(false);
  const voiceCallUiStateRef = useRef<VoiceCallUiState>("IDLE");
  const outgoingVoiceRingTimerRef = useRef<number | null>(null);
  const singleParticipantTimerRef = useRef<number | null>(null);
  const incomingVoiceInviteTimerRef = useRef<number | null>(null);
  const rejoinFallbackTimerRef = useRef<number | null>(null);
  const stopVoiceCallSessionRef = useRef<(() => Promise<void>) | null>(null);
  const openPerfRef = useRef<{ conversationId: string; openedAt: number; firstPaintLogged: boolean }>({
    conversationId,
    openedAt: performance.now(),
    firstPaintLogged: false,
  });

  const normalizedTargetDisplayName = String(targetUser.displayName ?? "").trim();
  const normalizedTargetUsername = String(targetUser.username ?? "").trim();
  const targetDisplayNameForFallback =
    (normalizedTargetDisplayName && normalizedTargetDisplayName.toLowerCase() !== "nome"
      ? normalizedTargetDisplayName
      : "") ||
    (normalizedTargetUsername && normalizedTargetUsername.toLowerCase() !== "username"
      ? normalizedTargetUsername
      : normalizedTargetUsername) ||
    "Usuario";
  const currentFirebaseUid = String(currentUser.firebaseUid ?? "").trim();
  const targetFirebaseUid = String(targetUser.firebaseUid ?? "").trim();
  const targetFallbackAvatar = getNameAvatarUrl(
    targetUser.userId || targetFirebaseUid || targetDisplayNameForFallback || normalizedTargetUsername || "U",
  );
  const currentFallbackAvatar = getNameAvatarUrl(
    currentUser.userId || currentFirebaseUid || currentUser.username || currentUser.displayName || "U",
  );
  const targetAvatarSrc = (targetUser.avatarSrc || "").trim() || targetFallbackAvatar;
  const currentAvatarSrc = (currentUser.avatarSrc || "").trim() || currentFallbackAvatar;
  const safeTargetDisplayName = targetDisplayNameForFallback;
  const safeTargetUsername = normalizedTargetUsername || "usuario";
  const voiceRoomId = useMemo(
    () => buildVoiceRoomId(currentUser.userId, targetUser.userId, conversationId),
    [conversationId, currentUser.userId, targetUser.userId],
  );
  const normalizedCurrentSidebarUserId = String(currentUserId ?? "").trim();
  const normalizedTargetSidebarUserId = String(targetUser.userId ?? "").trim();
  const currentSidebarDisplayName =
    String(currentUser.displayName ?? "").trim() ||
    String(currentUser.username ?? "").trim() ||
    "Voce";
  const targetPresenceState: PresenceState = targetUser.presenceState ?? "invisivel";
  const targetPresenceLabel = PRESENCE_LABELS[targetPresenceState];
  const isSidebarProfileCurrentUser = targetUser.userId === currentUserId;
  const targetSidebarSpotifyActivity = useMemo(() => {
    const activity = targetUser.spotifyActivity ?? null;
    if (!activity || activity.showOnProfile === false) {
      return null;
    }
    return isSpotifyPlaybackStillActive(
      {
        trackTitle: activity.trackTitle,
        artistNames: activity.artistNames,
        coverUrl: activity.coverUrl,
        trackUrl: activity.trackUrl,
        trackId: activity.trackId,
        progressSeconds: activity.progressSeconds,
        durationSeconds: activity.durationSeconds,
        ...(typeof activity.isPlaying === "boolean" ? { isPlaying: activity.isPlaying } : {}),
      },
      new Date(activity.updatedAt).toISOString(),
    )
      ? activity
      : null;
  }, [targetUser.spotifyActivity]);
  const handleOpenSidebarSpotifyTrack = useCallback((): void => {
    const trackUrl = String(targetSidebarSpotifyActivity?.trackUrl ?? "").trim();
    if (!trackUrl) {
      return;
    }
    const openExternalUrl = window.electronAPI?.openExternalUrl;
    if (openExternalUrl) {
      void openExternalUrl({ url: trackUrl });
      return;
    }
    window.open(trackUrl, "_blank", "noopener,noreferrer");
  }, [targetSidebarSpotifyActivity?.trackUrl]);
  const sidebarListenAlongTrackKey = useMemo(
    () =>
      String(targetSidebarSpotifyActivity?.trackId ?? "").trim() ||
      `${targetSidebarSpotifyActivity?.trackTitle ?? ""}:${targetSidebarSpotifyActivity?.artistNames ?? ""}`,
    [targetSidebarSpotifyActivity?.artistNames, targetSidebarSpotifyActivity?.trackId, targetSidebarSpotifyActivity?.trackTitle],
  );
  const canSidebarListenAlong = Boolean(
    targetSidebarSpotifyActivity &&
      normalizedCurrentSidebarUserId &&
      normalizedTargetSidebarUserId &&
      normalizedCurrentSidebarUserId !== normalizedTargetSidebarUserId,
  );
  const isSidebarListenAlongActive = Boolean(
    canSidebarListenAlong &&
      sidebarListenAlongSession.active &&
      sidebarListenAlongSession.listenerUserId === normalizedCurrentSidebarUserId &&
      sidebarListenAlongSession.hostUserId === normalizedTargetSidebarUserId &&
      sidebarListenAlongSession.trackId === sidebarListenAlongTrackKey,
  );
  const handleToggleSidebarListenAlong = useCallback((): void => {
    if (!targetSidebarSpotifyActivity || !canSidebarListenAlong) {
      return;
    }

    if (isSidebarListenAlongActive) {
      void leaveSpotifyListenAlongSession(normalizedCurrentSidebarUserId, normalizedTargetSidebarUserId, {
        reason: "listener_left",
      }).then((nextSession) => {
        setSidebarListenAlongSession(nextSession);
      });
      return;
    }

    void joinSpotifyListenAlongSession({
      listenerUserId: normalizedCurrentSidebarUserId,
      hostUserId: normalizedTargetSidebarUserId,
      listenerDisplayName: currentSidebarDisplayName,
      listenerAvatarSrc: currentAvatarSrc,
      hostDisplayName: safeTargetDisplayName,
      hostAvatarSrc: targetAvatarSrc,
      trackId: sidebarListenAlongTrackKey,
      trackTitle: targetSidebarSpotifyActivity.trackTitle,
      trackUrl: targetSidebarSpotifyActivity.trackUrl,
    }).then((result) => {
      if (!result.ok) {
        if (result.reason === "spotify_not_connected" && onOpenSettings) {
          onOpenSettings("connections");
          return;
        }
        window.alert(resolveSpotifyListenAlongFailureMessage(result.reason));
        return;
      }
      setSidebarListenAlongSession(result.session);
    });
  }, [
    canSidebarListenAlong,
    currentAvatarSrc,
    currentSidebarDisplayName,
    isSidebarListenAlongActive,
    normalizedCurrentSidebarUserId,
    normalizedTargetSidebarUserId,
    safeTargetDisplayName,
    sidebarListenAlongTrackKey,
    targetAvatarSrc,
    targetSidebarSpotifyActivity,
    onOpenSettings,
  ]);
  useEffect(() => {
    if (
      !normalizedCurrentSidebarUserId ||
      !normalizedTargetSidebarUserId ||
      normalizedCurrentSidebarUserId === normalizedTargetSidebarUserId
    ) {
      setSidebarListenAlongSession(
        createDefaultSpotifyListenAlongSession(normalizedCurrentSidebarUserId, normalizedTargetSidebarUserId),
      );
      return;
    }

    setSidebarListenAlongSession(
      readSpotifyListenAlongSession(normalizedCurrentSidebarUserId, normalizedTargetSidebarUserId),
    );
    return subscribeSpotifyListenAlongSession(
      normalizedCurrentSidebarUserId,
      normalizedTargetSidebarUserId,
      setSidebarListenAlongSession,
    );
  }, [normalizedCurrentSidebarUserId, normalizedTargetSidebarUserId]);
  useEffect(() => {
    if (
      !sidebarListenAlongSession.active ||
      !normalizedCurrentSidebarUserId ||
      !normalizedTargetSidebarUserId ||
      sidebarListenAlongSession.listenerUserId !== normalizedCurrentSidebarUserId ||
      sidebarListenAlongSession.hostUserId !== normalizedTargetSidebarUserId
    ) {
      return;
    }

    if (targetSidebarSpotifyActivity) {
      return;
    }

    void leaveSpotifyListenAlongSession(normalizedCurrentSidebarUserId, normalizedTargetSidebarUserId, {
      reason: "host_stopped",
    }).then((nextSession) => {
      setSidebarListenAlongSession(nextSession);
    });
  }, [
    normalizedCurrentSidebarUserId,
    normalizedTargetSidebarUserId,
    sidebarListenAlongSession,
    targetSidebarSpotifyActivity,
  ]);
  const targetBannerInlineStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isTargetProfileResolved) {
      return undefined;
    }

    const trimmedBannerSrc = String(targetBannerSrc ?? "").trim();
    const hasCustomBannerImage = Boolean(trimmedBannerSrc) && !isDefaultBannerUrl(trimmedBannerSrc);
    if (targetBannerHasCustomAsset || hasCustomBannerImage) {
      return undefined;
    }
    const normalizedThemePrimary = normalizeBannerColor(targetThemePrimaryColor);
    if (normalizedThemePrimary) {
      return {
        background: normalizedThemePrimary,
      };
    }
    const normalized = normalizeBannerColor(targetBannerColor);
    if (!normalized) {
      return undefined;
    }
    return {
      background: normalized,
    };
  }, [isTargetProfileResolved, targetBannerColor, targetBannerHasCustomAsset, targetBannerSrc, targetThemePrimaryColor]);
  const targetSidebarProfileThemeInlineStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isTargetProfileResolved) {
      return undefined;
    }

    const bannerBase = normalizeBannerColor(targetBannerColor) ?? null;
    const normalizedPrimary = normalizeBannerColor(targetThemePrimaryColor) ?? null;
    const normalizedAccent = normalizeBannerColor(targetThemeAccentColor) ?? null;
    const primaryBase = normalizedPrimary ?? bannerBase;
    const accentBase = normalizedAccent ?? normalizedPrimary ?? bannerBase;
    if (!primaryBase && !accentBase) {
      return undefined;
    }

    const effectivePrimary = primaryBase ?? accentBase;
    const effectiveAccent = accentBase ?? primaryBase;
    const fallbackThemeColor = effectivePrimary ?? effectiveAccent ?? "#262626";
    const harmonizedTheme = createProfileTheme({
      primaryColor: fallbackThemeColor,
      accentColor: effectiveAccent ?? fallbackThemeColor,
      // Keep DM sidebar theme aligned with full profile popover theme generation.
      mode: "dark",
    });
    const isPureBlackTheme =
      harmonizedTheme.normalizedPrimary === "#000000" && harmonizedTheme.normalizedAccent === "#000000";

    const resolvedAccent = harmonizedTheme.tokens["--profile-accent"] ?? effectiveAccent ?? fallbackThemeColor;
    const currentPresenceColor =
      targetPresenceState === "online"
        ? "var(--dm-chat-profile-presence-online, #35be81)"
        : targetPresenceState === "idle"
          ? "var(--dm-chat-profile-presence-idle, #d6a44f)"
          : targetPresenceState === "dnd"
            ? "var(--dm-chat-profile-presence-dnd, #db6262)"
            : "var(--dm-chat-profile-presence-invisible, #8b93a2)";
    const softPanelBase = mixHexThemeColors(resolvedAccent, "#ffffff", 0.82) ?? (effectiveAccent ?? "#262626");
    const softPanelTop = mixHexThemeColors(resolvedAccent, "#ffffff", 0.9) ?? softPanelBase;
    const softPanelMid = mixHexThemeColors(resolvedAccent, "#ffffff", 0.86) ?? softPanelBase;
    const softPanelBottom = mixHexThemeColors(resolvedAccent, "#ffffff", 0.72) ?? softPanelBase;
    const softCardTop = mixHexThemeColors(resolvedAccent, "#ffffff", 0.86) ?? softPanelBase;
    const softCardBottom = mixHexThemeColors(resolvedAccent, "#ffffff", 0.8) ?? softPanelBase;
    const ringColor = mixHexThemeColors(resolvedAccent, "#ffffff", 0.82) ?? softPanelBase;

    let panelBg = softPanelBase;
    let panelGradient = `linear-gradient(180deg, ${softPanelTop} 0%, ${softPanelMid} 46%, ${softPanelBottom} 100%)`;
    let sidebarBg = softPanelBase;
    let textColor = "#252a31";
    let mutedTextColor = "#6f7782";
    let subtleTextColor = "#6f7782";
    let linkHoverColor = "#252a31";
    let metaAccentColor = mixHexThemeColors(resolvedAccent, "#ffffff", 0.78) ?? resolvedAccent;
    let metaBg = `linear-gradient(180deg, ${softCardTop} 0%, ${softCardBottom} 100%)`;
    let metaBorder = "rgba(60, 67, 74, 0.12)";
    let footerBorder = "rgba(60, 67, 74, 0.12)";
    let footerBg = "transparent";

    if (isPureBlackTheme) {
      panelBg = "#000000";
      panelGradient = "#000000";
      sidebarBg = "#000000";
      textColor = "#ffffff";
      mutedTextColor = "rgba(231, 236, 245, 0.86)";
      subtleTextColor = "rgba(214, 221, 233, 0.88)";
      linkHoverColor = "#ffffff";
      metaBg = "#1b1d22";
      metaBorder = "rgba(255, 255, 255, 0.07)";
      footerBorder = "rgba(255, 255, 255, 0.07)";
      footerBg = "transparent";
    }

    return {
      ["--dm-chat-profile-sidebar-bg" as const]: sidebarBg,
      ["--dm-chat-profile-panel-bg" as const]: panelBg,
      ["--dm-chat-profile-panel-gradient" as const]: panelGradient,
      ["--dm-chat-profile-accent" as const]:
        resolvedAccent,
      ["--dm-chat-profile-meta-accent" as const]: metaAccentColor,
      ["--dm-chat-profile-avatar-ring" as const]: ringColor,
      ["--dm-chat-profile-avatar-ring-color" as const]: ringColor,
      ["--dm-chat-profile-presence-ring" as const]: ringColor,
      ["--dm-chat-profile-presence-ring-color" as const]: ringColor,
      ["--dm-chat-profile-presence-current-color" as const]: currentPresenceColor,
      ["--dm-chat-profile-text" as const]: textColor,
      ["--dm-chat-profile-muted" as const]: mutedTextColor,
      ["--dm-chat-profile-link" as const]: subtleTextColor,
      ["--dm-chat-profile-link-hover" as const]: linkHoverColor,
      ["--dm-chat-profile-meta-bg" as const]: metaBg,
      ["--dm-chat-profile-meta-border" as const]: metaBorder,
      ["--dm-chat-profile-footer-bg" as const]: footerBg,
      ["--dm-chat-profile-footer-border" as const]: footerBorder,
      ["--profile-divider" as const]: footerBorder,
      ["--profile-full-title" as const]: textColor,
      ["--profile-full-text" as const]: textColor,
      ["--profile-full-muted" as const]: mutedTextColor,
      ["--profile-full-activity-time" as const]: mutedTextColor,
      ["--profile-full-activity-card-bg" as const]: metaBg,
      ["--profile-full-activity-card-border" as const]: metaBorder,
      ["--profile-full-activity-cover-bg" as const]: softCardTop,
      ["--profile-full-secondary-btn-bg" as const]: metaBg,
      ["--profile-full-secondary-btn-bg-hover" as const]: `linear-gradient(180deg, ${softCardBottom} 0%, ${mixHexThemeColors(resolvedAccent, "#ffffff", 0.74) ?? softCardBottom} 100%)`,
      ["--profile-full-secondary-btn-fg" as const]: textColor,
      ["--profile-spotify-progress" as const]: harmonizedTheme.tokens["--profile-spotify-progress"],
      ["--profile-focus-ring" as const]: harmonizedTheme.tokens["--profile-focus-ring"],
      ["--profile-transition-fast" as const]: harmonizedTheme.tokens["--profile-transition-fast"],
      ["--profile-transition-standard" as const]: harmonizedTheme.tokens["--profile-transition-standard"],
    } as CSSProperties;
  }, [isTargetProfileResolved, targetBannerColor, targetPresenceState, targetThemeAccentColor, targetThemePrimaryColor]);
  const targetHasCustomBannerImage = useMemo(() => {
    const trimmed = String(targetBannerSrc ?? "").trim();
    if (!trimmed) {
      return false;
    }
    return !isDefaultBannerUrl(trimmed);
  }, [targetBannerSrc]);

  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const messageRenderData = useMemo(() => buildMessageRenderData(messages), [messages]);
  const normalizedHeaderSearchValue = headerSearchValue.trim().toLowerCase();
  const headerSearchMatchIds = useMemo(() => {
    if (!normalizedHeaderSearchValue) {
      return [] as string[];
    }

    const matches: string[] = [];
    for (const message of messages) {
      if (!isVisibleChatMessage(message)) {
        continue;
      }
      const searchableContent = String(message.content ?? "").trim().toLowerCase();
      if (!searchableContent) {
        continue;
      }
      if (searchableContent.includes(normalizedHeaderSearchValue)) {
        matches.push(message.id);
      }
    }
    return matches;
  }, [messages, normalizedHeaderSearchValue]);
  const uploadingAttachmentsCount = draftAttachments.length;
  const uploadStatusLabel = useMemo(
    () => formatUploadingAttachmentsLabel(uploadingAttachmentsCount),
    [uploadingAttachmentsCount],
  );
  const uploadStatusTitle = useMemo(() => {
    if (uploadingAttachmentsCount === 1) {
      const fileName = draftAttachments[0]?.file?.name?.trim();
      if (fileName) {
        return fileName;
      }
    }
    return uploadStatusLabel;
  }, [draftAttachments, uploadStatusLabel, uploadingAttachmentsCount]);
  const uploadStatusRatio = useMemo(() => {
    if (!isSending || uploadingAttachmentsCount === 0) {
      return 0;
    }
    const totalRatio = draftAttachments.reduce(
      (sum, item) => sum + Math.max(0, Math.min(1, Number(item.uploadProgress ?? 0))),
      0,
    );
    return Math.max(0, Math.min(1, totalRatio / uploadingAttachmentsCount));
  }, [draftAttachments, isSending, uploadingAttachmentsCount]);

  useEffect(() => {
    const now = performance.now();
    const previous = openPerfRef.current;
    const shouldLogStart =
      previous.conversationId !== conversationId || Math.abs(now - previous.openedAt) > 300;

    openPerfRef.current = {
      conversationId,
      openedAt: now,
      firstPaintLogged: false,
    };

    if (shouldLogStart) {
      logChatPerf("open:start", {
        conversationId,
      });
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    const defaultBanner = getDefaultBannerUrl();
    const targetId = String(targetUser.userId ?? "").trim();
    const seedAboutText = String(targetUser.aboutText ?? "").trim();
    const seedBannerColor = normalizeBannerColor(targetUser.bannerColor) ?? null;
    const seedThemePrimaryColor = normalizeBannerColor(targetUser.themePrimaryColor) ?? null;
    const seedThemeAccentColor = normalizeBannerColor(targetUser.themeAccentColor) ?? null;
    const seedBannerKey = String(targetUser.bannerKey ?? "").trim() || null;
    const seedBannerHash = String(targetUser.bannerHash ?? "").trim() || null;
    const seedBannerSrcRaw = String(targetUser.bannerSrc ?? "").trim();
    const seedBannerSrc = seedBannerSrcRaw || defaultBanner;
    const seedMemberSinceLabel = formatMemberSinceDate(targetUser.memberSinceAt) || "";
    const seedHasCustomBannerAsset = Boolean(seedBannerKey) || (Boolean(seedBannerSrcRaw) && !isDefaultBannerUrl(seedBannerSrcRaw));
    const hasProfileSeed =
      seedHasCustomBannerAsset ||
      Boolean(seedBannerColor) ||
      Boolean(seedThemePrimaryColor) ||
      Boolean(seedThemeAccentColor) ||
      Boolean(seedAboutText) ||
      Boolean(seedMemberSinceLabel);
    const cached = targetId ? targetProfileCache.get(targetId) ?? null : null;

    if (cached) {
      setIsTargetProfileResolved(true);
      setTargetBannerSrc(cached.bannerSrc);
      setTargetBannerHasCustomAsset(cached.hasCustomBannerAsset);
      setTargetBannerColor(cached.bannerColor);
      setTargetThemePrimaryColor(cached.themePrimaryColor);
      setTargetThemeAccentColor(cached.themeAccentColor);
      setTargetAboutText(cached.aboutText);
      setCanExpandBiography(false);
      setTargetMemberSinceLabel(cached.memberSinceLabel);
    } else {
      setIsTargetProfileResolved(hasProfileSeed);
      setTargetBannerSrc(seedBannerSrc);
      setTargetBannerHasCustomAsset(seedHasCustomBannerAsset);
      setTargetBannerColor(seedBannerColor);
      setTargetThemePrimaryColor(seedThemePrimaryColor);
      setTargetThemeAccentColor(seedThemeAccentColor);
      setTargetAboutText(seedAboutText);
      setCanExpandBiography(false);
      setTargetMemberSinceLabel(seedMemberSinceLabel);
    }

    if (!targetId) {
      return () => {
        cancelled = true;
      };
    }

    const resolveTargetBanner = async (): Promise<void> => {
      try {
        const bannerRow = await queryUserProfileExtras(targetId, USER_PROFILE_EXTRA_SELECT_VARIANTS);
        if (cancelled) {
          return;
        }
        const bannerRowHasBannerColor = bannerRow ? Object.prototype.hasOwnProperty.call(bannerRow, "banner_color") : false;
        const bannerRowHasThemePrimaryColor = bannerRow
          ? Object.prototype.hasOwnProperty.call(bannerRow, "profile_theme_primary_color")
          : false;
        const bannerRowHasThemeAccentColor = bannerRow
          ? Object.prototype.hasOwnProperty.call(bannerRow, "profile_theme_accent_color")
          : false;
        const normalizedBannerColor = bannerRowHasBannerColor
          ? normalizeBannerColor(bannerRow?.banner_color) ?? null
          : seedBannerColor;
        const normalizedThemePrimaryColor = bannerRowHasThemePrimaryColor
          ? normalizeBannerColor(bannerRow?.profile_theme_primary_color) ?? null
          : seedThemePrimaryColor;
        const normalizedThemeAccentColor = bannerRowHasThemeAccentColor
          ? normalizeBannerColor(bannerRow?.profile_theme_accent_color) ?? null
          : seedThemeAccentColor;
        const resolvedAboutText = String(bannerRow?.about ?? seedAboutText).trim();
        const resolvedMemberSince = formatMemberSinceDate(bannerRow?.created_at ?? targetUser.memberSinceAt) || "Data nao disponivel";
        const bannerRowHasBannerKey = bannerRow ? Object.prototype.hasOwnProperty.call(bannerRow, "banner_key") : false;
        const bannerRowHasBannerHash = bannerRow ? Object.prototype.hasOwnProperty.call(bannerRow, "banner_hash") : false;
        const resolvedBannerKey = String(
          (bannerRowHasBannerKey ? bannerRow?.banner_key : seedBannerKey) ?? "",
        ).trim() || null;
        const resolvedBannerHash = String(
          (bannerRowHasBannerHash ? bannerRow?.banner_hash : seedBannerHash) ?? "",
        ).trim() || null;
        const hasCustomBannerAsset = Boolean(resolvedBannerKey);

        if (!cancelled) {
          setTargetBannerHasCustomAsset(hasCustomBannerAsset);
          setTargetBannerColor(normalizedBannerColor);
          setTargetThemePrimaryColor(normalizedThemePrimaryColor);
          setTargetThemeAccentColor(normalizedThemeAccentColor);
          setTargetAboutText(resolvedAboutText);
          setCanExpandBiography(false);
          setTargetMemberSinceLabel(resolvedMemberSince);
          setIsTargetProfileResolved(true);
        }

        if (!hasCustomBannerAsset) {
          const fallbackEntry: TargetProfileCacheEntry = {
            bannerSrc: defaultBanner,
            bannerColor: normalizedBannerColor,
            themePrimaryColor: normalizedThemePrimaryColor,
            themeAccentColor: normalizedThemeAccentColor,
            aboutText: resolvedAboutText,
            memberSinceLabel: resolvedMemberSince,
            hasCustomBannerAsset: false,
          };
          targetProfileCache.set(targetId, fallbackEntry);
          setTargetBannerSrc(defaultBanner);
          return;
        }

        targetProfileCache.set(targetId, {
          bannerSrc: cached?.bannerSrc ?? seedBannerSrc,
          bannerColor: normalizedBannerColor,
          themePrimaryColor: normalizedThemePrimaryColor,
          themeAccentColor: normalizedThemeAccentColor,
          aboutText: resolvedAboutText,
          memberSinceLabel: resolvedMemberSince,
          hasCustomBannerAsset: true,
        });

        const resolvedBanner = await getBannerUrl(targetId, resolvedBannerKey, resolvedBannerHash);
        if (cancelled) {
          return;
        }
        const resolvedBannerSrc = String(resolvedBanner ?? "").trim() || defaultBanner;

        setTargetBannerSrc(resolvedBannerSrc);
        targetProfileCache.set(targetId, {
          bannerSrc: resolvedBannerSrc,
          bannerColor: normalizedBannerColor,
          themePrimaryColor: normalizedThemePrimaryColor,
          themeAccentColor: normalizedThemeAccentColor,
          aboutText: resolvedAboutText,
          memberSinceLabel: resolvedMemberSince,
          hasCustomBannerAsset: true,
        });
      } catch {
        if (!cancelled) {
          if (hasProfileSeed) {
            setTargetBannerSrc(seedBannerSrc);
            setTargetBannerHasCustomAsset(seedHasCustomBannerAsset);
            setTargetBannerColor(seedBannerColor);
            setTargetThemePrimaryColor(seedThemePrimaryColor);
            setTargetThemeAccentColor(seedThemeAccentColor);
            setTargetAboutText(seedAboutText);
            setCanExpandBiography(false);
            setTargetMemberSinceLabel(seedMemberSinceLabel);
            setIsTargetProfileResolved(true);

            targetProfileCache.set(targetId, {
              bannerSrc: seedBannerSrc,
              bannerColor: seedBannerColor,
              themePrimaryColor: seedThemePrimaryColor,
              themeAccentColor: seedThemeAccentColor,
              aboutText: seedAboutText,
              memberSinceLabel: seedMemberSinceLabel || "Data nao disponivel",
              hasCustomBannerAsset: seedHasCustomBannerAsset,
            });
          } else {
            setTargetBannerSrc(defaultBanner);
            setTargetBannerHasCustomAsset(false);
            setTargetBannerColor(null);
            setTargetThemePrimaryColor(null);
            setTargetThemeAccentColor(null);
            setTargetAboutText("");
            setCanExpandBiography(false);
            setTargetMemberSinceLabel("Data nao disponivel");
            setIsTargetProfileResolved(true);

            targetProfileCache.set(targetId, {
              bannerSrc: defaultBanner,
              bannerColor: null,
              themePrimaryColor: null,
              themeAccentColor: null,
              aboutText: "",
              memberSinceLabel: "Data nao disponivel",
              hasCustomBannerAsset: false,
            });
          }
        }
      }
    };

    void resolveTargetBanner();

    return () => {
      cancelled = true;
    };
  }, [
    isSidebarFullProfileOpen,
    targetUser.aboutText,
    targetUser.bannerColor,
    targetUser.themeAccentColor,
    targetUser.themePrimaryColor,
    targetUser.bannerHash,
    targetUser.bannerKey,
    targetUser.bannerSrc,
    targetUser.memberSinceAt,
    targetUser.userId,
  ]);

  useEffect(() => {
    if (!targetAboutText) {
      return;
    }

    let frameId = 0;
    const checkBiographyOverflow = (): void => {
      const element = profileAboutRef.current;
      if (!element) {
        setCanExpandBiography(false);
        return;
      }
      setCanExpandBiography(element.scrollHeight - element.clientHeight > 1);
    };

    frameId = requestAnimationFrame(checkBiographyOverflow);
    window.addEventListener("resize", checkBiographyOverflow);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", checkBiographyOverflow);
    };
  }, [targetAboutText]);

  const currentParticipantIds = useMemo(() => {
    const normalizedIds = [
      String(currentUserId ?? "").trim().toLowerCase(),
      String(currentUser.userId ?? "").trim().toLowerCase(),
      String(currentUser.firebaseUid ?? "").trim().toLowerCase(),
    ].filter(Boolean);
    return new Set(normalizedIds);
  }, [currentUser.firebaseUid, currentUser.userId, currentUserId]);

  const targetParticipantIds = useMemo(() => {
    const normalizedIds = [
      String(targetUser.userId ?? "").trim().toLowerCase(),
      String(targetUser.firebaseUid ?? "").trim().toLowerCase(),
    ].filter(Boolean);
    return new Set(normalizedIds);
  }, [targetUser.firebaseUid, targetUser.userId]);

  const isCurrentUserSender = useCallback(
    (userId: string): boolean => {
      const normalizedUserId = String(userId ?? "").trim().toLowerCase();
      return Boolean(normalizedUserId) && currentParticipantIds.has(normalizedUserId);
    },
    [currentParticipantIds],
  );

  const getParticipantById = useCallback(
    (userId: string) => {
      const normalizedUserId = String(userId ?? "").trim().toLowerCase();
      if (normalizedUserId && currentParticipantIds.has(normalizedUserId)) {
        return currentUser;
      }
      if (normalizedUserId && targetParticipantIds.has(normalizedUserId)) {
        return targetUser;
      }
      return targetUser;
    },
    [currentParticipantIds, currentUser, targetParticipantIds, targetUser],
  );

  const openMessageProfileParticipant = useMemo(() => {
    if (!openMessageProfileUserId) {
      return null;
    }
    return getParticipantById(openMessageProfileUserId);
  }, [getParticipantById, openMessageProfileUserId]);
  const openMessageProfileDisplayName = String(openMessageProfileParticipant?.displayName ?? "").trim()
    || String(openMessageProfileParticipant?.username ?? "").trim()
    || "Usuario";
  const openMessageProfileUsername = String(openMessageProfileParticipant?.username ?? "").trim() || "usuario";
  const openMessageProfileFallbackAvatar = getNameAvatarUrl(openMessageProfileDisplayName || openMessageProfileUsername || "U");
  const openMessageProfileAvatarSrc = String(openMessageProfileParticipant?.avatarSrc ?? "").trim() || openMessageProfileFallbackAvatar;
  const openMessageProfilePresenceState: PresenceState = openMessageProfileParticipant?.presenceState ?? "invisivel";
  const openMessageProfilePresenceLabel = PRESENCE_LABELS[openMessageProfilePresenceState];
  const isOpenMessageProfileCurrentUser = openMessageProfileUserId
    ? isCurrentUserSender(openMessageProfileUserId)
    : false;
  const openMessageProfileBannerSrc = useMemo(() => {
    if (!openMessageProfileUserId) {
      return getDefaultBannerUrl();
    }
    if (openMessageProfileUserId === targetUser.userId) {
      return targetBannerSrc;
    }
    return messageProfileExtrasByUserId[openMessageProfileUserId]?.bannerSrc ?? getDefaultBannerUrl();
  }, [messageProfileExtrasByUserId, openMessageProfileUserId, targetBannerSrc, targetUser.userId]);
  const openMessageProfileBannerColor = useMemo(() => {
    if (!openMessageProfileUserId) {
      return null;
    }
    if (openMessageProfileUserId === targetUser.userId) {
      return targetBannerColor;
    }
    return messageProfileExtrasByUserId[openMessageProfileUserId]?.bannerColor ?? null;
  }, [messageProfileExtrasByUserId, openMessageProfileUserId, targetBannerColor, targetUser.userId]);
  const openMessageProfileThemePrimaryColor = useMemo(() => {
    if (!openMessageProfileUserId) {
      return null;
    }
    if (openMessageProfileUserId === targetUser.userId) {
      return targetThemePrimaryColor;
    }
    return messageProfileExtrasByUserId[openMessageProfileUserId]?.themePrimaryColor ?? null;
  }, [messageProfileExtrasByUserId, openMessageProfileUserId, targetThemePrimaryColor, targetUser.userId]);
  const openMessageProfileThemeAccentColor = useMemo(() => {
    if (!openMessageProfileUserId) {
      return null;
    }
    if (openMessageProfileUserId === targetUser.userId) {
      return targetThemeAccentColor;
    }
    return messageProfileExtrasByUserId[openMessageProfileUserId]?.themeAccentColor ?? null;
  }, [messageProfileExtrasByUserId, openMessageProfileUserId, targetThemeAccentColor, targetUser.userId]);
  const openMessageProfileAboutText = useMemo(() => {
    if (!openMessageProfileUserId) {
      return "";
    }
    if (openMessageProfileUserId === targetUser.userId) {
      return targetAboutText;
    }
    return messageProfileExtrasByUserId[openMessageProfileUserId]?.aboutText ?? "";
  }, [messageProfileExtrasByUserId, openMessageProfileUserId, targetAboutText, targetUser.userId]);

  const loadMessageProfileExtra = useCallback(async (userId: string): Promise<void> => {
    const safeUserId = String(userId ?? "").trim();
    if (!safeUserId || safeUserId === targetUser.userId || messageProfileExtrasByUserId[safeUserId]) {
      return;
    }

    const defaultBanner = getDefaultBannerUrl();
    try {
      const row = await queryUserProfileExtras(safeUserId, USER_PROFILE_EXTRA_LIGHT_SELECT_VARIANTS);
      const resolvedBanner = await getBannerUrl(safeUserId, row?.banner_key ?? null, row?.banner_hash ?? null);

      setMessageProfileExtrasByUserId((current) => {
        if (current[safeUserId]) {
          return current;
        }
        return {
          ...current,
          [safeUserId]: {
            bannerSrc: String(resolvedBanner ?? "").trim() || defaultBanner,
            bannerColor: normalizeBannerColor(row?.banner_color) ?? null,
            themePrimaryColor: normalizeBannerColor(row?.profile_theme_primary_color) ?? null,
            themeAccentColor: normalizeBannerColor(row?.profile_theme_accent_color) ?? null,
            aboutText: String(row?.about ?? "").trim(),
          },
        };
      });
    } catch {
      setMessageProfileExtrasByUserId((current) => {
        if (current[safeUserId]) {
          return current;
        }
        return {
          ...current,
          [safeUserId]: {
            bannerSrc: defaultBanner,
            bannerColor: null,
            themePrimaryColor: null,
            themeAccentColor: null,
            aboutText: "",
          },
        };
      });
    }
  }, [messageProfileExtrasByUserId, targetUser.userId]);

  const closeMessageProfilePopover = useCallback((): void => {
    setOpenMessageProfileUserId(null);
    pendingProfileDraftCursorRef.current = null;
    messageProfileAnchorRef.current = null;
    if (emojiPopoverSource === "profile") {
      setIsEmojiOpen(false);
      setEmojiPopoverSource("composer");
    }
  }, [emojiPopoverSource]);

  const closeSidebarFullProfile = useCallback((): void => {
    setIsSidebarFullProfileOpen(false);
    if (emojiPopoverSource === "profile") {
      setIsEmojiOpen(false);
      setEmojiPopoverSource("composer");
    }
  }, [emojiPopoverSource]);

  const handleOpenSidebarFullProfile = useCallback((): void => {
    closeMessageProfilePopover();
    setIsSidebarFullProfileOpen(true);
  }, [closeMessageProfilePopover]);

  const handleOpenCurrentUserSettings = useCallback((): void => {
    closeMessageProfilePopover();
    closeSidebarFullProfile();
    onOpenSettings?.();
  }, [closeMessageProfilePopover, closeSidebarFullProfile, onOpenSettings]);

  const handleFullProfilePrimaryAction = useCallback((): void => {
    if (isSidebarProfileCurrentUser) {
      handleOpenCurrentUserSettings();
      return;
    }

    closeSidebarFullProfile();
    requestAnimationFrame(() => {
      draftInputRef.current?.focus();
    });
  }, [closeSidebarFullProfile, handleOpenCurrentUserSettings, isSidebarProfileCurrentUser]);

  const handleFullProfileUnfriend = useCallback(async (): Promise<void> => {
    if (!onUnfriendTarget || isSidebarProfileCurrentUser || isUnfriendingTarget) {
      return;
    }

    setIsUnfriendingTarget(true);
    try {
      await onUnfriendTarget();
    } finally {
      setIsUnfriendingTarget(false);
    }
  }, [isSidebarProfileCurrentUser, isUnfriendingTarget, onUnfriendTarget]);

  const handleFullProfileAddFriend = useCallback(async (): Promise<void> => {
    if (
      !onAddFriendTarget ||
      isSidebarProfileCurrentUser ||
      isAddingTargetFriend ||
      isTargetFriend ||
      isTargetFriendRequestPending
    ) {
      return;
    }

    setIsAddingTargetFriend(true);
    try {
      await onAddFriendTarget();
    } finally {
      setIsAddingTargetFriend(false);
    }
  }, [isAddingTargetFriend, isSidebarProfileCurrentUser, isTargetFriend, isTargetFriendRequestPending, onAddFriendTarget]);

  const handleFullProfileBlock = useCallback(async (): Promise<void> => {
    if (!onBlockTarget || isSidebarProfileCurrentUser || isBlockingTarget) {
      return;
    }

    setIsBlockingTarget(true);
    try {
      await onBlockTarget();
    } finally {
      setIsBlockingTarget(false);
    }
  }, [isBlockingTarget, isSidebarProfileCurrentUser, onBlockTarget]);

  const updateMessageProfilePopoverPosition = useCallback((): void => {
    if (!openMessageProfileUserId) {
      return;
    }

    const anchor = messageProfileAnchorRef.current;
    if (!anchor || !anchor.isConnected) {
      closeMessageProfilePopover();
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const measuredHeight = Number(messageProfilePopoverRef.current?.offsetHeight ?? MESSAGE_PROFILE_POPOVER_MIN_HEIGHT);
    const popoverHeight = Math.min(
      MESSAGE_PROFILE_POPOVER_MAX_HEIGHT,
      Math.max(MESSAGE_PROFILE_POPOVER_MIN_HEIGHT, measuredHeight),
    );

    const canPlaceRight =
      rect.right + MESSAGE_PROFILE_POPOVER_GAP + MESSAGE_PROFILE_POPOVER_WIDTH <=
      window.innerWidth - MESSAGE_PROFILE_POPOVER_MARGIN;
    const canPlaceLeft =
      rect.left - MESSAGE_PROFILE_POPOVER_GAP - MESSAGE_PROFILE_POPOVER_WIDTH >= MESSAGE_PROFILE_POPOVER_MARGIN;

    let left = canPlaceRight || !canPlaceLeft
      ? rect.right + MESSAGE_PROFILE_POPOVER_GAP
      : rect.left - MESSAGE_PROFILE_POPOVER_WIDTH - MESSAGE_PROFILE_POPOVER_GAP;
    const maxLeft = Math.max(
      MESSAGE_PROFILE_POPOVER_MARGIN,
      window.innerWidth - MESSAGE_PROFILE_POPOVER_WIDTH - MESSAGE_PROFILE_POPOVER_MARGIN,
    );
    left = Math.min(Math.max(left, MESSAGE_PROFILE_POPOVER_MARGIN), maxLeft);

    let top = rect.top - 16;
    const maxTop = Math.max(MESSAGE_PROFILE_POPOVER_MARGIN, window.innerHeight - popoverHeight - MESSAGE_PROFILE_POPOVER_MARGIN);
    top = Math.min(Math.max(top, MESSAGE_PROFILE_POPOVER_MARGIN), maxTop);

    setMessageProfilePosition((current) => {
      if (Math.abs(current.top - top) < 0.5 && Math.abs(current.left - left) < 0.5) {
        return current;
      }
      return { top, left };
    });
  }, [closeMessageProfilePopover, openMessageProfileUserId]);

  const handleOpenMessageProfilePopover = useCallback(
    (event: ReactMouseEvent<HTMLElement>, userId: string): void => {
      const safeUserId = String(userId ?? "").trim();
      if (!safeUserId) {
        return;
      }

      event.stopPropagation();
      closeSidebarFullProfile();

      const anchor = event.currentTarget;
      if (openMessageProfileUserId === safeUserId && messageProfileAnchorRef.current === anchor) {
        closeMessageProfilePopover();
        return;
      }

      messageProfileAnchorRef.current = anchor;
      setOpenMessageProfileUserId(safeUserId);
      void loadMessageProfileExtra(safeUserId);
    },
    [closeMessageProfilePopover, closeSidebarFullProfile, loadMessageProfileExtra, openMessageProfileUserId],
  );

  useEffect(() => {
    closeMessageProfilePopover();
    closeSidebarFullProfile();
  }, [closeMessageProfilePopover, closeSidebarFullProfile, conversationId]);

  useEffect(() => {
    if (!openMessageProfileUserId) {
      return;
    }

    updateMessageProfilePopoverPosition();
    const handleReposition = (): void => {
      updateMessageProfilePopoverPosition();
    };

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [openMessageProfileUserId, updateMessageProfilePopoverPosition]);

  useLayoutEffect(() => {
    if (!openMessageProfileUserId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      updateMessageProfilePopoverPosition();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    openMessageProfileAboutText,
    openMessageProfileBannerSrc,
    openMessageProfileUserId,
    updateMessageProfilePopoverPosition,
  ]);

  useEffect(() => {
    if (!openMessageProfileUserId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (messageProfileAnchorRef.current?.contains(target)) {
        return;
      }

      if (messageProfilePopoverRef.current?.contains(target)) {
        return;
      }

      closeMessageProfilePopover();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMessageProfilePopover();
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown, { passive: true });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMessageProfilePopover, openMessageProfileUserId]);

  useEffect(() => {
    if (!isSidebarFullProfileOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (sidebarFullProfileRef.current?.contains(target)) {
        return;
      }

      closeSidebarFullProfile();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeSidebarFullProfile();
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown, { passive: true });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSidebarFullProfile, isSidebarFullProfileOpen]);

  const releaseDraftAttachmentById = useCallback((attachmentId: string): void => {
    setDraftAttachments((current) => {
      const attachment = current.find((item) => item.id === attachmentId);
      if (attachment) {
        revokeDraftAttachment(attachment);
      }
      return current.filter((item) => item.id !== attachmentId);
    });
  }, []);

  const handleSelectEmoji = useCallback((emoji: string): void => {
    if (emojiPopoverSource === "profile") {
      const input = profileMessageComposerInputRef.current;
      if (!input) {
        setDraft((current) => {
          const { nextText } = insertEmojiAtCursor(current, current.length, current.length, emoji);
          return nextText;
        });
        return;
      }

      const currentValue = input.value;
      const selectionStart = input.selectionStart ?? currentValue.length;
      const selectionEnd = input.selectionEnd ?? selectionStart;
      const { nextText, nextCursor } = insertEmojiAtCursor(currentValue, selectionStart, selectionEnd, emoji);

      pendingProfileDraftCursorRef.current = nextCursor;
      setDraft(nextText);
      return;
    }

    const input = draftInputRef.current;
    if (!input) {
      setDraft((current) => {
        const { nextText } = insertEmojiAtCursor(current, current.length, current.length, emoji);
        return nextText;
      });
      return;
    }

    const currentValue = input.value;
    const selectionStart = input.selectionStart ?? currentValue.length;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    const { nextText, nextCursor } = insertEmojiAtCursor(currentValue, selectionStart, selectionEnd, emoji);

    pendingDraftCursorRef.current = nextCursor;
    setDraft(nextText);
  }, [emojiPopoverSource]);

  useLayoutEffect(() => {
    const pendingCursor = pendingDraftCursorRef.current;
    if (pendingCursor === null) {
      return;
    }
    const input = draftInputRef.current;
    if (!input) {
      pendingDraftCursorRef.current = null;
      return;
    }
    const clampedCursor = Math.max(0, Math.min(pendingCursor, input.value.length));
    input.focus();
    input.setSelectionRange(clampedCursor, clampedCursor);
    pendingDraftCursorRef.current = null;
  }, [draft]);

  useLayoutEffect(() => {
    const pendingCursor = pendingProfileDraftCursorRef.current;
    if (pendingCursor === null) {
      return;
    }
    const input = profileMessageComposerInputRef.current;
    if (!input) {
      pendingProfileDraftCursorRef.current = null;
      return;
    }
    const clampedCursor = Math.max(0, Math.min(pendingCursor, input.value.length));
    input.focus();
    input.setSelectionRange(clampedCursor, clampedCursor);
    pendingProfileDraftCursorRef.current = null;
  }, [draft]);

  const handleToggleComposerEmoji = useCallback((): void => {
    if (isSending) {
      return;
    }
    setIsEmojiOpen((current) => (emojiPopoverSource === "composer" ? !current : true));
    setEmojiPopoverSource("composer");
  }, [emojiPopoverSource, isSending]);

  const handleToggleProfileComposerEmoji = useCallback((): void => {
    if (isSending) {
      return;
    }
    setIsEmojiOpen((current) => (emojiPopoverSource === "profile" ? !current : true));
    setEmojiPopoverSource("profile");
  }, [emojiPopoverSource, isSending]);

  const handleCloseMediaViewer = useCallback((): void => {
    setMediaViewerState(null);
  }, []);

  const handleMediaViewerStep = useCallback((direction: 1 | -1): void => {
    setMediaViewerState((current) => {
      if (!current || current.items.length <= 1) {
        return current;
      }
      const nextIndex = (current.index + direction + current.items.length) % current.items.length;
      return {
        ...current,
        index: nextIndex,
      };
    });
  }, []);

  const isNearBottom = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (!container) {
      return true;
    }
    return container.scrollHeight - container.scrollTop - container.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  const updateScrollThumb = useCallback((): void => {
    const container = scrollContainerRef.current;
    const track = scrollbarRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!container || !track || !thumb) {
      return;
    }

    const { scrollHeight, clientHeight, scrollTop } = container;
    const trackHeight = track.clientHeight;
    if (scrollHeight <= clientHeight || trackHeight <= 0) {
      track.style.opacity = "0";
      thumb.style.height = "0px";
      thumb.style.transform = "translateY(0)";
      return;
    }

    const minThumbHeight = 24;
    const thumbHeight = Math.max((clientHeight / scrollHeight) * trackHeight, minThumbHeight);
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * maxThumbTop;

    track.style.opacity = "1";
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, []);

  const scrollToBottom = useCallback((immediate = false): void => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    setShowNewMessagesButton(false);

    gsap.killTweensOf(container);

    if (immediate) {
      container.scrollTop = container.scrollHeight;
      isNearBottomRef.current = true;
      updateScrollThumb();
      return;
    }

    gsap.to(container, {
      scrollTo: { y: "max" },
      duration: SCROLL_TO_BOTTOM_DURATION_S,
      ease: "power2.out",
      overwrite: "auto",
      onUpdate: updateScrollThumb,
      onComplete: () => {
        isNearBottomRef.current = true;
        updateScrollThumb();
      },
    });
  }, [updateScrollThumb]);

  const markConversationAsRead = useCallback(
    async (nextMessages: ChatMessageItem[]): Promise<void> => {
      const incomingIds = nextMessages
        .filter(
          (message) =>
            !message.optimistic &&
            !message.failed &&
            !message.deletedAt &&
            message.senderId !== currentUserId &&
            !message.id.startsWith("optimistic:"),
        )
        .map((message) => message.id);

      if (incomingIds.length === 0) {
        return;
      }

      const { data: existingReads, error: readsError } = await supabase
        .from("message_reads")
        .select("message_id")
        .eq("user_id", currentUserId)
        .in("message_id", incomingIds);

      if (readsError) {
        return;
      }

      const readIds = new Set((existingReads as MessageReadRow[] | null | undefined)?.map((row) => row.message_id) ?? []);
      const missingIds = incomingIds.filter((id) => !readIds.has(id));
      if (missingIds.length === 0) {
        return;
      }

      await supabase.from("message_reads").upsert(
        missingIds.map((messageId) => ({
          message_id: messageId,
          user_id: currentUserId,
          read_at: new Date().toISOString(),
        })),
        {
          onConflict: "message_id,user_id",
        },
      );
    },
    [currentUserId],
  );

  const shouldProcessVoiceSignal = useCallback((senderUserIdRaw: string, sentAtRaw: number): boolean => {
    const senderUserId = String(senderUserIdRaw ?? "").trim();
    if (!senderUserId) {
      return false;
    }
    if (!Number.isFinite(sentAtRaw) || sentAtRaw <= 0) {
      return false;
    }

    const latestBySender = latestVoiceSignalBySenderRef.current;
    const knownSentAt = latestBySender.get(senderUserId) ?? 0;
    if (sentAtRaw < knownSentAt) {
      return false;
    }
    latestBySender.set(senderUserId, sentAtRaw);
    return true;
  }, []);

  const clearOutgoingVoiceRingTimer = useCallback((): void => {
    if (outgoingVoiceRingTimerRef.current != null) {
      window.clearTimeout(outgoingVoiceRingTimerRef.current);
      outgoingVoiceRingTimerRef.current = null;
    }
  }, []);

  const clearSingleParticipantTimer = useCallback((): void => {
    if (singleParticipantTimerRef.current != null) {
      window.clearTimeout(singleParticipantTimerRef.current);
      singleParticipantTimerRef.current = null;
    }
  }, []);

  const clearIncomingVoiceInviteTimer = useCallback((): void => {
    if (incomingVoiceInviteTimerRef.current != null) {
      window.clearTimeout(incomingVoiceInviteTimerRef.current);
      incomingVoiceInviteTimerRef.current = null;
    }
  }, []);

  const clearRejoinFallbackTimer = useCallback((): void => {
    if (rejoinFallbackTimerRef.current != null) {
      window.clearTimeout(rejoinFallbackTimerRef.current);
      rejoinFallbackTimerRef.current = null;
    }
  }, []);

  const clearIncomingVoiceInviteState = useCallback(() => {
    clearIncomingVoiceInviteTimer();
    setIncomingVoiceInviteFromUserId(null);
    setIncomingVoiceInviteRoomId(null);
    setIncomingVoiceInviteExpiresAtMs(null);
  }, [clearIncomingVoiceInviteTimer]);

  const applyIncomingVoiceInviteState = useCallback(
    (senderUserIdRaw: string, roomIdRaw: string, sentAtRaw: number): void => {
      const senderUserId = String(senderUserIdRaw ?? "").trim();
      if (!senderUserId || !Number.isFinite(sentAtRaw) || sentAtRaw <= 0) {
        return;
      }
      const expiresAtMs = sentAtRaw + VOICE_CALL_INVITE_TTL_MS;
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        clearIncomingVoiceInviteState();
        return;
      }
      clearIncomingVoiceInviteTimer();
      setIncomingVoiceInviteFromUserId(senderUserId);
      setIncomingVoiceInviteRoomId(String(roomIdRaw ?? "").trim() || voiceRoomId);
      setIncomingVoiceInviteExpiresAtMs(expiresAtMs);
      if (!isVoiceCallActiveRef.current && !isVoiceCallConnectingRef.current) {
        setVoiceCallUiState("RINGING");
      }
      incomingVoiceInviteTimerRef.current = window.setTimeout(() => {
        clearIncomingVoiceInviteState();
      }, remainingMs);
    },
    [clearIncomingVoiceInviteState, clearIncomingVoiceInviteTimer, voiceRoomId],
  );

  const clearVoiceCallRejoinFallback = useCallback(() => {
    clearRejoinFallbackTimer();
    setVoiceCallRejoinFallback(null);
  }, [clearRejoinFallbackTimer]);

  const setVoiceCallRejoinFallbackWithTtl = useCallback(
    (
      fallback: Omit<VoiceCallRejoinFallback, "expiresAtMs"> | null,
      ttlMsRaw = VOICE_CALL_REJOIN_FALLBACK_TTL_MS,
    ): void => {
      clearRejoinFallbackTimer();
      if (!fallback) {
        setVoiceCallRejoinFallback(null);
        return;
      }
      const ttlMs = Number.isFinite(ttlMsRaw) ? Math.max(1_000, ttlMsRaw) : VOICE_CALL_REJOIN_FALLBACK_TTL_MS;
      const expiresAtMs = Date.now() + ttlMs;
      setVoiceCallRejoinFallback({
        ...fallback,
        expiresAtMs,
      });
      rejoinFallbackTimerRef.current = window.setTimeout(() => {
        setVoiceCallRejoinFallback((current) => {
          if (!current) {
            return null;
          }
          return current.expiresAtMs <= Date.now() ? null : current;
        });
      }, ttlMs + 50);
    },
    [clearRejoinFallbackTimer],
  );

  const clearVoiceCallRejoinFallbackForUser = useCallback((userIdRaw: string): void => {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      return;
    }
    clearRejoinFallbackTimer();
    setVoiceCallRejoinFallback((current) => {
      if (!current || current.userId !== userId) {
        return current;
      }
      return null;
    });
  }, [clearRejoinFallbackTimer]);

  const handleVoicePresenceStateUpdate = useCallback((update: VoiceCallStateUpdate): void => {
    const call = update.call;
    const localUserId = String(currentUser.userId ?? "").trim() || String(currentUserId ?? "").trim();
    const callStatus = String(call.status ?? "").trim().toUpperCase();
    const roomId = String(call.roomId ?? "").trim() || voiceRoomId;
    const remoteParticipant = call.participants.find((participant) => {
      const participantUserId = String(participant.userId ?? "").trim();
      if (!participantUserId || participantUserId === localUserId) {
        return false;
      }
      return String(participant.state ?? "").trim().toUpperCase() !== "DISCONNECTED";
    }) ?? null;
    const remoteUserId = String(remoteParticipant?.userId ?? "").trim() || String(targetUser.userId ?? "").trim();
    const remoteDisplayName = String(remoteParticipant?.displayName ?? "").trim() || safeTargetDisplayName;
    const createdAtMs = Number(call.createdAt ?? Date.now());
    const normalizedCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
    const isCallActiveOnServer = callStatus === "RINGING" || callStatus === "CONNECTED" || callStatus === "RECONNECTING";

    if (update.event === "CALL_ENDED" && isVoiceCallConnectingRef.current && !hadRemoteParticipantInSessionRef.current) {
      clearIncomingVoiceInviteState();
      clearVoiceCallRejoinFallback();
      void stopVoiceCallSessionRef.current?.();
      return;
    }

    if (!isCallActiveOnServer) {
      clearIncomingVoiceInviteState();
      clearVoiceCallRejoinFallback();
      if (!isVoiceCallActiveRef.current && !isVoiceCallConnectingRef.current) {
        setVoiceCallUiState("ENDED");
      }
      return;
    }

    if (isVoiceCallActiveRef.current || isVoiceCallConnectingRef.current) {
      clearIncomingVoiceInviteState();
      clearVoiceCallRejoinFallback();
      return;
    }

    if (callStatus === "RINGING") {
      const callerUserId = String(call.createdBy ?? "").trim();
      if (callerUserId && callerUserId !== localUserId) {
        applyIncomingVoiceInviteState(callerUserId, roomId, normalizedCreatedAtMs);
        return;
      }

      clearIncomingVoiceInviteState();
      if (!remoteUserId) {
        return;
      }
      setVoiceCallRejoinFallbackWithTtl({
        roomId,
        userId: remoteUserId,
        displayName: remoteDisplayName,
        avatarSrc: targetAvatarSrc,
      }, VOICE_CALL_SERVER_FALLBACK_TTL_MS);
      return;
    }

    clearIncomingVoiceInviteState();
    if (!remoteUserId) {
      clearVoiceCallRejoinFallback();
      return;
    }

    setVoiceCallRejoinFallbackWithTtl({
      roomId,
      userId: remoteUserId,
      displayName: remoteDisplayName,
      avatarSrc: targetAvatarSrc,
    }, VOICE_CALL_SERVER_FALLBACK_TTL_MS);
  }, [
    applyIncomingVoiceInviteState,
    clearIncomingVoiceInviteState,
    clearVoiceCallRejoinFallback,
    currentUser.userId,
    currentUserId,
    safeTargetDisplayName,
    setVoiceCallRejoinFallbackWithTtl,
    targetAvatarSrc,
    targetUser.userId,
    voiceRoomId,
  ]);

  const sendVoiceSignal = useCallback(
    async (action: VoiceCallSignalAction, roomIdOverride?: string | null): Promise<void> => {
      void action;
      void roomIdOverride;
    },
    [],
  );

  const consumeVoiceSignalMessage = useCallback(
    (message: ChatMessageItem): boolean => {
      if (message.type !== "text") {
        return false;
      }

      const signal = parseVoiceCallSignalContent(message.content);
      if (!signal) {
        return false;
      }

      if (!voiceSignalMessageIdsRef.current.has(message.id)) {
        voiceSignalMessageIdsRef.current.add(message.id);
        if (voiceSignalMessageIdsRef.current.size > 512) {
          const firstInserted = voiceSignalMessageIdsRef.current.values().next().value as string | undefined;
          if (firstInserted) {
            voiceSignalMessageIdsRef.current.delete(firstInserted);
          }
        }
      }

      const senderUserId = String(message.senderId ?? "").trim();
      const localUserId = String(currentUser.userId ?? "").trim() || String(currentUserId ?? "").trim();
      const fromRemote = Boolean(senderUserId) && senderUserId !== localUserId;

      if (fromRemote) {
        void markConversationAsRead([message]);
      }

      if (!fromRemote) {
        return true;
      }
      const sentAt = Number(signal.sentAt ?? 0);
      if (!shouldProcessVoiceSignal(senderUserId, sentAt)) {
        return true;
      }

      if (signal.action === "invite") {
        if (!isVoiceCallActiveRef.current && !isVoiceCallConnectingRef.current) {
          applyIncomingVoiceInviteState(senderUserId, signal.roomId, sentAt);
        }
        return true;
      }

      if (signal.action === "cancel") {
        if (incomingVoiceInviteFromUserIdRef.current === senderUserId) {
          clearIncomingVoiceInviteState();
        }
        clearVoiceCallRejoinFallbackForUser(senderUserId);
        if (isVoiceCallConnectingRef.current && !hadRemoteParticipantInSessionRef.current) {
          void stopVoiceCallSessionRef.current?.();
        }
        return true;
      }

      return true;
    },
    [
      clearIncomingVoiceInviteState,
      applyIncomingVoiceInviteState,
      clearVoiceCallRejoinFallbackForUser,
      currentUser.userId,
      currentUserId,
      markConversationAsRead,
      shouldProcessVoiceSignal,
      voiceRoomId,
    ],
  );

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    deletedMessageIdsRef.current = deletedMessageIds;
  }, [deletedMessageIds]);

  useEffect(() => {
    isVoiceCallActiveRef.current = isVoiceCallActive;
  }, [isVoiceCallActive]);

  useEffect(() => {
    isVoiceCallConnectingRef.current = isVoiceCallConnecting;
  }, [isVoiceCallConnecting]);

  useEffect(() => {
    publishVoiceCallUiSnapshot({
      callActive: isVoiceCallActive,
      callConnecting: isVoiceCallConnecting,
      muted: isVoiceCallMuted,
      deafened: isVoiceCallDeafened,
    });
  }, [isVoiceCallActive, isVoiceCallConnecting, isVoiceCallMuted, isVoiceCallDeafened]);

  useEffect(() => {
    return () => {
      resetVoiceCallUiSnapshot();
    };
  }, []);

  useEffect(() => {
    voiceCallUiStateRef.current = voiceCallUiState;
  }, [voiceCallUiState]);

  useEffect(() => {
    voiceCallParticipantsRef.current = voiceCallParticipants;
  }, [voiceCallParticipants]);

  useEffect(() => {
    activeVoiceRoomIdRef.current = voiceRoomId;
  }, [voiceRoomId]);

  useEffect(() => {
    incomingVoiceInviteFromUserIdRef.current = incomingVoiceInviteFromUserId;
  }, [incomingVoiceInviteFromUserId]);

  useEffect(() => {
    const localUserId = String(currentUser.userId ?? "").trim() || String(currentUserId ?? "").trim();
    if (!localUserId) {
      return;
    }

    const presenceClient = new VoiceCallPresenceClient({
      roomId: voiceRoomId,
      self: {
        userId: localUserId,
        displayName: String(currentUser.displayName ?? "").trim() || String(currentUser.username ?? "").trim() || "Voce",
      },
      onStateUpdate: handleVoicePresenceStateUpdate,
      onError: (error) => {
        const message = String(error.message ?? "").trim();
        if (!message) {
          return;
        }
        setVoiceCallError((current) => current ?? message);
      },
    });

    voicePresenceClientRef.current = presenceClient;
    void presenceClient.start().catch(() => undefined);

    return () => {
      if (voicePresenceClientRef.current === presenceClient) {
        voicePresenceClientRef.current = null;
      }
      void presenceClient.stop();
    };
  }, [
    currentUser.displayName,
    currentUser.userId,
    currentUser.username,
    currentUserId,
    handleVoicePresenceStateUpdate,
    voiceRoomId,
  ]);

  useEffect(() => {
    if (messages.length <= ACTIVE_MESSAGE_WINDOW_MAX) {
      return;
    }

    const trimmed = trimMessagesToActiveWindow(messages, "drop-older");
    if (areMessagesEqual(messages, trimmed.messages)) {
      return;
    }

    setMessages(trimmed.messages);
    if (trimmed.droppedOlder.length > 0) {
      const cursor = buildOlderCursorFromMessages(trimmed.messages);
      setNextCursor(cursor);
      setHasMoreBefore(Boolean(cursor));
    }
  }, [messages]);

  useEffect(() => {
    const messageIds = new Set(messages.map((message) => message.id));
    setAttachmentUrlMap((current) => {
      const next = pruneAttachmentMapByMessageIds(current, messageIds);
      return areFlatRecordValuesEqual(current, next) ? current : next;
    });
    setAttachmentThumbUrlMap((current) => {
      const next = pruneAttachmentMapByMessageIds(current, messageIds);
      return areFlatRecordValuesEqual(current, next) ? current : next;
    });
  }, [messages]);

  useEffect(() => {
    const stableMessages = messages.filter((message) => !message.optimistic && isVisibleChatMessage(message));
    if (stableMessages.some((message) => message.conversationId !== conversationId)) {
      return;
    }
    const hasAnyResolvedData =
      stableMessages.length > 0 ||
      hasMoreBefore ||
      Boolean(nextCursor) ||
      deletedMessageIds.size > 0 ||
      Object.keys(attachmentUrlMap).length > 0 ||
      Object.keys(attachmentThumbUrlMap).length > 0;
    if (isInitialConversationLoading && !hasAnyResolvedData) {
      return;
    }
    setConversationMessagesCache(conversationId, {
      messages: stableMessages,
      nextCursor,
      hasMoreBefore,
      deletedMessageIds: Array.from(deletedMessageIds),
      attachmentUrlMap,
      attachmentThumbUrlMap,
    });
  }, [
    attachmentThumbUrlMap,
    attachmentUrlMap,
    conversationId,
    deletedMessageIds,
    hasMoreBefore,
    isInitialConversationLoading,
    messages,
    nextCursor,
  ]);

  useEffect(
    () => () => {
      draftAttachmentsRef.current.forEach((attachment) => {
        revokeDraftAttachment(attachment);
      });
    },
    [],
  );

  const registerDeletedMessageId = useCallback((messageIdRaw: string): void => {
    const messageId = String(messageIdRaw ?? "").trim();
    if (!messageId) {
      return;
    }

    setDeletedMessageIds((current) => {
      if (current.has(messageId)) {
        deletedMessageIdsRef.current = current;
        return current;
      }
      const next = new Set(current);
      next.add(messageId);
      deletedMessageIdsRef.current = next;
      return next;
    });
  }, []);

  const loadConversationMessages = useCallback(async (reason: string = "manual"): Promise<void> => {
    const startedAt = Date.now();
    const fetchStartedAt = performance.now();
    try {
      const listed =
        reason === "open"
          ? ((await preloadChatMessages({
              conversationId,
              limit: INITIAL_PAGE_SIZE,
              // Prefer sidebar preload/in-flight cache on first open to reduce perceived wait.
              force: false,
            })) ??
            (await listChatMessages({
              conversationId,
              limit: INITIAL_PAGE_SIZE,
            })))
          : await listChatMessages({
              conversationId,
              limit: INITIAL_PAGE_SIZE,
            });
      const fetchElapsedMs = performance.now() - fetchStartedAt;
      const {
        normalizedMessages: listedNormalizedMessages,
        deletedIds,
        visibleMessages: serverMessages,
      } = normalizeListedMessages(listed.messages ?? []);

      for (const listedMessage of listedNormalizedMessages) {
        void consumeVoiceSignalMessage(listedMessage);
      }

      const knownDeletedMessageIds = new Set(deletedMessageIdsRef.current);
      let hasNewDeletedMessageId = false;
      deletedIds.forEach((id) => {
        if (!knownDeletedMessageIds.has(id)) {
          knownDeletedMessageIds.add(id);
          hasNewDeletedMessageId = true;
        }
      });
      if (hasNewDeletedMessageId) {
        deletedMessageIdsRef.current = knownDeletedMessageIds;
        setDeletedMessageIds(knownDeletedMessageIds);
      }

      const visibleServerMessages = serverMessages.filter((message) => !knownDeletedMessageIds.has(message.id));
      const localMessages = messagesRef.current.filter((message) => !knownDeletedMessageIds.has(message.id));
      const optimisticMessages = localMessages.filter((message) => message.optimistic || message.failed);
      const serverMessageIds = new Set(visibleServerMessages.map((message) => message.id).filter(Boolean));
      const serverClientIds = new Set(
        visibleServerMessages.map((message) => (message.clientId ? message.clientId : "")).filter(Boolean),
      );

      const carryOverMessages = optimisticMessages.filter(
        (message) =>
          !serverMessageIds.has(message.id) && (!message.clientId || !serverClientIds.has(message.clientId)),
      );
      const oldestServerMessage = visibleServerMessages[0] ?? null;
      const nowMs = Date.now();
      const localTransientMessages = localMessages.filter(
        (message) =>
          !message.optimistic &&
          !message.failed &&
          shouldRetainLocalMessageDuringReload(
            message,
            serverMessageIds,
            serverClientIds,
            oldestServerMessage,
            nowMs,
          ),
      );
      const mergedWithCarryOver = upsertMessages(visibleServerMessages, [...carryOverMessages, ...localTransientMessages]);
      const mergedMessages = filterMessagesByVisibilityAndDeletedIds(
        mergedWithCarryOver,
        knownDeletedMessageIds,
      );
      const trimmed = trimMessagesToActiveWindow(mergedMessages, "drop-older");
      const derivedOlderCursor = buildOlderCursorFromMessages(trimmed.messages);
      const resolvedCursor = trimmed.droppedOlder.length > 0
        ? derivedOlderCursor
        : (listed.nextCursor ?? null);
      const resolvedHasMoreBefore = trimmed.droppedOlder.length > 0 || Boolean(listed.nextCursor);

      setMessages((current) => (areMessagesEqual(current, trimmed.messages) ? current : trimmed.messages));
      setNextCursor(resolvedCursor);
      setHasMoreBefore(resolvedHasMoreBefore);
      setHasTrimmedNewerMessages(false);

      setLoadError(null);
      void markConversationAsRead(visibleServerMessages);
      recordLatency("chat_initial_load", startedAt);
      lastSuccessfulLoadAtRef.current = Date.now();
      logChatPerf("open:fetch", {
        conversationId,
        reason,
        fetchMs: Number(fetchElapsedMs.toFixed(1)),
        messageCount: visibleServerMessages.length,
      });
    } catch (error) {
      reportClientError(error, {
        scope: "chat.loadConversationMessages",
        conversationId,
        reason,
      });
      setLoadError("Nao foi possivel carregar as mensagens.");
      incrementMetric("chat_load_failure_total", 1);
    }
  }, [consumeVoiceSignalMessage, conversationId, markConversationAsRead]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!nextCursor || isLoadingOlderRef.current || !hasMoreBefore) {
      return;
    }

    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;
    const previousScrollTop = container?.scrollTop ?? 0;

    try {
      const listed = await listChatMessages({
        conversationId,
        limit: INITIAL_PAGE_SIZE,
        cursor: nextCursor,
      });

      const { deletedIds, visibleMessages: olderMessages } = normalizeListedMessages(listed.messages ?? []);
      const knownDeletedMessageIds = new Set(deletedMessageIdsRef.current);
      let hasNewDeletedMessageId = false;
      deletedIds.forEach((id) => {
        if (!knownDeletedMessageIds.has(id)) {
          knownDeletedMessageIds.add(id);
          hasNewDeletedMessageId = true;
        }
      });
      if (hasNewDeletedMessageId) {
        deletedMessageIdsRef.current = knownDeletedMessageIds;
        setDeletedMessageIds(knownDeletedMessageIds);
      }

      const visibleOlderMessages = olderMessages.filter((message) => !knownDeletedMessageIds.has(message.id));
      if (visibleOlderMessages.length > 0) {
        const currentById = new Map(messagesRef.current.map((message) => [message.id, message]));
        visibleOlderMessages.forEach((message) => {
          currentById.set(message.id, {
            ...currentById.get(message.id),
            ...message,
          });
        });
        const mergedMessages = filterMessagesByVisibilityAndDeletedIds(
          sortMessages(Array.from(currentById.values())),
          knownDeletedMessageIds,
        );
        const trimmed = trimMessagesToActiveWindow(mergedMessages, "drop-newer");
        if (trimmed.droppedNewer.length > 0) {
          setHasTrimmedNewerMessages(true);
        }
        setMessages((current) => (areMessagesEqual(current, trimmed.messages) ? current : trimmed.messages));
      }

      setNextCursor(listed.nextCursor ?? null);
      setHasMoreBefore(Boolean(listed.nextCursor));

      requestAnimationFrame(() => {
        const liveContainer = scrollContainerRef.current;
        if (!liveContainer) {
          return;
        }
        const nextScrollHeight = liveContainer.scrollHeight;
        const delta = nextScrollHeight - previousScrollHeight;
        liveContainer.scrollTop = previousScrollTop + delta;
      });
    } catch (error) {
      reportClientError(error, {
        scope: "chat.loadOlderMessages",
        conversationId,
      });
      incrementMetric("chat_load_older_failure_total", 1);
    } finally {
      isLoadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [conversationId, hasMoreBefore, nextCursor]);

  useEffect(() => {
    let isMounted = true;
    let inFlight = false;
    let queued = false;
    let initialLoadSettled = false;

    const cachedConversation = getConversationMessagesCache(conversationId);
    const staleConversationSeed = cachedConversation ? null : getStaleConversationMessagesCache(conversationId);
    const cachedConversationHasMessages = Boolean(cachedConversation && cachedConversation.messages.length > 0);
    const staleConversationHasMessages = Boolean(staleConversationSeed && staleConversationSeed.messages.length > 0);
    const preloadedConversation = getCachedInitialChatMessages(conversationId, INITIAL_MESSAGE_CACHE_TTL_MS);
    const stalePreloadedConversation =
      preloadedConversation || cachedConversationHasMessages || staleConversationHasMessages
        ? null
        : getCachedInitialChatMessages(conversationId, STALE_MESSAGE_SEED_CACHE_TTL_MS);
    const preloadedWindow = preloadedConversation ? normalizeListedMessages(preloadedConversation.messages ?? []) : null;
    const preloadedWindowHasMessages = Boolean(preloadedWindow && preloadedWindow.visibleMessages.length > 0);
    const stalePreloadedWindow = stalePreloadedConversation
      ? normalizeListedMessages(stalePreloadedConversation.messages ?? [])
      : null;
    const stalePreloadedWindowHasMessages = Boolean(
      stalePreloadedWindow && stalePreloadedWindow.visibleMessages.length > 0,
    );
    const preloadedHasSeed = Boolean(
      staleConversationHasMessages || preloadedWindowHasMessages || stalePreloadedWindowHasMessages,
    );

    if (cachedConversationHasMessages && cachedConversation) {
      setMessages(cachedConversation.messages);
      setNextCursor(cachedConversation.nextCursor);
      setHasMoreBefore(cachedConversation.hasMoreBefore);
      setDeletedMessageIds(new Set(cachedConversation.deletedMessageIds ?? []));
      setAttachmentUrlMap(cachedConversation.attachmentUrlMap);
      setAttachmentThumbUrlMap(cachedConversation.attachmentThumbUrlMap);
      previousMessageCountRef.current = cachedConversation.messages.length;
      logChatPerf("open:cache-hit", {
        conversationId,
        source: "conversation",
        messageCount: cachedConversation.messages.length,
      });
    } else if (staleConversationHasMessages && staleConversationSeed) {
      setMessages(staleConversationSeed.messages);
      setNextCursor(staleConversationSeed.nextCursor);
      setHasMoreBefore(staleConversationSeed.hasMoreBefore);
      setDeletedMessageIds(new Set(staleConversationSeed.deletedMessageIds ?? []));
      setAttachmentUrlMap(staleConversationSeed.attachmentUrlMap);
      setAttachmentThumbUrlMap(staleConversationSeed.attachmentThumbUrlMap);
      previousMessageCountRef.current = staleConversationSeed.messages.length;
      logChatPerf("open:cache-hit", {
        conversationId,
        source: "conversation-stale-seed",
        messageCount: staleConversationSeed.messages.length,
      });
    } else if (preloadedConversation && preloadedWindow && preloadedWindowHasMessages) {
      setMessages(preloadedWindow.visibleMessages);
      setNextCursor(preloadedConversation.nextCursor ?? null);
      setHasMoreBefore(Boolean(preloadedConversation.nextCursor));
      setDeletedMessageIds(new Set(preloadedWindow.deletedIds));
      setAttachmentUrlMap({});
      setAttachmentThumbUrlMap({});
      previousMessageCountRef.current = preloadedWindow.visibleMessages.length;
      logChatPerf("open:cache-hit", {
        conversationId,
        source: "preload",
        messageCount: preloadedWindow.visibleMessages.length,
      });
    } else if (stalePreloadedConversation && stalePreloadedWindow && stalePreloadedWindowHasMessages) {
      setMessages(stalePreloadedWindow.visibleMessages);
      setNextCursor(stalePreloadedConversation.nextCursor ?? null);
      setHasMoreBefore(Boolean(stalePreloadedConversation.nextCursor));
      setDeletedMessageIds(new Set(stalePreloadedWindow.deletedIds));
      setAttachmentUrlMap({});
      setAttachmentThumbUrlMap({});
      previousMessageCountRef.current = stalePreloadedWindow.visibleMessages.length;
      logChatPerf("open:cache-hit", {
        conversationId,
        source: "preload-stale-seed",
        messageCount: stalePreloadedWindow.visibleMessages.length,
      });
    } else {
      setMessages([]);
      setNextCursor(null);
      setHasMoreBefore(false);
      setDeletedMessageIds(new Set());
      setAttachmentUrlMap({});
      setAttachmentThumbUrlMap({});
      previousMessageCountRef.current = 0;
    }

    setIsInitialConversationLoading(!(cachedConversationHasMessages || preloadedHasSeed));

    setLoadError(null);
    setDraft("");
    setEditingMessageId(null);
    setEditingValue("");
    setIsSavingEdit(false);
    setDeleteTarget(null);
    setReplyTarget(null);
    setHighlightMessageId(null);
    setMediaViewerState(null);
    setIsEmojiOpen(false);
    setIsLoadingOlder(false);
    setHasTrimmedNewerMessages(false);
    setShowNewMessagesButton(false);
    setVirtualFocusIndex(null);
    setVirtualScrollTop(0);
    setVirtualViewportHeight(0);
    isLoadingOlderRef.current = false;
    isRestoringTrimmedWindowRef.current = false;
    pendingVirtualScrollMessageIdRef.current = null;
    setDraftAttachments((current) => {
      current.forEach((attachment) => {
        revokeDraftAttachment(attachment);
      });
      return [];
    });
    forceNextAutoScrollRef.current = true;
    initialScrollDoneRef.current = false;
    previousTailMessageIdRef.current = null;
    isNearBottomRef.current = true;

    const requestLoad = async (reason: string): Promise<void> => {
      if (!isMounted) {
        return;
      }
      const now = Date.now();
      if (
        (reason === "focus" || reason === "visibility") &&
        lastSuccessfulLoadAtRef.current > 0 &&
        now - lastSuccessfulLoadAtRef.current < 10_000
      ) {
        return;
      }
      if (inFlight) {
        if (reason === "open") {
          queued = true;
        }
        return;
      }

      inFlight = true;
      try {
        do {
          queued = false;
          await loadConversationMessages(reason);
        } while (queued && isMounted);
      } finally {
        inFlight = false;
        if (!initialLoadSettled && isMounted) {
          initialLoadSettled = true;
          setIsInitialConversationLoading(false);
        }
      }
    };

    void requestLoad("open");

    const intervalId = window.setInterval(() => {
      if (typeof document !== "undefined") {
        if (document.visibilityState !== "visible" || !document.hasFocus()) {
          return;
        }
      }
      void requestLoad("interval");
    }, 18_000);

    const handleFocus = (): void => {
      void requestLoad("focus");
    };

    const handleVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void requestLoad("visibility");
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [conversationId, loadConversationMessages]);

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Delay subscription by one macrotask to avoid StrictMode dev-only
    // mount/unmount noise that closes the socket before handshake.
    const bootstrapTimer = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      channel = supabase
        .channel(`dm-chat:${conversationId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const incoming = normalizeMessageRow(payload.new as MessageRow);
            if (consumeVoiceSignalMessage(incoming)) {
              return;
            }
            if (!isVisibleChatMessage(incoming) || deletedMessageIdsRef.current.has(incoming.id)) {
              registerDeletedMessageId(incoming.id);
              setMessages((current) => current.filter((message) => message.id !== incoming.id));
              return;
            }
            setMessages((current) => {
              const withoutOptimistic = current.filter(
                (message) => !(incoming.clientId && message.clientId === incoming.clientId && message.optimistic),
              );
              const currentById = new Map(withoutOptimistic.map((message) => [message.id, message]));
              currentById.set(incoming.id, {
                ...currentById.get(incoming.id),
                ...incoming,
                optimistic: false,
                failed: false,
              });
              return filterMessagesByVisibilityAndDeletedIds(
                sortMessages(Array.from(currentById.values())),
                deletedMessageIdsRef.current,
              );
            });

            if (incoming.senderId !== currentUserId) {
              void markConversationAsRead([incoming]);
            }

            if (incoming.type !== "text" && !incoming.attachment) {
              void loadConversationMessages("realtime-insert-attachment");
            }
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const incoming = normalizeMessageRow(payload.new as MessageRow);
            if (consumeVoiceSignalMessage(incoming)) {
              return;
            }
            if (!isVisibleChatMessage(incoming) || deletedMessageIdsRef.current.has(incoming.id)) {
              registerDeletedMessageId(incoming.id);
              setMessages((current) => current.filter((message) => message.id !== incoming.id));
              return;
            }

            setMessages((current) => {
              return filterMessagesByVisibilityAndDeletedIds(
                sortMessages(
                  current.map((message) =>
                    message.id === incoming.id
                      ? {
                          ...message,
                          ...incoming,
                          optimistic: false,
                          failed: false,
                        }
                      : message,
                  ),
                ),
                deletedMessageIdsRef.current,
              );
            });

            if (incoming.type !== "text" && !incoming.attachment) {
              void loadConversationMessages("realtime-update-attachment");
            }
          },
        )
        .on(
          "broadcast",
          {
            event: "voice-signal",
          },
          (payload) => {
            const raw = payload.payload as Partial<VoiceCallSignalPayload> | null;
            if (!raw || Number(raw.version ?? 0) !== 1) {
              return;
            }
            const action = String(raw.action ?? "").trim();
            if (action !== "invite" && action !== "cancel") {
              return;
            }
            const senderUserId = String(raw.senderUserId ?? "").trim();
            const localUserId = String(currentUser.userId ?? "").trim() || String(currentUserId ?? "").trim();
            if (!senderUserId || senderUserId === localUserId) {
              return;
            }

            if (action === "invite") {
              const sentAt = Number(raw.sentAt ?? 0);
              if (!shouldProcessVoiceSignal(senderUserId, sentAt)) {
                return;
              }
              if (!isVoiceCallActiveRef.current && !isVoiceCallConnectingRef.current) {
                applyIncomingVoiceInviteState(senderUserId, String(raw.roomId ?? "").trim() || voiceRoomId, sentAt);
              }
              return;
            }

            const sentAt = Number(raw.sentAt ?? 0);
            if (!shouldProcessVoiceSignal(senderUserId, sentAt)) {
              return;
            }

            if (incomingVoiceInviteFromUserIdRef.current === senderUserId) {
              clearIncomingVoiceInviteState();
            }
            clearVoiceCallRejoinFallbackForUser(senderUserId);
            if (isVoiceCallConnectingRef.current && !hadRemoteParticipantInSessionRef.current) {
              void stopVoiceCallSessionRef.current?.();
            }
          },
        )
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setLoadError("Reconectando realtime...");
            void loadConversationMessages("realtime-reconnect");
          }
        });
      dmRealtimeChannelRef.current = channel;
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(bootstrapTimer);
      if (channel) {
        if (dmRealtimeChannelRef.current === channel) {
          dmRealtimeChannelRef.current = null;
        }
        void supabase.removeChannel(channel);
      }
    };
  }, [
    consumeVoiceSignalMessage,
    conversationId,
    clearIncomingVoiceInviteState,
    applyIncomingVoiceInviteState,
    clearVoiceCallRejoinFallbackForUser,
    currentUser.userId,
    currentUserId,
    loadConversationMessages,
    markConversationAsRead,
    registerDeletedMessageId,
    shouldProcessVoiceSignal,
    voiceRoomId,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const currentMessageCount = messages.length;
    if (currentMessageCount === 0) {
      previousMessageCountRef.current = 0;
      previousTailMessageIdRef.current = null;
      isNearBottomRef.current = true;
      return;
    }

    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      previousMessageCountRef.current = currentMessageCount;
      previousTailMessageIdRef.current = messages[currentMessageCount - 1]?.id ?? null;
      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
      forceNextAutoScrollRef.current = false;
      return;
    }

    const latestMessageId = messages[currentMessageCount - 1]?.id ?? null;
    const hadNewMessages =
      currentMessageCount > previousMessageCountRef.current ||
      latestMessageId !== previousTailMessageIdRef.current;
    previousMessageCountRef.current = currentMessageCount;
    previousTailMessageIdRef.current = latestMessageId;

    if (!hadNewMessages) {
      forceNextAutoScrollRef.current = false;
      return;
    }

    const shouldForce = forceNextAutoScrollRef.current;
    const nearBottomBeforeUpdate = isNearBottomRef.current;
    const nearBottomNow = isNearBottom();

    if (shouldForce || nearBottomBeforeUpdate || nearBottomNow) {
      isNearBottomRef.current = true;
      requestAnimationFrame(() => {
        scrollToBottom(false);
      });
      setShowNewMessagesButton(false);
    } else {
      isNearBottomRef.current = false;
      setShowNewMessagesButton(true);
    }

    forceNextAutoScrollRef.current = false;
    requestAnimationFrame(() => {
      updateScrollThumb();
    });
  }, [isNearBottom, messages, scrollToBottom, updateScrollThumb]);

  useEffect(() => {
    if (isInitialConversationLoading || messages.length === 0) {
      return;
    }

    const perf = openPerfRef.current;
    if (perf.conversationId !== conversationId || perf.firstPaintLogged) {
      return;
    }

    perf.firstPaintLogged = true;
    requestAnimationFrame(() => {
      const elapsedMs = performance.now() - perf.openedAt;
      logChatPerf("open:first-paint", {
        conversationId,
        firstPaintMs: Number(elapsedMs.toFixed(1)),
        messageCount: messages.length,
      });
    });
  }, [conversationId, isInitialConversationLoading, messages.length]);

  useEffect(() => {
    if (!highlightMessageId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setHighlightMessageId(null);
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [highlightMessageId]);

  useEffect(() => {
    clearOutgoingVoiceRingTimer();
    clearSingleParticipantTimer();
    clearIncomingVoiceInviteTimer();
    clearRejoinFallbackTimer();
    setHeaderSearchValue("");
    setHeaderSearchIndex(-1);
    setIsVoiceCallActive(false);
    setIsVoiceCallConnecting(false);
    setVoiceCallUiState("IDLE");
    setVoiceCallParticipants([]);
    setVoiceCallDiagnostics([]);
    setVoiceCallConnectionState("idle");
    setVoiceCallError(null);
    setVoiceCallStartedAtMs(null);
    setVoiceCallElapsedTick(0);
    setIncomingVoiceInviteFromUserId(null);
    setIncomingVoiceInviteRoomId(null);
    setIncomingVoiceInviteExpiresAtMs(null);
    setVoiceCallRejoinFallback(null);
    voiceSignalMessageIdsRef.current.clear();
    latestVoiceSignalBySenderRef.current.clear();
    voiceCallParticipantsRef.current = [];
    activeVoiceRoomIdRef.current = voiceRoomId;
    activeVoiceSessionTokenRef.current = null;
    hadRemoteParticipantInSessionRef.current = false;

    const existingVoiceCallClient = voiceCallClientRef.current;
    voiceCallClientRef.current = null;
    if (existingVoiceCallClient) {
      void existingVoiceCallClient.leave();
    }
    const existingVoicePresenceClient = voicePresenceClientRef.current;
    voicePresenceClientRef.current = null;
    if (existingVoicePresenceClient) {
      void existingVoicePresenceClient.stop();
    }
  }, [
    clearIncomingVoiceInviteTimer,
    clearOutgoingVoiceRingTimer,
    clearRejoinFallbackTimer,
    clearSingleParticipantTimer,
    conversationId,
    voiceRoomId,
  ]);

  useEffect(() => {
    return () => {
      clearOutgoingVoiceRingTimer();
      clearSingleParticipantTimer();
      clearIncomingVoiceInviteTimer();
      clearRejoinFallbackTimer();
      const existingVoiceCallClient = voiceCallClientRef.current;
      voiceCallClientRef.current = null;
      const existingVoicePresenceClient = voicePresenceClientRef.current;
      voicePresenceClientRef.current = null;
      activeVoiceSessionTokenRef.current = null;
      if (existingVoiceCallClient) {
        void existingVoiceCallClient.leave();
      }
      if (existingVoicePresenceClient) {
        void existingVoicePresenceClient.stop();
      }
    };
  }, [clearIncomingVoiceInviteTimer, clearOutgoingVoiceRingTimer, clearRejoinFallbackTimer, clearSingleParticipantTimer]);

  useEffect(() => {
    if (!isVoiceCallActive || !voiceCallStartedAtMs) {
      return;
    }

    const timerId = window.setInterval(() => {
      setVoiceCallElapsedTick((current) => current + 1);
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isVoiceCallActive, voiceCallStartedAtMs]);

  useEffect(() => {
    if (isVoiceCallActive || isVoiceCallConnecting) {
      clearIncomingVoiceInviteState();
    }
  }, [clearIncomingVoiceInviteState, isVoiceCallActive, isVoiceCallConnecting]);

  useEffect(() => {
    const hasTransientVoiceUi =
      isVoiceCallActive ||
      isVoiceCallConnecting ||
      Boolean(incomingVoiceInviteFromUserId) ||
      Boolean(voiceCallRejoinFallback && voiceCallRejoinFallback.expiresAtMs > Date.now());
    if (hasTransientVoiceUi) {
      return;
    }
    if (voiceCallUiState === "IDLE") {
      return;
    }
    const timerId = window.setTimeout(() => {
      setVoiceCallUiState("IDLE");
    }, voiceCallUiState === "ENDED" ? 220 : 0);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    incomingVoiceInviteFromUserId,
    isVoiceCallActive,
    isVoiceCallConnecting,
    voiceCallRejoinFallback,
    voiceCallUiState,
  ]);

  useEffect(() => {
    if (!normalizedHeaderSearchValue) {
      setHeaderSearchIndex(-1);
      return;
    }

    if (headerSearchMatchIds.length === 0) {
      setHeaderSearchIndex(-1);
      return;
    }

    if (headerSearchIndex >= headerSearchMatchIds.length) {
      setHeaderSearchIndex(headerSearchMatchIds.length - 1);
    }
  }, [headerSearchIndex, headerSearchMatchIds.length, normalizedHeaderSearchValue]);

  useEffect(() => {
    if (!mediaViewerState) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseMediaViewer();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        handleMediaViewerStep(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handleMediaViewerStep(-1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCloseMediaViewer, handleMediaViewerStep, mediaViewerState]);

  useEffect(() => {
    let isActive = true;
    const pending = messages
      .filter((message) => isAttachmentMessage(message) && isVisibleChatMessage(message))
      .filter((message) => {
        const fullMissing = !attachmentUrlMap[message.id];
        const thumbKey = message.attachment?.thumbKey || null;
        const thumbMissing = Boolean(thumbKey) && !attachmentThumbUrlMap[message.id];
        return fullMissing || thumbMissing;
      })
      .slice(-24);
    if (pending.length === 0) {
      return () => {};
    }

    const resolveAttachments = async (): Promise<void> => {
      const fullUpdates: Record<string, string> = {};
      const thumbUpdates: Record<string, string> = {};
      await Promise.allSettled(
        pending.flatMap((message) => {
          const tasks: Array<Promise<void>> = [];
          const fullKey = message.attachment?.fileKey || message.content;
          const thumbKey = message.attachment?.thumbKey || null;

          if (!attachmentUrlMap[message.id] && fullKey) {
            tasks.push(
              getAttachmentUrl(fullKey).then((resolvedFull) => {
                if (resolvedFull) {
                  fullUpdates[message.id] = resolvedFull;
                }
              }),
            );
          }

          if (thumbKey && !attachmentThumbUrlMap[message.id]) {
            tasks.push(
              getAttachmentUrl(thumbKey).then((resolvedThumb) => {
                if (resolvedThumb) {
                  thumbUpdates[message.id] = resolvedThumb;
                }
              }),
            );
          }

          return tasks;
        }),
      );

      if (!isActive) {
        return;
      }

      if (Object.keys(fullUpdates).length > 0) {
        setAttachmentUrlMap((current) => ({ ...current, ...fullUpdates }));
      }

      if (Object.keys(thumbUpdates).length > 0) {
        setAttachmentThumbUrlMap((current) => ({ ...current, ...thumbUpdates }));
      }
    };

    void resolveAttachments();

    return () => {
      isActive = false;
    };
  }, [attachmentThumbUrlMap, attachmentUrlMap, messages]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    updateScrollThumb();
    setVirtualViewportHeight(container.clientHeight);
    setVirtualScrollTop(container.scrollTop);

    const handleResize = (): void => {
      updateScrollThumb();
      const liveContainer = scrollContainerRef.current;
      if (!liveContainer) {
        return;
      }
      setVirtualViewportHeight(liveContainer.clientHeight);
      setVirtualScrollTop(liveContainer.scrollTop);
    };

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [updateScrollThumb]);

  const handleMessagesScroll = useCallback((): void => {
    updateScrollThumb();

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    setVirtualScrollTop(container.scrollTop);
    setVirtualViewportHeight(container.clientHeight);
    if (virtualFocusIndex !== null) {
      setVirtualFocusIndex(null);
    }
    pendingVirtualScrollMessageIdRef.current = null;

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceToBottom <= AUTO_SCROLL_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;

    if (nearBottom) {
      setShowNewMessagesButton(false);
      if (
        hasTrimmedNewerMessages &&
        !isLoadingOlderRef.current &&
        !isRestoringTrimmedWindowRef.current
      ) {
        isRestoringTrimmedWindowRef.current = true;
        void loadConversationMessages("window-restore-latest").finally(() => {
          isRestoringTrimmedWindowRef.current = false;
        });
      }
    }

    if (container.scrollTop <= LOAD_OLDER_THRESHOLD_PX && hasMoreBefore && !isLoadingOlderRef.current) {
      void loadOlderMessages();
    }
  }, [
    hasMoreBefore,
    hasTrimmedNewerMessages,
    loadConversationMessages,
    loadOlderMessages,
    updateScrollThumb,
    virtualFocusIndex,
  ]);

  const scrollToMessageById = useCallback(
    (messageId: string): void => {
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }

      const anchorMessageId = messageRenderData.hiddenMessageAnchorMap.get(messageId) ?? messageId;
      const element =
        messageRefs.current.get(anchorMessageId) ??
        (container.querySelector(`[data-message-id="${anchorMessageId}"]`) as HTMLElement | null);

      if (!element) {
        let anchorMessageVisibleIndex = -1;
        let visibleCursor = 0;
        for (const entry of messageRenderData.entries) {
          if (entry.skipRender || !isVisibleChatMessage(entry.message)) {
            continue;
          }
          if (entry.message.id === anchorMessageId) {
            anchorMessageVisibleIndex = visibleCursor;
            break;
          }
          visibleCursor += 1;
        }

        if (
          anchorMessageVisibleIndex >= 0 &&
          pendingVirtualScrollMessageIdRef.current !== anchorMessageId
        ) {
          pendingVirtualScrollMessageIdRef.current = anchorMessageId;
          setVirtualFocusIndex(anchorMessageVisibleIndex);
          requestAnimationFrame(() => {
            scrollToMessageById(messageId);
          });
          return;
        }

        pendingVirtualScrollMessageIdRef.current = null;
        setLoadError("Mensagem nao encontrada.");
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const targetOffset = elementRect.top - containerRect.top + container.scrollTop - 12;

      gsap.killTweensOf(container);
      gsap.to(container, {
        scrollTo: { y: targetOffset },
        duration: SCROLL_TO_BOTTOM_DURATION_S,
        ease: "power2.out",
        overwrite: "auto",
        onUpdate: updateScrollThumb,
        onComplete: updateScrollThumb,
      });

      pendingVirtualScrollMessageIdRef.current = null;
      setHighlightMessageId(anchorMessageId);
      setVirtualFocusIndex(null);
    },
    [messageRenderData.entries, messageRenderData.hiddenMessageAnchorMap, updateScrollThumb],
  );

  const handleHeaderSearchStep = useCallback(
    (direction: 1 | -1): void => {
      if (!normalizedHeaderSearchValue || headerSearchMatchIds.length === 0) {
        return;
      }

      const total = headerSearchMatchIds.length;
      const nextIndex = headerSearchIndex < 0
        ? (direction > 0 ? 0 : total - 1)
        : (headerSearchIndex + direction + total) % total;

      setHeaderSearchIndex(nextIndex);
      const targetMessageId = headerSearchMatchIds[nextIndex];
      if (targetMessageId) {
        scrollToMessageById(targetMessageId);
      }
    },
    [headerSearchIndex, headerSearchMatchIds, normalizedHeaderSearchValue, scrollToMessageById],
  );

  const handleInlineMediaLoaded = useCallback((): void => {
    if (isLoadingOlderRef.current) {
      return;
    }

    const shouldStickToBottom = forceNextAutoScrollRef.current || isNearBottomRef.current;
    if (!shouldStickToBottom) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToBottom(true);
    });
  }, [scrollToBottom]);

  const canEditMessage = useCallback(
    (message: ChatMessageItem): boolean => {
      if (message.senderId !== currentUserId) {
        return false;
      }
      if (message.optimistic || message.failed) {
        return false;
      }
      if (message.deletedAt) {
        return false;
      }
      return message.type === "text";
    },
    [currentUserId],
  );

  const canDeleteMessage = useCallback(
    (message: ChatMessageItem): boolean => {
      if (message.senderId !== currentUserId) {
        return false;
      }
      if (message.optimistic || message.failed) {
        return false;
      }
      if (message.deletedAt) {
        return false;
      }
      return true;
    },
    [currentUserId],
  );

  const buildReplySnapshot = useCallback(
    (target: ReplyTarget): ReplySnapshot => ({
      author_id: target.authorId,
      author_name: target.authorName,
      author_avatar: target.authorAvatar ?? null,
      snippet: truncateSnippet(getReplySnippet({ content: target.content, type: target.type, deletedAt: null })),
      message_type: target.type,
      created_at: target.createdAt,
    }),
    [],
  );

  const resolveReplyPreview = useCallback(
    (message: ChatMessageItem): ReplySnapshot | null => {
      if (message.replyToId) {
        const original = messagesById.get(message.replyToId);
        if (original) {
          const participant = getParticipantById(original.senderId);
          return {
            author_id: original.senderId,
            author_name: participant.displayName,
            author_avatar: (participant.avatarSrc || "").trim() || null,
            snippet: truncateSnippet(getReplySnippet(original)),
            message_type: original.type,
            created_at: original.createdAt,
          };
        }

        if (deletedMessageIds.has(message.replyToId)) {
          const snapshotAuthorId = String(message.replyToSnapshot?.author_id ?? "").trim();
          const snapshotAuthorName = String(message.replyToSnapshot?.author_name ?? "").trim();
          const snapshotAuthorAvatar = String(message.replyToSnapshot?.author_avatar ?? "").trim() || null;
          const snapshotCreatedAt = String(message.replyToSnapshot?.created_at ?? "").trim() || null;

          const participant = snapshotAuthorId ? getParticipantById(snapshotAuthorId) : null;
          const participantName = participant ? participant.displayName : "";
          const participantAvatar = participant ? (participant.avatarSrc || "").trim() : "";

          return {
            author_id: snapshotAuthorId,
            author_name: participantName || snapshotAuthorName || "Mensagem excluida",
            author_avatar: participantAvatar || snapshotAuthorAvatar,
            snippet: "A mensagem original foi excluida",
            message_type: "deleted",
            created_at: snapshotCreatedAt,
          };
        }
      }

      if (message.replyToSnapshot) {
        return message.replyToSnapshot;
      }

      if (message.replyToId) {
        return {
          author_id: "",
          author_name: "Mensagem excluida",
          author_avatar: null,
          snippet: "A mensagem original foi excluida",
          message_type: "deleted",
          created_at: null,
        };
      }

      return null;
    },
    [deletedMessageIds, getParticipantById, messagesById],
  );

  const uploadDraftAttachment = useCallback(
    async (attachment: DraftAttachmentItem): Promise<UploadedAttachmentResult> => {
      const setAttachmentProgress = (ratio: number): void => {
        setDraftAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  uploadProgress: Math.max(0, Math.min(1, ratio)),
                  uploadError: null,
                }
              : item,
          ),
        );
      };

      const uploadBlob = async (
        fileToUpload: File,
        key: string,
        onProgress?: (ratio: number) => void,
      ): Promise<void> => {
        await uploadAttachmentBlob({
          conversationId,
          file: fileToUpload,
          key,
          contentType: fileToUpload.type || "application/octet-stream",
          retries: 3,
          timeoutMs: 55_000,
          onProgress,
        });
      };

      try {
        const prepared = await prepareAttachmentUpload(attachment.file, conversationId);
        await uploadBlob(prepared.uploadFile, prepared.fileKey, (ratio) => {
          setAttachmentProgress(ratio * 0.78);
        });

        if (prepared.thumbFile && prepared.thumbKey) {
          await uploadBlob(prepared.thumbFile, prepared.thumbKey, (ratio) => {
            setAttachmentProgress(0.78 + ratio * 0.14);
          });
        }

        if (prepared.originalFile && prepared.originalKey) {
          await uploadBlob(prepared.originalFile, prepared.originalKey, (ratio) => {
            setAttachmentProgress(0.92 + ratio * 0.08);
          });
        }

        const publicUrl = await getAttachmentUrl(prepared.fileKey);
        const thumbUrl = prepared.thumbKey ? await getAttachmentUrl(prepared.thumbKey) : null;
        setAttachmentProgress(1);

        return {
          fileKey: prepared.fileKey,
          originalKey: prepared.originalKey ?? null,
          thumbKey: prepared.thumbKey ?? null,
          mimeType: prepared.mimeType,
          fileSize: prepared.fileSize,
          width: prepared.width,
          height: prepared.height,
          thumbWidth: prepared.thumbWidth,
          thumbHeight: prepared.thumbHeight,
          codec: prepared.codec,
          durationMs: prepared.durationMs,
          messageType: prepared.kind,
          publicUrl,
          thumbUrl,
        };
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("[chat] attachment upload failed", error);
        }
        setDraftAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  uploadError: getSafeDraftAttachmentUploadErrorMessage(error),
                }
              : item,
          ),
        );
        incrementMetric("chat_attachment_upload_failed_total", 1);
        reportClientError(error, {
          scope: "chat.uploadDraftAttachment",
          conversationId,
        });
        throw error;
      }
    },
    [conversationId],
  );

  const insertMessage = useCallback(
    async (
      content: string,
      type: ChatMessageItem["type"],
      clientId: string,
      replyPayload?: { replyToId?: string | null; replyToSnapshot?: ReplySnapshot | null },
      attachmentMetadata?: ChatAttachmentMetadata | null,
    ): Promise<ChatMessageItem> => {
      const startedAt = Date.now();
      const serverMessage = await sendChatMessage({
        conversationId,
        clientId,
        type: type === "image" || type === "video" || type === "file" ? type : "text",
        content,
        replyToId: replyPayload?.replyToId ?? null,
        replyToSnapshot: replyPayload?.replyToSnapshot ?? null,
        attachment: attachmentMetadata ?? null,
      });
      recordLatency("chat_send_message", startedAt);
      return normalizeServerMessage(serverMessage);
    },
    [conversationId],
  );

  const submitMessage = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    const attachmentsToSend = [...draftAttachments];
    if ((content.length === 0 && attachmentsToSend.length === 0) || isSending) {
      return;
    }

    forceNextAutoScrollRef.current = true;
    shouldAutoScrollAfterSendRef.current = true;
    setLoadError(null);
    setIsSending(true);
    const replyPayload = replyTarget
      ? {
          replyToId: replyTarget.id,
          replyToSnapshot: buildReplySnapshot(replyTarget),
        }
      : null;

    if (replyTarget) {
      setReplyTarget(null);
    }

    let textClientId: string | null = null;

    if (content.length > 0) {
      textClientId = createClientMessageId();
      const optimisticMessage: ChatMessageItem = {
        id: `optimistic:${textClientId}`,
        conversationId,
        senderId: currentUserId,
        clientId: textClientId,
        content,
        type: "text",
        createdAt: new Date().toISOString(),
        replyToId: replyPayload?.replyToId ?? null,
        replyToSnapshot: replyPayload?.replyToSnapshot ?? null,
        optimistic: true,
        sendAttemptCount: 1,
      };
      setDraft("");
      setMessages((current) => sortMessages([...current, optimisticMessage]));
      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
    }

    try {
      if (content.length > 0 && textClientId) {
        const serverMessage = await insertMessage(content, "text", textClientId, replyPayload ?? undefined);
        setMessages((current) => {
          const withoutOptimistic = current.filter((message) => !(message.clientId === textClientId && message.optimistic));
          const nextMessages = upsertMessages(withoutOptimistic, [serverMessage]);
          return nextMessages;
        });
        void markConversationAsRead([serverMessage]);
      }

      if (attachmentsToSend.length > 0) {
        const settledAttachments = await Promise.allSettled(
          attachmentsToSend.map(async (attachment) => {
            const uploadedAttachment = await uploadDraftAttachment(attachment);
            const attachmentClientId = createClientMessageId();
            const attachmentMessage = await insertMessage(
              uploadedAttachment.fileKey,
              uploadedAttachment.messageType,
              attachmentClientId,
              replyPayload ?? undefined,
              {
                fileKey: uploadedAttachment.fileKey,
                originalKey: uploadedAttachment.originalKey ?? null,
                thumbKey: uploadedAttachment.thumbKey ?? null,
                mimeType: uploadedAttachment.mimeType ?? null,
                fileSize: uploadedAttachment.fileSize ?? null,
                width: uploadedAttachment.width ?? null,
                height: uploadedAttachment.height ?? null,
                thumbWidth: uploadedAttachment.thumbWidth ?? null,
                thumbHeight: uploadedAttachment.thumbHeight ?? null,
                codec: uploadedAttachment.codec ?? null,
                durationMs: uploadedAttachment.durationMs ?? null,
              },
            );
            return {
              attachment,
              uploadedAttachment,
              attachmentMessage,
            };
          }),
        );

        const successfulAttachments = settledAttachments.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failedAttachmentCount = settledAttachments.length - successfulAttachments.length;

        if (successfulAttachments.length > 0) {
          const nextAttachmentMessages = successfulAttachments.map((item) => item.attachmentMessage);
          setMessages((current) => upsertMessages(current, nextAttachmentMessages));

          setAttachmentUrlMap((current) => {
            const nextMap = { ...current };
            for (const item of successfulAttachments) {
              if (item.uploadedAttachment.publicUrl) {
                nextMap[item.attachmentMessage.id] = item.uploadedAttachment.publicUrl;
              }
            }
            return nextMap;
          });

          setAttachmentThumbUrlMap((current) => {
            const nextMap = { ...current };
            for (const item of successfulAttachments) {
              if (item.uploadedAttachment.thumbUrl) {
                nextMap[item.attachmentMessage.id] = item.uploadedAttachment.thumbUrl;
              }
            }
            return nextMap;
          });

          const successfulAttachmentIds = new Set(successfulAttachments.map((item) => item.attachment.id));
          setDraftAttachments((current) => {
            current.forEach((attachment) => {
              if (successfulAttachmentIds.has(attachment.id)) {
                revokeDraftAttachment(attachment);
              }
            });
            return current.filter((attachment) => !successfulAttachmentIds.has(attachment.id));
          });

          requestAnimationFrame(() => {
            scrollToBottom(true);
          });
        }

        if (failedAttachmentCount > 0) {
          setLoadError(
            failedAttachmentCount === 1
              ? "Nao foi possivel enviar 1 anexo."
              : `Nao foi possivel enviar ${failedAttachmentCount} anexos.`,
          );
        }
      }
    } catch (error) {
      if (textClientId) {
        setMessages((current) =>
          current.map((message) =>
            message.clientId === textClientId && message.optimistic
              ? {
                  ...message,
                  optimistic: false,
                  failed: true,
                  sendAttemptCount: Number(message.sendAttemptCount ?? 0) + 1,
                }
              : message,
          ),
        );
      }

      reportClientError(error, {
        scope: "chat.submitMessage",
        conversationId,
      });
      setLoadError(error instanceof Error ? error.message : "Nao foi possivel enviar a mensagem.");
    } finally {
      setIsSending(false);
    }
  }, [
    conversationId,
    currentUserId,
    draft,
    draftAttachments,
    buildReplySnapshot,
    insertMessage,
    isSending,
    markConversationAsRead,
    replyTarget,
    scrollToBottom,
    uploadDraftAttachment,
  ]);

  useEffect(() => {
    if (isSending || !shouldAutoScrollAfterSendRef.current) {
      return;
    }

    shouldAutoScrollAfterSendRef.current = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
    });
  }, [isSending, scrollToBottom]);

  useEffect(() => {
    if (!isSending || uploadingAttachmentsCount <= 0) {
      return;
    }

    forceNextAutoScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollToBottom(true);
    });
  }, [isSending, scrollToBottom, uploadingAttachmentsCount]);

  const handleRetryFailedMessage = useCallback(
    async (message: ChatMessageItem): Promise<void> => {
      if (!message.failed || message.type !== "text") {
        return;
      }

      const retryClientId = createClientMessageId();
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
                ...item,
                id: `optimistic:${retryClientId}`,
                clientId: retryClientId,
                optimistic: true,
                failed: false,
                sendAttemptCount: Number(item.sendAttemptCount ?? 0) + 1,
                createdAt: new Date().toISOString(),
              }
            : item,
        ),
      );

      try {
        const resent = await insertMessage(
          message.content,
          "text",
          retryClientId,
          message.replyToId || message.replyToSnapshot
            ? {
                replyToId: message.replyToId ?? null,
                replyToSnapshot: message.replyToSnapshot ?? null,
              }
            : undefined,
        );

        setMessages((current) => {
          const withoutOptimistic = current.filter((item) => !(item.clientId === retryClientId && item.optimistic));
          return upsertMessages(withoutOptimistic, [resent]);
        });
      } catch (error) {
        reportClientError(error, {
          scope: "chat.retryFailedMessage",
          messageId: message.id,
        });

        setMessages((current) =>
          current.map((item) =>
            item.clientId === retryClientId
              ? {
                  ...item,
                  optimistic: false,
                  failed: true,
                }
              : item,
          ),
        );
      }
    },
    [insertMessage],
  );

  const handleStartEdit = useCallback(
    (message: ChatMessageItem): void => {
      if (!canEditMessage(message)) {
        return;
      }
      setEditingMessageId(message.id);
      setEditingValue(message.content);
      setLoadError(null);
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    },
    [canEditMessage],
  );

  const handleCancelEdit = useCallback((): void => {
    setEditingMessageId(null);
    setEditingValue("");
    setIsSavingEdit(false);
  }, []);

  const adjustEditTextareaHeight = useCallback((element?: HTMLTextAreaElement | null): void => {
    const target = element ?? editInputRef.current;
    if (!target) {
      return;
    }
    target.style.height = "0px";
    const nextHeight = Math.max(target.scrollHeight, 24);
    target.style.height = `${nextHeight}px`;
  }, []);

  const handleSaveEdit = useCallback(async (): Promise<void> => {
    if (isSavingEdit) {
      return;
    }
    if (!editingMessageId) {
      return;
    }
    const original = messages.find((message) => message.id === editingMessageId);
    if (!original) {
      handleCancelEdit();
      return;
    }

    const trimmed = editingValue.trim();
    if (!trimmed) {
      setLoadError("A mensagem nao pode ficar vazia.");
      return;
    }

    if (trimmed === original.content.trim()) {
      handleCancelEdit();
      return;
    }

    const optimisticEditedAt = new Date().toISOString();
    setIsSavingEdit(true);
    setMessages((current) =>
      current.map((message) =>
        message.id === editingMessageId
          ? {
              ...message,
              content: trimmed,
              editedAt: optimisticEditedAt,
            }
          : message,
      ),
    );

    try {
      const updated = normalizeServerMessage(await editChatMessage(editingMessageId, trimmed));
      setMessages((current) =>
        current.map((message) => (message.id === updated.id ? { ...message, ...updated } : message)),
      );

      setEditingMessageId(null);
      setEditingValue("");
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === original.id ? { ...message, content: original.content, editedAt: original.editedAt ?? null } : message,
        ),
      );
      reportClientError(error, {
        scope: "chat.editMessage",
        messageId: editingMessageId,
      });
      setLoadError(error instanceof Error ? error.message : "Nao foi possivel editar a mensagem.");
    } finally {
      setIsSavingEdit(false);
    }
  }, [editingMessageId, editingValue, handleCancelEdit, isSavingEdit, messages]);

  useEffect(() => {
    if (!editingMessageId) {
      return;
    }
    requestAnimationFrame(() => {
      adjustEditTextareaHeight();
    });
  }, [adjustEditTextareaHeight, editingMessageId, editingValue]);

  const handleConfirmDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget) {
      return;
    }
    if (!canDeleteMessage(deleteTarget)) {
      setDeleteTarget(null);
      return;
    }

    const targetId = deleteTarget.id;
    const deleteTargetSnapshot = deleteTarget;
    const snapshot = messages;
    if (deletingMessageIds.has(targetId)) {
      return;
    }
    const alreadyKnownAsDeleted = deletedMessageIds.has(targetId);
    setDeletingMessageIds((current) => {
      const next = new Set(current);
      next.add(targetId);
      return next;
    });
    setDeleteTarget(null);
    registerDeletedMessageId(targetId);
    setMessages((current) => current.filter((message) => message.id !== targetId));

    try {
      await deleteChatMessage(targetId);
      setAttachmentUrlMap((current) => {
        const next = { ...current };
        delete next[targetId];
        return next;
      });
      setAttachmentThumbUrlMap((current) => {
        const next = { ...current };
        delete next[targetId];
        return next;
      });
    } catch (error) {
      setMessages(snapshot);
      if (!alreadyKnownAsDeleted) {
        setDeletedMessageIds((current) => {
          const next = new Set(current);
          next.delete(targetId);
          deletedMessageIdsRef.current = next;
          return next;
        });
      }
      reportClientError(error, {
        scope: "chat.deleteMessage",
        messageId: targetId,
      });
      setDeleteTarget(deleteTargetSnapshot);
      setLoadError(error instanceof Error ? error.message : "Nao foi possivel excluir a mensagem.");
    } finally {
      setDeletingMessageIds((current) => {
        if (!current.has(targetId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  }, [canDeleteMessage, deleteTarget, deletedMessageIds, deletingMessageIds, messages, registerDeletedMessageId]);

  const handlePickAttachments = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const pickedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (pickedFiles.length === 0) {
      return;
    }

    setLoadError(null);
    setDraftAttachments((current) => [...current, ...pickedFiles.map((file) => createDraftAttachment(file))]);
    requestAnimationFrame(() => {
      draftInputRef.current?.focus();
    });
  }, []);

  const handleStartReply = useCallback(
    (message: ChatMessageItem): void => {
      if (message.optimistic || message.failed) {
        return;
      }
      const participant = getParticipantById(message.senderId);
      setReplyTarget({
        id: message.id,
        authorId: message.senderId,
        authorName: participant.displayName,
        authorAvatar: (participant.avatarSrc || "").trim() || null,
        content: message.content,
        type: message.type,
        createdAt: message.createdAt,
      });
      requestAnimationFrame(() => {
        draftInputRef.current?.focus();
      });
    },
    [getParticipantById],
  );

  const resolveRenderedAttachmentUrl = useCallback(
    (message: ChatMessageItem): string =>
      attachmentUrlMap[message.id] ?? resolveInlineAttachmentUrl(message.attachment?.fileKey ?? message.content),
    [attachmentUrlMap],
  );

  const resolveRenderedAttachmentThumbUrl = useCallback(
    (message: ChatMessageItem): string =>
      attachmentThumbUrlMap[message.id] ??
      attachmentUrlMap[message.id] ??
      resolveInlineAttachmentUrl(message.attachment?.thumbKey ?? message.attachment?.fileKey ?? message.content),
    [attachmentThumbUrlMap, attachmentUrlMap],
  );

  const messageRenderEntries = useMemo(
    () => messageRenderData.entries.filter((entry) => !entry.skipRender && isVisibleChatMessage(entry.message)),
    [messageRenderData.entries],
  );
  const virtualViewportHeightSafe = virtualViewportHeight > 0 ? virtualViewportHeight : 720;
  const virtualVisibleRows = Math.max(
    MESSAGE_VIRTUAL_MIN_ROWS,
    Math.ceil(virtualViewportHeightSafe / MESSAGE_VIRTUAL_ESTIMATED_ROW_HEIGHT) + MESSAGE_VIRTUAL_OVERSCAN * 2,
  );
  const virtualStartIndex = useMemo(() => {
    const total = messageRenderEntries.length;
    if (total <= virtualVisibleRows) {
      return 0;
    }

    if (typeof virtualFocusIndex === "number" && virtualFocusIndex >= 0 && virtualFocusIndex < total) {
      const centeredStart = Math.max(virtualFocusIndex - Math.floor(virtualVisibleRows / 2), 0);
      return Math.min(centeredStart, Math.max(total - virtualVisibleRows, 0));
    }

    const estimatedStart = Math.max(
      Math.floor(virtualScrollTop / MESSAGE_VIRTUAL_ESTIMATED_ROW_HEIGHT) - MESSAGE_VIRTUAL_OVERSCAN,
      0,
    );
    return Math.min(estimatedStart, Math.max(total - virtualVisibleRows, 0));
  }, [messageRenderEntries.length, virtualFocusIndex, virtualScrollTop, virtualVisibleRows]);
  const virtualEndIndex = Math.min(messageRenderEntries.length, virtualStartIndex + virtualVisibleRows);
  const virtualTopSpacerHeight = virtualStartIndex * MESSAGE_VIRTUAL_ESTIMATED_ROW_HEIGHT;
  const virtualBottomSpacerHeight = Math.max(
    (messageRenderEntries.length - virtualEndIndex) * MESSAGE_VIRTUAL_ESTIMATED_ROW_HEIGHT,
    0,
  );
  const visibleMessageRenderEntries = useMemo(
    () => messageRenderEntries.slice(virtualStartIndex, virtualEndIndex),
    [messageRenderEntries, virtualEndIndex, virtualStartIndex],
  );
  const isLoadingMessages = isInitialConversationLoading;
  const shouldShowMessagesSkeleton = !loadError && isLoadingMessages && messages.length === 0;
  const composerPlaceholder = `Conversar com @${safeTargetUsername}`;
  const currentViewerItem = mediaViewerState ? mediaViewerState.items[mediaViewerState.index] ?? null : null;
  const shouldShowSidebarProfileMetaCard = Boolean(targetAboutText) || Boolean(targetMemberSinceLabel);
  const targetMemberSinceLabelForFullProfile = targetMemberSinceLabel || "Data nao disponivel";
  const isDeletingCurrentDeleteTarget = Boolean(deleteTarget && deletingMessageIds.has(deleteTarget.id));
  const handleDownloadViewerMedia = useCallback((): void => {
    if (!currentViewerItem) {
      return;
    }
    const downloadableUrl = currentViewerItem.fullUrl || currentViewerItem.previewUrl;
    if (!downloadableUrl) {
      return;
    }
    const link = document.createElement("a");
    link.href = downloadableUrl;
    link.download = getFileNameFromUrl(downloadableUrl) || `midia-${Date.now()}`;
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [currentViewerItem]);

  const handleOpenViewerMediaInBrowser = useCallback((): void => {
    if (!currentViewerItem) {
      return;
    }
    const externalUrl = currentViewerItem.fullUrl || currentViewerItem.previewUrl;
    if (!externalUrl) {
      return;
    }
    const openExternalUrl = window.electronAPI?.openExternalUrl;
    if (openExternalUrl) {
      void openExternalUrl({ url: externalUrl });
      return;
    }
    window.open(externalUrl, "_blank", "noopener,noreferrer");
  }, [currentViewerItem]);

  const stopVoiceCallSession = useCallback(async (): Promise<void> => {
    const existingVoiceCallClient = voiceCallClientRef.current;
    voiceCallClientRef.current = null;
    clearOutgoingVoiceRingTimer();
    clearSingleParticipantTimer();
    setIsVoiceCallActive(false);
    setIsVoiceCallConnecting(false);
    setVoiceCallUiState("ENDED");
    setVoiceCallParticipants([]);
    setVoiceCallDiagnostics([]);
    setVoiceCallConnectionState("idle");
    setVoiceCallMicWarning(null);
    setVoiceCallStartedAtMs(null);
    setVoiceCallElapsedTick(0);
    clearIncomingVoiceInviteState();
    voiceCallParticipantsRef.current = [];
    activeVoiceSessionTokenRef.current = null;
    hadRemoteParticipantInSessionRef.current = false;
    if (existingVoiceCallClient) {
      await existingVoiceCallClient.leave().catch(() => undefined);
    }
  }, [clearIncomingVoiceInviteState, clearOutgoingVoiceRingTimer, clearSingleParticipantTimer]);

  useEffect(() => {
    stopVoiceCallSessionRef.current = stopVoiceCallSession;
    return () => {
      stopVoiceCallSessionRef.current = null;
    };
  }, [stopVoiceCallSession]);

  const startVoiceCallWithRoomId = useCallback((roomIdOverride?: string | null, options?: { suppressInvite?: boolean; origin?: VoiceCallStartOrigin }) => {
    const suppressInviteSignal = options?.suppressInvite === true;
    const origin: VoiceCallStartOrigin = options?.origin ?? (suppressInviteSignal ? "incoming" : "outgoing");
    const localIdentity: VoiceUserIdentity = {
      userId: String(currentUser.userId ?? "").trim(),
      displayName: String(currentUser.displayName ?? "").trim() || "Voce",
      avatarSrc: String(currentUser.avatarSrc ?? "").trim() || currentFallbackAvatar,
    };
    const remoteIdentity: VoiceUserIdentity = {
      userId: String(targetUser.userId ?? "").trim(),
      displayName: safeTargetDisplayName,
      avatarSrc: targetAvatarSrc,
    };
    const activeVoiceRoomId = String(roomIdOverride ?? voiceRoomId).trim() || voiceRoomId;
    const mediaPreferences = readVoiceCallMediaPreferences(localIdentity.userId);
    activeVoiceRoomIdRef.current = activeVoiceRoomId;
    hadRemoteParticipantInSessionRef.current = false;
    clearIncomingVoiceInviteState();
    clearVoiceCallRejoinFallback();
    clearOutgoingVoiceRingTimer();
    clearSingleParticipantTimer();
    if (!suppressInviteSignal) {
      void sendVoiceSignal("invite", activeVoiceRoomId).catch(() => undefined);
    }

    setVoiceCallError(null);
    setVoiceCallMicWarning(null);
    setIsVoiceCallConnecting(true);
    setVoiceCallUiState("RINGING");
    setVoiceCallConnectionState("connecting");
    setVoiceCallDiagnostics([]);
    const initialParticipants: VoiceParticipantState[] = [
      {
        ...localIdentity,
        isLocal: true,
        muted: isVoiceCallMuted,
        deafened: isVoiceCallDeafened,
        speaking: false,
        speakingLevel: 0,
        connectionState: "connecting",
      },
    ];
    if (remoteIdentity.userId && remoteIdentity.userId !== localIdentity.userId) {
      initialParticipants.push({
        ...remoteIdentity,
        isLocal: false,
        muted: false,
        deafened: false,
        speaking: false,
        speakingLevel: 0,
        connectionState: "connecting",
      });
    }
    setVoiceCallParticipants(initialParticipants);
    voiceCallParticipantsRef.current = initialParticipants;
    const sessionToken = Symbol("voice-call-session");
    activeVoiceSessionTokenRef.current = sessionToken;
    if (origin === "outgoing") {
      outgoingVoiceRingTimerRef.current = window.setTimeout(() => {
        if (activeVoiceSessionTokenRef.current !== sessionToken) {
          return;
        }
        if (hadRemoteParticipantInSessionRef.current) {
          return;
        }
        const timeoutRoomId = String(activeVoiceRoomIdRef.current ?? "").trim() || activeVoiceRoomId;
        void sendVoiceSignal("cancel", timeoutRoomId).catch(() => undefined);
        clearVoiceCallRejoinFallback();
        void stopVoiceCallSession();
      }, VOICE_CALL_RING_TIMEOUT_MS);
    }

    const voiceCallClient = new VoiceCallClient({
      roomId: activeVoiceRoomId,
      self: localIdentity,
      peerDirectory: {
        [remoteIdentity.userId]: remoteIdentity,
      },
      mediaPreferences,
      onParticipantsChanged: (participants) => {
        if (activeVoiceSessionTokenRef.current !== sessionToken) {
          return;
        }

        const normalizedParticipants = participants.map((participant) => ({
          ...participant,
          avatarSrc: String(participant.avatarSrc ?? "").trim() || getNameAvatarUrl(participant.displayName || "U"),
        }));
        const hasRemoteParticipant = normalizedParticipants.some((participant) => !participant.isLocal);
        if (hasRemoteParticipant) {
          hadRemoteParticipantInSessionRef.current = true;
          clearOutgoingVoiceRingTimer();
          clearSingleParticipantTimer();
          setVoiceCallUiState("CONNECTED");
        }

        setVoiceCallParticipants(normalizedParticipants);
        voiceCallParticipantsRef.current = normalizedParticipants;
        const remoteParticipant = normalizedParticipants.find((participant) => !participant.isLocal);
        if (remoteParticipant) {
          setVoiceCallRejoinFallbackWithTtl({
            roomId: activeVoiceRoomId,
            userId: String(remoteParticipant.userId ?? "").trim() || remoteIdentity.userId,
            displayName: String(remoteParticipant.displayName ?? "").trim() || remoteIdentity.displayName,
            avatarSrc: String(remoteParticipant.avatarSrc ?? "").trim() || remoteIdentity.avatarSrc,
          });
          clearSingleParticipantTimer();
        }

        if (!hasRemoteParticipant && hadRemoteParticipantInSessionRef.current && isVoiceCallActiveRef.current) {
          if (singleParticipantTimerRef.current == null) {
            singleParticipantTimerRef.current = window.setTimeout(() => {
              if (activeVoiceSessionTokenRef.current !== sessionToken) {
                return;
              }
              const stillHasRemote = voiceCallParticipantsRef.current.some((participant) => !participant.isLocal);
              if (stillHasRemote) {
                return;
              }
              clearVoiceCallRejoinFallback();
              void stopVoiceCallSession();
            }, VOICE_CALL_SINGLE_PARTICIPANT_TIMEOUT_MS);
          }
        } else {
          clearSingleParticipantTimer();
        }

        const localParticipant = normalizedParticipants.find((participant) => participant.isLocal);
        if (localParticipant) {
          setIsVoiceCallMuted(localParticipant.muted);
          setIsVoiceCallDeafened(localParticipant.deafened);
        }
      },
      onDiagnostics: (snapshot) => {
        setVoiceCallDiagnostics(snapshot.peers);
      },
      onConnectionStateChanged: (state) => {
        setVoiceCallConnectionState(state);
        if (state === "reconnecting") {
          setVoiceCallUiState("RECONNECTING");
          return;
        }
        if (state === "closed") {
          setVoiceCallUiState("ENDED");
          return;
        }
        if (state === "connected" && hadRemoteParticipantInSessionRef.current) {
          setVoiceCallUiState("CONNECTED");
          return;
        }
        if (state === "connecting" && voiceCallUiStateRef.current === "IDLE") {
          setVoiceCallUiState("RINGING");
        }
      },
      onMicrophoneWarningChanged: (warningMessage) => {
        setVoiceCallMicWarning(warningMessage);
      },
      onError: (error) => {
        setVoiceCallError(String(error.message ?? "").trim() || "Falha na chamada de voz.");
      },
    });
    voiceCallClient.setMuted(isVoiceCallMuted);
    voiceCallClient.setDeafened(isVoiceCallDeafened);

    voiceCallClientRef.current = voiceCallClient;
    void voiceCallClient
      .start()
      .then(() => {
        if (voiceCallClientRef.current !== voiceCallClient) {
          return;
        }
        setIsVoiceCallConnecting(false);
        setIsVoiceCallActive(true);
        if (hadRemoteParticipantInSessionRef.current) {
          setVoiceCallUiState("CONNECTED");
        } else {
          setVoiceCallUiState("RINGING");
        }
        setVoiceCallStartedAtMs(Date.now());
        setVoiceCallElapsedTick(0);
        setIsVoiceCallMuted(voiceCallClient.isMuted());
        setIsVoiceCallDeafened(voiceCallClient.isDeafened());
      })
      .catch((error) => {
        if (voiceCallClientRef.current === voiceCallClient) {
          voiceCallClientRef.current = null;
        }
        setVoiceCallError(String(error instanceof Error ? error.message : error ?? "").trim() || "Falha na chamada de voz.");
        clearVoiceCallRejoinFallback();
        void stopVoiceCallSession();
      });
  }, [
    clearOutgoingVoiceRingTimer,
    clearSingleParticipantTimer,
    currentFallbackAvatar,
    currentUser.avatarSrc,
    currentUser.displayName,
    currentUser.userId,
    clearVoiceCallRejoinFallback,
    setVoiceCallRejoinFallbackWithTtl,
    clearIncomingVoiceInviteState,
    safeTargetDisplayName,
    sendVoiceSignal,
    stopVoiceCallSession,
    targetAvatarSrc,
    targetUser.userId,
    isVoiceCallDeafened,
    isVoiceCallMuted,
    voiceRoomId,
  ]);

  const handleToggleVoiceCall = useCallback(() => {
    if (isVoiceCallActive || isVoiceCallConnecting) {
      void sendVoiceSignal("cancel").catch(() => undefined);
      clearVoiceCallRejoinFallback();
      void stopVoiceCallSession();
      return;
    }
    startVoiceCallWithRoomId(null, { origin: "outgoing" });
  }, [
    clearVoiceCallRejoinFallback,
    isVoiceCallActive,
    isVoiceCallConnecting,
    sendVoiceSignal,
    startVoiceCallWithRoomId,
    stopVoiceCallSession,
  ]);

  const handleToggleVoiceMute = useCallback(() => {
    const existingVoiceCallClient = voiceCallClientRef.current;
    if (!existingVoiceCallClient) {
      setIsVoiceCallMuted((current) => !current);
      return;
    }
    existingVoiceCallClient.toggleMuted();
    setIsVoiceCallMuted(existingVoiceCallClient.isMuted());
  }, []);

  const handleToggleVoiceDeafen = useCallback(() => {
    const existingVoiceCallClient = voiceCallClientRef.current;
    if (!existingVoiceCallClient) {
      setIsVoiceCallDeafened((current) => !current);
      return;
    }
    existingVoiceCallClient.toggleDeafened();
    setIsVoiceCallDeafened(existingVoiceCallClient.isDeafened());
  }, []);

  useEffect(() => {
    return subscribeVoiceCallUiCommand((command) => {
      if (command === "toggle-mute") {
        handleToggleVoiceMute();
        return;
      }
      if (command === "toggle-deafen") {
        handleToggleVoiceDeafen();
      }
    });
  }, [handleToggleVoiceDeafen, handleToggleVoiceMute]);

  const handleAcceptIncomingVoiceInvite = useCallback(() => {
    const inviteRoomId = String(incomingVoiceInviteRoomId ?? "").trim();
    clearIncomingVoiceInviteState();
    if (isVoiceCallActive || isVoiceCallConnecting) {
      return;
    }
    startVoiceCallWithRoomId(inviteRoomId || null, { suppressInvite: true, origin: "incoming" });
  }, [clearIncomingVoiceInviteState, incomingVoiceInviteRoomId, isVoiceCallActive, isVoiceCallConnecting, startVoiceCallWithRoomId]);

  const handleDismissIncomingVoiceInvite = useCallback(() => {
    clearIncomingVoiceInviteState();
  }, [clearIncomingVoiceInviteState]);

  const handleLeaveVoiceCall = useCallback(() => {
    if (isVoiceCallActive || isVoiceCallConnecting) {
      const activeRoomId = String(activeVoiceRoomIdRef.current ?? "").trim() || voiceRoomId;
      const remoteParticipant = voiceCallParticipantsRef.current.find(
        (participant) => !participant.isLocal && Boolean(String(participant.userId ?? "").trim()),
      );
      const fallbackUserId = String(remoteParticipant?.userId ?? "").trim();
      const shouldOfferRejoin = Boolean(fallbackUserId) && hadRemoteParticipantInSessionRef.current;
      if (shouldOfferRejoin) {
        setVoiceCallRejoinFallbackWithTtl({
          roomId: activeRoomId,
          userId: fallbackUserId,
          displayName: String(remoteParticipant?.displayName ?? "").trim() || safeTargetDisplayName,
          avatarSrc: String(remoteParticipant?.avatarSrc ?? "").trim() || targetAvatarSrc,
        });
      } else {
        clearVoiceCallRejoinFallback();
      }
      if (!shouldOfferRejoin) {
        void sendVoiceSignal("cancel", activeRoomId).catch(() => undefined);
      }
    }
    void stopVoiceCallSession();
  }, [
    clearVoiceCallRejoinFallback,
    isVoiceCallActive,
    isVoiceCallConnecting,
    safeTargetDisplayName,
    sendVoiceSignal,
    setVoiceCallRejoinFallbackWithTtl,
    stopVoiceCallSession,
    targetAvatarSrc,
    voiceRoomId,
  ]);

  const handleRejoinVoiceCall = useCallback(() => {
    if (isVoiceCallActive || isVoiceCallConnecting || !voiceCallRejoinFallback) {
      return;
    }
    clearVoiceCallRejoinFallback();
    clearIncomingVoiceInviteState();
    startVoiceCallWithRoomId(voiceCallRejoinFallback.roomId, { suppressInvite: true, origin: "rejoin" });
  }, [
    clearIncomingVoiceInviteState,
    clearVoiceCallRejoinFallback,
    isVoiceCallActive,
    isVoiceCallConnecting,
    startVoiceCallWithRoomId,
    voiceCallRejoinFallback,
  ]);

  const voiceCallElapsedSeconds = useMemo(() => {
    if (!voiceCallStartedAtMs) {
      return null;
    }
    void voiceCallElapsedTick;
    return Math.max(0, Math.floor((Date.now() - voiceCallStartedAtMs) / 1_000));
  }, [voiceCallElapsedTick, voiceCallStartedAtMs]);

  const shouldShowVoiceCallPanel = isVoiceCallActive || isVoiceCallConnecting;
  const hasIncomingVoiceInvite = Boolean(incomingVoiceInviteFromUserId) && !shouldShowVoiceCallPanel;
  const hasVoiceCallRejoinFallback =
    Boolean(voiceCallRejoinFallback && voiceCallRejoinFallback.expiresAtMs > Date.now()) &&
    !hasIncomingVoiceInvite &&
    !shouldShowVoiceCallPanel;
  const shouldHideVoiceCallChrome = shouldShowVoiceCallPanel || hasVoiceCallRejoinFallback || hasIncomingVoiceInvite;
  const voiceCallButtonActive = isVoiceCallActive || isVoiceCallConnecting;
  const incomingVoiceInviteDisplayName =
    incomingVoiceInviteFromUserId && incomingVoiceInviteFromUserId === String(targetUser.userId ?? "").trim()
      ? safeTargetDisplayName
      : "Contato";
  const voiceCallRejoinDisplayName = String(voiceCallRejoinFallback?.displayName ?? "").trim() || safeTargetDisplayName;
  const voiceCallRejoinAvatarSrc = String(voiceCallRejoinFallback?.avatarSrc ?? "").trim() || targetAvatarSrc;

  return (
    <section
      className={`dm-chat${shouldHideVoiceCallChrome ? " dm-chat--voice-call-focus" : ""}`}
      aria-label={`Conversa com ${safeTargetDisplayName}`}
    >
      {!shouldHideVoiceCallChrome ? (
      <header className="dm-chat__header" role="banner">
        <div className="dm-chat__header-user">
          <div className="dm-chat__header-avatar-wrap">
            <img
              className="dm-chat__header-avatar"
              src={targetAvatarSrc}
              alt={`Avatar de ${safeTargetDisplayName}`}
              loading="eager"
              onError={(event) => {
                const target = event.currentTarget;
                if (target.src !== targetFallbackAvatar) {
                  target.src = targetFallbackAvatar;
                }
              }}
            />
          </div>
          <div className="dm-chat__header-meta">
            <h2 className="dm-chat__header-name">{safeTargetDisplayName}</h2>
          </div>
        </div>
        <div className="dm-chat__header-tools">
          <div className="dm-chat__header-actions" aria-label="Acoes da conversa">
            {!voiceCallButtonActive ? (
              <Tooltip text="Iniciar ou entrar na chamada de voz" position="top" delay={180}>
                <button
                  type="button"
                  className="dm-chat__header-action-btn dm-chat__header-action-btn--icon-only"
                  aria-label="Iniciar chamada de voz"
                  onClick={handleToggleVoiceCall}
                >
                  <img
                    className="dm-chat__header-action-icon"
                    src={headerVoiceCallIconUrl}
                    alt=""
                    aria-hidden="true"
                  />
                </button>
              </Tooltip>
            ) : null}
            <Tooltip text="Chamada de video indisponivel nesta versao" position="top" delay={180}>
              <button
                type="button"
                className="dm-chat__header-action-btn dm-chat__header-action-btn--icon-only"
                aria-label="Chamada de video indisponivel"
                disabled
              >
                <img
                  className="dm-chat__header-action-icon"
                  src={headerVideoOffIconUrl}
                  alt=""
                  aria-hidden="true"
                />
              </button>
            </Tooltip>
          </div>
          <label
            className={`dm-chat__header-search${normalizedHeaderSearchValue && headerSearchMatchIds.length === 0 ? " dm-chat__header-search--empty" : ""}`}
            aria-label="Buscar mensagens"
          >
            <MaterialSymbolIcon className="dm-chat__header-search-icon" name="search" size={16} />
            <input
              type="text"
              className="dm-chat__header-search-input"
              placeholder="Buscar mensagens"
              value={headerSearchValue}
              onChange={(event) => {
                setHeaderSearchValue(event.target.value);
                setHeaderSearchIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleHeaderSearchStep(event.shiftKey ? -1 : 1);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setHeaderSearchValue("");
                  setHeaderSearchIndex(-1);
                }
              }}
            />
            {normalizedHeaderSearchValue ? (
              <span className="dm-chat__header-search-count" aria-hidden="true">
                {headerSearchMatchIds.length > 0 && headerSearchIndex >= 0
                  ? `${headerSearchIndex + 1}/${headerSearchMatchIds.length}`
                  : `0/${headerSearchMatchIds.length}`}
              </span>
            ) : null}
          </label>
        </div>
      </header>
      ) : null}

      <div className={`dm-chat__body${shouldHideVoiceCallChrome ? " dm-chat__body--voice-call-focus" : ""}`}>
        <div className="dm-chat__main">
          {hasIncomingVoiceInvite ? (
            <section className="dm-chat__rejoin-stage dm-chat__rejoin-stage--compact" aria-label="Convite de chamada de voz">
              <div className="dm-chat__rejoin-stage-surface dm-chat__rejoin-stage-surface--compact">
                <div className="dm-chat__incoming-avatars" aria-hidden="true">
                  <img
                    className="dm-chat__rejoin-stage-avatar dm-chat__rejoin-stage-avatar--incoming dm-chat__rejoin-stage-avatar--incoming-local"
                    src={currentAvatarSrc}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      const target = event.currentTarget;
                      if (target.src !== currentFallbackAvatar) {
                        target.src = currentFallbackAvatar;
                      }
                    }}
                  />
                  <img
                    className="dm-chat__rejoin-stage-avatar dm-chat__rejoin-stage-avatar--incoming dm-chat__rejoin-stage-avatar--incoming-remote"
                    src={targetAvatarSrc}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      const target = event.currentTarget;
                      if (target.src !== targetFallbackAvatar) {
                        target.src = targetFallbackAvatar;
                      }
                    }}
                  />
                </div>
                <div
                  className="dm-chat__rejoin-stage-controls dm-chat__rejoin-stage-controls--incoming"
                  role="group"
                  aria-label="Acoes do convite de chamada"
                >
                  <button
                    type="button"
                    className="dm-chat__rejoin-stage-btn dm-chat__rejoin-stage-btn--incoming dm-chat__rejoin-stage-btn--incoming-video"
                    aria-label="Entrar com video em breve"
                    title="Entrar com video em breve"
                    disabled
                  >
                    <img className="dm-chat__rejoin-stage-btn-icon dm-chat__rejoin-stage-btn-icon--incoming" src={rejoinCameraIconUrl} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="dm-chat__rejoin-stage-btn dm-chat__rejoin-stage-btn--incoming dm-chat__rejoin-stage-btn--incoming-accept"
                    onClick={handleAcceptIncomingVoiceInvite}
                    aria-label="Atender chamada"
                    title="Atender chamada"
                  >
                    <img className="dm-chat__rejoin-stage-btn-icon dm-chat__rejoin-stage-btn-icon--incoming" src={headerVoiceCallIconUrl} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="dm-chat__rejoin-stage-btn dm-chat__rejoin-stage-btn--incoming dm-chat__rejoin-stage-btn--incoming-decline"
                    onClick={handleDismissIncomingVoiceInvite}
                    aria-label="Ignorar chamada"
                    title="Ignorar chamada"
                  >
                    <MaterialSymbolIcon className="dm-chat__rejoin-stage-btn-glyph dm-chat__rejoin-stage-btn-glyph--incoming" name="close" size={22} />
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {hasVoiceCallRejoinFallback ? (
            <section className="dm-chat__rejoin-stage dm-chat__rejoin-stage--compact" aria-label="Retorno para chamada de voz">
              <div className="dm-chat__rejoin-stage-surface dm-chat__rejoin-stage-surface--compact">
                <img
                  className="dm-chat__rejoin-stage-avatar"
                  src={voiceCallRejoinAvatarSrc}
                  alt={`Avatar de ${voiceCallRejoinDisplayName}`}
                  loading="lazy"
                  onError={(event) => {
                    const target = event.currentTarget;
                    if (target.src !== targetFallbackAvatar) {
                      target.src = targetFallbackAvatar;
                    }
                  }}
                />
                <div className="dm-chat__rejoin-stage-controls dm-chat__rejoin-stage-controls--icon" role="group" aria-label="Acoes para voltar para chamada">
                  <button
                    type="button"
                    className="dm-chat__rejoin-stage-btn dm-chat__rejoin-stage-btn--icon dm-chat__rejoin-stage-btn--accept"
                    onClick={handleRejoinVoiceCall}
                    aria-label="Entrar na chamada"
                    title="Entrar na chamada"
                  >
                    <img className="dm-chat__rejoin-stage-btn-icon" src={headerVoiceCallIconUrl} alt="" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="dm-chat__rejoin-stage-btn dm-chat__rejoin-stage-btn--icon"
                    aria-label="Camera em breve"
                    title="Camera em breve"
                    disabled
                  >
                    <img className="dm-chat__rejoin-stage-btn-icon" src={rejoinCameraIconUrl} alt="" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {shouldShowVoiceCallPanel ? (
            <div className="dm-chat__voice-call-wrap">
              <VoiceCallInterface
                isOpen={shouldShowVoiceCallPanel}
                isConnecting={isVoiceCallConnecting}
                connectionState={voiceCallConnectionState}
                participants={voiceCallParticipants}
                localMuted={isVoiceCallMuted}
                localDeafened={isVoiceCallDeafened}
                elapsedSeconds={voiceCallElapsedSeconds}
                diagnostics={voiceCallDiagnostics}
                errorMessage={voiceCallError}
                microphoneWarning={voiceCallMicWarning}
                onToggleMute={handleToggleVoiceMute}
                onLeave={handleLeaveVoiceCall}
              />
            </div>
          ) : null}
          <div className="dm-chat__messages-wrap">
            <div
              className={`dm-chat__messages dm-chat__message-scroll${shouldShowMessagesSkeleton ? "" : " dm-chat__messages--ready"}`}
              ref={scrollContainerRef}
              onScroll={handleMessagesScroll}
            >
          {isLoadingOlder ? <p className="dm-chat__state">Carregando mensagens antigas...</p> : null}
          {loadError ? <p className="dm-chat__state dm-chat__state--error">{loadError}</p> : null}
          {shouldShowMessagesSkeleton ? <MessagesSkeleton /> : null}
          {!loadError ? (
            <section className="dm-chat__intro" aria-label={`Inicio da conversa com ${safeTargetDisplayName}`}>
              <img
                className="dm-chat__intro-avatar"
                src={targetAvatarSrc}
                alt={`Avatar de ${safeTargetDisplayName}`}
                loading="eager"
                onError={(event) => {
                  const target = event.currentTarget;
                  if (target.src !== targetFallbackAvatar) {
                    target.src = targetFallbackAvatar;
                  }
                }}
              />
              <h3 className="dm-chat__intro-name">{safeTargetDisplayName}</h3>
              {safeTargetUsername ? <p className="dm-chat__intro-username">{safeTargetUsername}</p> : null}
              <p className="dm-chat__intro-copy">
                Este e o inicio da sua conversa privada com {safeTargetDisplayName}.
              </p>
              {messages.length === 0 && !shouldShowMessagesSkeleton ? (
                <p className="dm-chat__intro-empty-note">Envie a primeira mensagem abaixo.</p>
              ) : null}
            </section>
          ) : null}

          {virtualTopSpacerHeight > 0 ? (
            <div
              className="dm-chat__messages-virtual-spacer dm-chat__messages-virtual-spacer--top"
              style={{ height: `${virtualTopSpacerHeight}px` }}
              aria-hidden="true"
            />
          ) : null}

          {visibleMessageRenderEntries.map(({ message, showHeader, mediaGroup, dateDividerLabel }) => {
            const dateDividerNode = dateDividerLabel ? (
              <MessageDateDivider label={dateDividerLabel} dateTime={message.createdAt} />
            ) : null;
            const isFromCurrentUser = isCurrentUserSender(message.senderId);
            const sender = getParticipantById(message.senderId);
            const senderAvatar = isFromCurrentUser ? currentAvatarSrc : targetAvatarSrc;
            const senderFallbackAvatar = isFromCurrentUser ? currentFallbackAvatar : targetFallbackAvatar;
            const resolvedAttachmentUrl = resolveRenderedAttachmentUrl(message);
            const isEditing = editingMessageId === message.id;
            const canReply = !message.optimistic && !message.failed && !message.deletedAt;
            const canEdit = canEditMessage(message);
            const canDelete = canDeleteMessage(message);
            const replyPreview = resolveReplyPreview(message);
            const effectiveShowHeader = showHeader || Boolean(replyPreview);
            const replyPreviewRawSnippet = String(replyPreview?.snippet ?? "");
            const isReplyToDeletedOriginal = String(replyPreview?.message_type ?? "").trim().toLowerCase() === "deleted";
            const replyPreviewIcon = replyPreview ? getReplyIconName(replyPreview.message_type ?? null, replyPreviewRawSnippet) : null;
            const replyPreviewSnippet = truncateSnippet(replyPreviewRawSnippet);
            const mediaSourceMessages =
              !message.deletedAt
                ? mediaGroup?.messages ?? (isMediaMessage(message) ? [message] : [])
                : [];
            const mediaGridItems: MediaAttachmentItem[] =
              mediaSourceMessages.map((mediaMessage) => {
                const mediaFullUrl = resolveRenderedAttachmentUrl(mediaMessage);
                const mediaPreviewUrl = resolveRenderedAttachmentThumbUrl(mediaMessage);
                const mediaMimeType = String(mediaMessage.attachment?.mimeType ?? "").trim().toLowerCase();
                const mediaFileKey = String(mediaMessage.attachment?.fileKey ?? mediaMessage.content ?? "").trim().toLowerCase();
                const isGifImage =
                  mediaMessage.type === "image" &&
                  (mediaMimeType === "image/gif" || mediaFileKey.endsWith(".gif"));
                const mediaSender = getParticipantById(mediaMessage.senderId);
                const mediaSenderName = mediaSender.displayName || mediaSender.username || "Usuario";
                const mediaSenderAvatar =
                  (mediaSender.avatarSrc || "").trim() || getNameAvatarUrl(mediaSenderName || "U");
                return {
                  messageId: mediaMessage.id,
                  type: mediaMessage.type === "video" ? "video" : "image",
                  previewUrl: isGifImage ? mediaFullUrl : (mediaPreviewUrl || mediaFullUrl),
                  fullUrl: mediaFullUrl,
                  isLoading:
                    mediaMessage.type === "video"
                      ? !mediaFullUrl
                      : !mediaPreviewUrl && !mediaFullUrl,
                  senderName: mediaSenderName,
                  senderAvatar: mediaSenderAvatar,
                  createdAt: mediaMessage.createdAt,
                  canDelete: canDeleteMessage(mediaMessage),
                };
              }) ?? [];
            const messageTwemojiHtml = toTwemojiHtml(message.content);
            const emojiOnlyMeta = getEmojiOnlyMeta(messageTwemojiHtml);
            const emojiOnlySizeClass = emojiOnlyMeta.emojiCount <= 1
              ? "dm-chat__message-text--emoji-count-1"
              : emojiOnlyMeta.emojiCount === 2
                ? "dm-chat__message-text--emoji-count-2"
                : emojiOnlyMeta.emojiCount === 3
                  ? "dm-chat__message-text--emoji-count-3"
                  : "dm-chat__message-text--emoji-count-many";
            const messageTextClassName = [
              "dm-chat__message-text",
              emojiOnlyMeta.isEmojiOnly ? "dm-chat__message-text--emoji-only" : "",
              emojiOnlyMeta.isEmojiOnly ? emojiOnlySizeClass : "",
            ]
              .filter(Boolean)
              .join(" ");
            const renderedTextContent = message.deletedAt ? "Mensagem excluida" : message.content;

            return (
              <Fragment key={message.id}>
                {dateDividerNode}
                <div
                  className={`dm-chat__message-wrapper dm-chat__message-item${
                    effectiveShowHeader ? " dm-chat__message-wrapper--with-header dm-chat__message-item--with-header" : " dm-chat__message-wrapper--grouped dm-chat__message-item--grouped"
                  }${
                    replyPreview ? " dm-chat__message-wrapper--with-reply dm-chat__message-item--with-reply" : ""
                  }${highlightMessageId === message.id ? " dm-chat__message--highlight" : ""}`}
                >
                {replyPreview ? (
                  <button
                    type="button"
                    className={`dm-chat__reply-preview${isReplyToDeletedOriginal ? " dm-chat__reply-preview--deleted" : ""}`}
                    disabled={!message.replyToId || isReplyToDeletedOriginal}
                    onClick={() => {
                      if (message.replyToId && !isReplyToDeletedOriginal) {
                        scrollToMessageById(message.replyToId);
                      }
                    }}
                  >
                    {isReplyToDeletedOriginal ? (
                      <span className="dm-chat__reply-deleted">
                        <MaterialSymbolIcon className="dm-chat__reply-deleted-icon" name="reply" size={13} />
                        <span className="dm-chat__reply-deleted-text">{replyPreviewSnippet}</span>
                      </span>
                    ) : (
                      <>
                        {replyPreview.author_avatar ? (
                          <img className="dm-chat__reply-avatar" src={replyPreview.author_avatar} alt="" />
                        ) : (
                          <span className="dm-chat__reply-avatar dm-chat__reply-avatar--placeholder" />
                        )}
                        <span className="dm-chat__reply-text">
                          <span className="dm-chat__reply-author">{replyPreview.author_name}</span>
                          <span className="dm-chat__reply-snippet">
                            {replyPreviewIcon ? (
                              <MaterialSymbolIcon className="dm-chat__reply-snippet-icon" name={replyPreviewIcon} size={14} />
                            ) : null}
                            <span className="dm-chat__reply-snippet-text">{replyPreviewSnippet}</span>
                          </span>
                        </span>
                      </>
                    )}
                  </button>
                ) : null}

                <article
                  data-message-id={message.id}
                  ref={(element) => {
                    if (element) {
                      messageRefs.current.set(message.id, element);
                      if (mediaGroup?.hiddenMessageIds.length) {
                        mediaGroup.hiddenMessageIds.forEach((hiddenMessageId) => {
                          messageRefs.current.set(hiddenMessageId, element);
                        });
                      }
                    } else {
                      messageRefs.current.delete(message.id);
                      if (mediaGroup?.hiddenMessageIds.length) {
                        mediaGroup.hiddenMessageIds.forEach((hiddenMessageId) => {
                          messageRefs.current.delete(hiddenMessageId);
                        });
                      }
                    }
                  }}
                  className={`dm-chat__message${
                    effectiveShowHeader ? " dm-chat__message--with-header" : " dm-chat__message--grouped"
                  }${message.failed ? " dm-chat__message--failed" : ""} dm-chat__message-row`}
                >
                  {effectiveShowHeader ? (
                    <button
                      type="button"
                      className="dm-chat__message-avatar-trigger"
                      aria-label={`Abrir perfil de ${sender.displayName}`}
                      onClick={(event) => {
                        handleOpenMessageProfilePopover(event, sender.userId);
                      }}
                    >
                      <img
                        className="dm-chat__message-avatar"
                        src={senderAvatar}
                        alt={`Avatar de ${sender.displayName}`}
                        loading="lazy"
                        onError={(event) => {
                          const target = event.currentTarget;
                          if (target.src !== senderFallbackAvatar) {
                            target.src = senderFallbackAvatar;
                          }
                        }}
                      />
                    </button>
                  ) : (
                    <span className="dm-chat__message-avatar-spacer" aria-hidden="true" />
                  )}

                  <div className="dm-chat__message-content-wrap dm-chat__message-main">
                    {effectiveShowHeader ? (
                      <header className="dm-chat__message-head">
                        <button
                          type="button"
                          className="dm-chat__message-author-button"
                          aria-label={`Abrir perfil de ${sender.displayName}`}
                          onClick={(event) => {
                            handleOpenMessageProfilePopover(event, sender.userId);
                          }}
                        >
                          <span className="dm-chat__message-author">{sender.displayName}</span>
                        </button>
                        <time className="dm-chat__message-time" dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt)}
                        </time>
                        {message.editedAt ? <span className="dm-chat__message-edited">(editada)</span> : null}
                      </header>
                    ) : null}
                    {isEditing ? (
                      <div className="dm-chat__message-edit">
                        <textarea
                          ref={editInputRef}
                          className="dm-chat__message-edit-input"
                          value={editingValue}
                          onChange={(event) => {
                            setEditingValue(event.target.value);
                            adjustEditTextareaHeight(event.currentTarget);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              handleCancelEdit();
                              return;
                            }
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void handleSaveEdit();
                            }
                          }}
                          rows={1}
                        />
                        <div className="dm-chat__message-edit-actions">
                          <button
                            type="button"
                            className="dm-chat__message-edit-btn"
                            onClick={() => void handleSaveEdit()}
                            disabled={isSavingEdit}
                          >
                            Salvar
                          </button>
                          <button
                            type="button"
                            className="dm-chat__message-edit-btn dm-chat__message-edit-btn--ghost"
                            onClick={handleCancelEdit}
                            disabled={isSavingEdit}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {mediaGridItems.length > 0 ? (
                      <AttachmentGrid
                        items={mediaGridItems}
                        onMediaLoaded={handleInlineMediaLoaded}
                        onOpen={(index) => {
                          const initialIndex = Math.max(0, Math.min(index, mediaGridItems.length - 1));
                          const selectedItem = mediaGridItems[initialIndex];
                          if (!selectedItem) {
                            return;
                          }
                          const viewerItems = mediaGridItems.filter((item) => !item.isLoading);
                          const viewerIndex = viewerItems.findIndex((item) => item.messageId === selectedItem.messageId);
                          if (viewerItems.length === 0 || viewerIndex < 0) {
                            return;
                          }
                          setMediaViewerState({
                            items: viewerItems,
                            index: viewerIndex,
                          });
                        }}
                        onDelete={(mediaMessageId) => {
                          const mediaMessage = mediaSourceMessages.find((item) => item.id === mediaMessageId);
                          if (!mediaMessage || !canDeleteMessage(mediaMessage)) {
                            return;
                          }
                          setDeleteTarget(mediaMessage);
                        }}
                      />
                    ) : null}
                    {message.type === "file" && !message.deletedAt ? (
                      <a
                        className="dm-chat__message-file-link"
                        href={resolvedAttachmentUrl || "#"}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <MaterialSymbolIcon name="description" size={18} />
                        <span className="dm-chat__message-file-name">
                          {getFileNameFromUrl(resolvedAttachmentUrl || message.content)}
                        </span>
                      </a>
                    ) : null}
                    {mediaGridItems.length === 0 && message.type !== "file" ? (
                      !isEditing ? (
                        <p className={messageTextClassName}>
                          <span className="dm-chat__message-text-content">{renderedTextContent}</span>
                          {!effectiveShowHeader && message.editedAt ? <span className="dm-chat__message-edited"> (editada)</span> : null}
                        </p>
                      ) : null
                    ) : null}
                    {message.failed ? (
                      <span className="dm-chat__message-failed">
                        Falha ao enviar.
                        {message.type === "text" ? (
                          <button
                            type="button"
                            className="dm-chat__message-retry-btn"
                            onClick={() => {
                              void handleRetryFailedMessage(message);
                            }}
                          >
                            Tentar novamente
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  {canReply || canEdit || canDelete ? (
                    <div
                      className={`dm-chat__message-actions dm-chat__message-actions-bar${
                        isEditing ? " dm-chat__message-actions--hidden" : ""
                      }`}
                    >
                      {canReply ? (
                        <button
                          type="button"
                          className="dm-chat__message-action"
                          data-tooltip="Responder"
                          aria-label="Responder mensagem"
                          onMouseDown={(event) => {
                            // Keep hover logic stable: do not leave this button focused after click.
                            event.preventDefault();
                          }}
                          onClick={() => handleStartReply(message)}
                        >
                          <MaterialSymbolIcon name="reply" size={16} />
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button
                          type="button"
                          className="dm-chat__message-action"
                          data-tooltip="Editar"
                          aria-label="Editar mensagem"
                          onMouseDown={(event) => {
                            // Keep hover logic stable: do not leave this button focused after click.
                            event.preventDefault();
                          }}
                          onClick={() => handleStartEdit(message)}
                        >
                          <MaterialSymbolIcon name="edit" size={16} />
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          className="dm-chat__message-action dm-chat__message-action--danger"
                          data-tooltip="Excluir"
                          aria-label="Excluir mensagem"
                          onMouseDown={(event) => {
                            // Keep hover logic stable: do not leave this button focused after click.
                            event.preventDefault();
                          }}
                          onClick={() => setDeleteTarget(message)}
                        >
                          <MaterialSymbolIcon name="delete" size={16} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
                </div>
              </Fragment>
            );
          })}

          {virtualBottomSpacerHeight > 0 ? (
            <div
              className="dm-chat__messages-virtual-spacer dm-chat__messages-virtual-spacer--bottom"
              style={{ height: `${virtualBottomSpacerHeight}px` }}
              aria-hidden="true"
            />
          ) : null}

          {isSending && uploadingAttachmentsCount > 0 ? (
            <div className="dm-chat__messages-upload-status-wrap">
              <div className="dm-chat__upload-status dm-chat__upload-status--in-messages" role="status" aria-live="polite" aria-label={uploadStatusLabel}>
                <div className="dm-chat__upload-status-icon">
                  <MaterialSymbolIcon name="description" size={24} />
                </div>
                <div className="dm-chat__upload-status-content">
                  <p className="dm-chat__upload-status-title" title={uploadStatusTitle}>{uploadStatusTitle}</p>
                  <div className="dm-chat__upload-status-track" aria-hidden="true">
                    <span
                      className="dm-chat__upload-status-bar"
                      style={{
                        width: `${Math.round(uploadStatusRatio * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="dm-chat__upload-status-close"
                  aria-label="Envio em andamento"
                  title="Envio em andamento"
                  disabled
                >
                  <MaterialSymbolIcon name="close" size={18} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="dm-chat__scrollbar" ref={scrollbarRef} aria-hidden="true">
          <div className="dm-chat__scrollbar-thumb" ref={scrollbarThumbRef} />
        </div>
      </div>

      {showNewMessagesButton ? (
        <div className="dm-chat__new-messages-wrap">
          <button
            type="button"
            className="dm-chat__new-messages-btn"
            onClick={() => {
              scrollToBottom(false);
              setShowNewMessagesButton(false);
            }}
          >
            Novas mensagens
          </button>
        </div>
      ) : null}

        <form
          className="dm-chat__composer"
          onSubmit={(event) => {
          event.preventDefault();
          void submitMessage();
        }}
      >
        {replyTarget ? (
          <div className="dm-chat__reply-composer">
            <span className="dm-chat__reply-composer-heading">
              Respondendo para <span className="dm-chat__reply-composer-name">{replyTarget.authorName}</span>
            </span>
            <button
              type="button"
              className="dm-chat__reply-composer-close"
              aria-label="Cancelar resposta"
              title="Cancelar resposta"
              onClick={() => setReplyTarget(null)}
            >
              <MaterialSymbolIcon name="close" size={18} />
            </button>
          </div>
        ) : null}

        {draftAttachments.length > 0 && !isSending ? (
          <div className="dm-chat__composer-drafts" aria-label="Anexos selecionados">
            {draftAttachments.map((attachment) => (
              <article key={attachment.id} className="dm-chat__draft-item">
                <button
                  className="dm-chat__draft-remove"
                  type="button"
                  aria-label={`Remover ${attachment.file.name}`}
                  title="Remover anexo"
                  onClick={() => {
                    releaseDraftAttachmentById(attachment.id);
                  }}
                  disabled={isSending}
                >
                  <MaterialSymbolIcon name="delete" size={16} />
                </button>

                <div className="dm-chat__draft-preview">
                  {attachment.kind === "image" && attachment.previewUrl ? (
                    <img className="dm-chat__draft-image" src={attachment.previewUrl} alt={attachment.file.name} loading="lazy" />
                  ) : null}
                  {attachment.kind === "video" && attachment.previewUrl ? (
                    <video className="dm-chat__draft-video" src={attachment.previewUrl} muted preload="metadata" />
                  ) : null}
                  {attachment.kind === "file" ? (
                    <div className="dm-chat__draft-file-icon-wrap">
                      <MaterialSymbolIcon name="description" size={28} />
                    </div>
                  ) : null}
                </div>

                <div className="dm-chat__draft-meta">
                  <p className="dm-chat__draft-name" title={attachment.file.name}>
                    {attachment.file.name}
                  </p>
                  <p className="dm-chat__draft-size">{formatFileSize(attachment.file.size)}</p>
                  {attachment.uploadError ? <p className="dm-chat__draft-error">{attachment.uploadError}</p> : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}

        <div className={`dm-chat__composer-box${replyTarget ? " dm-chat__composer-box--with-reply" : ""}`}>
          <button
            className="dm-chat__composer-media"
            type="button"
            aria-label="Adicionar anexo"
            title="Adicionar anexo"
            onClick={() => {
              mediaInputRef.current?.click();
            }}
            disabled={isSending}
          >
            <MaterialSymbolIcon name="add" size={30} filled={false} weight={200} />
          </button>
          <input
            ref={mediaInputRef}
            className="dm-chat__composer-media-input"
            type="file"
            multiple
            onChange={handlePickAttachments}
          />
          <div className="dm-chat__composer-input-wrap">
            <input
              className="dm-chat__composer-input"
              placeholder={composerPlaceholder}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                void submitMessage();
              }}
              type="text"
              autoComplete="off"
              ref={draftInputRef}
            />
          </div>
          <EmojiButton
            buttonRef={emojiButtonRef}
            isOpen={isEmojiOpen && emojiPopoverSource === "composer"}
            disabled={isSending}
            onToggle={handleToggleComposerEmoji}
          />
        </div>
      </form>
        </div>

        {!shouldHideVoiceCallChrome ? (
        <aside
          className="dm-chat__profile-sidebar"
          aria-label={`Perfil de ${safeTargetDisplayName}`}
          style={targetSidebarProfileThemeInlineStyle}
        >
          <section className="dm-chat__profile-panel">
            <div
              className={`dm-chat__profile-banner-wrap ${
                targetHasCustomBannerImage ? "dm-chat__profile-banner-wrap--image" : "dm-chat__profile-banner-wrap--separator"
              }`}
              style={targetBannerInlineStyle}
            >
              {targetHasCustomBannerImage ? (
                <img
                  className="dm-chat__profile-banner"
                  src={targetBannerSrc}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
            </div>

            <div
              className={`dm-chat__profile-content ${
                targetHasCustomBannerImage ? "dm-chat__profile-content--banner-image" : ""
              }`}
            >
              <button
                type="button"
                className="dm-chat__profile-avatar-wrap dm-chat__profile-avatar-button"
                aria-label={`Abrir perfil completo de ${safeTargetDisplayName}`}
                onClick={handleOpenSidebarFullProfile}
              >
                <img
                  className="dm-chat__profile-avatar"
                  src={targetAvatarSrc}
                  alt={`Avatar de ${safeTargetDisplayName}`}
                  loading="lazy"
                  onError={(event) => {
                    const target = event.currentTarget;
                    if (target.src !== targetFallbackAvatar) {
                      target.src = targetFallbackAvatar;
                    }
                  }}
                />
                <span
                  className={`dm-chat__profile-presence dm-chat__profile-presence--${targetPresenceState}`}
                  aria-label={`Status: ${targetPresenceLabel}`}
                  role="img"
                />
              </button>

              <h3 className="dm-chat__profile-name-heading">
                <button
                  type="button"
                  className="dm-chat__profile-name dm-chat__profile-name-button"
                  onClick={handleOpenSidebarFullProfile}
                  aria-label={`Abrir perfil completo de ${safeTargetDisplayName}`}
                >
                  {safeTargetDisplayName}
                </button>
              </h3>
              <p className="dm-chat__profile-username">@{safeTargetUsername}</p>

              {targetSidebarSpotifyActivity ? (
                <section className="dm-chat__profile-spotify-section" aria-label={`Ouvindo ${targetSidebarSpotifyActivity.trackTitle}`}>
                  <article className="dm-chat__profile-spotify-card">
                    <p className="dm-chat__profile-spotify-title">
                      <span className="dm-chat__profile-spotify-title-icon" aria-hidden="true">
                        <SpotifyIcon size={12} monochrome />
                      </span>
                      Ouvindo Spotify
                    </p>
                    <div className="dm-chat__profile-spotify-main">
                      <button
                        type="button"
                        className="dm-chat__profile-spotify-cover-button"
                        onClick={handleOpenSidebarSpotifyTrack}
                        aria-label={`Abrir ${targetSidebarSpotifyActivity.trackTitle} no Spotify`}
                        title="Abrir no Spotify"
                      >
                        {targetSidebarSpotifyActivity.coverUrl ? (
                          <img
                            className="dm-chat__profile-spotify-cover"
                            src={targetSidebarSpotifyActivity.coverUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : null}
                      </button>
                      <div className="dm-chat__profile-spotify-meta">
                        <button
                          type="button"
                          className="dm-chat__profile-spotify-track"
                          onClick={handleOpenSidebarSpotifyTrack}
                          title="Abrir no Spotify"
                        >
                          {targetSidebarSpotifyActivity.trackTitle}
                        </button>
                        <button
                          type="button"
                          className="dm-chat__profile-spotify-artist"
                          onClick={handleOpenSidebarSpotifyTrack}
                          title="Abrir no Spotify"
                        >
                          {targetSidebarSpotifyActivity.artistNames}
                        </button>
                        <div className="dm-chat__profile-spotify-timeline">
                          <span className="dm-chat__profile-spotify-time">
                            {formatSpotifyPlaybackTime(targetSidebarSpotifyActivity.progressSeconds)}
                          </span>
                          <div className="dm-chat__profile-spotify-progress-track" aria-hidden="true">
                            <span
                              className="dm-chat__profile-spotify-progress-bar"
                              style={{
                                width: `${Math.max(
                                  0,
                                  Math.min(
                                    100,
                                    targetSidebarSpotifyActivity.durationSeconds > 0
                                      ? (targetSidebarSpotifyActivity.progressSeconds / targetSidebarSpotifyActivity.durationSeconds) * 100
                                      : 0,
                                  ),
                                )}%`,
                              }}
                            />
                          </div>
                          <span className="dm-chat__profile-spotify-time">
                            {formatSpotifyPlaybackTime(targetSidebarSpotifyActivity.durationSeconds)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="dm-chat__profile-spotify-actions">
                      <button
                        type="button"
                        className="dm-chat__profile-spotify-action dm-chat__profile-spotify-action--primary"
                        onClick={handleOpenSidebarSpotifyTrack}
                      >
                        <SpotifyIcon size={14} monochrome />
                        <span>Ouvir no Spotify</span>
                      </button>
                      <Tooltip
                        text={isSidebarListenAlongActive ? `Ouvindo junto com ${safeTargetDisplayName}` : `Ouça junto com ${safeTargetDisplayName}`}
                        position="top"
                        delay={180}
                        disabled={!canSidebarListenAlong}
                      >
                        <button
                          type="button"
                          className={`dm-chat__profile-spotify-action dm-chat__profile-spotify-action--icon${isSidebarListenAlongActive ? " dm-chat__profile-spotify-action--active" : ""}`}
                          onClick={handleToggleSidebarListenAlong}
                          aria-label={isSidebarListenAlongActive ? "Parar de ouvir junto" : "Ouvir junto"}
                          disabled={!canSidebarListenAlong}
                        >
                          <MaterialSymbolIcon name="headphones" size={18} filled={isSidebarListenAlongActive} />
                        </button>
                      </Tooltip>
                    </div>
                  </article>
                </section>
              ) : null}

              {shouldShowSidebarProfileMetaCard ? (
                <div className="dm-chat__profile-meta-card" role="note" aria-label={`Membro desde ${targetMemberSinceLabelForFullProfile}`}>
                  {targetAboutText ? (
                    <div className="dm-chat__profile-meta-section">
                      <p className="dm-chat__profile-meta-title">Sobre mim</p>
                      <p
                        ref={profileAboutRef}
                        className="dm-chat__profile-meta-value dm-chat__profile-meta-about"
                      >
                        {targetAboutText}
                      </p>
                      {canExpandBiography ? (
                        <button
                          type="button"
                          className="dm-chat__profile-meta-link"
                          onClick={handleOpenSidebarFullProfile}
                        >
                          Ver Biografia Completa
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {targetMemberSinceLabel ? (
                    <div className="dm-chat__profile-meta-section">
                      <p className="dm-chat__profile-meta-title">Membro desde</p>
                      <p className="dm-chat__profile-meta-value">{targetMemberSinceLabel}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="dm-chat__profile-footer">
              <button
                type="button"
                className="dm-chat__profile-footer-link"
                onClick={handleOpenSidebarFullProfile}
              >
                Ver Perfil Completo
              </button>
            </div>
          </section>
        </aside>
        ) : null}
      </div>

      <EmojiPopover
        isOpen={isEmojiOpen}
        anchorRef={emojiPopoverSource === "profile" ? profileMessageComposerEmojiButtonRef : emojiButtonRef}
        onClose={() => setIsEmojiOpen(false)}
        onSelect={handleSelectEmoji}
      />

      {openMessageProfileUserId && openMessageProfileParticipant && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={messageProfilePopoverRef}
              className="dm-chat__message-profile-popover"
              style={{
                top: `${messageProfilePosition.top}px`,
                left: `${messageProfilePosition.left}px`,
              }}
            >
              <UserProfilePopover
                avatarSrc={openMessageProfileAvatarSrc}
                bannerSrc={openMessageProfileBannerSrc}
                bannerColor={openMessageProfileBannerColor}
                themePrimaryColor={openMessageProfileThemePrimaryColor}
                themeAccentColor={openMessageProfileThemeAccentColor}
                displayName={openMessageProfileDisplayName}
                username={openMessageProfileUsername}
                aboutText={openMessageProfileAboutText}
                profileUserId={openMessageProfileParticipant.userId}
                spotifyActivity={openMessageProfileParticipant.spotifyActivity ?? null}
                presenceState={openMessageProfilePresenceState}
                presenceLabel={openMessageProfilePresenceLabel}
                showActions={false}
                showMessageComposer={!isOpenMessageProfileCurrentUser}
                showEditProfileButton={isOpenMessageProfileCurrentUser}
                messageComposerInputRef={profileMessageComposerInputRef}
                messageComposerValue={draft}
                onMessageComposerChange={setDraft}
                onMessageComposerSubmit={() => {
                  void submitMessage();
                }}
                onEditProfile={handleOpenCurrentUserSettings}
                messageComposerEmojiButtonRef={profileMessageComposerEmojiButtonRef}
                messageComposerEmojiDisabled={isSending}
                isMessageComposerEmojiOpen={isEmojiOpen && emojiPopoverSource === "profile"}
                onToggleMessageComposerEmoji={handleToggleProfileComposerEmoji}
                onOpenSettings={onOpenSettings}
              />
            </div>,
            document.body,
          )
        : null}

      {isSidebarFullProfileOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="dm-chat__center-profile" onClick={closeSidebarFullProfile}>
              <div
                ref={sidebarFullProfileRef}
                className="dm-chat__center-profile-card"
                role="dialog"
                aria-label={`Perfil de ${safeTargetDisplayName}`}
                onClick={(event) => event.stopPropagation()}
              >
                <UserProfilePopover
                  avatarSrc={targetAvatarSrc}
                  bannerSrc={targetBannerSrc}
                  bannerColor={targetBannerColor}
                  themePrimaryColor={targetThemePrimaryColor}
                  themeAccentColor={targetThemeAccentColor}
                  displayName={safeTargetDisplayName}
                  username={safeTargetUsername}
                  profileUserId={targetUser.userId}
                  viewMode="full"
                  aboutText={targetAboutText}
                  spotifyActivity={targetUser.spotifyActivity ?? null}
                  memberSinceLabel={targetMemberSinceLabelForFullProfile}
                  onCloseFullProfile={closeSidebarFullProfile}
                  presenceState={targetPresenceState}
                  presenceLabel={targetPresenceLabel}
                  showActions={false}
                  showEditProfileButton={isSidebarProfileCurrentUser}
                  onMessageComposerSubmit={handleFullProfilePrimaryAction}
                  onEditProfile={handleOpenCurrentUserSettings}
                  onOpenSettings={onOpenSettings}
                  showFriendActions={!isSidebarProfileCurrentUser && isTargetFriend}
                  onUnfriend={handleFullProfileUnfriend}
                  isUnfriending={isUnfriendingTarget}
                  showFriendRequestPending={!isSidebarProfileCurrentUser && !isTargetFriend && isTargetFriendRequestPending}
                  showAddFriendAction={!isSidebarProfileCurrentUser && !isTargetFriend && !isTargetFriendRequestPending}
                  onAddFriend={handleFullProfileAddFriend}
                  isAddingFriend={isAddingTargetFriend}
                  mutualFriends={mutualFriends}
                  showBlockAction={!isSidebarProfileCurrentUser}
                  onBlockUser={handleFullProfileBlock}
                  isBlockingUser={isBlockingTarget}
                />
              </div>
            </div>,
            document.body,
          )
        : null}

      {mediaViewerState && currentViewerItem ? (
        <div
          className="dm-chat__media-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Visualizador de midia"
          onClick={handleCloseMediaViewer}
        >
          <div className="dm-chat__media-viewer-inner" onClick={(event) => event.stopPropagation()}>
            <div className="dm-chat__media-viewer-toolbar">
              <div className="dm-chat__media-viewer-toolbar-group">
                {mediaViewerState.items.length > 1 ? (
                  <button
                    type="button"
                    className="dm-chat__media-viewer-tool-btn"
                    onClick={() => handleMediaViewerStep(-1)}
                    aria-label="Midia anterior"
                    title="Midia anterior"
                  >
                    <MaterialSymbolIcon name="chevron_left" size={18} />
                  </button>
                ) : null}
                {mediaViewerState.items.length > 1 ? (
                  <button
                    type="button"
                    className="dm-chat__media-viewer-tool-btn"
                    onClick={() => handleMediaViewerStep(1)}
                    aria-label="Proxima midia"
                    title="Proxima midia"
                  >
                    <MaterialSymbolIcon name="chevron_right" size={18} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="dm-chat__media-viewer-tool-btn"
                  onClick={handleDownloadViewerMedia}
                  aria-label="Baixar midia"
                  title="Baixar midia"
                >
                  <MaterialSymbolIcon name="download" size={18} />
                </button>
                <button
                  type="button"
                  className="dm-chat__media-viewer-tool-btn"
                  onClick={handleOpenViewerMediaInBrowser}
                  aria-label="Abrir no navegador"
                  title="Abrir no navegador"
                >
                  <MaterialSymbolIcon name="open_in_new" size={18} />
                </button>
              </div>
              <button
                type="button"
                className="dm-chat__media-viewer-close-btn"
                onClick={handleCloseMediaViewer}
                aria-label="Fechar visualizador"
                title="Fechar"
              >
                <MaterialSymbolIcon name="close" size={20} />
              </button>
            </div>

            <div className="dm-chat__media-viewer-author">
              <img
                className="dm-chat__media-viewer-author-avatar"
                src={currentViewerItem.senderAvatar}
                alt={`Avatar de ${currentViewerItem.senderName}`}
                onError={(event) => {
                  const fallbackAvatar = getNameAvatarUrl(currentViewerItem.senderName || "U");
                  if (event.currentTarget.src !== fallbackAvatar) {
                    event.currentTarget.src = fallbackAvatar;
                  }
                }}
              />
              <div className="dm-chat__media-viewer-author-meta">
                <p className="dm-chat__media-viewer-author-name">{currentViewerItem.senderName}</p>
                <p className="dm-chat__media-viewer-author-date">{formatMessageDateTime(currentViewerItem.createdAt)}</p>
              </div>
            </div>

            {mediaViewerState.items.length > 1 ? (
              <div className="dm-chat__media-viewer-counter dm-chat__media-viewer-counter--top">
                {mediaViewerState.index + 1} / {mediaViewerState.items.length}
              </div>
            ) : null}

            <div className="dm-chat__media-viewer-content">
              {currentViewerItem.type === "image" ? (
                <img src={currentViewerItem.fullUrl || currentViewerItem.previewUrl} alt="Imagem em destaque" loading="lazy" />
              ) : (
                <video
                  src={currentViewerItem.fullUrl || currentViewerItem.previewUrl}
                  controls
                  preload="metadata"
                  poster={currentViewerItem.previewUrl || undefined}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        isOpen={Boolean(deleteTarget)}
        title="Excluir mensagem"
        ariaLabel="Confirmar exclusao de mensagem"
        onClose={() => {
          if (!isDeletingCurrentDeleteTarget) {
            setDeleteTarget(null);
          }
        }}
        panelClassName="dm-chat__delete-modal-panel"
        bodyClassName="dm-chat__delete-modal-body"
        footer={
          <div className="dm-chat__delete-modal-footer">
            <button
              type="button"
              className="dm-chat__delete-modal-btn"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeletingCurrentDeleteTarget}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="dm-chat__delete-modal-btn dm-chat__delete-modal-btn--danger"
              onClick={() => void handleConfirmDelete()}
              disabled={isDeletingCurrentDeleteTarget}
            >
              Excluir
            </button>
          </div>
        }
      >
        <p className="dm-chat__delete-modal-text">Tem certeza? Isso nao pode ser desfeito.</p>
      </Modal>
    </section>
  );
}

