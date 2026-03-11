import type { UnknownAction } from "@reduxjs/toolkit";
import type {
  GatewayMessageDeleteDispatchPayload,
  GatewayMessageDispatchPayload,
} from "../gateway/protocol";
import type { ConversationScopeType, NotificationEntity } from "../stores/entities";
import { conversationsActions } from "../stores/conversationsSlice";
import { messagesActions } from "../stores/messagesSlice";
import { notificationsActions } from "../stores/notificationsSlice";
import { profilesActions } from "../stores/profilesSlice";
import { createClientNonce } from "../utils/ids";

interface MessageEventContext {
  currentUserId: string | null;
}

function buildAuthorDisplayName(payload: GatewayMessageDispatchPayload): {
  title: string;
  avatarUrl: string | null;
} {
  const authorProfile = payload.profiles?.find((profile) => profile.id === payload.message.senderId);
  return {
    title: authorProfile?.displayName ?? authorProfile?.username ?? "Nova mensagem",
    avatarUrl: authorProfile?.avatarUrl ?? null,
  };
}

function resolveNotificationConversationType(
  scopeTypeRaw: ConversationScopeType | string | null | undefined,
): "dm" | "group" | "channel" | "guild" | "voice" | "unknown" {
  const scopeType = String(scopeTypeRaw ?? "").trim().toLowerCase();
  if (scopeType === "dm") {
    return "dm";
  }
  if (scopeType === "channel") {
    return "channel";
  }
  if (scopeType === "guild") {
    return "guild";
  }
  if (scopeType === "voice") {
    return "voice";
  }
  if (scopeType === "group") {
    return "group";
  }
  return "unknown";
}

function resolveNotificationContextLabel(conversationType: "dm" | "group" | "channel" | "guild" | "voice" | "unknown"): string | null {
  if (conversationType === "dm") {
    return null;
  }
  if (conversationType === "channel") {
    return "Canal";
  }
  if (conversationType === "guild") {
    return "Servidor";
  }
  if (conversationType === "voice") {
    return "Canal de voz";
  }
  if (conversationType === "group") {
    return "Grupo";
  }
  return "Conversa";
}

export function buildMessageCreateActions(
  payload: GatewayMessageDispatchPayload,
  context: MessageEventContext,
): UnknownAction[] {
  const actions: UnknownAction[] = [];

  if (payload.profiles?.length) {
    actions.push(profilesActions.profilesUpserted(payload.profiles));
  }
  if (payload.conversation?.id) {
    actions.push(
      conversationsActions.conversationUpserted({
        ...payload.conversation,
        id: payload.conversation.id,
      }),
    );
  }

  actions.push(
    messagesActions.messagesUpserted({
      conversationId: payload.message.conversationId,
      messages: [payload.message],
    }),
  );
  actions.push(
    conversationsActions.conversationLastMessageUpdated({
      conversationId: payload.message.conversationId,
      lastMessageId: payload.message.id,
      lastMessageAt: payload.message.createdAt,
      incrementUnread: payload.message.senderId !== context.currentUserId,
    }),
  );

  if (payload.message.senderId !== context.currentUserId) {
    const author = buildAuthorDisplayName(payload);
    const conversationType = resolveNotificationConversationType(payload.conversation?.scopeType);
    const notificationPayload: NotificationEntity = {
      id: createClientNonce("notification"),
      eventId: payload.message.id,
      source: "gateway",
      type: "message" as const,
      conversationId: payload.message.conversationId,
      messageId: payload.message.id,
      authorId: payload.message.senderId,
      title: author.title,
      body: payload.message.content.trim(),
      avatarUrl: author.avatarUrl,
      conversationType,
      contextLabel: resolveNotificationContextLabel(conversationType),
      messageType: payload.message.type,
      attachmentMimeType: payload.message.attachment?.mimeType ?? null,
      attachmentCount: payload.message.attachment ? 1 : 0,
      muted: false,
      createdAt: payload.message.createdAt,
      deliveredAt: null,
    };

    if (import.meta.env.DEV) {
      console.debug("[notifications:gateway] queued", {
        conversationId: notificationPayload.conversationId,
        messageId: notificationPayload.messageId,
        authorId: notificationPayload.authorId,
      });
    }

    actions.push(
      notificationsActions.notificationQueued(notificationPayload),
    );
  }

  return actions;
}

export function buildMessageUpdateActions(payload: GatewayMessageDispatchPayload): UnknownAction[] {
  const actions: UnknownAction[] = [];
  if (payload.profiles?.length) {
    actions.push(profilesActions.profilesUpserted(payload.profiles));
  }
  actions.push(
    messagesActions.messagesUpserted({
      conversationId: payload.message.conversationId,
      messages: [payload.message],
    }),
  );
  return actions;
}

export function buildMessageDeleteActions(payload: GatewayMessageDeleteDispatchPayload): UnknownAction[] {
  return [
    messagesActions.messageRemoved({
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    }),
  ];
}
