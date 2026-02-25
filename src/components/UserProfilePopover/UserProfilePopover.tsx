import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import EmojiButton from "../chat/EmojiButton";
import { getNameAvatarUrl, isDefaultAvatarUrl, isDefaultBannerUrl } from "../../services/cdn/mediaUrls";
import type { PresenceState } from "../../services/presence/presenceTypes";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import messageIconSrc from "../../assets/images/msg.png";
import styles from "./UserProfilePopover.module.css";

interface UserProfilePopoverProps {
  avatarSrc: string;
  bannerSrc?: string;
  bannerColor?: string | null;
  themePrimaryColor?: string | null;
  themeAccentColor?: string | null;
  displayName: string;
  username: string;
  presenceLabel: string;
  presenceState: PresenceState;
  showActions?: boolean;
  viewMode?: "compact" | "full";
  showMessageComposer?: boolean;
  showEditProfileButton?: boolean;
  memberSinceLabel?: string;
  onCloseFullProfile?: () => void;
  messageComposerInputRef?: RefObject<HTMLInputElement>;
  messageComposerValue?: string;
  onMessageComposerChange?: (nextValue: string) => void;
  onMessageComposerSubmit?: () => void;
  messageComposerEmojiButtonRef?: RefObject<HTMLButtonElement>;
  messageComposerEmojiDisabled?: boolean;
  isMessageComposerEmojiOpen?: boolean;
  onToggleMessageComposerEmoji?: () => void;
  aboutText?: string;
  onChangePresence?: (state: PresenceState) => void;
  onEditProfile?: () => void;
  showFriendActions?: boolean;
  onUnfriend?: () => void | Promise<void>;
  isUnfriending?: boolean;
  showFriendRequestPending?: boolean;
  showAddFriendAction?: boolean;
  onAddFriend?: () => void | Promise<void>;
  isAddingFriend?: boolean;
  showBlockAction?: boolean;
  onBlockUser?: () => void | Promise<void>;
  isBlockingUser?: boolean;
  onOpenFullProfile?: () => void;
}

const BADGE_BY_STATE: Record<PresenceState, string> = {
  online: styles.presenceOnline,
  idle: styles.presenceIdle,
  dnd: styles.presenceDnd,
  offline: styles.presenceOffline,
};

type FullProfileTab = "activity" | "mutualFriends";
type ParsedRgb = {
  red: number;
  green: number;
  blue: number;
};

function isInstantMediaSource(urlRaw: string | null | undefined): boolean {
  const url = String(urlRaw ?? "").trim();
  return !url || url.startsWith("data:") || url.startsWith("blob:");
}

function hexToRgbaCss(hexColor: string | null | undefined, alpha: number): string | null {
  const rgb = parseHexColor(hexColor);
  if (!rgb) {
    return null;
  }

  const safeAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${safeAlpha})`;
}

function parseHexColor(hexColor: string | null | undefined): ParsedRgb | null {
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

function getRelativeLuminance(hexColor: string | null | undefined): number | null {
  const rgb = parseHexColor(hexColor);
  if (!rgb) {
    return null;
  }

  const toLinear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  const red = toLinear(rgb.red);
  const green = toLinear(rgb.green);
  const blue = toLinear(rgb.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHexCss(rgb: ParsedRgb): string {
  const toHex = (value: number): string => clampByte(value).toString(16).padStart(2, "0");
  return `#${toHex(rgb.red)}${toHex(rgb.green)}${toHex(rgb.blue)}`;
}

function shadeHexColor(hexColor: string | null | undefined, multiplier: number): string | null {
  const rgb = parseHexColor(hexColor);
  if (!rgb) {
    return null;
  }
  const safeMultiplier = Math.max(0, multiplier);
  return rgbToHexCss({
    red: rgb.red * safeMultiplier,
    green: rgb.green * safeMultiplier,
    blue: rgb.blue * safeMultiplier,
  });
}

function mixHexColors(hexA: string | null | undefined, hexB: string | null | undefined, ratioB: number): string | null {
  const rgbA = parseHexColor(hexA);
  const rgbB = parseHexColor(hexB);
  if (!rgbA || !rgbB) {
    return rgbToHexCss(rgbA ?? rgbB ?? { red: 0, green: 0, blue: 0 });
  }

  const t = Math.min(1, Math.max(0, ratioB));
  const inv = 1 - t;
  return rgbToHexCss({
    red: rgbA.red * inv + rgbB.red * t,
    green: rgbA.green * inv + rgbB.green * t,
    blue: rgbA.blue * inv + rgbB.blue * t,
  });
}

