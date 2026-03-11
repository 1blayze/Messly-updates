import {
  deleteChatMessage,
  editChatMessage,
  listChatMessages,
  sendChatMessage,
  type ChatAttachmentMetadata,
  type ChatMessagePayload,
  type MessageListCursor,
  type ReplySnapshot,
  type SendableChatMessageType,
} from "../services/chat/chatApi";
import { mapChatMessageToEntity, type MessageEntity } from "../stores/entities";

export async function listConversationMessages(params: {
  conversationId: string;
  limit?: number;
  cursor?: MessageListCursor | null;
}): Promise<MessageEntity[]> {
  const response = await listChatMessages({
    conversationId: params.conversationId,
    limit: params.limit,
    cursor: params.cursor ?? null,
  });

  return response.messages.map((message) => mapChatMessageToEntity(message));
}

export async function sendConversationMessage(params: {
  conversationId: string;
  clientId: string;
  type: SendableChatMessageType;
  content?: string | null;
  replyToId?: string | null;
  replyToSnapshot?: ReplySnapshot | null;
  attachment?: ChatAttachmentMetadata | null;
  payload?: ChatMessagePayload | null;
}): Promise<MessageEntity> {
  const message = await sendChatMessage(params);
  return mapChatMessageToEntity(message);
}

export async function editConversationMessage(messageId: string, content: string): Promise<MessageEntity> {
  const message = await editChatMessage(messageId, content);
  return mapChatMessageToEntity(message);
}

export async function deleteConversationMessage(messageId: string): Promise<MessageEntity> {
  const message = await deleteChatMessage(messageId);
  return mapChatMessageToEntity(message);
}
