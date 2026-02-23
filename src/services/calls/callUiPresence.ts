export const SIDEBAR_CALL_STATE_EVENT = "messly:sidebar-call-state";
export const SIDEBAR_CALL_HANGUP_EVENT = "messly:sidebar-call-hangup";
export const SIDEBAR_CALL_TOGGLE_MIC_EVENT = "messly:sidebar-call-toggle-mic";
export const SIDEBAR_CALL_TOGGLE_SOUND_EVENT = "messly:sidebar-call-toggle-sound";
export const SIDEBAR_CALL_FOCUS_EVENT = "messly:sidebar-call-focus";
export const SIDEBAR_CALL_REJOIN_EVENT = "messly:sidebar-call-rejoin";

export interface SidebarCallRejoinDetail {
  conversationId: string | null;
  mode: "audio" | "video";
  withCamera?: boolean;
}

export interface SidebarCallStateDetail {
  active: boolean;
  conversationId: string | null;
  partnerName: string;
  mode: "audio" | "video";
  phase: "idle" | "incoming" | "outgoing" | "connecting" | "active" | "reconnecting" | "disconnected";
  averagePingMs: number | null;
  lastPingMs: number | null;
  packetLossPercent: number | null;
  micEnabled: boolean;
  soundEnabled: boolean;
  isPopoutOpen: boolean;
  updatedAt: string;
}

export function dispatchSidebarCallState(detail: SidebarCallStateDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<SidebarCallStateDetail>(SIDEBAR_CALL_STATE_EVENT, {
      detail,
    }),
  );
}

export function dispatchSidebarCallHangup(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_CALL_HANGUP_EVENT));
}

export function dispatchSidebarCallToggleMic(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_CALL_TOGGLE_MIC_EVENT));
}

export function dispatchSidebarCallToggleSound(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_CALL_TOGGLE_SOUND_EVENT));
}

export function dispatchSidebarCallFocus(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_CALL_FOCUS_EVENT));
}

export function dispatchSidebarCallRejoin(detail: SidebarCallRejoinDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<SidebarCallRejoinDetail>(SIDEBAR_CALL_REJOIN_EVENT, {
      detail,
    }),
  );
}
