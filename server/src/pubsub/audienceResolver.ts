import type { SupabaseClient } from "@supabase/supabase-js";
import type { GatewaySubscription } from "../protocol/dispatch";

interface CachedValue<TValue> {
  expiresAt: number;
  value: TValue;
}

function nowMs(): number {
  return Date.now();
}

export class AudienceResolver {
  private readonly cacheTtlMs: number;
  private readonly conversationAccessCache = new Map<string, CachedValue<boolean>>();
  private readonly friendWatchersCache = new Map<string, CachedValue<string[]>>();

  constructor(
    private readonly supabase: SupabaseClient,
    cacheTtlMs = 30_000,
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  async canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    const cacheKey = `${userId}:${conversationId}`;
    const cached = this.conversationAccessCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs()) {
      return cached.value;
    }

    const directResult = await this.supabase
      .from("conversations")
      .select("id,user1_id,user2_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (!directResult.error && directResult.data) {
      const allowed =
        String(directResult.data.user1_id ?? "") === userId || String(directResult.data.user2_id ?? "") === userId;
      this.conversationAccessCache.set(cacheKey, {
        expiresAt: nowMs() + this.cacheTtlMs,
        value: allowed,
      });
      return allowed;
    }

    const memberResult = await this.supabase
      .from("conversation_members")
      .select("conversation_id,user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    const allowed =
      !memberResult.error &&
      memberResult.data !== null &&
      String(memberResult.data.conversation_id ?? "") === conversationId;
    this.conversationAccessCache.set(cacheKey, {
      expiresAt: nowMs() + this.cacheTtlMs,
      value: allowed,
    });
    return allowed;
  }

  async getPresenceWatcherTargets(userId: string): Promise<GatewaySubscription[]> {
    const cached = this.friendWatchersCache.get(userId);
    if (cached && cached.expiresAt > nowMs()) {
      return cached.value.map((watcherId) => ({ type: "friends", id: watcherId }));
    }

    const { data, error } = await this.supabase
      .from("friend_requests")
      .select("requester_id,addressee_id,status")
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .eq("status", "accepted");

    if (error) {
      return [];
    }

    const watcherIds = Array.from(
      new Set(
        (data ?? [])
          .map((row) => {
            const requesterId = String(row.requester_id ?? "");
            const addresseeId = String(row.addressee_id ?? "");
            return requesterId === userId ? addresseeId : requesterId;
          })
          .filter(Boolean),
      ),
    );

    this.friendWatchersCache.set(userId, {
      expiresAt: nowMs() + this.cacheTtlMs,
      value: watcherIds,
    });

    return watcherIds.map((watcherId) => ({
      type: "friends",
      id: watcherId,
    }));
  }
}
