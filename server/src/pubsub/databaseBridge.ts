import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logging/logger";
import type { RedisLease } from "../redis/lease";
import type { DispatchPublisher } from "./dispatchPublisher";

interface RealtimePostgresPayload {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

interface CommandProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  bio: string | null;
  updated_at: string;
}

function safeString(value: unknown): string {
  return String(value ?? "").trim();
}

function toDomainProfile(row: CommandProfile) {
  return {
    id: row.id,
    username: row.username ?? "",
    displayName: row.display_name ?? "",
    avatarUrl: row.avatar_url ?? null,
    bannerUrl: row.banner_url ?? null,
    bio: row.bio ?? null,
    updatedAt: row.updated_at,
  };
}

export class SupabaseRealtimeBridge {
  private unsubscribeDb: (() => void) | null = null;
  private readonly profileCache = new Map<string, ReturnType<typeof toDomainProfile>>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly publisher: DispatchPublisher,
    private readonly lease: RedisLease,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.lease.start(
      async () => {
        await this.subscribeDbChannels();
      },
      async () => {
        this.unsubscribeDb?.();
        this.unsubscribeDb = null;
      },
    );
  }

  async stop(): Promise<void> {
    await this.lease.stop(async () => {
      this.unsubscribeDb?.();
      this.unsubscribeDb = null;
    });
  }

  private async subscribeDbChannels(): Promise<void> {
    if (this.unsubscribeDb) {
      return;
    }

    this.logger.info("realtime_bridge_subscribing");
    const messagesChannel = this.supabase
      .channel("messly.gateway.messages")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (change) => {
          void this.handleMessageChange(change as unknown as RealtimePostgresPayload);
        },
      )
      .subscribe();

    const friendChannel = this.supabase
      .channel("messly.gateway.friend_requests")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friend_requests" },
        (change) => {
          void this.handleFriendRequestChange(change as unknown as RealtimePostgresPayload);
        },
      )
      .subscribe();

    this.unsubscribeDb = () => {
      void messagesChannel.unsubscribe();
      void friendChannel.unsubscribe();
    };
  }

  private async handleMessageChange(change: RealtimePostgresPayload): Promise<void> {
    const row = (change.eventType === "DELETE" ? change.old : change.new) ?? null;
    const record = row ?? {};
    const conversationId = safeString(record.conversation_id);
    if (!conversationId) {
      return;
    }

    const messageId = safeString(record.id);
    const deletedAt = safeString(record.deleted_at);
    const isSoftDelete = change.eventType === "UPDATE" && Boolean(deletedAt);

    if (!messageId) {
      return;
    }

    if (change.eventType === "DELETE" || isSoftDelete) {
      await this.publisher.publishDispatch({
        event: "MESSAGE_DELETE",
        payload: {
          conversationId,
          messageId,
          deletedAt: deletedAt || new Date().toISOString(),
        },
        targets: [{ type: "conversation", id: conversationId }],
      });
      return;
    }

    const message = this.mapMessageRow(conversationId, record);
    if (!message) {
      return;
    }

    const profiles = await this.resolveProfiles(safeString(message.senderId));
    const eventType = change.eventType === "INSERT" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE";
    await this.publisher.publishDispatch({
      event: eventType,
      payload: {
        message,
        conversation: {
          id: conversationId,
          scopeType: "dm",
          scopeId: conversationId,
        },
        profiles,
      },
      targets: [{ type: "conversation", id: conversationId }],
    });
  }

  private async handleFriendRequestChange(change: RealtimePostgresPayload): Promise<void> {
    const row = (change.eventType === "DELETE" ? change.old : change.new) ?? null;
    const request = this.mapFriendRequestRow(row);
    if (!request) {
      return;
    }

    const eventType = request.status === "accepted" ? "FRIEND_REQUEST_ACCEPT" : "FRIEND_REQUEST_CREATE";
    const profiles = await this.resolveProfiles(request.requesterId);
    const profileB = await this.resolveProfiles(request.addresseeId);
    await this.publisher.publishDispatch({
      event: eventType,
      payload: {
        request,
        profiles: [...profiles, ...profileB],
      },
      targets: [
        { type: "user", id: request.requesterId },
        { type: "notifications", id: request.requesterId },
        { type: "user", id: request.addresseeId },
        { type: "notifications", id: request.addresseeId },
      ],
    });
  }

  private mapMessageRow(conversationId: string, row: Record<string, unknown>) {
    const id = safeString(row.id);
    const senderId = safeString(row.sender_id);
    if (!id || !senderId) {
      return null;
    }

    return {
      id,
      conversationId,
      scopeType: "dm",
      scopeId: conversationId,
      senderId,
      clientId: typeof row.client_id === "string" ? row.client_id : null,
      content: safeString(row.content),
      type: safeString(row.type) || "text",
      createdAt: safeString(row.created_at) || new Date().toISOString(),
      editedAt: typeof row.edited_at === "string" ? row.edited_at : null,
      deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : null,
      replyToId: typeof row.reply_to_id === "string" ? row.reply_to_id : null,
      payload: typeof row.payload === "object" && row.payload !== null ? (row.payload as Record<string, unknown>) : null,
      attachment:
        typeof row.attachment === "object" && row.attachment !== null ? (row.attachment as Record<string, unknown>) : null,
      deliveryState: "sent",
      errorMessage: null,
    };
  }

  private mapFriendRequestRow(row: Record<string, unknown> | null) {
    if (!row) {
      return null;
    }
    const id = safeString(row.id);
    const requesterId = safeString(row.requester_id);
    const addresseeId = safeString(row.addressee_id);
    if (!id || !requesterId || !addresseeId) {
      return null;
    }
    return {
      id,
      requesterId,
      addresseeId,
      status: safeString(row.status) || "pending",
      createdAt: safeString(row.created_at) || new Date().toISOString(),
    };
  }

  private async resolveProfiles(userId: string): Promise<Array<ReturnType<typeof toDomainProfile>>> {
    if (!userId) {
      return [];
    }

    const cached = this.profileCache.get(userId);
    if (cached) {
      return [cached];
    }

    const { data } = await this.supabase
      .from("profiles")
      .select("id,username,display_name,avatar_url,banner_url,bio,updated_at")
      .eq("id", userId)
      .maybeSingle();
    if (!data) {
      return [];
    }

    const mapped = toDomainProfile(data as unknown as CommandProfile);
    this.profileCache.set(userId, mapped);
    return [mapped];
  }
}
