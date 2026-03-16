import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAuthSession } from "../../auth/AuthProvider";
import {
  getAvatarUrl,
  getBannerUrl,
  getDefaultAvatarUrl,
  getDefaultBannerUrl,
  isDefaultAvatarUrl,
} from "../../services/cdn/mediaUrls";
import {
  isProfileMediaUploadError,
  uploadProfileMediaAsset,
  type ProfileMediaKind,
} from "../../services/media/profileMediaUpload";
import { deleteMedia } from "../../api/mediaController";
import { AVATAR_MAX_BYTES, AVATAR_MAX_MB, BANNER_MAX_BYTES, BANNER_MAX_MB } from "../../services/media/imageLimits";
import ImageEditModal from "../media/ImageEditModal";
import { PRESENCE_LABELS, type PresencePlatform, type PresenceState } from "../../services/presence/presenceTypes";
import { supabase } from "../../services/supabase";
import { isUsernameAvailable, normalizeEmail, validateUsernameInput } from "../../services/usernameAvailability";
import { DEFAULT_BANNER_COLOR, getBannerColorInputValue, normalizeBannerColor } from "../../services/profile/bannerColor";
import { ensureUser, loadPendingProfile } from "../../services/userSync";
import {
  connectSpotifyOAuth,
  createDefaultSpotifyConnection,
  disconnectSpotifyOAuth,
  setSpotifyConnectionVisibility,
  isSpotifyOAuthConfigured,
  readSpotifyConnection,
  subscribeSpotifyConnection,
  type SpotifyConnectionState,
} from "../../services/connections/spotifyConnection";
import {
  DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS,
  getFriendRequestPrivacySettings,
  type FriendRequestPrivacySettings,
} from "../../services/friends/friendRequestPrivacy";
import {
  endAllOtherLoginSessions,
  endCurrentLoginSession,
  endLoginSessionById,
  getCurrentLoginSessionId,
  listActiveLoginSessions,
  type LoginSessionView,
} from "../../services/security/loginSessions";
import {
  getOrCreatePresenceDeviceId,
  getPresenceDeviceMetadataSnapshot,
  hydratePresenceDeviceMetadata,
  type PresenceDeviceMetadata,
} from "../../services/presence/presenceDeviceInfo";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import BannerImage from "../ui/BannerImage";
import spotifyLogoSrc from "../../assets/icons/ui/spotify.svg";
import Modal from "../ui/Modal";
import UserProfilePopover from "../UserProfilePopover/UserProfilePopover";
import styles from "./AppSettingsView.module.css";
import appPackage from "../../../package.json";

// Firebase removed: provide minimal stubs for legacy flows.
const EmailAuthProvider = { credential: (_e: string, _p: string) => ({}) };
async function reauthenticateWithCredential(): Promise<void> {
  return;
}
async function updatePassword(_user: unknown, password: string): Promise<void> {
  await supabase.auth.updateUser({ password });
}
async function verifyBeforeUpdateEmail(_user: unknown, email: string): Promise<void> {
  await supabase.auth.updateUser({ email });
}
async function deleteUser(_user: { id?: string } | null): Promise<void> {
  const uid = _user?.id;
  if (uid) {
    try {
      await supabase.rpc("delete_user", { user_id: uid });
    } catch {
      // ignore
    }
  }
}
const onValue = () => () => undefined;
const ref = () => null;
async function remove(): Promise<void> {
  return;
}
interface AppSettingsViewProps {
  onClose: () => void;
  currentUserId?: string | null;
  initialSection?: SettingsSection;
}

interface UploadFeedbackState {
  message: string;
  tone: "error" | "success";
}

interface ModalAvailabilityFeedbackState {
  message: string;
  tone: "error" | "success" | "info";
}

interface ProcessingCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
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
  username_changed_at?: string | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
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

interface BlockedAccountItem {
  userId: string;
  displayName: string;
  username: string;
  avatarSrc: string;
  blockedAtLabel: string;
}

interface DeviceSessionItem {
  id: string;
  sessionId: string | null;
  deviceId: string | null;
  platform: PresencePlatform;
  state: PresenceState;
  clientName: string;
  osName: string;
  locationLabel: string | null;
  lastActive: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  appVersion: string | null;
  ipAddressMasked: string | null;
  isCurrent: boolean;
  source: "presence" | "loginSession";
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
  email?: string | null;
  firebase_uid?: string | null;
  display_name?: string | null;
  username?: string | null;
  username_changed_at?: string | null;
  friend_requests_allow_all?: boolean | null;
  friend_requests_allow_friends_of_friends?: boolean | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  avatar_url?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
}

type SettingsSection = "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows";
type AccountModalKind = "username" | "email" | "password" | "deactivate" | "delete";
type AccountEmailModalStep = "verifyCurrent" | "verifyNew";
type ProfileThemeColorSlot = "primary" | "accent";

type ProfileMediaUpdatePayload = Record<string, string | null>;
type UserProfileUpdatePayload = Record<string, unknown>;

const ABOUT_MAX_LENGTH = 190;
const USERNAME_CHANGE_COOLDOWN_DAYS = 30;
const USERNAME_CHANGE_COOLDOWN_MS = USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const USERS_MISSING_COLUMN_REGEX = /Could not find the '([^']+)' column of 'users' in the schema cache/i;
const PROFILE_MEDIA_COLUMNS = new Set(["avatar_key", "avatar_hash", "avatar_url", "banner_key", "banner_hash"]);
const OPTIONAL_PROFILE_COLUMNS = new Set([
  "banner_color",
  "profile_theme_primary_color",
  "profile_theme_accent_color",
  "spotify_connection",
  "username_changed_at",
  "friend_requests_allow_all",
  "friend_requests_allow_friends_of_friends",
]);

function isTableMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const casted = error as { code?: string; status?: number; message?: string };
  const code = String(casted.code ?? "").trim();
  const status = Number(casted.status ?? 0);
  const message = String(casted.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST114" || status === 404 || message.includes("does not exist");
}
const USER_PROFILE_SELECT_COLUMNS =
  "id,username,display_name,email,avatar_url,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,about:bio,created_at,updated_at";
const USER_PROFILE_SELECT_COLUMNS_WITHOUT_AVATAR_URL =
  "id,username,display_name,email,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,about:bio,created_at,updated_at";
const USER_PROFILE_SELECT_COLUMNS_FALLBACK = "id,username,display_name,email,bio,about:bio";
const BLOCKED_USERS_SELECT_COLUMNS = "id,username,display_name,avatar_url,avatar_key,avatar_hash";
const BLOCKED_USERS_SELECT_COLUMNS_FALLBACK = "id,username,display_name,avatar_url";
const SIDEBAR_IDENTITY_CACHE_PREFIX = "messly:sidebar-identity:";
const SIDEBAR_RESOLVED_MEDIA_CACHE_PREFIX = "messly:sidebar-media:";
const AUDIO_SETTINGS_STORAGE_KEY_PREFIX = "messly:audio-settings:";
const AUDIO_SETTINGS_UPDATED_EVENT = "messly:audio-settings-updated";
const PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX = "messly:profile-plus-theme:";
const PROFILE_PLUS_THEME_UPDATED_EVENT = "messly:profile-plus-theme-updated";
const USERNAME_CHANGE_STORAGE_KEY_PREFIX = "messly:username-change:";
const DEFAULT_PUSH_TO_TALK_BIND = "V";
const APP_RELEASE_CHANNEL = "stable";
const DEFAULT_PLUS_PROFILE_PRIMARY_COLOR = "#FFFFFF";
const DEFAULT_PLUS_PROFILE_ACCENT_COLOR = "#FFFFFF";
const LEGACY_PLUS_PROFILE_PRIMARY_COLOR = "#6F737C";
const LEGACY_PLUS_PROFILE_ACCENT_COLOR = "#4A4E56";
const USERS_UPDATE_ROW_NOT_FOUND_ERROR = "Não foi possível encontrar o usuário para atualizar.";
const ENDED_DEVICE_SESSION_SUPPRESS_TTL_MS = 5 * 60 * 1000;
const DISMISSED_LOGIN_SESSIONS_STORAGE_PREFIX = "messly:security:dismissed-login-sessions:";
const DISMISSED_LOGIN_SESSIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_SESSIONS_CACHE_STORAGE_PREFIX = "messly:security:login-sessions-cache:";
const LOGIN_SESSIONS_CACHE_TTL_MS = 2 * 60 * 1000;
const BANNER_COLOR_SWATCHES = ["#3B82F6", "#F44C4C", "#10B981", "#F59E0B", "#8B5CF6"];
const DEFAULT_WINDOWS_BEHAVIOR_SETTINGS: WindowsBehaviorSettings = {
  startMinimized: true,
  closeToTray: true,
  launchAtStartup: true,
};
const SETTINGS_SIDEBAR_ITEMS: ReadonlyArray<{
  key: SettingsSection;
  label: string;
  icon: string;
}> = [
  { key: "account", label: "Minha conta", icon: "badge" },
  { key: "profile", label: "Editar perfil", icon: "person" },
  { key: "connections", label: "Conexões", icon: "link" },
  { key: "social", label: "Conteúdo social", icon: "groups" },
  { key: "devices", label: "Dispositivos", icon: "devices" },
  { key: "audio", label: "Voz e vídeo", icon: "mic" },
  { key: "windows", label: "Config. Windows", icon: "desktop_windows" },
];

const NOISE_SUPPRESSION_MODE_OPTIONS: ReadonlyArray<{
  value: NoiseSuppressionMode;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "Desativado",
    description: "Sem filtros de supressão de ruído.",
  },
  {
    value: "webrtc",
    label: "Padrão (WebRTC)",
    description: "Usa os filtros nativos do navegador.",
  },
  {
    value: "rnnoise",
    label: "RNNoise (Avançado)",
    description: "Supressão de ruído por IA em tempo real.",
  },
];

function resolveVisibleSettingsSection(section: SettingsSection, isElectron: boolean): SettingsSection {
  if (section === "windows" && !isElectron) {
    return "account";
  }
  return section;
}

const ACCOUNT_DELETE_CONFIRM_TEXT = "EXCLUIR";
const ACCOUNT_DEACTIVATE_CONFIRM_TEXT = "DESATIVAR";

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

interface CachedLoginSessionsPayload {
  v: 2;
  updatedAt: number;
  sessions: LoginSessionView[];
}

interface PersistedAudioSettings {
  v: 1;
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppressionMode: "off" | "webrtc" | "rnnoise";
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  vadEnabled: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
  pushToTalkEnabled: boolean;
  pushToTalkBind: string;
  qosHighPriority: boolean;
}

interface PersistedProfilePlusThemeSettings {
  v: 1;
  primary: string;
  accent: string;
}

type NoiseSuppressionMode = "off" | "webrtc" | "rnnoise";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function maskEmailAddress(emailRaw: string): string {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    return "";
  }

  const [localPart, domainPart] = email.split("@");
  if (!localPart || !domainPart) {
    return email;
  }

  const visibleLocalChars = localPart.length <= 2 ? 1 : 2;
  const preservedLocal = localPart.slice(0, visibleLocalChars);
  const hiddenLocal = "*".repeat(Math.max(4, localPart.length - visibleLocalChars));

  return `${preservedLocal}${hiddenLocal}@${domainPart}`;
}

