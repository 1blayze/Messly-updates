import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";
import { PRESENCE_LABELS, type PresenceState } from "../../services/presence/presenceTypes";
import {
  SIDEBAR_CALL_FOCUS_EVENT,
  SIDEBAR_CALL_STATE_EVENT,
  dispatchSidebarCallHangup,
  dispatchSidebarCallToggleMic,
  dispatchSidebarCallToggleSound,
  type SidebarCallStateDetail,
} from "../../services/calls/callUiPresence";
import { useAuthSession } from "../../auth/AuthProvider";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import { createProfileTheme, type ProfileThemeInlineStyle } from "../../services/profile/profileTheme";
import {
  isSpotifyPlaybackStillActive,
  readSpotifyConnection,
  subscribeSpotifyConnection,
  type SpotifyConnectionState,
} from "../../services/connections/spotifyConnection";
import { supabase } from "../../services/supabase";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import UserCardMini from "../UserCardMini/UserCardMini";
import UserProfilePopover from "../UserProfilePopover/UserProfilePopover";
import styles from "./UserCard.module.css";

const SIDEBAR_CALL_PERSIST_KEY = "messly:sidebar-call-state:v2";
const PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX = "messly:profile-plus-theme:";
const PROFILE_PLUS_THEME_UPDATED_EVENT = "messly:profile-plus-theme-updated";

interface PersistedProfilePlusThemeSettings {
  v?: number;
  primary?: string | null;
  accent?: string | null;
}

interface ProfilePlusThemeState {
  primary: string | null;
  accent: string | null;
}

function buildProfilePlusThemeStorageKey(userUid: string | null | undefined): string {
  const normalizedUid = String(userUid ?? "").trim();
  if (!normalizedUid) {
    return `${PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX}guest`;
  }
  return `${PROFILE_PLUS_THEME_STORAGE_KEY_PREFIX}${normalizedUid}`;
}

function readProfilePlusThemeState(currentUserUid: string | null | undefined): ProfilePlusThemeState {
  if (typeof window === "undefined") {
    return { primary: null, accent: null };
  }

  const candidateKeys = Array.from(
    new Set([
      buildProfilePlusThemeStorageKey(currentUserUid),
      buildProfilePlusThemeStorageKey(null),
    ]),
  );

  for (const storageKey of candidateKeys) {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as PersistedProfilePlusThemeSettings | null;
      return {
        primary: normalizeBannerColor(parsed?.primary ?? null),
        accent: normalizeBannerColor(parsed?.accent ?? null),
      };
    } catch {
      // Ignore malformed local cache.
    }
  }

  return { primary: null, accent: null };
}