export default function UserProfilePopover({
  avatarSrc,
  bannerSrc,
  bannerColor,
  themePrimaryColor,
  themeAccentColor,
  displayName,
  username,
  presenceLabel,
  presenceState,
  showActions = true,
  viewMode = "compact",
  showMessageComposer = false,
  showEditProfileButton = false,
  memberSinceLabel = "Data nao disponivel",
  onCloseFullProfile,
  messageComposerInputRef,
  messageComposerValue = "",
  onMessageComposerChange,
  onMessageComposerSubmit,
  messageComposerEmojiButtonRef,
  messageComposerEmojiDisabled = false,
  isMessageComposerEmojiOpen = false,
  onToggleMessageComposerEmoji,
  aboutText,
  onChangePresence,
  onEditProfile,
  showFriendActions = false,
  onUnfriend,
  isUnfriending = false,
  showFriendRequestPending = false,
  showAddFriendAction = false,
  onAddFriend,
  isAddingFriend = false,
  showBlockAction = false,
  onBlockUser,
  isBlockingUser = false,
  onOpenFullProfile,
}: UserProfilePopoverProps) {
  const closeTimerRef = useRef<number | null>(null);
  const aboutTextRef = useRef<HTMLParagraphElement | null>(null);
  const fullAboutTextRef = useRef<HTMLParagraphElement | null>(null);
  const friendMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [isPresenceMenuOpen, setIsPresenceMenuOpen] = useState(false);
  const [canShowFullBioHint, setCanShowFullBioHint] = useState(false);
  const [isFullBioExpanded, setIsFullBioExpanded] = useState(false);
  const [canToggleFullBio, setCanToggleFullBio] = useState(false);
  const [activeFullProfileTab, setActiveFullProfileTab] = useState<FullProfileTab>("activity");
  const [isFriendMenuOpen, setIsFriendMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isAvatarLoaded, setIsAvatarLoaded] = useState(() => isInstantMediaSource(avatarSrc));
  const [isBannerLoaded, setIsBannerLoaded] = useState(() => isInstantMediaSource(bannerSrc));
  const badgeClass = BADGE_BY_STATE[presenceState];
  const safeAboutText = aboutText?.trim() ?? "";
  const canOpenFullProfile = viewMode !== "full" && typeof onOpenFullProfile === "function";
  const safeMessageComposerValue = showMessageComposer ? messageComposerValue : "";
  const fallbackAvatarSrc = useMemo(
    () => getNameAvatarUrl(displayName.trim() || username.trim() || "U"),
    [displayName, username],
  );
  const safeAvatarSrc = useMemo(() => {
    const trimmed = avatarSrc.trim();
    const isAbsolute =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    return !trimmed || !isAbsolute || isDefaultAvatarUrl(trimmed) ? fallbackAvatarSrc : trimmed;
  }, [avatarSrc, fallbackAvatarSrc]);
  const safeBannerSrc = useMemo(() => {
    const trimmed = (bannerSrc ?? "").trim();
    const isAbsolute =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    return !trimmed || !isAbsolute || isDefaultBannerUrl(trimmed) ? "" : trimmed;
  }, [bannerSrc]);
  const safeBannerColor = useMemo(() => normalizeBannerColor(bannerColor), [bannerColor]);
  const safeThemePrimaryColor = useMemo(() => normalizeBannerColor(themePrimaryColor), [themePrimaryColor]);
  const safeThemeAccentColor = useMemo(() => normalizeBannerColor(themeAccentColor), [themeAccentColor]);
  const isLightThemePanel = useMemo(() => {
    const luminances = [getRelativeLuminance(safeThemePrimaryColor), getRelativeLuminance(safeThemeAccentColor)].filter(
      (value): value is number => value != null,
    );
    if (luminances.length === 0) {
      return false;
    }
    const average = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
    return average >= 0.72;
  }, [safeThemeAccentColor, safeThemePrimaryColor]);
  const isNearBlackThemePanel = useMemo(() => {
    const luminances = [getRelativeLuminance(safeThemePrimaryColor), getRelativeLuminance(safeThemeAccentColor)].filter(
      (value): value is number => value != null,
    );
    if (luminances.length === 0) {
      return false;
    }
    return Math.max(...luminances) <= 0.022;
  }, [safeThemeAccentColor, safeThemePrimaryColor]);
  const bannerInlineStyle = useMemo<CSSProperties | undefined>(() => {
    // When a custom banner image exists, do not apply the fallback stripe color.
    if (safeBannerSrc) {
      return undefined;
    }
    const themeBannerColor = safeThemePrimaryColor ?? safeThemeAccentColor;
    if (themeBannerColor) {
      return {
        background: themeBannerColor,
      };
    }
    if (!safeBannerColor) {
      return undefined;
    }
    return {
      background: safeBannerColor,
    };
  }, [safeBannerColor, safeBannerSrc, safeThemeAccentColor, safeThemePrimaryColor]);
  const compactPanelInlineStyle = useMemo<CSSProperties | undefined>(() => {
    if (!safeThemePrimaryColor && !safeThemeAccentColor) {
      return undefined;
    }

    const primaryBaseTheme = safeThemePrimaryColor ?? safeThemeAccentColor ?? "#ffffff";
    const accentBaseTheme = safeThemeAccentColor ?? safeThemePrimaryColor ?? "#ffffff";

    const primarySurfaceTint = isLightThemePanel
      ? hexToRgbaCss(safeThemePrimaryColor, 0.98) ?? "rgba(255, 255, 255, 0.98)"
      : hexToRgbaCss(safeThemePrimaryColor, 0.22) ?? "rgba(93, 76, 244, 0.22)";
    const accentSurfaceTint = isLightThemePanel
      ? hexToRgbaCss(safeThemeAccentColor, 0.96) ?? "rgba(255, 255, 255, 0.96)"
      : hexToRgbaCss(safeThemeAccentColor, 0.16) ?? "rgba(139, 43, 226, 0.16)";
    const primaryGlow = isLightThemePanel
      ? hexToRgbaCss(safeThemePrimaryColor, 0.2) ?? "rgba(255, 255, 255, 0.2)"
      : hexToRgbaCss(safeThemePrimaryColor, 0.24) ?? "rgba(93, 76, 244, 0.24)";
    const accentGlow = isLightThemePanel
      ? hexToRgbaCss(safeThemeAccentColor, 0.14) ?? "rgba(255, 255, 255, 0.14)"
      : hexToRgbaCss(safeThemeAccentColor, 0.22) ?? "rgba(139, 43, 226, 0.22)";
    const borderTint = isLightThemePanel
      ? "rgba(15, 19, 28, 0.14)"
      : hexToRgbaCss(safeThemeAccentColor ?? safeThemePrimaryColor, 0.42) ?? "rgba(255, 255, 255, 0.16)";
    const baseSurface = isLightThemePanel ? "#ffffff" : "rgba(14, 15, 20, 0.92)";

    const style = {
      background: `linear-gradient(165deg, ${primarySurfaceTint} 0%, ${accentSurfaceTint} 58%, ${baseSurface} 100%), radial-gradient(120% 90% at 0% 0%, ${primaryGlow} 0%, rgba(0, 0, 0, 0) 56%), radial-gradient(90% 80% at 100% 0%, ${accentGlow} 0%, rgba(0, 0, 0, 0) 60%)`,
      borderColor: borderTint,
      boxShadow: "none",
    } as CSSProperties & Record<string, string>;

    if (isLightThemePanel) {
      style.background = `linear-gradient(180deg, ${primaryBaseTheme} 0%, ${primaryBaseTheme} 40%, ${accentBaseTheme} 40%, ${accentBaseTheme} 100%)`;
      style["--popover-bg"] = accentBaseTheme;
      style["--popover-surface"] = "rgba(12, 16, 24, 0.035)";
      style["--border-subtle"] = "rgba(15, 19, 28, 0.1)";
      style["--border-default"] = "rgba(15, 19, 28, 0.14)";
      style["--profile-card-text-primary"] = "#11151c";
      style["--profile-card-text-secondary"] = "rgba(17, 21, 28, 0.68)";
      style["--profile-card-text-body"] = "rgba(17, 21, 28, 0.86)";
      style["--profile-card-text-hint"] = "rgba(17, 21, 28, 0.8)";
      style["--profile-card-input-bg"] = "rgba(12, 16, 24, 0.03)";
      style["--profile-card-input-text"] = "rgba(17, 21, 28, 0.84)";
      style["--profile-card-input-placeholder"] = "rgba(17, 21, 28, 0.5)";
      style["--profile-card-input-icon"] = "rgba(17, 21, 28, 0.62)";
      style["--profile-card-actions-bg"] = "rgba(12, 16, 24, 0.03)";
      style["--profile-card-action-text"] = "rgba(17, 21, 28, 0.88)";
      style["--profile-card-action-icon"] = "rgba(17, 21, 28, 0.72)";
      style["--profile-card-action-hover"] = "rgba(12, 16, 24, 0.045)";
      style["--profile-card-action-active"] = "rgba(12, 16, 24, 0.06)";
      style["--profile-card-action-pressed"] = "rgba(12, 16, 24, 0.035)";
      style["--profile-card-presence-menu-bg"] = "#ffffff";
      style["--profile-card-presence-menu-shadow"] = "none";
      style["--profile-card-presence-menu-hover"] = "rgba(12, 16, 24, 0.045)";
      style["--profile-card-presence-menu-description"] = "rgba(17, 21, 28, 0.66)";
      style["--profile-card-primary-btn-bg"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-card-primary-btn-bg-hover"] = "rgba(17, 21, 28, 0.14)";
      style["--profile-card-primary-btn-fg"] = "#11151c";
      style["--profile-card-banner-separator"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-theme-banner-bg"] = primaryBaseTheme;
    } else {
      const primaryBase = safeThemePrimaryColor ?? "#000000";
      const accentBase = safeThemeAccentColor ?? safeThemePrimaryColor ?? "#8b2be2";
      const topSurface = primaryBase;
      const bodySurface = isNearBlackThemePanel
        ? "#101114"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.18), 0.36) ?? "#340000";
      const bodySurfaceDeep = isNearBlackThemePanel
        ? "#0c0d10"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.1), 0.28) ?? "#240000";
      const cardSurface = isNearBlackThemePanel
        ? "#1a1c21"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.24), 0.33) ?? "#2c0b0b";
      const cardSurfaceRaised = isNearBlackThemePanel
        ? "#20232a"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.22), 0.38) ?? "#350c0c";
      const borderStrong = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.1)"
        : hexToRgbaCss(accentBase, 0.95) ?? "rgba(255, 0, 0, 0.95)";
      const borderSoft = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.08)"
        : hexToRgbaCss(accentBase, 0.32) ?? "rgba(255, 0, 0, 0.32)";
      const borderSoftAlt = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.06)"
        : hexToRgbaCss(accentBase, 0.22) ?? "rgba(255, 0, 0, 0.22)";
      const accentGlow = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0)"
        : hexToRgbaCss(accentBase, 0.18) ?? "rgba(255, 0, 0, 0.18)";
      const primaryGlowDark = isNearBlackThemePanel ? "rgba(0, 0, 0, 0)" : hexToRgbaCss(primaryBase, 0.14) ?? "rgba(0, 0, 0, 0.14)";

      style.background = isNearBlackThemePanel
        ? `linear-gradient(180deg, ${topSurface} 0%, ${topSurface} 40%, #000000 40%, #000000 100%)`
        : `linear-gradient(180deg, ${topSurface} 0%, ${topSurface} 40%, ${bodySurface} 40%, ${bodySurfaceDeep} 100%), ` +
          `radial-gradient(120% 100% at 100% 100%, ${accentGlow} 0%, rgba(0, 0, 0, 0) 62%), ` +
          `radial-gradient(90% 90% at 0% 0%, ${primaryGlowDark} 0%, rgba(0, 0, 0, 0) 55%)`;
      style.borderColor = borderStrong;
      style.boxShadow = "none";
      style["--popover-bg"] = isNearBlackThemePanel ? "#000000" : bodySurface;
      style["--popover-surface"] = cardSurface;
      style["--border-subtle"] = borderSoft;
      style["--border-default"] = borderSoftAlt;
      style["--profile-card-actions-bg"] = cardSurface;
      style["--profile-card-input-bg"] = cardSurfaceRaised;
      style["--profile-card-input-text"] = "rgba(246, 248, 252, 0.9)";
      style["--profile-card-input-placeholder"] = "rgba(246, 248, 252, 0.56)";
      style["--profile-card-input-icon"] = "rgba(246, 248, 252, 0.68)";
      style["--profile-card-action-hover"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.04)" : "rgba(255, 255, 255, 0.05)";
      style["--profile-card-action-active"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.07)";
      style["--profile-card-action-pressed"] = "rgba(255, 255, 255, 0.035)";
      style["--profile-card-presence-menu-bg"] = cardSurfaceRaised;
      style["--profile-card-presence-menu-shadow"] = "none";
      style["--profile-card-presence-menu-hover"] = "rgba(255, 255, 255, 0.06)";
      style["--profile-card-presence-menu-description"] = "rgba(246, 248, 252, 0.72)";
      style["--profile-card-primary-btn-bg"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.12)" : "rgba(255, 255, 255, 0.16)";
      style["--profile-card-primary-btn-bg-hover"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.22)";
      style["--profile-card-primary-btn-fg"] = "#ffffff";
      style["--profile-theme-banner-bg"] = primaryBase;
      style["--profile-card-banner-separator"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.08)" : borderSoft;
    }

    return style;
  }, [isLightThemePanel, isNearBlackThemePanel, safeThemeAccentColor, safeThemePrimaryColor]);

  const fullPanelInlineStyle = useMemo<CSSProperties | undefined>(() => {
    if (!safeThemePrimaryColor && !safeThemeAccentColor) {
      return undefined;
    }

    const style = {} as CSSProperties & Record<string, string>;
    const primaryBaseTheme = safeThemePrimaryColor ?? safeThemeAccentColor ?? "#ffffff";
    const accentBaseTheme = safeThemeAccentColor ?? safeThemePrimaryColor ?? "#ffffff";
    const primarySoft = hexToRgbaCss(safeThemePrimaryColor, isLightThemePanel ? 0.12 : 0.16) ?? "rgba(93, 76, 244, 0.16)";
    const accentSoft = hexToRgbaCss(safeThemeAccentColor, isLightThemePanel ? 0.1 : 0.14) ?? "rgba(139, 43, 226, 0.14)";
    const primaryEdge = hexToRgbaCss(safeThemePrimaryColor, isLightThemePanel ? 0.22 : 0.2) ?? "rgba(93, 76, 244, 0.2)";
    const accentEdge = hexToRgbaCss(safeThemeAccentColor, isLightThemePanel ? 0.18 : 0.18) ?? "rgba(139, 43, 226, 0.18)";

    if (isLightThemePanel) {
      style["--profile-full-shell-bg"] = accentBaseTheme;
      style["--profile-full-sidebar-bg"] = accentBaseTheme;
      style["--profile-full-content-bg"] = accentBaseTheme;
      style["--profile-full-shell-border"] = "rgba(17, 21, 28, 0.12)";
      style["--profile-full-sidebar-border"] = "rgba(17, 21, 28, 0.1)";
      style["--profile-full-pane-divider"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-full-overlay-btn-bg"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-full-overlay-btn-bg-hover"] = "rgba(17, 21, 28, 0.14)";
      style["--profile-full-overlay-btn-fg"] = "rgba(17, 21, 28, 0.88)";
      style["--profile-full-status-bg"] = "rgba(255, 255, 255, 0.88)";
      style["--profile-full-status-border"] = "rgba(17, 21, 28, 0.1)";
      style["--profile-full-status-fg"] = "rgba(17, 21, 28, 0.72)";
      style["--profile-full-title"] = "#11151c";
      style["--profile-full-username"] = "rgba(17, 21, 28, 0.72)";
      style["--profile-full-text"] = "rgba(17, 21, 28, 0.88)";
      style["--profile-full-muted"] = "rgba(17, 21, 28, 0.66)";
      style["--profile-full-faint"] = "rgba(17, 21, 28, 0.56)";
      style["--profile-full-divider"] = "rgba(17, 21, 28, 0.1)";
      style["--profile-full-tab-text"] = "rgba(17, 21, 28, 0.62)";
      style["--profile-full-tab-active"] = "rgba(17, 21, 28, 0.94)";
      style["--profile-full-tab-active-border"] = "rgba(17, 21, 28, 0.88)";
      style["--profile-full-secondary-btn-bg"] = "rgba(17, 21, 28, 0.06)";
      style["--profile-full-secondary-btn-bg-hover"] = "rgba(17, 21, 28, 0.1)";
      style["--profile-full-secondary-btn-fg"] = "rgba(17, 21, 28, 0.84)";
      style["--profile-full-menu-bg"] = "#ffffff";
      style["--profile-full-menu-border"] = "rgba(17, 21, 28, 0.1)";
      style["--profile-full-menu-shadow"] = "0 10px 22px rgba(17, 21, 28, 0.08)";
      style["--profile-full-menu-item"] = "rgba(17, 21, 28, 0.9)";
      style["--profile-full-menu-item-hover"] = "rgba(17, 21, 28, 0.05)";
      style["--profile-full-activity-card-bg"] = "rgba(255, 255, 255, 0.74)";
      style["--profile-full-activity-card-border"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-full-activity-cover-bg"] = "rgba(17, 21, 28, 0.05)";
      style["--profile-full-activity-menu-fg"] = "rgba(17, 21, 28, 0.72)";
      style["--profile-full-activity-menu-hover"] = "rgba(17, 21, 28, 0.06)";
      style["--profile-full-connection-icon-bg"] = "rgba(17, 21, 28, 0.08)";
      style["--profile-full-connection-icon-fg"] = "#11151c";
      style["--profile-full-pending-clock-bg"] = "rgba(255, 255, 255, 0.95)";
      style["--profile-theme-banner-bg"] = primaryBaseTheme;
    } else {
      const primaryBase = safeThemePrimaryColor ?? "#000000";
      const accentBase = safeThemeAccentColor ?? safeThemePrimaryColor ?? "#8b2be2";
      const shellTop = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.12), 0.26) ?? "#250000";
      const shellBottom = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.08), 0.2) ?? "#1a0000";
      const sidebarTop = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.2), 0.34) ?? "#3b0000";
      const sidebarBottom = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.18), 0.28) ?? "#300000";
      const contentTop = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.12), 0.3) ?? "#340000";
      const contentBottom = isNearBlackThemePanel
        ? "#000000"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.12), 0.24) ?? "#2a0000";
      const activityCardTop = isNearBlackThemePanel
        ? "#181a1f"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.2), 0.35) ?? "#3c1111";
      const activityCardBottom = isNearBlackThemePanel
        ? "#14161b"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.14), 0.31) ?? "#340c0c";
      const menuBg = isNearBlackThemePanel
        ? "#181a1f"
        : shadeHexColor(mixHexColors(accentBase, primaryBase, 0.22), 0.33) ?? "#341010";
      const cardBorder = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.08)"
        : hexToRgbaCss(accentBase, 0.24) ?? "rgba(255, 0, 0, 0.24)";
      const shellBorder = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.08)"
        : hexToRgbaCss(accentBase, 0.36) ?? "rgba(255, 0, 0, 0.36)";
      const sidebarBorder = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.06)"
        : hexToRgbaCss(accentBase, 0.24) ?? "rgba(255, 0, 0, 0.24)";
      const paneDivider = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.05)"
        : hexToRgbaCss(accentBase, 0.16) ?? "rgba(255, 0, 0, 0.16)";
      const divider = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.1)"
        : hexToRgbaCss(accentBase, 0.18) ?? "rgba(255, 0, 0, 0.18)";
      const overlayBtnBg = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.06)"
        : hexToRgbaCss(accentBase, 0.12) ?? "rgba(255, 0, 0, 0.12)";
      const overlayBtnBgHover = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.1)"
        : hexToRgbaCss(accentBase, 0.18) ?? "rgba(255, 0, 0, 0.18)";
      const secondaryBtnBg = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.08)"
        : hexToRgbaCss(primaryBase, 0.34) ?? "rgba(0, 0, 0, 0.34)";
      const secondaryBtnBgHover = isNearBlackThemePanel
        ? "rgba(255, 255, 255, 0.12)"
        : hexToRgbaCss(accentBase, 0.18) ?? "rgba(255, 0, 0, 0.18)";
      const primaryBtnBg = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.22)";
      const primaryBtnBgHover = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.28)";
      const bannerBg = shadeHexColor(mixHexColors(primaryBase, accentBase, 0.06), 0.18) ?? "#080808";

      style["--profile-full-shell-bg"] =
        `linear-gradient(180deg, ${shellTop} 0%, ${shellBottom} 100%), ` +
        `radial-gradient(100% 100% at 0% 0%, ${hexToRgbaCss(primaryBase, 0.16) ?? primarySoft} 0%, rgba(0, 0, 0, 0) 64%), ` +
        `radial-gradient(80% 100% at 100% 0%, ${hexToRgbaCss(accentBase, 0.18) ?? accentSoft} 0%, rgba(0, 0, 0, 0) 66%)`;
      style["--profile-full-sidebar-bg"] =
        `linear-gradient(180deg, ${sidebarTop} 0%, ${sidebarBottom} 100%), ` +
        `radial-gradient(130% 120% at 0% 0%, ${hexToRgbaCss(primaryBase, 0.14) ?? primarySoft} 0%, rgba(0, 0, 0, 0) 70%)`;
      style["--profile-full-content-bg"] =
        `linear-gradient(180deg, ${contentTop} 0%, ${contentBottom} 100%), ` +
        `radial-gradient(120% 120% at 100% 0%, ${hexToRgbaCss(accentBase, 0.16) ?? accentSoft} 0%, rgba(0, 0, 0, 0) 72%)`;
      style["--profile-full-shell-border"] = shellBorder;
      style["--profile-full-sidebar-border"] = sidebarBorder;
      style["--profile-full-pane-divider"] = paneDivider;
      style["--profile-full-overlay-btn-bg"] = overlayBtnBg;
      style["--profile-full-overlay-btn-bg-hover"] = overlayBtnBgHover;
      style["--profile-full-overlay-btn-fg"] = "rgba(236, 240, 248, 0.94)";
      style["--profile-full-status-bg"] = isNearBlackThemePanel ? "rgba(26, 30, 37, 0.9)" : "rgba(25, 14, 14, 0.9)";
      if (isNearBlackThemePanel) {
        style["--profile-full-status-bg"] = "rgba(28, 31, 37, 0.9)";
      }
      style["--profile-full-status-border"] = cardBorder;
      style["--profile-full-status-fg"] = "rgba(216, 225, 238, 0.76)";
      style["--profile-full-title"] = "var(--text-primary)";
      style["--profile-full-username"] = "rgba(241, 246, 255, 0.97)";
      style["--profile-full-text"] = "rgba(243, 247, 255, 0.95)";
      style["--profile-full-muted"] = "rgba(215, 223, 237, 0.88)";
      style["--profile-full-faint"] = "rgba(214, 223, 236, 0.82)";
      style["--profile-full-divider"] = divider;
      style["--profile-full-tab-text"] = "rgba(206, 214, 228, 0.72)";
      style["--profile-full-tab-active"] = "rgba(244, 248, 255, 0.96)";
      style["--profile-full-tab-active-border"] = "rgba(255, 255, 255, 0.95)";
      style["--profile-full-secondary-btn-bg"] = secondaryBtnBg;
      style["--profile-full-secondary-btn-bg-hover"] = secondaryBtnBgHover;
      style["--profile-full-secondary-btn-fg"] = "rgba(240, 246, 255, 0.9)";
      style["--profile-full-menu-bg"] = menuBg;
      style["--profile-full-menu-border"] = cardBorder;
      style["--profile-full-menu-shadow"] = "none";
      style["--profile-full-menu-item"] = "#f3f6fc";
      style["--profile-full-menu-item-hover"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.08)";
      style["--profile-full-activity-card-bg"] = `linear-gradient(180deg, ${activityCardTop} 0%, ${activityCardBottom} 100%)`;
      style["--profile-full-activity-card-border"] = cardBorder;
      style["--profile-full-activity-cover-bg"] = shadeHexColor(primaryBase, 0.16) ?? "#06080d";
      style["--profile-full-activity-menu-fg"] = "rgba(218, 226, 239, 0.84)";
      style["--profile-full-activity-menu-hover"] = isNearBlackThemePanel ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.08)";
      style["--profile-full-connection-icon-bg"] = "rgba(255, 255, 255, 0.9)";
      style["--profile-full-connection-icon-fg"] = "#16181f";
      style["--profile-full-pending-clock-bg"] = "rgba(43, 45, 49, 0.95)";
      style["--profile-full-primary-btn-bg"] = primaryBtnBg;
      style["--profile-full-primary-btn-bg-hover"] = primaryBtnBgHover;
      style["--profile-full-primary-btn-fg"] = "#ffffff";
      style["--profile-theme-banner-bg"] = safeThemePrimaryColor ?? safeThemeAccentColor ?? bannerBg;
    }

    style["--profile-full-accent-edge"] = primaryEdge;
    style["--profile-full-accent-edge-2"] = accentEdge;
    return style;
  }, [isLightThemePanel, isNearBlackThemePanel, safeThemeAccentColor, safeThemePrimaryColor]);

  useEffect(() => {
    setIsAvatarLoaded(isInstantMediaSource(safeAvatarSrc));
  }, [safeAvatarSrc]);

  useEffect(() => {
    setIsBannerLoaded(isInstantMediaSource(safeBannerSrc));
  }, [safeBannerSrc]);

  const PRESENCE_OPTIONS: Array<{
    state: PresenceState;
    label: string;
    description?: string;
  }> = [
    {
      state: "online",
      label: "Disponivel",
    },
    {
      state: "idle",
      label: "Ausente",
    },
    {
      state: "dnd",
      label: "Nao perturbar",
      description: "Voce nao recebera notificacao na area de trabalho",
    },
    {
      state: "offline",
      label: "Offline",
      description: "Voce vai aparecer offline para outros usuarios",
    },
  ];

  const clearPresenceCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openPresenceMenu = (): void => {
    clearPresenceCloseTimer();
    setIsPresenceMenuOpen(true);
  };

  const schedulePresenceMenuClose = (): void => {
    clearPresenceCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setIsPresenceMenuOpen(false);
    }, 120);
  };

  const handlePresenceSelect = (state: PresenceState): void => {
    onChangePresence?.(state);
    setIsPresenceMenuOpen(false);
  };

  const handlePresenceBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
      schedulePresenceMenuClose();
    }
  };

  useEffect(() => {
    return () => {
      clearPresenceCloseTimer();
    };
  }, []);

  useEffect(() => {
    if (!safeAboutText) {
      setCanShowFullBioHint(false);
      return;
    }

    let frameId = 0;
    const checkAboutOverflow = (): void => {
      const element = aboutTextRef.current;
      if (!element) {
        setCanShowFullBioHint(false);
        return;
      }
      setCanShowFullBioHint(element.scrollHeight - element.clientHeight > 1);
    };

    frameId = window.requestAnimationFrame(checkAboutOverflow);
    window.addEventListener("resize", checkAboutOverflow);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", checkAboutOverflow);
    };
  }, [safeAboutText]);

  useEffect(() => {
    setIsFullBioExpanded(false);
  }, [safeAboutText, viewMode]);

  useEffect(() => {
    if (viewMode !== "full" || !safeAboutText) {
      setCanToggleFullBio(false);
      return;
    }

    let frameId = 0;
    const checkFullAboutOverflow = (): void => {
      const element = fullAboutTextRef.current;
      if (!element) {
        setCanToggleFullBio(false);
        return;
      }

      if (isFullBioExpanded) {
        setCanToggleFullBio(true);
        return;
      }

      setCanToggleFullBio(element.scrollHeight - element.clientHeight > 1);
    };

    frameId = window.requestAnimationFrame(checkFullAboutOverflow);
    window.addEventListener("resize", checkFullAboutOverflow);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", checkFullAboutOverflow);
    };
  }, [isFullBioExpanded, safeAboutText, viewMode]);

  useEffect(() => {
    if (viewMode === "full") {
      setActiveFullProfileTab("activity");
    }
  }, [username, viewMode]);

  useEffect(() => {
    if (!isFriendMenuOpen && !isMoreMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const isInsideFriendMenu = Boolean(friendMenuRef.current?.contains(target));
      const isInsideMoreMenu = Boolean(moreMenuRef.current?.contains(target));
      if (!isInsideFriendMenu && !isInsideMoreMenu) {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
      }
    };

    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isFriendMenuOpen, isMoreMenuOpen]);

  const handleMessageComposerChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onMessageComposerChange?.(event.target.value);
  };

  const handleMessageComposerKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    onMessageComposerSubmit?.();
  };

  const handleFullPrimaryAction = (): void => {
    if (showEditProfileButton) {
      onEditProfile?.();
      return;
    }
    onMessageComposerSubmit?.();
  };

  const handleUnfriendClick = (): void => {
    if (isUnfriending) {
      return;
    }
    setIsFriendMenuOpen(false);
    void onUnfriend?.();
  };

  const handleAddFriendClick = (): void => {
    if (isAddingFriend) {
      return;
    }
    setIsFriendMenuOpen(false);
    void onAddFriend?.();
  };

  const handleBlockUserClick = (): void => {
    if (isBlockingUser) {
      return;
    }
    setIsMoreMenuOpen(false);
    void onBlockUser?.();
  };

  const isFriendMenuMode = showFriendActions;
  const isFriendRequestPendingMode = !isFriendMenuMode && showFriendRequestPending;
  const isAddFriendMode = !isFriendMenuMode && !isFriendRequestPendingMode && showAddFriendAction;

  if (viewMode === "full") {
    return (
      <article
        className={`${styles.panel} ${styles.panelFull}`}
        style={fullPanelInlineStyle}
        role="dialog"
        aria-label="Perfil completo do usuario"
      >
        <div className={styles.fullLayout}>
          <section className={`${styles.fullSidebar}${showEditProfileButton ? ` ${styles.fullSidebarOwn}` : ""}`}>
            <header className={styles.fullHeader}>
              <div
                className={`${styles.fullBanner}${safeBannerSrc && !isBannerLoaded ? ` ${styles.fullBannerLoading}` : ""}${!safeBannerSrc ? ` ${styles.fullBannerNoImage}` : ""}`}
                style={bannerInlineStyle}
              >
                {safeBannerSrc ? (
                  <img
                    key={safeBannerSrc}
                    className={`${styles.fullBannerImage}${isBannerLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
                    src={safeBannerSrc}
                    alt=""
                    loading="eager"
                    decoding="async"
                    onLoad={() => {
                      setIsBannerLoaded(true);
                    }}
                    onError={(event) => {
                      setIsBannerLoaded(true);
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
              </div>

              <div className={`${styles.fullAvatarWrap}${!isAvatarLoaded ? ` ${styles.fullAvatarWrapLoading}` : ""}`}>
                <img
                  className={`${styles.fullAvatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
                  src={safeAvatarSrc}
                  alt={`Avatar de ${displayName}`}
                  loading="eager"
                  decoding="async"
                  onLoad={() => {
                    setIsAvatarLoaded(true);
                  }}
                  onError={(event) => {
                    const target = event.currentTarget;
                    if (target.src !== fallbackAvatarSrc) {
                      target.src = fallbackAvatarSrc;
                    }
                    setIsAvatarLoaded(true);
                  }}
                />
                <span className={`${styles.fullPresenceBadge} ${badgeClass}`} aria-hidden="true" />
              </div>
            </header>

            <div className={styles.fullSidebarBody}>
              <section className={styles.fullIdentity}>
                <h3 className={styles.fullDisplayName}>{displayName}</h3>
                <p className={styles.fullUsername}>{username}</p>
              </section>

              <div className={styles.fullPrimaryActions}>
                <button className={styles.fullPrimaryButton} type="button" onClick={handleFullPrimaryAction}>
                  {showEditProfileButton ? (
                    <MaterialSymbolIcon name="edit" size={16} filled={false} />
                  ) : (
                    <img className={styles.fullPrimaryButtonImageIcon} src={messageIconSrc} alt="" aria-hidden="true" />
                  )}
                  {showEditProfileButton ? "Editar perfil" : "Mensagem"}
                </button>

                <div className={styles.fullFriendMenuWrap} ref={friendMenuRef}>
                  <button
                    className={`${styles.fullSecondaryActionButton}${
                      isFriendRequestPendingMode ? ` ${styles.fullSecondaryActionButtonDisabled}` : ""
                    }`}
                    type="button"
                    aria-label={
                      isFriendRequestPendingMode
                        ? "Pedido enviado"
                        : isFriendMenuMode
                          ? "Amizade"
                          : isAddFriendMode
                            ? "Adicionar amigo"
                            : "Amizade"
                    }
                    title={isFriendRequestPendingMode ? "Pedido enviado" : undefined}
                    aria-haspopup={isFriendMenuMode ? "menu" : undefined}
                    aria-expanded={isFriendMenuMode ? isFriendMenuOpen : undefined}
                    aria-disabled={isFriendRequestPendingMode ? true : undefined}
                    disabled={isAddFriendMode ? isAddingFriend : false}
                    onClick={() => {
                      if (isFriendMenuMode) {
                        setIsMoreMenuOpen(false);
                        setIsFriendMenuOpen((current) => !current);
                        return;
                      }

                      if (isFriendRequestPendingMode) {
                        return;
                      }

                      if (isAddFriendMode) {
                        setIsMoreMenuOpen(false);
                        handleAddFriendClick();
                        return;
                      }

                      if (!isFriendMenuMode && !isAddFriendMode) {
                        return;
                      }
                    }}
                  >
                    {isFriendRequestPendingMode ? (
                      <span className={styles.fullSecondaryActionPendingIcon} aria-hidden="true">
                        <MaterialSymbolIcon
                          className={styles.fullSecondaryActionPendingPerson}
                          name="person"
                          size={16}
                          filled
                        />
                        <span className={styles.fullSecondaryActionPendingClock} />
                      </span>
                    ) : isAddFriendMode ? (
                      <MaterialSymbolIcon name="person_add" size={16} filled={false} />
                    ) : (
                      <MaterialSymbolIcon name="person" size={16} filled />
                    )}
                  </button>

                  {isFriendMenuMode && isFriendMenuOpen ? (
                    <div className={styles.fullFriendMenu} role="menu" aria-label="Acoes de amizade">
                      <button
                        className={styles.fullFriendMenuItem}
                        type="button"
                        role="menuitem"
                        onClick={handleUnfriendClick}
                        disabled={isUnfriending}
                      >
                        {isUnfriending ? "Desfazendo..." : "Desfazer amizade"}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className={styles.fullMoreMenuWrap} ref={moreMenuRef}>
                  <button
                    className={styles.fullSecondaryActionButton}
                    type="button"
                    aria-label="Mais opcoes"
                    aria-haspopup={showBlockAction ? "menu" : undefined}
                    aria-expanded={showBlockAction ? isMoreMenuOpen : undefined}
                    onClick={() => {
                      if (!showBlockAction) {
                        return;
                      }
                      setIsFriendMenuOpen(false);
                      setIsMoreMenuOpen((current) => !current);
                    }}
                  >
                    <MaterialSymbolIcon name="more_horiz" size={16} filled={false} />
                  </button>

                  {showBlockAction && isMoreMenuOpen ? (
                    <div className={styles.fullMoreMenu} role="menu" aria-label="Mais acoes">
                      <button
                        className={`${styles.fullMoreMenuItem} ${styles.fullMoreMenuItemDanger}`}
                        type="button"
                        role="menuitem"
                        onClick={handleBlockUserClick}
                        disabled={isBlockingUser}
                      >
                        {isBlockingUser ? "Bloqueando..." : "Bloquear usuario"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <section className={styles.fullDetails}>
                {safeAboutText ? (
                  <div className={styles.fullDetailSection}>
                    <p
                      ref={fullAboutTextRef}
                      className={`${styles.fullBioPlain}${isFullBioExpanded ? ` ${styles.fullBioExpanded}` : ""}`}
                    >
                      {safeAboutText}
                    </p>
                    {canToggleFullBio ? (
                      <button
                        className={styles.fullBioToggle}
                        type="button"
                        onClick={() => setIsFullBioExpanded((current) => !current)}
                      >
                        {isFullBioExpanded ? "Ver menos" : "Ver mais"}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className={styles.fullDetailSection}>
                  <p className={styles.fullDetailTitle}>Membro desde</p>
                  <p className={styles.fullDetailValue}>{memberSinceLabel}</p>
                </div>
              </section>
            </div>
          </section>

          <section className={styles.fullContent}>
            <nav className={styles.fullTabs} aria-label="Abas do perfil" role="tablist">
              <button
                className={`${styles.fullTabButton}${activeFullProfileTab === "activity" ? ` ${styles.fullTabButtonActive}` : ""}`}
                type="button"
                role="tab"
                aria-selected={activeFullProfileTab === "activity"}
                onClick={() => setActiveFullProfileTab("activity")}
              >
                Atividade
              </button>
              <button
                className={`${styles.fullTabButton}${activeFullProfileTab === "mutualFriends" ? ` ${styles.fullTabButtonActive}` : ""}`}
                type="button"
                role="tab"
                aria-selected={activeFullProfileTab === "mutualFriends"}
                onClick={() => setActiveFullProfileTab("mutualFriends")}
              >
                Amigos em comum
              </button>
            </nav>

            <div className={styles.fullContentBody}>
              {activeFullProfileTab === "activity" ? (
                <section className={styles.fullActivitySection}>
                  <h4 className={styles.fullActivityTitle}>Atividade recente</h4>
                </section>
              ) : (
                <section className={styles.fullPlaceholderSection}>
                  <h4 className={styles.fullPlaceholderTitle}>Amigos em comum</h4>
                  <p className={styles.fullPlaceholderText}>
                    Voce e {displayName} ainda nao tem amigos em comum. Quando houver conexoes em comum, elas aparecerao aqui.
                  </p>
                </section>
              )}
            </div>
          </section>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`${styles.panel}${!showActions ? ` ${styles.panelNoActions}` : ""}`}
      style={compactPanelInlineStyle}
      role="dialog"
      aria-label="Perfil do usuario"
    >
      <header className={styles.header}>
        <div
          className={`${styles.banner}${safeBannerSrc && !isBannerLoaded ? ` ${styles.bannerLoading}` : ""}${!safeBannerSrc ? ` ${styles.bannerNoImage}` : ""}`}
          style={bannerInlineStyle}
        >
          {safeBannerSrc ? (
            <img
              key={safeBannerSrc}
              className={`${styles.bannerImage}${isBannerLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeBannerSrc}
              alt=""
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsBannerLoaded(true);
              }}
              onError={(event) => {
                setIsBannerLoaded(true);
                event.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </div>
        {canOpenFullProfile ? (
          <button
            className={`${styles.avatarWrap} ${styles.avatarWrapButton}${!isAvatarLoaded ? ` ${styles.avatarWrapLoading}` : ""}`}
            type="button"
            onClick={onOpenFullProfile}
            aria-label={`Abrir perfil completo de ${displayName}`}
          >
            <img
              className={`${styles.avatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeAvatarSrc}
              alt={`Avatar de ${displayName}`}
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsAvatarLoaded(true);
              }}
              onError={(event) => {
                const target = event.currentTarget;
                if (target.src !== fallbackAvatarSrc) {
                  target.src = fallbackAvatarSrc;
                }
                setIsAvatarLoaded(true);
              }}
            />
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </button>
        ) : (
          <div className={`${styles.avatarWrap}${!isAvatarLoaded ? ` ${styles.avatarWrapLoading}` : ""}`}>
            <img
              className={`${styles.avatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeAvatarSrc}
              alt={`Avatar de ${displayName}`}
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsAvatarLoaded(true);
              }}
              onError={(event) => {
                const target = event.currentTarget;
                if (target.src !== fallbackAvatarSrc) {
                  target.src = fallbackAvatarSrc;
                }
                setIsAvatarLoaded(true);
              }}
            />
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </div>
        )}
      </header>

      <section className={styles.body}>
        <div className={styles.identity}>
          {canOpenFullProfile ? (
            <h3 className={styles.displayNameHeading}>
              <button
                className={`${styles.displayName} ${styles.displayNameButton}`}
                type="button"
                onClick={onOpenFullProfile}
                aria-label={`Abrir perfil completo de ${displayName}`}
              >
                {displayName}
              </button>
            </h3>
          ) : (
            <h3 className={styles.displayName}>{displayName}</h3>
          )}
          <p className={styles.username}>@{username}</p>
          {safeAboutText ? (
            <div className={styles.aboutWrap}>
              <p ref={aboutTextRef} className={styles.about}>
                {safeAboutText}
              </p>
              {canShowFullBioHint ? (
                canOpenFullProfile ? (
                  <button
                    className={`${styles.aboutHint} ${styles.aboutHintButton}`}
                    type="button"
                    onClick={onOpenFullProfile}
                  >
                    Ver Biografia Completa
                  </button>
                ) : (
                  <span className={styles.aboutHint}>Ver Biografia Completa</span>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {showMessageComposer ? (
        <div className={styles.messageComposer}>
          <input
            ref={messageComposerInputRef}
            className={styles.messageComposerInput}
            type="text"
            value={safeMessageComposerValue}
            onChange={handleMessageComposerChange}
            onKeyDown={handleMessageComposerKeyDown}
            placeholder={`Conversar com @${username}`}
            autoComplete="off"
            aria-label={`Conversar com @${username}`}
          />
          {messageComposerEmojiButtonRef && onToggleMessageComposerEmoji ? (
            <EmojiButton
              buttonRef={messageComposerEmojiButtonRef}
              isOpen={isMessageComposerEmojiOpen}
              disabled={messageComposerEmojiDisabled}
              onToggle={onToggleMessageComposerEmoji}
            />
          ) : (
            <button className={styles.messageComposerIconButton} type="button" aria-label="Abrir emojis" disabled>
              <MaterialSymbolIcon name="sentiment_satisfied" size={18} filled={false} />
            </button>
          )}
        </div>
      ) : showEditProfileButton ? (
        <div className={styles.messageComposerEditWrap}>
          <button className={styles.messageComposerEditButton} type="button" onClick={onEditProfile}>
            <span className={styles.messageComposerEditButtonContent}>
              <MaterialSymbolIcon name="edit" size={16} filled={false} />
              Editar perfil
            </span>
          </button>
        </div>
      ) : null}

      {showActions ? (
        <div className={styles.actions}>
          <button className={styles.actionButton} type="button" onClick={onEditProfile}>
            <span className={styles.actionLeft}>
              <MaterialSymbolIcon name="edit" size={18} filled={false} />
              Editar perfil
            </span>
          </button>

          <div
            className={styles.presenceActionWrap}
            onMouseEnter={openPresenceMenu}
            onMouseLeave={schedulePresenceMenuClose}
            onFocusCapture={openPresenceMenu}
            onBlurCapture={handlePresenceBlur}
          >
            <button
              className={`${styles.actionButton}${isPresenceMenuOpen ? ` ${styles.actionButtonActive}` : ""}`}
              type="button"
              onClick={() => setIsPresenceMenuOpen((current) => !current)}
              aria-expanded={isPresenceMenuOpen}
              aria-haspopup="menu"
            >
              <span className={styles.actionLeft}>
                <span className={`${styles.presenceMenuDot} ${badgeClass}`} aria-hidden="true" />
                {presenceLabel}
              </span>
            </button>

            {isPresenceMenuOpen ? (
              <div className={styles.presenceMenu} role="menu" aria-label="Selecionar presenca">
                {PRESENCE_OPTIONS.map((option) => {
                  const optionBadgeClass = BADGE_BY_STATE[option.state];
                  const isActive = option.state === presenceState;
                  const dotOffsetClass = option.description ? styles.presenceMenuDotLower : "";

                  return (
                    <button
                      key={option.state}
                      className={`${styles.presenceMenuItem}${isActive ? ` ${styles.presenceMenuItemActive}` : ""}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => handlePresenceSelect(option.state)}
                    >
                      <span className={styles.presenceMenuMain}>
                        <span className={`${styles.presenceMenuDot} ${optionBadgeClass} ${dotOffsetClass}`} aria-hidden="true" />
                        <span className={styles.presenceMenuText}>
                          <span className={styles.presenceMenuLabel}>{option.label}</span>
                          {option.description ? (
                            <span className={styles.presenceMenuDescription}>{option.description}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <button className={styles.actionButton} type="button">
            <span className={styles.actionLeft}>
              <MaterialSymbolIcon name="supervisor_account" size={18} filled={false} />
              Mudar de conta
            </span>
          </button>
        </div>
      ) : null}
    </article>
  );
}
