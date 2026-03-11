import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { UserPresenceEntity } from "./entities";

const presenceAdapter = createEntityAdapter<UserPresenceEntity, string>({
  selectId: (presence) => presence.userId,
  sortComparer: (left, right) => {
    const leftUpdated = left.updatedAt ?? "";
    const rightUpdated = right.updatedAt ?? "";
    return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : 0;
  },
});

export type PresenceStateStore = EntityState<UserPresenceEntity, string>;

const initialState: PresenceStateStore = presenceAdapter.getInitialState();

const presenceSlice = createSlice({
  name: "presence",
  initialState,
  reducers: {
    presenceHydrated(state, action: PayloadAction<UserPresenceEntity[]>) {
      presenceAdapter.setAll(state, action.payload);
    },
    presenceUpserted(state, action: PayloadAction<UserPresenceEntity>) {
      presenceAdapter.upsertOne(state, action.payload);
    },
    presenceRemoved(state, action: PayloadAction<string>) {
      presenceAdapter.removeOne(state, action.payload);
    },
    presenceReset() {
      return initialState;
    },
  },
});

export const presenceActions = presenceSlice.actions;
export const presenceReducer = presenceSlice.reducer;
export const presenceAdapterSelectors = presenceAdapter.getSelectors<{ presence: PresenceStateStore }>((state) => state.presence);
