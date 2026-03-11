import type { User } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";
import {
  buildUsernameSeedFromEmail,
  generateUniqueUsername,
  normalizeUsername,
  validateUsername,
  isUsernameAvailable,
} from "../../shared/username";
import { normalizeEmail } from "../usernameAvailability";

export interface ProfileRow {
  id: string;
  email: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string | null;
}

function toNullableTrimmed(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

interface CodedError extends Error {
  code?: string;
}

function usernameTakenError(): CodedError {
  const error: CodedError = new Error("Este nome de usuário já está em uso.");
  error.code = "USERNAME_TAKEN";
  return error;
}

export async function fetchProfileById(profileId: string): Promise<ProfileRow | null> {
  const id = toNullableTrimmed(profileId);
  if (!id) {
    return null;
  }

  const { data, error } = await supabase.from("profiles").select("*").eq("id", id).limit(1).maybeSingle();
  if (error) {
    throw error;
  }

  return (data as ProfileRow | null) ?? null;
}

export async function fetchProfileByUsername(usernameRaw: string): Promise<ProfileRow | null> {
  const username = normalizeUsername(usernameRaw);
  if (!username) {
    return null;
  }

  const { data, error } = await supabase.from("profiles").select("*").eq("username", username).limit(1).maybeSingle();
  if (error) {
    throw error;
  }

  return (data as ProfileRow | null) ?? null;
}

async function insertProfile(payload: Partial<ProfileRow> & { id: string; username: string }): Promise<ProfileRow> {
  const { data, error } = await supabase.from("profiles").insert(payload).select("*").maybeSingle();
  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Perfil não retornado após criação.");
  }

  return data as ProfileRow;
}

export async function createProfileForUser(
  user: User,
  options: { preferredUsername?: string | null; displayName?: string | null } = {},
): Promise<ProfileRow> {
  const userId = toNullableTrimmed(user.id);
  if (!userId) {
    throw new Error("Usuário inválido para criar perfil.");
  }

  const email = normalizeEmail(user.email ?? "");
  const displayName =
    toNullableTrimmed(options.displayName) ??
    toNullableTrimmed((user.user_metadata as Record<string, unknown> | null)?.display_name) ??
    null;

  const preferredUsername =
    normalizeUsername(options.preferredUsername ?? "") ||
    normalizeUsername((user.user_metadata as Record<string, unknown> | null)?.username as string);

  const baseUsername =
    preferredUsername ||
    buildUsernameSeedFromEmail(email) ||
    normalizeUsername(displayName ?? "") ||
    normalizeUsername(userId.slice(0, 12));

  let username: string;
  const userProvidedUsername = Boolean(preferredUsername);

  if (userProvidedUsername) {
    const validation = validateUsername(preferredUsername);
    if (!validation.isValid) {
      throw new Error(validation.message ?? "Nome de usuário inválido.");
    }

    const available = await isUsernameAvailable(preferredUsername, { ignoreProfileId: null });
    if (!available) {
      throw usernameTakenError();
    }
    username = preferredUsername;
  } else {
    username = await generateUniqueUsername(baseUsername);
  }

  const payload: Partial<ProfileRow> & { id: string; username: string } = {
    id: userId,
    email: email || null,
    username,
    display_name: displayName,
    avatar_url: toNullableTrimmed((user.user_metadata as Record<string, unknown> | null)?.avatar_url),
    bio: null,
    banner_url: null,
  };

  try {
    return await insertProfile(payload);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "23505") {
      if (userProvidedUsername) {
        throw usernameTakenError();
      }
      const retryUsername = await generateUniqueUsername(`${baseUsername}`, { maxAttempts: 35 });
      return await insertProfile({ ...payload, username: retryUsername });
    }
    throw error;
  }
}

export async function updateProfile(
  profileId: string,
  updates: Partial<Pick<ProfileRow, "display_name" | "avatar_url" | "banner_url" | "bio" | "username" | "email">>,
): Promise<ProfileRow> {
  const id = toNullableTrimmed(profileId);
  if (!id) {
    throw new Error("Perfil inválido.");
  }

  const payload: Record<string, unknown> = { ...updates };
  if (typeof updates.email === "string") {
    payload.email = normalizeEmail(updates.email);
  }
  if (typeof updates.username === "string") {
    const normalizedUsername = normalizeUsername(updates.username);
    const validation = validateUsername(normalizedUsername);
    if (!validation.isValid) {
      throw new Error(validation.message ?? "Nome de usuário inválido.");
    }
    payload.username = normalizedUsername;
  }

  const { data, error } = await supabase.from("profiles").update(payload).eq("id", id).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error("Perfil não encontrado.");
  }
  return data as ProfileRow;
}

export async function ensureProfileForUser(
  user: User | null,
  options: { preferredUsername?: string | null; displayName?: string | null } = {},
): Promise<ProfileRow | null> {
  if (!user?.id) {
    return null;
  }

  const existing = await fetchProfileById(user.id);
  if (existing) {
    // Optionally fill in email/display name if missing.
    const nextEmail = normalizeEmail(user.email ?? "");
    const nextDisplayName = toNullableTrimmed(options.displayName ?? user.user_metadata?.display_name ?? user.email);
    if (!existing.email || (nextEmail && existing.email !== nextEmail) || (!existing.display_name && nextDisplayName)) {
      try {
        return await updateProfile(user.id, {
          email: nextEmail || existing.email,
          display_name: nextDisplayName ?? existing.display_name,
        });
      } catch {
        return existing;
      }
    }
    return existing;
  }

  return await createProfileForUser(user, options);
}
