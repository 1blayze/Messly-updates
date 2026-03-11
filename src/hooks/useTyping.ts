import { useAppSelector } from "../stores/store";

export function useTyping(conversationId: string | null | undefined): string[] {
  const normalizedConversationId = String(conversationId ?? "").trim();
  return useAppSelector((state) => {
    return state.conversations.entities[normalizedConversationId]?.typingUserIds ?? [];
  });
}
