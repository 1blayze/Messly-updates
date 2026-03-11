import type { User } from "@supabase/supabase-js";
import { normalizeEmail } from "./crypto";
import { AuthHttpError } from "./http";
import type { AuthDependencies } from "./types";

const USERNAME_REGEX = /^[a-z0-9._]{3,32}$/;

interface ExistingProfileRow {
  id: string;
  email: string | null;
  username: string;
  display_name: string | null;
}

function normalizeDisplayName(value: unknown): string | null {
  const displayName = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!displayName) {
    return null;
  }
  return displayName.slice(0, 32);
}

function normalizeUsernameCandidate(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 32);

  if (USERNAME_REGEX.test(normalized)) {
    return normalized;
  }

  return "";
}

function buildUsernameCandidates(user: User): string[] {
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(user.email ?? "");
  const emailLocalPart = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const idSuffix = user.id.replace(/-/g, "").slice(0, 8).toLowerCase();
  const baseCandidates = [
    normalizeUsernameCandidate(String(metadata.username ?? "")),
    normalizeUsernameCandidate(emailLocalPart),
    normalizeUsernameCandidate(`user_${idSuffix}`),
  ].filter(Boolean);

  const uniqueCandidates = new Set<string>();
  for (const baseCandidate of baseCandidates) {
    if (USERNAME_REGEX.test(baseCandidate)) {
      uniqueCandidates.add(baseCandidate);
    }

    const suffixCandidate = normalizeUsernameCandidate(
      `${baseCandidate.slice(0, Math.max(0, 32 - (idSuffix.length + 1)))}_${idSuffix}`,
    );
    if (USERNAME_REGEX.test(suffixCandidate)) {
      uniqueCandidates.add(suffixCandidate);
    }
  }

  if (uniqueCandidates.size === 0) {
    uniqueCandidates.add(`user_${idSuffix}`);
  }

  return [...uniqueCandidates];
}

async function isUsernameAvailable(
  deps: AuthDependencies,
  username: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await deps.adminSupabase
    .from("profiles")
    .select("id")
    .eq("username", username)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AuthHttpError(503, "PROFILE_LOOKUP_FAILED", "Failed to validate username availability.");
  }

  return !data || String((data as { id?: string } | null)?.id ?? "") === userId;
}

async function resolveProfileUsername(deps: AuthDependencies, user: User): Promise<string> {
  const candidates = buildUsernameCandidates(user);
  for (const candidate of candidates) {
    if (await isUsernameAvailable(deps, candidate, user.id)) {
      return candidate;
    }
  }

  const suffix = user.id.replace(/-/g, "").slice(0, 12).toLowerCase();
  const fallback = normalizeUsernameCandidate(`user_${suffix}`);
  if (await isUsernameAvailable(deps, fallback, user.id)) {
    return fallback;
  }

  throw new AuthHttpError(503, "PROFILE_USERNAME_UNAVAILABLE", "Failed to allocate a unique username for the profile.");
}

export async function ensureAuthUserProfile(deps: AuthDependencies, user: User): Promise<void> {
  const normalizedEmail = normalizeEmail(user.email ?? "") || null;
  const displayName = normalizeDisplayName((user.user_metadata as Record<string, unknown> | null)?.display_name);

  const { data, error } = await deps.adminSupabase
    .from("profiles")
    .select("id, email, username, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw new AuthHttpError(503, "PROFILE_LOOKUP_FAILED", "Failed to read the user profile.");
  }

  const existingProfile = (data as ExistingProfileRow | null) ?? null;
  if (existingProfile) {
    const patch: Record<string, string | null> = {};
    if (normalizedEmail && existingProfile.email !== normalizedEmail) {
      patch.email = normalizedEmail;
    }
    if (displayName && existingProfile.display_name !== displayName) {
      patch.display_name = displayName;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    const { error: updateError } = await deps.adminSupabase.from("profiles").update(patch).eq("id", user.id);
    if (updateError) {
      throw new AuthHttpError(503, "PROFILE_UPDATE_FAILED", "Failed to synchronize the user profile.");
    }
    return;
  }

  const username = await resolveProfileUsername(deps, user);
  const { error: insertError } = await deps.adminSupabase.from("profiles").insert({
    id: user.id,
    email: normalizedEmail,
    username,
    display_name: displayName,
  });

  if (insertError) {
    throw new AuthHttpError(503, "PROFILE_CREATE_FAILED", "Failed to create the user profile.");
  }
}
