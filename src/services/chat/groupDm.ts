const groupDmAvatarUrl = new URL("../../assets/icons/ui/Group 1.svg", import.meta.url).href;

export function getGroupDmAvatarUrl(): string {
  return groupDmAvatarUrl;
}

export function buildGroupDmName(displayNames: string[]): string {
  const uniqueNames = Array.from(
    new Set(
      displayNames
        .map((displayName) => String(displayName ?? "").trim())
        .filter((displayName) => Boolean(displayName)),
    ),
  );

  if (uniqueNames.length === 0) {
    return "Grupo privado";
  }

  const fullName = uniqueNames.join(", ");
  if (fullName.length <= 72) {
    return fullName;
  }

  const previewNames = uniqueNames.slice(0, 3);
  const remainingCount = uniqueNames.length - previewNames.length;
  if (remainingCount <= 0) {
    return previewNames.join(", ");
  }

  return `${previewNames.join(", ")} +${remainingCount}`;
}

export function resolveGroupDmDisplayName(
  storedName: string | null | undefined,
  participantDisplayNames: string[],
): string {
  const normalizedStoredName = String(storedName ?? "").trim();
  if (normalizedStoredName) {
    return normalizedStoredName;
  }
  return buildGroupDmName(participantDisplayNames);
}
