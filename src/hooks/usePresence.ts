import { useAppSelector } from "../stores/store";

export function usePresence(userId: string | null | undefined) {
  const normalizedUserId = String(userId ?? "").trim();
  return useAppSelector((state) => state.presence.entities[normalizedUserId] ?? null);
}
