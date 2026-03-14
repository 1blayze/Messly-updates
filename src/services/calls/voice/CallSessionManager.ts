import {
  type CallDebugLogger,
  type CallLifecycleState,
  type VoiceSession,
  toPeerConnectionState,
} from "./types";

interface CallSessionManagerOptions {
  onLifecycleChange?: (state: CallLifecycleState) => void;
  onPeerConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  debugLog?: CallDebugLogger;
}

export class CallSessionManager {
  private lifecycle: CallLifecycleState = "idle";
  private session: VoiceSession | null = null;
  private readonly onLifecycleChange: (state: CallLifecycleState) => void;
  private readonly onPeerConnectionStateChange: (state: RTCPeerConnectionState) => void;
  private readonly debugLog: CallDebugLogger;

  constructor(options: CallSessionManagerOptions = {}) {
    this.onLifecycleChange = typeof options.onLifecycleChange === "function" ? options.onLifecycleChange : () => {};
    this.onPeerConnectionStateChange =
      typeof options.onPeerConnectionStateChange === "function" ? options.onPeerConnectionStateChange : () => {};
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  }

  getLifecycle(): CallLifecycleState {
    return this.lifecycle;
  }

  getPeerConnectionState(): RTCPeerConnectionState {
    return toPeerConnectionState(this.lifecycle);
  }

  getSession(): VoiceSession | null {
    if (!this.session) {
      return null;
    }
    return { ...this.session };
  }

  setSession(nextSession: VoiceSession | null): void {
    this.session = nextSession ? { ...nextSession } : null;
  }

  mutateSession(mutator: (current: VoiceSession) => VoiceSession): VoiceSession | null {
    if (!this.session) {
      return null;
    }
    const next = mutator({ ...this.session });
    this.session = { ...next };
    return { ...this.session };
  }

  transition(next: CallLifecycleState, reason = "state-change"): void {
    if (this.lifecycle === next) {
      return;
    }
    const previous = this.lifecycle;
    this.lifecycle = next;
    this.debugLog("lifecycle_transition", {
      from: previous,
      to: next,
      reason,
    });
    this.onLifecycleChange(next);
    this.onPeerConnectionStateChange(toPeerConnectionState(next));
  }

  isDestroyed(): boolean {
    return this.lifecycle === "destroyed";
  }

  isConnectingLike(): boolean {
    return this.lifecycle === "connecting" || this.lifecycle === "reconnecting";
  }

  canMutateCallGraph(): boolean {
    return this.lifecycle !== "disconnecting" && this.lifecycle !== "destroyed";
  }

  resetForClose(reason = "call-closed"): void {
    this.transition("disconnecting", reason);
    this.setSession(null);
    this.transition("destroyed", reason);
  }
}
