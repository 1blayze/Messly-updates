import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type AuthStatus = "bootstrapping" | "signed_out" | "verification_pending" | "authenticated";

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  emailVerified: boolean;
  expiresAt: number | null;
  pendingVerificationEmail: string | null;
  lastError: string | null;
}

const initialState: AuthState = {
  status: "bootstrapping",
  userId: null,
  email: null,
  emailVerified: false,
  expiresAt: null,
  pendingVerificationEmail: null,
  lastError: null,
};

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    authBootstrapStarted(state) {
      state.status = "bootstrapping";
      state.lastError = null;
    },
    authSessionChanged(
      state,
      action: PayloadAction<{
        userId: string;
        email: string | null;
        emailVerified: boolean;
        expiresAt: number | null;
      }>,
    ) {
      state.status = "authenticated";
      state.userId = action.payload.userId;
      state.email = action.payload.email;
      state.emailVerified = action.payload.emailVerified;
      state.expiresAt = action.payload.expiresAt;
      state.pendingVerificationEmail = null;
      state.lastError = null;
    },
    authVerificationRequired(state, action: PayloadAction<{ email: string }>) {
      state.status = "verification_pending";
      state.pendingVerificationEmail = action.payload.email;
      state.userId = null;
      state.email = action.payload.email;
      state.emailVerified = false;
      state.expiresAt = null;
      state.lastError = null;
    },
    authSignedOut(state) {
      state.status = "signed_out";
      state.userId = null;
      state.email = null;
      state.emailVerified = false;
      state.expiresAt = null;
      state.pendingVerificationEmail = null;
      state.lastError = null;
    },
    authErrorChanged(state, action: PayloadAction<string | null>) {
      state.lastError = action.payload;
    },
  },
});

export const authActions = authSlice.actions;
export const authReducer = authSlice.reducer;
