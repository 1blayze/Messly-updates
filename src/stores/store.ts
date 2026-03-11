import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux";
import { authReducer } from "./authSlice";
import { conversationsReducer } from "./conversationsSlice";
import { friendsReducer } from "./friendsSlice";
import { gatewayReducer } from "./gatewaySlice";
import { messagesReducer } from "./messagesSlice";
import { notificationsReducer } from "./notificationsSlice";
import { presenceReducer } from "./presenceSlice";
import { profilesReducer } from "./profilesSlice";

export const messlyStore = configureStore({
  reducer: {
    auth: authReducer,
    gateway: gatewayReducer,
    messages: messagesReducer,
    presence: presenceReducer,
    friends: friendsReducer,
    conversations: conversationsReducer,
    notifications: notificationsReducer,
    profiles: profilesReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }),
  devTools: import.meta.env.DEV,
});

export type RootState = ReturnType<typeof messlyStore.getState>;
export type AppDispatch = typeof messlyStore.dispatch;
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
