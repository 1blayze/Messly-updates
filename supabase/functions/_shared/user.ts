import { HttpError } from "./http.ts";
import { getSupabaseAdminClient } from "./supabaseAdmin.ts";

interface UserRow {
  id: string;
  firebase_uid?: string | null;
  email?: string | null;
}

interface ConversationRow {
  id: string;
}

interface CachedValue<T> {
  value: T;
  expiresAtMs: number;
}

const USER_ID_CACHE_TTL_MS = 5 * 60_000;
const MEMBERSHIP_CACHE_TTL_MS = 45_000;
const userIdByFirebaseUidCache = new Map<string, CachedValue<string>>();
const conversationMembershipCache = new Map<string, CachedValue<true>>();

function normalizeEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

function getCachedValue<T>(map: Map<string, CachedValue<T>>, key: string): T | null {
  const now = Date.now();
  const cached = map.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAtMs <= now) {
    map.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedValue<T>(map: Map<string, CachedValue<T>>, key: string, value: T, ttlMs: number): void {
  map.set(key, {
    value,
    expiresAtMs: Date.now() + ttlMs,
  });
}

export async function resolveUserIdByFirebaseUid(firebaseUid: string, email?: string | null): Promise<string> {
  const cachedUserId = getCachedValue(userIdByFirebaseUidCache, firebaseUid);
  if (cachedUserId) {
    return cachedUserId;
  }

  const supabase = getSupabaseAdminClient();
  const { data: uidData, error: uidError } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .limit(1)
    .maybeSingle();

  if (uidError) {
    throw new HttpError(500, "USER_RESOLUTION_FAILED", "Falha ao resolver usuario autenticado.");
  }

  const uidRow = uidData as UserRow | null;
  if (uidRow?.id) {
    setCachedValue(userIdByFirebaseUidCache, firebaseUid, uidRow.id, USER_ID_CACHE_TTL_MS);
    return uidRow.id;
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new HttpError(403, "USER_NOT_MAPPED", "Usuario Firebase nao vinculado na tabela users.");
  }

  const { data: emailData, error: emailError } = await supabase
    .from("users")
    .select("id,firebase_uid")
    .eq("email", normalizedEmail)
    .limit(1)
    .maybeSingle();

  if (emailError) {
    throw new HttpError(500, "USER_RESOLUTION_FAILED", "Falha ao resolver usuario autenticado.");
  }

  const emailRow = emailData as UserRow | null;
  if (!emailRow?.id) {
    throw new HttpError(403, "USER_NOT_MAPPED", "Usuario Firebase nao vinculado na tabela users.");
  }

  const mappedFirebaseUid = String(emailRow.firebase_uid ?? "").trim();
  if (mappedFirebaseUid && mappedFirebaseUid !== firebaseUid) {
    throw new HttpError(403, "USER_LINK_CONFLICT", "Este e-mail ja esta vinculado a outra conta.");
  }

  if (!mappedFirebaseUid) {
    const { error: linkError } = await supabase
      .from("users")
      .update({
        firebase_uid: firebaseUid,
      })
      .eq("id", emailRow.id);

    if (linkError) {
      const message = String(linkError.message ?? "").toLowerCase();
      const code = String((linkError as { code?: string }).code ?? "").trim();
      if (code === "23505" || message.includes("duplicate key") || message.includes("firebase_uid")) {
        throw new HttpError(403, "USER_LINK_CONFLICT", "Este e-mail ja esta vinculado a outra conta.");
      }
      throw new HttpError(500, "USER_LINK_FAILED", "Falha ao vincular usuario Firebase.");
    }
  }

  setCachedValue(userIdByFirebaseUidCache, firebaseUid, emailRow.id, USER_ID_CACHE_TTL_MS);
  return emailRow.id;
}

export async function assertConversationMembership(conversationId: string, userId: string): Promise<void> {
  const cacheKey = `${conversationId}:${userId}`;
  const cachedMembership = getCachedValue(conversationMembershipCache, cacheKey);
  if (cachedMembership) {
    return;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "CONVERSATION_AUTH_FAILED", "Falha ao validar permissao da conversa.");
  }

  const row = data as ConversationRow | null;
  if (!row?.id) {
    throw new HttpError(403, "FORBIDDEN", "Usuario sem permissao para esta conversa.");
  }

  setCachedValue(conversationMembershipCache, cacheKey, true, MEMBERSHIP_CACHE_TTL_MS);
}
