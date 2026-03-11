import type { ReactNode } from "react";
import SpotifyIcon from "../ui/SpotifyIcon";
import styles from "../UserProfilePopover/UserProfilePopover.module.css";

interface ProfileSpotifyActivityCardProps {
  trackTitle: string;
  artistNames: string;
  coverUrl?: string | null;
  progressRatio: number;
  elapsedLabel: string;
  durationLabel: string;
  onOpenTrack: () => void;
  actions?: ReactNode;
}

export default function ProfileSpotifyActivityCard({
  trackTitle,
  artistNames,
  coverUrl,
  progressRatio,
  elapsedLabel,
  durationLabel,
  onOpenTrack,
  actions = null,
}: ProfileSpotifyActivityCardProps) {
  return (
    <article className={styles.fullActivityCard} aria-label={`Ouvindo ${trackTitle}`}>
      <p className={styles.fullActivitySpotifyLabel}>
        <span className={styles.fullActivitySpotifyLabelIcon} aria-hidden="true">
          <SpotifyIcon size={12} monochrome />
        </span>
        Ouvindo Spotify
      </p>
      <div className={styles.fullActivityMain}>
        <button
          type="button"
          className={`${styles.fullActivityCover} ${styles.fullActivityCoverButton}`}
          onClick={onOpenTrack}
          aria-label={`Abrir ${trackTitle} no Spotify`}
          title="Abrir no Spotify"
        >
          {coverUrl ? (
            <img
              className={styles.fullActivityCoverImage}
              src={coverUrl}
              alt=""
              loading="lazy"
            />
          ) : null}
        </button>
        <div className={styles.fullActivityMeta}>
          <button
            type="button"
            className={`${styles.fullActivityName} ${styles.fullActivityTextLink}`}
            onClick={onOpenTrack}
            aria-label={`Abrir ${trackTitle} no Spotify`}
            title="Abrir no Spotify"
          >
            {trackTitle}
          </button>
          <button
            type="button"
            className={`${styles.fullActivityArtist} ${styles.fullActivityTextLink}`}
            onClick={onOpenTrack}
            aria-label={`Abrir ${artistNames} no Spotify`}
            title="Abrir no Spotify"
          >
            {artistNames}
          </button>
          <div className={styles.fullActivityTimeline}>
            <span className={styles.fullActivityTime}>{elapsedLabel}</span>
            <div className={styles.fullActivityProgressTrack} aria-hidden="true">
              <span
                className={styles.fullActivityProgressBar}
                style={{ width: `${progressRatio}%` }}
              />
            </div>
            <span className={styles.fullActivityTime}>{durationLabel}</span>
          </div>
          {actions ? <div className={styles.fullActivityActions}>{actions}</div> : null}
        </div>
      </div>
    </article>
  );
}
