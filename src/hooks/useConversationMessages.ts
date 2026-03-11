import { useEffect } from "react";
import { messagesService } from "../services/messages";
import { useAppSelector } from "../stores/store";

export function useConversationMessages(conversationId: string | null | undefined) {
  const normalizedConversationId = String(conversationId ?? "").trim();

  useEffect(() => {
    if (!normalizedConversationId) {
      return;
    }
    void messagesService.hydrateConversation(normalizedConversationId);
  }, [normalizedConversationId]);

  return useAppSelector((state) => {
    const messageIds = state.messages.idsByConversationId[normalizedConversationId];
    if (!messageIds?.length) {
      return [];
    }
    return messageIds.map((id) => state.messages.entities[id]).filter(Boolean);
  });
}
