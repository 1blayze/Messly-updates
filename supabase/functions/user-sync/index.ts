/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken, type FirebaseAuthContext } from "../_shared/auth.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseError,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";

const ROUTE = "user-sync";
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "support",
  "root",
  "system",
  "messly",
  "staff",
  "owner",
  "mod",
]);

const inputSchema = z
  .object({
    username: z.string().max(64).optional().nullable(),
    displayName: z.string().max(120).optional().nullable(),
  })
  .strict();

type InputPayload = z.infer<typeof inputSchema>;

interface UserRow {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  avatar_key?: string | null;
  banner_key?: string | null;
  avatar_hash?: string | null;
  banner_hash?: string | null;
  avatar_url?: string | null;
  about?: string | null;
  status?: string | null;
  last_active?: string | null;
  firebase_uid?: string | null;
  public_id?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  spotify_connection?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface EnsureUserResult {
  user: UserRow;
  created: boolean;
  linkedByEmail: boolean;
}

function parsePayload(payload: unknown): InputPayload {
  const parsed = inputSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload inválido.", {
    issues: parsed.error.issues.map((issue: { path: PropertyKey[]; message: string; code: string }) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  });
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = String(email ?? "").trim().toLowerCase();
  return normalized || null;
}

function sanitizeDisplayName(displayName: string | null | undefined): string | null {
  const value = String(displayName ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return value || null;
}

function normalizeUsernameSeed(seed: string | null | undefined): string {
  const normalized = String(seed ?? "")
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

function deriveUsernameFromUid(firebaseUid: string): string {
  const compactUid = String(firebaseUid ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  const candidate = `user_${compactUid}`;
  if (candidate.length >= 3) {
    return candidate.slice(0, 20);
  }

  return "user_000";
}

function buildUsernameCandidate(baseSeed: string, attempt: number): string {
  const suffix = attempt === 0 ? "" : `_${attempt + 1}`;
  const maxBaseLength = 20 - suffix.length;
  const base = baseSeed.slice(0, Math.max(3, maxBaseLength));
  return `${base}${suffix}`;
}

function isDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = String((error as { code?: string }).code ?? "").trim();
  const message = String((error as { message?: string }).message ?? "").toLowerCase();
  return code === "23505" || message.includes("duplicate key");
}

function referencesColumn(error: unknown, column: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = String((error as { message?: string }).message ?? "").toLowerCase();
  const rawDetails = (error as { details?: unknown }).details;
  const details =
    typeof rawDetails === "string"
      ? rawDetails.toLowerCase()
      : JSON.stringify(rawDetails ?? "").toLowerCase();
  const target = column.toLowerCase();
  return message.includes(target) || details.includes(target);
}

async function queryByFirebaseUid(firebaseUid: string): Promise<UserRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("firebase_uid", firebaseUid)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "USER_LOOKUP_FAILED", "Falha ao consultar usuário por firebase_uid.");
  }

  return (data as UserRow | null) ?? null;
}

async function queryByEmail(email: string): Promise<UserRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "USER_LOOKUP_FAILED", "Falha ao consultar usuário por email.");
  }

  return (data as UserRow | null) ?? null;
}

async function isUsernameAvailable(candidate: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("username", candidate)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "USERNAME_LOOKUP_FAILED", "Falha ao validar disponibilidade de username.");
  }

  return !(data as { id?: string } | null)?.id;
}

async function resolveUniqueUsername(seed: string | null | undefined, firebaseUid: string): Promise<string> {
  const baseSeed = normalizeUsernameSeed(seed) || deriveUsernameFromUid(firebaseUid);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = buildUsernameCandidate(baseSeed, attempt);
    if (!USERNAME_REGEX.test(candidate) || RESERVED_USERNAMES.has(candidate)) {
      continue;
    }

    const available = await isUsernameAvailable(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new HttpError(409, "USERNAME_UNAVAILABLE", "Não foi possível reservar um username único.");
}

async function updateUserById(userId: string, updates: Record<string, unknown>): Promise<UserRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(500, "USER_UPDATE_FAILED", "Falha ao atualizar usuário.");
  }

  return data as UserRow;
}

async function insertUser(values: Record<string, unknown>): Promise<UserRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .insert(values)
    .select("*")
    .single();

  if (error || !data) {
    if (isDuplicateError(error)) {
      throw new HttpError(409, "USER_DUPLICATE", "Conflito ao criar usuário.", {
        message: String((error as { message?: string }).message ?? ""),
        code: String((error as { code?: string }).code ?? ""),
      });
    }
    throw new HttpError(500, "USER_INSERT_FAILED", "Falha ao criar usuário.");
  }

  return data as UserRow;
}

