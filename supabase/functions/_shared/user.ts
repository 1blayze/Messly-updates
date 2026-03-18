import { HttpError } from "./http.ts";
import { getSupabaseAdminClient } from "./supabaseAdmin.ts";

interface ConversationRow {
  user1_id?: string | null;
  user2_id?: string | null;
}

interface ConversationParticipants {
  userIds: string[];
}

interface CachedValue<T> {
  value: T;
  expiresAtMs: number;
}

const MEMBERSHIP_CACHE_TTL_MS = 45_000;
const conversationMembershipCache = new Map<string, CachedValue<true>>();
const conversationParticipantsCache = new Map<string, CachedValue<ConversationParticipants>>();

function getCachedValue<T>(map: Map<string, CachedValue<T>>, key: string): T | null {
  const now = Date.now();
  const cached = map.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs <= now) {
    map.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedValue<T>(map: Map<string, CachedValue<T>>, key: string, value: T, ttlMs: number): void {
  map.set(key, { value, expiresAtMs: Date.now() + ttlMs });
}

function normalizeConversationParticipants(row: ConversationRow | null | undefined): ConversationParticipants | null {
  const userIds = Array.from(
    new Set(
      [
        String(row?.user1_id ?? "").trim(),
        String(row?.user2_id ?? "").trim(),
      ].filter((userId) => Boolean(userId)),
    ),
  );

  if (userIds.length === 0) {
    return null;
  }

  return { userIds };
}

export async function resolveUserId(authUid: string | null | undefined): Promise<string> {
  const userId = String(authUid ?? "").trim();
  if (!userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "SessÃƒÂ£o nÃƒÂ£o identificada.");
  }
  return userId;
}

async function loadConversationParticipantsForMember(
  conversationId: string,
  userId: string,
): Promise<ConversationParticipants> {
  const membershipCacheKey = `${conversationId}:${userId}`;
  const cachedMembership = getCachedValue(conversationMembershipCache, membershipCacheKey);
  const cachedParticipants = getCachedValue(conversationParticipantsCache, conversationId);
  if (cachedMembership && cachedParticipants) {
    return cachedParticipants;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("user1_id,user2_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "CONVERSATION_AUTH_FAILED", "Falha ao validar permissÃƒÂ£o da conversa.");
  }

  const participants = normalizeConversationParticipants(data as ConversationRow | null | undefined);
  if (!participants || !participants.userIds.includes(userId)) {
    throw new HttpError(403, "FORBIDDEN", "UsuÃƒÂ¡rio sem permissÃƒÂ£o para esta conversa.");
  }

  setCachedValue(conversationMembershipCache, membershipCacheKey, true, MEMBERSHIP_CACHE_TTL_MS);
  setCachedValue(conversationParticipantsCache, conversationId, participants, MEMBERSHIP_CACHE_TTL_MS);
  return participants;
}

export async function assertConversationMembership(conversationId: string, userId: string): Promise<void> {
  await loadConversationParticipantsForMember(conversationId, userId);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "t" || normalized === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

async function areUserIdsBlocked(user1Id: string, user2Id: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  const rpcResult = await supabase.rpc("user_ids_are_blocked", {
    user_a: user1Id,
    user_b: user2Id,
  });

  if (!rpcResult.error) {
    return toBoolean(rpcResult.data);
  }

  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocker_id,blocked_id")
    .or(
      `and(blocker_id.eq.${user1Id},blocked_id.eq.${user2Id}),and(blocker_id.eq.${user2Id},blocked_id.eq.${user1Id})`,
    )
    .limit(1);

  if (error) {
    throw new HttpError(500, "CONVERSATION_BLOCK_CHECK_FAILED", "Falha ao validar bloqueio da conversa.", {
      rpcCode: rpcResult.error.code ?? null,
      queryCode: error.code ?? null,
    });
  }

  return Array.isArray(data) && data.length > 0;
}

export async function assertConversationCanSendMessages(conversationId: string, userId: string): Promise<void> {
  const participants = await loadConversationParticipantsForMember(conversationId, userId);

  if (participants.userIds.length !== 2) {
    return;
  }

  const [user1Id, user2Id] = participants.userIds;
  if (await areUserIdsBlocked(user1Id, user2Id)) {
    throw new HttpError(403, "CONVERSATION_BLOCKED", "NÃƒÂ£o ÃƒÂ© possÃƒÂ­vel enviar mensagem para este usuÃƒÂ¡rio.");
  }
}

// Legacy no-op; kept for compatibility with callers expecting existence.
export async function upsertUserIdentity(): Promise<void> {
  return;
}
