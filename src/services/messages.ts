import { ensureDirectConversation, listUserConversations } from "../api/conversationsApi";
import { deleteMedia } from "../api/mediaController";
import {
  deleteConversationMessage,
  editConversationMessage,
  listConversationMessages,
  sendConversationMessage,
} from "../api/messagesApi";
import { readCachedConversationMessages, writeCachedConversationMessages, writeCachedConversations } from "../realtime/cache";
import { conversationsActions } from "../stores/conversationsSlice";
import type { MessageEntity } from "../stores/entities";
import { messagesActions } from "../stores/messagesSlice";
import { messlyStore } from "../stores/store";
import { createClientNonce } from "../utils/ids";
import { gatewayService } from "./gateway";
import type { SendableChatMessageType } from "./chat/chatApi";

class MessagesService {
  async hydrateConversations(currentUserId: string): Promise<void> {
    const conversations = await listUserConversations(currentUserId);
    messlyStore.dispatch(conversationsActions.conversationsHydrated(conversations));
    await writeCachedConversations(Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])));
  }

  async hydrateConversation(conversationId: string): Promise<void> {
    gatewayService.subscribeConversation(conversationId);

    const cached = await readCachedConversationMessages(conversationId);
    if (cached?.length) {
      messlyStore.dispatch(
        messagesActions.messagesHydrated({
          conversationId,
          messages: cached,
        }),
      );
    }

    const messages = await listConversationMessages({
      conversationId,
      limit: 50,
    });
    messlyStore.dispatch(
      messagesActions.messagesHydrated({
        conversationId,
        messages,
      }),
    );
    await writeCachedConversationMessages(conversationId, messages);
  }

  async ensureDirectConversation(currentUserId: string, otherUserId: string): Promise<string> {
    const conversation = await ensureDirectConversation(currentUserId, otherUserId);
    messlyStore.dispatch(conversationsActions.conversationUpserted(conversation));
    gatewayService.subscribeConversation(conversation.id);
    return conversation.id;
  }

  async sendMessage(params: {
    conversationId: string;
    content: string;
    type?: SendableChatMessageType;
  }): Promise<MessageEntity> {
    const currentUserId = gatewayService.getCurrentUserId();
    if (!currentUserId) {
      throw new Error("Usuario nao autenticado para enviar mensagem.");
    }

    const clientId = createClientNonce("message");
    const optimisticMessage: MessageEntity = {
      id: clientId,
      conversationId: params.conversationId,
      scopeType: "dm",
      scopeId: params.conversationId,
      senderId: currentUserId,
      clientId,
      content: params.content,
      type: params.type ?? "text",
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      replyToId: null,
      payload: null,
      attachment: null,
      deliveryState: "pending",
      errorMessage: null,
    };

    messlyStore.dispatch(
      messagesActions.messagesUpserted({
        conversationId: params.conversationId,
        messages: [optimisticMessage],
      }),
    );
    messlyStore.dispatch(
      conversationsActions.conversationLastMessageUpdated({
        conversationId: params.conversationId,
        lastMessageId: optimisticMessage.id,
        lastMessageAt: optimisticMessage.createdAt,
        incrementUnread: false,
      }),
    );

    try {
      const savedMessage = await sendConversationMessage({
        conversationId: params.conversationId,
        clientId,
        type: params.type ?? "text",
        content: params.content,
      });

      messlyStore.dispatch(
        messagesActions.messageRemoved({
          conversationId: params.conversationId,
          messageId: clientId,
        }),
      );
      messlyStore.dispatch(
        messagesActions.messagesUpserted({
          conversationId: params.conversationId,
          messages: [savedMessage],
        }),
      );
      messlyStore.dispatch(
        conversationsActions.conversationLastMessageUpdated({
          conversationId: params.conversationId,
          lastMessageId: savedMessage.id,
          lastMessageAt: savedMessage.createdAt,
          incrementUnread: false,
        }),
      );
      await this.persistConversationCache(params.conversationId);
      return savedMessage;
    } catch (error) {
      messlyStore.dispatch(
        messagesActions.messageDeliveryStateUpdated({
          conversationId: params.conversationId,
          messageId: clientId,
          deliveryState: "failed",
          errorMessage: error instanceof Error ? error.message : "Falha ao enviar mensagem.",
        }),
      );
      throw error;
    }
  }

  async editMessage(conversationId: string, messageId: string, content: string): Promise<MessageEntity> {
    const message = await editConversationMessage(messageId, content);
    messlyStore.dispatch(
      messagesActions.messagesUpserted({
        conversationId,
        messages: [message],
      }),
    );
    await this.persistConversationCache(conversationId);
    return message;
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<MessageEntity> {
    const message = await deleteConversationMessage(messageId);
    messlyStore.dispatch(
      messagesActions.messagesUpserted({
        conversationId,
        messages: [message],
      }),
    );
    await this.persistConversationCache(conversationId);

    const attachmentKeys = [
      String(message.attachment?.fileKey ?? "").trim(),
      String(message.attachment?.originalKey ?? "").trim(),
      String(message.attachment?.thumbKey ?? "").trim(),
    ].filter(Boolean);
    attachmentKeys.forEach((fileKey) => {
      void deleteMedia({ fileKey }).catch(() => undefined);
    });

    return message;
  }

  private async persistConversationCache(conversationId: string): Promise<void> {
    const state = messlyStore.getState().messages;
    const messageIds = state.idsByConversationId[conversationId];
    if (!messageIds?.length) {
      return;
    }
    const messages = messageIds.map((id) => state.entities[id]).filter(Boolean) as MessageEntity[];
    await writeCachedConversationMessages(conversationId, messages);
  }
}

export const messagesService = new MessagesService();
