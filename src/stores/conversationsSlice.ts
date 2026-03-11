import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { ConversationEntity } from "./entities";

export interface ConversationsState {
  ids: string[];
  entities: Record<string, ConversationEntity>;
  activeConversationId: string | null;
}

const conversationsAdapter = createEntityAdapter<ConversationEntity, string>({
  selectId: (conversation) => conversation.id,
  sortComparer: (left, right) => {
    const leftUpdated = left.updatedAt ?? left.lastMessageAt ?? "";
    const rightUpdated = right.updatedAt ?? right.lastMessageAt ?? "";
    return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : 0;
  },
});

const initialState: ConversationsState = conversationsAdapter.getInitialState({
  activeConversationId: null,
}) as ConversationsState;

function ensureConversation(
  state: ConversationsState,
  conversationId: string,
): ConversationEntity {
  if (!state.entities[conversationId]) {
    conversationsAdapter.addOne(state as EntityState<ConversationEntity, string>, {
      id: conversationId,
      scopeType: "dm",
      scopeId: conversationId,
      participantIds: [],
      lastMessageId: null,
      lastMessageAt: null,
      unreadCount: 0,
      typingUserIds: [],
      updatedAt: null,
    });
  }
  return state.entities[conversationId] as ConversationEntity;
}

const conversationsSlice = createSlice({
  name: "conversations",
  initialState,
  reducers: {
    conversationsHydrated(state, action: PayloadAction<ConversationEntity[]>) {
      conversationsAdapter.setAll(state as EntityState<ConversationEntity, string>, action.payload);
    },
    conversationUpserted(
      state,
      action: PayloadAction<Partial<ConversationEntity> & Pick<ConversationEntity, "id">>,
    ) {
      const current = ensureConversation(state, action.payload.id);
      conversationsAdapter.upsertOne(state as EntityState<ConversationEntity, string>, {
        ...current,
        ...action.payload,
      });
    },
    conversationLastMessageUpdated(
      state,
      action: PayloadAction<{
        conversationId: string;
        lastMessageId: string;
        lastMessageAt: string;
        incrementUnread?: boolean;
      }>,
    ) {
      const conversation = ensureConversation(state, action.payload.conversationId);
      conversation.lastMessageId = action.payload.lastMessageId;
      conversation.lastMessageAt = action.payload.lastMessageAt;
      conversation.updatedAt = action.payload.lastMessageAt;
      if (action.payload.incrementUnread && state.activeConversationId !== action.payload.conversationId) {
        conversation.unreadCount += 1;
      }
    },
    conversationTypingUpdated(
      state,
      action: PayloadAction<{
        conversationId: string;
        userId: string;
        isTyping: boolean;
      }>,
    ) {
      const conversation = ensureConversation(state, action.payload.conversationId);
      const nextTypingUserIds = new Set(conversation.typingUserIds);
      if (action.payload.isTyping) {
        nextTypingUserIds.add(action.payload.userId);
      } else {
        nextTypingUserIds.delete(action.payload.userId);
      }
      conversation.typingUserIds = [...nextTypingUserIds];
    },
    activeConversationChanged(state, action: PayloadAction<string | null>) {
      state.activeConversationId = action.payload;
      if (action.payload && state.entities[action.payload]) {
        state.entities[action.payload].unreadCount = 0;
      }
    },
    conversationsReset() {
      return initialState;
    },
  },
});

export const conversationsActions = conversationsSlice.actions;
export const conversationsReducer = conversationsSlice.reducer;
export const conversationsAdapterSelectors = conversationsAdapter.getSelectors<{ conversations: ConversationsState }>(
  (state) => state.conversations,
);
