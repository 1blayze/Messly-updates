import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";
import { PRESENCE_LABELS, type PresenceState } from "../../services/presence/presenceTypes";
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
import {
  emitVoiceCallUiCommand,
  getVoiceCallUiSnapshot,
  publishVoiceCallUiSnapshot,
  subscribeVoiceCallUiSnapshot,
} from "../../voice/client/uiState";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import UserCardMini from "../UserCardMini/UserCardMini";
import UserProfilePopover from "../UserProfilePopover/UserProfilePopover";
import styles from "./UserCard.module.css";

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

function formatDiagnosticsMetric(value: number | null, suffix: string): string {
  if (!Number.isFinite(value) || value == null) {
    return `--${suffix}`;
  }
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${suffix}`;
}

function formatAudioFlowMetric(value: number | null, fallback: string): string {
  if (!Number.isFinite(value) || value == null || value <= 0) {
    return fallback;
  }
  return `${Number(value.toFixed(1))} kbps`;
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
}: UserCardProps) {
  const { user: authUser } = useAuthSession();
  const currentAuthUid = authUser?.uid ?? "";
  const currentAuthCreationTime = authUser?.raw?.created_at ?? "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isFullProfileOpen, setIsFullProfileOpen] = useState(false);
  const [profileThemeState, setProfileThemeState] = useState<ProfilePlusThemeState>(() =>
    readProfilePlusThemeState(authUser?.uid ?? currentUserId),
  );
  const [spotifyConnection, setSpotifyConnection] = useState<SpotifyConnectionState>(() => readSpotifyConnection(userId));
  const [voiceCallUiSnapshot, setVoiceCallUiSnapshot] = useState(() => getVoiceCallUiSnapshot());
  const [isVoiceDiagnosticsOpen, setIsVoiceDiagnosticsOpen] = useState(false);
  const fallbackMemberSinceLabel = useMemo(
    () => formatMemberSinceDate(currentAuthCreationTime) || "Data nao disponivel",
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
  const shouldShowVoiceCallCard = voiceCallUiSnapshot.callActive || voiceCallUiSnapshot.callConnecting;
  const voicePeerDisplayName = useMemo(
    () => String(voiceCallUiSnapshot.peerDisplayName ?? "").trim() || "Contato",
    [voiceCallUiSnapshot.peerDisplayName],
  );
  const voiceCallStatusTitle = useMemo(() => {
    if (voiceCallUiSnapshot.stage === "RECONNECTING" || voiceCallUiSnapshot.connectionState === "reconnecting") {
      return "Reconectando";
    }
    if (voiceCallUiSnapshot.stage === "CONNECTED" || voiceCallUiSnapshot.connectionState === "connected" || voiceCallUiSnapshot.callActive) {
      return "Voz conectada";
    }
    if (voiceCallUiSnapshot.stage === "RINGING" || voiceCallUiSnapshot.connectionState === "connecting" || voiceCallUiSnapshot.callConnecting) {
      return "Conectando voz";
    }
    return "Chamada de voz";
  }, [
    voiceCallUiSnapshot.callActive,
    voiceCallUiSnapshot.callConnecting,
    voiceCallUiSnapshot.connectionState,
    voiceCallUiSnapshot.stage,
  ]);
  const voiceCallStatusToneClass = useMemo(() => {
    if (voiceCallUiSnapshot.stage === "RECONNECTING" || voiceCallUiSnapshot.connectionState === "reconnecting") {
      return styles.voiceCallStatusTitleWarning;
    }
    return styles.voiceCallStatusTitleSuccess;
  }, [voiceCallUiSnapshot.connectionState, voiceCallUiSnapshot.stage]);
  const voiceDiagnostics = voiceCallUiSnapshot.diagnostics;
  const voicePingAverageLabel = useMemo(
    () => formatDiagnosticsMetric(voiceDiagnostics.pingAverageMs, " ms"),
    [voiceDiagnostics.pingAverageMs],
  );
  const voiceLastPingLabel = useMemo(
    () => formatDiagnosticsMetric(voiceDiagnostics.lastPingMs, " ms"),
    [voiceDiagnostics.lastPingMs],
  );
  const voicePacketLossLabel = useMemo(
    () => formatDiagnosticsMetric(voiceDiagnostics.packetLossPercent, "%"),
    [voiceDiagnostics.packetLossPercent],
  );
  const voiceSendingAudioLabel = useMemo(
    () => formatAudioFlowMetric(voiceDiagnostics.sendingAudioKbps, "Sem audio"),
    [voiceDiagnostics.sendingAudioKbps],
  );
  const voiceReceivingAudioLabel = useMemo(
    () => formatAudioFlowMetric(voiceDiagnostics.receivingAudioKbps, "Sem stream"),
    [voiceDiagnostics.receivingAudioKbps],
  );

  useEffect(() => {
    setProfileThemeState(readProfilePlusThemeState(authUser?.uid ?? currentUserId));
  }, [authUser?.uid, currentUserId, userId]);

  useEffect(() => subscribeVoiceCallUiSnapshot(setVoiceCallUiSnapshot), []);

  useEffect(() => {
    if (!shouldShowVoiceCallCard) {
      setIsVoiceDiagnosticsOpen(false);
    }
  }, [shouldShowVoiceCallCard]);

  useEffect(() => {
    setSpotifyConnection(readSpotifyConnection(spotifyScope));
    return subscribeSpotifyConnection(spotifyScope, setSpotifyConnection);
  }, [spotifyScope]);

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
    if (!isProfileOpen) {
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
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsProfileOpen(false);
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
  }, [isProfileOpen]);

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

  const voiceCallContent = shouldShowVoiceCallCard ? (
    <div className={styles.voiceCallCard} role="status" aria-live="polite">
      <div className={styles.voiceCallHeaderRow}>
        <div className={styles.voiceCallStatusWrap}>
          <span className={styles.voiceCallStatusIcon} aria-hidden="true">
            <MaterialSymbolIcon name="wifi" size={16} />
          </span>
          <div className={styles.voiceCallStatusTextWrap}>
            <span className={`${styles.voiceCallStatusTitle} ${voiceCallStatusToneClass}`}>{voiceCallStatusTitle}</span>
            <span className={styles.voiceCallPeerName}>{voicePeerDisplayName}</span>
          </div>
        </div>
        <button
          type="button"
          className={styles.voiceCallQualityButton}
          aria-label={isVoiceDiagnosticsOpen ? "Ocultar qualidade da chamada" : "Mostrar qualidade da chamada"}
          title="Qualidade da chamada"
          onClick={() => setIsVoiceDiagnosticsOpen((current) => !current)}
        >
          <MaterialSymbolIcon name="network_check" size={18} />
        </button>
      </div>

      {isVoiceDiagnosticsOpen ? (
        <section className={styles.voiceCallDiagnosticsPanel} aria-label="Qualidade da chamada">
          <p className={styles.voiceCallDiagnosticsTitle}>Qualidade da chamada</p>
          <p className={styles.voiceCallDiagnosticsSubtitle}>Diagnostico em tempo real da conexao de voz.</p>

          <dl className={styles.voiceCallDiagnosticsList}>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Ping medio</dt>
              <dd>{voicePingAverageLabel}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Ultimo ping</dt>
              <dd>{voiceLastPingLabel}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Perda de pacotes</dt>
              <dd>{voicePacketLossLabel}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Enviando audio</dt>
              <dd>{voiceSendingAudioLabel}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Recebendo audio</dt>
              <dd>{voiceReceivingAudioLabel}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Track local</dt>
              <dd>{voiceDiagnostics.localTrackActive ? "Ativa" : "Inativa"}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Track remota</dt>
              <dd>{voiceDiagnostics.remoteTrackActive ? "Ativa" : "Ausente"}</dd>
            </div>
            <div className={styles.voiceCallDiagnosticsItem}>
              <dt>Streams remotos</dt>
              <dd>{voiceDiagnostics.remoteStreams}</dd>
            </div>
          </dl>

          <p className={styles.voiceCallDiagnosticsFooter}>
            <MaterialSymbolIcon name="lock" size={14} />
            <span>Chamada criptografada em transito</span>
          </p>
        </section>
      ) : null}
    </div>
  ) : null;

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
        isMicEnabled={!voiceCallUiSnapshot.muted}
        isSoundEnabled={!voiceCallUiSnapshot.deafened}
        callContent={voiceCallContent}
        onToggleMic={() => {
          const isCurrentlyMuted = Boolean(voiceCallUiSnapshot.muted);
          const isCurrentlyDeafened = Boolean(voiceCallUiSnapshot.deafened);

          if (!isCurrentlyMuted && !isCurrentlyDeafened) {
            // Manter comportamento sincronizado: desativar microfone tambem ativa ensurdecer.
            publishVoiceCallUiSnapshot({
              muted: true,
              deafened: true,
            });
            emitVoiceCallUiCommand("toggle-deafen");
            return;
          }

          if (isCurrentlyDeafened) {
            publishVoiceCallUiSnapshot({
              deafened: false,
            });
            emitVoiceCallUiCommand("toggle-deafen");
            return;
          }

          publishVoiceCallUiSnapshot({
            muted: !isCurrentlyMuted,
          });
          emitVoiceCallUiCommand("toggle-mute");
        }}
        onToggleSound={() => {
          if (!voiceCallUiSnapshot.deafened) {
            publishVoiceCallUiSnapshot({
              deafened: true,
              muted: true,
            });
          } else {
            publishVoiceCallUiSnapshot({
              deafened: false,
            });
          }
          emitVoiceCallUiCommand("toggle-deafen");
        }}
        onOpenSettings={handleOpenSettings}
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
