import { supabase } from "../lib/supabaseClient";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_REGEX = /^[a-z0-9._]+$/;

export interface UsernameValidationResult {
  isValid: boolean;
  message?: string;
}

function stripSeparators(value: string): string {
  return value.replace(/^[._]+/, "").replace(/[._]+$/, "");
}

export function normalizeUsername(raw: string): string {
  const lowered = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");

  const cleaned = lowered
    .replace(/[^a-z0-9._]/g, "")
    .replace(/[._]{2,}/g, "."); // collapse repeated separators to keep it tidy

  return stripSeparators(cleaned).slice(0, USERNAME_MAX_LENGTH);
}

export function validateUsername(raw: string): UsernameValidationResult {
  const username = normalizeUsername(raw);

  if (!username) {
    return { isValid: false, message: "Informe um nome de usuário." };
  }

  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return {
      isValid: false,
      message: `Use entre ${USERNAME_MIN_LENGTH} e ${USERNAME_MAX_LENGTH} caracteres.`,
    };
  }

  if (!USERNAME_REGEX.test(username)) {
    return {
      isValid: false,
      message: "Use apenas letras minúsculas, números, ponto ou underscore.",
    };
  }

  return { isValid: true };
}

export function formatUsernameForDisplay(raw: string | null | undefined): string {
  const normalized = normalizeUsername(raw ?? "");
  return normalized ? `@${normalized}` : "";
}

export async function isUsernameAvailable(
  candidateRaw: string,
  options: { ignoreProfileId?: string | null } = {},
): Promise<boolean> {
  const candidate = normalizeUsername(candidateRaw);
  const validation = validateUsername(candidate);
  if (!validation.isValid) {
    return false;
  }

  const ignoreId = String(options.ignoreProfileId ?? "").trim() || null;
  const query = supabase.from("profiles").select("id").eq("username", candidate).limit(1);
  if (ignoreId) {
    query.neq("id", ignoreId);
  }

  const { data, error } = await query;
  if (error) {
    // In doubt, consider unavailable to avoid collisions; caller can retry.
    return false;
  }

  return (data?.length ?? 0) === 0;
}

export function buildUsernameSeedFromEmail(email: string): string {
  const localPart = String(email ?? "").split("@")[0] ?? "";
  const normalized = normalizeUsername(localPart);
  if (normalized.length >= USERNAME_MIN_LENGTH) {
    return normalized;
  }
  return "user";
}

export async function generateUniqueUsername(
  seedRaw: string,
  options: { maxAttempts?: number; ignoreProfileId?: string | null } = {},
): Promise<string> {
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Number(options.maxAttempts) : 25;
  const ignoreProfileId = options.ignoreProfileId ?? null;
  const baseSeed = normalizeUsername(seedRaw || "user");
  const base = baseSeed.length >= USERNAME_MIN_LENGTH ? baseSeed : "user";

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const suffix = attempt === 0 ? "" : `${attempt}`;
    const trimmedBase = base.slice(0, USERNAME_MAX_LENGTH - suffix.length);
    const candidate = `${trimmedBase}${suffix}`;

    if (!validateUsername(candidate).isValid) {
      continue;
    }

    const available = await isUsernameAvailable(candidate, { ignoreProfileId });
    if (available) {
      return candidate;
    }
  }

  throw new Error("Não foi possível gerar um nome de usuário único.");
}
