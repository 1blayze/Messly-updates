import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type DomainConversationSummary,
  type DomainEvent,
  type DomainEventPayloadMap,
  type DomainFriendRequest,
  type GatewayDomainEventType,
  type MessageDispatchPayload,
  normalizeEventIdentity,
} from "../events/eventTypes";
import type { EventBus } from "../events/eventBus";
import { FanoutService } from "../fanout/fanoutService";
import { PresenceService, type PresenceSnapshot } from "../presence/presenceService";
import { TypingService } from "../typing/typingService";

function safeString(value: unknown): string {
  return String(value ?? "").trim();
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

interface RealtimePostgresPayload {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

export class RealtimeCore {
  readonly typing: TypingService;
  private unsubscribeBus: (() => void) | null = null;
  private unsubscribeDb: (() => void) | null = null;
  private readonly profileCache = new Map<string, ReturnType<typeof toDomainProfile>>();

  constructor(
    private readonly eventBus: EventBus,
    private readonly fanout: FanoutService,
    private readonly presence: PresenceService,
    private readonly supabase?: SupabaseClient,
    typingTtlMs = 5_000,
  ) {
    this.typing = new TypingService(eventBus, typingTtlMs);
  }

  start(): void {
    this.unsubscribeBus = this.eventBus.subscribe((event) => {
      this.fanout.fanout(event);
    });

    if (this.supabase) {
      this.subscribeDbChannels(this.supabase);
    }
  }

  stop(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.unsubscribeDb?.();
    this.unsubscribeDb = null;
  }

  async publishPresence(snapshot: PresenceSnapshot): Promise<void> {
    const persisted = await this.presence.update(snapshot);
    const identity = normalizeEventIdentity("PRESENCE_UPDATE");
    await this.eventBus.publish({
      ...identity,
      event: "PRESENCE_UPDATE",
      scopeType: "dm",
      scopeId: persisted.userId,
      routingKey: `user:${persisted.userId}`,
      payload: {
        presence: persisted,
      },
      occurredAt: identity.occurredAt,
    });
  }

  async publishSpotify(userId: string, status: PresenceSnapshot["status"], activity: unknown): Promise<void> {
    const identity = normalizeEventIdentity("SPOTIFY_UPDATE");
    await this.eventBus.publish({
      ...identity,
      event: "SPOTIFY_UPDATE",
      scopeType: "dm",
      scopeId: userId,
      routingKey: `user:${userId}`,
      payload: {
        userId,
        status,
        activity: activity ?? null,
        updatedAt: new Date().toISOString(),
      },
      occurredAt: identity.occurredAt,
    });
  }

  private subscribeDbChannels(supabase: SupabaseClient): void {
    const messagesChannel = supabase
      .channel("messly.gateway.messages")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (change) => {
          void this.handleMessageChange(change as unknown as RealtimePostgresPayload);
        },
      )
      .subscribe();

    const friendChannel = supabase
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

    const scope: DomainConversationSummary = {
      id: conversationId,
      scopeType: "dm",
      scopeId: conversationId,
    };

    const messageId = safeString(record.id);
    const deletedAt = safeString(record.deleted_at);
    const isSoftDelete = change.eventType === "UPDATE" && Boolean(deletedAt);

    if (!messageId) {
      return;
    }

    if (change.eventType === "DELETE" || isSoftDelete) {
      const identity = normalizeEventIdentity("MESSAGE_DELETE");
      await this.eventBus.publish({
        ...identity,
        event: "MESSAGE_DELETE",
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        routingKey: `conversation:${conversationId}`,
        payload: {
          conversationId,
          messageId,
          deletedAt: deletedAt || new Date().toISOString(),
        },
        occurredAt: identity.occurredAt,
      });
      return;
    }

    const message = this.mapMessageRow(conversationId, record);
    if (!message) {
      return;
    }

    const profiles = await this.resolveProfiles(safeString(message.senderId));
    const eventType = change.eventType === "INSERT" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE";
    const identity = normalizeEventIdentity(eventType);
    const event: DomainEvent = {
      ...identity,
      event: eventType,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      routingKey: `conversation:${conversationId}`,
      payload: {
        message,
        conversation: scope,
        profiles,
      } as MessageDispatchPayload,
      occurredAt: identity.occurredAt,
    } as DomainEvent<GatewayDomainEventType>;

    await this.eventBus.publish(event);
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
    const mergedProfiles = [...profiles, ...profileB];
    const identity = normalizeEventIdentity(eventType);

    await this.eventBus.publish({
      ...identity,
      event: eventType,
      scopeType: "dm",
      scopeId: request.requesterId,
      routingKey: `user:${request.requesterId}`,
      payload: {
        request,
        profiles: mergedProfiles,
      },
      occurredAt: identity.occurredAt,
    } as DomainEvent<GatewayDomainEventType>);
  }

  private mapMessageRow(
    conversationId: string,
    row: Record<string, unknown>,
  ): MessageDispatchPayload["message"] | null {
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
      attachment: typeof row.attachment === "object" && row.attachment !== null ? (row.attachment as Record<string, unknown>) : null,
      deliveryState: "sent",
      errorMessage: null,
    };
  }

  private mapFriendRequestRow(row: Record<string, unknown> | null): DomainFriendRequest | null {
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

  private async resolveProfiles(userId: string): Promise<Array<DomainEventPayloadMap["FRIEND_REQUEST_CREATE"]["profiles"][0]>> {
    if (!userId) {
      return [];
    }

    const cached = this.profileCache.get(userId);
    if (cached) {
      return [cached];
    }

    if (!this.supabase) {
      return [];
    }

    const { data } = await this.supabase.from("profiles").select("id,username,display_name,avatar_url,banner_url,bio,updated_at").eq("id", userId).maybeSingle();
    if (!data) {
      return [];
    }

    const mapped = toDomainProfile(data as unknown as CommandProfile);
    this.profileCache.set(userId, mapped);
    return [mapped];
  }
}
