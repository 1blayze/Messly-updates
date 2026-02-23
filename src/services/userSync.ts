import type { User as FirebaseUser } from "firebase/auth";
import { supabase, type UserRow } from "./supabase";
import {
  escapeLikePattern,
  isUsernameAvailable,
  normalizeEmail,
  sanitizeDisplayName,
  validateUsernameInput,
} from "./usernameAvailability";

const PENDING_PROFILE_KEY = "messly:pending-profile";

export interface PendingProfile {
  firebaseUid: string;
  username: string;
  displayName: string;
  createdAt: number;
}

export interface EnsureUserOptions {
  username?: string;
  displayName?: string;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: string }).code);
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: string }).message ?? "");
  }
  return "";
}

function deriveUsernameFromUid(firebaseUid: string): string {
  const compactUid = firebaseUid
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  const candidate = `user_${compactUid}`;
  if (candidate.length >= 3) {
    return candidate.slice(0, 20);
  }

  return "user_000";
}

function normalizeUsernameSeed(username: string): string {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    return "user";
  }

  if (normalized.length < 3) {
    return `${normalized}user`.slice(0, 20);
  }

  return normalized.slice(0, 20);
}

async function getUserByFirebaseUid(firebaseUid: string): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("firebase_uid", firebaseUid)
    .limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

async function getUserByEmail(email: string): Promise<UserRow | null> {
  const escapedEmail = escapeLikePattern(email);
  const { data, error } = await supabase.from("users").select("*").ilike("email", escapedEmail).limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

async function updateUserById(id: string, values: Partial<UserRow>): Promise<UserRow> {
  const { data, error } = await supabase.from("users").update(values).eq("id", id).select("*").single();
  if (error) {
    throw error;
  }
  return data;
}

async function resolveAvailableUsername(usernameSeed: string): Promise<string> {
  const baseSeed = normalizeUsernameSeed(usernameSeed);

  const maxAttempts = 50;
  for (let index = 0; index < maxAttempts; index += 1) {
    const suffix = index === 0 ? "" : `_${index + 1}`;
    const maxBaseLength = 20 - suffix.length;
    const candidateBase = baseSeed.slice(0, Math.max(3, maxBaseLength));
    const candidate = `${candidateBase}${suffix}`;
    const validation = validateUsernameInput(candidate);

    if (!validation.isValid) {
      continue;
    }

    const available = await isUsernameAvailable(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error("Unable to resolve a unique username.");
}

export function savePendingProfile(profile: PendingProfile): void {
  localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(profile));
}

export function loadPendingProfile(): PendingProfile | null {
  const raw = localStorage.getItem(PENDING_PROFILE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PendingProfile;
    if (!parsed.firebaseUid || !parsed.username || !parsed.displayName) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingProfile(firebaseUid?: string): void {
  const current = loadPendingProfile();
  if (!current) {
    return;
  }

  if (!firebaseUid || current.firebaseUid === firebaseUid) {
    localStorage.removeItem(PENDING_PROFILE_KEY);
  }
}

export async function ensureUser(firebaseUser: FirebaseUser, options: EnsureUserOptions = {}): Promise<UserRow> {
  const firebaseUid = firebaseUser.uid;
  const normalizedEmail = normalizeEmail(firebaseUser.email ?? "");

  if (!firebaseUid || !normalizedEmail) {
    throw new Error("Invalid Firebase user session.");
  }

  const pendingProfile = loadPendingProfile();
  const pendingForCurrentUser =
    pendingProfile && pendingProfile.firebaseUid === firebaseUid ? pendingProfile : null;

  const desiredDisplayName = sanitizeDisplayName(
    options.displayName ?? pendingForCurrentUser?.displayName ?? firebaseUser.displayName ?? "",
  );
  const usernameSeed =
    options.username ??
    pendingForCurrentUser?.username ??
    deriveUsernameFromUid(firebaseUid);

  const existingByUid = await getUserByFirebaseUid(firebaseUid);
  if (existingByUid) {
    const updates: Partial<UserRow> = {
      last_active: new Date().toISOString(),
    };

    if ((!existingByUid.display_name || !existingByUid.display_name.trim()) && desiredDisplayName) {
      updates.display_name = desiredDisplayName;
    }

    if ((!existingByUid.email || !existingByUid.email.trim()) && normalizedEmail) {
      updates.email = normalizedEmail;
    }

    if (Object.keys(updates).length > 1 || updates.email || updates.display_name) {
      const updated = await updateUserById(existingByUid.id, updates);
      clearPendingProfile(firebaseUid);
      return updated;
    }

    clearPendingProfile(firebaseUid);
    return existingByUid;
  }

  const existingByEmail = await getUserByEmail(normalizedEmail);
  if (existingByEmail) {
    if (existingByEmail.firebase_uid && existingByEmail.firebase_uid !== firebaseUid) {
      throw new Error("Email already linked to another account.");
    }

    const updates: Partial<UserRow> = {
      firebase_uid: firebaseUid,
      last_active: new Date().toISOString(),
    };

    if ((!existingByEmail.display_name || !existingByEmail.display_name.trim()) && desiredDisplayName) {
      updates.display_name = desiredDisplayName;
    }

    if (!existingByEmail.username || !existingByEmail.username.trim()) {
      updates.username = await resolveAvailableUsername(usernameSeed);
    }

    const updated = await updateUserById(existingByEmail.id, updates);
    clearPendingProfile(firebaseUid);
    return updated;
  }

  let resolvedUsername = await resolveAvailableUsername(usernameSeed);
  const insertBase = {
    firebase_uid: firebaseUid,
    email: normalizedEmail,
    display_name: desiredDisplayName || null,
    status: "offline",
    last_active: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("users")
      .insert({
        ...insertBase,
        username: resolvedUsername,
      })
      .select("*")
      .single();

    if (!error && data) {
      clearPendingProfile(firebaseUid);
      return data;
    }

    const code = getErrorCode(error);
    const message = getErrorMessage(error).toLowerCase();
    const isUniqueViolation = code === "23505" || message.includes("duplicate key");

    if (!isUniqueViolation) {
      throw error;
    }

    if (message.includes("username")) {
      resolvedUsername = await resolveAvailableUsername(`${resolvedUsername}_${attempt + 2}`);
      continue;
    }

    if (message.includes("email") || message.includes("firebase_uid")) {
      const recovered = (await getUserByFirebaseUid(firebaseUid)) ?? (await getUserByEmail(normalizedEmail));
      if (recovered) {
        clearPendingProfile(firebaseUid);
        return recovered;
      }
    }

    throw error;
  }

  throw new Error("Could not ensure user record.");
}
