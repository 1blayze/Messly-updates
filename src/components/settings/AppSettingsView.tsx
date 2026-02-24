import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useAuthSession } from "../../auth/AuthProvider";
import {
  getAvatarUrl,
  getBannerUrl,
  getDefaultAvatarUrl,
  getDefaultBannerUrl,
  getNameAvatarUrl,
} from "../../services/cdn/mediaUrls";
import {
  isProfileMediaUploadError,
  uploadProfileMediaAsset,
  type ProfileMediaKind,
} from "../../services/media/profileMediaUpload";
import { AVATAR_MAX_BYTES, AVATAR_MAX_MB, BANNER_MAX_BYTES, BANNER_MAX_MB } from "../../services/media/imageLimits";
import ImageEditModal from "../media/ImageEditModal";
import { PRESENCE_LABELS } from "../../services/presence/presenceTypes";
import { supabase } from "../../services/supabase";
import { escapeLikePattern, normalizeEmail } from "../../services/usernameAvailability";
import { DEFAULT_BANNER_COLOR, getBannerColorInputValue, normalizeBannerColor } from "../../services/profile/bannerColor";
import { ensureUser } from "../../services/userSync";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import Modal from "../ui/Modal";
import UserProfilePopover from "../UserProfilePopover/UserProfilePopover";
import styles from "./AppSettingsView.module.css";

interface AppSettingsViewProps {
  onClose: () => void;
  currentUserId?: string | null;
}

interface UploadFeedbackState {
  message: string;
  tone: "error" | "success";
}

interface PendingImageEdit {
  kind: ProfileMediaKind;
  file: File;
}

interface UploadLimitModalState {
  kind: ProfileMediaKind;
  maxMb: number;
}

interface ProfileUpdatedDetail {
  userId: string;
  display_name?: string | null;
  username?: string | null;
  about?: string | null;
  banner_color?: string | null;
}

interface BlockedAccountItem {
  userId: string;
  displayName: string;
  username: string;
  avatarSrc: string;
}

interface BlockedUserRow {
  id?: string | null;
  username?: string | null;
  display_name?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
}

interface UserProfileRow {
  id?: string | null;
  display_name?: string | null;
  username?: string | null;
  about?: string | null;
  banner_color?: string | null;
  avatar_url?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
}

type SettingsSection = "profile" | "social" | "audio" | "windows";

type ProfileMediaUpdatePayload = Record<string, string | null>;

const ABOUT_MAX_LENGTH = 190;
const USERS_MISSING_COLUMN_REGEX = /Could not find the '([^']+)' column of 'users' in the schema cache/i;
const PROFILE_MEDIA_COLUMNS = new Set(["avatar_key", "avatar_hash", "avatar_url", "banner_key", "banner_hash"]);
const OPTIONAL_PROFILE_COLUMNS = new Set(["banner_color"]);
const USER_PROFILE_SELECT_COLUMNS =
  "id,username,display_name,email,firebase_uid,about,banner_color,avatar_key,avatar_hash,avatar_url,banner_key,banner_hash";
const USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL =
  "id,username,display_name,email,firebase_uid,about,banner_color,avatar_key,avatar_hash,banner_key,banner_hash";
const USER_PROFILE_SELECT_COLUMNS_FALLBACK = "id,username,display_name,email,firebase_uid,about";
const BLOCKED_USERS_SELECT_COLUMNS = "id,username,display_name,avatar_key,avatar_hash,avatar_url";
const BLOCKED_USERS_SELECT_COLUMNS_FALLBACK = "id,username,display_name,avatar_key,avatar_hash";
const SIDEBAR_IDENTITY_CACHE_PREFIX = "messly:sidebar-identity:";
const SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX = "messly:sidebar-media:";
const AUDIO_SETTINGS_STORAGE_KEY_PREFIX = "messly:audio-settings:";
const DEFAULT_PUSH_TO_TALK_BIND = "V";
const DEFAULT_WINDOWS_BEHAVIOR_SETTINGS: WindowsBehaviorSettings = {
  startMinimized: true,
  closeToTray: true,
  launchAtStartup: true,
};

interface CachedSidebarIdentityFallback {
  displayName: string;
  username: string;
  about: string;
  avatarKey: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  bannerKey: string | null;
  bannerHash: string | null;
}

interface CachedSidebarResolvedMediaFallback {
  avatarSrc: string;
  bannerSrc: string;
}

interface PersistedAudioSettings {
  v: 1;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  vadEnabled: boolean;
  voiceFocus: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
  pushToTalkEnabled: boolean;
  pushToTalkBind: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildAudioSettingsStorageKey(userUid: string | null | undefined): string {
  const normalizedUid = String(userUid ?? "").trim();
  if (!normalizedUid) {
    return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}guest`;
  }
  return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}${normalizedUid}`;
}

function formatDeviceOptionLabel(rawLabel: string | null | undefined, fallback: string): string {
  const label = String(rawLabel ?? "").trim();
  return label.length > 0 ? label : fallback;
}

function normalizePushToTalkBind(rawValue: unknown): string {
  const value = String(rawValue ?? "").trim().toUpperCase();
  return value.length > 0 ? value : DEFAULT_PUSH_TO_TALK_BIND;
}

function formatKeyboardBinding(event: KeyboardEvent): string {
  const code = String(event.code ?? "").trim();
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toUpperCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  const key = String(event.key ?? "").trim();
  if (key.length === 1) {
    return key.toUpperCase();
  }
  if (key.toLowerCase() === " ") {
    return "SPACE";
  }
  if (key.toLowerCase() === "escape") {
    return "";
  }
  return key.toUpperCase();
}

function hsvToRgb(hue: number, saturation: number, value: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 100) / 100;
  const v = clamp(value, 0, 100) / 100;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h < 60) {
    rPrime = chroma;
    gPrime = x;
  } else if (h < 120) {
    rPrime = x;
    gPrime = chroma;
  } else if (h < 180) {
    gPrime = chroma;
    bPrime = x;
  } else if (h < 240) {
    gPrime = x;
    bPrime = chroma;
  } else if (h < 300) {
    rPrime = x;
    bPrime = chroma;
  } else {
    rPrime = chroma;
    bPrime = x;
  }

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255),
  };
}

function rgbToHsv(red: number, green: number, blue: number): { h: number; s: number; v: number } {
  const r = clamp(red, 0, 255) / 255;
  const g = clamp(green, 0, 255) / 255;
  const b = clamp(blue, 0, 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  if (h < 0) {
    h += 360;
  }

  const s = max === 0 ? 0 : (delta / max) * 100;
  const v = max * 100;

  return {
    h: clamp(h, 0, 360),
    s: clamp(s, 0, 100),
    v: clamp(v, 0, 100),
  };
}

function rgbToHex(red: number, green: number, blue: number): string {
  const toHex = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`.toLowerCase();
}

function hexToRgb(hexColor: string | null | undefined): { r: number; g: number; b: number } | null {
  const normalized = normalizeBannerColor(hexColor);
  if (!normalized) {
    return null;
  }

  const value = normalized.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function hexToHsv(hexColor: string | null | undefined): { h: number; s: number; v: number } {
  const rgb = hexToRgb(hexColor);
  if (!rgb) {
    return { h: 0, s: 0, v: 0 };
  }
  return rgbToHsv(rgb.r, rgb.g, rgb.b);
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

function getErrorMessage(error: unknown): string {
  if (isProfileMediaUploadError(error)) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: string }).message ?? "").trim();
    if (message) {
      if (message.includes("column of 'users' in the schema cache")) {
        return "Seu banco users ainda nao tem as colunas de midia. Rode a migracao de avatar/banner.";
      }
      if (message.includes("Profile media payload must be WebP.")) {
        return "Versao antiga do backend detectada. Reinicie o aplicativo.";
      }
      if (message.includes("No handler registered for 'media:upload-profile'")) {
        return "Reinicie o aplicativo para ativar o upload de avatar e banner.";
      }
      return message;
    }
  }

  return "Nao foi possivel concluir o upload agora.";
}

function getMissingUsersColumn(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }

  const message = String((error as { message?: string }).message ?? "");
  const match = message.match(USERS_MISSING_COLUMN_REGEX);
  if (!match) {
    return null;
  }

  const column = (match[1] ?? "").trim();
  return column || null;
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

    if (error || !Array.isArray(data)) {
      return new Map();
    }

    const map = new Map<string, string>();
    data.forEach((item) => {
      const userId = String((item as { user_id?: string | null }).user_id ?? "").trim();
      const avatarUrl = String((item as { avatar_url?: string | null }).avatar_url ?? "").trim();
      if (userId && avatarUrl) {
        map.set(userId, avatarUrl);
      }
    });
    return map;
  } catch {
    return new Map();
  }
}

function readSidebarIdentityFallback(firebaseUid: string | null | undefined): CachedSidebarIdentityFallback | null {
  if (!firebaseUid || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${SIDEBAR_IDENTITY_CACHE_PREFIX}${firebaseUid}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedSidebarIdentityFallback>;
    return {
      displayName: String(parsed.displayName ?? "").trim(),
      username: String(parsed.username ?? "").trim(),
      about: String(parsed.about ?? ""),
      avatarKey: String(parsed.avatarKey ?? "").trim() || null,
      avatarHash: String(parsed.avatarHash ?? "").trim() || null,
      avatarUrl: String(parsed.avatarUrl ?? "").trim() || null,
      bannerKey: String(parsed.bannerKey ?? "").trim() || null,
      bannerHash: String(parsed.bannerHash ?? "").trim() || null,
    };
  } catch {
    return null;
  }
}

function readSidebarResolvedMediaFallback(firebaseUid: string | null | undefined): CachedSidebarResolvedMediaFallback | null {
  if (!firebaseUid || typeof window === "undefined") {
    return null;
  }

  try {
    const key = `${SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX}${firebaseUid}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedSidebarResolvedMediaFallback>;
    const avatarSrc = String(parsed.avatarSrc ?? "").trim();
    const bannerSrc = String(parsed.bannerSrc ?? "").trim();
    if (!avatarSrc && !bannerSrc) {
      return null;
    }
    return { avatarSrc, bannerSrc };
  } catch {
    return null;
  }
}

