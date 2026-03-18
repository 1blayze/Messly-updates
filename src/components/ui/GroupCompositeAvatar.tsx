import { useMemo } from "react";
import AvatarImage from "./AvatarImage";
import { getNameAvatarUrl } from "../../services/cdn/mediaUrls";
import "../../styles/components/GroupCompositeAvatar.css";

interface GroupCompositeAvatarParticipant {
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  avatarSrc?: string | null;
}

interface GroupCompositeAvatarProps {
  participants: GroupCompositeAvatarParticipant[];
  label: string;
  className?: string;
  fallbackSrc?: string;
  fixedSrc?: string | null;
}

interface ResolvedAvatarParticipant {
  key: string;
  name: string;
  avatarSrc: string;
}

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export default function GroupCompositeAvatar({
  participants,
  label,
  className,
  fallbackSrc,
  fixedSrc,
}: GroupCompositeAvatarProps) {
  const normalizedFixedSrc = String(fixedSrc ?? "").trim();
  const resolvedParticipants = useMemo<ResolvedAvatarParticipant[]>(() => {
    return participants
      .map((participant, index) => {
        const name =
          String(participant.displayName ?? "").trim()
          || String(participant.username ?? "").trim()
          || "Usuario";
        const avatarSrc = String(participant.avatarSrc ?? "").trim() || getNameAvatarUrl(name || "U");
        const key = String(participant.userId ?? "").trim() || `${name}:${index}`;
        return {
          key,
          name,
          avatarSrc,
        };
      })
      .filter((participant) => Boolean(participant.key))
      .slice(0, 4);
  }, [participants]);

  if (normalizedFixedSrc) {
    return (
      <AvatarImage
        className={joinClassNames("group-composite-avatar", className)}
        src={normalizedFixedSrc}
        name={label || "Grupo privado"}
        alt={`Avatar de ${label}`}
        loading="lazy"
      />
    );
  }

  if (resolvedParticipants.length <= 1) {
    const firstParticipant = resolvedParticipants[0] ?? null;
    const singleAvatarSrc = firstParticipant?.avatarSrc || String(fallbackSrc ?? "").trim() || getNameAvatarUrl(label || "G");
    const singleName = firstParticipant?.name || label || "Grupo privado";
    return (
      <AvatarImage
        className={joinClassNames("group-composite-avatar", className)}
        src={singleAvatarSrc}
        name={singleName}
        alt={`Avatar de ${label}`}
        loading="lazy"
      />
    );
  }

  const layoutCount = Math.min(resolvedParticipants.length, 4);

  return (
    <div
      className={joinClassNames("group-composite-avatar", `group-composite-avatar--count-${layoutCount}`, className)}
      role="img"
      aria-label={`Avatar do grupo ${label}`}
    >
      {resolvedParticipants.map((participant, index) => (
        <span
          key={participant.key}
          className={joinClassNames("group-composite-avatar__slot", `group-composite-avatar__slot--${index + 1}`)}
        >
          <AvatarImage
            className="group-composite-avatar__image"
            src={participant.avatarSrc}
            name={participant.name}
            alt={`Avatar de ${participant.name}`}
            loading="lazy"
          />
        </span>
      ))}
    </div>
  );
}
