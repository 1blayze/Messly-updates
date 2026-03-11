import Tooltip from "../ui/Tooltip";

function formatUnreadBadgeValue(unreadCount: number): string {
  if (unreadCount > 99) {
    return "99+";
  }
  return String(unreadCount);
}

interface ServerRailItemProps {
  label: string;
  iconSrc: string;
  isActive?: boolean;
  hasUnread?: boolean;
  hasMention?: boolean;
  isMuted?: boolean;
  isHome?: boolean;
  unreadCount?: number;
  onClick?: () => void;
}

export default function ServerRailItem({
  label,
  iconSrc,
  isActive = false,
  hasUnread = false,
  hasMention = false,
  isMuted = false,
  isHome = false,
  unreadCount = 0,
  onClick,
}: ServerRailItemProps) {
  const showBadge = hasMention || hasUnread;
  const sanitizedUnreadCount = Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0;
  const badgeLabel = hasMention ? "!" : formatUnreadBadgeValue(sanitizedUnreadCount);

  const stateClassName = [
    "server-rail__item",
    isActive ? "server-rail__item--active" : "",
    hasUnread ? "server-rail__item--unread" : "",
    hasMention ? "server-rail__item--mention" : "",
    isMuted ? "server-rail__item--muted" : "",
    isHome ? "server-rail__item--home" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={stateClassName}>
      <Tooltip text={label} delay={80}>
        <button className="server-rail__item-button" type="button" aria-label={label} onClick={onClick}>
          <img className="server-rail__item-icon" src={iconSrc} alt="" aria-hidden="true" />
          {showBadge ? (
            <span
              className={`server-rail__item-badge${hasMention ? " server-rail__item-badge--mention" : ""}`}
              aria-hidden="true"
            >
              {badgeLabel}
            </span>
          ) : null}
        </button>
      </Tooltip>
    </div>
  );
}
