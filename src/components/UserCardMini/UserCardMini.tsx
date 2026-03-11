import type { ReactNode } from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import type { PresenceState } from "../../services/presence/presenceTypes";
import musicalIcon from "../../assets/icons/ui/musical.svg";
import styles from "./UserCardMini.module.css";

interface UserCardMiniProps {
  avatarSrc: string;
  displayName: string;
  username?: string;
  presenceLabel: string;
  presenceState: PresenceState;
  spotifyStatusText?: string;
  isMicEnabled?: boolean;
  isSoundEnabled?: boolean;
  onToggleMic?: () => void;
  onToggleSound?: () => void;
  onOpenSettings?: (section?: "account" | "profile" | "connections" | "social" | "audio" | "windows") => void;
  callContent?: ReactNode;
  isProfileOpen: boolean;
  onToggleProfile: () => void;
}

const BADGE_BY_STATE: Record<PresenceState, string> = {
  online: styles.presenceOnline,
  idle: styles.presenceIdle,
  dnd: styles.presenceDnd,
  invisivel: styles.presenceInvisivel,
};

export default function UserCardMini({
  avatarSrc,
  displayName,
  username = "",
  presenceLabel,
  presenceState,
  spotifyStatusText = "",
  isMicEnabled = true,
  isSoundEnabled = true,
  onToggleMic,
  onToggleSound,
  onOpenSettings,
  callContent,
  isProfileOpen,
  onToggleProfile,
}: UserCardMiniProps) {
  const badgeClass = BADGE_BY_STATE[presenceState];
  const safeSpotifyStatusText = String(spotifyStatusText ?? "").trim();
  const safeUsername = String(username ?? "").trim().replace(/^@+/, "");
  const shouldShowSpotifyStatus = safeSpotifyStatusText.length > 0;
  const shouldShowUsername = safeUsername.length > 0;
  return (
    <div className={styles.card} role="group" aria-label="Card de usuário">
      {callContent ? <div className={styles.callSection}>{callContent}</div> : null}

      <button
        className={`${styles.mainButton}${isProfileOpen ? ` ${styles.mainButtonActive}` : ""}`}
        type="button"
        onClick={onToggleProfile}
      >
        <span className={styles.avatarWrap}>
          <AvatarImage
            className={styles.avatar}
            src={avatarSrc}
            name={displayName}
            alt={`Avatar de ${displayName}`}
          />
          <span className={`${styles.presenceBadge} ${badgeClass}`} role="img" aria-label={`Status atual: ${presenceLabel}`} />
        </span>

        <span className={styles.meta}>
          <span className={styles.name}>{displayName}</span>
          <span className={styles.metaSecondary}>
            <span className={styles.metaSecondaryDefault}>
              {shouldShowSpotifyStatus ? (
                <span className={styles.spotifyStatus}>
                  <img className={styles.spotifyStatusIcon} src={musicalIcon} alt="" aria-hidden="true" />
                  <span className={styles.spotifyStatusText}>{safeSpotifyStatusText}</span>
                </span>
              ) : (
                <span className={styles.status}>{presenceLabel}</span>
              )}
            </span>
            {shouldShowUsername ? <span className={styles.metaSecondaryUsername}>@{safeUsername}</span> : null}
          </span>
        </span>
      </button>

      <div className={styles.actions}>
        <button
          className={`${styles.actionButton}${!isMicEnabled ? ` ${styles.actionButtonActive}` : ""}`}
          type="button"
          aria-label={isMicEnabled ? "Silenciar microfone" : "Ativar microfone"}
          title={isMicEnabled ? "Silenciar" : "Ativar"}
          onClick={onToggleMic}
        >
          <MaterialSymbolIcon name={isMicEnabled ? "mic" : "mic_off"} size={18} />
        </button>
        <button
          className={`${styles.actionButton}${!isSoundEnabled ? ` ${styles.actionButtonActive}` : ""}`}
          type="button"
          aria-label={isSoundEnabled ? "Ensurdecer" : "Ativar áudio"}
          title={isSoundEnabled ? "Ensurdecer" : "Ativar áudio"}
          onClick={onToggleSound}
        >
          <MaterialSymbolIcon name={isSoundEnabled ? "headset" : "headset_off"} size={18} />
        </button>
        <button
          className={styles.actionButton}
          type="button"
          aria-label="Abrir configurações"
          title="Configurações"
          onClick={() => onOpenSettings?.("account")}
        >
          <MaterialSymbolIcon name="settings" size={18} />
        </button>
      </div>
    </div>
  );
}



