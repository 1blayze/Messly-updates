import { supabase } from "./supabase";
import { isDirectUsersRestBlocked } from "./supabase";
import { authService } from "./auth";
import { getCachedValue, setCachedValue } from "./indexedCache";
import {
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
  validateUsername,
} from "../shared/username";

export const RESERVED_USERNAMES = new Set([
  "admin",
  "support",
  "root",
  "system",
  "messly",
  "staff",
  "owner",
  "mod",
]);

export interface UsernameValidationResult {
  isValid: boolean;
  hasUppercase: boolean;
  message: string | null;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function sanitizeDisplayName(displayName: string): string {
  return displayName.trim().replace(/\s+/g, " ");
}

async function hasSupabaseSession(): Promise<boolean> {
  try {
    return Boolean(await authService.getCurrentAccessToken());
  } catch {
    return false;
  }
}

export function validateUsernameInput(rawUsername: string): UsernameValidationResult {
  const normalized = normalizeUsername(rawUsername);
  const hasUppercase = /[A-Z]/.test(rawUsername);

  if (!normalized) {
    return { isValid: false, hasUppercase, message: "Informe um nome de usuario." };
  }

  if (RESERVED_USERNAMES.has(normalized)) {
    return { isValid: false, hasUppercase, message: "Esse nome de usuario esta reservado." };
  }

  const result = validateUsername(normalized);
  return {
    isValid: result.isValid,
    hasUppercase,
    message: result.message ?? null,
  };
}

function isTableMissing(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST114" || status === 404 || message.includes("not found");
}

function isAuthRequiredError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  return status === 401 || status === 403;
}

export async function isUsernameAvailable(username: string, _options: { requireRemote?: boolean } = {}): Promise<boolean> {
  const normalized = normalizeUsername(username);
  const validation = validateUsernameInput(normalized);
  if (!validation.isValid) {
    return false;
  }

  const sessionAvailable = await hasSupabaseSession();
  // Sign-up runs before login; keep optimistic to avoid false "username already in use".
  if (!sessionAvailable || isDirectUsersRestBlocked()) {
    return true;
  }

  const cacheKey = `username:${normalized}`;
  try {
    const cached = await getCachedValue<boolean>(cacheKey);
    if (typeof cached === "boolean") {
      return cached;
    }
  } catch {
    // cache is optional
  }

  try {
    const { count, error } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("username", normalized);

    if (error) {
      throw error;
    }

    const available = !count || count === 0;
    try {
      await setCachedValue(cacheKey, available, 30_000);
    } catch {
      // cache is optional
    }
    return available;
  } catch (error) {
    if (isAuthRequiredError(error) || isTableMissing(error)) {
      return true;
    }
    // Fallback remains optimistic; backend enforces uniqueness at write time.
    return true;
  }
}

export async function isEmailAvailable(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }

  const sessionAvailable = await hasSupabaseSession();
  if (isDirectUsersRestBlocked() || !sessionAvailable) {
    return true;
  }

  const cacheKey = `email:${normalized}`;
  try {
    const cached = await getCachedValue<boolean>(cacheKey);
    if (typeof cached === "boolean") {
      return cached;
    }
  } catch {
    // cache is optional
  }

  try {
    const { data, error } = await supabase.from("profiles").select("id").eq("email", normalized).limit(1);
    if (error) {
      throw error;
    }

    const available = (data?.length ?? 0) === 0;
    try {
      await setCachedValue(cacheKey, available, 30_000);
    } catch {
      // cache is optional
    }

    return available;
  } catch {
    // Fallback otimista; a validacao final ainda ocorre nas etapas seguintes.
    return true;
  }
}

export { USERNAME_REGEX, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH };
