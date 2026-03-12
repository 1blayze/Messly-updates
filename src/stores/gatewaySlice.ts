import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { GatewaySubscription } from "../gateway/protocol";

export type GatewayConnectionStatus =
  | "idle"
  | "disabled"
  | "unauthenticated"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface GatewayState {
  status: GatewayConnectionStatus;
  sessionId: string | null;
  seq: number | null;
  latencyMs: number | null;
  reconnectAttempt: number;
  lastError: string | null;
  lastConnectedAt: string | null;
  subscriptions: GatewaySubscription[];
}

const initialState: GatewayState = {
  status: "idle",
  sessionId: null,
  seq: null,
  latencyMs: null,
  reconnectAttempt: 0,
  lastError: null,
  lastConnectedAt: null,
  subscriptions: [],
};

const gatewaySlice = createSlice({
  name: "gateway",
  initialState,
  reducers: {
    gatewayStateChanged(
      state,
      action: PayloadAction<{
        status: GatewayConnectionStatus;
        reconnectAttempt?: number;
        lastError?: string | null;
      }>,
    ) {
      state.status = action.payload.status;
      state.reconnectAttempt = action.payload.reconnectAttempt ?? state.reconnectAttempt;
      state.lastError = action.payload.lastError ?? null;
      if (action.payload.status === "connected") {
        state.lastConnectedAt = new Date().toISOString();
      }
    },
    gatewayLatencyUpdated(state, action: PayloadAction<number | null>) {
      state.latencyMs = action.payload;
    },
    gatewaySessionUpdated(
      state,
      action: PayloadAction<{
        sessionId: string | null;
        seq: number | null;
      }>,
    ) {
      state.sessionId = action.payload.sessionId;
      state.seq = action.payload.seq;
    },
    gatewaySubscriptionsReplaced(state, action: PayloadAction<GatewaySubscription[]>) {
      state.subscriptions = action.payload;
    },
    gatewaySubscriptionAdded(state, action: PayloadAction<GatewaySubscription>) {
      const exists = state.subscriptions.some((subscription) => {
        return subscription.type === action.payload.type && subscription.id === action.payload.id;
      });
      if (!exists) {
        state.subscriptions.push(action.payload);
      }
    },
    gatewaySubscriptionRemoved(state, action: PayloadAction<GatewaySubscription>) {
      state.subscriptions = state.subscriptions.filter((subscription) => {
        return !(subscription.type === action.payload.type && subscription.id === action.payload.id);
      });
    },
    gatewayReset() {
      return initialState;
    },
  },
});

export const gatewayActions = gatewaySlice.actions;
export const gatewayReducer = gatewaySlice.reducer;