async function ensureUserRecord(auth: FirebaseAuthContext, payload: InputPayload): Promise<EnsureUserResult> {
  const firebaseUid = String(auth.uid ?? "").trim();
  const normalizedEmail = normalizeEmail(auth.email);
  const desiredDisplayName = sanitizeDisplayName(payload.displayName);
  const desiredUsernameSeed = payload.username
    ? normalizeUsernameSeed(payload.username)
    : deriveUsernameFromUid(firebaseUid);
  const nowIso = new Date().toISOString();

  if (!firebaseUid) {
    throw new HttpError(401, "UNAUTHENTICATED", "Usuário não autenticado.");
  }

  const existingByUid = await queryByFirebaseUid(firebaseUid);
  if (existingByUid) {
    const updates: Record<string, unknown> = {
      last_active: nowIso,
    };

    if ((!existingByUid.display_name || !existingByUid.display_name.trim()) && desiredDisplayName) {
      updates.display_name = desiredDisplayName;
    }

    if ((!existingByUid.email || !existingByUid.email.trim()) && normalizedEmail) {
      updates.email = normalizedEmail;
    }

    if (!existingByUid.username || !existingByUid.username.trim()) {
      updates.username = await resolveUniqueUsername(desiredUsernameSeed, firebaseUid);
    }

    const updated = await updateUserById(existingByUid.id, updates);
    return {
      user: updated,
      created: false,
      linkedByEmail: false,
    };
  }

  if (normalizedEmail) {
    const existingByEmail = await queryByEmail(normalizedEmail);
    if (existingByEmail) {
      const linkedFirebaseUid = String(existingByEmail.firebase_uid ?? "").trim();
      if (linkedFirebaseUid && linkedFirebaseUid !== firebaseUid) {
        throw new HttpError(409, "EMAIL_ALREADY_LINKED", "Este e-mail já está vinculado a outra conta.");
      }

      const updates: Record<string, unknown> = {
        firebase_uid: firebaseUid,
        last_active: nowIso,
      };

      if ((!existingByEmail.display_name || !existingByEmail.display_name.trim()) && desiredDisplayName) {
        updates.display_name = desiredDisplayName;
      }

      if (!existingByEmail.username || !existingByEmail.username.trim()) {
        updates.username = await resolveUniqueUsername(desiredUsernameSeed, firebaseUid);
      }

      const updated = await updateUserById(existingByEmail.id, updates);
      return {
        user: updated,
        created: false,
        linkedByEmail: true,
      };
    }
  }

  let username = await resolveUniqueUsername(desiredUsernameSeed, firebaseUid);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const createdUser = await insertUser({
        firebase_uid: firebaseUid,
        email: normalizedEmail,
        username,
        display_name: desiredDisplayName,
        // Must match users_status_chk in Postgres.
        status: "invisible",
        last_active: nowIso,
      });

      return {
        user: createdUser,
        created: true,
        linkedByEmail: false,
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "USER_DUPLICATE") {
        throw error;
      }

      if (referencesColumn(error, "username")) {
        username = await resolveUniqueUsername(`${username}_${attempt + 2}`, firebaseUid);
        continue;
      }

      const recoveredByUid = await queryByFirebaseUid(firebaseUid);
      if (recoveredByUid) {
        return {
          user: recoveredByUid,
          created: false,
          linkedByEmail: false,
        };
      }

      if (normalizedEmail) {
        const recoveredByEmail = await queryByEmail(normalizedEmail);
        if (recoveredByEmail) {
          const linkedFirebaseUid = String(recoveredByEmail.firebase_uid ?? "").trim();
          if (!linkedFirebaseUid || linkedFirebaseUid === firebaseUid) {
            if (!linkedFirebaseUid) {
              const linked = await updateUserById(recoveredByEmail.id, {
                firebase_uid: firebaseUid,
                last_active: nowIso,
              });
              return {
                user: linked,
                created: false,
                linkedByEmail: true,
              };
            }
            return {
              user: recoveredByEmail,
              created: false,
              linkedByEmail: true,
            };
          }
        }
      }

      throw error;
    }
  }

  throw new HttpError(500, "USER_SYNC_FAILED", "Não foi possível sincronizar usuário.");
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");

    const auth = await validateSupabaseToken(request);
    context.uid = auth.uid;
    context.action = "sync";

    await enforceRateLimit(`sync:${auth.uid}`, 40, 60_000, ROUTE, {
      action: "sync",
    });

    const rawPayload = await parseJsonBody<unknown>(request);
    const payload = parsePayload(rawPayload);

    const result = await ensureUserRecord(auth, payload);
    logStructured("info", "user_sync_success", context, {
      status: 200,
      created: result.created,
      linkedByEmail: result.linkedByEmail,
      userId: result.user.id,
    });

    return responseJson(
      request,
      {
        user: result.user,
        created: result.created,
        linkedByEmail: result.linkedByEmail,
      },
      200,
    );
  } catch (error) {
    logStructured("error", "user_sync_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseError(request, context, error);
  }
});
