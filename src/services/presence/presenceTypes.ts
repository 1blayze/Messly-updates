export type PresenceState = "online" | "idle" | "dnd" | "offline";

export type PresencePlatform = "desktop" | "mobile" | "browser";

export interface PresenceRecord {
  state: PresenceState;
  lastActive: number | null;
  platform: PresencePlatform;
  updatedAt: number | null;
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  online: "Disponivel",
  idle: "Ausente",
  dnd: "Nao perturbar",
  offline: "Offline",
};
