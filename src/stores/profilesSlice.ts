import { createEntityAdapter, createSlice, type EntityState, type PayloadAction } from "@reduxjs/toolkit";
import type { UserProfileEntity } from "./entities";

const profilesAdapter = createEntityAdapter<UserProfileEntity, string>({
  selectId: (profile) => profile.id,
  sortComparer: (left, right) => {
    const leftUpdated = left.updatedAt ?? "";
    const rightUpdated = right.updatedAt ?? "";
    return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : 0;
  },
});

export type ProfilesState = EntityState<UserProfileEntity, string>;

const initialState: ProfilesState = profilesAdapter.getInitialState();

const profilesSlice = createSlice({
  name: "profiles",
  initialState,
  reducers: {
    profilesHydrated(state, action: PayloadAction<UserProfileEntity[]>) {
      profilesAdapter.setAll(state, action.payload);
    },
    profileUpserted(state, action: PayloadAction<UserProfileEntity>) {
      profilesAdapter.upsertOne(state, action.payload);
    },
    profilesUpserted(state, action: PayloadAction<UserProfileEntity[]>) {
      profilesAdapter.upsertMany(state, action.payload);
    },
    profilesReset() {
      return initialState;
    },
  },
});

export const profilesActions = profilesSlice.actions;
export const profilesReducer = profilesSlice.reducer;
export const profilesAdapterSelectors = profilesAdapter.getSelectors<{ profiles: ProfilesState }>((state) => state.profiles);