function deriveSessionFallbackUsername(
  firebaseUid: string | null | undefined,
  pendingUsername: string | null | undefined,
): string {
  const sanitize = (raw: string | null | undefined): string => {
    const normalized = String(raw ?? "")
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
  };

  const uidSeed = String(firebaseUid ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  return sanitize(pendingUsername) || sanitize(uidSeed ? `user_${uidSeed}` : "") || "usuario";
}

function formatReleaseChannelLabel(channelRaw: string | null | undefined): string {
  const normalizedChannel = String(channelRaw ?? "").trim().toLowerCase();
  switch (normalizedChannel) {
    case "stable":
      return "Canal estável";
    case "beta":
      return "Canal beta";
    case "alpha":
      return "Canal alpha";
    default:
      return normalizedChannel ? `Canal ${normalizedChannel}` : "Canal padrão";
  }
}

function formatRuntimePlatformName(
  platformRaw: string | null | undefined,
  archRaw: string | null | undefined,
): string {
  const normalizedPlatform = String(platformRaw ?? "").trim().toLowerCase();
  const normalizedArch = String(archRaw ?? "").trim().toLowerCase();

  const platformLabel =
    normalizedPlatform === "win32"
      ? "Windows"
      : normalizedPlatform === "darwin"
        ? "macOS"
        : normalizedPlatform === "linux"
          ? "Linux"
          : normalizedPlatform === "web"
            ? "Web"
            : normalizedPlatform || "Desktop";

  const archLabel =
    normalizedArch === "x64"
      ? "x64"
      : normalizedArch === "arm64"
        ? "ARM64"
        : normalizedArch === "ia32"
          ? "x86"
          : normalizedArch;

  return archLabel ? `${platformLabel} ${archLabel}` : platformLabel;
}

function buildAudioSettingsStorageKey(userUid: string | null | undefined): string {
  const normalizedUid = String(userUid ?? "").trim();
  if (!normalizedUid) {
    return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}guest`;
  }
  return `${AUDIO_SETTINGS_STORAGE_KEY_PREFIX}${normalizedUid}`;
}

function buildProfilePlusThemeStorageKey(userUid: string | null | undefined): string {
  const normalizedUid = String(userUid ?? "").trim();
  if (!normalizedUid) {
    return `${PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX}guest`;
  }
  return `${PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX}${normalizedUid}`;
}

function readProfilePlusThemeSettings(userUid: string | null | undefined): {
  primary: string;
  accent: string;
} {
  if (typeof window === "undefined") {
    return {
      primary: DEFAULT_PLUS_PROFILE_PRIMARY_COLOR,
      accent: DEFAULT_PLUS_PROFILE_ACCENT_COLOR,
    };
  }

  try {
    const raw = window.localStorage.getItem(buildProfilePlusThemeStorageKey(userUid));
    if (!raw) {
      return {
        primary: DEFAULT_PLUS_PROFILE_PRIMARY_COLOR,
        accent: DEFAULT_PLUS_PROFILE_ACCENT_COLOR,
      };
    }

    const parsed = JSON.parse(raw) as Partial<PersistedProfilePlusThemeSettings> | null;
    const normalizedLegacyPrimary = normalizeBannerColor(LEGACY_PLUS_PROFILE_PRIMARY_COLOR);
    const normalizedLegacyAccent = normalizeBannerColor(LEGACY_PLUS_PROFILE_ACCENT_COLOR);
    const normalizedPrimary = normalizeBannerColor(parsed?.primary);
    const normalizedAccent = normalizeBannerColor(parsed?.accent);
    const primary =
      !normalizedPrimary || normalizedPrimary === normalizedLegacyPrimary
        ? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR
        : normalizedPrimary;
    const accent =
      !normalizedAccent || normalizedAccent === normalizedLegacyAccent
        ? DEFAULT_PLUS_PROFILE_ACCENT_COLOR
        : normalizedAccent;
    return { primary, accent };
  } catch {
    return {
      primary: DEFAULT_PLUS_PROFILE_PRIMARY_COLOR,
      accent: DEFAULT_PLUS_PROFILE_ACCENT_COLOR,
    };
  }
}

function writeProfilePlusThemeSettings(
  userUid: string | null | undefined,
  payload: {
    primary: string;
    accent: string;
  },
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const primary = normalizeBannerColor(payload.primary) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR;
    const accent = normalizeBannerColor(payload.accent) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR;
    const serialized: PersistedProfilePlusThemeSettings = {
      v: 1,
      primary,
      accent,
    };
    window.localStorage.setItem(buildProfilePlusThemeStorageKey(userUid), JSON.stringify(serialized));
  } catch {
    // ignore storage failures
  }
}

function formatDeviceOptionLabel(rawLabel: string | null | undefined, fallback: string): string {
  const label = String(rawLabel ?? "").trim();
  if (!label) {
    return fallback;
  }

  const withoutRoutePrefixes = label
    .replace(/^\s*default\s*-\s*/i, "")
    .replace(/^\s*communications\s*-\s*/i, "")
    .trim();
  const withoutHardwareIds = withoutRoutePrefixes
    .replace(/\(\s*[0-9a-f]{4}\s*:\s*[0-9a-f]{4}\s*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return withoutHardwareIds || fallback;
}

function buildUniqueAudioDeviceOptions(
  devices: MediaDeviceInfo[],
  defaultLabel: string,
  fallbackLabel: string,
  selectedDeviceId: string,
): Array<{ value: string; title: string; subtitle: string }> {
  const normalizedSelectedDeviceId = String(selectedDeviceId ?? "").trim();
  const normalizeKey = (value: string): string =>
    value
      .toLocaleLowerCase("pt-BR")
      .replace(/\s+/g, " ")
      .trim();

  const defaultOption = {
    value: "",
    title: defaultLabel,
    subtitle: "",
  };
  const defaultKey = normalizeKey(defaultLabel);
  const uniqueOptionsByKey = new Map<string, { value: string; title: string; subtitle: string }>();

  devices.forEach((device) => {
    const value = String(device.deviceId ?? "").trim();
    if (!value) {
      return;
    }

    const title = formatDeviceOptionLabel(device.label, fallbackLabel);
    const key = normalizeKey(title);
    if (!key || key === defaultKey) {
      return;
    }

    const nextOption = {
      value,
      title,
      subtitle: "",
    };
    const currentOption = uniqueOptionsByKey.get(key);
    if (!currentOption) {
      uniqueOptionsByKey.set(key, nextOption);
      return;
    }
    if (normalizedSelectedDeviceId && value === normalizedSelectedDeviceId) {
      uniqueOptionsByKey.set(key, nextOption);
    }
  });

  const result = [defaultOption, ...Array.from(uniqueOptionsByKey.values())];
  if (
    normalizedSelectedDeviceId &&
    normalizedSelectedDeviceId !== "" &&
    !result.some((option) => option.value === normalizedSelectedDeviceId)
  ) {
    const selectedDevice = devices.find(
      (device) => String(device.deviceId ?? "").trim() === normalizedSelectedDeviceId,
    );
    if (selectedDevice) {
      result.push({
        value: normalizedSelectedDeviceId,
        title: formatDeviceOptionLabel(selectedDevice.label, fallbackLabel),
        subtitle: "",
      });
    }
  }

  return result;
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
        return "Seu banco users ainda não tem as colunas de mídia. Execute a migração de avatar/banner.";
      }
      if (message.includes("Profile media payload must be WebP.")) {
        return "Versão antiga do backend detectada. Reinicie o aplicativo.";
      }
      if (message.includes("No handler registered for 'media:upload-profile'")) {
        return "Reinicie o aplicativo para ativar o upload de avatar e banner.";
      }
      return message;
    }
  }

  return "Não foi possível concluir o upload agora.";
}

function getProfileMediaErrorMessage(kind: ProfileMediaKind, error: unknown): string {
  if (isProfileMediaUploadError(error)) {
    return error.message;
  }

  const resolvedMessage = getErrorMessage(error);
  if (
    resolvedMessage.includes("Usuário ainda não sincronizado")
    || resolvedMessage.includes("colunas de mídia")
    || resolvedMessage.includes("Versão antiga do backend")
    || resolvedMessage.includes("Reinicie o aplicativo")
  ) {
    return resolvedMessage;
  }

  return kind === "avatar"
    ? "Falha ao enviar avatar. Tente novamente."
    : "Falha ao enviar banner. Tente novamente.";
}

function getAccountActionErrorMessage(error: unknown): string {
  const firebaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: string }).code ?? "").trim()
      : "";

  switch (firebaseCode) {
    case "auth/network-request-failed":
      return "Sem internet. Verifique sua conexão e tente novamente.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Aguarde um pouco e tente novamente.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Senha atual incorreta.";
    case "auth/invalid-email":
      return "Digite um e-mail válido.";
    case "auth/email-already-in-use":
      return "Esse e-mail já está em uso.";
    case "auth/requires-recent-login":
      return "Entre novamente para concluir essa alteração de segurança.";
    case "auth/weak-password":
      return "A nova senha é muito fraca. Use uma senha mais forte.";
    case "auth/user-mismatch":
      return "Confirme o e-mail atual corretamente.";
    default:
      break;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: string }).message ?? "").trim();
    if (message) {
      const normalized = message.toLocaleLowerCase("pt-BR");
      if (
        normalized.includes("invalid login credentials") ||
        normalized.includes("invalid credentials") ||
        normalized.includes("wrong password") ||
        normalized.includes("senha incorreta")
      ) {
        return "Senha incorreta. Tente novamente.";
      }
      return message;
    }
  }

  return "Não foi possível concluir esta ação agora.";
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
  return new Map();
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

function isReusableSidebarMediaUrl(urlRaw: string | null | undefined): boolean {
  const url = String(urlRaw ?? "").trim();
  if (!url) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:");
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
    if (avatarSrc && !isReusableSidebarMediaUrl(avatarSrc)) {
      return null;
    }
    if (bannerSrc && !isReusableSidebarMediaUrl(bannerSrc)) {
      return null;
    }
    return { avatarSrc, bannerSrc };
  } catch {
    return null;
  }
}

function buildDismissedLoginSessionsStorageKey(scope: string | null | undefined): string | null {
  const normalizedScope = String(scope ?? "").trim();
  if (!normalizedScope) {
    return null;
  }

  return `${DISMISSED_LOGIN_SESSIONS_STORAGE_PREFIX}${normalizedScope}`;
}

function readDismissedLoginSessions(scope: string | null | undefined): Map<string, number> {
  if (typeof window === "undefined") {
    return new Map();
  }

  const key = buildDismissedLoginSessionsStorageKey(scope);
  if (!key) {
    return new Map();
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return new Map();
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    const nextMap = new Map<string, number>();
    for (const [sessionIdRaw, dismissedAtRaw] of Object.entries(parsed ?? {})) {
      const sessionId = String(sessionIdRaw ?? "").trim();
      const dismissedAt = Number(dismissedAtRaw);
      if (!sessionId || !Number.isFinite(dismissedAt)) {
        continue;
      }
      if (dismissedAt + DISMISSED_LOGIN_SESSIONS_TTL_MS <= now) {
        continue;
      }
      nextMap.set(sessionId, dismissedAt);
    }
    return nextMap;
  } catch {
    return new Map();
  }
}

function writeDismissedLoginSessions(scope: string | null | undefined, dismissedMap: Map<string, number>): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = buildDismissedLoginSessionsStorageKey(scope);
  if (!key) {
    return;
  }

  try {
    if (dismissedMap.size === 0) {
      window.localStorage.removeItem(key);
      return;
    }

    const payload: Record<string, number> = {};
    dismissedMap.forEach((dismissedAt, sessionId) => {
      payload[sessionId] = dismissedAt;
    });
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function buildLoginSessionsCacheStorageKey(scope: string | null | undefined): string | null {
  const normalizedScope = String(scope ?? "").trim();
  if (!normalizedScope) {
    return null;
  }

  return `${LOGIN_SESSIONS_CACHE_STORAGE_PREFIX}${normalizedScope}`;
}

function readCachedLoginSessions(scope: string | null | undefined): LoginSessionView[] {
  if (typeof window === "undefined") {
    return [];
  }

  const key = buildLoginSessionsCacheStorageKey(scope);
  if (!key) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as Partial<CachedLoginSessionsPayload>;
    if (parsed.v !== 2) {
      return [];
    }

    const updatedAt = Number(parsed.updatedAt ?? NaN);
    if (!Number.isFinite(updatedAt) || updatedAt + LOGIN_SESSIONS_CACHE_TTL_MS <= Date.now()) {
      return [];
    }

    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return sessions
      .map((entry) => {
        const id = String((entry as Partial<LoginSessionView>)?.id ?? "").trim();
        if (!isUuidLike(id)) {
          return null;
        }

        const recordId = String((entry as Partial<LoginSessionView>)?.recordId ?? "").trim() || id;
        const deviceId = String((entry as Partial<LoginSessionView>)?.deviceId ?? "").trim() || `legacy:${recordId}`;
        const clientType = String((entry as Partial<LoginSessionView>)?.clientType ?? "").trim() || "unknown";
        const platform = String((entry as Partial<LoginSessionView>)?.platform ?? "").trim() || "unknown";
        const device = String((entry as Partial<LoginSessionView>)?.device ?? "").trim() || "Cliente";
        const os = String((entry as Partial<LoginSessionView>)?.os ?? "").trim() || "Sistema";
        const appVersionRaw = (entry as Partial<LoginSessionView>)?.appVersion;
        const clientVersionRaw = (entry as Partial<LoginSessionView>)?.clientVersion;
        const locationRaw = (entry as Partial<LoginSessionView>)?.location;
        const ipAddressMasked = String((entry as Partial<LoginSessionView>)?.ipAddressMasked ?? "").trim() || "0.0.0.0";
        const createdAt = String((entry as Partial<LoginSessionView>)?.createdAt ?? "").trim() || new Date().toISOString();
        const lastSeenAt = String((entry as Partial<LoginSessionView>)?.lastSeenAt ?? "").trim() || createdAt;
        const loggedInLabel =
          String((entry as Partial<LoginSessionView>)?.loggedInLabel ?? "").trim() || "Logged in recently";
        const revokedAtRaw = (entry as Partial<LoginSessionView>)?.revokedAt;
        const userAgentRaw = (entry as Partial<LoginSessionView>)?.userAgent;
        const suspicious = Boolean((entry as Partial<LoginSessionView>)?.suspicious);

        return {
          id,
          recordId,
          deviceId,
          clientType,
          platform,
          device,
          os,
          appVersion: appVersionRaw == null ? null : String(appVersionRaw).trim() || null,
          clientVersion: clientVersionRaw == null ? null : String(clientVersionRaw).trim() || null,
          location: locationRaw == null ? null : String(locationRaw).trim() || null,
          ipAddressMasked,
          createdAt,
          lastSeenAt,
          loggedInLabel,
          revokedAt: revokedAtRaw == null ? null : String(revokedAtRaw).trim() || null,
          userAgent: userAgentRaw == null ? null : String(userAgentRaw).trim() || null,
          suspicious,
        } satisfies LoginSessionView;
      })
      .filter((entry): entry is LoginSessionView => entry !== null);
  } catch {
    return [];
  }
}

function writeCachedLoginSessions(scope: string | null | undefined, sessions: LoginSessionView[]): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = buildLoginSessionsCacheStorageKey(scope);
  if (!key) {
    return;
  }

  try {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }

    const payload: CachedLoginSessionsPayload = {
      v: 2,
      updatedAt: Date.now(),
      sessions,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeStoredIsoTimestamp(rawValue: string | null | undefined): string | null {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function buildUsernameChangeStorageKey(scope: string | null | undefined): string | null {
  const normalizedScope = String(scope ?? "").trim();
  if (!normalizedScope) {
    return null;
  }

  return `${USERNAME_CHANGE_STORAGE_KEY_PREFIX}${normalizedScope}`;
}

function readUsernameChangeFallback(scope: string | null | undefined): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const key = buildUsernameChangeStorageKey(scope);
  if (!key) {
    return null;
  }

  try {
    return normalizeStoredIsoTimestamp(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeUsernameChangeFallback(scope: string | null | undefined, timestamp: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = buildUsernameChangeStorageKey(scope);
  if (!key) {
    return;
  }

  try {
    const normalizedTimestamp = normalizeStoredIsoTimestamp(timestamp);
    if (!normalizedTimestamp) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, normalizedTimestamp);
  } catch {
    // ignore storage failures
  }
}

function formatShortDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toLocaleDateString("pt-BR");
  }
}

function formatBlockedDateLabel(timestampRaw: string | null | undefined): string {
  const normalizedTimestamp = normalizeStoredIsoTimestamp(timestampRaw);
  if (!normalizedTimestamp) {
    return "BLOQUEADO RECENTEMENTE";
  }

  const date = new Date(normalizedTimestamp);
  if (Number.isNaN(date.getTime())) {
    return "BLOQUEADO RECENTEMENTE";
  }

  try {
    const day = new Intl.DateTimeFormat("pt-BR", { day: "2-digit" }).format(date);
    const month = new Intl.DateTimeFormat("pt-BR", { month: "short" })
      .format(date)
      .replace(".", "")
      .trim()
      .toUpperCase();

    return `BLOQUEADO EM ${day} ${month}`;
  } catch {
    const day = String(date.getDate()).padStart(2, "0");
    const monthNames = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
    return `BLOQUEADO EM ${day} ${monthNames[date.getMonth()] ?? "REC"}`;
  }
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

function normalizePresenceState(value: unknown): PresenceState {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "online" || raw === "disponivel" || raw === "available") {
    return "online";
  }
  if (raw === "idle" || raw === "ausente" || raw === "away") {
    return "idle";
  }
  if (raw === "dnd" || raw === "nao perturbar" || raw === "busy") {
    return "dnd";
  }
  return "invisivel";
}

function normalizePresencePlatform(value: unknown): PresencePlatform {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "desktop" || raw === "mobile" || raw === "browser") {
    return raw;
  }
  return "browser";
}

function getDevicePlatformIcon(platform: PresencePlatform): string {
  switch (platform) {
    case "desktop":
      return "desktop_windows";
    case "mobile":
      return "mobile";
    default:
      return "browser";
  }
}

function formatRelativeLastSeen(timestamp: number | null): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return null;
  }

  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "agora mesmo";
  }

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return "agora mesmo";
  }
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.round(diffMs / minuteMs));
    return minutes === 1 ? "há 1 minuto" : `há ${minutes} minutos`;
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.round(diffMs / hourMs));
    return hours === 1 ? "há 1 hora" : `há ${hours} horas`;
  }

  const days = Math.max(1, Math.round(diffMs / dayMs));
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

function formatSessionActiveForLabel(createdAt: number | null, lastSeenAt: number | null): string {
  const baseTimestamp = Number.isFinite(createdAt ?? NaN) ? (createdAt as number) : lastSeenAt;
  const relative = formatRelativeLastSeen(baseTimestamp);
  if (!relative) {
    return "Ativo recentemente";
  }
  if (relative === "agora mesmo") {
    return "Ativo agora mesmo";
  }
  return `Ativo ${relative}`;
}

function formatDeviceLocationLabel(locationLabelRaw: string | null | undefined): string | null {
  const raw = String(locationLabelRaw ?? "").trim();
  if (!raw) {
    return null;
  }

  const toTitleCase = (value: string): string =>
    value.replace(/\b([A-Za-zÀ-ÿ])([A-Za-zÀ-ÿ'’.-]*)/g, (_match, first: string, rest: string) => {
      return `${first.toLocaleUpperCase("pt-BR")}${rest.toLocaleLowerCase("pt-BR")}`;
    });

  const normalizeCountryName = (value: string): string => {
    const normalized = value.trim().toLocaleLowerCase("pt-BR");
    switch (normalized) {
      case "br":
      case "bra":
      case "brasil":
        return "Brasil";
      case "us":
      case "usa":
      case "estados unidos":
      case "eua":
        return "Estados Unidos";
      case "uk":
      case "gb":
      case "reino unido":
        return "Reino Unido";
      default:
        return toTitleCase(value.trim());
    }
  };

  const parts = raw
    .split(",")
    .map((part) => part.replace(/_/g, " ").replace(/\s+/g, " ").trim())
    .filter((part, index, array) => part.length > 0 && array.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index);

  if (parts.length === 0) {
    return null;
  }

  return parts
    .map((part, index) => (index === parts.length - 1 ? normalizeCountryName(part) : toTitleCase(part)))
    .join(", ");
}

function getPlatformFromLoginSession(session: LoginSessionView): PresencePlatform {
  const normalizedClientType = session.clientType.trim().toLocaleLowerCase();
  if (normalizedClientType === "mobile") {
    return "mobile";
  }
  if (normalizedClientType === "desktop") {
    return "desktop";
  }
  if (normalizedClientType === "web") {
    return "browser";
  }

  const normalizedPlatform = session.platform.trim().toLocaleLowerCase();
  if (normalizedPlatform === "android" || normalizedPlatform === "ios") {
    return "mobile";
  }
  if (normalizedPlatform === "windows" || normalizedPlatform === "macos" || normalizedPlatform === "linux") {
    return "desktop";
  }
  if (normalizedPlatform === "browser") {
    return "browser";
  }

  const device = session.device.trim().toLocaleLowerCase();
  const os = session.os.trim().toLocaleLowerCase();

  if (os.includes("android") || os.includes("ios") || device.includes("mobile")) {
    return "mobile";
  }

  if (
    device.includes("electron") ||
    device.includes("messly desktop") ||
    device.includes("desktop app") ||
    os === "win32" ||
    os === "darwin" ||
    os === "linux"
  ) {
    return "desktop";
  }

  if (
    device.includes("chrome") ||
    device.includes("edge") ||
    device.includes("firefox") ||
    device.includes("opera") ||
    device.includes("safari") ||
    device.includes("browser")
  ) {
    return "browser";
  }

  if (os.includes("windows") || os.includes("mac") || os.includes("linux")) {
    return "desktop";
  }

  return "browser";
}

function formatSessionOsName(osNameRaw: string | null | undefined): string {
  const normalized = String(osNameRaw ?? "").trim();
  if (!normalized) {
    return "Sistema";
  }

  const formattedPlatform = formatRuntimePlatformName(normalized, null);
  return formattedPlatform.trim() || normalized;
}

function mapLoginSessionsToDeviceItems(
  sessions: LoginSessionView[],
  currentSessionId: string | null,
  currentDeviceMetadata: PresenceDeviceMetadata,
): DeviceSessionItem[] {
  const nextItems: DeviceSessionItem[] = sessions.map((session) => {
    const isCurrent = Boolean(currentSessionId && session.id === currentSessionId);
    const platform = getPlatformFromLoginSession(session);
    const parsedCreatedAt = Date.parse(session.createdAt);
    const parsedLastSeenAt = Date.parse(session.lastSeenAt);
    const state: PresenceState = "online";

    return {
      id: session.id,
      sessionId: session.id,
      deviceId: session.deviceId,
      platform,
      state,
      clientName: session.device.trim() || (isCurrent ? currentDeviceMetadata.clientName : "Cliente"),
      osName: formatSessionOsName(session.os),
      locationLabel: session.location,
      lastActive: Number.isFinite(parsedLastSeenAt) ? parsedLastSeenAt : null,
      createdAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : null,
      updatedAt: Number.isFinite(parsedLastSeenAt) ? parsedLastSeenAt : null,
      appVersion: session.appVersion ?? session.clientVersion ?? null,
      ipAddressMasked: session.ipAddressMasked ?? null,
      isCurrent,
      source: "loginSession" as const,
    };
  });

  nextItems.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }

    const leftSort = left.lastActive ?? left.updatedAt ?? 0;
    const rightSort = right.lastActive ?? right.updatedAt ?? 0;
    return rightSort - leftSort;
  });

  return nextItems;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getUsernameCooldownState(lastChangedAtRaw: string | null | undefined): {
  isLocked: boolean;
  remainingDays: number;
  nextAllowedAt: Date | null;
  nextAllowedLabel: string | null;
} {
  const normalizedTimestamp = normalizeStoredIsoTimestamp(lastChangedAtRaw);
  if (!normalizedTimestamp) {
    return {
      isLocked: false,
      remainingDays: 0,
      nextAllowedAt: null,
      nextAllowedLabel: null,
    };
  }

  const nextAllowedAt = new Date(Date.parse(normalizedTimestamp) + USERNAME_CHANGE_COOLDOWN_MS);
  const remainingMs = nextAllowedAt.getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return {
      isLocked: false,
      remainingDays: 0,
      nextAllowedAt,
      nextAllowedLabel: formatShortDate(nextAllowedAt),
    };
  }

  return {
    isLocked: true,
    remainingDays: Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
    nextAllowedAt,
    nextAllowedLabel: formatShortDate(nextAllowedAt),
  };
}

async function queryUserByFirebaseUid(firebaseUid: string) {
  return supabase
    .from("profiles")
    .select(USER_PROFILE_SELECT_COLUMNS)
    .eq("id", firebaseUid)
    .limit(1)
    .maybeSingle();
}

async function queryUserById(userId: string) {
  return supabase.from("profiles").select(USER_PROFILE_SELECT_COLUMNS).eq("id", userId).limit(1).maybeSingle();
}

async function queryUsernameChangedAt(userId: string): Promise<string | null> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return null;
  }

  const { data, error } = await supabase.from("profiles").select("updated_at").eq("id", normalizedUserId).limit(1).maybeSingle();

  if (error) {
    const message = String(error.message ?? "");
    const details = String((error as { details?: string | null }).details ?? "");
    const code = String((error as { code?: string | null }).code ?? "").toUpperCase();
    if (
      isUsersSchemaColumnCacheError(message) ||
      message.toLowerCase().includes("username_changed_at") ||
      details.toLowerCase().includes("username_changed_at") ||
      code.startsWith("PGRST")
    ) {
      return null;
    }
    throw error;
  }

  return normalizeStoredIsoTimestamp((data as { updated_at?: string | null } | null)?.updated_at ?? null);
}

async function updateUserMediaWithSchemaFallback(
  userId: string,
  updates: ProfileMediaUpdatePayload,
): Promise<ProfileMediaUpdatePayload> {
  const allowedKeys: Array<keyof ProfileMediaUpdatePayload> = [
    "avatar_key",
    "avatar_hash",
    "avatar_url",
    "banner_key",
    "banner_hash",
    "banner_url",
  ];

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowedKeys.includes(key as keyof ProfileMediaUpdatePayload)) {
      filtered[key] = value;
    }
  }

  if (Object.keys(filtered).length === 0) {
    return {};
  }

  const { data, error } = await supabase.from("profiles").update(filtered).eq("id", userId).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  if (!data?.id) {
    throw new Error(USERS_UPDATE_ROW_NOT_FOUND_ERROR);
  }

  return filtered as ProfileMediaUpdatePayload;
}

function toPersistedProfileMediaUpdates(
  kind: ProfileMediaKind,
  persistedProfile: unknown,
): ProfileMediaUpdatePayload {
  if (!persistedProfile || typeof persistedProfile !== "object" || Array.isArray(persistedProfile)) {
    return {};
  }

  const relevantKeys =
    kind === "avatar"
      ? ["avatar_key", "avatar_hash", "avatar_url"]
      : ["banner_key", "banner_hash", "banner_url"];

  const normalized: ProfileMediaUpdatePayload = {};
  for (const key of relevantKeys) {
    if (!Object.prototype.hasOwnProperty.call(persistedProfile, key)) {
      continue;
    }

    const rawValue = (persistedProfile as Record<string, unknown>)[key];
    normalized[key] = typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : null;
  }

  return normalized;
}

async function updateUserProfileWithSchemaFallback(
  userId: string,
  updates: UserProfileUpdatePayload,
): Promise<UserProfileUpdatePayload> {
  const allowed = [
    "display_name",
    "username",
    "email",
    "avatar_url",
    "avatar_key",
    "avatar_hash",
    "banner_url",
    "banner_key",
    "banner_hash",
    "bio",
    "about",
    "banner_color",
    "profile_theme_primary_color",
    "profile_theme_accent_color",
    "friend_requests_allow_all",
    "friend_requests_allow_friends_of_friends",
  ];
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      filtered[key] = value;
    }
  }
  if (Object.keys(filtered).length === 0) {
    return {};
  }
  const { data, error } = await supabase.from("profiles").update(filtered).eq("id", userId).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  if (!data?.id) {
    throw new Error(USERS_UPDATE_ROW_NOT_FOUND_ERROR);
  }
  return filtered as UserProfileUpdatePayload;
}

function ProcessingCheckbox({ checked, onChange, ariaLabel }: ProcessingCheckboxProps) {
  return (
    <label className={styles.processingCoreCheckbox}>
      <input
        className={styles.processingCoreCheckboxInput}
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className={`${styles.processingCoreCheckboxFill} ${styles.processingCoreCheckboxTransition}`} aria-hidden="true" />
      <span className={`${styles.processingCoreCheckboxIcon} ${styles.processingCoreCheckboxTransition}`} aria-hidden="true">
        <MaterialSymbolIcon name="done" size={16} filled={true} />
      </span>
    </label>
  );
}

export default function AppSettingsView({
  onClose,
  currentUserId = null,
  initialSection = "account",
}: AppSettingsViewProps) {
  const { user, signOutCurrent, updateCurrentAccountProfile } = useAuthSession();
  const isElectron =
    typeof window !== "undefined" &&
    Boolean(window?.navigator?.userAgent?.toLowerCase().includes("electron"));
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    resolveVisibleSettingsSection(initialSection, isElectron),
  );
  const visibleSettingsSidebarItems = useMemo(
    () => SETTINGS_SIDEBAR_ITEMS.filter((item) => isElectron || item.key !== "windows"),
    [isElectron],
  );
  useEffect(() => {
    setActiveSection(resolveVisibleSettingsSection(initialSection, isElectron));
  }, [initialSection, isElectron]);
  useEffect(() => {
    if (activeSection !== "account") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      accountContentRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeSection]);

  const [dbUserId, setDbUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("Nome");
  const [savedDisplayName, setSavedDisplayName] = useState("Nome");
  const [username, setUsername] = useState("username");
  const [accountUsernameChangedAt, setAccountUsernameChangedAt] = useState<string | null>(null);
  const [about, setAbout] = useState("");
  const [savedAbout, setSavedAbout] = useState("");
  const [bannerColor, setBannerColor] = useState<string | null>(null);
  const [savedBannerColor, setSavedBannerColor] = useState<string | null>(null);
  const [profileThemePrimaryColor, setProfileThemePrimaryColor] = useState<string>(DEFAULT_PLUS_PROFILE_PRIMARY_COLOR);
  const [savedProfileThemePrimaryColor, setSavedProfileThemePrimaryColor] = useState<string>(DEFAULT_PLUS_PROFILE_PRIMARY_COLOR);
  const [profileThemeAccentColor, setProfileThemeAccentColor] = useState<string>(DEFAULT_PLUS_PROFILE_ACCENT_COLOR);
  const [savedProfileThemeAccentColor, setSavedProfileThemeAccentColor] = useState<string>(DEFAULT_PLUS_PROFILE_ACCENT_COLOR);
  const [isProfileThemeColorPickerOpen, setIsProfileThemeColorPickerOpen] = useState(false);
  const [profileThemeColorPickerSlot, setProfileThemeColorPickerSlot] = useState<ProfileThemeColorSlot>("primary");
  const [profileThemeColorInput, setProfileThemeColorInput] = useState(
    getBannerColorInputValue(DEFAULT_PLUS_PROFILE_PRIMARY_COLOR),
  );
  const [profileThemeColorHue, setProfileThemeColorHue] = useState(0);
  const [profileThemeColorSaturation, setProfileThemeColorSaturation] = useState(0);
  const [profileThemeColorValue, setProfileThemeColorValue] = useState(0);
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
  const [bannerSrc, setBannerSrc] = useState<string>(() => {
    const cachedMedia = readSidebarResolvedMediaFallback(user?.uid ?? null);
    const cachedBannerSrc = String(cachedMedia?.bannerSrc ?? "").trim();
    return cachedBannerSrc || getDefaultBannerUrl();
  });
  const [isProfileIdentityLoading, setIsProfileIdentityLoading] = useState(true);
  const [accountModalKind, setAccountModalKind] = useState<AccountModalKind | null>(null);
  const [accountActionFeedback, setAccountActionFeedback] = useState<UploadFeedbackState | null>(null);
  const [isAccountEmailVisible, setIsAccountEmailVisible] = useState(false);
  const [isAccountActionPending, setIsAccountActionPending] = useState(false);
  const [accountUsernameInput, setAccountUsernameInput] = useState("");
  const [accountUsernamePasswordInput, setAccountUsernamePasswordInput] = useState("");
  const [accountUsernameModalFeedback, setAccountUsernameModalFeedback] = useState<UploadFeedbackState | null>(null);
  const [accountUsernameAvailabilityFeedback, setAccountUsernameAvailabilityFeedback] =
    useState<ModalAvailabilityFeedbackState | null>(null);
  const [isAccountUsernameAvailabilityPending, setIsAccountUsernameAvailabilityPending] = useState(false);
  const [accountEmailModalStep, setAccountEmailModalStep] = useState<AccountEmailModalStep>("verifyCurrent");
  const [accountCurrentEmailInput, setAccountCurrentEmailInput] = useState("");
  const [accountCurrentPasswordInput, setAccountCurrentPasswordInput] = useState("");
  const [accountNewEmailInput, setAccountNewEmailInput] = useState("");
  const [accountEmailModalFeedback, setAccountEmailModalFeedback] = useState<UploadFeedbackState | null>(null);
  const [accountPasswordCurrentInput, setAccountPasswordCurrentInput] = useState("");
  const [accountPasswordNewInput, setAccountPasswordNewInput] = useState("");
  const [accountPasswordConfirmInput, setAccountPasswordConfirmInput] = useState("");
  const [accountPasswordModalFeedback, setAccountPasswordModalFeedback] = useState<UploadFeedbackState | null>(null);
  const [accountDeactivatePasswordInput, setAccountDeactivatePasswordInput] = useState("");
  const [accountDeactivateConfirmInput, setAccountDeactivateConfirmInput] = useState("");
  const [accountDeactivateModalFeedback, setAccountDeactivateModalFeedback] = useState<UploadFeedbackState | null>(null);
  const [accountDeletePasswordInput, setAccountDeletePasswordInput] = useState("");
  const [accountDeleteConfirmInput, setAccountDeleteConfirmInput] = useState("");
  const [accountDeleteModalFeedback, setAccountDeleteModalFeedback] = useState<UploadFeedbackState | null>(null);
  const [isSidebarSignOutPending, setIsSidebarSignOutPending] = useState(false);
  const [sidebarSignOutFeedback, setSidebarSignOutFeedback] = useState<string | null>(null);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [isBannerUploading, setIsBannerUploading] = useState(false);
  const [isPreviewBannerHotspotActive, setIsPreviewBannerHotspotActive] = useState(false);
  const [isPreviewAvatarHotspotActive, setIsPreviewAvatarHotspotActive] = useState(false);
  const [avatarFeedback, setAvatarFeedback] = useState<UploadFeedbackState | null>(null);
  const [bannerFeedback, setBannerFeedback] = useState<UploadFeedbackState | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<UploadFeedbackState | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [pendingImageEdit, setPendingImageEdit] = useState<PendingImageEdit | null>(null);
  const [uploadLimitModal, setUploadLimitModal] = useState<UploadLimitModalState | null>(null);
  const [friendRequestPrivacy, setFriendRequestPrivacy] = useState<FriendRequestPrivacySettings>(
    DEFAULT_FRIEND_REQUEST_PRIVACY_SETTINGS,
  );
  const [friendRequestPrivacyError, setFriendRequestPrivacyError] = useState<string | null>(null);
  const [savingFriendRequestPrivacyKey, setSavingFriendRequestPrivacyKey] =
    useState<keyof FriendRequestPrivacySettings | null>(null);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSessionItem[]>([]);
  const [isDeviceSessionsLoading, setIsDeviceSessionsLoading] = useState(false);
  const [deviceSessionsError, setDeviceSessionsError] = useState<string | null>(null);
  const [deviceSessionsFeedback, setDeviceSessionsFeedback] = useState<UploadFeedbackState | null>(null);
  const [endingDeviceSessionId, setEndingDeviceSessionId] = useState<string | null>(null);
  const [isEndingAllOtherDeviceSessions, setIsEndingAllOtherDeviceSessions] = useState(false);
  const [pendingDeviceSession, setPendingDeviceSession] = useState<DeviceSessionItem | null>(null);
  const [pendingDeviceSessionPasswordInput, setPendingDeviceSessionPasswordInput] = useState("");
  const [pendingDeviceSessionFeedback, setPendingDeviceSessionFeedback] = useState<UploadFeedbackState | null>(null);
  const [isEndAllOtherSessionsModalOpen, setIsEndAllOtherSessionsModalOpen] = useState(false);
  const [endAllOtherSessionsPasswordInput, setEndAllOtherSessionsPasswordInput] = useState("");
  const [endAllOtherSessionsFeedback, setEndAllOtherSessionsFeedback] = useState<UploadFeedbackState | null>(null);
  const recentlyEndedDeviceSessionsRef = useRef<Map<string, number>>(new Map());
  const dismissedLoginSessionsRef = useRef<Map<string, number>>(new Map());
  const [currentPresenceDeviceMetadata, setCurrentPresenceDeviceMetadata] = useState(() =>
    getPresenceDeviceMetadataSnapshot(),
  );
  const [blockedAccounts, setBlockedAccounts] = useState<BlockedAccountItem[]>([]);
  const [isBlockedAccountsLoading, setIsBlockedAccountsLoading] = useState(false);
  const [blockedAccountsError, setBlockedAccountsError] = useState<string | null>(null);
  const [blockedSearchQuery, setBlockedSearchQuery] = useState("");
  const [unblockingUserId, setUnblockingUserId] = useState<string | null>(null);
  const [windowsBehaviorSettings, setWindowsBehaviorSettings] = useState<WindowsBehaviorSettings>(
    DEFAULT_WINDOWS_BEHAVIOR_SETTINGS,
  );
  const [isWindowsBehaviorLoading, setIsWindowsBehaviorLoading] = useState(false);
  const [windowsBehaviorError, setWindowsBehaviorError] = useState<string | null>(null);
  const [savingWindowsBehaviorKey, setSavingWindowsBehaviorKey] = useState<keyof WindowsBehaviorSettings | null>(null);
  const [spotifyConnection, setSpotifyConnection] = useState<SpotifyConnectionState>(createDefaultSpotifyConnection);
  const [isSpotifyConnecting, setIsSpotifyConnecting] = useState(false);
  const [spotifyConnectionError, setSpotifyConnectionError] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [isInputDeviceSelectOpen, setIsInputDeviceSelectOpen] = useState(false);
  const [isOutputDeviceSelectOpen, setIsOutputDeviceSelectOpen] = useState(false);
  const [inputGain, setInputGain] = useState(100);
  const [outputVolume, setOutputVolume] = useState(100);
  const [noiseSuppressionMode, setNoiseSuppressionMode] = useState<NoiseSuppressionMode>("webrtc");
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [vadEnabled, setVadEnabled] = useState(true);
  const [autoMicSensitivity, setAutoMicSensitivity] = useState(true);
  const [manualMicSensitivity, setManualMicSensitivity] = useState(-70);
  const [qosHighPriority, setQosHighPriority] = useState(false);
  const [pushToTalkEnabled, setPushToTalkEnabled] = useState(false);
  const [pushToTalkBind, setPushToTalkBind] = useState(DEFAULT_PUSH_TO_TALK_BIND);
  const [listeningForBind, setListeningForBind] = useState(false);
  const bannerColorPickerRef = useRef<HTMLDivElement | null>(null);
  const bannerColorAreaRef = useRef<HTMLDivElement | null>(null);
  const profileThemeColorPickerRef = useRef<HTMLDivElement | null>(null);
  const profileThemeColorAreaRef = useRef<HTMLDivElement | null>(null);
  const profileThemeColorPopoverRef = useRef<HTMLDivElement | null>(null);
  const [profileThemeColorPopoverPosition, setProfileThemeColorPopoverPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const bannerFileInputRef = useRef<HTMLInputElement | null>(null);
  const accountContentRef = useRef<HTMLDivElement | null>(null);
  const temporaryAvatarUrlRef = useRef<string | null>(null);
  const temporaryBannerUrlRef = useRef<string | null>(null);
  const windowsBehaviorLoadedRef = useRef(false);
  const audioSettingsLoadedRef = useRef(false);
  const inputDeviceSelectRef = useRef<HTMLDivElement | null>(null);
  const outputDeviceSelectRef = useRef<HTMLDivElement | null>(null);
  const accountProfileSyncSignatureRef = useRef<string>("");
  const normalizedInputGain = clamp(Math.round(inputGain), 0, 100);
  const normalizedOutputVolume = clamp(Math.round(outputVolume), 0, 200);
  const displayedMicSensitivity = manualMicSensitivity;
  const inputVolumeProgressPercent = clamp(normalizedInputGain, 0, 100);
  const outputVolumeProgressPercent = clamp((normalizedOutputVolume / 200) * 100, 0, 100);
  const inputVolumeSliderStyle = {
    "--volume-progress": `${inputVolumeProgressPercent}%`,
  } as CSSProperties;
  const outputVolumeSliderStyle = {
    "--volume-progress": `${outputVolumeProgressPercent}%`,
  } as CSSProperties;
  const micSensitivityProgressPercent = clamp(displayedMicSensitivity + 100, 0, 100);
  const micSensitivitySliderStyle = {
    "--sensitivity-progress": `${micSensitivityProgressPercent}%`,
  } as CSSProperties;
  const audioSettingsStorageKey = useMemo(() => buildAudioSettingsStorageKey(user?.uid ?? null), [user?.uid]);
  const spotifyConnectionScope = useMemo(
    () => String(dbUserId ?? currentUserId ?? user?.uid ?? "").trim() || null,
    [currentUserId, dbUserId, user?.uid],
  );
  const normalizedProfileThemePrimaryColor = useMemo(
    () => normalizeBannerColor(profileThemePrimaryColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR,
    [profileThemePrimaryColor],
  );
  const normalizedProfileThemeAccentColor = useMemo(
    () => normalizeBannerColor(profileThemeAccentColor) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR,
    [profileThemeAccentColor],
  );
  const safeBannerColor = useMemo(() => normalizeBannerColor(bannerColor), [bannerColor]);
  const draftProfileTheme = useMemo(
    () => ({
      primary: normalizedProfileThemePrimaryColor,
      accent: normalizedProfileThemeAccentColor,
    }),
    [normalizedProfileThemeAccentColor, normalizedProfileThemePrimaryColor],
  );
  const savedProfileTheme = useMemo(
    () => ({
      primary: normalizeBannerColor(savedProfileThemePrimaryColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR,
      accent: normalizeBannerColor(savedProfileThemeAccentColor) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR,
    }),
    [savedProfileThemeAccentColor, savedProfileThemePrimaryColor],
  );
  const activeProfileThemePickerColor = useMemo(
    () =>
      profileThemeColorPickerSlot === "primary"
        ? draftProfileTheme.primary
        : draftProfileTheme.accent,
    [draftProfileTheme, profileThemeColorPickerSlot],
  );
  const hasAvatarMedia = useMemo(() => {
    const resolvedAvatarSrc = avatarSrc.trim();
    return resolvedAvatarSrc.length > 0 && !isDefaultAvatarUrl(resolvedAvatarSrc);
  }, [avatarSrc]);
  const hasBannerMedia = useMemo(() => {
    const resolvedBannerSrc = bannerSrc.trim();
    return resolvedBannerSrc.length > 0 && resolvedBannerSrc !== getDefaultBannerUrl();
  }, [bannerSrc]);
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);
  const isWindowsDesktopRuntime = isDesktopRuntime && window.electronAPI?.platform === "win32";
  const canManageWindowsBehavior =
    isWindowsDesktopRuntime &&
    typeof window.electronAPI?.getWindowsSettings === "function" &&
    typeof window.electronAPI?.updateWindowsSettings === "function";
  const currentPresenceDeviceId = useMemo(
    () => (typeof window === "undefined" ? null : getOrCreatePresenceDeviceId()),
    [],
  );
  const dismissedLoginSessionsStorageScope = useMemo(
    () => String(user?.uid ?? "").trim() || null,
    [user?.uid],
  );
  const loginSessionsCacheStorageScope = useMemo(
    () => String(user?.uid ?? "").trim() || null,
    [user?.uid],
  );
  useEffect(() => {
    dismissedLoginSessionsRef.current = readDismissedLoginSessions(dismissedLoginSessionsStorageScope);
  }, [dismissedLoginSessionsStorageScope]);
  useEffect(() => {
    if (!deviceSessionsFeedback) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDeviceSessionsFeedback(null);
    }, 5_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [deviceSessionsFeedback]);
  useEffect(() => {
    if (activeSection !== "devices") {
      return;
    }

    let cancelled = false;
    setCurrentPresenceDeviceMetadata(getPresenceDeviceMetadataSnapshot());

    void hydratePresenceDeviceMetadata()
      .then((metadata) => {
        if (!cancelled) {
          setCurrentPresenceDeviceMetadata(metadata);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentPresenceDeviceMetadata(getPresenceDeviceMetadataSnapshot());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection]);
  const settingsVersion = String(appPackage.version ?? "0.0.0").trim() || "0.0.0";
  const runtimePlatformLabel = useMemo(
    () => formatRuntimePlatformName(isDesktopRuntime ? window.electronAPI?.platform : "web", window.electronAPI?.arch),
    [isDesktopRuntime],
  );
  const runtimeEngineLabel = useMemo(
    () =>
      isDesktopRuntime && window.electronAPI?.versions?.electron
        ? `Electron ${window.electronAPI.versions.electron}`
        : "Navegador",
    [isDesktopRuntime],
  );
  const releaseChannelLabel = useMemo(() => formatReleaseChannelLabel(APP_RELEASE_CHANNEL), []);
  const defaultInputDeviceLabel = useMemo(
    () => formatDeviceOptionLabel(audioInputs[0]?.label, "Microfone"),
    [audioInputs],
  );
  const defaultOutputDeviceLabel = useMemo(
    () => formatDeviceOptionLabel(audioOutputs[0]?.label, "Saída"),
    [audioOutputs],
  );
  const inputDeviceOptions = useMemo(
    () => buildUniqueAudioDeviceOptions(audioInputs, defaultInputDeviceLabel, "Microfone", selectedInputId),
    [audioInputs, defaultInputDeviceLabel, selectedInputId],
  );
  const outputDeviceOptions = useMemo(
    () => buildUniqueAudioDeviceOptions(audioOutputs, defaultOutputDeviceLabel, "Dispositivo de saída", selectedOutputId),
    [audioOutputs, defaultOutputDeviceLabel, selectedOutputId],
  );
  const selectedInputDeviceOption = useMemo(
    () => inputDeviceOptions.find((option) => option.value === selectedInputId) ?? inputDeviceOptions[0] ?? null,
    [inputDeviceOptions, selectedInputId],
  );
  const selectedOutputDeviceOption = useMemo(
    () => outputDeviceOptions.find((option) => option.value === selectedOutputId) ?? outputDeviceOptions[0] ?? null,
    [outputDeviceOptions, selectedOutputId],
  );
  const settingsSidebarVersionPrimary = `Messly ${settingsVersion}`;
  const settingsSidebarVersionSecondary = `${releaseChannelLabel} · ${runtimePlatformLabel} · ${runtimeEngineLabel}`;
  const pendingProfile = useMemo(() => {
    if (!user?.uid || typeof window === "undefined") {
      return null;
    }
    const candidate = loadPendingProfile();
    if (!candidate || candidate.firebaseUid !== user.uid) {
      return null;
    }
    return candidate;
  }, [user?.uid]);
  const sessionFallbackUsername = useMemo(
    () => deriveSessionFallbackUsername(user?.uid ?? null, pendingProfile?.username ?? null),
    [pendingProfile?.username, user?.uid],
  );
  const sessionFallbackDisplayName = useMemo(
    () =>
      String(pendingProfile?.displayName ?? "").trim() ||
      String(user?.displayName ?? "").trim() ||
      sessionFallbackUsername ||
      "Usuário",
    [pendingProfile?.displayName, sessionFallbackUsername, user?.displayName],
  );

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
      setSelectedInputId((current) => {
        if (!current) {
          return "";
        }
        return nextInputs.some((device) => device.deviceId === current) ? current : "";
      });
      setSelectedOutputId((current) => {
        if (!current) {
          return "";
        }
        return nextOutputs.some((device) => device.deviceId === current) ? current : "";
      });
    } catch {
      // Ignore enumerateDevices failures on unsupported environments.
    }
  };

  const handlePushToTalkChange = (isEnabled: boolean): void => {
    setPushToTalkEnabled(isEnabled);
    if (!isEnabled) {
      setListeningForBind(false);
    }
  };

  const handleSelectInputDevice = (value: string): void => {
    setSelectedInputId(value);
    setIsInputDeviceSelectOpen(false);
  };

  const handleSelectOutputDevice = (value: string): void => {
    setSelectedOutputId(value);
    setIsOutputDeviceSelectOpen(false);
  };

  const handleManualMicSensitivityChange = (value: number): void => {
    setManualMicSensitivity(clamp(Math.round(value), -100, 0));
  };

  const handleMicSensitivitySliderChange = (value: number): void => {
    if (autoMicSensitivity) {
      setAutoMicSensitivity(false);
    }
    handleManualMicSensitivityChange(value);
  };

  useEffect(() => {
    if (!sessionFallbackDisplayName) {
      return;
    }

    setDisplayName((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "Nome" && trimmed !== "Usuário") {
        return current;
      }
      return sessionFallbackDisplayName;
    });
    setSavedDisplayName((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "Nome" && trimmed !== "Usuário") {
        return current;
      }
      return sessionFallbackDisplayName;
    });
  }, [sessionFallbackDisplayName]);

  useEffect(() => {
    if (!sessionFallbackUsername) {
      return;
    }

    setUsername((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "username" && trimmed !== "usuario") {
        return current;
      }
      return sessionFallbackUsername;
    });
  }, [sessionFallbackUsername]);

  useEffect(() => {
    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      return;
    }
    setDbUserId((current) => (current && current.trim().length > 0 ? current : normalizedCurrentUserId));
  }, [currentUserId]);

  useEffect(() => {
    setSpotifyConnection(readSpotifyConnection(spotifyConnectionScope));
    return subscribeSpotifyConnection(spotifyConnectionScope, setSpotifyConnection);
  }, [spotifyConnectionScope]);

  useEffect(() => {
    const normalizedColor = normalizeBannerColor(bannerColor) ?? DEFAULT_BANNER_COLOR;
    const nextHsv = hexToHsv(normalizedColor);
    setBannerColorHue(nextHsv.h);
    setBannerColorSaturation(nextHsv.s);
    setBannerColorValue(nextHsv.v);
  }, [bannerColor]);

  useEffect(() => {
    if (!isProfileThemeColorPickerOpen) {
      return;
    }
    const normalizedColor = normalizeBannerColor(activeProfileThemePickerColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR;
    const nextHsv = hexToHsv(normalizedColor);
    setProfileThemeColorInput(normalizedColor.toUpperCase());
    setProfileThemeColorHue(nextHsv.h);
    setProfileThemeColorSaturation(nextHsv.s);
    setProfileThemeColorValue(nextHsv.v);
  }, [activeProfileThemePickerColor, isProfileThemeColorPickerOpen]);

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
    if (!isProfileThemeColorPickerOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const pickerElement = profileThemeColorPickerRef.current;
      if (!pickerElement || !(event.target instanceof Node) || pickerElement.contains(event.target)) {
        return;
      }
      setIsProfileThemeColorPickerOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsProfileThemeColorPickerOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProfileThemeColorPickerOpen]);

  useLayoutEffect(() => {
    if (!isProfileThemeColorPickerOpen) {
      setProfileThemeColorPopoverPosition(null);
      return;
    }

    const updatePopoverPosition = (): void => {
      const anchorElement = profileThemeColorPickerRef.current;
      const popoverElement = profileThemeColorPopoverRef.current;
      if (!anchorElement || !popoverElement) {
        return;
      }

      const anchorRect = anchorElement.getBoundingClientRect();
      const popoverRect = popoverElement.getBoundingClientRect();
      const viewportMargin = 12;
      const gap = 10;
      const width = Math.max(popoverRect.width, popoverElement.offsetWidth);
      const height = Math.max(popoverRect.height, popoverElement.offsetHeight);

      const nextLeft = clamp(anchorRect.left, viewportMargin, window.innerWidth - width - viewportMargin);
      const nextTop = clamp(anchorRect.bottom + gap, viewportMargin, window.innerHeight - height - viewportMargin);

      setProfileThemeColorPopoverPosition((current) => {
        if (current && Math.abs(current.left - nextLeft) < 0.5 && Math.abs(current.top - nextTop) < 0.5) {
          return current;
        }
        return { top: nextTop, left: nextLeft };
      });
    };

    const frameId = window.requestAnimationFrame(updatePopoverPosition);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [isProfileThemeColorPickerOpen, profileThemeColorPickerSlot]);

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
      const normalizedNoiseSuppressionMode = (() => {
        const modeRaw = String(parsed.noiseSuppressionMode ?? "").trim().toLowerCase();
        if (modeRaw === "off" || modeRaw === "webrtc" || modeRaw === "rnnoise") {
          return modeRaw as NoiseSuppressionMode;
        }
        if (typeof parsed.noiseSuppression === "boolean") {
          return parsed.noiseSuppression ? "webrtc" : "off";
        }
        return "webrtc";
      })();
      setNoiseSuppressionMode(normalizedNoiseSuppressionMode);
      setEchoCancellation(typeof parsed.echoCancellation === "boolean" ? parsed.echoCancellation : true);
      setAutoGainControl(typeof parsed.autoGain === "boolean" ? parsed.autoGain : true);
      setVadEnabled(typeof parsed.vadEnabled === "boolean" ? parsed.vadEnabled : true);
      setAutoMicSensitivity(typeof parsed.autoSensitivity === "boolean" ? parsed.autoSensitivity : true);
      if (typeof parsed.sensitivityDb === "number" && Number.isFinite(parsed.sensitivityDb)) {
        setManualMicSensitivity(clamp(Math.round(parsed.sensitivityDb), -100, 0));
      }
      setQosHighPriority(typeof parsed.qosHighPriority === "boolean" ? parsed.qosHighPriority : false);
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
      noiseSuppressionMode,
      noiseSuppression: noiseSuppressionMode !== "off",
      echoCancellation,
      autoGain: autoGainControl,
      vadEnabled,
      autoSensitivity: autoMicSensitivity,
      sensitivityDb: clamp(Math.round(manualMicSensitivity), -100, 0),
      pushToTalkEnabled,
      pushToTalkBind: normalizePushToTalkBind(pushToTalkBind),
      qosHighPriority,
    };

    try {
      window.localStorage.setItem(audioSettingsStorageKey, JSON.stringify(payload));
      window.dispatchEvent(
        new CustomEvent(AUDIO_SETTINGS_UPDATED_EVENT, {
          detail: {
            storageKey: audioSettingsStorageKey,
            qosHighPriority: payload.qosHighPriority,
          },
        }),
      );
    } catch {
      // Ignore persistence errors.
    }
  }, [
    audioSettingsStorageKey,
    selectedInputId,
    selectedOutputId,
    inputGain,
    outputVolume,
    noiseSuppressionMode,
    echoCancellation,
    autoGainControl,
    vadEnabled,
    autoMicSensitivity,
    manualMicSensitivity,
    pushToTalkEnabled,
    pushToTalkBind,
    qosHighPriority,
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
    if (!isInputDeviceSelectOpen && !isOutputDeviceSelectOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      const clickedInsideInput = inputDeviceSelectRef.current?.contains(target) ?? false;
      const clickedInsideOutput = outputDeviceSelectRef.current?.contains(target) ?? false;
      if (clickedInsideInput || clickedInsideOutput) {
        return;
      }

      setIsInputDeviceSelectOpen(false);
      setIsOutputDeviceSelectOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      setIsInputDeviceSelectOpen(false);
      setIsOutputDeviceSelectOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isInputDeviceSelectOpen, isOutputDeviceSelectOpen]);

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
    const stored = readProfilePlusThemeSettings(user?.uid ?? null);
    setProfileThemePrimaryColor(stored.primary);
    setSavedProfileThemePrimaryColor(stored.primary);
    setProfileThemeAccentColor(stored.accent);
    setSavedProfileThemeAccentColor(stored.accent);
  }, [user?.uid]);

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
      const cachedUsernameChangedAt = readUsernameChangeFallback(stableFirebaseUid ?? stableCurrentUserId);

      if (isMounted) {
        setAccountUsernameChangedAt(cachedUsernameChangedAt);
      }

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
        const fallbackUsername =
          String(cachedIdentity?.username ?? "").trim() || sessionFallbackUsername || "usuario";
        const fallbackDisplayName = cachedIdentity?.displayName || (user?.displayName ?? "").trim() || fallbackUsername || "Nome";
        const fallbackAbout = String(cachedIdentity?.about ?? "").slice(0, ABOUT_MAX_LENGTH);
        const fallbackAvatarSource = cachedIdentity?.avatarUrl ?? cachedMedia?.avatarSrc ?? null;
        const fallbackBannerSource = cachedIdentity?.bannerKey ?? null;

        if (stableCurrentUserId) {
          setDbUserId(stableCurrentUserId);
        }
        setDisplayName(fallbackDisplayName);
        setSavedDisplayName(fallbackDisplayName);
        setUsername(fallbackUsername);
        setAccountUsernameChangedAt(cachedUsernameChangedAt);
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
      const rowHasUsernameChangedAt = Object.prototype.hasOwnProperty.call(row, "username_changed_at");
      const resolvedUsernameChangedAtFromDatabase = rowHasUsernameChangedAt
        ? normalizeStoredIsoTimestamp(row.username_changed_at ?? null)
        : null;
      const resolvedUsernameChangedAt = resolvedUsernameChangedAtFromDatabase ?? cachedUsernameChangedAt;

      setDbUserId(row.id ?? null);
      const resolvedUsername = (row.username ?? "").trim() || sessionFallbackUsername || "usuario";
      const resolvedDisplayName =
        (row.display_name ?? "").trim() ||
        resolvedUsername ||
        (user?.displayName ?? "").trim() ||
        "Nome";
      const resolvedAbout = (row.about ?? "").slice(0, ABOUT_MAX_LENGTH);
      const resolvedBannerColor = normalizeBannerColor(row.banner_color) ?? null;
      const rowHasProfileThemePrimaryColor = Object.prototype.hasOwnProperty.call(row, "profile_theme_primary_color");
      const rowHasProfileThemeAccentColor = Object.prototype.hasOwnProperty.call(row, "profile_theme_accent_color");
      const normalizedLegacyPrimary = normalizeBannerColor(LEGACY_PLUS_PROFILE_PRIMARY_COLOR);
      const normalizedLegacyAccent = normalizeBannerColor(LEGACY_PLUS_PROFILE_ACCENT_COLOR);
      const normalizedRowPrimary = normalizeBannerColor(row.profile_theme_primary_color);
      const normalizedRowAccent = normalizeBannerColor(row.profile_theme_accent_color);
      const resolvedProfileThemePrimaryColor =
        !normalizedRowPrimary || normalizedRowPrimary === normalizedLegacyPrimary
          ? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR
          : normalizedRowPrimary;
      const resolvedProfileThemeAccentColor =
        !normalizedRowAccent || normalizedRowAccent === normalizedLegacyAccent
          ? DEFAULT_PLUS_PROFILE_ACCENT_COLOR
          : normalizedRowAccent;
      const fallbackProfileThemePrimaryColor =
        normalizeBannerColor(savedProfileThemePrimaryColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR;
      const fallbackProfileThemeAccentColor =
        normalizeBannerColor(savedProfileThemeAccentColor) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR;
      const resolvedFriendRequestPrivacy = getFriendRequestPrivacySettings(row);
      setDisplayName(resolvedDisplayName);
      setSavedDisplayName(resolvedDisplayName);
      setUsername(resolvedUsername);
      setAccountUsernameChangedAt(resolvedUsernameChangedAt);
      setFriendRequestPrivacy(resolvedFriendRequestPrivacy);
      setFriendRequestPrivacyError(null);
      setAbout(resolvedAbout);
      setSavedAbout(resolvedAbout);
      setBannerColor(resolvedBannerColor);
      setSavedBannerColor(resolvedBannerColor);
      setBannerColorInput(getBannerColorInputValue(resolvedBannerColor));
      if (rowHasProfileThemePrimaryColor) {
        setProfileThemePrimaryColor(resolvedProfileThemePrimaryColor);
        setSavedProfileThemePrimaryColor(resolvedProfileThemePrimaryColor);
      }
      if (rowHasProfileThemeAccentColor) {
        setProfileThemeAccentColor(resolvedProfileThemeAccentColor);
        setSavedProfileThemeAccentColor(resolvedProfileThemeAccentColor);
      }
      if (rowHasProfileThemePrimaryColor || rowHasProfileThemeAccentColor) {
        writeProfilePlusThemeSettings(user?.uid ?? null, {
          primary: rowHasProfileThemePrimaryColor
            ? resolvedProfileThemePrimaryColor
            : fallbackProfileThemePrimaryColor,
          accent: rowHasProfileThemeAccentColor
            ? resolvedProfileThemeAccentColor
            : fallbackProfileThemeAccentColor,
        });
      }
      setAvatarUrl((row.avatar_url ?? "").trim() || null);
      setAvatarKey((row.avatar_key ?? "").trim() || null);
      setAvatarHash((row.avatar_hash ?? "").trim() || null);
      setBannerKey((row.banner_key ?? "").trim() || null);
      setBannerHash((row.banner_hash ?? "").trim() || null);
      writeUsernameChangeFallback(stableFirebaseUid ?? row.id ?? stableCurrentUserId, resolvedUsernameChangedAt);
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
  }, [currentUserId, sessionFallbackUsername, user?.displayName, user?.uid]);

  useEffect(() => {
    const resolvedUserId = String(dbUserId ?? currentUserId ?? "").trim();
    if (!resolvedUserId) {
      return;
    }

    const usernameChangeStorageScope = user?.uid ?? resolvedUserId;

    const handleProfileUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileUpdatedDetail>).detail;
      if (!detail?.userId || detail.userId !== resolvedUserId) {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(detail, "username")) {
        const nextUsername = String(detail.username ?? "").trim().toLowerCase() || username;
        setUsername(nextUsername);
        if (accountModalKind !== "username") {
          setAccountUsernameInput(nextUsername);
        }
      }

      if (Object.prototype.hasOwnProperty.call(detail, "display_name")) {
        const fallbackUsername = String(detail.username ?? username).trim().toLowerCase();
        const nextDisplayName = String(detail.display_name ?? "").trim() || fallbackUsername || "Nome";
        setDisplayName(nextDisplayName);
        setSavedDisplayName(nextDisplayName);
      }

      if (Object.prototype.hasOwnProperty.call(detail, "about")) {
        const nextAbout = String(detail.about ?? "").slice(0, ABOUT_MAX_LENGTH);
        setAbout(nextAbout);
        setSavedAbout(nextAbout);
      }

      if (Object.prototype.hasOwnProperty.call(detail, "banner_color")) {
        const nextBannerColor = normalizeBannerColor(detail.banner_color) ?? null;
        setBannerColor(nextBannerColor);
        setSavedBannerColor(nextBannerColor);
        setBannerColorInput(getBannerColorInputValue(nextBannerColor));
      }

      const hasPrimary = Object.prototype.hasOwnProperty.call(detail, "profile_theme_primary_color");
      const hasAccent = Object.prototype.hasOwnProperty.call(detail, "profile_theme_accent_color");
      if (hasPrimary || hasAccent) {
        const nextPrimary = hasPrimary
          ? normalizeBannerColor(detail.profile_theme_primary_color) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR
          : normalizeBannerColor(profileThemePrimaryColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR;
        const nextAccent = hasAccent
          ? normalizeBannerColor(detail.profile_theme_accent_color) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR
          : normalizeBannerColor(profileThemeAccentColor) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR;

        setProfileThemePrimaryColor(nextPrimary);
        setSavedProfileThemePrimaryColor(nextPrimary);
        setProfileThemeAccentColor(nextAccent);
        setSavedProfileThemeAccentColor(nextAccent);
        writeProfilePlusThemeSettings(user?.uid ?? null, {
          primary: nextPrimary,
          accent: nextAccent,
        });
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(PROFILE_PLUS_THEME_UPDATED_EVENT, {
              detail: {
                userUid: user?.uid ?? null,
                primary: nextPrimary,
                accent: nextAccent,
              },
            }),
          );
        }
      }

      if (Object.prototype.hasOwnProperty.call(detail, "username_changed_at")) {
        const normalizedChangedAt = normalizeStoredIsoTimestamp(detail.username_changed_at ?? null);
        setAccountUsernameChangedAt(normalizedChangedAt);
        writeUsernameChangeFallback(usernameChangeStorageScope, normalizedChangedAt);
      }
    };

    const handleProfileMediaUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ProfileMediaUpdatedDetail>).detail;
      if (!detail?.userId || detail.userId !== resolvedUserId) {
        return;
      }

      if (Object.prototype.hasOwnProperty.call(detail, "avatar_key")) {
        setAvatarKey(detail.avatar_key ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(detail, "avatar_hash")) {
        setAvatarHash(detail.avatar_hash ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(detail, "avatar_url")) {
        setAvatarUrl(detail.avatar_url ?? null);
      }

      if (Object.prototype.hasOwnProperty.call(detail, "banner_key")) {
        setBannerKey(detail.banner_key ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(detail, "banner_hash")) {
        setBannerHash(detail.banner_hash ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(detail, "banner_color")) {
        const nextBannerColor = normalizeBannerColor(detail.banner_color) ?? null;
        setBannerColor(nextBannerColor);
        setSavedBannerColor(nextBannerColor);
        setBannerColorInput(getBannerColorInputValue(nextBannerColor));
      }

      const avatarKeyTouched = Object.prototype.hasOwnProperty.call(detail, "avatar_key");
      const avatarUrlTouched = Object.prototype.hasOwnProperty.call(detail, "avatar_url");
      if ((avatarKeyTouched && detail.avatar_key == null) || (avatarUrlTouched && detail.avatar_url == null)) {
        setAvatarSrc("");
      }

      const bannerKeyTouched = Object.prototype.hasOwnProperty.call(detail, "banner_key");
      const bannerHashTouched = Object.prototype.hasOwnProperty.call(detail, "banner_hash");
      if ((bannerKeyTouched && detail.banner_key == null) || (bannerHashTouched && detail.banner_hash == null)) {
        setBannerSrc(getDefaultBannerUrl());
      }
    };

    window.addEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
    window.addEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    return () => {
      window.removeEventListener("messly:profile-updated", handleProfileUpdated as EventListener);
      window.removeEventListener("messly:profile-media-updated", handleProfileMediaUpdated as EventListener);
    };
  }, [accountModalKind, currentUserId, dbUserId, profileThemeAccentColor, profileThemePrimaryColor, user?.uid, username]);

  useEffect(() => {
    if (activeSection !== "devices") {
      return;
    }

    const firebaseUid = String(user?.uid ?? "").trim();
    if (!firebaseUid) {
      setDeviceSessions([]);
      setDeviceSessionsError("Sessão atual indisponível.");
      setIsDeviceSessionsLoading(false);
      return;
    }

    const currentLoginSessionId = getCurrentLoginSessionId();
    const currentFallbackSession: DeviceSessionItem | null = currentPresenceDeviceId
      ? {
          id: currentLoginSessionId ?? currentPresenceDeviceId,
          sessionId: currentLoginSessionId,
          deviceId: currentPresenceDeviceId,
          platform: currentPresenceDeviceMetadata.platform,
          state: "online",
          clientName: currentPresenceDeviceMetadata.clientName,
          osName: currentPresenceDeviceMetadata.osName,
          locationLabel: currentPresenceDeviceMetadata.locationLabel,
          lastActive: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          appVersion: String(appPackage.version ?? "").trim() || null,
          ipAddressMasked: null,
          isCurrent: true,
          source: "presence",
        }
      : null;

    setDeviceSessions(currentFallbackSession ? [currentFallbackSession] : []);
    setDeviceSessionsError(null);
    setIsDeviceSessionsLoading(true);
    let isCancelled = false;
    let didReceivePresenceSnapshot = false;
    let didApplyServerSessions = false;
    let shouldUsePresenceFallback = false;
    let lastPresenceItems: DeviceSessionItem[] | null = null;
    let didReceivePresenceError = false;
    const isSuppressedDevice = (deviceIdRaw: string): boolean => {
      const deviceId = String(deviceIdRaw ?? "").trim();
      if (!deviceId) {
        return false;
      }

      const now = Date.now();
      const suppressionMap = recentlyEndedDeviceSessionsRef.current;
      for (const [id, expiresAt] of suppressionMap.entries()) {
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          suppressionMap.delete(id);
        }
      }

      const expiresAt = suppressionMap.get(deviceId);
      return Number.isFinite(expiresAt) && (expiresAt as number) > now;
    };
    const isDismissedSession = (sessionIdRaw: string): boolean => {
      const sessionId = String(sessionIdRaw ?? "").trim();
      if (!sessionId) {
        return false;
      }

      const now = Date.now();
      const dismissedMap = dismissedLoginSessionsRef.current;
      let mutated = false;
      for (const [id, dismissedAt] of dismissedMap.entries()) {
        if (!Number.isFinite(dismissedAt) || dismissedAt + DISMISSED_LOGIN_SESSIONS_TTL_MS <= now) {
          dismissedMap.delete(id);
          mutated = true;
        }
      }
      if (mutated) {
        writeDismissedLoginSessions(dismissedLoginSessionsStorageScope, dismissedMap);
      }

      return dismissedMap.has(sessionId);
    };
    const applyPresenceFallback = (): void => {
      if (isCancelled || !shouldUsePresenceFallback || didApplyServerSessions) {
        return;
      }

      if (didReceivePresenceError) {
        setDeviceSessions(currentFallbackSession ? [currentFallbackSession] : []);
        setDeviceSessionsError("Não foi possível carregar os dispositivos desta conta.");
        setIsDeviceSessionsLoading(false);
        return;
      }

      if (lastPresenceItems !== null) {
        const hasDismissedSessions = dismissedLoginSessionsRef.current.size > 0;
        const basePresenceItems = lastPresenceItems as DeviceSessionItem[];
        const visiblePresenceItems = hasDismissedSessions
          ? basePresenceItems.filter((session) => session.isCurrent)
          : basePresenceItems;
        setDeviceSessions(visiblePresenceItems);
        setDeviceSessionsError(null);
        setIsDeviceSessionsLoading(false);
        return;
      }

      if (didReceivePresenceSnapshot) {
        setDeviceSessions(currentFallbackSession ? [currentFallbackSession] : []);
        setDeviceSessionsError(null);
        setIsDeviceSessionsLoading(false);
        return;
      }
    };
    const unsubscribePresence = () => {};

    const cachedLoginSessions = readCachedLoginSessions(loginSessionsCacheStorageScope).filter(
      (session) => !isSuppressedDevice(session.id) && !isDismissedSession(session.id),
    );
    if (cachedLoginSessions.length > 0) {
      const mappedCachedSessions = mapLoginSessionsToDeviceItems(
        cachedLoginSessions,
        currentLoginSessionId,
        currentPresenceDeviceMetadata,
      );
      setDeviceSessions(mappedCachedSessions);
      setIsDeviceSessionsLoading(false);
    }

    void (async () => {
      try {
        const loginSessions = await listActiveLoginSessions();
        if (isCancelled) {
          return;
        }

        const visibleLoginSessions = loginSessions.filter(
          (session) => !isSuppressedDevice(session.id) && !isDismissedSession(session.id),
        );

        if (visibleLoginSessions.length > 0) {
          didApplyServerSessions = true;
          writeCachedLoginSessions(loginSessionsCacheStorageScope, visibleLoginSessions);
          unsubscribePresence();
          setDeviceSessions(
            mapLoginSessionsToDeviceItems(
              visibleLoginSessions,
              currentLoginSessionId,
              currentPresenceDeviceMetadata,
            ),
          );
          setDeviceSessionsError(null);
          setIsDeviceSessionsLoading(false);
          return;
        }

        didApplyServerSessions = true;
        writeCachedLoginSessions(loginSessionsCacheStorageScope, []);
        unsubscribePresence();
        setDeviceSessions(currentFallbackSession ? [currentFallbackSession] : []);
        setDeviceSessionsError(null);
        setIsDeviceSessionsLoading(false);
        return;
      } catch (error) {
        console.warn("[devices:login-sessions]", error);
      }

      if (isCancelled || didApplyServerSessions) {
        return;
      }

      if (cachedLoginSessions.length > 0) {
        setIsDeviceSessionsLoading(false);
        return;
      }

      shouldUsePresenceFallback = true;
      applyPresenceFallback();
      if (!didReceivePresenceSnapshot) {
        setIsDeviceSessionsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
      unsubscribePresence();
    };
  }, [
    activeSection,
    currentPresenceDeviceId,
    currentPresenceDeviceMetadata,
    dismissedLoginSessionsStorageScope,
    loginSessionsCacheStorageScope,
    user?.uid,
  ]);

  useEffect(() => {
    if (activeSection !== "social") {
      return;
    }

    if (!dbUserId) {
      setBlockedAccounts([]);
      setBlockedAccountsError("Usuário ainda não sincronizado.");
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
            ? "Tabela user_blocks indisponível no banco."
            : "Não foi possível carregar contas bloqueadas.",
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
      const blockedCreatedAtById = new Map<string, string | null>();
      blocks.forEach((item) => {
        const blockedId = String(item.blocked_id ?? "").trim();
        if (blockedId && !blockedCreatedAtById.has(blockedId)) {
          blockedCreatedAtById.set(blockedId, item.created_at ?? null);
        }
      });

      if (blockedIds.length === 0) {
        setBlockedAccounts([]);
        setIsBlockedAccountsLoading(false);
        return;
      }

      const { data: usersData, error: usersError } = await supabase
        .from("profiles")
        .select(BLOCKED_USERS_SELECT_COLUMNS)
        .in("id", blockedIds);

      let resolvedUsersData = usersData as BlockedUserRow[] | null;
      let resolvedUsersError = usersError;

      if (resolvedUsersError) {
        const message = String(resolvedUsersError.message ?? "");
        if (isUsersSchemaColumnCacheError(message) || isMissingAvatarUrlColumnError(message)) {
          const fallbackUsersResult = await supabase
            .from("profiles")
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
        setBlockedAccountsError("Não foi possível carregar os perfis bloqueados.");
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
          if (isDefaultAvatarUrl(resolvedAvatar) && legacyAvatarUrl) {
            const resolvedLegacyAvatar = await getAvatarUrl(blockedId, legacyAvatarUrl, userRow?.avatar_hash ?? null);
            if (!isDefaultAvatarUrl(resolvedLegacyAvatar)) {
              resolvedAvatar = resolvedLegacyAvatar;
            }
          }

          const fallbackAvatar = getDefaultAvatarUrl(blockedId || resolvedUsername || resolvedDisplayName);

          return {
            userId: blockedId,
            username: resolvedUsername,
            displayName: resolvedDisplayName,
            avatarSrc: isDefaultAvatarUrl(resolvedAvatar) ? fallbackAvatar : resolvedAvatar,
            blockedAtLabel: formatBlockedDateLabel(blockedCreatedAtById.get(blockedId) ?? null),
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
      setWindowsBehaviorError("Disponível apenas no aplicativo desktop para Windows.");
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
        const launchAtStartup = Boolean(settings.launchAtStartup);
        windowsBehaviorLoadedRef.current = true;
        setWindowsBehaviorSettings({
          startMinimized: launchAtStartup && Boolean(settings.startMinimized),
          closeToTray: Boolean(settings.closeToTray),
          launchAtStartup,
        });
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        setWindowsBehaviorError("Não foi possível carregar as configurações do Windows.");
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

  const safeUsername = useMemo(() => username.trim() || sessionFallbackUsername || "usuario", [sessionFallbackUsername, username]);
  const safeDisplayName = useMemo(
    () => displayName.trim() || sessionFallbackDisplayName || safeUsername || "Usuário",
    [displayName, safeUsername, sessionFallbackDisplayName],
  );
  const usernameCooldownState = useMemo(
    () => getUsernameCooldownState(accountUsernameChangedAt),
    [accountUsernameChangedAt],
  );
  const usernameCooldownMessage = useMemo(() => {
    if (!usernameCooldownState.isLocked) {
      return null;
    }

    const nextAllowedLabel = usernameCooldownState.nextAllowedLabel;
    if (nextAllowedLabel) {
      return `Você poderá alterar o nome de usuário novamente em ${nextAllowedLabel}.`;
    }

    return `Você poderá alterar o nome de usuário novamente em ${usernameCooldownState.remainingDays} dias.`;
  }, [usernameCooldownState]);
  const safeAbout = useMemo(() => about.trim(), [about]);
  const hasUnsavedProfileChanges = useMemo(
    () =>
      displayName.trim() !== savedDisplayName.trim() ||
      about !== savedAbout ||
      normalizeBannerColor(bannerColor) !== normalizeBannerColor(savedBannerColor) ||
      normalizedProfileThemePrimaryColor !==
        (normalizeBannerColor(savedProfileThemePrimaryColor) ?? DEFAULT_PLUS_PROFILE_PRIMARY_COLOR) ||
      normalizedProfileThemeAccentColor !==
        (normalizeBannerColor(savedProfileThemeAccentColor) ?? DEFAULT_PLUS_PROFILE_ACCENT_COLOR),
    [
      about,
      bannerColor,
      displayName,
      normalizedProfileThemeAccentColor,
      normalizedProfileThemePrimaryColor,
      savedAbout,
      savedBannerColor,
      savedDisplayName,
      savedProfileThemeAccentColor,
      savedProfileThemePrimaryColor,
    ],
  );
  const previewThemePrimaryColor = draftProfileTheme.primary;
  const previewThemeAccentColor = draftProfileTheme.accent;
  const previewBannerColor = safeBannerColor;
  const aboutCount = about.length;
  const isEyeDropperSupported = typeof window !== "undefined" && "EyeDropper" in window;
  const normalizedBlockedSearchQuery = blockedSearchQuery.trim().toLocaleLowerCase();
  const filteredBlockedAccounts = useMemo(() => {
    if (!normalizedBlockedSearchQuery) {
      return blockedAccounts;
    }

    return blockedAccounts.filter((account) => {
      const displayNameMatch = account.displayName.trim().toLocaleLowerCase().includes(normalizedBlockedSearchQuery);
      const usernameMatch = account.username.trim().toLocaleLowerCase().includes(normalizedBlockedSearchQuery);
      return displayNameMatch || usernameMatch;
    });
  }, [blockedAccounts, normalizedBlockedSearchQuery]);
  const hasBlockedSearchQuery = normalizedBlockedSearchQuery.length > 0;
  const totalBlockedAccounts = blockedAccounts.length;
  const filteredBlockedAccountsCount = filteredBlockedAccounts.length;
  const blockedFooterCountLabel = hasBlockedSearchQuery
    ? `Mostrando ${filteredBlockedAccountsCount} de ${totalBlockedAccounts} usuários bloqueados`
    : `Mostrando ${filteredBlockedAccountsCount} ${
        filteredBlockedAccountsCount === 1 ? "usuário bloqueado" : "usuários bloqueados"
      }`;
  const reauthenticateCurrentEmailSession = useCallback(
    async (password: string) => {
      const currentEmail = normalizeEmail(user?.email ?? "");
      if (!currentEmail) {
        throw new Error("Sua conta atual não possui login por e-mail disponível.");
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: currentEmail,
        password,
      });
      if (error || !data.user) {
        throw error ?? new Error("Falha ao reautenticar.");
      }
      return data.user;
    },
    [user?.email],
  );
  const isRecentlyEndedDeviceSession = useCallback((deviceIdRaw: string): boolean => {
    const deviceId = String(deviceIdRaw ?? "").trim();
    if (!deviceId) {
      return false;
    }

    const now = Date.now();
    const suppressionMap = recentlyEndedDeviceSessionsRef.current;
    for (const [id, expiresAt] of suppressionMap.entries()) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        suppressionMap.delete(id);
      }
    }

    const expiresAt = suppressionMap.get(deviceId);
    return Number.isFinite(expiresAt) && (expiresAt as number) > now;
  }, []);
  const markDeviceSessionRecentlyEnded = useCallback((deviceIdRaw: string): void => {
    const deviceId = String(deviceIdRaw ?? "").trim();
    if (!deviceId) {
      return;
    }

    recentlyEndedDeviceSessionsRef.current.set(deviceId, Date.now() + ENDED_DEVICE_SESSION_SUPPRESS_TTL_MS);
  }, []);
  const rememberDismissedLoginSession = useCallback(
    (sessionIdRaw: string): void => {
      const sessionId = String(sessionIdRaw ?? "").trim();
      if (!sessionId) {
        return;
      }

      const dismissedMap = dismissedLoginSessionsRef.current;
      dismissedMap.set(sessionId, Date.now());
      writeDismissedLoginSessions(dismissedLoginSessionsStorageScope, dismissedMap);
    },
    [dismissedLoginSessionsStorageScope],
  );
  const refreshDeviceSessionsFromServer = useCallback(async (): Promise<void> => {
    const currentLoginSessionId = getCurrentLoginSessionId();
    const fetchedSessions = await listActiveLoginSessions();
    const visibleSessions = fetchedSessions.filter((session) => {
      const sessionId = String(session.id ?? "").trim();
      if (!sessionId) {
        return false;
      }
      if (isRecentlyEndedDeviceSession(sessionId)) {
        return false;
      }
      return !dismissedLoginSessionsRef.current.has(sessionId);
    });

    writeCachedLoginSessions(loginSessionsCacheStorageScope, visibleSessions);
    setDeviceSessions(
      mapLoginSessionsToDeviceItems(
        visibleSessions,
        currentLoginSessionId,
        currentPresenceDeviceMetadata,
      ),
    );
    setDeviceSessionsError(null);
  }, [currentPresenceDeviceMetadata, isRecentlyEndedDeviceSession, loginSessionsCacheStorageScope]);
  const currentDeviceSession = useMemo(
    () => deviceSessions.find((session) => session.isCurrent) ?? null,
    [deviceSessions],
  );
  const otherDeviceSessions = useMemo(
    () => deviceSessions.filter((session) => !session.isCurrent),
    [deviceSessions],
  );
  const hasOtherDeviceSessions = otherDeviceSessions.length > 0;
  const hasKnownDeviceSessions = deviceSessions.length > 0;
  const openEndDeviceSessionModal = useCallback(
    (session: DeviceSessionItem): void => {
      if (
        endingDeviceSessionId ||
        isEndingAllOtherDeviceSessions ||
        session.isCurrent ||
        !isUuidLike(String(session.sessionId ?? ""))
      ) {
        return;
      }

      setPendingDeviceSession(session);
      setPendingDeviceSessionPasswordInput("");
      setPendingDeviceSessionFeedback(null);
      setDeviceSessionsFeedback(null);
      setDeviceSessionsError(null);
    },
    [endingDeviceSessionId, isEndingAllOtherDeviceSessions],
  );
  const closeEndDeviceSessionModal = useCallback((): void => {
    if (endingDeviceSessionId || isEndingAllOtherDeviceSessions) {
      return;
    }

    setPendingDeviceSession(null);
    setPendingDeviceSessionPasswordInput("");
    setPendingDeviceSessionFeedback(null);
  }, [endingDeviceSessionId, isEndingAllOtherDeviceSessions]);
  const openEndAllOtherSessionsModal = useCallback((): void => {
    if (!hasKnownDeviceSessions || endingDeviceSessionId || isEndingAllOtherDeviceSessions) {
      return;
    }

    setIsEndAllOtherSessionsModalOpen(true);
    setEndAllOtherSessionsPasswordInput("");
    setEndAllOtherSessionsFeedback(null);
    setDeviceSessionsFeedback(null);
    setDeviceSessionsError(null);
  }, [endingDeviceSessionId, hasKnownDeviceSessions, isEndingAllOtherDeviceSessions]);
  const closeEndAllOtherSessionsModal = useCallback((): void => {
    if (isEndingAllOtherDeviceSessions || endingDeviceSessionId) {
      return;
    }

    setIsEndAllOtherSessionsModalOpen(false);
    setEndAllOtherSessionsPasswordInput("");
    setEndAllOtherSessionsFeedback(null);
  }, [endingDeviceSessionId, isEndingAllOtherDeviceSessions]);
  const handleEndDeviceSession = useCallback(
    async (session: DeviceSessionItem, password: string): Promise<boolean> => {
      const sessionId = String(session.sessionId ?? "").trim();
      if (endingDeviceSessionId || isEndingAllOtherDeviceSessions || session.isCurrent || !isUuidLike(sessionId)) {
        return false;
      }

      if (!String(password ?? "").trim()) {
        setPendingDeviceSessionFeedback({ tone: "error", message: "Digite sua senha atual para continuar." });
        return false;
      }

      setEndingDeviceSessionId(sessionId);
      setDeviceSessionsError(null);
      setDeviceSessionsFeedback(null);
      setPendingDeviceSessionFeedback(null);

      try {
        await reauthenticateCurrentEmailSession(password);

        if (session.source === "loginSession") {
          await endLoginSessionById(sessionId);
        } else {
          // Presence cleanup no longer uses Firebase; rely on session invalidation only.
        }
        if (session.source === "loginSession") {
          rememberDismissedLoginSession(sessionId);
          const cached = readCachedLoginSessions(loginSessionsCacheStorageScope);
          if (cached.length > 0) {
            const nextCached = cached.filter((entry) => entry.id !== sessionId);
            writeCachedLoginSessions(loginSessionsCacheStorageScope, nextCached);
          }
        } else {
          markDeviceSessionRecentlyEnded(sessionId);
        }
        setDeviceSessions((current) => current.filter((entry) => entry.id !== sessionId));
        setDeviceSessionsFeedback({ tone: "success", message: "Sessão encerrada com sucesso." });
        void refreshDeviceSessionsFromServer().catch(() => undefined);
        return true;
      } catch (error) {
        console.error("[devices:end-session]", error);
        setPendingDeviceSessionFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
        setDeviceSessionsError("Não foi possível encerrar este dispositivo agora.");
        return false;
      } finally {
        setEndingDeviceSessionId((current) => (current === sessionId ? null : current));
      }
    },
    [
      endingDeviceSessionId,
      isEndingAllOtherDeviceSessions,
      markDeviceSessionRecentlyEnded,
      loginSessionsCacheStorageScope,
      refreshDeviceSessionsFromServer,
      reauthenticateCurrentEmailSession,
      rememberDismissedLoginSession,
      user?.uid,
    ],
  );
  const handleConfirmEndDeviceSession = useCallback(async (): Promise<void> => {
    if (!pendingDeviceSession) {
      return;
    }

    const didEndSession = await handleEndDeviceSession(pendingDeviceSession, pendingDeviceSessionPasswordInput);
    if (!didEndSession) {
      return;
    }

    setPendingDeviceSession(null);
    setPendingDeviceSessionPasswordInput("");
    setPendingDeviceSessionFeedback(null);
  }, [handleEndDeviceSession, pendingDeviceSession, pendingDeviceSessionPasswordInput]);
  const handleConfirmEndAllOtherSessions = useCallback(async (): Promise<void> => {
    if (!hasKnownDeviceSessions) {
      setIsEndAllOtherSessionsModalOpen(false);
      return;
    }

    if (!String(endAllOtherSessionsPasswordInput ?? "").trim()) {
      setEndAllOtherSessionsFeedback({ tone: "error", message: "Digite sua senha atual para continuar." });
      return;
    }

    setIsEndingAllOtherDeviceSessions(true);
    setDeviceSessionsError(null);
    setDeviceSessionsFeedback(null);
    setEndAllOtherSessionsFeedback(null);

    try {
      await reauthenticateCurrentEmailSession(endAllOtherSessionsPasswordInput);
      await endAllOtherLoginSessions();

      const signOutWithScope = supabase.auth.signOut as unknown as (
        options: { scope: "global" | "local" | "others" },
      ) => Promise<{ error: unknown | null }>;
      const signOutResult = await signOutWithScope({ scope: "global" }).catch(() => ({ error: null }));
      if (signOutResult?.error && import.meta.env.DEV) {
        console.warn("[devices:end-all-sessions:signout-global]", signOutResult.error);
      }

      dismissedLoginSessionsRef.current.clear();
      writeDismissedLoginSessions(dismissedLoginSessionsStorageScope, dismissedLoginSessionsRef.current);
      writeCachedLoginSessions(loginSessionsCacheStorageScope, []);

      setDeviceSessions([]);
      setDeviceSessionsFeedback({ tone: "success", message: "Todas as sessões conhecidas foram encerradas." });
      setIsEndAllOtherSessionsModalOpen(false);
      setEndAllOtherSessionsPasswordInput("");
      setEndAllOtherSessionsFeedback(null);
      await signOutCurrent();
    } catch (error) {
      console.error("[devices:end-all-sessions]", error);
      setEndAllOtherSessionsFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
      setDeviceSessionsError("Não foi possível encerrar todas as sessões agora.");
    } finally {
      setIsEndingAllOtherDeviceSessions(false);
    }
  }, [
    dismissedLoginSessionsStorageScope,
    endAllOtherSessionsPasswordInput,
    hasKnownDeviceSessions,
    loginSessionsCacheStorageScope,
    reauthenticateCurrentEmailSession,
    signOutCurrent,
  ]);
  const spotifyOAuthEnabled = isSpotifyOAuthConfigured();
  const isSpotifyConnected = spotifyConnection.connected;
  const spotifyDisplayName = useMemo(
    () => (isSpotifyConnected ? spotifyConnection.accountName || safeDisplayName || safeUsername : "Spotify"),
    [isSpotifyConnected, safeDisplayName, safeUsername, spotifyConnection.accountName],
  );
  const persistSpotifyConnectionToProfile = useCallback(async (_nextConnection: SpotifyConnectionState): Promise<void> => {
    // Perfil não armazena mais conexão Spotify; mantemos apenas local.
    return;
  }, []);

  const handleConnectSpotify = useCallback(async (): Promise<void> => {
    if (isSpotifyConnecting || !spotifyOAuthEnabled) {
      return;
    }

    setSpotifyConnectionError(null);
    setIsSpotifyConnecting(true);

    try {
      const next = await connectSpotifyOAuth(spotifyConnectionScope);
      setSpotifyConnection(next);
      try {
        await persistSpotifyConnectionToProfile(next);
      } catch {
        setSpotifyConnectionError("Conta conectada, mas não foi possível salvar a conexão no perfil.");
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      const normalizedMessage = rawMessage.toLowerCase();
      let message = rawMessage || "Não foi possível conectar a conta do Spotify.";

      if (
        normalizedMessage.includes("invalid client secret") ||
        normalizedMessage.includes("invalid_client") ||
        normalizedMessage.includes("spotify_client_secret") ||
        normalizedMessage.includes("configuracao do spotify invalida") ||
        normalizedMessage.includes("configuracao oauth do spotify invalida")
      ) {
        message = "Configuração do Spotify inválida no servidor. Verifique SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET na Edge Function.";
      } else if (
        normalizedMessage.includes("request timeout") ||
        normalizedMessage.includes("tempo limite") ||
        normalizedMessage.includes("timed out")
      ) {
        message = "Tempo limite ao conectar com o Spotify. Tente novamente.";
      }

      setSpotifyConnectionError(message);
    } finally {
      setIsSpotifyConnecting(false);
    }
  }, [isSpotifyConnecting, persistSpotifyConnectionToProfile, spotifyConnectionScope, spotifyOAuthEnabled]);

  const handleDisconnectSpotify = useCallback(async (): Promise<void> => {
    setSpotifyConnectionError(null);
    const fallback = createDefaultSpotifyConnection();
    setSpotifyConnection(fallback);
    try {
      const next = await disconnectSpotifyOAuth(spotifyConnectionScope);
      setSpotifyConnection(next);
      await persistSpotifyConnectionToProfile(next);
    } catch {
      setSpotifyConnectionError("A conexão foi removida só neste dispositivo. Tente novamente para atualizar o perfil.");
    }
  }, [persistSpotifyConnectionToProfile, spotifyConnectionScope]);

  const handleSpotifyVisibilityToggle = useCallback(
    async (key: "showOnProfile" | "showAsStatus"): Promise<void> => {
      if (!spotifyConnection.connected) {
        return;
      }
      const optimisticNext = {
        ...spotifyConnection,
        [key]: !spotifyConnection[key],
        updatedAt: new Date().toISOString(),
      };
      setSpotifyConnection(optimisticNext);
      try {
        const next = await setSpotifyConnectionVisibility(spotifyConnectionScope, {
          [key]: !spotifyConnection[key],
        });
        setSpotifyConnection(next);
        await persistSpotifyConnectionToProfile(next);
      } catch {
        setSpotifyConnectionError("A conexão foi atualizada só neste dispositivo. Tente novamente para salvar no perfil.");
      }
    },
    [persistSpotifyConnectionToProfile, spotifyConnection, spotifyConnectionScope],
  );

  const handleResetProfileDraft = (): void => {
    setDisplayName(savedDisplayName);
    setAbout(savedAbout);
    setBannerColor(savedBannerColor);
    setBannerColorInput(getBannerColorInputValue(savedBannerColor));
    setProfileThemePrimaryColor(savedProfileTheme.primary);
    setProfileThemeAccentColor(savedProfileTheme.accent);
    setProfileFeedback(null);
  };

  const handleProfileThemeColorChange = (slot: "primary" | "accent", rawValue: string): void => {
    const normalized = normalizeBannerColor(rawValue);
    if (!normalized) {
      return;
    }

    if (slot === "primary") {
      setProfileThemePrimaryColor(normalized);
      setBannerColor(normalized);
      setBannerColorInput(getBannerColorInputValue(normalized));
    } else {
      setProfileThemeAccentColor(normalized);
    }
    setProfileFeedback(null);
  };

  const applyProfileThemeColorPickerValue = (rawValue: string): void => {
    const normalized = normalizeBannerColor(rawValue);
    if (!normalized) {
      return;
    }

    handleProfileThemeColorChange(profileThemeColorPickerSlot, normalized);
    setProfileThemeColorInput(normalized.toUpperCase());
  };

  const handleOpenProfileThemeColorPicker = (slot: ProfileThemeColorSlot): void => {
    const normalizedColor = slot === "primary" ? draftProfileTheme.primary : draftProfileTheme.accent;
    const nextHsv = hexToHsv(normalizedColor);
    setIsBannerColorPickerOpen(false);
    setProfileThemeColorPickerSlot(slot);
    setProfileThemeColorInput(normalizedColor.toUpperCase());
    setProfileThemeColorHue(nextHsv.h);
    setProfileThemeColorSaturation(nextHsv.s);
    setProfileThemeColorValue(nextHsv.v);
    setIsProfileThemeColorPickerOpen(true);
  };

  const handleProfileThemeColorInputChange = (rawValue: string): void => {
    const sanitized = rawValue
      .trim()
      .replace(/[^#0-9a-fA-F]/g, "")
      .slice(0, 7)
      .toUpperCase();
    setProfileThemeColorInput(sanitized);

    const normalized = normalizeBannerColor(sanitized);
    if (normalized) {
      applyProfileThemeColorPickerValue(normalized);
    }
  };

  const handleProfileThemeColorInputBlur = (): void => {
    const normalized = normalizeBannerColor(profileThemeColorInput);
    if (normalized) {
      applyProfileThemeColorPickerValue(normalized);
      return;
    }

    setProfileThemeColorInput(activeProfileThemePickerColor.toUpperCase());
  };

  const updateProfileThemeColorFromArea = (clientX: number, clientY: number): void => {
    const pickerArea = profileThemeColorAreaRef.current;
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
    const rgb = hsvToRgb(profileThemeColorHue, nextSaturation, nextValue);
    const nextColor = rgbToHex(rgb.r, rgb.g, rgb.b);

    applyProfileThemeColorPickerValue(nextColor);
  };

  const handleProfileThemeColorAreaPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateProfileThemeColorFromArea(event.clientX, event.clientY);
  };

  const handleProfileThemeColorAreaPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateProfileThemeColorFromArea(event.clientX, event.clientY);
  };

  const handleProfileThemeColorAreaPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleProfileThemeColorHueChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const parsedHue = Number.parseFloat(event.target.value);
    const nextHue = Number.isFinite(parsedHue) ? clamp(parsedHue, 0, 360) : 0;
    const rgb = hsvToRgb(nextHue, profileThemeColorSaturation, profileThemeColorValue);
    const nextColor = rgbToHex(rgb.r, rgb.g, rgb.b);
    applyProfileThemeColorPickerValue(nextColor);
  };

  const handleProfileThemeColorEyedropperClick = async (): Promise<void> => {
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
        applyProfileThemeColorPickerValue(result.sRGBHex);
      }
    } catch {
      // Ignore cancellations from the color picker API.
    }
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
    if (key === "startMinimized" && !windowsBehaviorSettings.launchAtStartup) {
      return;
    }

    const previous = windowsBehaviorSettings;
    const nextPartial: Partial<WindowsBehaviorSettings> = {
      [key]: nextValue,
    };
    if (key === "launchAtStartup" && !nextValue) {
      nextPartial.startMinimized = false;
    }

    const optimistic = {
      ...previous,
      ...nextPartial,
    };
    setWindowsBehaviorSettings(optimistic);
    setSavingWindowsBehaviorKey(key);
    setWindowsBehaviorError(null);

    try {
      const updated = await window.electronAPI.updateWindowsSettings(nextPartial);
      const launchAtStartup = Boolean(updated.launchAtStartup);
      setWindowsBehaviorSettings({
        startMinimized: launchAtStartup && Boolean(updated.startMinimized),
        closeToTray: Boolean(updated.closeToTray),
        launchAtStartup,
      });
      windowsBehaviorLoadedRef.current = true;
    } catch {
      setWindowsBehaviorSettings(previous);
      setWindowsBehaviorError("Não foi possível salvar a configuração do Windows.");
    } finally {
      setSavingWindowsBehaviorKey((current) => (current === key ? null : current));
    }
  };

  const handleFriendRequestPrivacyToggle = async (
    key: keyof FriendRequestPrivacySettings,
    nextValue: boolean,
  ): Promise<void> => {
    const writableUserId = String(dbUserId ?? "").trim();
    if (!writableUserId || savingFriendRequestPrivacyKey) {
      return;
    }

    const previousSettings = friendRequestPrivacy;
    const nextSettings: FriendRequestPrivacySettings = {
      ...previousSettings,
      [key]: nextValue,
    };
    const dbColumn =
      key === "allowAll" ? "friend_requests_allow_all" : "friend_requests_allow_friends_of_friends";

    setFriendRequestPrivacy(nextSettings);
    setFriendRequestPrivacyError(null);
    setSavingFriendRequestPrivacyKey(key);

    try {
      await updateUserProfileWithSchemaFallback(writableUserId, {
        [dbColumn]: nextValue,
      });
    } catch {
      setFriendRequestPrivacy(previousSettings);
      setFriendRequestPrivacyError("Não foi possível salvar essa permissão agora.");
    } finally {
      setSavingFriendRequestPrivacyKey((current) => (current === key ? null : current));
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
          ? "Tabela user_blocks indisponível no banco."
          : "Não foi possível desbloquear o usuário.",
      );
      setUnblockingUserId(null);
      return;
    }

    setBlockedAccounts((current) => current.filter((item) => item.userId !== blockedUserId));
    setUnblockingUserId(null);
  };

  const handleSaveProfileDraft = async (): Promise<void> => {
    let writableUserId = dbUserId;
    if (!writableUserId) {
      writableUserId = await refreshDbUserIdFromSession();
    }

    if (!writableUserId) {
      setProfileFeedback({
        tone: "error",
        message: "Usuário ainda não sincronizado. Reabra as configurações e tente novamente.",
      });
      return;
    }

    const nextDisplayName = displayName.trim() || safeUsername || "Nome";
    const nextAbout = about.slice(0, ABOUT_MAX_LENGTH);
    const nextBannerColor = normalizeBannerColor(bannerColor) ?? null;
    const nextProfileThemePrimaryColor = draftProfileTheme.primary;
    const nextProfileThemeAccentColor = draftProfileTheme.accent;

    setIsSavingProfile(true);
    setProfileFeedback(null);
    try {
      const savePayload: UserProfileUpdatePayload = {
        display_name: nextDisplayName,
        about: nextAbout || null,
        banner_color: nextBannerColor,
        profile_theme_primary_color: nextProfileThemePrimaryColor,
        profile_theme_accent_color: nextProfileThemeAccentColor,
      };
      let persistedUpdates: UserProfileUpdatePayload;
      try {
        persistedUpdates = await updateUserProfileWithSchemaFallback(writableUserId, savePayload);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== USERS_UPDATE_ROW_NOT_FOUND_ERROR) {
          throw error;
        }

        const refreshedUserId = await refreshDbUserIdFromSession();
        if (!refreshedUserId || refreshedUserId === writableUserId) {
          throw error;
        }
        writableUserId = refreshedUserId;
        persistedUpdates = await updateUserProfileWithSchemaFallback(writableUserId, savePayload);
      }
      const didPersistBannerColor = Object.prototype.hasOwnProperty.call(persistedUpdates, "banner_color");
      const didPersistProfileThemePrimaryColor = Object.prototype.hasOwnProperty.call(
        persistedUpdates,
        "profile_theme_primary_color",
      );
      const didPersistProfileThemeAccentColor = Object.prototype.hasOwnProperty.call(
        persistedUpdates,
        "profile_theme_accent_color",
      );
      const effectiveBannerColor = didPersistBannerColor ? nextBannerColor : savedBannerColor;

      setDisplayName(nextDisplayName);
      setSavedDisplayName(nextDisplayName);
      setAbout(nextAbout);
      setSavedAbout(nextAbout);
      setBannerColor(effectiveBannerColor);
      setSavedBannerColor(effectiveBannerColor);
      setBannerColorInput(getBannerColorInputValue(effectiveBannerColor));
      setProfileThemePrimaryColor(nextProfileThemePrimaryColor);
      setSavedProfileThemePrimaryColor(nextProfileThemePrimaryColor);
      setProfileThemeAccentColor(nextProfileThemeAccentColor);
      setSavedProfileThemeAccentColor(nextProfileThemeAccentColor);
      writeProfilePlusThemeSettings(user?.uid ?? null, {
        primary: nextProfileThemePrimaryColor,
        accent: nextProfileThemeAccentColor,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(PROFILE_PLUS_THEME_UPDATED_EVENT, {
            detail: {
              userUid: user?.uid ?? null,
              primary: nextProfileThemePrimaryColor,
              accent: nextProfileThemeAccentColor,
            },
          }),
        );
      }
      const profileUpdateDetail: ProfileUpdatedDetail = {
        userId: writableUserId,
        display_name: nextDisplayName,
        username: safeUsername,
        about: nextAbout || null,
      };
      if (didPersistBannerColor) {
        profileUpdateDetail.banner_color = nextBannerColor;
      }
      if (didPersistProfileThemePrimaryColor) {
        profileUpdateDetail.profile_theme_primary_color = nextProfileThemePrimaryColor;
      }
      if (didPersistProfileThemeAccentColor) {
        profileUpdateDetail.profile_theme_accent_color = nextProfileThemeAccentColor;
      }
      publishProfileUpdated(profileUpdateDetail);

      if (!didPersistBannerColor) {
        setProfileFeedback({
          tone: "error",
          message: "A coluna banner_color não existe no banco. Execute a migração para sincronizar a cor da faixa para todos.",
        });
      } else if (!didPersistProfileThemePrimaryColor || !didPersistProfileThemeAccentColor) {
        setProfileFeedback({
          tone: "error",
          message: "As colunas de tema de perfil Plus ainda não existem no banco. O visual foi salvo localmente.",
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
    let preloadImage: HTMLImageElement | null = null;

    const avatarSource = avatarKey ?? avatarUrl;
    const hasAvatarSource = Boolean(String(avatarSource ?? "").trim());

    void getAvatarUrl(dbUserId, avatarSource, avatarHash).then((url) => {
      if (!isMounted) {
        return;
      }

      if (isMounted) {
        const resolvedUrl = String(url ?? "").trim() || getDefaultAvatarUrl(dbUserId || user?.uid || safeUsername);
        if (isDefaultAvatarUrl(resolvedUrl)) {
          setAvatarSrc((current) => {
            if (current === resolvedUrl || (isDefaultAvatarUrl(resolvedUrl) && current === "")) {
              return current;
            }
            if (hasAvatarSource && current && !isDefaultAvatarUrl(current)) {
              return current;
            }
            return "";
          });
          return;
        }

        preloadImage = new Image();
        preloadImage.decoding = "async";
        preloadImage.onload = () => {
          if (!isMounted) {
            return;
          }
          if (temporaryAvatarUrlRef.current && resolvedUrl !== temporaryAvatarUrlRef.current) {
            URL.revokeObjectURL(temporaryAvatarUrlRef.current);
            temporaryAvatarUrlRef.current = null;
          }
          setAvatarSrc((current) => (current === resolvedUrl ? current : resolvedUrl));
        };
        preloadImage.onerror = () => {
          if (!isMounted || !hasAvatarSource) {
            return;
          }
          setAvatarSrc((current) => (current && !isDefaultAvatarUrl(current) ? current : ""));
        };
        preloadImage.src = resolvedUrl;
        if (typeof preloadImage.decode === "function") {
          void preloadImage.decode().catch(() => undefined);
        }
      }
    });

    return () => {
      isMounted = false;
      if (preloadImage) {
        preloadImage.onload = null;
        preloadImage.onerror = null;
        preloadImage = null;
      }
    };
  }, [avatarHash, avatarKey, avatarUrl, dbUserId, safeUsername, user?.uid]);

  useEffect(() => {
    let isMounted = true;
    let preloadImage: HTMLImageElement | null = null;

    void getBannerUrl(dbUserId, bannerKey, bannerHash).then((url) => {
      if (!isMounted) {
        return;
      }

      const resolvedUrl = String(url ?? "").trim() || getDefaultBannerUrl();
      if (bannerKey && resolvedUrl === getDefaultBannerUrl()) {
        return;
      }

      if (resolvedUrl === getDefaultBannerUrl()) {
        setBannerSrc((current) => {
          const currentTrimmed = String(current ?? "").trim();
          if (currentTrimmed === resolvedUrl) {
            return current;
          }

          const currentHasReusableUrl = isReusableSidebarMediaUrl(currentTrimmed) && currentTrimmed !== getDefaultBannerUrl();
          return currentHasReusableUrl ? current : resolvedUrl;
        });
        return;
      }

      preloadImage = new Image();
      preloadImage.decoding = "async";
      preloadImage.onload = () => {
        if (!isMounted) {
          return;
        }
        if (temporaryBannerUrlRef.current && resolvedUrl !== temporaryBannerUrlRef.current) {
          URL.revokeObjectURL(temporaryBannerUrlRef.current);
          temporaryBannerUrlRef.current = null;
        }
        setBannerSrc((current) => (current === resolvedUrl ? current : resolvedUrl));
      };
      preloadImage.onerror = () => {
        if (!isMounted) {
          return;
        }
        if (!bannerKey) {
          setBannerSrc((current) => (current === getDefaultBannerUrl() ? current : getDefaultBannerUrl()));
        }
      };
      preloadImage.src = resolvedUrl;
    });

    return () => {
      isMounted = false;
      if (preloadImage) {
        preloadImage.onload = null;
        preloadImage.onerror = null;
        preloadImage = null;
      }
    };
  }, [bannerHash, bannerKey, dbUserId]);

  const canUploadMedia = Boolean(dbUserId);
  const refreshDbUserIdFromSession = useCallback(async (): Promise<string | null> => {
    if (!user?.uid) {
      return null;
    }

    const byUidResult = await queryUserByFirebaseUid(user.uid);
    if (byUidResult.error) {
      return null;
    }
    const resolvedId = String((byUidResult.data as UserProfileRow | null)?.id ?? "").trim();
    if (!resolvedId) {
      return null;
    }
    setDbUserId(resolvedId);
    return resolvedId;
  }, [user?.uid]);

  const publishProfileMediaChange = (detail: {
    userId: string;
    avatar_key?: string | null;
    avatar_hash?: string | null;
    avatar_url?: string | null;
    banner_color?: string | null;
    banner_key?: string | null;
    banner_hash?: string | null;
  }): void => {
    window.dispatchEvent(new CustomEvent("messly:profile-media-updated", { detail }));
  };

  const publishProfileUpdated = (detail: ProfileUpdatedDetail): void => {
    window.dispatchEvent(new CustomEvent<ProfileUpdatedDetail>("messly:profile-updated", { detail }));
  };

  const uploadProfileMedia = async (kind: ProfileMediaKind, file: File): Promise<boolean> => {
    let writableUserId = dbUserId;
    if (!writableUserId) {
      writableUserId = await refreshDbUserIdFromSession();
    }

    if (!writableUserId) {
      const noSessionFeedback: UploadFeedbackState = {
        tone: "error",
        message: "Usuário ainda não sincronizado. Reabra as configurações e tente novamente.",
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

    const previousVisualSrc = kind === "avatar" ? avatarSrc : bannerSrc;
    const optimisticPreviewUrl = URL.createObjectURL(file);
    setTemporaryPreviewUrl(kind, optimisticPreviewUrl);

    try {
      const previousKey = kind === "avatar" ? avatarKey : bannerKey;
      const uploaded = await uploadProfileMediaAsset(kind, writableUserId, file);
      const canonicalVersionedUrl = String(uploaded.versionedUrl ?? "").trim() || null;
      const fallbackUpdates: ProfileMediaUpdatePayload =
        kind === "avatar"
          ? {
              avatar_key: uploaded.key,
              avatar_hash: uploaded.hash,
              avatar_url: canonicalVersionedUrl,
            }
          : {
              banner_key: uploaded.key,
              banner_hash: uploaded.hash,
              banner_url: canonicalVersionedUrl,
            };
      const persistedUpdates = toPersistedProfileMediaUpdates(kind, uploaded.persistedProfile);

      let appliedUpdates: ProfileMediaUpdatePayload;
      if (Object.keys(persistedUpdates).length > 0) {
        appliedUpdates = persistedUpdates;
      } else {
        try {
          appliedUpdates = await updateUserMediaWithSchemaFallback(writableUserId, fallbackUpdates);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== USERS_UPDATE_ROW_NOT_FOUND_ERROR) {
            throw error;
          }

          const refreshedUserId = await refreshDbUserIdFromSession();
          if (!refreshedUserId || refreshedUserId === writableUserId) {
            throw error;
          }
          writableUserId = refreshedUserId;
          appliedUpdates = await updateUserMediaWithSchemaFallback(writableUserId, fallbackUpdates);
        }
      }

      if (kind === "avatar" && !Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")) {
        throw new Error("A coluna avatar_key não existe na tabela profiles.");
      }

      if (kind === "banner" && !Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")) {
        throw new Error("A coluna banner_key não existe na tabela users.");
      }

      if (kind === "avatar") {
        setAvatarKey(
          Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")
            ? String(appliedUpdates.avatar_key ?? "").trim() || null
            : null,
        );
        setAvatarHash(
          Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_hash")
            ? String(appliedUpdates.avatar_hash ?? "").trim() || null
            : null,
        );
        if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_url")) {
          setAvatarUrl(String(appliedUpdates.avatar_url ?? "").trim() || null);
        }
        setAvatarFeedback(null);
      } else {
        setBannerKey(
          Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")
            ? String(appliedUpdates.banner_key ?? "").trim() || null
            : null,
        );
        setBannerHash(
          Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_hash")
            ? String(appliedUpdates.banner_hash ?? "").trim() || null
            : null,
        );
        setBannerFeedback(null);
      }

      const detail: {
        userId: string;
        avatar_key?: string | null;
        avatar_hash?: string | null;
        avatar_url?: string | null;
        banner_color?: string | null;
        banner_key?: string | null;
        banner_hash?: string | null;
      } = {
        userId: writableUserId,
      };

      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_key")) {
        detail.avatar_key = String(appliedUpdates.avatar_key ?? "").trim() || null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_hash")) {
        detail.avatar_hash = String(appliedUpdates.avatar_hash ?? "").trim() || null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "avatar_url")) {
        detail.avatar_url = String(appliedUpdates.avatar_url ?? "").trim() || null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_key")) {
        detail.banner_key = String(appliedUpdates.banner_key ?? "").trim() || null;
      }
      if (Object.prototype.hasOwnProperty.call(appliedUpdates, "banner_hash")) {
        detail.banner_hash = String(appliedUpdates.banner_hash ?? "").trim() || null;
      }
      if (kind === "banner") {
        detail.banner_color = normalizeBannerColor(savedBannerColor) ?? null;
      }

      publishProfileMediaChange(detail);

      if (previousKey && previousKey !== uploaded.key) {
        void deleteMedia({ fileKey: previousKey }).catch(() => undefined);
      }
      return true;
    } catch (error) {
      clearTemporaryPreviewUrl(kind);
      if (kind === "avatar") {
        setAvatarSrc(previousVisualSrc);
      } else {
        setBannerSrc(previousVisualSrc);
      }

      const feedback: UploadFeedbackState = {
        tone: "error",
        message: getProfileMediaErrorMessage(kind, error),
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
    let writableUserId = dbUserId;
    if (!writableUserId) {
      writableUserId = await refreshDbUserIdFromSession();
    }

    if (!writableUserId) {
      const noSessionFeedback: UploadFeedbackState = {
        tone: "error",
        message: "Usuário ainda não sincronizado. Reabra as configurações e tente novamente.",
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
      const previousKey = kind === "avatar" ? avatarKey : bannerKey;
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

      let appliedUpdates: ProfileMediaUpdatePayload;
      try {
        appliedUpdates = await updateUserMediaWithSchemaFallback(writableUserId, updates);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== USERS_UPDATE_ROW_NOT_FOUND_ERROR) {
          throw error;
        }

        const refreshedUserId = await refreshDbUserIdFromSession();
        if (!refreshedUserId || refreshedUserId === writableUserId) {
          throw error;
        }
        writableUserId = refreshedUserId;
        appliedUpdates = await updateUserMediaWithSchemaFallback(writableUserId, updates);
      }

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
        banner_color?: string | null;
        banner_key?: string | null;
        banner_hash?: string | null;
      } = { userId: writableUserId };

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
      if (kind === "banner") {
        detail.banner_color = normalizeBannerColor(savedBannerColor) ?? null;
      }

      publishProfileMediaChange(detail);

      if (previousKey) {
        void deleteMedia({ fileKey: previousKey }).catch(() => undefined);
      }
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

    setPendingImageEdit({ kind, file });
  };

  const handleOpenProfileMediaDialog = (kind: ProfileMediaKind): void => {
    if (!canUploadMedia) {
      const feedback: UploadFeedbackState = {
        tone: "error",
        message: "Usuário ainda não sincronizado. Reabra as configurações e tente novamente.",
      };
      if (kind === "avatar") {
        setAvatarFeedback(feedback);
      } else {
        setBannerFeedback(feedback);
      }
      return;
    }

    if ((kind === "avatar" && isAvatarUploading) || (kind === "banner" && isBannerUploading)) {
      return;
    }

    const input = kind === "avatar" ? avatarFileInputRef.current : bannerFileInputRef.current;
    input?.click();
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

  const accountEmail = useMemo(() => normalizeEmail(user?.email ?? ""), [user?.email]);
  const accountEmailLabel = accountEmail || "Sem e-mail";
  const maskedAccountEmailLabel = useMemo(() => maskEmailAddress(accountEmailLabel) || accountEmailLabel, [accountEmailLabel]);
  const accountAvatarPreviewSrc =
    avatarSrc || getDefaultAvatarUrl(currentUserId || user?.uid || safeUsername || safeDisplayName);

  useEffect(() => {
    if (!user) {
      accountProfileSyncSignatureRef.current = "";
      return;
    }
    const nextSignature = `${user.uid}:${safeDisplayName}:${accountAvatarPreviewSrc}`;
    if (accountProfileSyncSignatureRef.current === nextSignature) {
      return;
    }
    accountProfileSyncSignatureRef.current = nextSignature;
    updateCurrentAccountProfile({
      alias: safeDisplayName,
      avatarSrc: accountAvatarPreviewSrc,
    });
  }, [accountAvatarPreviewSrc, safeDisplayName, updateCurrentAccountProfile, user]);

  const resetAccountModalState = useCallback(() => {
    setAccountActionFeedback(null);
    setIsAccountActionPending(false);
    setAccountUsernameInput(safeUsername);
    setAccountUsernamePasswordInput("");
    setAccountUsernameModalFeedback(null);
    setAccountUsernameAvailabilityFeedback(null);
    setIsAccountUsernameAvailabilityPending(false);
    setAccountEmailModalStep("verifyCurrent");
    setAccountCurrentEmailInput(accountEmail);
    setAccountCurrentPasswordInput("");
    setAccountNewEmailInput("");
    setAccountEmailModalFeedback(null);
    setAccountPasswordCurrentInput("");
    setAccountPasswordNewInput("");
    setAccountPasswordConfirmInput("");
    setAccountPasswordModalFeedback(null);
    setAccountDeactivatePasswordInput("");
    setAccountDeactivateConfirmInput("");
    setAccountDeactivateModalFeedback(null);
    setAccountDeletePasswordInput("");
    setAccountDeleteConfirmInput("");
    setAccountDeleteModalFeedback(null);
  }, [accountEmail, safeUsername]);

  const openAccountModal = useCallback(
    (kind: AccountModalKind) => {
      resetAccountModalState();
      setAccountModalKind(kind);
    },
    [resetAccountModalState],
  );

  const closeAccountModal = useCallback(() => {
    setAccountModalKind(null);
    resetAccountModalState();
  }, [resetAccountModalState]);

  useEffect(() => {
    if (accountModalKind !== "username") {
      setAccountUsernameAvailabilityFeedback(null);
      setIsAccountUsernameAvailabilityPending(false);
      return;
    }

    const normalizedUsername = String(accountUsernameInput ?? "").trim().toLowerCase();
    if (!normalizedUsername) {
      setAccountUsernameAvailabilityFeedback(null);
      setIsAccountUsernameAvailabilityPending(false);
      return;
    }

    if (normalizedUsername === safeUsername) {
      setAccountUsernameAvailabilityFeedback(null);
      setIsAccountUsernameAvailabilityPending(false);
      return;
    }

    const validation = validateUsernameInput(normalizedUsername);
    if (!validation.isValid) {
      setAccountUsernameAvailabilityFeedback({
        tone: "error",
        message: validation.message ?? "Nome de usuário inválido.",
      });
      setIsAccountUsernameAvailabilityPending(false);
      return;
    }

    let isCancelled = false;
    const timeout = window.setTimeout(() => {
      setIsAccountUsernameAvailabilityPending(true);
      setAccountUsernameAvailabilityFeedback({
        tone: "info",
        message: "Verificando disponibilidade...",
      });

      void isUsernameAvailable(normalizedUsername)
        .then((isAvailable) => {
          if (isCancelled) {
            return;
          }

          setAccountUsernameAvailabilityFeedback({
            tone: isAvailable ? "success" : "error",
            message: isAvailable ? "Nome de usuário disponível." : "Esse nome de usuário já está em uso.",
          });
        })
        .finally(() => {
          if (!isCancelled) {
            setIsAccountUsernameAvailabilityPending(false);
          }
        });
    }, 250);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeout);
    };
  }, [accountModalKind, accountUsernameInput, safeUsername]);

  const handleSidebarSignOut = useCallback(async () => {
    if (isSidebarSignOutPending) {
      return;
    }

    setSidebarSignOutFeedback(null);
    setIsSidebarSignOutPending(true);

    try {
      await signOutCurrent();
    } catch (error) {
      console.error("[settings:sidebar-signout]", error);
      setSidebarSignOutFeedback("Não foi possível encerrar a sessão agora.");
    } finally {
      setIsSidebarSignOutPending(false);
    }
  }, [isSidebarSignOutPending, signOutCurrent]);

  const handleAccountUsernameUpdate = useCallback(async () => {
    let writableUserId = dbUserId;
    if (!writableUserId) {
      writableUserId = await refreshDbUserIdFromSession();
    }

    if (!writableUserId) {
      setAccountUsernameModalFeedback({
        tone: "error",
        message: "Usuário ainda não sincronizado. Reabra as configurações e tente novamente.",
      });
      return;
    }

    if (usernameCooldownState.isLocked) {
      setAccountUsernameModalFeedback({
        tone: "error",
        message: usernameCooldownMessage ?? "Você ainda não pode alterar o nome de usuário.",
      });
      return;
    }

    const nextUsername = String(accountUsernameInput ?? "").trim().toLowerCase();
    if (!nextUsername) {
      setAccountUsernameModalFeedback({ tone: "error", message: "Digite o novo nome de usuário." });
      return;
    }

    if (nextUsername === safeUsername) {
      setAccountUsernameModalFeedback({ tone: "error", message: "Digite um nome de usuário diferente do atual." });
      return;
    }

    if (!accountUsernamePasswordInput.trim()) {
      setAccountUsernameModalFeedback({ tone: "error", message: "Digite sua senha atual para confirmar." });
      return;
    }

    const validation = validateUsernameInput(nextUsername);
    if (!validation.isValid) {
      setAccountUsernameModalFeedback({
        tone: "error",
        message: validation.message ?? "Nome de usuário inválido.",
      });
      return;
    }

    setIsAccountActionPending(true);
    setAccountUsernameModalFeedback(null);

    try {
      await reauthenticateCurrentEmailSession(accountUsernamePasswordInput);

      const isAvailable = await isUsernameAvailable(nextUsername);
      if (!isAvailable) {
        setAccountUsernameModalFeedback({ tone: "error", message: "Esse nome de usuário já está em uso." });
        return;
      }

      const changedAt = new Date().toISOString();
      const persistedUpdates = await updateUserProfileWithSchemaFallback(writableUserId, {
        username: nextUsername,
        username_changed_at: changedAt,
      });
      const didPersistUsernameChangedAt = Object.prototype.hasOwnProperty.call(persistedUpdates, "username_changed_at");
      const effectiveUsernameChangedAt = changedAt;
      const successMessage = didPersistUsernameChangedAt
        ? "Nome de usuário atualizado com sucesso."
        : "Nome de usuário atualizado com sucesso. O prazo de 30 dias foi salvo neste dispositivo.";
      const usernameChangeStorageScope = user?.uid ?? writableUserId;

      writeUsernameChangeFallback(usernameChangeStorageScope, effectiveUsernameChangedAt);
      setDbUserId(writableUserId);
      setUsername(nextUsername);
      setAccountUsernameInput(nextUsername);
      setAccountUsernamePasswordInput("");
      setAccountUsernameChangedAt(effectiveUsernameChangedAt);
      setAccountUsernameModalFeedback({
        tone: "success",
        message: successMessage,
      });
      setAccountActionFeedback({
        tone: "success",
        message: successMessage,
      });
      publishProfileUpdated({
        userId: writableUserId,
        display_name: safeDisplayName,
        username: nextUsername,
        username_changed_at: effectiveUsernameChangedAt,
        about: safeAbout || null,
      });

      window.setTimeout(() => {
        setAccountModalKind((current) => (current === "username" ? null : current));
      }, 450);
    } catch (error) {
      console.error("[account:change-username]", error);
      const errorMessage = String((error as { message?: string } | null)?.message ?? "").toLowerCase();
      setAccountUsernameModalFeedback({
        tone: "error",
        message:
          errorMessage.includes("duplicate key") || errorMessage.includes("users_username")
            ? "Esse nome de usuário já está em uso."
            : getAccountActionErrorMessage(error),
      });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [
    accountUsernamePasswordInput,
    accountUsernameInput,
    dbUserId,
    refreshDbUserIdFromSession,
    reauthenticateCurrentEmailSession,
    safeAbout,
    safeDisplayName,
    safeUsername,
    user?.uid,
    usernameCooldownMessage,
    usernameCooldownState.isLocked,
  ]);

  const handleAccountEmailVerifyCurrentStep = useCallback(async () => {
    const currentTypedEmail = normalizeEmail(accountCurrentEmailInput);
    const currentSessionEmail = normalizeEmail(user?.email ?? "");

    if (!currentSessionEmail) {
      setAccountEmailModalFeedback({ tone: "error", message: "Não foi possível identificar o e-mail atual da conta." });
      return;
    }

    if (currentTypedEmail !== currentSessionEmail) {
      setAccountEmailModalFeedback({ tone: "error", message: "Confirme o e-mail atual exatamente como ele está na conta." });
      return;
    }

    if (!accountCurrentPasswordInput.trim()) {
      setAccountEmailModalFeedback({ tone: "error", message: "Digite sua senha atual para continuar." });
      return;
    }

    setIsAccountActionPending(true);
    setAccountEmailModalFeedback(null);

    try {
      await reauthenticateCurrentEmailSession(accountCurrentPasswordInput);
      setAccountCurrentPasswordInput("");
      setAccountEmailModalStep("verifyNew");
      setAccountEmailModalFeedback({
        tone: "success",
        message: "E-mail atual confirmado. Agora informe o novo e-mail para enviar a verificação.",
      });
    } catch (error) {
      console.error("[account:change-email:verify-current]", error);
      setAccountEmailModalFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [accountCurrentEmailInput, accountCurrentPasswordInput, reauthenticateCurrentEmailSession, user?.email]);

  const handleAccountEmailSendVerification = useCallback(async () => {
    const currentSessionEmail = normalizeEmail(user?.email ?? "");
    const nextEmail = normalizeEmail(accountNewEmailInput);

    if (!currentSessionEmail) {
      setAccountEmailModalFeedback({ tone: "error", message: "Sessão inválida. Entre novamente para alterar o e-mail." });
      return;
    }

    if (!nextEmail) {
      setAccountEmailModalFeedback({ tone: "error", message: "Digite o novo e-mail." });
      return;
    }

    if (nextEmail === currentSessionEmail) {
      setAccountEmailModalFeedback({ tone: "error", message: "O novo e-mail precisa ser diferente do atual." });
      return;
    }

    setIsAccountActionPending(true);
    setAccountEmailModalFeedback(null);

    try {
      const { error } = await supabase.auth.updateUser({ email: nextEmail });
      if (error) {
        throw error;
      }
      setAccountEmailModalFeedback({
        tone: "success",
        message: `Enviamos um link de confirmação para ${nextEmail}. Confirme no novo e-mail para concluir a troca.`,
      });
      setAccountActionFeedback({
        tone: "success",
        message: "Solicitação enviada. Verifique o novo e-mail para concluir a alteração.",
      });
    } catch (error) {
      console.error("[account:change-email:verify-new]", error);
      setAccountEmailModalFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [accountNewEmailInput, user?.email]);

  const handleAccountPasswordUpdate = useCallback(async () => {
    if (!accountPasswordCurrentInput.trim()) {
      setAccountPasswordModalFeedback({ tone: "error", message: "Digite sua senha atual." });
      return;
    }

    if (!accountPasswordNewInput) {
      setAccountPasswordModalFeedback({ tone: "error", message: "Digite a nova senha." });
      return;
    }

    if (accountPasswordNewInput.length < 6) {
      setAccountPasswordModalFeedback({ tone: "error", message: "A nova senha deve ter pelo menos 6 caracteres." });
      return;
    }

    if (accountPasswordNewInput !== accountPasswordConfirmInput) {
      setAccountPasswordModalFeedback({ tone: "error", message: "A confirmação da nova senha não confere." });
      return;
    }

    setIsAccountActionPending(true);
    setAccountPasswordModalFeedback(null);

    try {
      const currentAuthUser = await reauthenticateCurrentEmailSession(accountPasswordCurrentInput);
      await updatePassword(currentAuthUser, accountPasswordNewInput);
      setAccountActionFeedback({ tone: "success", message: "Senha atualizada com sucesso." });
      setAccountPasswordModalFeedback({ tone: "success", message: "Senha atualizada com sucesso." });
      window.setTimeout(() => {
        setAccountModalKind((current) => (current === "password" ? null : current));
      }, 450);
    } catch (error) {
      console.error("[account:change-password]", error);
      setAccountPasswordModalFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [
    accountPasswordConfirmInput,
    accountPasswordCurrentInput,
    accountPasswordNewInput,
    reauthenticateCurrentEmailSession,
  ]);

  const handleAccountDeactivate = useCallback(async () => {
    if (!accountDeactivatePasswordInput.trim()) {
      setAccountDeactivateModalFeedback({ tone: "error", message: "Digite sua senha atual para confirmar." });
      return;
    }

    if (accountDeactivateConfirmInput.trim().toUpperCase() !== ACCOUNT_DEACTIVATE_CONFIRM_TEXT) {
      setAccountDeactivateModalFeedback({
        tone: "error",
        message: `Digite ${ACCOUNT_DEACTIVATE_CONFIRM_TEXT} para confirmar.`,
      });
      return;
    }

    setIsAccountActionPending(true);
    setAccountDeactivateModalFeedback(null);

    try {
      await reauthenticateCurrentEmailSession(accountDeactivatePasswordInput);

      if (dbUserId) {
        const { error } = await supabase.from("profiles").update({ status: "disabled" }).eq("id", dbUserId);
        if (error) {
          console.error("[account:deactivate:db]", error);
        }
      }

      setAccountActionFeedback({
        tone: "success",
        message: "Conta desativada nesta sessão. Você será desconectado agora.",
      });
      await signOutCurrent();
    } catch (error) {
      console.error("[account:deactivate]", error);
      setAccountDeactivateModalFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [accountDeactivateConfirmInput, accountDeactivatePasswordInput, dbUserId, reauthenticateCurrentEmailSession, signOutCurrent]);

  const handleAccountDelete = useCallback(async () => {
    if (!accountDeletePasswordInput.trim()) {
      setAccountDeleteModalFeedback({ tone: "error", message: "Digite sua senha atual para confirmar." });
      return;
    }

    if (accountDeleteConfirmInput.trim().toUpperCase() !== ACCOUNT_DELETE_CONFIRM_TEXT) {
      setAccountDeleteModalFeedback({
        tone: "error",
        message: `Digite ${ACCOUNT_DELETE_CONFIRM_TEXT} para confirmar.`,
      });
      return;
    }

    setIsAccountActionPending(true);
    setAccountDeleteModalFeedback(null);

    try {
      const currentAuthUser = await reauthenticateCurrentEmailSession(accountDeletePasswordInput);

      if (dbUserId) {
        const { error } = await supabase.from("profiles").update({ status: "disabled" }).eq("id", dbUserId);
        if (error) {
          console.error("[account:delete:disable]", error);
        }
      }

      try {
        await endCurrentLoginSession();
      } catch (sessionError) {
        console.warn("[security:end-login-session]", sessionError);
      }

      await deleteUser(currentAuthUser);
      setAccountActionFeedback({ tone: "success", message: "Conta excluída com sucesso." });
    } catch (error) {
      console.error("[account:delete]", error);
      setAccountDeleteModalFeedback({ tone: "error", message: getAccountActionErrorMessage(error) });
    } finally {
      setIsAccountActionPending(false);
    }
  }, [accountDeleteConfirmInput, accountDeletePasswordInput, dbUserId, reauthenticateCurrentEmailSession]);

  const isImageEditorApplying =
    pendingImageEdit?.kind === "avatar"
      ? isAvatarUploading
      : pendingImageEdit?.kind === "banner"
        ? isBannerUploading
        : false;
  const shouldSuppressPreviewBannerColor = isProfileIdentityLoading || hasBannerMedia;

  return (
    <>
      <section className={styles.settings} aria-label="Configurações">
        <button className={styles.shellCloseButton} type="button" onClick={onClose} aria-label="Fechar configurações">
          <MaterialSymbolIcon name="close" size={16} filled={false} />
        </button>

        <div className={styles.grid}>
          <aside className={styles.menu} aria-label="Categorias">
            <div className={styles.menuBrand}>
              <span className={styles.menuBrandIcon} aria-hidden="true">
                <MaterialSymbolIcon name="settings" size={18} filled={true} />
              </span>
              <div className={styles.menuBrandCopy}>
                <h2 className={styles.menuBrandTitle}>Configurações</h2>
                <p className={styles.menuBrandSection}>Geral</p>
              </div>
            </div>

            <div className={styles.menuList}>
              {visibleSettingsSidebarItems.map((item) => {
                const isActive = activeSection === item.key;
                return (
                  <button
                    key={item.key}
                    className={`${styles.menuItem}${isActive ? ` ${styles.menuItemActive}` : ""}`}
                    type="button"
                    onClick={() => setActiveSection(item.key)}
                  >
                    <MaterialSymbolIcon
                      className={styles.menuItemIcon}
                      name={item.icon}
                      size={17}
                      filled={isActive}
                    />
                    <span className={styles.menuItemLabel}>{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className={styles.menuVersionBlock} aria-label={`Versão do aplicativo ${settingsVersion}`}>
              <button
                className={`${styles.menuItem} ${styles.menuSignOutButton}`}
                type="button"
                onClick={() => {
                  void handleSidebarSignOut();
                }}
                disabled={isSidebarSignOutPending}
              >
                <MaterialSymbolIcon className={styles.menuItemIcon} name="logout" size={17} filled={false} />
                <span className={styles.menuItemLabel}>{isSidebarSignOutPending ? "Encerrando..." : "Encerrar sessão"}</span>
              </button>

              {sidebarSignOutFeedback ? (
                <p className={styles.menuSignOutFeedback} role="status" aria-live="polite">
                  {sidebarSignOutFeedback}
                </p>
              ) : null}

              <p className={styles.menuVersionPrimary}>{settingsSidebarVersionPrimary}</p>
              <p className={styles.menuVersionSecondary}>{settingsSidebarVersionSecondary}</p>
            </div>
          </aside>

          <div className={styles.panel}>
            {activeSection === "account" ? (
              <section className={styles.accountPanel} aria-label="Minha conta">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Minha conta</h3>
                </header>

                <div ref={accountContentRef} className={styles.accountContent}>
                  <section className={styles.accountMainCard} aria-label="Resumo da conta">
                    <section className={styles.accountHeroCard} aria-label="Perfil atual">
                      <div
                        className={styles.accountHeroBanner}
                        style={{ backgroundColor: safeBannerColor ?? DEFAULT_BANNER_COLOR }}
                      >
                        {hasBannerMedia ? (
                          <BannerImage className={styles.accountHeroBannerImage} src={bannerSrc} alt="" />
                        ) : null}
                        <div className={styles.accountHeroBannerShade} />
                      </div>

                      <div className={styles.accountHeroBody}>
                        <div className={styles.accountHeroBannerIdentity}>
                          <AvatarImage
                            className={styles.accountHeroAvatar}
                            src={accountAvatarPreviewSrc}
                            name={safeDisplayName}
                            alt={`Avatar de ${safeDisplayName}`}
                          />
                        </div>

                        <div className={styles.accountHeroMeta}>
                          <h4 className={styles.accountHeroName}>{safeDisplayName}</h4>
                        </div>

                        <div className={styles.accountHeroActions}>
                          <button
                            type="button"
                            className={`${styles.accountInlineAction} ${styles.accountInlineActionPrimary}`}
                            onClick={() => setActiveSection("profile")}
                          >
                            <MaterialSymbolIcon name="edit" size={16} filled={false} />
                            Editar perfil
                          </button>
                        </div>
                      </div>
                    </section>

                    <section className={styles.accountDetailsCard} aria-label="Dados principais da conta">
                      <article className={styles.accountDetailRow}>
                        <div className={styles.accountDetailMeta}>
                          <p className={styles.accountDetailLabel}>Nome exibido</p>
                          <p className={styles.accountDetailValue}>{safeDisplayName}</p>
                        </div>
                        <button
                          type="button"
                          className={styles.accountDetailButton}
                          onClick={() => setActiveSection("profile")}
                        >
                          Editar
                        </button>
                      </article>

                      <article className={styles.accountDetailRow}>
                        <div className={styles.accountDetailMeta}>
                          <p className={styles.accountDetailLabel}>Nome de usuário</p>
                          <p className={styles.accountDetailValue}>@{safeUsername}</p>
                        </div>
                        <button
                          type="button"
                          className={styles.accountDetailButton}
                          onClick={() => openAccountModal("username")}
                        >
                          Editar
                        </button>
                      </article>

                      <article className={styles.accountDetailRow}>
                        <div className={styles.accountDetailMeta}>
                          <p className={styles.accountDetailLabel}>E-mail</p>
                          <div className={styles.accountDetailValueWrap}>
                            <p className={styles.accountDetailValue}>
                              {isAccountEmailVisible ? accountEmailLabel : maskedAccountEmailLabel}
                            </p>
                            {accountEmail ? (
                              <button
                                type="button"
                                className={styles.accountDetailReveal}
                                onClick={() => setIsAccountEmailVisible((current) => !current)}
                              >
                                {isAccountEmailVisible ? "Ocultar" : "Mostrar"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={styles.accountDetailButton}
                          onClick={() => openAccountModal("email")}
                        >
                          Alterar
                        </button>
                      </article>
                    </section>
                  </section>

                  <div className={styles.accountMainSections}>
                    <section className={styles.accountFeatureSection} aria-label="Senha e autenticação">
                      <div className={styles.accountFeatureHeader}>
                        <h5 className={styles.accountFeatureTitle}>Senha e autenticação</h5>
                      </div>

                      <div className={styles.accountFeatureStatus}>
                        <span className={styles.accountFeatureStatusIcon} aria-hidden="true">
                          <MaterialSymbolIcon name="lock" size={16} filled={false} />
                        </span>
                        <span className={styles.accountFeatureStatusText}>Confirmações por senha e e-mail ativas</span>
                      </div>

                      <div className={styles.accountFeatureActions}>
                        <button
                          type="button"
                          className={`${styles.accountFeatureButton} ${styles.accountFeatureButtonPrimary}`}
                          onClick={() => openAccountModal("password")}
                        >
                          Mudar senha
                        </button>
                      </div>
                    </section>

                    <section className={styles.accountRemovalSection} aria-label="Remoção de conta">
                      <h5 className={styles.accountFeatureTitle}>Remoção de conta</h5>
                      <p className={styles.accountFeatureDescription}>
                        Desativar sua conta significa que você poderá recuperá-la quando quiser.
                      </p>

                      <div className={styles.accountFeatureActions}>
                        <button
                          type="button"
                          className={`${styles.accountFeatureButton} ${styles.accountFeatureButtonWarn}`}
                          onClick={() => openAccountModal("deactivate")}
                        >
                          Desativar conta
                        </button>
                        <button
                          type="button"
                          className={`${styles.accountFeatureButton} ${styles.accountFeatureButtonDanger}`}
                          onClick={() => openAccountModal("delete")}
                        >
                          Excluir conta
                        </button>
                      </div>
                    </section>

                    {accountActionFeedback ? (
                      <p
                        className={`${styles.accountActionFeedback} ${styles.accountSectionFeedback}${
                          accountActionFeedback.tone === "error"
                            ? ` ${styles.accountActionFeedbackError}`
                            : ` ${styles.accountActionFeedbackSuccess}`
                        }`}
                        role="status"
                        aria-live="polite"
                      >
                        {accountActionFeedback.message}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : activeSection === "profile" ? (
            <div
              className={`${styles.profileEditor}${hasUnsavedProfileChanges ? ` ${styles.profileEditorWithUnsaved}` : ""}`}
            >
              <div className={styles.editorHeader}>
                <h3 className={styles.editorTitle}>Editar perfil</h3>
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
                  <div className={styles.formDivider} aria-hidden="true" />

                  <div className={styles.profileMediaGrid}>
                    <section className={`${styles.formSection} ${styles.profileMediaSection}`}>
                      <label className={styles.fieldLabel} htmlFor="profile-avatar-upload">
                        Avatar
                      </label>
                      <div className={`${styles.uploadActions} ${styles.uploadActionsStack}`}>
                      <label
                        className={`${styles.uploadButton}${isAvatarUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""}`}
                        htmlFor="profile-avatar-upload"
                      >
                        {isAvatarUploading ? "Enviando avatar..." : "Alterar avatar"}
                      </label>
                      {hasAvatarMedia ? (
                        <button
                          type="button"
                          className={styles.uploadLinkButton}
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
                        ref={avatarFileInputRef}
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

                    <section className={`${styles.formSection} ${styles.profileMediaSection}`}>
                      <label className={styles.fieldLabel} htmlFor="profile-banner-upload">
                        Banner do perfil
                      </label>
                      <div className={`${styles.uploadActions} ${styles.uploadActionsStack}`}>
                      <label
                        className={`${styles.uploadButton}${isBannerUploading || !canUploadMedia ? ` ${styles.uploadButtonDisabled}` : ""}`}
                        htmlFor="profile-banner-upload"
                      >
                        {isBannerUploading ? "Enviando banner..." : "Alterar banner"}
                      </label>
                      {hasBannerMedia ? (
                        <button
                          type="button"
                          className={styles.uploadLinkButton}
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
                        ref={bannerFileInputRef}
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
                  </div>
                  <div className={styles.formDivider} aria-hidden="true" />

                  <section className={`${styles.formSection} ${styles.plusProfileSection}`} aria-label="Tema de perfil">
                    <div className={styles.plusProfileHeader}>
                      <p className={styles.plusProfileEyebrow}>Tema de perfil</p>
                    </div>

                    <div className={styles.plusProfileThemeBlock}>
                      <div className={styles.plusProfileThemeColors}>
                        {(
                          [
                            { slot: "primary", label: "Primária", color: draftProfileTheme.primary },
                            { slot: "accent", label: "Realce", color: draftProfileTheme.accent },
                          ] as const
                        ).map((entry) => {
                          const isOpen =
                            isProfileThemeColorPickerOpen && profileThemeColorPickerSlot === entry.slot;
                          return (
                            <div key={entry.slot} className={styles.plusProfileColorPickerItem}>
                              <span className={styles.plusProfileColorLabel}>{entry.label}</span>
                              <div
                                className={styles.bannerColorPicker}
                                ref={isOpen ? profileThemeColorPickerRef : undefined}
                              >
                                <button
                                  type="button"
                                  className={styles.bannerColorTrigger}
                                  style={{ backgroundColor: entry.color }}
                                  aria-label={`Selecionar cor ${entry.label.toLowerCase()} do perfil`}
                                  aria-expanded={isOpen}
                                  onClick={() => {
                                    if (isOpen) {
                                      setIsProfileThemeColorPickerOpen(false);
                                      return;
                                    }
                                    handleOpenProfileThemeColorPicker(entry.slot);
                                  }}
                                >
                                  <span className={styles.bannerColorTriggerIcon} aria-hidden="true">
                                    <MaterialSymbolIcon name="edit" size={14} filled={true} />
                                  </span>
                                </button>

                                {isOpen ? (
                                  <div
                                    ref={profileThemeColorPopoverRef}
                                    className={styles.bannerColorPopover}
                                    style={
                                      profileThemeColorPopoverPosition
                                        ? {
                                            top: `${profileThemeColorPopoverPosition.top}px`,
                                            left: `${profileThemeColorPopoverPosition.left}px`,
                                          }
                                        : undefined
                                    }
                                    role="group"
                                    aria-label={`Cor ${entry.label}`}
                                  >
                                    <div
                                      ref={profileThemeColorAreaRef}
                                      className={styles.bannerColorArea}
                                      style={{ backgroundColor: `hsl(${profileThemeColorHue} 100% 50%)` }}
                                      onPointerDown={handleProfileThemeColorAreaPointerDown}
                                      onPointerMove={handleProfileThemeColorAreaPointerMove}
                                      onPointerUp={handleProfileThemeColorAreaPointerUp}
                                      onPointerCancel={handleProfileThemeColorAreaPointerUp}
                                    >
                                      <div className={styles.bannerColorAreaWhiteOverlay} />
                                      <div className={styles.bannerColorAreaBlackOverlay} />
                                      <span
                                        className={styles.bannerColorAreaCursor}
                                        style={{
                                          left: `${clamp(profileThemeColorSaturation, 2, 98)}%`,
                                          top: `${clamp(100 - profileThemeColorValue, 2, 98)}%`,
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
                                      value={Math.round(profileThemeColorHue)}
                                      aria-label={`Matiz da cor ${entry.label.toLowerCase()}`}
                                      onChange={handleProfileThemeColorHueChange}
                                    />

                                    <div className={styles.bannerColorHexRow}>
                                      <input
                                        className={styles.bannerColorHexInput}
                                        type="text"
                                        inputMode="text"
                                        spellCheck={false}
                                        value={profileThemeColorInput}
                                        aria-label={`Cor hexadecimal ${entry.label.toLowerCase()}`}
                                        onChange={(event) => handleProfileThemeColorInputChange(event.target.value)}
                                        onBlur={handleProfileThemeColorInputBlur}
                                      />
                                      <button
                                        type="button"
                                        className={styles.bannerColorEyeDropperButton}
                                        aria-label="Capturar cor da tela"
                                        title={isEyeDropperSupported ? "Capturar cor da tela" : "Captura de tela indisponível"}
                                        disabled={!isEyeDropperSupported}
                                        onClick={() => {
                                          void handleProfileThemeColorEyedropperClick();
                                        }}
                                      >
                                        <MaterialSymbolIcon name="colorize" size={16} filled={false} />
                                      </button>
                                    </div>

                                    <div className={styles.bannerColorSwatches} role="list" aria-label="Cores sugeridas">
                                      {BANNER_COLOR_SWATCHES.map((color) => {
                                        const normalizedSwatchColor = normalizeBannerColor(color) ?? color;
                                        const isActiveSwatch = normalizedSwatchColor === entry.color;
                                        return (
                                          <button
                                            key={`${entry.slot}-${color}`}
                                            type="button"
                                            className={`${styles.bannerColorSwatchButton}${isActiveSwatch ? ` ${styles.bannerColorSwatchButtonActive}` : ""}`}
                                            style={{ backgroundColor: normalizedSwatchColor }}
                                            aria-label={`Selecionar cor ${normalizedSwatchColor}`}
                                            onClick={() => {
                                              applyProfileThemeColorPickerValue(normalizedSwatchColor);
                                            }}
                                          />
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                  <div className={styles.formDivider} aria-hidden="true" />

                  <section className={styles.formSection}>
                    <label className={styles.fieldLabel} htmlFor="profile-about">
                      Sobre mim
                    </label>
                    <div className={styles.fieldMetaRow}>
                      <p className={styles.fieldHelp}>Markdown e links são suportados.</p>
                    </div>
                    <div className={styles.textareaWrap}>
                      <span className={styles.fieldCounter}>{aboutCount} / {ABOUT_MAX_LENGTH}</span>
                      <textarea
                        id="profile-about"
                        className={styles.fieldTextarea}
                        value={about}
                        onChange={(event) => setAbout(event.target.value.slice(0, ABOUT_MAX_LENGTH))}
                        maxLength={ABOUT_MAX_LENGTH}
                        spellCheck={false}
                      />
                    </div>
                  </section>

                </form>

                <aside className={styles.previewPane} aria-label="Prévia do perfil">
                  <div className={styles.previewCardReuse}>
                    <div className={styles.previewInteractiveFrame}>
                      <button
                        type="button"
                        className={`${styles.previewMediaHotspot} ${styles.previewBannerHotspot}${
                          isBannerUploading || !canUploadMedia ? ` ${styles.previewMediaHotspotDisabled}` : ""
                        }`}
                        onMouseEnter={() => setIsPreviewBannerHotspotActive(true)}
                        onMouseLeave={() => setIsPreviewBannerHotspotActive(false)}
                        onFocus={() => setIsPreviewBannerHotspotActive(true)}
                        onBlur={() => setIsPreviewBannerHotspotActive(false)}
                        onClick={() => handleOpenProfileMediaDialog("banner")}
                        disabled={isBannerUploading || !canUploadMedia}
                        aria-label={isBannerUploading ? "Enviando banner..." : "Clique para enviar banner"}
                      >
                        <span className={styles.previewMediaHotspotContent} aria-hidden="true">
                          <MaterialSymbolIcon className={styles.previewMediaHotspotIcon} name="edit" size={20} filled={false} />
                          <span className={styles.previewMediaHotspotLabel}>Mudar banner</span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`${styles.previewMediaHotspot} ${styles.previewAvatarHotspot}${
                          isAvatarUploading || !canUploadMedia ? ` ${styles.previewMediaHotspotDisabled}` : ""
                        }`}
                        onMouseEnter={() => setIsPreviewAvatarHotspotActive(true)}
                        onMouseLeave={() => setIsPreviewAvatarHotspotActive(false)}
                        onFocus={() => setIsPreviewAvatarHotspotActive(true)}
                        onBlur={() => setIsPreviewAvatarHotspotActive(false)}
                        onClick={() => handleOpenProfileMediaDialog("avatar")}
                        disabled={isAvatarUploading || !canUploadMedia}
                        aria-label={isAvatarUploading ? "Enviando avatar..." : "Clique para enviar avatar"}
                      >
                        <span className={styles.previewMediaHotspotContent} aria-hidden="true">
                          <MaterialSymbolIcon className={styles.previewMediaHotspotIcon} name="edit" size={18} filled={false} />
                        </span>
                      </button>

                      <div className={styles.previewProfileLayer}>
                        <UserProfilePopover
                          avatarSrc={avatarSrc}
                          bannerSrc={bannerSrc}
                          bannerColor={shouldSuppressPreviewBannerColor ? null : previewBannerColor}
                          themePrimaryColor={previewThemePrimaryColor}
                          themeAccentColor={previewThemeAccentColor}
                          showBannerEditOverlay={isPreviewBannerHotspotActive}
                          showAvatarEditOverlay={isPreviewAvatarHotspotActive}
                          displayName={safeDisplayName}
                          username={safeUsername}
                          profileUserId={spotifyConnectionScope}
                          aboutText={safeAbout}
                          spotifyConnection={spotifyConnection}
                          presenceState="online"
                          presenceLabel={PRESENCE_LABELS.online}
                          showActions={false}
                        />
                      </div>
                    </div>
                  </div>
                </aside>
              </div>

              {hasUnsavedProfileChanges ? (
                <div className={styles.unsavedBar} role="status" aria-live="polite">
                  <p className={styles.unsavedText}>Há alterações não salvas.</p>
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
            ) : activeSection === "connections" ? (
              <section className={styles.connectionsPanel} aria-label="Conexões">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Conexões</h3>
                </header>

                <div className={styles.connectionsContent}>
                  <section className={styles.connectionsDirectory} aria-label="Adicionar conexões ao perfil">
                    <p className={styles.connectionsDirectoryTitle}>Adicionar conexões ao perfil</p>
                    <p className={styles.connectionsDirectorySubtitle}>
                      Seus dados só serão usados com sua autorização, conforme a{" "}
                      <span className={styles.connectionsDirectoryPolicyLink}>política de privacidade</span> do Messly.
                    </p>
                    <div className={styles.connectionsProviderGrid}>
                      <button
                        type="button"
                        className={`${styles.connectionsProviderButton}${
                          isSpotifyConnected ? ` ${styles.connectionsProviderButtonActive}` : ""
                        }`}
                        aria-label={isSpotifyConnected ? "Spotify conectado" : "Conectar Spotify"}
                        title={isSpotifyConnected ? "Spotify conectado" : "Conectar Spotify"}
                        onClick={() => {
                          void handleConnectSpotify();
                        }}
                        disabled={isSpotifyConnected || isSpotifyConnecting || !spotifyOAuthEnabled}
                      >
                        <img className={styles.connectionsProviderButtonLogoImage} src={spotifyLogoSrc} alt="" loading="lazy" />
                      </button>
                    </div>

                    {!isSpotifyConnected && isSpotifyConnecting ? (
                      <p className={styles.connectionsProviderStatus}>Conectando ao Spotify...</p>
                    ) : null}
                    {!isSpotifyConnected && !isSpotifyConnecting && !spotifyOAuthEnabled ? (
                      <p className={styles.connectionsProviderHint}>
                        A conexão com o Spotify não está disponível no momento.
                      </p>
                    ) : null}
                    {spotifyConnectionError ? (
                      <p className={styles.connectionsProviderError} role="alert">
                        {spotifyConnectionError}
                      </p>
                    ) : null}
                  </section>

                  <div className={styles.connectionsDivider} aria-hidden="true" />

                  {isSpotifyConnected ? (
                    <article className={styles.connectionsCard} aria-label="Spotify conectado">
                      <div className={styles.connectionsCardHeader}>
                        <span className={styles.connectionsProviderIcon} aria-hidden="true">
                          <img className={styles.connectionsProviderLogoImage} src={spotifyLogoSrc} alt="" loading="lazy" />
                        </span>
                        <div className={styles.connectionsProviderMeta}>
                          <p className={styles.connectionsProviderName}>{spotifyDisplayName}</p>
                          <p className={styles.connectionsProviderType}>Spotify</p>
                        </div>
                        <button
                          type="button"
                          className={styles.connectionsDisconnectButton}
                          onClick={handleDisconnectSpotify}
                          aria-label="Desconectar Spotify"
                        >
                          <MaterialSymbolIcon name="close" size={16} filled={false} />
                        </button>
                      </div>

                      <div className={styles.connectionsToggleList}>
                        <div className={styles.connectionsToggleRow}>
                          <p className={styles.connectionsToggleTitle}>Exibir no perfil</p>
                          <button
                            type="button"
                            className={`${styles.windowsSwitch}${spotifyConnection.showOnProfile ? ` ${styles.windowsSwitchOn}` : ""}`}
                            aria-label="Exibir no perfil"
                            aria-pressed={spotifyConnection.showOnProfile}
                            onClick={() => handleSpotifyVisibilityToggle("showOnProfile")}
                          >
                            <span className={styles.windowsSwitchThumb} />
                          </button>
                        </div>

                        <div className={styles.connectionsToggleRow}>
                          <p className={styles.connectionsToggleTitle}>Exibir Spotify no status</p>
                          <button
                            type="button"
                            className={`${styles.windowsSwitch}${spotifyConnection.showAsStatus ? ` ${styles.windowsSwitchOn}` : ""}`}
                            aria-label="Alternar status do Spotify"
                            aria-pressed={spotifyConnection.showAsStatus}
                            onClick={() => handleSpotifyVisibilityToggle("showAsStatus")}
                          >
                            <span className={styles.windowsSwitchThumb} />
                          </button>
                        </div>

                      </div>
                    </article>
                  ) : null}
                </div>
              </section>
            ) : activeSection === "audio" ? (
              <section className={styles.audioPanel} aria-label="Configurações de voz e vídeo">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Voz e vídeo</h3>
                </header>

                <div className={styles.audioContent}>
                  <div className={styles.audioScene}>
                    <section className={styles.audioDeviceGrid} aria-label="Dispositivos de áudio">
                      <article className={styles.audioDeviceCard}>
                        <label className={styles.audioField}>
                          <span>Microfone</span>
                          <div className={styles.audioDeviceSelect} ref={inputDeviceSelectRef}>
                            <button
                              type="button"
                              className={`${styles.audioDeviceSelectTrigger}${
                                isInputDeviceSelectOpen ? ` ${styles.audioDeviceSelectTriggerOpen}` : ""
                              }`}
                              aria-haspopup="listbox"
                              aria-expanded={isInputDeviceSelectOpen}
                              aria-label="Selecionar microfone"
                              onClick={() => {
                                setIsOutputDeviceSelectOpen(false);
                                setIsInputDeviceSelectOpen((current) => !current);
                              }}
                            >
                              <span className={styles.audioDeviceSelectTriggerText}>
                                <span className={styles.audioDeviceSelectTitle}>
                                  {selectedInputDeviceOption?.title ?? "Padrão do Windows"}
                                </span>
                                {selectedInputDeviceOption?.subtitle ? (
                                  <span className={styles.audioDeviceSelectSubtitle}>
                                    {selectedInputDeviceOption.subtitle}
                                  </span>
                                ) : null}
                              </span>
                              <MaterialSymbolIcon name="expand_more" size={18} />
                            </button>

                            {isInputDeviceSelectOpen ? (
                              <div className={styles.audioDeviceSelectMenu} role="listbox" aria-label="Lista de microfones">
                                {inputDeviceOptions.map((option, index) => {
                                  const optionKey = option.value || `default-input-${index}`;
                                  const isSelected = option.value === selectedInputId;
                                  return (
                                    <button
                                      key={optionKey}
                                      type="button"
                                      className={`${styles.audioDeviceSelectOption}${
                                        isSelected ? ` ${styles.audioDeviceSelectOptionSelected}` : ""
                                      }`}
                                      role="option"
                                      aria-selected={isSelected}
                                      onClick={() => handleSelectInputDevice(option.value)}
                                    >
                                      <span className={styles.audioDeviceSelectOptionText}>
                                        <span className={styles.audioDeviceSelectOptionTitle}>{option.title}</span>
                                        {option.subtitle ? (
                                          <span className={styles.audioDeviceSelectOptionSubtitle}>{option.subtitle}</span>
                                        ) : null}
                                      </span>
                                      {isSelected ? (
                                        <span className={styles.audioDeviceSelectOptionCheck} aria-hidden="true">
                                          <MaterialSymbolIcon name="check" size={14} filled={true} />
                                        </span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        </label>

                        <label className={`${styles.audioSlider} ${styles.audioVolumeSlider}`}>
                          <span className={styles.audioSliderLabelRow}>
                            <span>Volume de entrada</span>
                            <strong>{normalizedInputGain}%</strong>
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={normalizedInputGain}
                            style={inputVolumeSliderStyle}
                            onInput={(event) => setInputGain(clamp(Number((event.target as HTMLInputElement).value), 0, 100))}
                            onChange={(event) => setInputGain(clamp(Number(event.target.value), 0, 100))}
                          />
                        </label>
                      </article>

                      <article className={styles.audioDeviceCard}>
                        <label className={styles.audioField}>
                          <span>Saída</span>
                          <div className={styles.audioDeviceSelect} ref={outputDeviceSelectRef}>
                            <button
                              type="button"
                              className={`${styles.audioDeviceSelectTrigger}${
                                isOutputDeviceSelectOpen ? ` ${styles.audioDeviceSelectTriggerOpen}` : ""
                              }`}
                              aria-haspopup="listbox"
                              aria-expanded={isOutputDeviceSelectOpen}
                              aria-label="Selecionar dispositivo de saída"
                              onClick={() => {
                                setIsInputDeviceSelectOpen(false);
                                setIsOutputDeviceSelectOpen((current) => !current);
                              }}
                            >
                              <span className={styles.audioDeviceSelectTriggerText}>
                                <span className={styles.audioDeviceSelectTitle}>
                                  {selectedOutputDeviceOption?.title ?? "Padrão do Windows"}
                                </span>
                                {selectedOutputDeviceOption?.subtitle ? (
                                  <span className={styles.audioDeviceSelectSubtitle}>
                                    {selectedOutputDeviceOption.subtitle}
                                  </span>
                                ) : null}
                              </span>
                              <MaterialSymbolIcon name="expand_more" size={18} />
                            </button>

                            {isOutputDeviceSelectOpen ? (
                              <div className={styles.audioDeviceSelectMenu} role="listbox" aria-label="Lista de saídas de áudio">
                                {outputDeviceOptions.map((option, index) => {
                                  const optionKey = option.value || `default-output-${index}`;
                                  const isSelected = option.value === selectedOutputId;
                                  return (
                                    <button
                                      key={optionKey}
                                      type="button"
                                      className={`${styles.audioDeviceSelectOption}${
                                        isSelected ? ` ${styles.audioDeviceSelectOptionSelected}` : ""
                                      }`}
                                      role="option"
                                      aria-selected={isSelected}
                                      onClick={() => handleSelectOutputDevice(option.value)}
                                    >
                                      <span className={styles.audioDeviceSelectOptionText}>
                                        <span className={styles.audioDeviceSelectOptionTitle}>{option.title}</span>
                                        {option.subtitle ? (
                                          <span className={styles.audioDeviceSelectOptionSubtitle}>{option.subtitle}</span>
                                        ) : null}
                                      </span>
                                      {isSelected ? (
                                        <span className={styles.audioDeviceSelectOptionCheck} aria-hidden="true">
                                          <MaterialSymbolIcon name="check" size={14} filled={true} />
                                        </span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        </label>

                        <label className={`${styles.audioSlider} ${styles.audioVolumeSlider}`}>
                          <span className={styles.audioSliderLabelRow}>
                            <span>Volume de saída</span>
                            <strong>{normalizedOutputVolume}%</strong>
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={200}
                            step={1}
                            value={outputVolume}
                            style={outputVolumeSliderStyle}
                            onInput={(event) => setOutputVolume(clamp(Number((event.target as HTMLInputElement).value), 0, 200))}
                            onChange={(event) => setOutputVolume(clamp(Number(event.target.value), 0, 200))}
                          />
                        </label>
                      </article>
                    </section>

                    <section className={styles.audioProcessingSection} aria-label="Processamento de voz">
                      <div className={`${styles.processingCoreRows} ${styles.processingCoreRowsClean}`}>
                        <div className={`${styles.processingCoreRow} ${styles.processingCoreRowCheckboxLayout}`}>
                          <ProcessingCheckbox
                            checked={echoCancellation}
                            ariaLabel="Alternar cancelamento de eco"
                            onChange={setEchoCancellation}
                          />
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>Cancelamento de eco</p>
                            <p className={styles.processingCoreRowState}>Filtra retorno acústico do alto-falante.</p>
                          </div>
                        </div>

                        <div className={styles.processingCoreRow}>
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>Supressão de ruído</p>
                            <p className={styles.processingCoreRowState}>
                              Reduz ruído de fundo do microfone durante chamadas de voz.
                            </p>
                            <div className={styles.noiseSuppressionModeList} role="radiogroup" aria-label="Supressão de ruído">
                              {NOISE_SUPPRESSION_MODE_OPTIONS.map((option) => {
                                const isSelected = noiseSuppressionMode === option.value;
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={isSelected}
                                    className={`${styles.noiseSuppressionModeOption}${
                                      isSelected ? ` ${styles.noiseSuppressionModeOptionSelected}` : ""
                                    }`}
                                    onClick={() => setNoiseSuppressionMode(option.value)}
                                  >
                                    <span className={styles.noiseSuppressionModeDot} aria-hidden="true" />
                                    <span className={styles.noiseSuppressionModeLabel}>{option.label}</span>
                                    <span className={styles.noiseSuppressionModeHint}>{option.description}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>

                        <div className={`${styles.processingCoreRow} ${styles.processingCoreRowCheckboxLayout}`}>
                          <ProcessingCheckbox
                            checked={vadEnabled}
                            ariaLabel="Alternar detecção de voz"
                            onChange={setVadEnabled}
                          />
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>Detecção de voz (VAD)</p>
                            <p className={styles.processingCoreRowState}>Evita envio de silêncio quando não há fala.</p>
                          </div>
                        </div>
                      </div>
                    </section>

                    <section className={styles.audioModeSection} aria-label="Modo de entrada">
                      <div className={styles.audioPttHeader}>
                        <div className={styles.audioPttHeaderMeta}>
                          <h4 className={styles.audioPttTitle}>Apertar para falar</h4>
                          <p className={styles.audioPttDescription}>
                            Ative para transmitir áudio apenas enquanto pressiona uma tecla.
                          </p>
                        </div>
                        <button
                          type="button"
                          className={`${styles.windowsSwitch}${pushToTalkEnabled ? ` ${styles.windowsSwitchOn}` : ""}`}
                          aria-label="Alternar apertar para falar"
                          aria-pressed={pushToTalkEnabled}
                          onClick={() => handlePushToTalkChange(!pushToTalkEnabled)}
                        >
                          <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                        </button>
                      </div>

                      {pushToTalkEnabled ? (
                        <div className={styles.audioPttBody}>
                          <div className={styles.audioPttMeta}>
                            <p className={styles.audioPttSummaryTitle}>Atalho de teclado</p>
                            <p className={styles.audioPttDescription}>Tecla usada para ativar o microfone.</p>
                          </div>

                          <div className={styles.audioShortcutRow}>
                            <span className={styles.audioShortcutKey}>{String(pushToTalkBind).replace(/\s+/g, "").toUpperCase()}</span>
                            <button
                              type="button"
                              className={`${styles.audioShortcutEditButton}${
                                listeningForBind ? ` ${styles.audioShortcutEditButtonListening}` : ""
                              }`}
                              onClick={() => setListeningForBind(true)}
                            >
                              <MaterialSymbolIcon name="edit" size={14} filled={false} />
                              <span>{listeningForBind ? "Pressione uma tecla..." : "Editar"}</span>
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </section>

                    <section className={styles.audioProcessingSection} aria-label="Processamento avançado de voz">
                      <div className={styles.processingCoreRows}>
                        <div className={styles.processingCoreRow}>
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>Controle de ganho automático</p>
                            <p className={styles.processingCoreRowState}>Compensa volume baixo sem ajuste manual.</p>
                          </div>
                          <button
                            type="button"
                            className={`${styles.windowsSwitch}${autoGainControl ? ` ${styles.windowsSwitchOn}` : ""}`}
                            aria-label="Alternar controle de ganho automático"
                            aria-pressed={autoGainControl}
                            onClick={() => setAutoGainControl(!autoGainControl)}
                          >
                            <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                          </button>
                        </div>

                        <div className={styles.processingCoreRow}>
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>
                              Prioridade de audio em tempo real
                            </p>
                            <p className={styles.processingCoreRowState}>
                              Melhora a estabilidade do audio em conexoes sobrecarregadas. Em algumas redes, este ajuste
                              pode não ter efeito.
                            </p>
                          </div>
                          <button
                            type="button"
                            className={`${styles.windowsSwitch}${qosHighPriority ? ` ${styles.windowsSwitchOn}` : ""}`}
                            aria-label="Alternar prioridade de audio em tempo real"
                            aria-pressed={qosHighPriority}
                            onClick={() => setQosHighPriority(!qosHighPriority)}
                          >
                            <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <section className={styles.processingCoreSensitivityBlock} aria-label="Sensibilidade do microfone">
                        <div className={styles.processingCoreSensitivityHead}>
                          <div className={styles.processingCoreRowMeta}>
                            <p className={styles.processingCoreRowTitle}>Ajustar automaticamente a sensibilidade de entrada</p>
                            <p className={styles.processingCoreRowState}>
                              {autoMicSensitivity
                                ? "Ajusta automaticamente a sensibilidade do microfone para manter sua voz clara."
                                : "Defina manualmente a sensibilidade do microfone."}
                            </p>
                          </div>
                          <button
                            type="button"
                            className={`${styles.windowsSwitch}${autoMicSensitivity ? ` ${styles.windowsSwitchOn}` : ""}`}
                            aria-label="Alternar ajuste automático da sensibilidade"
                            aria-pressed={autoMicSensitivity}
                            onClick={() => setAutoMicSensitivity(!autoMicSensitivity)}
                          >
                            <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                          </button>
                        </div>

                        <label
                          className={`${styles.audioSlider} ${styles.audioSliderSensitivity} ${styles.processingCoreSensitivitySlider}${
                            autoMicSensitivity ? "" : ` ${styles.processingCoreSensitivitySliderManual}`
                          }`}
                        >
                          <span className={styles.audioSrOnly}>Sensibilidade do microfone</span>
                            <input
                              type="range"
                              min={-100}
                              max={0}
                              step={1}
                              value={displayedMicSensitivity}
                              style={micSensitivitySliderStyle}
                              onInput={(event) => {
                                handleMicSensitivitySliderChange(Number((event.target as HTMLInputElement).value));
                              }}
                              onChange={(event) => {
                                handleMicSensitivitySliderChange(Number(event.target.value));
                              }}
                          />
                        </label>
                      </section>
                    </section>
                  </div>
                </div>
              </section>
            ) : activeSection === "windows" && isElectron ? (
              <section className={styles.windowsPanel} aria-label="Configurações do Windows">
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
                        Disponível apenas no app para Windows.
                      </p>
                    ) : (
                      <div className={styles.windowsSettingList}>
                        {(
                          [
                            {
                              key: "startMinimized",
                              title: "Iniciar minimizado",
                              description: "Abre o aplicativo minimizado na próxima inicialização do sistema.",
                            },
                            {
                              key: "closeToTray",
                              title: "Ao fechar, minimizar para bandeja",
                              description: "Mantém o aplicativo em segundo plano ao fechar a janela principal.",
                            },
                            {
                              key: "launchAtStartup",
                              title: "Abrir na inicialização",
                              description: "Inicia o Messly automaticamente quando o Windows ligar.",
                            },
                          ] as const
                        ).map((item) => {
                          const isSaving = savingWindowsBehaviorKey === item.key;
                          const isBlockedByDependency =
                            item.key === "startMinimized" && !windowsBehaviorSettings.launchAtStartup;
                          const disabled =
                            !canManageWindowsBehavior || isWindowsBehaviorLoading || Boolean(isSaving) || isBlockedByDependency;
                          const checked = Boolean(windowsBehaviorSettings[item.key]);
                          return (
                            <div
                              key={item.key}
                              className={`${styles.windowsSettingRow}${
                                disabled ? ` ${styles.windowsSettingRowDisabled}` : ""
                              }`}
                            >
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
            ) : activeSection === "devices" ? (
              <section className={styles.devicesPanel} aria-label="Dispositivos">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Dispositivos</h3>
                </header>

                <div className={styles.devicesContent}>
                  <section className={styles.devicesIntro}>
                    <p className={styles.devicesIntroText}>
                      Veja os acessos recentes da sua conta neste dispositivo e nos outros clientes conectados.
                    </p>
                  </section>
                  {deviceSessionsFeedback ? (
                    <p
                      className={`${styles.devicesState}${
                        deviceSessionsFeedback.tone === "error"
                          ? ` ${styles.devicesStateError}`
                          : ` ${styles.devicesStateSuccess}`
                      }`}
                      role="status"
                      aria-live="polite"
                    >
                      {deviceSessionsFeedback.message}
                    </p>
                  ) : null}

                  {deviceSessionsError ? (
                    <p className={`${styles.devicesState} ${styles.devicesStateError}`}>{deviceSessionsError}</p>
                  ) : deviceSessions.length === 0 ? (
                    isDeviceSessionsLoading ? null : (
                      <div className={styles.devicesEmptyState}>
                        <div className={styles.devicesEmptyIcon} aria-hidden="true">
                          <MaterialSymbolIcon name="devices" size={30} filled={false} />
                        </div>
                        <p className={styles.devicesEmptyTitle}>Nenhum dispositivo recente encontrado</p>
                        <p className={styles.devicesEmptyText}>
                          Quando houver sessões registradas, elas aparecerão aqui com sistema e localização aproximada.
                        </p>
                      </div>
                    )
                  ) : (
                    <>
                      {currentDeviceSession ? (
                        <section className={styles.devicesGroup} aria-label="Dispositivo atual">
                          <h4 className={styles.devicesGroupTitle}>Dispositivo atual</h4>

                          {(() => {
                            const currentLocationLabel = formatDeviceLocationLabel(currentDeviceSession.locationLabel);

                            return (
                              <article className={`${styles.deviceRow} ${styles.deviceRowCurrent}`}>
                                <div className={styles.deviceIconWrap} aria-hidden="true">
                                  <MaterialSymbolIcon
                                    className={styles.deviceIcon}
                                    name={getDevicePlatformIcon(currentDeviceSession.platform)}
                                    size={24}
                                    filled={false}
                                  />
                                </div>

                                <div className={styles.deviceMeta}>
                                  <p className={styles.deviceClientOs}>
                                    {`${currentDeviceSession.osName} • ${currentDeviceSession.clientName}`}
                                  </p>
                                  <p className={styles.deviceMetaLine}>
                                    {currentLocationLabel ?? "Localização não disponível"}
                                  </p>
                                </div>
                              </article>
                            );
                          })()}
                        </section>
                      ) : null}

                      {otherDeviceSessions.length > 0 ? (
                        <section className={styles.devicesGroup} aria-label="Outros dispositivos">
                          <h4 className={styles.devicesGroupTitle}>Outros dispositivos</h4>

                          <div className={styles.devicesList}>
                            {otherDeviceSessions.map((session) => {
                              const sessionAgeLabel = formatSessionActiveForLabel(
                                session.createdAt,
                                session.lastActive ?? session.updatedAt,
                              );
                              const sessionRelativeLabel = sessionAgeLabel.replace(/^Ativo\s+/i, "");
                              const locationLabel = formatDeviceLocationLabel(session.locationLabel);
                              const canEndSession = !session.isCurrent && isUuidLike(String(session.sessionId ?? ""));
                              const isEndingSession = endingDeviceSessionId === session.sessionId;

                              return (
                                <article key={session.id} className={styles.deviceRow}>
                                  <div className={styles.deviceIconWrap} aria-hidden="true">
                                    <MaterialSymbolIcon
                                      className={styles.deviceIcon}
                                      name={getDevicePlatformIcon(session.platform)}
                                      size={24}
                                      filled={false}
                                    />
                                  </div>

                                  <div className={styles.deviceMeta}>
                                    <p className={styles.deviceClientOs}>{`${session.osName} • ${session.clientName}`}</p>
                                    <p className={styles.deviceMetaLine}>
                                      {`${locationLabel ?? "Localização não disponível"} - ${sessionRelativeLabel}`}
                                    </p>
                                  </div>

                                  {canEndSession ? (
                                    <button
                                      type="button"
                                      className={`${styles.deviceEndSessionButton}${
                                        isEndingSession ? ` ${styles.deviceEndSessionButtonBusy}` : ""
                                      }`}
                                      aria-label={`Encerrar sessão de ${session.clientName}`}
                                      title="Encerrar sessão"
                                      disabled={isEndingSession || isEndingAllOtherDeviceSessions}
                                      onClick={() => {
                                        openEndDeviceSessionModal(session);
                                      }}
                                    >
                                      <MaterialSymbolIcon name="close" size={18} filled={false} />
                                    </button>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      ) : null}
                    </>
                  )}

                  <section className={styles.devicesEndAllSection} aria-label="Sair de todos os dispositivos conhecidos">
                    <h4 className={styles.devicesEndAllTitle}>Sair de todos os dispositivos conhecidos</h4>
                    <p className={styles.devicesEndAllText}>
                      Você terá que entrar novamente em todos os dispositivos de que sair.
                    </p>
                    <button
                      type="button"
                      className={styles.devicesEndAllDangerButton}
                      onClick={openEndAllOtherSessionsModal}
                      disabled={!hasKnownDeviceSessions || Boolean(endingDeviceSessionId) || isEndingAllOtherDeviceSessions}
                    >
                      {isEndingAllOtherDeviceSessions ? "Encerrando sessões..." : "Sair de todos os dispositivos conhecidos"}
                    </button>
                  </section>
                </div>
              </section>
            ) : (
              <section className={styles.socialPanel} aria-label="Conteúdo social">
                <header className={styles.editorHeader}>
                  <h3 className={styles.editorTitle}>Conteúdo social</h3>
                </header>

                <div className={styles.socialContent}>
                  <section className={styles.friendRequestCard} aria-label="Pedidos de amizade">
                    <div className={styles.friendRequestHeader}>
                      <h4 className={styles.friendRequestTitle}>Pedidos de amizade</h4>
                    </div>

                    <div className={styles.friendRequestList}>
                      {(
                        [
                          {
                            key: "allowAll",
                            title: "Qualquer pessoa",
                            description: "Permite convites de qualquer conta.",
                          },
                          {
                            key: "allowFriendsOfFriends",
                            title: "Amigos em comum",
                            description: "Libera pedidos quando existe ao menos uma amizade compartilhada.",
                          },
                        ] as const
                      ).map((item) => {
                        const checked = Boolean(friendRequestPrivacy[item.key]);
                        const disabled = !dbUserId || Boolean(savingFriendRequestPrivacyKey);
                        const isSaving = savingFriendRequestPrivacyKey === item.key;

                        return (
                          <div key={item.key} className={styles.friendRequestRow}>
                            <div className={styles.friendRequestMeta}>
                              <p className={styles.friendRequestRowTitle}>{item.title}</p>
                              <p className={styles.friendRequestRowDescription}>
                                {isSaving ? "Salvando permissão..." : item.description}
                              </p>
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
                                void handleFriendRequestPrivacyToggle(item.key, !checked);
                              }}
                            >
                              <span className={styles.windowsSwitchThumb} aria-hidden="true" />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {friendRequestPrivacyError ? (
                      <p className={styles.friendRequestError}>{friendRequestPrivacyError}</p>
                    ) : null}
                  </section>

                  {blockedAccounts.length > 0 ? (
                    <section className={styles.blockedCard} aria-label="Contas bloqueadas">
                      <div className={styles.blockedCardHeader}>
                        <div className={styles.blockedCardHeaderMeta}>
                          <h4 className={styles.blockedCardTitle}>Contas bloqueadas</h4>
                          <p className={styles.blockedCardDescription}>
                            Usuários bloqueados não podem iniciar contato com você até serem removidos desta lista.
                          </p>
                        </div>
                      </div>

                      <div className={styles.blockedTopBar}>
                        <label className={styles.blockedSearchField} htmlFor="blocked-accounts-search">
                          <MaterialSymbolIcon className={styles.blockedSearchIcon} name="search" size={16} filled={false} />
                          <input
                            id="blocked-accounts-search"
                            className={styles.blockedSearchInput}
                            type="search"
                            inputMode="search"
                            value={blockedSearchQuery}
                            onChange={(event) => setBlockedSearchQuery(event.target.value)}
                            placeholder="Buscar na lista de bloqueios"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                      </div>

                      {isBlockedAccountsLoading ? (
                        <p className={styles.blockedState}>Carregando bloqueios...</p>
                      ) : blockedAccountsError ? (
                        <p className={`${styles.blockedState} ${styles.blockedStateError}`}>{blockedAccountsError}</p>
                      ) : filteredBlockedAccounts.length === 0 ? (
                        <div className={styles.blockedEmptyStateCompact}>
                          <p className={styles.blockedEmptyTitle}>Nenhum resultado encontrado</p>
                          <p className={styles.blockedEmptyDescription}>Tente outro termo para buscar na lista.</p>
                        </div>
                      ) : (
                        <>
                          <div className={styles.blockedList}>
                            {filteredBlockedAccounts.map((account) => (
                              <article key={account.userId} className={styles.blockedRow}>
                                <div className={styles.blockedRowMain}>
                                  <div className={styles.blockedAvatarWrap}>
                                    <AvatarImage
                                      className={styles.blockedAvatar}
                                      src={account.avatarSrc}
                                      name={account.displayName || account.username}
                                      alt={`Avatar de ${account.displayName}`}
                                      loading="lazy"
                                    />
                                    <span className={styles.blockedAvatarStatus} aria-hidden="true" />
                                  </div>

                                  <div className={styles.blockedMeta}>
                                    <p className={styles.blockedName}>{account.displayName}</p>
                                    <p className={styles.blockedUsername}>{account.blockedAtLabel}</p>
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

                          <footer className={styles.blockedFooter}>
                            <p className={styles.blockedFooterCount}>{blockedFooterCountLabel}</p>
                          </footer>
                        </>
                      )}
                    </section>
                  ) : null}
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
        isOpen={Boolean(pendingDeviceSession)}
        title="Encerrar sessão"
        ariaLabel="Confirmar encerramento de sessão de dispositivo"
        onClose={closeEndDeviceSessionModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        closeOnBackdrop={!Boolean(endingDeviceSessionId)}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeEndDeviceSessionModal}
              disabled={Boolean(endingDeviceSessionId)}
            >
              Cancelar
            </button>
            <button
              className={styles.accountModalButtonPrimary}
              type="button"
              onClick={() => {
                void handleConfirmEndDeviceSession();
              }}
              disabled={Boolean(endingDeviceSessionId) || isEndingAllOtherDeviceSessions}
            >
              {endingDeviceSessionId ? "Encerrando sessão..." : "Encerrar sessão"}
            </button>
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Este dispositivo será desconectado da sua conta.
          </p>

          {pendingDeviceSession ? (
            <div className={styles.deviceSessionSummaryCard}>
              <p className={styles.deviceSessionSummaryPrimary}>
                {`${pendingDeviceSession.osName} • ${pendingDeviceSession.clientName}`}
              </p>
              <p className={styles.deviceSessionSummaryLine}>
                {formatDeviceLocationLabel(pendingDeviceSession.locationLabel) ?? "Localização não disponível"}
              </p>
            </div>
          ) : null}

          <label className={styles.accountModalLabel} htmlFor="device-session-password-input">
            Senha atual
          </label>
          <input
            id="device-session-password-input"
            className={styles.accountModalInput}
            type="password"
            value={pendingDeviceSessionPasswordInput}
            onChange={(event) => setPendingDeviceSessionPasswordInput(event.target.value)}
            placeholder="Digite sua senha"
            autoComplete="current-password"
            disabled={Boolean(endingDeviceSessionId) || isEndingAllOtherDeviceSessions}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleConfirmEndDeviceSession();
              }
            }}
          />

          {pendingDeviceSessionFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                pendingDeviceSessionFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {pendingDeviceSessionFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={isEndAllOtherSessionsModalOpen}
        title="Encerrar todas as sessões"
        ariaLabel="Confirmar encerramento de todas as sessões conhecidas"
        onClose={closeEndAllOtherSessionsModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        closeOnBackdrop={!isEndingAllOtherDeviceSessions}
        footer={(
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeEndAllOtherSessionsModal}
              disabled={isEndingAllOtherDeviceSessions}
            >
              Cancelar
            </button>
            <button
              className={styles.accountModalButtonPrimary}
              type="button"
              onClick={() => {
                void handleConfirmEndAllOtherSessions();
              }}
              disabled={isEndingAllOtherDeviceSessions}
            >
              {isEndingAllOtherDeviceSessions ? "Encerrando sessões..." : "Encerrar todas as sessões"}
            </button>
          </div>
        )}
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Isso irá desconectar sua conta de todos os dispositivos conhecidos, incluindo este dispositivo atual.
          </p>

          <label className={styles.accountModalLabel} htmlFor="device-session-end-all-password-input">
            Senha atual
          </label>
          <input
            id="device-session-end-all-password-input"
            className={styles.accountModalInput}
            type="password"
            value={endAllOtherSessionsPasswordInput}
            onChange={(event) => setEndAllOtherSessionsPasswordInput(event.target.value)}
            placeholder="Digite sua senha"
            autoComplete="current-password"
            disabled={isEndingAllOtherDeviceSessions}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleConfirmEndAllOtherSessions();
              }
            }}
          />

          {endAllOtherSessionsFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                endAllOtherSessionsFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {endAllOtherSessionsFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={accountModalKind === "username"}
        title="Alterar nome de usuário"
        ariaLabel="Alterar nome de usuário da conta"
        onClose={closeAccountModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeAccountModal}
              disabled={isAccountActionPending}
            >
              Cancelar
            </button>
            <button
              className={styles.accountModalButtonPrimary}
              type="button"
              onClick={() => {
                void handleAccountUsernameUpdate();
              }}
              disabled={isAccountActionPending || usernameCooldownState.isLocked || isAccountUsernameAvailabilityPending}
            >
              {isAccountActionPending ? "Salvando..." : "Confirmar"}
            </button>
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Escolha um novo nome de usuário. Use apenas letras minúsculas, números e underscore.
          </p>
          {usernameCooldownMessage ? <p className={styles.accountModalDescription}>{usernameCooldownMessage}</p> : null}

          <label className={styles.accountModalLabel} htmlFor="account-username-input">
            Novo nome de usuário
          </label>
          <input
            id="account-username-input"
            className={styles.accountModalInput}
            type="text"
            value={accountUsernameInput}
            onChange={(event) => setAccountUsernameInput(event.target.value.toLowerCase())}
            placeholder={safeUsername}
            autoComplete="username"
            spellCheck={false}
            maxLength={20}
            disabled={isAccountActionPending || usernameCooldownState.isLocked}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (!usernameCooldownState.isLocked) {
                  void handleAccountUsernameUpdate();
                }
              }
            }}
          />
          {accountUsernameAvailabilityFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountUsernameAvailabilityFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : accountUsernameAvailabilityFeedback.tone === "success"
                    ? ` ${styles.accountModalFeedbackSuccess}`
                    : ` ${styles.accountModalFeedbackInfo}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountUsernameAvailabilityFeedback.message}
            </p>
          ) : null}

          <label className={styles.accountModalLabel} htmlFor="account-username-password-input">
            Senha atual
          </label>
          <input
            id="account-username-password-input"
            className={styles.accountModalInput}
            type="password"
            value={accountUsernamePasswordInput}
            onChange={(event) => setAccountUsernamePasswordInput(event.target.value)}
            placeholder="Digite sua senha"
            autoComplete="current-password"
            disabled={isAccountActionPending || usernameCooldownState.isLocked}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (!usernameCooldownState.isLocked) {
                  void handleAccountUsernameUpdate();
                }
              }
            }}
          />

          {accountUsernameModalFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountUsernameModalFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountUsernameModalFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={accountModalKind === "email"}
        title="Alterar e-mail"
        ariaLabel="Alterar e-mail da conta"
        onClose={closeAccountModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeAccountModal}
              disabled={isAccountActionPending}
            >
              Cancelar
            </button>
            {accountEmailModalStep === "verifyCurrent" ? (
              <button
                className={styles.accountModalButtonPrimary}
                type="button"
                onClick={() => {
                  void handleAccountEmailVerifyCurrentStep();
                }}
                disabled={isAccountActionPending}
              >
                {isAccountActionPending ? "Verificando..." : "Verificar e-mail atual"}
              </button>
            ) : (
              <button
                className={styles.accountModalButtonPrimary}
                type="button"
                onClick={() => {
                  void handleAccountEmailSendVerification();
                }}
                disabled={isAccountActionPending}
              >
                {isAccountActionPending ? "Enviando..." : "Enviar verificação"}
              </button>
            )}
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            {accountEmailModalStep === "verifyCurrent"
              ? "Primeiro confirme o e-mail atual e sua senha. Depois enviamos a verificação para o novo e-mail."
              : "Agora informe o novo e-mail. Um link de verificação será enviado para concluir a troca."}
          </p>

          {accountEmailModalStep === "verifyCurrent" ? (
            <>
              <label className={styles.accountModalLabel} htmlFor="account-current-email-input">
                E-mail atual
              </label>
              <input
                id="account-current-email-input"
                className={styles.accountModalInput}
                type="email"
                value={accountCurrentEmailInput}
                onChange={(event) => setAccountCurrentEmailInput(event.target.value)}
                placeholder={accountEmailLabel}
                autoComplete="email"
                disabled={isAccountActionPending}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleAccountEmailVerifyCurrentStep();
                  }
                }}
              />

              <label className={styles.accountModalLabel} htmlFor="account-current-password-email-input">
                Senha atual
              </label>
              <input
                id="account-current-password-email-input"
                className={styles.accountModalInput}
                type="password"
                value={accountCurrentPasswordInput}
                onChange={(event) => setAccountCurrentPasswordInput(event.target.value)}
                placeholder="Digite sua senha"
                autoComplete="current-password"
                disabled={isAccountActionPending}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleAccountEmailVerifyCurrentStep();
                  }
                }}
              />
            </>
          ) : (
            <>
              <div className={styles.accountModalStepBadge}>
                <MaterialSymbolIcon name="check_circle" size={14} filled={true} />
                <span>Email atual confirmado</span>
              </div>

              <label className={styles.accountModalLabel} htmlFor="account-new-email-input">
                Novo e-mail
              </label>
              <input
                id="account-new-email-input"
                className={styles.accountModalInput}
                type="email"
                value={accountNewEmailInput}
                onChange={(event) => setAccountNewEmailInput(event.target.value)}
                placeholder="novoemail@gmail.com"
                autoComplete="email"
                disabled={isAccountActionPending}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleAccountEmailSendVerification();
                  }
                }}
              />
            </>
          )}

          {accountEmailModalFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountEmailModalFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountEmailModalFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={accountModalKind === "password"}
        title="Alterar senha"
        ariaLabel="Alterar senha da conta"
        onClose={closeAccountModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeAccountModal}
              disabled={isAccountActionPending}
            >
              Cancelar
            </button>
            <button
              className={styles.accountModalButtonPrimary}
              type="button"
              onClick={() => {
                void handleAccountPasswordUpdate();
              }}
              disabled={isAccountActionPending}
            >
              {isAccountActionPending ? "Salvando..." : "Salvar senha"}
            </button>
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Confirme a senha atual e defina uma nova senha para a sua conta.
          </p>

          <label className={styles.accountModalLabel} htmlFor="account-password-current">
            Senha atual
          </label>
          <input
            id="account-password-current"
            className={styles.accountModalInput}
            type="password"
            value={accountPasswordCurrentInput}
            onChange={(event) => setAccountPasswordCurrentInput(event.target.value)}
            autoComplete="current-password"
            disabled={isAccountActionPending}
          />

          <label className={styles.accountModalLabel} htmlFor="account-password-new">
            Nova senha
          </label>
          <input
            id="account-password-new"
            className={styles.accountModalInput}
            type="password"
            value={accountPasswordNewInput}
            onChange={(event) => setAccountPasswordNewInput(event.target.value)}
            autoComplete="new-password"
            disabled={isAccountActionPending}
          />

          <label className={styles.accountModalLabel} htmlFor="account-password-confirm">
            Confirmar nova senha
          </label>
          <input
            id="account-password-confirm"
            className={styles.accountModalInput}
            type="password"
            value={accountPasswordConfirmInput}
            onChange={(event) => setAccountPasswordConfirmInput(event.target.value)}
            autoComplete="new-password"
            disabled={isAccountActionPending}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAccountPasswordUpdate();
              }
            }}
          />

          {accountPasswordModalFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountPasswordModalFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountPasswordModalFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={accountModalKind === "deactivate"}
        title="Desativar conta"
        ariaLabel="Desativar conta"
        onClose={closeAccountModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeAccountModal}
              disabled={isAccountActionPending}
            >
              Cancelar
            </button>
            <button
              className={`${styles.accountModalButtonPrimary} ${styles.accountModalButtonWarn}`}
              type="button"
              onClick={() => {
                void handleAccountDeactivate();
              }}
              disabled={isAccountActionPending}
            >
              {isAccountActionPending ? "Desativando..." : "Desativar conta"}
            </button>
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Isso vai desconectar sua sessão atual. Para confirmar, digite sua senha e a palavra{" "}
            <strong>{ACCOUNT_DEACTIVATE_CONFIRM_TEXT}</strong>.
          </p>

          <label className={styles.accountModalLabel} htmlFor="account-deactivate-password">
            Senha atual
          </label>
          <input
            id="account-deactivate-password"
            className={styles.accountModalInput}
            type="password"
            value={accountDeactivatePasswordInput}
            onChange={(event) => setAccountDeactivatePasswordInput(event.target.value)}
            autoComplete="current-password"
            disabled={isAccountActionPending}
          />

          <label className={styles.accountModalLabel} htmlFor="account-deactivate-confirm">
            Digite {ACCOUNT_DEACTIVATE_CONFIRM_TEXT}
          </label>
          <input
            id="account-deactivate-confirm"
            className={styles.accountModalInput}
            type="text"
            value={accountDeactivateConfirmInput}
            onChange={(event) => setAccountDeactivateConfirmInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={isAccountActionPending}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAccountDeactivate();
              }
            }}
          />

          {accountDeactivateModalFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountDeactivateModalFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountDeactivateModalFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={accountModalKind === "delete"}
        title="Excluir conta"
        ariaLabel="Excluir conta"
        onClose={closeAccountModal}
        panelClassName={styles.accountModalPanel}
        bodyClassName={styles.accountModalBody}
        footer={
          <div className={styles.accountModalFooter}>
            <button
              className={styles.accountModalButtonGhost}
              type="button"
              onClick={closeAccountModal}
              disabled={isAccountActionPending}
            >
              Cancelar
            </button>
            <button
              className={`${styles.accountModalButtonPrimary} ${styles.accountModalButtonDanger}`}
              type="button"
              onClick={() => {
                void handleAccountDelete();
              }}
              disabled={isAccountActionPending}
            >
              {isAccountActionPending ? "Excluindo..." : "Excluir conta"}
            </button>
          </div>
        }
      >
        <div className={styles.accountModalForm}>
          <p className={styles.accountModalDescription}>
            Essa ação é irreversível. Para confirmar, digite sua senha e a palavra{" "}
            <strong>{ACCOUNT_DELETE_CONFIRM_TEXT}</strong>.
          </p>

          <label className={styles.accountModalLabel} htmlFor="account-delete-password">
            Senha atual
          </label>
          <input
            id="account-delete-password"
            className={styles.accountModalInput}
            type="password"
            value={accountDeletePasswordInput}
            onChange={(event) => setAccountDeletePasswordInput(event.target.value)}
            autoComplete="current-password"
            disabled={isAccountActionPending}
          />

          <label className={styles.accountModalLabel} htmlFor="account-delete-confirm">
            Digite {ACCOUNT_DELETE_CONFIRM_TEXT}
          </label>
          <input
            id="account-delete-confirm"
            className={styles.accountModalInput}
            type="text"
            value={accountDeleteConfirmInput}
            onChange={(event) => setAccountDeleteConfirmInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={isAccountActionPending}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAccountDelete();
              }
            }}
          />

          {accountDeleteModalFeedback ? (
            <p
              className={`${styles.accountModalFeedback}${
                accountDeleteModalFeedback.tone === "error"
                  ? ` ${styles.accountModalFeedbackError}`
                  : ` ${styles.accountModalFeedbackSuccess}`
              }`}
              role="status"
              aria-live="polite"
            >
              {accountDeleteModalFeedback.message}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(uploadLimitModal)}
        title="Arquivo acima do limite"
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
          O tamanho máximo para {uploadLimitModal?.kind === "avatar" ? "avatares" : "banners"} é{" "}
          {(uploadLimitModal?.maxMb ?? 0).toFixed(2)} MB.
        </p>
      </Modal>
    </>
  );
}