async function queryUserByFirebaseUid(firebaseUid: string) {
  const primary = await supabase
    .from("users")
    .select(USER_PROFILE_SELECT_COLUMNS)
    .eq("firebase_uid", firebaseUid)
    .limit(1)
    .maybeSingle();

  if (primary.error && isMissingAvatarUrlColumnError(primary.error.message ?? "")) {
    const withoutAvatarUrl = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .eq("firebase_uid", firebaseUid)
      .limit(1)
      .maybeSingle();
    if (!withoutAvatarUrl.error) {
      return withoutAvatarUrl;
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

async function queryUserById(userId: string) {
  const primary = await supabase
    .from("users")
    .select(USER_PROFILE_SELECT_COLUMNS)
    .eq("id", userId)
    .limit(1)
    .maybeSingle();

  if (primary.error && isMissingAvatarUrlColumnError(primary.error.message ?? "")) {
    const withoutAvatarUrl = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
    if (!withoutAvatarUrl.error) {
      return withoutAvatarUrl;
    }
  }

  if (primary.error && isUsersSchemaColumnCacheError(primary.error.message ?? "")) {
    return supabase.from("users").select(USER_PROFILE_SELECT_COLUMNS_FALLBACK).eq("id", userId).limit(1).maybeSingle();
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
    const withoutAvatarUrl = await supabase
      .from("users")
      .select(USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL)
      .ilike("email", escapedEmail)
      .limit(1)
      .maybeSingle();
    if (!withoutAvatarUrl.error) {
      return withoutAvatarUrl;
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

async function updateUserMediaWithSchemaFallback(
  userId: string,
  updates: ProfileMediaUpdatePayload,
): Promise<ProfileMediaUpdatePayload> {
  const pendingUpdates: ProfileMediaUpdatePayload = { ...updates };

  while (Object.keys(pendingUpdates).length > 0) {
    const { error } = await supabase.from("users").update(pendingUpdates).eq("id", userId);
    if (!error) {
      return pendingUpdates;
    }

    const missingColumn = getMissingUsersColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(pendingUpdates, missingColumn) &&
      PROFILE_MEDIA_COLUMNS.has(missingColumn)
    ) {
      delete pendingUpdates[missingColumn];
      continue;
    }

    throw error;
  }

  throw new Error("Tabela users sem colunas de midia para salvar avatar/banner.");
}

async function updateUserProfileWithSchemaFallback(
  userId: string,
  updates: ProfileMediaUpdatePayload,
): Promise<ProfileMediaUpdatePayload> {
  const pendingUpdates: ProfileMediaUpdatePayload = { ...updates };

  while (Object.keys(pendingUpdates).length > 0) {
    const { error } = await supabase.from("users").update(pendingUpdates).eq("id", userId);
    if (!error) {
      return pendingUpdates;
    }

    const missingColumn = getMissingUsersColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(pendingUpdates, missingColumn) &&
      OPTIONAL_PROFILE_COLUMNS.has(missingColumn)
    ) {
      delete pendingUpdates[missingColumn];
      continue;
    }

    throw error;
  }

  throw new Error("Tabela users sem colunas de perfil para salvar.");
}

export default function AppSettingsView({ onClose, currentUserId = null }: AppSettingsViewProps) {
  const { user } = useAuthSession();
  const [activeSection, setActiveSection] = useState<SettingsSection>("profile");
  const [dbUserId, setDbUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("Nome");
  const [savedDisplayName, setSavedDisplayName] = useState("Nome");
  const [username, setUsername] = useState("username");
  const [about, setAbout] = useState("");
  const [savedAbout, setSavedAbout] = useState("");
  const [bannerColor, setBannerColor] = useState<string | null>(null);
  const [savedBannerColor, setSavedBannerColor] = useState<string | null>(null);
  const [bannerColorInput, setBannerColorInput] = useState(getBannerColorInputValue(null));
  const [bannerColorHue, setBannerColorHue] = useState(0);
  const [bannerColorSaturation, setBannerColorSaturation] = useState(0);
  const [bannerColorValue, setBannerColorValue] = useState(0);
  const [isBannerColorPickerOpen, setIsBannerColorPickerOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [avatarHash, setAvatarHash] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState<string | null>(null);
  const [bannerHash, setBannerHash] = useState<string | null>(null);
  const [avatarSrc, setAvatarSrc] = useState<string>("");
  const [bannerSrc, setBannerSrc] = useState<string>(getDefaultBannerUrl);
  const [isProfileIdentityLoading, setIsProfileIdentityLoading] = useState(true);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [isBannerUploading, setIsBannerUploading] = useState(false);
  const [avatarFeedback, setAvatarFeedback] = useState<UploadFeedbackState | null>(null);
  const [bannerFeedback, setBannerFeedback] = useState<UploadFeedbackState | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<UploadFeedbackState | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [pendingImageEdit, setPendingImageEdit] = useState<PendingImageEdit | null>(null);
  const [uploadLimitModal, setUploadLimitModal] = useState<UploadLimitModalState | null>(null);
  const [blockedAccounts, setBlockedAccounts] = useState<BlockedAccountItem[]>([]);
  const [isBlockedAccountsLoading, setIsBlockedAccountsLoading] = useState(false);
  const [blockedAccountsError, setBlockedAccountsError] = useState<string | null>(null);
  const [unblockingUserId, setUnblockingUserId] = useState<string | null>(null);
  const [windowsBehaviorSettings, setWindowsBehaviorSettings] = useState<WindowsBehaviorSettings>(
    DEFAULT_WINDOWS_BEHAVIOR_SETTINGS,
  );
  const [isWindowsBehaviorLoading, setIsWindowsBehaviorLoading] = useState(false);
  const [windowsBehaviorError, setWindowsBehaviorError] = useState<string | null>(null);
  const [savingWindowsBehaviorKey, setSavingWindowsBehaviorKey] = useState<keyof WindowsBehaviorSettings | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [inputGain, setInputGain] = useState(100);
  const [outputVolume, setOutputVolume] = useState(100);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [vadEnabled, setVadEnabled] = useState(true);
  const [voiceFocus, setVoiceFocus] = useState(false);
  const [autoMicSensitivity, setAutoMicSensitivity] = useState(true);
  const [manualMicSensitivity, setManualMicSensitivity] = useState(-70);
  const [pushToTalkEnabled, setPushToTalkEnabled] = useState(false);
  const [pushToTalkBind, setPushToTalkBind] = useState(DEFAULT_PUSH_TO_TALK_BIND);
  const [listeningForBind, setListeningForBind] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const [localMicLevel, setLocalMicLevel] = useState(0);
  const [localMicPeak, setLocalMicPeak] = useState(0);
  const [localMicClipping, setLocalMicClipping] = useState(false);
  const [micMeterHasSignal, setMicMeterHasSignal] = useState(false);
  const [vadState, setVadState] = useState<"speaking" | "silence">("silence");
  const bannerColorPickerRef = useRef<HTMLDivElement | null>(null);
  const bannerColorAreaRef = useRef<HTMLDivElement | null>(null);
  const temporaryAvatarUrlRef = useRef<string | null>(null);
  const temporaryBannerUrlRef = useRef<string | null>(null);
  const windowsBehaviorLoadedRef = useRef(false);
  const audioSettingsLoadedRef = useRef(false);
  const micTestAnimationFrameRef = useRef<number | null>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestAudioContextRef = useRef<AudioContext | null>(null);
  const micTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const micTestAnalyserDataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const inputGainRef = useRef(100);
  const vadEnabledRef = useRef(true);
  const autoMicSensitivityRef = useRef(true);
  const manualMicSensitivityRef = useRef(-70);
  const normalizedInputGain = clamp(Math.round(inputGain), 0, 100);
  const displayedMicSensitivity = autoMicSensitivity ? -40 : manualMicSensitivity;
  const audioSettingsStorageKey = useMemo(() => buildAudioSettingsStorageKey(user?.uid ?? null), [user?.uid]);
  const hasBannerMedia = useMemo(
    () =>
      Boolean(
        bannerKey ||
          bannerHash ||
          (bannerSrc && bannerSrc.trim().length > 0 && bannerSrc !== getDefaultBannerUrl()),
      ),
    [bannerHash, bannerKey, bannerSrc],
  );
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);
  const isWindowsDesktopRuntime = isDesktopRuntime && window.electronAPI?.platform === "win32";
  const canManageWindowsBehavior =
    isWindowsDesktopRuntime &&
    typeof window.electronAPI?.getWindowsSettings === "function" &&
    typeof window.electronAPI?.updateWindowsSettings === "function";

  const setTemporaryPreviewUrl = (kind: ProfileMediaKind, nextUrl: string): void => {
    if (kind === "avatar") {
      if (temporaryAvatarUrlRef.current) {
        URL.revokeObjectURL(temporaryAvatarUrlRef.current);
      }
      temporaryAvatarUrlRef.current = nextUrl;
      setAvatarSrc(nextUrl);
      return;
    }

    if (temporaryBannerUrlRef.current) {
      URL.revokeObjectURL(temporaryBannerUrlRef.current);
    }
    temporaryBannerUrlRef.current = nextUrl;
    setBannerSrc(nextUrl);
  };

  const clearTemporaryPreviewUrl = (kind: ProfileMediaKind): void => {
    if (kind === "avatar") {
      if (temporaryAvatarUrlRef.current) {
        URL.revokeObjectURL(temporaryAvatarUrlRef.current);
        temporaryAvatarUrlRef.current = null;
      }
      return;
    }

    if (temporaryBannerUrlRef.current) {
      URL.revokeObjectURL(temporaryBannerUrlRef.current);
      temporaryBannerUrlRef.current = null;
    }
  };

  const stopMicTest = (): void => {
    if (micTestAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(micTestAnimationFrameRef.current);
      micTestAnimationFrameRef.current = null;
    }

    micTestAnalyserDataRef.current = null;
    micTestAnalyserRef.current = null;

    if (micTestAudioContextRef.current) {
      void micTestAudioContextRef.current.close().catch(() => undefined);
      micTestAudioContextRef.current = null;
    }

    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach((track) => track.stop());
      micTestStreamRef.current = null;
    }

    setMicTestActive(false);
    setLocalMicLevel(0);
    setLocalMicPeak(0);
    setLocalMicClipping(false);
    setMicMeterHasSignal(false);
    setVadState("silence");
  };

  const refreshAudioDevices = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const hasMissingLabels = devices.some(
        (device) =>
          (device.kind === "audioinput" || device.kind === "audiooutput") &&
          String(device.label ?? "").trim().length === 0,
      );

      if (hasMissingLabels && navigator.mediaDevices?.getUserMedia) {
        try {
          const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          probeStream.getTracks().forEach((track) => track.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
          // Ignore permission errors and keep the best effort list.
        }
      }

      const nextInputs = devices.filter((device) => device.kind === "audioinput");
      const nextOutputs = devices.filter((device) => device.kind === "audiooutput");

      setAudioInputs(nextInputs);
      setAudioOutputs(nextOutputs);
      setSelectedInputId((current) =>
        current ||
        nextInputs[0]?.deviceId ||
        "",
      );
      setSelectedOutputId((current) =>
        current ||
        nextOutputs[0]?.deviceId ||
        "",
      );
    } catch {
      // Ignore enumerateDevices failures on unsupported environments.
    }
  };

  const startMicTest = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMicTestError("Teste de microfone indisponivel neste ambiente.");
      return;
    }

    stopMicTest();
    setMicTestError(null);

    const audioConstraints: MediaTrackConstraints = {
      noiseSuppression,
      echoCancellation,
      autoGainControl,
    };
    if (selectedInputId) {
      audioConstraints.deviceId = { exact: selectedInputId };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const analyserData = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));

      micTestStreamRef.current = stream;
      micTestAudioContextRef.current = audioContext;
      micTestAnalyserRef.current = analyser;
      micTestAnalyserDataRef.current = analyserData;
      setMicTestActive(true);

      let peakHold = 0;
      const tick = (): void => {
        const currentAnalyser = micTestAnalyserRef.current;
        const currentData = micTestAnalyserDataRef.current;
        if (!currentAnalyser || !currentData) {
          return;
        }

        currentAnalyser.getFloatTimeDomainData(currentData);

        let squared = 0;
        let peak = 0;
        for (let index = 0; index < currentData.length; index += 1) {
          const sample = currentData[index] ?? 0;
          const absolute = Math.abs(sample);
          squared += sample * sample;
          if (absolute > peak) {
            peak = absolute;
          }
        }

        const rms = Math.sqrt(squared / currentData.length);
        const gainScale = Math.max(0.1, inputGainRef.current / 100);
        const level = Math.min(1, rms * 5 * gainScale);
        peakHold = Math.max(peakHold * 0.9, peak);

        const sensitivityDb = clamp(manualMicSensitivityRef.current, -100, 0);
        const threshold = autoMicSensitivityRef.current ? 0.055 : 0.02 + ((sensitivityDb + 100) / 100) * 0.18;
        const speaking = vadEnabledRef.current ? rms >= threshold : false;
        const clipping = peak >= 0.985;

        setLocalMicLevel(level);
        setLocalMicPeak(Math.min(1, peakHold));
        setLocalMicClipping(clipping);
        setMicMeterHasSignal(level >= 0.04);
        setVadState(speaking ? "speaking" : "silence");

        micTestAnimationFrameRef.current = window.requestAnimationFrame(tick);
      };

      micTestAnimationFrameRef.current = window.requestAnimationFrame(tick);
    } catch {
      stopMicTest();
      setMicTestError("Nao foi possivel acessar o microfone para teste.");
    }
  };

  const handleMicTestToggle = (): void => {
    if (micTestActive) {
      stopMicTest();
      return;
    }
    void startMicTest();
  };

  const handlePushToTalkChange = (isEnabled: boolean): void => {
    setPushToTalkEnabled(isEnabled);
    if (!isEnabled) {
      setListeningForBind(false);
    }
  };

  const handleManualMicSensitivityChange = (value: number): void => {
    setManualMicSensitivity(clamp(Math.round(value), -100, 0));
  };

  useEffect(() => {
    const firebaseDisplayName = (user?.displayName ?? "").trim();
    if (!firebaseDisplayName) {
      return;
    }

    setDisplayName((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "Nome") {
        return current;
      }
      return firebaseDisplayName;
    });
    setSavedDisplayName((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "Nome") {
        return current;
      }
      return firebaseDisplayName;
    });
  }, [user?.displayName]);

  useEffect(() => {
    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      return;
    }
    setDbUserId((current) => (current && current.trim().length > 0 ? current : normalizedCurrentUserId));
  }, [currentUserId]);

  useEffect(() => {
    const normalizedColor = normalizeBannerColor(bannerColor) ?? DEFAULT_BANNER_COLOR;
    const nextHsv = hexToHsv(normalizedColor);
    setBannerColorHue(nextHsv.h);
    setBannerColorSaturation(nextHsv.s);
    setBannerColorValue(nextHsv.v);
  }, [bannerColor]);

  useEffect(() => {
    if (!isBannerColorPickerOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const pickerElement = bannerColorPickerRef.current;
      if (!pickerElement || !(event.target instanceof Node) || pickerElement.contains(event.target)) {
        return;
      }
      setIsBannerColorPickerOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsBannerColorPickerOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isBannerColorPickerOpen]);

  useEffect(() => {
    if (hasBannerMedia && isBannerColorPickerOpen) {
      setIsBannerColorPickerOpen(false);
    }
  }, [hasBannerMedia, isBannerColorPickerOpen]);

  useEffect(() => {
    return () => {
      if (temporaryAvatarUrlRef.current) {
        URL.revokeObjectURL(temporaryAvatarUrlRef.current);
      }
      if (temporaryBannerUrlRef.current) {
        URL.revokeObjectURL(temporaryBannerUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    inputGainRef.current = normalizedInputGain;
  }, [normalizedInputGain]);

  useEffect(() => {
    vadEnabledRef.current = vadEnabled;
  }, [vadEnabled]);

  useEffect(() => {
    autoMicSensitivityRef.current = autoMicSensitivity;
  }, [autoMicSensitivity]);

  useEffect(() => {
    manualMicSensitivityRef.current = manualMicSensitivity;
  }, [manualMicSensitivity]);

  useEffect(() => {
    if (typeof window === "undefined") {
      audioSettingsLoadedRef.current = true;
      return;
    }

    audioSettingsLoadedRef.current = false;
    try {
      const raw = window.localStorage.getItem(audioSettingsStorageKey);
      if (!raw) {
        audioSettingsLoadedRef.current = true;
        return;
      }

      const parsed = JSON.parse(raw) as Partial<PersistedAudioSettings> | null;
      if (!parsed || parsed.v !== 1) {
        audioSettingsLoadedRef.current = true;
        return;
      }

      const clampPercent = (value: unknown, fallback: number, max: number): number => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return fallback;
        }
        return clamp(Math.round(value), 0, max);
      };

      setSelectedInputId(typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : "");
      setSelectedOutputId(typeof parsed.outputDeviceId === "string" ? parsed.outputDeviceId : "");
      setInputGain(clampPercent(parsed.inputVolume, 100, 100));
      setOutputVolume(clampPercent(parsed.outputVolume, 100, 200));
      setNoiseSuppression(typeof parsed.noiseSuppression === "boolean" ? parsed.noiseSuppression : true);
      setEchoCancellation(typeof parsed.echoCancellation === "boolean" ? parsed.echoCancellation : true);
      setAutoGainControl(typeof parsed.autoGain === "boolean" ? parsed.autoGain : true);
      setVadEnabled(typeof parsed.vadEnabled === "boolean" ? parsed.vadEnabled : true);
      setVoiceFocus(typeof parsed.voiceFocus === "boolean" ? parsed.voiceFocus : false);
      setAutoMicSensitivity(typeof parsed.autoSensitivity === "boolean" ? parsed.autoSensitivity : true);
      if (typeof parsed.sensitivityDb === "number" && Number.isFinite(parsed.sensitivityDb)) {
        setManualMicSensitivity(clamp(Math.round(parsed.sensitivityDb), -100, 0));
      }
      setPushToTalkEnabled(typeof parsed.pushToTalkEnabled === "boolean" ? parsed.pushToTalkEnabled : false);
      setPushToTalkBind(normalizePushToTalkBind(parsed.pushToTalkBind));
    } catch {
      // Ignore invalid payload and use defaults.
    } finally {
      audioSettingsLoadedRef.current = true;
    }
  }, [audioSettingsStorageKey]);

  useEffect(() => {
    if (!audioSettingsLoadedRef.current || typeof window === "undefined") {
      return;
    }

    const payload: PersistedAudioSettings = {
      v: 1,
      inputDeviceId: selectedInputId,
      outputDeviceId: selectedOutputId,
      inputVolume: clamp(Math.round(inputGain), 0, 100),
      outputVolume: clamp(Math.round(outputVolume), 0, 200),
      noiseSuppression,
      echoCancellation,
      autoGain: autoGainControl,
      vadEnabled,
      voiceFocus,
      autoSensitivity: autoMicSensitivity,
      sensitivityDb: clamp(Math.round(manualMicSensitivity), -100, 0),
      pushToTalkEnabled,
      pushToTalkBind: normalizePushToTalkBind(pushToTalkBind),
    };

    try {
      window.localStorage.setItem(audioSettingsStorageKey, JSON.stringify(payload));
    } catch {
      // Ignore persistence errors.
    }
  }, [
    audioSettingsStorageKey,
    selectedInputId,
    selectedOutputId,
    inputGain,
    outputVolume,
    noiseSuppression,
    echoCancellation,
    autoGainControl,
    vadEnabled,
    voiceFocus,
    autoMicSensitivity,
    manualMicSensitivity,
    pushToTalkEnabled,
    pushToTalkBind,
  ]);

  useEffect(() => {
    if (activeSection !== "audio") {
      return;
    }

    void refreshAudioDevices();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) {
      return;
    }

    const handleDeviceChange = (): void => {
      void refreshAudioDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [activeSection]);

  useEffect(() => {
    if (!listeningForBind) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      const normalized = formatKeyboardBinding(event);
      if (!normalized) {
        setListeningForBind(false);
        return;
      }
      setPushToTalkBind(normalized);
      setListeningForBind(false);
    };

    const handleMouseDown = (event: MouseEvent): void => {
      event.preventDefault();
      if (event.button === 0) {
        setPushToTalkBind("MOUSE 1");
      } else if (event.button === 1) {
        setPushToTalkBind("MOUSE 2");
      } else {
        setPushToTalkBind(`MOUSE ${event.button + 1}`);
      }
      setListeningForBind(false);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("mousedown", handleMouseDown, { capture: true });
    };
  }, [listeningForBind]);

  useEffect(() => {
    if (activeSection === "audio") {
      return;
    }
    if (micTestActive) {
      stopMicTest();
    }
  }, [activeSection, micTestActive]);

  useEffect(
    () => () => {
      stopMicTest();
    },
    [],
  );

  useEffect(() => {
    const firebaseUid = user?.uid;
    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!firebaseUid && !normalizedCurrentUserId) {
      return;
    }
    const stableFirebaseUid: string | null = firebaseUid ?? null;
    const stableCurrentUserId = normalizedCurrentUserId || null;

    let isMounted = true;

    setIsProfileIdentityLoading(true);

    async function loadProfileFromDatabase(): Promise<void> {
      let data: UserProfileRow | null = null;
      const cachedIdentity = readSidebarIdentityFallback(stableFirebaseUid);
      const cachedMedia = readSidebarResolvedMediaFallback(stableFirebaseUid);

      if (isMounted && (cachedIdentity || cachedMedia)) {
        const cachedDisplayName = String(cachedIdentity?.displayName ?? "").trim();
        const cachedUsername = String(cachedIdentity?.username ?? "").trim();
        const cachedAbout = String(cachedIdentity?.about ?? "").slice(0, ABOUT_MAX_LENGTH);
        const cachedAvatarKey = String(cachedIdentity?.avatarKey ?? "").trim() || null;
        const cachedAvatarHash = String(cachedIdentity?.avatarHash ?? "").trim() || null;
        const cachedAvatarUrl = String(cachedIdentity?.avatarUrl ?? cachedMedia?.avatarSrc ?? "").trim() || null;
        const cachedBannerKey = String(cachedIdentity?.bannerKey ?? "").trim() || null;
        const cachedBannerHash = String(cachedIdentity?.bannerHash ?? "").trim() || null;
        const cachedBannerSrc = String(cachedMedia?.bannerSrc ?? "").trim();

        if (cachedDisplayName) {
          setDisplayName(cachedDisplayName);
          setSavedDisplayName(cachedDisplayName);
        }
        if (cachedUsername) {
          setUsername(cachedUsername);
        }
        if (cachedAbout) {
          setAbout(cachedAbout);
          setSavedAbout(cachedAbout);
        }
        if (cachedAvatarKey) {
          setAvatarKey(cachedAvatarKey);
        }
        if (cachedAvatarHash) {
          setAvatarHash(cachedAvatarHash);
        }
        if (cachedAvatarUrl) {
          setAvatarUrl(cachedAvatarUrl);
          if (!cachedAvatarUrl.startsWith("http") && !cachedAvatarUrl.startsWith("blob:")) {
            setAvatarSrc(cachedAvatarUrl);
          }
        }
        if (cachedBannerKey) {
          setBannerKey(cachedBannerKey);
        }
        if (cachedBannerHash) {
          setBannerHash(cachedBannerHash);
        }
        if (cachedBannerSrc) {
          setBannerSrc(cachedBannerSrc);
        }
      }

      if (stableCurrentUserId) {
        const byIdResult = await queryUserById(stableCurrentUserId);
        if (!byIdResult.error) {
          data = byIdResult.data as UserProfileRow | null;
        }
      }

      if (!isMounted) {
        return;
      }

      if (!data && stableFirebaseUid) {
        const { data: byUid, error: byUidError } = await queryUserByFirebaseUid(stableFirebaseUid);
        if (!byUidError) {
          data = byUid as UserProfileRow | null;
        }
      }

      if (!data && stableFirebaseUid) {
        const normalizedEmail = normalizeEmail(user?.email ?? "");
        if (normalizedEmail) {
          const { data: byEmail, error: emailError } = await queryUserByEmail(normalizedEmail);
          if (!emailError) {
            data = byEmail as UserProfileRow | null;
          }
        }
      }

      if (!data) {
        try {
          if (user) {
            const ensuredUser = await ensureUser(user);
            data = (ensuredUser as unknown as UserProfileRow) ?? null;
          }
        } catch {
          // Keep fallback display values if user sync is unavailable.
        }
      }

      if (!data) {
        const emailUsername = String(user?.email ?? "").trim().split("@")[0]?.trim() || "username";
        const uidUsername = String(user?.uid ?? "").trim().slice(0, 12);
        const fallbackUsername = cachedIdentity?.username || emailUsername || uidUsername || "username";
        const fallbackDisplayName = cachedIdentity?.displayName || (user?.displayName ?? "").trim() || fallbackUsername || "Nome";
        const fallbackAbout = String(cachedIdentity?.about ?? "").slice(0, ABOUT_MAX_LENGTH);
        const fallbackAvatarSource =
          cachedIdentity?.avatarKey ?? cachedIdentity?.avatarUrl ?? cachedMedia?.avatarSrc ?? null;
        const fallbackBannerSource = cachedIdentity?.bannerKey ?? cachedMedia?.bannerSrc ?? null;

        if (stableCurrentUserId) {
          setDbUserId(stableCurrentUserId);
        }
        setDisplayName(fallbackDisplayName);
        setSavedDisplayName(fallbackDisplayName);
        setUsername(fallbackUsername);
        setAbout(fallbackAbout);
        setSavedAbout(fallbackAbout);
        setAvatarKey(String(cachedIdentity?.avatarKey ?? "").trim() || null);
        setAvatarHash(String(cachedIdentity?.avatarHash ?? "").trim() || null);
        setAvatarUrl(String(fallbackAvatarSource ?? "").trim() || null);
        setBannerKey(String(fallbackBannerSource ?? "").trim() || null);
        setBannerHash(String(cachedIdentity?.bannerHash ?? "").trim() || null);
        if (cachedMedia?.avatarSrc) {
          setAvatarSrc(cachedMedia.avatarSrc);
        }
        if (cachedMedia?.bannerSrc) {
          setBannerSrc(cachedMedia.bannerSrc);
        }
        setIsProfileIdentityLoading(false);
        return;
      }
      const row = data as UserProfileRow;

      setDbUserId(row.id ?? null);
      const emailUsername = String(user?.email ?? "").trim().split("@")[0]?.trim() || "";
      const uidUsername = String(user?.uid ?? "").trim().slice(0, 12);
      const resolvedUsername = (row.username ?? "").trim() || emailUsername || uidUsername || "username";
      const resolvedDisplayName =
        (row.display_name ?? "").trim() ||
        resolvedUsername ||
        (user?.displayName ?? "").trim() ||
        "Nome";
      const resolvedAbout = (row.about ?? "").slice(0, ABOUT_MAX_LENGTH);
      const resolvedBannerColor = normalizeBannerColor(row.banner_color) ?? null;
      setDisplayName(resolvedDisplayName);
      setSavedDisplayName(resolvedDisplayName);
      setUsername(resolvedUsername);
      setAbout(resolvedAbout);
      setSavedAbout(resolvedAbout);
      setBannerColor(resolvedBannerColor);
      setSavedBannerColor(resolvedBannerColor);
      setBannerColorInput(getBannerColorInputValue(resolvedBannerColor));
      setAvatarUrl((row.avatar_url ?? "").trim() || null);
      setAvatarKey((row.avatar_key ?? "").trim() || null);
      setAvatarHash((row.avatar_hash ?? "").trim() || null);
      setBannerKey((row.banner_key ?? "").trim() || null);
      setBannerHash((row.banner_hash ?? "").trim() || null);
      setIsProfileIdentityLoading(false);
    }

    void loadProfileFromDatabase().catch(() => {
      if (isMounted) {
        setIsProfileIdentityLoading(false);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [currentUserId, user?.displayName, user?.email, user?.uid]);

  useEffect(() => {
    if (activeSection !== "social") {
      return;
    }

    if (!dbUserId) {
      setBlockedAccounts([]);
      setBlockedAccountsError("Usuario ainda nao sincronizado.");
      return;
    }

    let isMounted = true;

    async function loadBlockedAccounts(): Promise<void> {
      setIsBlockedAccountsLoading(true);
      setBlockedAccountsError(null);

      const { data: blocksData, error: blocksError } = await supabase
        .from("user_blocks")
        .select("blocked_id,created_at")
        .eq("blocker_id", dbUserId)
        .order("created_at", { ascending: false });

      if (!isMounted) {
        return;
      }

      if (blocksError) {
        setBlockedAccounts([]);
        setBlockedAccountsError(
          isUserBlocksUnavailableError(blocksError)
            ? "Tabela user_blocks indisponivel no banco."
            : "Nao foi possivel carregar contas bloqueadas.",
        );
        setIsBlockedAccountsLoading(false);
        return;
      }

      const blocks = (Array.isArray(blocksData) ? blocksData : []) as Array<{
        blocked_id?: string | null;
        created_at?: string | null;
      }>;

      const blockedIds = blocks
        .map((item) => String(item.blocked_id ?? "").trim())
        .filter((value): value is string => value.length > 0);

      if (blockedIds.length === 0) {
        setBlockedAccounts([]);
        setIsBlockedAccountsLoading(false);
        return;
      }

      const { data: usersData, error: usersError } = await supabase
        .from("users")
        .select(BLOCKED_USERS_SELECT_COLUMNS)
        .in("id", blockedIds);

      let resolvedUsersData = usersData as BlockedUserRow[] | null;
      let resolvedUsersError = usersError;

      if (resolvedUsersError) {
        const message = String(resolvedUsersError.message ?? "");
        if (isUsersSchemaColumnCacheError(message) || isMissingAvatarUrlColumnError(message)) {
          const fallbackUsersResult = await supabase
            .from("users")
            .select(BLOCKED_USERS_SELECT_COLUMNS_FALLBACK)
            .in("id", blockedIds);
          resolvedUsersData = fallbackUsersResult.data as BlockedUserRow[] | null;
          resolvedUsersError = fallbackUsersResult.error;
        }
      }

      if (!isMounted) {
        return;
      }

      if (resolvedUsersError) {
        setBlockedAccounts([]);
        setBlockedAccountsError("Nao foi possivel carregar os perfis bloqueados.");
        setIsBlockedAccountsLoading(false);
        return;
      }

      const users = Array.isArray(resolvedUsersData) ? resolvedUsersData : [];
      const usersById = new Map<string, (typeof users)[number]>();
      users.forEach((item) => {
        const userId = String(item.id ?? "").trim();
        if (userId) {
          usersById.set(userId, item);
        }
      });

      const legacyAvatarMap = await loadLegacyAvatarMap(blockedIds);

      const resolvedItems = await Promise.all(
        blockedIds.map(async (blockedId) => {
          const userRow = usersById.get(blockedId);
          const resolvedUsername = String(userRow?.username ?? "").trim() || "username";
          const resolvedDisplayName = String(userRow?.display_name ?? "").trim() || resolvedUsername;
          const legacyAvatarUrl =
            String(userRow?.avatar_url ?? "").trim() || String(legacyAvatarMap.get(blockedId) ?? "").trim();
          const avatarSource = String(userRow?.avatar_key ?? "").trim() || legacyAvatarUrl || null;

          let resolvedAvatar = await getAvatarUrl(blockedId, avatarSource, userRow?.avatar_hash ?? null);
          if (resolvedAvatar === getDefaultAvatarUrl() && legacyAvatarUrl) {
            const resolvedLegacyAvatar = await getAvatarUrl(blockedId, legacyAvatarUrl, userRow?.avatar_hash ?? null);
            if (resolvedLegacyAvatar !== getDefaultAvatarUrl()) {
              resolvedAvatar = resolvedLegacyAvatar;
            }
          }

          const fallbackAvatar = getNameAvatarUrl(resolvedDisplayName || resolvedUsername || "U");

          return {
            userId: blockedId,
            username: resolvedUsername,
            displayName: resolvedDisplayName,
            avatarSrc: resolvedAvatar === getDefaultAvatarUrl() ? fallbackAvatar : resolvedAvatar,
          } satisfies BlockedAccountItem;
        }),
      );

      if (!isMounted) {
        return;
      }

      setBlockedAccounts(resolvedItems);
      setIsBlockedAccountsLoading(false);
    }

    void loadBlockedAccounts();

    return () => {
      isMounted = false;
    };
  }, [activeSection, dbUserId]);

  useEffect(() => {
    if (activeSection !== "windows") {
      return;
    }

    if (!isWindowsDesktopRuntime) {
      setWindowsBehaviorError("Disponivel apenas no aplicativo desktop para Windows.");
      return;
    }

    if (!canManageWindowsBehavior || windowsBehaviorLoadedRef.current) {
      return;
    }

    let isMounted = true;
    setIsWindowsBehaviorLoading(true);
    setWindowsBehaviorError(null);

    void window.electronAPI
      ?.getWindowsSettings?.()
      .then((settings) => {
        if (!isMounted || !settings) {
          return;
        }
        windowsBehaviorLoadedRef.current = true;
        setWindowsBehaviorSettings({
          startMinimized: Boolean(settings.startMinimized),
          closeToTray: Boolean(settings.closeToTray),
          launchAtStartup: Boolean(settings.launchAtStartup),
        });
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        setWindowsBehaviorError("Nao foi possivel carregar as configuracoes do Windows.");
      })
      .finally(() => {
        if (!isMounted) {
          return;
        }
        setIsWindowsBehaviorLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeSection, canManageWindowsBehavior, isWindowsDesktopRuntime]);

  const safeUsername = useMemo(() => username.trim() || "username", [username]);
  const safeDisplayName = useMemo(() => displayName.trim() || safeUsername || "Nome", [displayName, safeUsername]);
  const safeAbout = useMemo(() => about.trim(), [about]);
  const micMeterBars = useMemo(
    () =>
      Array.from({ length: 20 }, (_, index) => {
        const ramp = 1 - index / 24;
        const levelContribution = localMicLevel * 1.15;
        const peakContribution = localMicPeak * 0.35;
        return clamp(levelContribution * ramp + peakContribution * 0.22, 0.08, 1);
      }),
    [localMicLevel, localMicPeak],
  );
  const safeBannerColor = useMemo(() => normalizeBannerColor(bannerColor), [bannerColor]);
  const bannerColorSwatch = useMemo(
    () => normalizeBannerColor(bannerColor) ?? normalizeBannerColor(savedBannerColor) ?? DEFAULT_BANNER_COLOR,
    [bannerColor, savedBannerColor],
  );
  const hasUnsavedProfileChanges = useMemo(
    () =>
      displayName.trim() !== savedDisplayName.trim() ||
      about !== savedAbout ||
      normalizeBannerColor(bannerColor) !== normalizeBannerColor(savedBannerColor),
    [about, bannerColor, displayName, savedAbout, savedBannerColor, savedDisplayName],
  );
  const aboutCount = about.length;
  const isEyeDropperSupported = typeof window !== "undefined" && "EyeDropper" in window;
  const blockedAccountsCountLabel = useMemo(() => {
    const count = blockedAccounts.length;
    return count === 1 ? "1 conta" : `${count} contas`;
  }, [blockedAccounts.length]);

  const handleResetProfileDraft = (): void => {
    setDisplayName(savedDisplayName);
    setAbout(savedAbout);
    setBannerColor(savedBannerColor);
    setBannerColorInput(getBannerColorInputValue(savedBannerColor));
    setProfileFeedback(null);
  };

  const handleBannerColorSelect = (rawValue: string): void => {
    const normalized = normalizeBannerColor(rawValue);
    if (!normalized) {
      return;
    }

    setBannerColor(normalized);
    setBannerColorInput(normalized.toUpperCase());
    setProfileFeedback(null);
  };

  const handleBannerColorInputChange = (rawValue: string): void => {
    const sanitized = rawValue
      .trim()
      .replace(/[^#0-9a-fA-F]/g, "")
      .slice(0, 7)
      .toUpperCase();
    setBannerColorInput(sanitized);

    const normalized = normalizeBannerColor(sanitized);
    if (normalized) {
      setBannerColor(normalized);
      setProfileFeedback(null);
    }
  };

  const handleWindowsBehaviorToggle = async (
    key: keyof WindowsBehaviorSettings,
    nextValue: boolean,
  ): Promise<void> => {
    if (!canManageWindowsBehavior || !window.electronAPI?.updateWindowsSettings) {
      return;
    }

    const previous = windowsBehaviorSettings;
    const optimistic = {
      ...previous,
      [key]: nextValue,
    };
    setWindowsBehaviorSettings(optimistic);
    setSavingWindowsBehaviorKey(key);
    setWindowsBehaviorError(null);

    try {
      const updated = await window.electronAPI.updateWindowsSettings({ [key]: nextValue });
      setWindowsBehaviorSettings({
        startMinimized: Boolean(updated.startMinimized),
        closeToTray: Boolean(updated.closeToTray),
        launchAtStartup: Boolean(updated.launchAtStartup),
      });
      windowsBehaviorLoadedRef.current = true;
    } catch {
      setWindowsBehaviorSettings(previous);
      setWindowsBehaviorError("Nao foi possivel salvar a configuracao do Windows.");
    } finally {
      setSavingWindowsBehaviorKey((current) => (current === key ? null : current));
    }
  };

  const handleBannerColorInputBlur = (): void => {
    const normalized = normalizeBannerColor(bannerColorInput);
    if (normalized) {
      setBannerColor(normalized);
      setBannerColorInput(normalized.toUpperCase());
      return;
    }

    setBannerColorInput(getBannerColorInputValue(bannerColor));
  };

  const updateBannerColorFromArea = (clientX: number, clientY: number): void => {
    const pickerArea = bannerColorAreaRef.current;
    if (!pickerArea) {
      return;
    }

    const bounds = pickerArea.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const x = clamp(clientX - bounds.left, 0, bounds.width);
    const y = clamp(clientY - bounds.top, 0, bounds.height);
    const nextSaturation = (x / bounds.width) * 100;
    const nextValue = 100 - (y / bounds.height) * 100;
    const rgb = hsvToRgb(bannerColorHue, nextSaturation, nextValue);
    const nextColor = rgbToHex(rgb.r, rgb.g, rgb.b);

    setBannerColor(nextColor);
    setBannerColorInput(nextColor.toUpperCase());
    setProfileFeedback(null);
  };

  const handleBannerColorAreaPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateBannerColorFromArea(event.clientX, event.clientY);
  };

  const handleBannerColorAreaPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateBannerColorFromArea(event.clientX, event.clientY);
  };

  const handleBannerColorAreaPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleBannerHueChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const parsedHue = Number.parseFloat(event.target.value);
    const nextHue = Number.isFinite(parsedHue) ? clamp(parsedHue, 0, 360) : 0;
    const rgb = hsvToRgb(nextHue, bannerColorSaturation, bannerColorValue);
    const nextColor = rgbToHex(rgb.r, rgb.g, rgb.b);
    setBannerColor(nextColor);
    setBannerColorInput(nextColor.toUpperCase());
    setProfileFeedback(null);
  };

  const handleBannerColorEyedropperClick = async (): Promise<void> => {
    if (typeof window === "undefined") {
      return;
    }

    const eyeDropperCtor = (
      window as Window & {
        EyeDropper?: new () => {
          open: () => Promise<{ sRGBHex?: string }>;
        };
      }
    ).EyeDropper;

    if (!eyeDropperCtor) {
      return;
    }

    try {
      const picker = new eyeDropperCtor();
      const result = await picker.open();
      if (result?.sRGBHex) {
        handleBannerColorSelect(result.sRGBHex);
      }
    } catch {
      // Ignore cancellations from the color picker API.
    }
  };

  const handleUnblockAccount = async (blockedUserId: string): Promise<void> => {
    if (!dbUserId || !blockedUserId || unblockingUserId) {
      return;
    }

    setUnblockingUserId(blockedUserId);
    setBlockedAccountsError(null);
    const { error } = await supabase
      .from("user_blocks")
      .delete()
      .eq("blocker_id", dbUserId)
      .eq("blocked_id", blockedUserId);

    if (error) {
      setBlockedAccountsError(
        isUserBlocksUnavailableError(error)
          ? "Tabela user_blocks indisponivel no banco."
          : "Nao foi possivel desbloquear usuario.",
      );
      setUnblockingUserId(null);
      return;
    }

    setBlockedAccounts((current) => current.filter((item) => item.userId !== blockedUserId));
    setUnblockingUserId(null);
  };

  const handleSaveProfileDraft = async (): Promise<void> => {
    if (!dbUserId) {
      setProfileFeedback({
        tone: "error",
        message: "Usuario ainda nao sincronizado. Reabra as configuracoes e tente novamente.",
      });
      return;
    }

    const nextDisplayName = displayName.trim() || safeUsername || "Nome";
    const nextAbout = about.slice(0, ABOUT_MAX_LENGTH);
    const nextBannerColor = normalizeBannerColor(bannerColor) ?? null;

    setIsSavingProfile(true);
    setProfileFeedback(null);
    try {
      const persistedUpdates = await updateUserProfileWithSchemaFallback(dbUserId, {
        display_name: nextDisplayName,
        about: nextAbout || null,
        banner_color: nextBannerColor,
      });
      const didPersistBannerColor = Object.prototype.hasOwnProperty.call(persistedUpdates, "banner_color");
      const effectiveBannerColor = didPersistBannerColor ? nextBannerColor : savedBannerColor;

      setDisplayName(nextDisplayName);
      setSavedDisplayName(nextDisplayName);
      setAbout(nextAbout);
      setSavedAbout(nextAbout);
      setBannerColor(effectiveBannerColor);
      setSavedBannerColor(effectiveBannerColor);
      setBannerColorInput(getBannerColorInputValue(effectiveBannerColor));
      const profileUpdateDetail: ProfileUpdatedDetail = {
        userId: dbUserId,
        display_name: nextDisplayName,
        username: safeUsername,
        about: nextAbout || null,
      };
      if (didPersistBannerColor) {
        profileUpdateDetail.banner_color = nextBannerColor;
      }
      publishProfileUpdated(profileUpdateDetail);

      if (!didPersistBannerColor) {
        setProfileFeedback({
          tone: "error",
          message: "A coluna banner_color nao existe no banco. Rode a migracao para sincronizar a cor da faixa para todos.",
        });
      }
    } catch (error) {
      setProfileFeedback({
        tone: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setIsSavingProfile(false);
    }
  };

  useEffect(() => {
    let isMounted = true;

    const avatarSource = avatarKey ?? avatarUrl;
    const hasAvatarSource = Boolean(String(avatarSource ?? "").trim());

    void getAvatarUrl(dbUserId, avatarSource, avatarHash).then((url) => {
      if (isMounted) {
        const resolvedUrl = String(url ?? "").trim() || getDefaultAvatarUrl();
        if (temporaryAvatarUrlRef.current && url !== temporaryAvatarUrlRef.current) {
          URL.revokeObjectURL(temporaryAvatarUrlRef.current);
          temporaryAvatarUrlRef.current = null;
        }
        setAvatarSrc((current) => {
          if (current === resolvedUrl || (resolvedUrl === getDefaultAvatarUrl() && current === "")) {
            return current;
          }
          if (hasAvatarSource && resolvedUrl === getDefaultAvatarUrl() && current && current !== getDefaultAvatarUrl()) {
            return current;
          }
          return resolvedUrl === getDefaultAvatarUrl() ? "" : resolvedUrl;
        });
      }
    });

    return () => {
      isMounted = false;
    };
  }, [avatarHash, avatarKey, avatarUrl, dbUserId]);

  useEffect(() => {
    let isMounted = true;

    void getBannerUrl(dbUserId, bannerKey, bannerHash).then((url) => {
      if (isMounted) {
        if (bannerKey && url === getDefaultBannerUrl()) {
          return;
        }
        if (temporaryBannerUrlRef.current && url !== temporaryBannerUrlRef.current) {
          URL.revokeObjectURL(temporaryBannerUrlRef.current);
          temporaryBannerUrlRef.current = null;
        }
        setBannerSrc(url);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [bannerHash, bannerKey, dbUserId]);

  const canUploadMedia = Boolean(dbUserId);

  const publishProfileMediaChange = (detail: {
    userId: string;
    avatar_key?: string | null;
    avatar_hash?: string | null;
    avatar_url?: string | null;
    banner_key?: string | null;
    banner_hash?: string | null;
  }): void => {
    window.dispatchEvent(new CustomEvent("messly:profile-media-updated", { detail }));
  };

  const publishProfileUpdated = (detail: ProfileUpdatedDetail): void => {
    window.dispatchEvent(new CustomEvent<ProfileUpdatedDetail>("messly:profile-updated", { detail }));
  };

  const uploadProfileMedia = async (kind: ProfileMediaKind, file: File): Promise<boolean> => {
    if (!dbUserId) {
      const noSessionFeedback: UploadFeedbackState = {
        tone: "error",
        message: "Usuario ainda nao sincronizado. Reabra as configuracoes e tente novamente.",
      };

      if (kind === "avatar") {
        setAvatarFeedback(noSessionFeedback);
      } else {
        setBannerFeedback(noSessionFeedback);
      }
      return false;
    }

    if (kind === "avatar") {
      setIsAvatarUploading(true);
      setAvatarFeedback(null);
    } else {
      setIsBannerUploading(true);
      setBannerFeedback(null);
    }

    try {
      const uploaded = await uploadProfileMediaAsset(kind, dbUserId, file);
      const updates: ProfileMediaUpdatePayload =
        kind === "avatar"
          ? {
              avatar_key: uploaded.key,
              avatar_hash: uploaded.hash,
              avatar_url: null,
            }
          : {
              banner_key: uploaded.key,
              banner_hash: uploaded.hash,
            };

      const appliedUpdates = await updateUserMediaWithSchemaFallback(dbUserId, updates);

      if (kind === "avatar" && !Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")) {
        throw new Error("A coluna avatar_key nao existe na tabela users.");
      }

      if (kind === "banner" && !Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")) {
        throw new Error("A coluna banner_key nao existe na tabela users.");
      }

      if (kind === "avatar") {
        setAvatarKey(Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key") ? uploaded.key : null);
        setAvatarHash(Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_hash") ? uploaded.hash : null);
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_url")) {
          setAvatarUrl(null);
        }
        setTemporaryPreviewUrl("avatar", URL.createObjectURL(file));
        setAvatarFeedback(null);
      } else {
        setBannerKey(Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key") ? uploaded.key : null);
        setBannerHash(Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_hash") ? uploaded.hash : null);
        setTemporaryPreviewUrl("banner", URL.createObjectURL(file));
        setBannerFeedback(null);
      }

      const detail: {
        userId: string;
        avatar_key?: string | null;
        avatar_hash?: string | null;
        avatar_url?: string | null;
        banner_key?: string | null;
        banner_hash?: string | null;
      } = {
        userId: dbUserId,
      };

      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")) {
        detail.avatar_key = uploaded.key;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_hash")) {
        detail.avatar_hash = uploaded.hash;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_url")) {
        detail.avatar_url = null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")) {
        detail.banner_key = uploaded.key;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_hash")) {
        detail.banner_hash = uploaded.hash;
      }

      publishProfileMediaChange(detail);
      return true;
    } catch (error) {
      const feedback: UploadFeedbackState = {
        tone: "error",
        message: getErrorMessage(error),
      };

      if (kind === "avatar") {
        setAvatarFeedback(feedback);
      } else {
        setBannerFeedback(feedback);
      }
      return false;
    } finally {
      if (kind === "avatar") {
        setIsAvatarUploading(false);
      } else {
        setIsBannerUploading(false);
      }
    }
  };

  const removeProfileMedia = async (kind: ProfileMediaKind): Promise<void> => {
    if (!dbUserId) {
      const noSessionFeedback: UploadFeedbackState = {
        tone: "error",
        message: "Usuario ainda nao sincronizado. Reabra as configuracoes e tente novamente.",
      };
      if (kind === "avatar") {
        setAvatarFeedback(noSessionFeedback);
      } else {
        setBannerFeedback(noSessionFeedback);
      }
      return;
    }

    if (kind === "avatar") {
      setIsAvatarUploading(true);
      setAvatarFeedback(null);
    } else {
      setIsBannerUploading(true);
      setBannerFeedback(null);
    }

    try {
      const updates: ProfileMediaUpdatePayload =
        kind === "avatar"
          ? {
              avatar_key: null,
              avatar_hash: null,
              avatar_url: null,
            }
          : {
              banner_key: null,
              banner_hash: null,
            };

      const appliedUpdates = await updateUserMediaWithSchemaFallback(dbUserId, updates);

      if (kind === "avatar") {
        clearTemporaryPreviewUrl("avatar");
        setAvatarKey(null);
        setAvatarHash(null);
        setAvatarUrl(null);
        setAvatarSrc("");
        setAvatarFeedback(null);
      } else {
        clearTemporaryPreviewUrl("banner");
        setBannerKey(null);
        setBannerHash(null);
        setBannerSrc(getDefaultBannerUrl());
        setBannerFeedback(null);
      }

      const detail: {
        userId: string;
        avatar_key?: string | null;
        avatar_hash?: string | null;
        avatar_url?: string | null;
        banner_key?: string | null;
        banner_hash?: string | null;
      } = { userId: dbUserId };

      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")) {
        detail.avatar_key = null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_hash")) {
        detail.avatar_hash = null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_url")) {
        detail.avatar_url = null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")) {
        detail.banner_key = null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_hash")) {
        detail.banner_hash = null;
      }

      publishProfileMediaChange(detail);
    } catch (error) {
      const feedback: UploadFeedbackState = {
        tone: "error",
        message: getErrorMessage(error),
      };

      if (kind === "avatar") {
        setAvatarFeedback(feedback);
      } else {
        setBannerFeedback(feedback);
      }
    } finally {
      if (kind === "avatar") {
        setIsAvatarUploading(false);
      } else {
        setIsBannerUploading(false);
      }
    }
  };

  const handleProfileMediaFileChange = (kind: ProfileMediaKind, event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (kind === "avatar") {
      setAvatarFeedback(null);
    } else {
      setBannerFeedback(null);
    }

    const maxBytes = kind === "avatar" ? AVATAR_MAX_BYTES : BANNER_MAX_BYTES;
    const maxMb = kind === "avatar" ? AVATAR_MAX_MB : BANNER_MAX_MB;
    if (file.size > maxBytes) {
      setUploadLimitModal({ kind, maxMb });
      return;
    }

    // Send GIFs directly to preserve animation (avatar + banner).
    if (file.type.toLowerCase() === "image/gif") {
      void uploadProfileMedia(kind, file);
      return;
    }

    setPendingImageEdit({ kind, file });
  };

  const handleApplyEditedImage = async (editedFile: File): Promise<void> => {
    if (!pendingImageEdit) {
      return;
    }

    const uploadCompleted = await uploadProfileMedia(pendingImageEdit.kind, editedFile);
    if (uploadCompleted) {
      setPendingImageEdit(null);
    }
  };

  const isImageEditorApplying =
    pendingImageEdit?.kind === "avatar"
      ? isAvatarUploading
      : pendingImageEdit?.kind === "banner"
        ? isBannerUploading
        : false;
  const hasAvatarMedia = Boolean(
    avatarKey || avatarHash || avatarUrl || (avatarSrc && avatarSrc.trim().length > 0 && avatarSrc !== getDefaultAvatarUrl()),
  );
  const shouldSuppressPreviewBannerColor = isProfileIdentityLoading || hasBannerMedia || Boolean(bannerHash);

  return (
    <>
      <section className={styles.settings} aria-label="Configuracoes do aplicativo">
        <header className={styles.header}>
          <div className={styles.headerInfo}>
            <h2 className={styles.title}>Configuracoes do aplicativo</h2>
            <p className={styles.subtitle}>Ajuste preferencias visuais e de comportamento do Messly.</p>
          </div>

          <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Fechar configuracoes">
            <MaterialSymbolIcon name="close" size={18} filled={false} />
          </button>
        </header>

        <div className={styles.grid}>
          <aside className={styles.menu} aria-label="Categorias">
            <button
              className={`${styles.menuItem}${activeSection === "profile" ? ` ${styles.menuItemActive}` : ""}`}
              type="button"
              onClick={() => setActiveSection("profile")}
            >
              Editar perfil
            </button>
            <button
              className={`${styles.menuItem}${activeSection === "social" ? ` ${styles.menuItemActive}` : ""}`}
              type="button"
              onClick={() => setActiveSection("social")}
            >
              Conteudo social
            </button>
            <button
              className={`${styles.menuItem}${activeSection === "audio" ? ` ${styles.menuItemActive}` : ""}`}
              type="button"
              onClick={() => setActiveSection("audio")}
            >
              Audio
            </button>
            <button
              className={`${styles.menuItem}${activeSection === "windows" ? ` ${styles.menuItemActive}` : ""}`}
              type="button"
              onClick={() => setActiveSection("windows")}
            >
              Windows
            </button>
          </aside>

          <div className={styles.panel}>
            {activeSection === "profile" ? (
            <div
              className={`${styles.profileEditor}${hasUnsavedProfileChanges ? ` ${styles.profileEditorWithUnsaved}` : ""}`}
            >
              <div className={styles.editorHeader}>
                <h3 className={styles.editorTitle}>Perfil</h3>
              </div>

              <div
                className={`${styles.editorContent}${hasUnsavedProfileChanges ? ` ${styles.editorContentWithUnsaved}` : ""}`}
              >
                <form className={styles.form} onSubmit={(event) => event.preventDefault()}>
                  <section className={styles.formSection}>
                    <label className={styles.fieldLabel} htmlFor="profile-display-name">
                      Nome exibido
                    </label>
                    <input
                      id="profile-display-name"
                      className={styles.fieldInput}
                      type="text"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      maxLength={32}
                      autoComplete="nickname"
                    />
                  </section>

                  <section className={styles.formSection}>
                    <label className={styles.fieldLabel} htmlFor="profile-about">
                      Sobre mim
                    </label>
                    <p className={styles.fieldHelp}>Voce pode usar markdown e links, se desejar.</p>
                    <div className={styles.textareaWrap}>
                      <textarea
                        id="profile-about"
                        className={styles.fieldTextarea}
                        value={about}
                        onChange={(event) => setAbout(event.target.value.slice(0, ABOUT_MAX_LENGTH))}
                        maxLength={ABOUT_MAX_LENGTH}
                        spellCheck={false}
                      />
                      <span className={styles.fieldCounter}>{aboutCount}</span>
                    </div>
                  </section>

                  <section className={styles.formSection}>
                  <label className={styles.fieldLabel} htmlFor="profile-avatar-upload">
                    Avatar
                  </label>
                    <div className={styles.uploadActions}>
                      <label
                        className={`${styles.uploadButton}${isAvatarUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""}`}
                        htmlFor="profile-avatar-upload"
                      >
                        {isAvatarUploading ? "Enviando avatar..." : "Enviar avatar"}
                      </label>
                      {hasAvatarMedia ? (
                        <button
                          type="button"
                          className={`${styles.uploadButton} ${styles.removeMediaButton}${
                            isAvatarUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""
                          }`}
                          onClick={() => {
                            void removeProfileMedia("avatar");
                          }}
                          disabled={isAvatarUploading || !canUploadMedia}
                        >
                          Remover
                        </button>
                      ) : null}
                      <input
                        id="profile-avatar-upload"
                        className={styles.fileInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={isAvatarUploading || !canUploadMedia}
                        onChange={(event) => {
                          handleProfileMediaFileChange("avatar", event);
                        }}
                      />
                    </div>
                    {avatarFeedback?.tone === "error" ? (
                      <p
                        className={`${styles.uploadFeedback} ${
                          avatarFeedback.tone === "error" ? styles.uploadFeedbackError : styles.uploadFeedbackSuccess
                        }`}
                      >
                        {avatarFeedback.message}
                      </p>
                    ) : null}
                  </section>

                  <section className={styles.formSection}>
                    <label className={styles.fieldLabel} htmlFor="profile-banner-upload">
                      Banner
                    </label>
                    <div className={styles.uploadActions}>
                      <label
                        className={`${styles.uploadButton}${isBannerUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""}`}
                        htmlFor="profile-banner-upload"
                      >
                        {isBannerUploading ? "Enviando banner..." : "Enviar banner"}
                      </label>
                      {hasBannerMedia ? (
                        <button
                          type="button"
                          className={`${styles.uploadButton} ${styles.removeMediaButton}${
                            isBannerUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""
                          }`}
                          onClick={() => {
                            void removeProfileMedia("banner");
                          }}
                          disabled={isBannerUploading || !canUploadMedia}
                        >
                          Remover
                        </button>
                      ) : null}
                      <input
                        id="profile-banner-upload"
                        className={styles.fileInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={isBannerUploading || !canUploadMedia}
                        onChange={(event) => {
                          handleProfileMediaFileChange("banner", event);
                        }}
                      />
                    </div>
                    {bannerFeedback?.tone === "error" ? (
                      <p
                        className={`${styles.uploadFeedback} ${
                          bannerFeedback.tone === "error" ? styles.uploadFeedbackError : styles.uploadFeedbackSuccess
                        }`}
                      >
                        {bannerFeedback.message}
                      </p>
                    ) : null}
                  </section>

                  {!hasBannerMedia ? (
                    <section className={styles.formSection}>
                      <span className={styles.fieldLabel}>Cor da faixa</span>
                      <div className={styles.bannerColorPicker} ref={bannerColorPickerRef}>
                        <button
                          type="button"
                          className={styles.bannerColorTrigger}
                          style={{ backgroundColor: bannerColorSwatch }}
                          aria-label="Selecionar cor da faixa"
                          aria-expanded={isBannerColorPickerOpen}
                          onClick={() => {
                            setIsBannerColorPickerOpen((current) => !current);
                          }}
                        >
                          <span className={styles.bannerColorTriggerIcon} aria-hidden="true">
                            <MaterialSymbolIcon name="edit" size={14} filled={true} />
                          </span>
                        </button>

                        {isBannerColorPickerOpen ? (
                          <div className={styles.bannerColorPopover} role="group" aria-label="Selecionar cor da faixa">
                            <div
                              ref={bannerColorAreaRef}
                              className={styles.bannerColorArea}
                              style={{ backgroundColor: `hsl(${bannerColorHue} 100% 50%)` }}
                              onPointerDown={handleBannerColorAreaPointerDown}
                              onPointerMove={handleBannerColorAreaPointerMove}
                              onPointerUp={handleBannerColorAreaPointerUp}
                              onPointerCancel={handleBannerColorAreaPointerUp}
                            >
                              <div className={styles.bannerColorAreaWhiteOverlay} />
                              <div className={styles.bannerColorAreaBlackOverlay} />
                              <span
                                className={styles.bannerColorAreaCursor}
                                style={{
                                  left: `${bannerColorSaturation}%`,
                                  top: `${100 - bannerColorValue}%`,
                                }}
                                aria-hidden="true"
                              />
                            </div>

                            <input
                              className={styles.bannerColorHueSlider}
                              type="range"
                              min={0}
                              max={360}
                              step={1}
                              value={Math.round(bannerColorHue)}
                              aria-label="Matiz da cor"
                              onChange={handleBannerHueChange}
                            />

                            <div className={styles.bannerColorHexRow}>
                              <input
                                className={styles.bannerColorHexInput}
                                type="text"
                                inputMode="text"
                                spellCheck={false}
                                value={bannerColorInput}
                                aria-label="Cor hexadecimal da faixa"
                                onChange={(event) => handleBannerColorInputChange(event.target.value)}
                                onBlur={handleBannerColorInputBlur}
                              />
                              <button
                                type="button"
                                className={styles.bannerColorEyeDropperButton}
                                aria-label="Capturar cor da tela"
                                title={isEyeDropperSupported ? "Capturar cor da tela" : "Seletor de tela indisponivel"}
                                disabled={!isEyeDropperSupported}
                                onClick={() => {
                                  void handleBannerColorEyedropperClick();
                                }}
                              >
                                <MaterialSymbolIcon name="colorize" size={16} filled={false} />
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </section>
                  ) : null}
                </form>

                <aside className={styles.previewPane} aria-label="Pre-visualizacao do perfil">
                  <div className={styles.previewCardReuse}>
                    <UserProfilePopover
                      avatarSrc={avatarSrc}
                      bannerSrc={bannerSrc}
                      bannerColor={shouldSuppressPreviewBannerColor ? null : safeBannerColor}
                      displayName={safeDisplayName}
                      username={safeUsername}
                      aboutText={safeAbout}
                      presenceState="online"
                      presenceLabel={PRESENCE_LABELS.online}
                      showActions={false}
                    />
                  </div>
                </aside>
              </div>

              {hasUnsavedProfileChanges ? (
                <div className={styles.unsavedBar} role="status" aria-live="polite">
                  <p className={styles.unsavedText}>Voce tem alteracoes nao salvas.</p>
                  <div className={styles.unsavedActions}>
                    <button
                      type="button"
                      className={styles.unsavedResetButton}
                      onClick={handleResetProfileDraft}
                      disabled={isSavingProfile}
                    >
                      Redefinir
                    </button>
                    <button
                      type="button"
                      className={styles.unsavedSaveButton}
                      onClick={() => {
                        void handleSaveProfileDraft();
                      }}
                      disabled={isSavingProfile}
                    >
                      {isSavingProfile ? "Salvando..." : "Salvar"}
                    </button>
                  </div>
                </div>
              ) : null}

              {profileFeedback?.tone === "error" ? (
                <p
                  className={`${styles.profileFeedback} ${styles.profileFeedbackError}`}
                >
                  {profileFeedback.message}
                </p>
              ) : null}
            </div>
            ) : activeSection === "audio" ? (
              <section className={styles.audioPanel} aria-label="Configuracoes de audio">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Audio</h3>
                </header>

                <div className={styles.audioContent}>
                  <section className={styles.audioCard}>
                    <div className={styles.audioCardHead}>
                      <h4>Dispositivos</h4>
                    </div>

                    <div className={styles.audioGrid}>
                      <label className={styles.audioField}>
                        <span>Microfone</span>
                        <select value={selectedInputId} onChange={(event) => setSelectedInputId(event.target.value)}>
                          {audioInputs.length === 0 ? (
                            <option value="">Nenhum microfone encontrado</option>
                          ) : (
                            audioInputs.map((device, index) => (
                              <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
                                {formatDeviceOptionLabel(device.label, `Microfone ${index + 1}`)}
                              </option>
                            ))
                          )}
                        </select>
                      </label>

                      <label className={styles.audioField}>
                        <span>Saida</span>
                        <select value={selectedOutputId} onChange={(event) => setSelectedOutputId(event.target.value)}>
                          {audioOutputs.length === 0 ? (
                            <option value="">Saida padrao do sistema</option>
                          ) : (
                            audioOutputs.map((device, index) => (
                              <option key={device.deviceId || `output-${index}`} value={device.deviceId}>
                                {formatDeviceOptionLabel(device.label, `Saida ${index + 1}`)}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    </div>

                    <div className={styles.audioSliders}>
                      <div className={styles.audioSliderRow}>
                        <label className={styles.audioSlider}>
                          <span>Volume de entrada ({normalizedInputGain}%)</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={normalizedInputGain}
                            onChange={(event) => setInputGain(clamp(Number(event.target.value), 0, 100))}
                          />
                        </label>
                        <label className={styles.audioSlider}>
                          <span>Volume de saida ({Math.round(outputVolume)}%)</span>
                          <input
                            type="range"
                            min={0}
                            max={200}
                            step={1}
                            value={outputVolume}
                            onChange={(event) => setOutputVolume(clamp(Number(event.target.value), 0, 200))}
                          />
                        </label>
                      </div>
                    </div>

                    <div className={styles.audioMeterWrap}>
                      <div
                        className={`${styles.audioMeter}${
                          micMeterHasSignal ? ` ${styles.audioMeterActive}` : ""
                        }${localMicClipping ? ` ${styles.audioMeterClipping}` : ""}`}
                      >
                        <div className={styles.audioMeterBars}>
                          {micMeterBars.map((scale, index) => (
                            <span
                              key={`mic-meter-${index}`}
                              className={styles.audioMeterBar}
                              style={{ transform: `scaleY(${scale})` }}
                            />
                          ))}
                        </div>
                      </div>

                      <div className={styles.audioMeterStats}>
                        <span>Nivel: {Math.round(localMicLevel * 100)}%</span>
                        <span>Pico: {Math.round(localMicPeak * 100)}%</span>
                        <span
                          className={`${styles.audioVadState}${vadState === "speaking" ? ` ${styles.audioVadStateSpeaking}` : ""}`}
                        >
                          {vadState === "speaking" ? "Falando" : "Silencio"}
                        </span>
                        {localMicClipping ? <span className={styles.audioClipState}>Clipping</span> : null}
                      </div>

                      {micTestError ? <p className={styles.audioError}>{micTestError}</p> : null}

                      <button
                        type="button"
                        className={`${styles.audioTestButton}${micTestActive ? ` ${styles.audioTestButtonStop}` : ""}`}
                        onClick={handleMicTestToggle}
                      >
                        {micTestActive ? "Parar teste do microfone" : "Iniciar teste do microfone"}
                      </button>
                    </div>
                  </section>

                  <section className={`${styles.audioCard} ${styles.audioCardVoice}`}>
                    <div className={styles.audioCardHead}>
                      <h4>Processamento de voz</h4>
                    </div>

                    <div className={styles.voiceLayout}>
                      <div className={styles.voiceColumn}>
                        <section className={styles.voiceBlock}>
                          <h5 className={styles.voiceBlockTitle}>Qualidade de captura</h5>
                          <div className={styles.audioToggles}>
                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Reducao de ruido</span>
                                <span className={styles.audioToggleDesc}>Filtra ruido constante de fundo.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={noiseSuppression}
                                onChange={(event) => setNoiseSuppression(event.target.checked)}
                              />
                            </label>

                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Cancelamento de eco</span>
                                <span className={styles.audioToggleDesc}>Evita retorno do audio para a chamada.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={echoCancellation}
                                onChange={(event) => setEchoCancellation(event.target.checked)}
                              />
                            </label>

                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Ganho automatico (AGC)</span>
                                <span className={styles.audioToggleDesc}>Ajusta o volume do microfone automaticamente.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={autoGainControl}
                                onChange={(event) => setAutoGainControl(event.target.checked)}
                              />
                            </label>

                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Deteccao de voz (VAD)</span>
                                <span className={styles.audioToggleDesc}>Detecta fala e reduz envio de silencio.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={vadEnabled}
                                onChange={(event) => setVadEnabled(event.target.checked)}
                              />
                            </label>

                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Foco de voz</span>
                                <span className={styles.audioToggleDesc}>Prioriza sua voz e corta sons laterais.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={voiceFocus}
                                onChange={(event) => setVoiceFocus(event.target.checked)}
                              />
                            </label>
                          </div>
                        </section>
                      </div>

                      <div className={styles.voiceColumn}>
                        <section className={styles.voiceBlock}>
                          <h5 className={styles.voiceBlockTitle}>Sensibilidade</h5>
                          <label className={`${styles.audioToggle} ${styles.audioToggleCentered}`}>
                            <span className={styles.audioToggleText}>
                              <span className={styles.audioToggleTitle}>Sensibilidade automatica</span>
                              <span className={styles.audioToggleDesc}>Define o nivel ideal sem ajuste manual.</span>
                            </span>
                            <input
                              type="checkbox"
                              checked={autoMicSensitivity}
                              onChange={(event) => setAutoMicSensitivity(event.target.checked)}
                            />
                          </label>

                          <label className={`${styles.audioSlider} ${styles.audioSliderSensitivity}`}>
                            <span>Sensibilidade ({Math.round(displayedMicSensitivity)} dB)</span>
                            <input
                              type="range"
                              min={-100}
                              max={0}
                              step={1}
                              value={displayedMicSensitivity}
                              disabled={autoMicSensitivity}
                              onChange={(event) => handleManualMicSensitivityChange(Number(event.target.value))}
                            />
                          </label>
                        </section>

                        <section className={styles.voiceBlock}>
                          <h5 className={styles.voiceBlockTitle}>Push to talk</h5>
                          <div className={styles.audioPtt}>
                            <label className={styles.audioToggle}>
                              <span className={styles.audioToggleText}>
                                <span className={styles.audioToggleTitle}>Push-to-talk</span>
                                <span className={styles.audioToggleDesc}>O microfone abre apenas com o atalho.</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={pushToTalkEnabled}
                                onChange={(event) => handlePushToTalkChange(event.target.checked)}
                              />
                            </label>

                            {pushToTalkEnabled ? (
                              <button
                                type="button"
                                className={`${styles.audioBindButton}${listeningForBind ? ` ${styles.audioBindButtonListening}` : ""}`}
                                onClick={() => setListeningForBind(true)}
                              >
                                {listeningForBind ? "Pressione uma tecla..." : `Atalho: ${pushToTalkBind}`}
                              </button>
                            ) : null}
                          </div>
                        </section>
                      </div>
                    </div>
                  </section>
                </div>
              </section>
            ) : activeSection === "windows" ? (
              <section className={styles.windowsPanel} aria-label="Configuracoes do Windows">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Windows</h3>
                </header>

                <div className={styles.windowsContent}>
                  <section className={styles.windowsCard} aria-label="Comportamento no Windows">
                    <div className={styles.windowsCardHead}>
                      <h4>Comportamento do aplicativo</h4>
                      {isWindowsBehaviorLoading ? (
                        <span className={styles.windowsInlineStatus}>Carregando...</span>
                      ) : null}
                    </div>

                    {!isWindowsDesktopRuntime ? (
                      <p className={styles.windowsSupportNotice}>
                        Disponivel apenas no aplicativo desktop para Windows.
                      </p>
                    ) : (
                      <div className={styles.windowsSettingList}>
                        {(
                          [
                            {
                              key: "startMinimized",
                              title: "Iniciar minimizado",
                              description: "Abre o Messly minimizado na proxima inicializacao do app.",
                            },
                            {
                              key: "closeToTray",
                              title: "Ao fechar, minimizar para bandeja",
                              description: "Mantem o app rodando na bandeja do sistema ao fechar a janela.",
                            },
                            {
                              key: "launchAtStartup",
                              title: "Abrir o Messly na inicializacao",
                              description: "Inicia o Messly automaticamente quando o Windows ligar.",
                            },
                          ] as const
                        ).map((item) => {
                          const isSaving = savingWindowsBehaviorKey === item.key;
                          const disabled = !canManageWindowsBehavior || isWindowsBehaviorLoading || Boolean(isSaving);
                          const checked = Boolean(windowsBehaviorSettings[item.key]);
                          return (
                            <div key={item.key} className={styles.windowsSettingRow}>
                              <div className={styles.windowsSettingMeta}>
                                <p className={styles.windowsSettingTitle}>{item.title}</p>
                                <p className={styles.windowsSettingDesc}>{item.description}</p>
                              </div>

                              <button
                                type="button"
                                role="switch"
                                aria-checked={checked}
                                aria-label={item.title}
                                disabled={disabled}
                                className={`${styles.windowsSwitch}${checked ? ` ${styles.windowsSwitchOn}` : ""}${
                                  disabled ? ` ${styles.windowsSwitchDisabled}` : ""
                                }`}
                                onClick={() => {
                                  void handleWindowsBehaviorToggle(item.key, !checked);
                                }}
                              >
                                <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {windowsBehaviorError ? (
                      <p className={styles.windowsErrorText} role="status" aria-live="polite">
                        {windowsBehaviorError}
                      </p>
                    ) : null}
                  </section>
                </div>
              </section>
            ) : (
              <section className={styles.socialPanel} aria-label="Conteudo social">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Conteudo social</h3>
                </header>

                <div className={styles.socialContent}>
                  <section className={styles.blockedCard} aria-label="Contas bloqueadas">
                    <header className={styles.blockedCardHeader}>
                      <div className={styles.blockedCardIconWrap} aria-hidden="true">
                        <MaterialSymbolIcon name="block" size={18} filled={false} />
                      </div>
                      <div className={styles.blockedCardHeading}>
                        <h4 className={styles.blockedCardTitle}>Contas bloqueadas</h4>
                        <p className={styles.blockedCardCount}>{blockedAccountsCountLabel}</p>
                      </div>
                    </header>

                    {isBlockedAccountsLoading ? (
                      <p className={styles.blockedState}>Carregando contas bloqueadas...</p>
                    ) : blockedAccountsError ? (
                      <p className={`${styles.blockedState} ${styles.blockedStateError}`}>{blockedAccountsError}</p>
                    ) : blockedAccounts.length === 0 ? (
                      <p className={styles.blockedState}>Voce nao bloqueou nenhum usuario.</p>
                    ) : (
                      <div className={styles.blockedList}>
                        {blockedAccounts.map((account) => (
                          <article key={account.userId} className={styles.blockedRow}>
                            <div className={styles.blockedRowMain}>
                              <img
                                className={styles.blockedAvatar}
                                src={account.avatarSrc}
                                alt={`Avatar de ${account.displayName}`}
                                loading="lazy"
                                onError={(event) => {
                                  event.currentTarget.onerror = null;
                                  event.currentTarget.src = getNameAvatarUrl(account.displayName || account.username || "U");
                                }}
                              />
                              <div className={styles.blockedMeta}>
                                <p className={styles.blockedName}>{account.displayName}</p>
                                <p className={styles.blockedUsername}>{account.username}</p>
                              </div>
                            </div>

                            <button
                              type="button"
                              className={styles.blockedUnblockButton}
                              onClick={() => {
                                void handleUnblockAccount(account.userId);
                              }}
                              disabled={unblockingUserId === account.userId}
                            >
                              {unblockingUserId === account.userId ? "Desbloqueando..." : "Desbloquear"}
                            </button>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </section>
            )}
          </div>
        </div>
      </section>

      <ImageEditModal
        isOpen={Boolean(pendingImageEdit)}
        kind={pendingImageEdit?.kind ?? "avatar"}
        file={pendingImageEdit?.file ?? null}
        isApplying={isImageEditorApplying}
        onClose={() => setPendingImageEdit(null)}
        onApply={handleApplyEditedImage}
      />

      <Modal
        isOpen={Boolean(uploadLimitModal)}
        title="Seus arquivos sao poderosos demais"
        ariaLabel="Arquivo acima do limite"
        onClose={() => setUploadLimitModal(null)}
        panelClassName={styles.uploadLimitModalPanel}
        bodyClassName={styles.uploadLimitModalBody}
        footer={
          <button
            className={styles.uploadLimitModalButton}
            type="button"
            onClick={() => setUploadLimitModal(null)}
          >
            Entendi
          </button>
        }
      >
        <p className={styles.uploadLimitModalText}>
          O tamanho maximo de {uploadLimitModal?.kind === "avatar" ? "avatares" : "banners"} e{" "}
          {(uploadLimitModal?.maxMb ?? 0).toFixed(2)} MB.
        </p>
      </Modal>
    </>
  );
}
