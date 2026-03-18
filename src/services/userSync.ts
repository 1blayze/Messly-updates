import type { User as SupabaseUser } from "@supabase/supabase-js";
import { isDirectUsersRestBlocked, supabase } from "./supabase";
import { ensureProfileForUser, type ProfileRow } from "./profile/profileService";
import { normalizeEmail } from "./usernameAvailability";

const PENDING_PROFILE_KEY = "messly:pending-profile";

export interface PendingProfile {
  authUid?: string | null;
  username: string;
  displayName: string;
  createdAt: number;
  firebaseUid?: string | null;
}

export interface EnsureUserOptions {
  username?: string;
  displayName?: string;
}

type AuthIdentityInput =
  | SupabaseUser
  | {
      uid?: string | null;
      id?: string | null;
      email?: string | null;
      displayName?: string | null;
      raw?: SupabaseUser | null;
      user_metadata?: Record<string, unknown> | null;
    };

function resolveSupabaseUser(identity: AuthIdentityInput): SupabaseUser | null {
  if ((identity as SupabaseUser)?.id) {
    return identity as SupabaseUser;
  }
  const raw = (identity as { raw?: SupabaseUser | null }).raw;
  if (raw?.id) {
    return raw;
  }
  return null;
}

function resolveDisplayName(identity: AuthIdentityInput): string | null {
  const direct = (identity as { displayName?: string | null }).displayName;
  if (direct && direct.trim()) {
    return direct.trim();
  }
  const raw = resolveSupabaseUser(identity);
  const metadata = (identity as { user_metadata?: Record<string, unknown> | null }).user_metadata ?? raw?.user_metadata;
  const candidate =
    (metadata as { display_name?: string | null })?.display_name ??
    (metadata as { name?: string | null })?.name ??
    raw?.email ??
    null;
  const normalized = String(candidate ?? "").trim();
  return normalized || null;
}

function resolvePreferredUsername(identity: AuthIdentityInput): string | null {
  const raw = resolveSupabaseUser(identity);
  const direct = (identity as { username?: string | null }).username;
  if (direct && direct.trim()) {
    return direct.trim();
  }
  const metadata = (identity as { user_metadata?: Record<string, unknown> | null }).user_metadata ?? raw?.user_metadata;
  const candidate =
    (metadata as { username?: string | null })?.username ??
    (metadata as { preferred_username?: string | null })?.preferred_username ??
    null;
  const normalized = String(candidate ?? "").trim().toLowerCase();
  return normalized || null;
}

function getAuthUid(identity: AuthIdentityInput): string {
  const raw = resolveSupabaseUser(identity);
  const fallbackUid =
    (identity as { uid?: string | null }).uid ?? (identity as { id?: string | null }).id ?? raw?.id ?? "";
  return String(fallbackUid ?? "").trim();
}

export function savePendingProfile(profile: PendingProfile): void {
  const payload: PendingProfile = {
    authUid: profile.authUid ?? null,
    username: profile.username.trim(),
    displayName: profile.displayName.trim(),
    createdAt: profile.createdAt || Date.now(),
  };

  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(payload));
    }
  } catch {
    // ignore storage issues
  }
}

export function loadPendingProfile(): PendingProfile | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PENDING_PROFILE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PendingProfile> | null;
    const username = String(parsed?.username ?? "").trim();
    const displayName = String(parsed?.displayName ?? "").trim();
    if (!username || !displayName) {
      return null;
    }
    return {
      authUid: parsed?.authUid ?? null,
      username,
      displayName,
      createdAt: Number(parsed?.createdAt ?? Date.now()),
    };
  } catch {
    return null;
  }
}

export function clearPendingProfile(authUid?: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const existing = loadPendingProfile();
    if (authUid && existing?.authUid && existing.authUid !== authUid) {
      return;
    }
    window.localStorage.removeItem(PENDING_PROFILE_KEY);
  } catch {
    // ignore
  }
}

export async function ensureUser(identity: AuthIdentityInput, options: EnsureUserOptions = {}): Promise<ProfileRow> {
  const authUser = resolveSupabaseUser(identity);
  const uid = getAuthUid(identity);
  if (!authUser || !uid) {
    throw new Error("Sessão de usuário indisponível.");
  }

  const preferredUsername = resolvePreferredUsername(identity) ?? options.username ?? null;
  const displayName =
    options.displayName ?? resolveDisplayName(identity) ?? normalizeEmail(authUser.email ?? "") ?? authUser.id;

  const profile = await ensureProfileForUser(authUser, {
    preferredUsername,
    displayName,
  });

  if (!profile) {
    throw new Error("Não foi possível criar/atualizar o perfil.");
  }

  // update cached email if changed
  const normalizedEmail = normalizeEmail(authUser.email ?? "");
  if (normalizedEmail && profile.email !== normalizedEmail && !isDirectUsersRestBlocked()) {
    await supabase.from("profiles").update({ email: normalizedEmail }).eq("id", profile.id);
  }

  return profile;
}