interface UserCardProps {
  userId?: string | null;
  currentUserId?: string | null;
  avatarSrc: string;
  bannerSrc?: string;
  bannerColor?: string | null;
  displayName: string;
  username: string;
  aboutText?: string;
  presenceState: PresenceState;
  onChangePresence: (state: PresenceState) => void;
  onOpenSettings: (section?: "account" | "profile" | "connections" | "social" | "devices" | "audio" | "windows") => void;
  onOpenConversation?: (conversationId: string) => void;
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

export default function UserCard({
  userId = null,
  currentUserId = null,
  avatarSrc,
  bannerSrc,
  bannerColor = null,
  displayName,
  username,
  aboutText,
  presenceState,
  onChangePresence,
  onOpenSettings,
  onOpenConversation,
}: UserCardProps) {
  const { user: authUser } = useAuthSession();
  const currentAuthUid = authUser?.uid ?? "";
  const currentAuthCreationTime = authUser?.raw?.created_at ?? "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isFullProfileOpen, setIsFullProfileOpen] = useState(false);
  const [isVoiceDetailsOpen, setIsVoiceDetailsOpen] = useState(false);
  const [profileThemeState, setProfileThemeState] = useState<ProfilePlusThemeState>(() =>
    readProfilePlusThemeState(authUser?.uid ?? currentUserId),
  );
  const [spotifyConnection, setSpotifyConnection] = useState<SpotifyConnectionState>(() => readSpotifyConnection(userId));
  const [sidebarCallState, setSidebarCallState] = useState<SidebarCallStateDetail>({
    active: false,
    conversationId: null,
    partnerName: "",
    mode: "audio",
    phase: "idle",
    averagePingMs: null,
    lastPingMs: null,
    packetLossPercent: null,
    micEnabled: true,
    soundEnabled: true,
    isPopoutOpen: false,
    updatedAt: new Date().toISOString(),
  });
  const fallbackMemberSinceLabel = useMemo(
    () => formatMemberSinceDate(currentAuthCreationTime) || "Data não disponível",
    [currentAuthCreationTime, currentAuthUid],
  );
  const [memberSinceLabel, setMemberSinceLabel] = useState(fallbackMemberSinceLabel);

  const safeDisplayName = useMemo(() => displayName.trim() || "Nome", [displayName]);
  const safeUsername = useMemo(() => username.trim() || "username", [username]);
  const fallbackAvatarSrc = useMemo(() => getNameAvatarUrl(safeDisplayName || safeUsername || "U"), [safeDisplayName, safeUsername]);
  const safeAvatarSrc = useMemo(() => {
    const trimmed = avatarSrc.trim();
    const isAbsolute =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    if (!trimmed || !isAbsolute || isDefaultAvatarUrl(trimmed)) {
      return fallbackAvatarSrc;
    }
    return trimmed;
  }, [avatarSrc, fallbackAvatarSrc]);
  const profileTheme = useMemo(
    () =>
      createProfileTheme({
        primaryColor: profileThemeState.primary ?? bannerColor ?? "",
        accentColor: profileThemeState.accent ?? profileThemeState.primary ?? bannerColor ?? "",
        mode: "dark",
      }),
    [bannerColor, profileThemeState.accent, profileThemeState.primary],
  );
  const profileThemeInlineStyle = useMemo<ProfileThemeInlineStyle>(() => profileTheme.style, [profileTheme.style]);
  const presenceLabel = PRESENCE_LABELS[presenceState];
  const spotifyScope = useMemo(
    () =>
      String(currentUserId ?? "").trim() ||
      String(userId ?? "").trim() ||
      String(authUser?.uid ?? "").trim() ||
      null,
    [authUser?.uid, currentUserId, userId],
  );
  const hasActiveSpotifyPlayback = useMemo(
    () => isSpotifyPlaybackStillActive(spotifyConnection.playback, spotifyConnection.updatedAt),
    [spotifyConnection.playback, spotifyConnection.updatedAt],
  );
  const miniSpotifyStatusText = useMemo(() => {
    if (!spotifyConnection.connected || !spotifyConnection.showAsStatus || !spotifyConnection.playback || !hasActiveSpotifyPlayback) {
      return "";
    }
    const artistNames = String(spotifyConnection.playback.artistNames ?? "").trim();
    const trackTitle = String(spotifyConnection.playback.trackTitle ?? "").trim();
    return artistNames || trackTitle;
  }, [hasActiveSpotifyPlayback, spotifyConnection.connected, spotifyConnection.playback, spotifyConnection.showAsStatus]);
  const voiceStatusTitle = useMemo(() => {
    if (!sidebarCallState.active) {
      return "Aguardando chamada";
    }
    const modeLabel = sidebarCallState.mode === "video" ? "video" : "voz";
    switch (sidebarCallState.phase) {
      case "outgoing":
        return "Chamando...";
      case "incoming":
        return "Chamada recebida";
      case "connecting":
        return "Conectando";
      case "reconnecting":
        return "Reconectando";
      case "disconnected":
        return modeLabel === "video" ? "Chamada de vídeo" : "Chamada de voz";
      case "active":
        return modeLabel === "video" ? "Chamada de vídeo" : "Chamada de voz";
      default:
        return "Aguardando chamada";
    }
  }, [sidebarCallState.active, sidebarCallState.mode, sidebarCallState.phase]);
  const voiceStatusTarget = sidebarCallState.partnerName || "Aguardando";
  const averagePingLabel = sidebarCallState.averagePingMs == null ? "-- ms" : `${Math.max(0, Math.round(sidebarCallState.averagePingMs))} ms`;
  const lastPingLabel = sidebarCallState.lastPingMs == null ? "-- ms" : `${Math.max(0, Math.round(sidebarCallState.lastPingMs))} ms`;
  const packetLossLabel = sidebarCallState.packetLossPercent == null ? "--%" : `${sidebarCallState.packetLossPercent.toFixed(1)}%`;
  const shouldShowCallStrip =
    sidebarCallState.active &&
    sidebarCallState.phase !== "incoming" &&
    sidebarCallState.phase !== "disconnected";

  useEffect(() => {
    setProfileThemeState(readProfilePlusThemeState(authUser?.uid ?? currentUserId));
  }, [authUser?.uid, currentUserId, userId]);

  useEffect(() => {
    setSpotifyConnection(readSpotifyConnection(spotifyScope));
    return subscribeSpotifyConnection(spotifyScope, setSpotifyConnection);
  }, [spotifyScope]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(SIDEBAR_CALL_PERSIST_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        detail?: SidebarCallStateDetail;
      } | null;
      const detail = parsed?.detail ?? null;
      if (!detail) {
        return;
      }
      const normalizedDetail: SidebarCallStateDetail = {
        ...detail,
        micEnabled: detail.micEnabled ?? true,
        soundEnabled: detail.soundEnabled ?? true,
        isPopoutOpen: detail.isPopoutOpen ?? false,
      };

      const now = Date.now();
      const detailUpdatedAt = Date.parse(String(normalizedDetail.updatedAt ?? ""));
      const isStaleActiveState =
        normalizedDetail.active &&
        Number.isFinite(detailUpdatedAt) &&
        now - detailUpdatedAt > 30_000;
      if (isStaleActiveState) {
        normalizedDetail.active = false;
      }
      if (!normalizedDetail.active) {
        window.localStorage.removeItem(SIDEBAR_CALL_PERSIST_KEY);
        return;
      }

      setSidebarCallState(normalizedDetail);
    } catch {
      // Ignore malformed persisted state.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      if (!shouldShowCallStrip || !sidebarCallState.conversationId) {
        window.localStorage.removeItem(SIDEBAR_CALL_PERSIST_KEY);
        return;
      }
      window.localStorage.setItem(
        SIDEBAR_CALL_PERSIST_KEY,
        JSON.stringify({
          detail: sidebarCallState,
        }),
      );
    } catch {
      // Ignore localStorage write errors.
    }
  }, [shouldShowCallStrip, sidebarCallState]);

  useEffect(() => {
    let cancelled = false;
    const normalizedUserId = String(userId ?? "").trim();
    const normalizedUsername = String(username ?? "").trim();
    setMemberSinceLabel(fallbackMemberSinceLabel);

    const resolveMemberSince = async (): Promise<void> => {
      try {
        const query = supabase.from("profiles").select("created_at").limit(1);
        const result =
          normalizedUserId.length > 0
            ? await query.eq("id", normalizedUserId).maybeSingle()
            : normalizedUsername.length > 0
              ? await query.eq("username", normalizedUsername).maybeSingle()
              : { data: null, error: null };

        if (cancelled || result.error) {
          return;
        }

        const row = result.data as { created_at?: string | null } | null;
        const resolved = formatMemberSinceDate(row?.created_at);
        if (!cancelled && resolved) {
          setMemberSinceLabel(resolved);
        }
      } catch {
        // Keep fallback label when query fails.
      }
    };

    void resolveMemberSince();

    return () => {
      cancelled = true;
    };
  }, [fallbackMemberSinceLabel, userId, username]);

  const handleOpenSettings = (
    section: "account" | "profile" | "connections" | "social" | "audio" | "windows" = "account",
  ): void => {
    setIsProfileOpen(false);
    setIsFullProfileOpen(false);
    onOpenSettings(section);
  };

  const handleOpenProfileSettings = (): void => {
    handleOpenSettings("profile");
  };

  const handleOpenFullProfile = (): void => {
    setIsProfileOpen(false);
    setIsFullProfileOpen(true);
  };

  const handleCloseFullProfile = (): void => {
    setIsFullProfileOpen(false);
  };

  useEffect(() => {
    if (!isProfileOpen && !isVoiceDetailsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (target instanceof Element && target.closest('[data-messly-modal-root="true"]')) {
        return;
      }

      if (!rootRef.current?.contains(target)) {
        setIsProfileOpen(false);
        setIsVoiceDetailsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsProfileOpen(false);
        setIsVoiceDetailsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProfileOpen, isVoiceDetailsOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleProfileThemeUpdated = (event: Event): void => {
      const currentAuthUid = String(authUser?.uid ?? currentUserId ?? "").trim();
      const detail = (event as CustomEvent<{ userUid?: string | null } | undefined>).detail;
      const updatedUid = String(detail?.userUid ?? "").trim();
      if (updatedUid && currentAuthUid && updatedUid !== currentAuthUid) {
        return;
      }
      setProfileThemeState(readProfilePlusThemeState(currentAuthUid || null));
    };

    window.addEventListener(PROFILE_PLUS_THEME_UPDATED_EVENT, handleProfileThemeUpdated as EventListener);
    return () => {
      window.removeEventListener(PROFILE_PLUS_THEME_UPDATED_EVENT, handleProfileThemeUpdated as EventListener);
    };
  }, [authUser?.uid, currentUserId]);

  useEffect(() => {
    if (!shouldShowCallStrip) {
      setIsVoiceDetailsOpen(false);
    }
  }, [shouldShowCallStrip]);

  useEffect(() => {
    const handleSidebarCallState = (event: Event): void => {
      const detailRaw = (event as CustomEvent<SidebarCallStateDetail>).detail;
      if (!detailRaw) {
        return;
      }
      const detail: SidebarCallStateDetail = {
        ...detailRaw,
        micEnabled: detailRaw.micEnabled ?? true,
        soundEnabled: detailRaw.soundEnabled ?? true,
        isPopoutOpen: detailRaw.isPopoutOpen ?? false,
      };
      setSidebarCallState(detail);
      if (detail.active) {
        return;
      } else {
        setIsVoiceDetailsOpen(false);
      }
    };

    window.addEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    return () => {
      window.removeEventListener(SIDEBAR_CALL_STATE_EVENT, handleSidebarCallState as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleSidebarCallFocus = (): void => {
      const conversationId = String(sidebarCallState.conversationId ?? "").trim();
      if (!conversationId || !onOpenConversation) {
        return;
      }
      onOpenConversation(conversationId);
    };

    window.addEventListener(SIDEBAR_CALL_FOCUS_EVENT, handleSidebarCallFocus as EventListener);
    return () => {
      window.removeEventListener(SIDEBAR_CALL_FOCUS_EVENT, handleSidebarCallFocus as EventListener);
    };
  }, [onOpenConversation, sidebarCallState.conversationId]);

  const handleMiniToggleMic = (): void => {
    setSidebarCallState((current) => ({
      ...current,
      micEnabled: !current.micEnabled,
      updatedAt: new Date().toISOString(),
    }));
    dispatchSidebarCallToggleMic();
  };

  const handleMiniToggleSound = (): void => {
    const nextSoundEnabled = !sidebarCallState.soundEnabled;
    const nextMicEnabled = nextSoundEnabled;
    const shouldToggleMic = sidebarCallState.micEnabled !== nextMicEnabled;

    setSidebarCallState((current) => ({
      ...current,
      soundEnabled: nextSoundEnabled,
      micEnabled: nextMicEnabled,
      updatedAt: new Date().toISOString(),
    }));

    if (shouldToggleMic) {
      dispatchSidebarCallToggleMic();
    }
    dispatchSidebarCallToggleSound();
  };

  useEffect(() => {
    if (!isFullProfileOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFullProfileOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullProfileOpen]);

  return (
    <div className={styles.wrap} ref={rootRef} style={profileThemeInlineStyle}>
      {isProfileOpen ? (
        <div className={styles.popoverAnchor}>
          <UserProfilePopover
            avatarSrc={safeAvatarSrc}
            bannerSrc={bannerSrc}
            bannerColor={bannerColor}
            themePrimaryColor={profileThemeState.primary}
            themeAccentColor={profileThemeState.accent}
            displayName={safeDisplayName}
            username={safeUsername}
            profileUserId={userId}
            aboutText={aboutText}
            spotifyConnection={spotifyConnection}
            memberSinceLabel={memberSinceLabel}
            presenceState={presenceState}
            presenceLabel={presenceLabel}
            onChangePresence={onChangePresence}
            onEditProfile={handleOpenProfileSettings}
            onOpenFullProfile={handleOpenFullProfile}
            onOpenSettings={onOpenSettings}
          />
        </div>
      ) : null}

      <UserCardMini
        avatarSrc={safeAvatarSrc}
        displayName={safeDisplayName}
        username={safeUsername}
        presenceLabel={presenceLabel}
        presenceState={presenceState}
        spotifyStatusText={miniSpotifyStatusText}
        isMicEnabled={sidebarCallState.micEnabled}
        isSoundEnabled={sidebarCallState.soundEnabled}
        onToggleMic={handleMiniToggleMic}
        onToggleSound={handleMiniToggleSound}
        onOpenSettings={handleOpenSettings}
        callContent={shouldShowCallStrip ? (
            <section className={styles.voiceStrip} aria-label="Status da chamada de voz">
              {sidebarCallState.phase !== "disconnected" ? (
                <div
                  className={styles.voiceDetailsPopover}
                  role="dialog"
                  aria-label="Diagnóstico da chamada"
                  aria-hidden={!isVoiceDetailsOpen}
                  hidden={!isVoiceDetailsOpen}
                >
                  <div className={styles.voiceDetailsHeader}>
                    <MaterialSymbolIcon name="network_check" size={18} />
                    <p className={styles.voiceDetailsTitle}>Qualidade da chamada</p>
                  </div>
                  <p className={styles.voiceDetailsSubTitle}>Diagnóstico em tempo real da conexão de voz.</p>
                  <div className={styles.voiceDetailsMetrics}>
                    <p className={styles.voiceDetailsMetricRow}>
                      <span className={styles.voiceDetailsMetricLabel}>Ping médio</span>
                      <span className={styles.voiceDetailsMetricValue}>{averagePingLabel}</span>
                    </p>
                    <p className={styles.voiceDetailsMetricRow}>
                      <span className={styles.voiceDetailsMetricLabel}>Último ping</span>
                      <span className={styles.voiceDetailsMetricValue}>{lastPingLabel}</span>
                    </p>
                    <p className={styles.voiceDetailsMetricRow}>
                      <span className={styles.voiceDetailsMetricLabel}>Perda de pacotes</span>
                      <span className={styles.voiceDetailsMetricValue}>{packetLossLabel}</span>
                    </p>
                  </div>
                  <p className={styles.voiceDetailsHint}>
                    Valores altos de ping ou perda de pacotes podem causar atrasos, cortes e reconexões.
                  </p>
                  <div className={styles.voiceDetailsFooter}>
                    <span className={styles.voiceDetailsFooterLock}>
                      <MaterialSymbolIcon name="lock" size={14} />
                      Chamada criptografada em trânsito
                    </span>
                  </div>
                </div>
              ) : null}
              <div className={styles.voiceStripHeader}>
                {sidebarCallState.phase !== "disconnected" ? (
                  <div className={styles.voiceNetworkWrap}>
                    <button
                    type="button"
                    className={styles.voiceNetworkButton}
                    aria-label={`Qualidade da conexão: ${averagePingLabel}`}
                    data-ping={averagePingLabel}
                    aria-expanded={isVoiceDetailsOpen}
                    onClick={() => {
                      setIsVoiceDetailsOpen((current) => !current);
                    }}
                  >
                    <MaterialSymbolIcon name="wifi" size={18} />
                    </button>
                  </div>
                ) : null}
                <div className={styles.voiceHeaderMeta}>
                  <p className={styles.voiceHeaderTitle}>{voiceStatusTitle}</p>
                  <p className={styles.voiceHeaderSubtitle}>{voiceStatusTarget}</p>
                </div>
                <div className={styles.voiceHeaderIcons}>
                  {sidebarCallState.phase !== "disconnected" ? (
                    <button
                      type="button"
                      className={styles.voiceHangupButton}
                      aria-label="Desconectar da chamada"
                      title="Desconectar"
                      onClick={() => {
                        dispatchSidebarCallHangup();
                      }}
                    >
                      <MaterialSymbolIcon name="call_end" size={22} />
                    </button>
                  ) : null}
                </div>
              </div>
          </section>
        ) : null}
        isProfileOpen={isProfileOpen}
        onToggleProfile={() => setIsProfileOpen((current) => !current)}
      />

      {isFullProfileOpen && typeof document !== "undefined"
        ? createPortal(
            <div className={styles.fullProfileLayer} onClick={handleCloseFullProfile}>
              <div className={styles.fullProfileCard} onClick={(event) => event.stopPropagation()}>
                <UserProfilePopover
                  avatarSrc={safeAvatarSrc}
                  bannerSrc={bannerSrc}
                  bannerColor={bannerColor}
                  themePrimaryColor={profileThemeState.primary}
                  themeAccentColor={profileThemeState.accent}
                  displayName={safeDisplayName}
                  username={safeUsername}
                  profileUserId={userId}
                  aboutText={aboutText}
                  spotifyConnection={spotifyConnection}
                  memberSinceLabel={memberSinceLabel}
                  presenceState={presenceState}
                  presenceLabel={presenceLabel}
                  viewMode="full"
                  showActions={false}
                  showEditProfileButton
                  onEditProfile={handleOpenProfileSettings}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
