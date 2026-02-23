import { useMemo, type ReactNode } from "react";
import { getNameAvatarUrl } from "../../services/cdn/mediaUrls";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import type { PresenceState } from "../../services/presence/presenceTypes";
import styles from "./UserCardMini.module.css";

interface UserCardMiniProps {
  avatarSrc: string;
  displayName: string;
  presenceLabel: string;
  presenceState: PresenceState;
  isMicEnabled?: boolean;
  isSoundEnabled?: boolean;
  onToggleMic?: () => void;
  onToggleSound?: () => void;
  onOpenSettings?: () => void;
  callContent?: ReactNode;
  isProfileOpen: boolean;
  onToggleProfile: () => void;
}

const BADGE_BY_STATE: Record<PresenceState, string> = {
  online: styles.presenceOnline,
  idle: styles.presenceIdle,
  dnd: styles.presenceDnd,
  offline: styles.presenceOffline,
};

export default function UserCardMini({
  avatarSrc,
  displayName,
  presenceLabel,
  presenceState,
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
  const fallbackAvatarSrc = useMemo(() => getNameAvatarUrl(displayName || "U"), [displayName]);

  return (
    <div className={styles.card} role="group" aria-label="Card de usuario">
      {callContent ? <div className={styles.callSection}>{callContent}</div> : null}

      <button
        className={`${styles.mainButton}${isProfileOpen ? ` ${styles.mainButtonActive}` : ""}`}
        type="button"
        onClick={onToggleProfile}
      >
        <span className={styles.avatarWrap}>
          <img
            className={styles.avatar}
            src={avatarSrc}
            alt={`Avatar de ${displayName}`}
            onError={(event) => {
              const target = event.currentTarget;
              if (target.src !== fallbackAvatarSrc) {
                target.src = fallbackAvatarSrc;
              }
            }}
          />
          <span className={`${styles.presenceBadge} ${badgeClass}`} role="img" aria-label={`Status atual: ${presenceLabel}`} />
        </span>

        <span className={styles.meta}>
          <span className={styles.name}>{displayName}</span>
          <span className={styles.status}>{presenceLabel}</span>
        </span>
      </button>

      <div className={styles.actions}>
        <button
          className={`${styles.actionButton}${!isMicEnabled ? ` ${styles.actionButtonActive}` : ""}`}
          type="button"
          aria-label={isMicEnabled ? "Silenciar microfone" : "Ativar microfone"}
          title={isMicEnabled ? "Silenciar microfone" : "Ativar microfone"}
          onClick={onToggleMic}
        >
          <MaterialSymbolIcon name={isMicEnabled ? "mic" : "mic_off"} size={18} />
        </button>
        <button
          className={`${styles.actionButton}${!isSoundEnabled ? ` ${styles.actionButtonActive}` : ""}`}
          type="button"
          aria-label={isSoundEnabled ? "Ensurdecer" : "Ativar audio"}
          title={isSoundEnabled ? "Ensurdecer" : "Ativar audio"}
          onClick={onToggleSound}
        >
          <MaterialSymbolIcon name={isSoundEnabled ? "headset" : "headset_off"} size={18} />
        </button>
        <button
          className={styles.actionButton}
          type="button"
          aria-label="Abrir configuracoes"
          title="Configuracoes"
          onClick={onOpenSettings}
        >
          <MaterialSymbolIcon name="settings" size={18} />
        </button>
      </div>
    </div>
  );
}
