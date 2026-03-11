import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { NotificationEntity } from "./entities";

const notificationsAdapter = createEntityAdapter<NotificationEntity, string>({
  selectId: (notification) => notification.id,
  sortComparer: (left, right) => {
    return left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0;
  },
});

export type NotificationsState = EntityState<NotificationEntity, string>;

const initialState: NotificationsState = notificationsAdapter.getInitialState();

const notificationsSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    notificationQueued(state, action: PayloadAction<NotificationEntity>) {
      notificationsAdapter.addOne(state, action.payload);
    },
    notificationDelivered(state, action: PayloadAction<string>) {
      const notification = state.entities[action.payload];
      if (notification) {
        notification.deliveredAt = new Date().toISOString();
      }
    },
    notificationsReset() {
      return initialState;
    },
  },
});

export const notificationsActions = notificationsSlice.actions;
export const notificationsReducer = notificationsSlice.reducer;
export const notificationsAdapterSelectors = notificationsAdapter.getSelectors<{ notifications: NotificationsState }>(
  (state) => state.notifications,
);
