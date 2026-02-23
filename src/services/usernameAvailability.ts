import { supabase } from "./supabase";
import { getCachedValue, setCachedValue } from "./indexedCache";

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

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

export function validateUsernameInput(rawUsername: string): UsernameValidationResult {
  const username = rawUsername.trim();
  const hasUppercase = /[A-Z]/.test(username);

  if (!username) {
    return {
      isValid: false,
      hasUppercase,
      message: "Informe um username.",
    };
  }

  if (hasUppercase) {
    return {
      isValid: false,
      hasUppercase,
      message: "Use apenas letras minusculas, numeros e underscore.",
    };
  }

  if (!USERNAME_REGEX.test(username)) {
    return {
      isValid: false,
      hasUppercase,
      message: "Use de 3 a 20 caracteres com letras minusculas, numeros e underscore.",
    };
  }

  if (RESERVED_USERNAMES.has(username)) {
    return {
      isValid: false,
      hasUppercase,
      message: "Esse username esta reservado.",
    };
  }

  return {
    isValid: true,
    hasUppercase,
    message: null,
  };
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const normalized = username.trim();
  const validation = validateUsernameInput(normalized);
  if (!validation.isValid) {
    return false;
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
    const escaped = escapeLikePattern(normalized);
    const { data, error } = await supabase.from("users").select("id").ilike("username", escaped).limit(1);
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
    // Fallback otimista para não bloquear UX quando a checagem remota falha.
    return true;
  }
}

export async function isEmailAvailable(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
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
    const escaped = escapeLikePattern(normalized);
    const { data, error } = await supabase.from("users").select("id").ilike("email", escaped).limit(1);
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
    // Fallback otimista; a validação final ainda ocorre nas etapas seguintes.
    return true;
  }
}
