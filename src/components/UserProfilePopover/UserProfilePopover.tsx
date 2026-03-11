import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import BannerImage from "../ui/BannerImage";
import SpotifyIcon from "../ui/SpotifyIcon";
import ProfileSpotifyActivityCard from "../profile/ProfileSpotifyActivityCard";
import EmojiButton from "../chat/EmojiButton";
import { getNameAvatarUrl, isDefaultAvatarUrl, isDefaultBannerUrl } from "../../services/cdn/mediaUrls";
import { useAuthSession } from "../../auth/AuthProvider";
import type { PresenceSpotifyActivity, PresenceState } from "../../services/presence/presenceTypes";
import {
  formatSpotifyPlaybackTime,
  isSpotifyPlaybackStillActive,
  resolveSpotifyPlaybackProgressSeconds,
  type SpotifyConnectionState,
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
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import {
  createProfileTheme,
  type ProfileThemeInlineStyle,
} from "../../services/profile/profileTheme";
import spotifyLogoSrc from "../../assets/icons/ui/spotify.svg";
import messageIconSrc from "../../assets/icons/ui/Chat.svg";
import AccountCenterModal from "../account/AccountCenterModal";
import styles from "./UserProfilePopover.module.css";

interface UserProfilePopoverProps {
  avatarSrc: string;
  bannerSrc?: string;
  bannerColor?: string | null;
  themePrimaryColor?: string | null;
  themeAccentColor?: string | null;
  displayName: string;
  username: string;
  profileUserId?: string | null;
  presenceLabel: string;
  presenceState: PresenceState;
  showActions?: boolean;
  showBannerEditOverlay?: boolean;
  bannerEditOverlayLabel?: string;
  showAvatarEditOverlay?: boolean;
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
  compactAvatarRingMode?: "default" | "none" | "thin";
  spotifyConnection?: SpotifyConnectionState | null;
  spotifyActivity?: PresenceSpotifyActivity | null;
  mutualFriends?: UserProfileMutualFriendItem[];
  onOpenSettings?: (section?: "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows") => void;
}

export interface UserProfileMutualFriendItem {
  userId: string;
  displayName: string;
  username: string;
  avatarSrc: string;
}

const BADGE_BY_STATE: Record<PresenceState, string> = {
  online: styles.presenceOnline,
  idle: styles.presenceIdle,
  dnd: styles.presenceDnd,
  invisivel: styles.presenceInvisivel,
};

type FullProfileTab = "activity" | "mutualFriends";
type AccountCenterMode = "overview" | "attach" | "swap";
type ProfilePopoverInlineStyle = ProfileThemeInlineStyle;

function isInstantMediaSource(urlRaw: string | null | undefined): boolean {
  const url = String(urlRaw ?? "").trim();
  return !url || url.startsWith("data:") || url.startsWith("blob:");
}

function getCompactAvatarRingSize(mode: "default" | "none" | "thin"): string {
  if (mode === "none") {
    return "0px";
  }
  if (mode === "thin") {
    return "2px";
  }
  return "4px";
}

function getCompactPresenceRingSize(mode: "default" | "none" | "thin"): string {
  if (mode === "none") {
    return "2px";
  }
  if (mode === "thin") {
    return "2px";
  }
  return "3px";
}

function buildSpotifyConnectionFromActivity(
  activity: PresenceSpotifyActivity | null | undefined,
): SpotifyConnectionState | null {
  if (!activity) {
    return null;
  }

  const updatedAtIso = new Date(activity.updatedAt ?? Date.now()).toISOString();
  return {
    v: 1,
    provider: "spotify",
    authState: "detached",
    connected: true,
    accountName: "Spotify",
    accountId: "",
    accountUrl: "",
    accountProduct: "",
    showOnProfile: activity.showOnProfile !== false,
    showAsStatus: true,
    playback: {
      trackTitle: activity.trackTitle,
      artistNames: activity.artistNames,
      coverUrl: activity.coverUrl,
      trackUrl: activity.trackUrl,
      trackId: activity.trackId,
      progressSeconds: activity.progressSeconds,
      durationSeconds: activity.durationSeconds,
      ...(typeof activity.isPlaying === "boolean" ? { isPlaying: activity.isPlaying } : {}),
      updatedAt: updatedAtIso,
    },
    token: null,
    updatedAt: updatedAtIso,
  };
}

export default function UserProfilePopover({
  avatarSrc,
  bannerSrc,
  bannerColor,
  themePrimaryColor,
  themeAccentColor,
  displayName,
  username,
  profileUserId = null,
  presenceLabel,
  presenceState,
  showActions = true,
  showBannerEditOverlay = false,
  bannerEditOverlayLabel = "Mudar banner",
  showAvatarEditOverlay = false,
  viewMode = "compact",
  showMessageComposer = false,
  showEditProfileButton = false,
  memberSinceLabel = "",
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
  compactAvatarRingMode = "default",
  spotifyConnection = null,
  spotifyActivity = null,
  mutualFriends = [],
  onOpenSettings,
}: UserProfilePopoverProps) {
  const effectiveSpotifyConnection = useMemo(
    () => spotifyConnection ?? buildSpotifyConnectionFromActivity(spotifyActivity),
    [spotifyActivity, spotifyConnection],
  );
  const closeTimerRef = useRef<number | null>(null);
  const accountCloseTimerRef = useRef<number | null>(null);
  const aboutTextRef = useRef<HTMLParagraphElement | null>(null);
  const fullSidebarBodyRef = useRef<HTMLDivElement | null>(null);
  const fullSidebarScrollbarRef = useRef<HTMLDivElement | null>(null);
  const fullSidebarScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const fullSidebarHasOverflowRef = useRef(false);
  const isFullSidebarScrollbarDraggingRef = useRef(false);
  const fullSidebarDragStartYRef = useRef(0);
  const fullSidebarDragStartScrollTopRef = useRef(0);
  const friendMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [isPresenceMenuOpen, setIsPresenceMenuOpen] = useState(false);
  const [canShowFullBioHint, setCanShowFullBioHint] = useState(false);
  const [activeFullProfileTab, setActiveFullProfileTab] = useState<FullProfileTab>("activity");
  const [isFriendMenuOpen, setIsFriendMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isAccountQuickMenuOpen, setIsAccountQuickMenuOpen] = useState(false);
  const [isAccountCenterOpen, setIsAccountCenterOpen] = useState(false);
  const [showFullSidebarCustomScrollbar, setShowFullSidebarCustomScrollbar] = useState(false);
  const [accountCenterMode, setAccountCenterMode] = useState<AccountCenterMode>("overview");
  const [accountCenterTargetUid, setAccountCenterTargetUid] = useState<string | null>(null);
  const [listenAlongSession, setListenAlongSession] = useState<SpotifyListenAlongSession>(() =>
    createDefaultSpotifyListenAlongSession("", ""),
  );
  const [isAvatarLoaded, setIsAvatarLoaded] = useState(() => isInstantMediaSource(avatarSrc));
  const [isBannerLoaded, setIsBannerLoaded] = useState(() => isInstantMediaSource(bannerSrc));
  const { user: authUser, knownAccounts } = useAuthSession();
  const uniqueKnownAccounts = useMemo(() => {
    const normalizedSortedAccounts = [...knownAccounts].sort((accountA, accountB) => {
      if (accountA.isActive !== accountB.isActive) {
        return accountA.isActive ? -1 : 1;
      }
      return accountB.lastUsedAt - accountA.lastUsedAt;
    });

    const seenUids = new Set<string>();
    const seenEmails = new Set<string>();
    const uniqueAccounts: typeof knownAccounts = [];

    for (const account of normalizedSortedAccounts) {
      const uid = String(account.uid ?? "").trim();
      const email = String(account.email ?? "").trim().toLowerCase();
      if (!uid || !email) {
        continue;
      }

      if (seenUids.has(uid) || seenEmails.has(email)) {
        continue;
      }

      seenUids.add(uid);
      seenEmails.add(email);
      uniqueAccounts.push(account);
    }

    return uniqueAccounts;
  }, [knownAccounts]);
  const badgeClass = BADGE_BY_STATE[presenceState];
  const safeAboutText = aboutText?.trim() ?? "";
  const safeMemberSinceLabel = memberSinceLabel?.trim() ?? "";
  const hasActiveSpotifyPlayback = useMemo(
    () => isSpotifyPlaybackStillActive(effectiveSpotifyConnection?.playback ?? null, effectiveSpotifyConnection?.updatedAt),
    [effectiveSpotifyConnection?.playback, effectiveSpotifyConnection?.updatedAt],
  );
  const shouldShowSpotifyConnectionSection = Boolean(
    effectiveSpotifyConnection?.connected && effectiveSpotifyConnection.showOnProfile,
  );
  const shouldShowSpotifyPlayback = Boolean(
    shouldShowSpotifyConnectionSection && hasActiveSpotifyPlayback,
  );
  const spotifyPlayback = shouldShowSpotifyPlayback ? effectiveSpotifyConnection?.playback ?? null : null;
  const [spotifyClockMs, setSpotifyClockMs] = useState(() => Date.now());
  const spotifyAccountName = shouldShowSpotifyConnectionSection
    ? String(effectiveSpotifyConnection?.accountName ?? "").trim() || "Spotify"
    : "Spotify";
  const spotifyAccountUrl = useMemo(() => {
    if (!shouldShowSpotifyConnectionSection) {
      return "";
    }

    const directUrl = String(effectiveSpotifyConnection?.accountUrl ?? "").trim();
    if (/^https?:\/\//i.test(directUrl)) {
      return directUrl;
    }

    const accountId = String(effectiveSpotifyConnection?.accountId ?? "").trim();
    if (!accountId) {
      return "";
    }

    return `https://open.spotify.com/user/${encodeURIComponent(accountId)}`;
  }, [effectiveSpotifyConnection?.accountId, effectiveSpotifyConnection?.accountUrl, shouldShowSpotifyConnectionSection]);
  useEffect(() => {
    if (!spotifyPlayback) {
      return;
    }

    setSpotifyClockMs(Date.now());
    const intervalId = window.setInterval(() => {
      setSpotifyClockMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    effectiveSpotifyConnection?.updatedAt,
    spotifyPlayback?.durationSeconds,
    spotifyPlayback?.progressSeconds,
    spotifyPlayback?.trackId,
  ]);
  const spotifyLiveProgressSeconds = useMemo(
    () => resolveSpotifyPlaybackProgressSeconds(spotifyPlayback, effectiveSpotifyConnection?.updatedAt, spotifyClockMs),
    [effectiveSpotifyConnection?.updatedAt, spotifyClockMs, spotifyPlayback],
  );
  const spotifyProgressRatio = useMemo(() => {
    if (!spotifyPlayback || spotifyPlayback.durationSeconds <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (spotifyLiveProgressSeconds / spotifyPlayback.durationSeconds) * 100));
  }, [spotifyLiveProgressSeconds, spotifyPlayback]);
  const spotifyElapsedLabel = useMemo(
    () => (spotifyPlayback ? formatSpotifyPlaybackTime(spotifyLiveProgressSeconds) : ""),
    [spotifyLiveProgressSeconds, spotifyPlayback],
  );
  const spotifyDurationLabel = useMemo(
    () => (spotifyPlayback ? formatSpotifyPlaybackTime(spotifyPlayback.durationSeconds) : ""),
    [spotifyPlayback],
  );
  const normalizedProfileUserId = useMemo(() => String(profileUserId ?? "").trim(), [profileUserId]);
  const normalizedAuthUserId = useMemo(() => String(authUser?.uid ?? "").trim(), [authUser?.uid]);
  const canListenAlong = Boolean(
    spotifyPlayback &&
      normalizedProfileUserId &&
      normalizedAuthUserId &&
      normalizedProfileUserId !== normalizedAuthUserId,
  );
  const shouldShowActivityActionButtons = Boolean(
    spotifyPlayback &&
      normalizedProfileUserId &&
      normalizedAuthUserId &&
      normalizedProfileUserId !== normalizedAuthUserId &&
      !showEditProfileButton,
  );
  const activeKnownAccount = useMemo(
    () => uniqueKnownAccounts.find((entry) => entry.isActive) ?? null,
    [uniqueKnownAccounts],
  );
  const currentUserDisplayName = useMemo(
    () =>
      String(activeKnownAccount?.alias ?? "").trim() ||
      String(authUser?.displayName ?? "").trim() ||
      "Voce",
    [activeKnownAccount?.alias, authUser?.displayName],
  );
  const currentUserAvatarSrc = useMemo(() => {
    const candidate = String(activeKnownAccount?.avatarSrc ?? authUser?.photoURL ?? "").trim();
    if (
      candidate &&
      (candidate.startsWith("http://") ||
        candidate.startsWith("https://") ||
        candidate.startsWith("data:") ||
        candidate.startsWith("blob:"))
    ) {
      return candidate;
    }
    return getNameAvatarUrl(currentUserDisplayName || "V");
  }, [activeKnownAccount?.avatarSrc, authUser?.photoURL, currentUserDisplayName]);
  const listenAlongTrackKey = useMemo(
    () => String(spotifyPlayback?.trackId ?? "").trim() || `${spotifyPlayback?.trackTitle ?? ""}:${spotifyPlayback?.artistNames ?? ""}`,
    [spotifyPlayback?.artistNames, spotifyPlayback?.trackId, spotifyPlayback?.trackTitle],
  );
  const isListenAlongActive = Boolean(
    canListenAlong &&
      listenAlongSession.active &&
      listenAlongSession.listenerUserId === normalizedAuthUserId &&
      listenAlongSession.hostUserId === normalizedProfileUserId &&
      listenAlongSession.trackId === listenAlongTrackKey,
  );
  const handleToggleListenAlong = (): void => {
    if (!spotifyPlayback || !canListenAlong) {
      return;
    }

    if (isListenAlongActive) {
      void leaveSpotifyListenAlongSession(normalizedAuthUserId, normalizedProfileUserId, {
        reason: "listener_left",
      }).then((nextSession) => {
        setListenAlongSession(nextSession);
      });
      return;
    }

    void joinSpotifyListenAlongSession({
      listenerUserId: normalizedAuthUserId,
      hostUserId: normalizedProfileUserId,
      listenerDisplayName: currentUserDisplayName,
      listenerAvatarSrc: currentUserAvatarSrc,
      hostDisplayName: displayName,
      hostAvatarSrc: safeAvatarSrc,
      trackId: listenAlongTrackKey,
      trackTitle: spotifyPlayback.trackTitle,
      trackUrl: spotifyPlayback.trackUrl,
    }).then((result) => {
      if (!result.ok) {
        if (result.reason === "spotify_not_connected" && onOpenSettings) {
          onOpenSettings("connections");
          return;
        }
        window.alert(resolveSpotifyListenAlongFailureMessage(result.reason));
        return;
      }
      setListenAlongSession(result.session);
    });
  };
  const handleOpenSpotifyTrack = (): void => {
    const trackUrl = String(spotifyPlayback?.trackUrl ?? "").trim();
    const accountUrl = String(spotifyAccountUrl ?? "").trim();
    const externalUrl = trackUrl || accountUrl;
    if (!externalUrl) {
      return;
    }
    const openExternalUrl = window.electronAPI?.openExternalUrl;
    if (openExternalUrl) {
      void openExternalUrl({ url: externalUrl });
      return;
    }
    window.open(externalUrl, "_blank", "noopener,noreferrer");
  };
  const handleOpenSpotifyProfile = (): void => {
    if (!spotifyAccountUrl) {
      return;
    }

    const openExternalUrl = window.electronAPI?.openExternalUrl;
    if (openExternalUrl) {
      void openExternalUrl({ url: spotifyAccountUrl });
      return;
    }

    window.open(spotifyAccountUrl, "_blank", "noopener,noreferrer");
  };
  useEffect(() => {
    if (!normalizedAuthUserId || !normalizedProfileUserId || normalizedAuthUserId === normalizedProfileUserId) {
      setListenAlongSession(createDefaultSpotifyListenAlongSession(normalizedAuthUserId, normalizedProfileUserId));
      return;
    }

    setListenAlongSession(readSpotifyListenAlongSession(normalizedAuthUserId, normalizedProfileUserId));
    return subscribeSpotifyListenAlongSession(normalizedAuthUserId, normalizedProfileUserId, setListenAlongSession);
  }, [normalizedAuthUserId, normalizedProfileUserId]);
  useEffect(() => {
    if (
      !listenAlongSession.active ||
      !normalizedAuthUserId ||
      !normalizedProfileUserId ||
      listenAlongSession.listenerUserId !== normalizedAuthUserId ||
      listenAlongSession.hostUserId !== normalizedProfileUserId
    ) {
      return;
    }

    if (spotifyPlayback) {
      return;
    }

    void leaveSpotifyListenAlongSession(normalizedAuthUserId, normalizedProfileUserId, {
      reason: "host_stopped",
    }).then((nextSession) => {
      setListenAlongSession(nextSession);
    });
  }, [
    listenAlongSession,
    normalizedAuthUserId,
    normalizedProfileUserId,
    spotifyPlayback,
  ]);
  const canOpenFullProfile = viewMode !== "full" && typeof onOpenFullProfile === "function";
  const safeMessageComposerValue = showMessageComposer ? messageComposerValue : "";
  const activeAccountUid = authUser?.uid ?? null;
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
  const profileTheme = useMemo(
    () =>
      createProfileTheme({
        primaryColor: themePrimaryColor ?? safeBannerColor ?? "",
        accentColor: themeAccentColor ?? themePrimaryColor ?? safeBannerColor ?? "",
        mode: "dark",
      }),
    [safeBannerColor, themeAccentColor, themePrimaryColor],
  );
  const panelInlineStyle = useMemo<ProfilePopoverInlineStyle>(
    () => profileTheme.style,
    [profileTheme.style],
  );
  const bannerInlineStyle = undefined;
  const compactPanelInlineStyle = panelInlineStyle;
  const fullPanelInlineStyle = panelInlineStyle;
  const shouldShowNoImageBannerSeparator = useMemo(() => !safeBannerSrc, [safeBannerSrc]);

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
      label: "Disponível",
    },
    {
      state: "idle",
      label: "Ausente",
    },
    {
      state: "dnd",
      label: "Não perturbar",
      description: "Você não receberá notificações na área de trabalho",
    },
    {
      state: "invisivel",
      label: "Invisível",
      description: "Você aparecerá invisível para outros usuários",
    },
  ];

  const clearPresenceCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const clearAccountCloseTimer = (): void => {
    if (accountCloseTimerRef.current !== null) {
      window.clearTimeout(accountCloseTimerRef.current);
      accountCloseTimerRef.current = null;
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

  const openAccountQuickMenu = (): void => {
    clearAccountCloseTimer();
    setIsFriendMenuOpen(false);
    setIsMoreMenuOpen(false);
    setIsAccountQuickMenuOpen(true);
  };

  const scheduleAccountQuickMenuClose = (): void => {
    clearAccountCloseTimer();
    accountCloseTimerRef.current = window.setTimeout(() => {
      accountCloseTimerRef.current = null;
      setIsAccountQuickMenuOpen(false);
    }, 120);
  };

  const handleAccountMenuBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
      scheduleAccountQuickMenuClose();
    }
  };

  useEffect(() => {
    return () => {
      clearPresenceCloseTimer();
      clearAccountCloseTimer();
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
    if (viewMode !== "full") {
      fullSidebarHasOverflowRef.current = false;
      setShowFullSidebarCustomScrollbar(false);
      return;
    }

    const sidebarBody = fullSidebarBodyRef.current;
    if (!sidebarBody) {
      fullSidebarHasOverflowRef.current = false;
      setShowFullSidebarCustomScrollbar(false);
      return;
    }

    let frameId = 0;
    const updateCustomScrollbar = (): void => {
      const currentBody = fullSidebarBodyRef.current;
      const track = fullSidebarScrollbarRef.current;
      const thumb = fullSidebarScrollbarThumbRef.current;
      if (!currentBody || !track || !thumb) {
        return;
      }

      const { clientHeight, scrollHeight, scrollTop } = currentBody;
      const trackHeight = track.clientHeight;
      const maxScrollTop = Math.max(scrollHeight - clientHeight, 0);
      const hasOverflow = maxScrollTop > 1 && trackHeight > 0;

      if (fullSidebarHasOverflowRef.current !== hasOverflow) {
        fullSidebarHasOverflowRef.current = hasOverflow;
        setShowFullSidebarCustomScrollbar(hasOverflow);
      }

      if (!hasOverflow) {
        thumb.style.height = "0px";
        thumb.style.transform = "translateY(0)";
        return;
      }

      const minThumbHeight = 28;
      const thumbHeight = Math.max(minThumbHeight, (clientHeight / scrollHeight) * trackHeight);
      const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
      const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
    };

    const scheduleUpdate = (): void => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateCustomScrollbar);
    };

    scheduleUpdate();
    sidebarBody.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
    if (resizeObserver) {
      resizeObserver.observe(sidebarBody);
      const firstChild = sidebarBody.firstElementChild;
      if (firstChild instanceof HTMLElement) {
        resizeObserver.observe(firstChild);
      }
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      sidebarBody.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [activeFullProfileTab, safeAboutText, shouldShowSpotifyConnectionSection, viewMode]);

  useEffect(() => {
    if (viewMode === "full") {
      setActiveFullProfileTab("activity");
    }
  }, [username, viewMode]);

  useEffect(() => {
    if (!isFriendMenuOpen && !isMoreMenuOpen && !isAccountQuickMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const isInsideFriendMenu = Boolean(friendMenuRef.current?.contains(target));
      const isInsideMoreMenu = Boolean(moreMenuRef.current?.contains(target));
      const isInsideAccountMenu = Boolean(accountMenuRef.current?.contains(target));
      if (!isInsideFriendMenu && !isInsideMoreMenu && !isInsideAccountMenu) {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
        setIsAccountQuickMenuOpen(false);
      }
    };

    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
        setIsAccountQuickMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isAccountQuickMenuOpen, isFriendMenuOpen, isMoreMenuOpen]);

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

  const handleEditProfileClick = (): void => {
    onEditProfile?.();
  };

  const handleFullPrimaryAction = (): void => {
    if (showEditProfileButton) {
      handleEditProfileClick();
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

  const handleFullSidebarScrollbarMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !fullSidebarHasOverflowRef.current) {
      return;
    }

    const body = fullSidebarBodyRef.current;
    const track = fullSidebarScrollbarRef.current;
    const thumb = fullSidebarScrollbarThumbRef.current;
    if (!body || !track || !thumb) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const clickY = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
    const thumbHeight = thumb.offsetHeight;
    const maxThumbTop = Math.max(rect.height - thumbHeight, 0);
    const targetThumbTop = Math.max(0, Math.min(clickY - thumbHeight / 2, maxThumbTop));
    const maxScrollTop = Math.max(body.scrollHeight - body.clientHeight, 0);
    const targetScrollTop = maxThumbTop > 0 ? (targetThumbTop / maxThumbTop) * maxScrollTop : 0;
    body.scrollTop = targetScrollTop;

    isFullSidebarScrollbarDraggingRef.current = true;
    fullSidebarDragStartYRef.current = event.clientY;
    fullSidebarDragStartScrollTopRef.current = body.scrollTop;
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  const handleFullSidebarScrollbarThumbMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !fullSidebarHasOverflowRef.current) {
      return;
    }

    const body = fullSidebarBodyRef.current;
    if (!body) {
      return;
    }

    isFullSidebarScrollbarDraggingRef.current = true;
    fullSidebarDragStartYRef.current = event.clientY;
    fullSidebarDragStartScrollTopRef.current = body.scrollTop;
    document.body.style.userSelect = "none";
    event.preventDefault();
    event.stopPropagation();
  };

  const openAccountCenter = (mode: AccountCenterMode, targetUid: string | null = null): void => {
    setIsAccountQuickMenuOpen(false);
    setAccountCenterMode(mode);
    setAccountCenterTargetUid(targetUid);
    setIsAccountCenterOpen(true);
  };

  const closeAccountCenter = (): void => {
    setIsAccountCenterOpen(false);
    setAccountCenterMode("overview");
    setAccountCenterTargetUid(null);
  };

  const handleSelectQuickAccount = (uid: string): void => {
    if (uid === activeAccountUid) {
      setIsAccountQuickMenuOpen(false);
      return;
    }
    openAccountCenter("swap", uid);
  };

  const isFriendMenuMode = showFriendActions;
  const isFriendRequestPendingMode = !isFriendMenuMode && showFriendRequestPending;
  const isAddFriendMode = !isFriendMenuMode && !isFriendRequestPendingMode && showAddFriendAction;
  const isOwnFullProfile = viewMode === "full" && showEditProfileButton;
  const resolvedMutualFriends = useMemo(() => {
    if (!Array.isArray(mutualFriends)) {
      return [] as UserProfileMutualFriendItem[];
    }

    const seen = new Set<string>();
    const next: UserProfileMutualFriendItem[] = [];
    mutualFriends.forEach((entry) => {
      const userId = String(entry?.userId ?? "").trim();
      if (!userId || seen.has(userId) || userId === normalizedProfileUserId || userId === normalizedAuthUserId) {
        return;
      }

      seen.add(userId);
      next.push({
        userId,
        displayName: String(entry?.displayName ?? "").trim() || String(entry?.username ?? "").trim() || "Usuário",
        username: String(entry?.username ?? "").trim() || "usuario",
        avatarSrc: String(entry?.avatarSrc ?? "").trim(),
      });
    });

    return next;
  }, [mutualFriends, normalizedAuthUserId, normalizedProfileUserId]);
  const mutualFriendsCount = resolvedMutualFriends.length;
  const mutualFriendsTabLabel = mutualFriendsCount === 1 ? "1 amigo mútuo" : `${mutualFriendsCount} amigos mútuos`;
  const shouldShowMutualFriendsTab = !isOwnFullProfile && mutualFriendsCount > 0;

  useEffect(() => {
    if (!isOwnFullProfile) {
      return;
    }
    setActiveFullProfileTab("activity");
  }, [isOwnFullProfile]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      if (!isFullSidebarScrollbarDraggingRef.current) {
        return;
      }

      const body = fullSidebarBodyRef.current;
      const track = fullSidebarScrollbarRef.current;
      const thumb = fullSidebarScrollbarThumbRef.current;
      if (!body || !track || !thumb) {
        return;
      }

      const deltaY = event.clientY - fullSidebarDragStartYRef.current;
      const maxScrollTop = Math.max(body.scrollHeight - body.clientHeight, 0);
      if (maxScrollTop <= 0) {
        return;
      }

      const trackHeight = track.clientHeight;
      const thumbHeight = thumb.offsetHeight;
      const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
      if (maxThumbTop <= 0) {
        return;
      }

      const scrollDelta = (deltaY / maxThumbTop) * maxScrollTop;
      const nextScrollTop = Math.max(0, Math.min(fullSidebarDragStartScrollTopRef.current + scrollDelta, maxScrollTop));
      body.scrollTop = nextScrollTop;
      event.preventDefault();
    };

    const stopDragging = (): void => {
      if (!isFullSidebarScrollbarDraggingRef.current) {
        return;
      }
      isFullSidebarScrollbarDraggingRef.current = false;
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("blur", stopDragging);
      stopDragging();
    };
  }, []);

  useEffect(() => {
    if (activeFullProfileTab === "mutualFriends" && !shouldShowMutualFriendsTab) {
      setActiveFullProfileTab("activity");
    }
  }, [activeFullProfileTab, shouldShowMutualFriendsTab]);

  if (viewMode === "full") {
    return (
      <article
        className={`${styles.panel} ${styles.panelFull}`}
        style={fullPanelInlineStyle}
        role="dialog"
        aria-label="Perfil completo do usuário"
      >
        <div className={styles.fullLayout}>
          <section className={`${styles.fullSidebar}${showEditProfileButton ? ` ${styles.fullSidebarOwn}` : ""}`}>
            <header className={styles.fullHeader}>
              <div
                className={`${styles.fullBanner}${safeBannerSrc ? ` ${styles.fullBannerHasImage}` : ""}${
                  safeBannerSrc && !isBannerLoaded ? ` ${styles.fullBannerLoading}` : ""
                }${!safeBannerSrc ? ` ${styles.fullBannerNoImage}` : ""}${
                  !safeBannerSrc && shouldShowNoImageBannerSeparator ? ` ${styles.fullBannerSeparatorVisible}` : ""
                }`}
                style={bannerInlineStyle}
              >
                {safeBannerSrc ? (
                  <BannerImage
                    key={safeBannerSrc}
                    className={`${styles.fullBannerImage}${isBannerLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
                    src={safeBannerSrc}
                    alt=""
                    loading="eager"
                    decoding="async"
                    onLoad={() => {
                      setIsBannerLoaded(true);
                    }}
                    onError={() => {
                      setIsBannerLoaded(true);
                    }}
                  />
                ) : null}
              </div>

              <div className={`${styles.fullAvatarWrap}${!isAvatarLoaded ? ` ${styles.fullAvatarWrapLoading}` : ""}`}>
                <AvatarImage
                  className={`${styles.fullAvatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
                  src={safeAvatarSrc}
                  name={displayName || username}
                  alt={`Avatar de ${displayName}`}
                  loading="eager"
                  decoding="async"
                  onLoad={() => {
                    setIsAvatarLoaded(true);
                  }}
                  onError={() => {
                    setIsAvatarLoaded(true);
                  }}
                />
                <span className={`${styles.fullPresenceBadge} ${badgeClass}`} aria-hidden="true" />
              </div>
            </header>

            <div className={`${styles.fullSidebarBodyWrap}${safeBannerSrc ? ` ${styles.fullSidebarBodyWrapWithBannerImage}` : ""}`}>
              <div ref={fullSidebarBodyRef} className={styles.fullSidebarBody}>
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

                {!isOwnFullProfile ? (
                  <>
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
                        <div className={styles.fullFriendMenu} role="menu" aria-label="Ações de amizade">
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
                        aria-label="Mais opções"
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
                        <div className={styles.fullMoreMenu} role="menu" aria-label="Mais ações">
                          <button
                            className={`${styles.fullMoreMenuItem} ${styles.fullMoreMenuItemDanger}`}
                            type="button"
                            role="menuitem"
                            onClick={handleBlockUserClick}
                            disabled={isBlockingUser}
                          >
                            {isBlockingUser ? "Bloqueando..." : "Bloquear usuário"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>

              <section className={styles.fullDetails}>
                {safeAboutText ? (
                  <div className={styles.fullDetailSection}>
                    <p className={styles.fullBioPlain}>{safeAboutText}</p>
                  </div>
                ) : null}

                {safeMemberSinceLabel ? (
                  <div className={styles.fullDetailSection}>
                    <p className={styles.fullDetailTitle}>Membro desde</p>
                    <p className={styles.fullDetailValue}>{safeMemberSinceLabel}</p>
                  </div>
                ) : null}

                {shouldShowSpotifyConnectionSection ? (
                  <div className={styles.fullDetailSection}>
                    <p className={styles.fullDetailTitle}>Conexões</p>
                    <div className={styles.fullConnectionItem}>
                      <span className={styles.fullConnectionIcon} aria-hidden="true">
                        <img className={styles.fullConnectionLogoImage} src={spotifyLogoSrc} alt="" loading="lazy" />
                      </span>
                      {spotifyAccountUrl ? (
                        <button
                          type="button"
                          className={styles.fullConnectionLinkButton}
                          onClick={handleOpenSpotifyProfile}
                          aria-label={`Abrir perfil do Spotify de ${spotifyAccountName}`}
                        >
                          <span className={styles.fullConnectionName}>{spotifyAccountName}</span>
                          <span className={styles.fullConnectionArrow} aria-hidden="true">
                            <MaterialSymbolIcon name="arrow_forward" size={14} filled={false} />
                          </span>
                        </button>
                      ) : (
                        <p className={styles.fullConnectionName}>{spotifyAccountName}</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </section>
              </div>
              <div
                ref={fullSidebarScrollbarRef}
                className={`${styles.fullSidebarCustomScrollbar}${
                  showFullSidebarCustomScrollbar ? "" : ` ${styles.fullSidebarCustomScrollbarHidden}`
                }`}
                aria-hidden="true"
                onMouseDown={handleFullSidebarScrollbarMouseDown}
              >
                <div
                  ref={fullSidebarScrollbarThumbRef}
                  className={styles.fullSidebarCustomScrollbarThumb}
                  onMouseDown={handleFullSidebarScrollbarThumbMouseDown}
                />
              </div>
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
              {shouldShowMutualFriendsTab ? (
                <button
                  className={`${styles.fullTabButton}${activeFullProfileTab === "mutualFriends" ? ` ${styles.fullTabButtonActive}` : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeFullProfileTab === "mutualFriends"}
                  onClick={() => setActiveFullProfileTab("mutualFriends")}
                >
                  {mutualFriendsTabLabel}
                </button>
              ) : null}
            </nav>

            <div className={styles.fullContentBody}>
              {!shouldShowMutualFriendsTab || activeFullProfileTab === "activity" ? (
                <section className={styles.fullActivitySection}>
                  <h4 className={styles.fullActivityTitle}>Atividade agora</h4>
                  {spotifyPlayback ? (
                    <>
                      <ProfileSpotifyActivityCard
                        trackTitle={spotifyPlayback.trackTitle}
                        artistNames={spotifyPlayback.artistNames}
                        coverUrl={spotifyPlayback.coverUrl}
                        progressRatio={spotifyProgressRatio}
                        elapsedLabel={spotifyElapsedLabel}
                        durationLabel={spotifyDurationLabel}
                        onOpenTrack={handleOpenSpotifyTrack}
                        actions={
                          shouldShowActivityActionButtons ? (
                            <>
                              {canListenAlong ? (
                                <button
                                  type="button"
                                  className={`${styles.fullActivityActionButton}${isListenAlongActive ? ` ${styles.fullActivityActionButtonActive}` : ""}`}
                                  onClick={handleToggleListenAlong}
                                  title={`Ouvir junto com ${displayName}`}
                                >
                                  {isListenAlongActive ? "Ouvindo junto" : "Ouvir junto"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={styles.fullActivityActionButton}
                                onClick={handleOpenSpotifyTrack}
                              >
                                Ouvir no Spotify
                              </button>
                            </>
                          ) : null
                        }
                      />
                    </>
                  ) : (
                    <p className={styles.fullPlaceholderText}>
                      Ainda não há nada para mostrar aqui.
                    </p>
                  )}
                </section>
              ) : (
                <section className={styles.fullPlaceholderSection} aria-label="Amigos mútuos">
                  <h4 className={styles.fullPlaceholderTitle}>{mutualFriendsTabLabel}</h4>
                  <div className={styles.fullMutualList}>
                    {resolvedMutualFriends.map((friend) => (
                      <article key={friend.userId} className={styles.fullMutualItem}>
                        <AvatarImage
                          className={styles.fullMutualAvatar}
                          src={friend.avatarSrc}
                          name={friend.displayName || friend.username}
                          alt={`Avatar de ${friend.displayName}`}
                          loading="lazy"
                        />
                        <div className={styles.fullMutualMeta}>
                          <p className={styles.fullMutualName}>{friend.displayName}</p>
                        </div>
                      </article>
                    ))}
                  </div>
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
      aria-label="Perfil do usuário"
    >
      <header className={styles.header}>
        <div
          className={`${styles.banner}${safeBannerSrc ? ` ${styles.bannerHasImage}` : ""}${
            safeBannerSrc && !isBannerLoaded ? ` ${styles.bannerLoading}` : ""
          }${!safeBannerSrc ? ` ${styles.bannerNoImage}` : ""}${
            !safeBannerSrc && shouldShowNoImageBannerSeparator ? ` ${styles.bannerSeparatorVisible}` : ""
          }`}
          style={bannerInlineStyle}
        >
          <div
            className={`${styles.bannerEditOverlay}${showBannerEditOverlay ? ` ${styles.bannerEditOverlayVisible}` : ""}`}
            aria-hidden="true"
          >
            <MaterialSymbolIcon className={styles.bannerEditOverlayIcon} name="edit" size={20} filled={false} />
            <span className={styles.bannerEditOverlayLabel}>{bannerEditOverlayLabel}</span>
          </div>
          {safeBannerSrc ? (
            <BannerImage
              key={safeBannerSrc}
              className={`${styles.bannerImage}${isBannerLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeBannerSrc}
              alt=""
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsBannerLoaded(true);
              }}
              onError={() => {
                setIsBannerLoaded(true);
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
            <AvatarImage
              className={`${styles.avatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeAvatarSrc}
              name={displayName || username}
              alt={`Avatar de ${displayName}`}
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsAvatarLoaded(true);
              }}
              onError={() => {
                setIsAvatarLoaded(true);
              }}
            />
            <span
              className={`${styles.avatarEditOverlay}${showAvatarEditOverlay ? ` ${styles.avatarEditOverlayVisible}` : ""}`}
              aria-hidden="true"
            >
              <MaterialSymbolIcon name="edit" size={16} filled={false} />
            </span>
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </button>
        ) : (
          <div className={`${styles.avatarWrap}${!isAvatarLoaded ? ` ${styles.avatarWrapLoading}` : ""}`}>
            <AvatarImage
              className={`${styles.avatar}${isAvatarLoaded ? ` ${styles.mediaImageLoaded}` : ""}`}
              src={safeAvatarSrc}
              name={displayName || username}
              alt={`Avatar de ${displayName}`}
              loading="eager"
              decoding="async"
              onLoad={() => {
                setIsAvatarLoaded(true);
              }}
              onError={() => {
                setIsAvatarLoaded(true);
              }}
            />
            <span
              className={`${styles.avatarEditOverlay}${showAvatarEditOverlay ? ` ${styles.avatarEditOverlayVisible}` : ""}`}
              aria-hidden="true"
            >
              <MaterialSymbolIcon name="edit" size={16} filled={false} />
            </span>
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </div>
        )}
      </header>

      <section className={`${styles.body}${safeBannerSrc ? ` ${styles.bodyWithBannerImage}` : ""}`}>
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
                    Ver biografia completa
                  </button>
                ) : (
                  <span className={styles.aboutHint}>Ver biografia completa</span>
                )
              ) : null}
            </div>
          ) : null}

          {spotifyPlayback ? (
            <div className={styles.compactSpotifyCard} role="note" aria-label={`Ouvindo ${spotifyPlayback.trackTitle}`}>
              <p className={styles.compactSpotifyTitle}>
                <span className={styles.compactSpotifyTitleIcon} aria-hidden="true">
                  <SpotifyIcon size={12} monochrome />
                </span>
                Ouvindo Spotify
              </p>
              <div className={styles.compactSpotifyBody}>
                <button
                  type="button"
                  className={`${styles.compactSpotifyCover} ${styles.compactSpotifyCoverButton}`}
                  onClick={handleOpenSpotifyTrack}
                  aria-label={`Abrir ${spotifyPlayback.trackTitle} no Spotify`}
                  title="Abrir no Spotify"
                >
                  {spotifyPlayback.coverUrl ? (
                    <img
                      className={styles.compactSpotifyCoverImage}
                      src={spotifyPlayback.coverUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : null}
                </button>
                <div className={styles.compactSpotifyMeta}>
                  <button
                    type="button"
                    className={`${styles.compactSpotifyTrack} ${styles.compactSpotifyLink}`}
                    onClick={handleOpenSpotifyTrack}
                    aria-label={`Abrir ${spotifyPlayback.trackTitle} no Spotify`}
                    title="Abrir no Spotify"
                  >
                    {spotifyPlayback.trackTitle}
                  </button>
                  <button
                    type="button"
                    className={`${styles.compactSpotifyArtists} ${styles.compactSpotifyLink}`}
                    onClick={handleOpenSpotifyTrack}
                    aria-label={`Abrir ${spotifyPlayback.artistNames} no Spotify`}
                    title="Abrir no Spotify"
                  >
                    {spotifyPlayback.artistNames}
                  </button>
                  <div className={styles.compactSpotifyTimeline}>
                    <span className={styles.compactSpotifyTime}>{spotifyElapsedLabel}</span>
                    <div className={styles.compactSpotifyProgressTrack} aria-hidden="true">
                      <span className={styles.compactSpotifyProgressBar} style={{ width: `${spotifyProgressRatio}%` }} />
                    </div>
                    <span className={styles.compactSpotifyTime}>{spotifyDurationLabel}</span>
                  </div>
                </div>
              </div>
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
          <button className={styles.messageComposerEditButton} type="button" onClick={handleEditProfileClick}>
            <span className={styles.messageComposerEditButtonContent}>
              <MaterialSymbolIcon name="edit" size={16} filled={false} />
              Editar perfil
            </span>
          </button>
        </div>
      ) : null}

      {showActions ? (
        <div className={styles.actions}>
          <div className={styles.actionsGroup}>
            <button className={styles.actionButton} type="button" onClick={handleEditProfileClick}>
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
                className={`${styles.actionButton} ${styles.actionButtonWithChevron}${isPresenceMenuOpen ? ` ${styles.actionButtonActive}` : ""}`}
                type="button"
                onClick={() => setIsPresenceMenuOpen((current) => !current)}
                aria-expanded={isPresenceMenuOpen}
                aria-haspopup="menu"
              >
                <span className={styles.actionLeft}>
                  <span className={`${styles.presenceMenuDot} ${badgeClass}`} aria-hidden="true" />
                  {presenceLabel}
                </span>
                <MaterialSymbolIcon className={styles.actionChevron} name="chevron_right" size={16} filled={false} />
              </button>

              {isPresenceMenuOpen ? (
                <div className={styles.presenceMenu} role="menu" aria-label="Selecionar presença">
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
          </div>

          <div className={styles.actionsGroup}>
            <div
              className={styles.accountSwitchWrap}
              ref={accountMenuRef}
              onMouseEnter={openAccountQuickMenu}
              onMouseLeave={scheduleAccountQuickMenuClose}
              onFocusCapture={openAccountQuickMenu}
              onBlurCapture={handleAccountMenuBlur}
            >
              <button
                className={`${styles.actionButton} ${styles.actionButtonWithChevron}${isAccountQuickMenuOpen ? ` ${styles.actionButtonActive}` : ""}`}
                type="button"
                onClick={() => {
                  setIsFriendMenuOpen(false);
                  setIsMoreMenuOpen(false);
                  clearAccountCloseTimer();
                  setIsAccountQuickMenuOpen((current) => !current);
                }}
                aria-haspopup="menu"
                aria-expanded={isAccountQuickMenuOpen}
              >
                <span className={styles.actionLeft}>
                  <MaterialSymbolIcon name="supervisor_account" size={18} filled={false} />
                  Mudar de conta
                </span>
                <MaterialSymbolIcon className={styles.actionChevron} name="chevron_right" size={16} filled={false} />
              </button>

              {isAccountQuickMenuOpen ? (
                <div className={styles.accountQuickMenu} role="menu" aria-label="Perfis conectados">
                  {uniqueKnownAccounts.length === 0 ? (
                    <p className={styles.accountQuickEmpty}>Nenhum perfil salvo.</p>
                  ) : (
                    uniqueKnownAccounts.map((account) => {
                      return (
                        <button
                          key={account.uid}
                          type="button"
                          role="menuitem"
                          className={`${styles.accountQuickRow}${account.uid === activeAccountUid ? ` ${styles.accountQuickRowActive}` : ""}`}
                          onClick={() => handleSelectQuickAccount(account.uid)}
                        >
                          <span className={styles.accountQuickMain}>
                            <AvatarImage
                              className={styles.accountQuickAvatar}
                              src={account.avatarSrc}
                              name={account.alias || account.email}
                              alt=""
                              aria-hidden="true"
                              loading="lazy"
                            />
                            <span className={styles.accountQuickIdentity}>
                              <span className={styles.accountQuickAlias}>{account.alias}</span>
                            </span>
                          </span>
                          {account.uid === activeAccountUid ? (
                            <span className={styles.accountQuickIndicator}>
                              <MaterialSymbolIcon name="check_circle" size={16} />
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}

                  <button
                    type="button"
                    className={styles.accountQuickManage}
                    onClick={() => {
                      openAccountCenter("overview");
                    }}
                  >
                    Gerenciar perfis
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <AccountCenterModal
        isOpen={isAccountCenterOpen}
        onClose={closeAccountCenter}
        initialMode={accountCenterMode}
        targetUid={accountCenterTargetUid}
      />
    </article>
  );
}
