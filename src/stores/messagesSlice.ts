import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { MessageEntity, MessageDeliveryState } from "./entities";
import { compareIsoTimestampsAsc } from "../utils/time";

function compareMessages(left: MessageEntity, right: MessageEntity): number {
  const createdOrder = compareIsoTimestampsAsc(left.createdAt, right.createdAt);
  if (createdOrder !== 0) {
    return createdOrder;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

const messagesAdapter = createEntityAdapter<MessageEntity, string>({
  selectId: (message) => message.id,
  sortComparer: compareMessages,
});

export interface MessagesState extends EntityState<MessageEntity, string> {
  idsByConversationId: Record<string, string[]>;
  hydratedConversationIds: Record<string, boolean>;
}

const initialState: MessagesState = messagesAdapter.getInitialState({
  idsByConversationId: {},
  hydratedConversationIds: {},
});

function rebuildConversationIndex(state: MessagesState, conversationId: string): void {
  state.idsByConversationId[conversationId] = state.ids
    .map((id) => state.entities[id])
    .filter((message): message is MessageEntity => Boolean(message) && message.conversationId === conversationId)
    .sort(compareMessages)
    .map((message) => message.id);
}

const messagesSlice = createSlice({
  name: "messages",
  initialState,
  reducers: {
    messagesHydrated(
      state,
      action: PayloadAction<{
        conversationId: string;
        messages: MessageEntity[];
      }>,
    ) {
      const existingIds = state.idsByConversationId[action.payload.conversationId] ?? [];
      messagesAdapter.removeMany(state, existingIds);
      messagesAdapter.upsertMany(state, action.payload.messages);
      rebuildConversationIndex(state, action.payload.conversationId);
      state.hydratedConversationIds[action.payload.conversationId] = true;
    },
    messagesUpserted(
      state,
      action: PayloadAction<{
        conversationId: string;
        messages: MessageEntity[];
      }>,
    ) {
      action.payload.messages.forEach((message) => {
        const existing = state.entities[message.id];
        messagesAdapter.upsertOne(state, existing ? { ...existing, ...message } : message);
      });
      rebuildConversationIndex(state, action.payload.conversationId);
    },
    messageRemoved(
      state,
      action: PayloadAction<{
        conversationId: string;
        messageId: string;
      }>,
    ) {
      if (!state.idsByConversationId[action.payload.conversationId]) {
        return;
      }

      messagesAdapter.removeOne(state, action.payload.messageId);
      rebuildConversationIndex(state, action.payload.conversationId);
    },
    messageDeliveryStateUpdated(
      state,
      action: PayloadAction<{
        conversationId: string;
        messageId: string;
        deliveryState: MessageDeliveryState;
        errorMessage?: string | null;
      }>,
    ) {
      const message = state.entities[action.payload.messageId];
      if (!message) {
        return;
      }

      message.deliveryState = action.payload.deliveryState;
      message.errorMessage = action.payload.errorMessage ?? null;
    },
    messagesReset() {
      return initialState;
    },
  },
});

export const messagesActions = messagesSlice.actions;
export const messagesReducer = messagesSlice.reducer;
export const messagesAdapterSelectors = messagesAdapter.getSelectors<{ messages: MessagesState }>((state) => state.messages);
