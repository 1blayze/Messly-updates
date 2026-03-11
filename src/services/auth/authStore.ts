import type { Session } from "@supabase/supabase-js";

interface InMemoryAuthState {
  currentSession: Session | null;
  currentAccessToken: string | null;
  currentUserId: string | null;
}

const AUTH_STATE_SLOT = "__messlyAuthState";

function getGlobalAuthState(): InMemoryAuthState {
  if (typeof window === "undefined") {
    return {
      currentSession: null,
      currentAccessToken: null,
      currentUserId: null,
    };
  }

  const existing = window[AUTH_STATE_SLOT];
  if (existing) {
    return existing;
  }

  const created: InMemoryAuthState = {
    currentSession: null,
    currentAccessToken: null,
    currentUserId: null,
  };
  window[AUTH_STATE_SLOT] = created;
  return created;
}

export function setInMemorySession(session: Session | null): void {
  const state = getGlobalAuthState();
  state.currentSession = session;
  state.currentAccessToken = String(session?.access_token ?? "").trim() || null;
  state.currentUserId = String(session?.user?.id ?? "").trim() || null;
}

export function getInMemorySession(): Session | null {
  return getGlobalAuthState().currentSession;
}

export function getAccessToken(): string | null {
  return getGlobalAuthState().currentAccessToken;
}

export function getCurrentUserId(): string | null {
  return getGlobalAuthState().currentUserId;
}

export function clearAccessToken(): void {
  setInMemorySession(null);
}
