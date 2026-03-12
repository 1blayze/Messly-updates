import type { Session } from "@supabase/supabase-js";
import appPackage from "../../package.json";
import {
  AuthApiError,
  buildAuthClientDescriptor,
  login as loginRequest,
  logout as logoutRequest,
  resendVerification as resendVerificationRequest,
  signup as signupRequest,
  verifyEmail as verifyEmailRequest,
  type AuthClientDescriptor,
} from "../api/authApi";
import { getRuntimeAppApiUrl, getRuntimeAuthApiUrl } from "../config/runtimeApiConfig";
import { supabase, supabaseUrl } from "../lib/supabaseClient";
import {
  clearAccessToken,
  getAccessToken,
  getCurrentUserId as getCurrentUserIdFromStore,
  getInMemorySession,
  setInMemorySession,
} from "./auth/authStore";
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from "./auth/refreshTokenStorage";
import { getSecureJson, removeSecureItem, setSecureJson } from "./auth/secureStorage";

const PENDING_VERIFICATION_KEY = "messly.auth.pending-verification";
const LEGACY_SESSION_STORAGE_KEY = "messly.auth.session";
const SESSION_REFRESH_BUFFER_MS = 30_000;
const EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS = 15_000;

let refreshSessionPromise: Promise<Session | null> | null = null;
let authStateSyncInitialized = false;
let legacySessionCleanupStarted = false;
let lastValidatedEdgeAccessToken: { token: string; validatedAt: number } | null = null;

export interface PendingVerificationState {
  email: string;
  expiresAt: string | null;
  maxAttempts: number | null;
  createdAt: number;
}

export interface SignupInput {
  email: string;
  password: string;
  turnstileToken: string;
  registrationFingerprint: string;
  profile?: {
    displayName?: string | null;
    username?: string | null;
  };
}

function resolveClientDescriptor(): AuthClientDescriptor {
  const descriptor = buildAuthClientDescriptor();
  return {
    ...descriptor,
    version: String(descriptor.version || appPackage.version || "0.0.5"),
  };
}

async function setPendingVerificationState(state: PendingVerificationState | null): Promise<void> {
  if (!state) {
    await removeSecureItem(PENDING_VERIFICATION_KEY);
    return;
  }

  await setSecureJson(PENDING_VERIFICATION_KEY, state);
}

function isSessionExpiringSoon(session: Session | null): boolean {
  const expiresAt = typeof session?.expires_at === "number" ? session.expires_at * 1000 : 0;
  return !expiresAt || expiresAt <= Date.now() + SESSION_REFRESH_BUFFER_MS;
}

function isLikelyJwt(tokenRaw: string | null | undefined): boolean {
  const token = String(tokenRaw ?? "").trim();
  if (!token) {
    return false;
  }
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function isInvalidRefreshTokenError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const name = String((error as { name?: unknown } | null)?.name ?? "").trim();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  const combined = `${code} ${name} ${message}`;

  return (
    name === "AuthSessionMissingError" ||
    status === 400 ||
    status === 401 ||
    status === 403 ||
    code === "INVALID_REFRESH_TOKEN" ||
    code === "REFRESH_TOKEN_NOT_FOUND" ||
    code === "SESSION_NOT_FOUND" ||
    code === "INVALID_GRANT" ||
    code === "OTP_REQUIRED" ||
    message.includes("refresh token") ||
    message.includes("refresh-token") ||
    message.includes("invalid grant") ||
    message.includes("session not found") ||
    message.includes("session from session_id claim in jwt does not exist") ||
    message.includes("session_id claim") ||
    message.includes("token has expired") ||
    message.includes("token expired") ||
    combined.includes("refresh token has expired")
  );
}

function isSupabaseSessionCorruptedError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();
  const details = String((error as { details?: unknown } | null)?.details ?? "").trim().toLowerCase();

  const combined = `${code} ${message} ${details}`;
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    code === "AUTH_SESSION_MISSING" ||
    code === "INVALID_JWT" ||
    code === "JWT_EXPIRED" ||
    code === "PGRST301" ||
    code === "SESSION_NOT_FOUND" ||
    combined.includes("invalid jwt") ||
    combined.includes("jwt expired") ||
    combined.includes("invalid session") ||
    combined.includes("session not found") ||
    combined.includes("session from session_id claim in jwt does not exist") ||
    combined.includes("session_id claim") ||
    combined.includes("session is invalid") ||
    combined.includes("not able to parse auth token")
  );
}

async function persistSessionState(session: Session | null, fallbackRefreshToken?: string | null): Promise<void> {
  setInMemorySession(session);
  lastValidatedEdgeAccessToken = null;
  await removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
  const nextRefreshToken = String(session?.refresh_token ?? fallbackRefreshToken ?? "").trim();
  if (nextRefreshToken) {
    await saveRefreshToken(nextRefreshToken);
    return;
  }
  await clearRefreshToken();
}

function clearSupabaseLocalSessionStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  let projectRef = "";
  try {
    projectRef = String(new URL(supabaseUrl).hostname.split(".")[0] ?? "").trim();
  } catch {
    projectRef = "";
  }

  const keyPatterns = [
    /^sb-[a-z0-9_-]+-auth-token$/i,
    /^sb-[a-z0-9_-]+-auth-token-code-verifier$/i,
  ];

  if (projectRef) {
    keyPatterns.push(new RegExp(`^sb-${projectRef}-auth-token$`, "i"));
    keyPatterns.push(new RegExp(`^sb-${projectRef}-auth-token-code-verifier$`, "i"));
  }

  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = String(window.localStorage.key(index) ?? "").trim();
      if (!key) {
        continue;
      }

      if (keyPatterns.some((pattern) => pattern.test(key))) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      window.localStorage.removeItem(key);
    });
  } catch {
    // Ignore storage access failures.
  }
}

async function clearSessionState(): Promise<void> {
  clearAccessToken();
  lastValidatedEdgeAccessToken = null;
  clearSupabaseLocalSessionStorage();
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  clearSupabaseLocalSessionStorage();
  await removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
  await clearRefreshToken();
}

async function readSupabaseClientSession(): Promise<Session | null> {
  try {
    const result = await supabase.auth.getSession();
    if (result.error) {
      if (isSupabaseSessionCorruptedError(result.error)) {
        await clearSessionState();
        return null;
      }
      throw result.error;
    }

    const session = result.data.session ?? null;
    if (session) {
      setInMemorySession(session);
    }
    return session;
  } catch (error) {
    if (isSupabaseSessionCorruptedError(error)) {
      await clearSessionState();
      return null;
    }
    throw error;
  }
}

function ensureLegacySessionCleanup(): void {
  if (legacySessionCleanupStarted) {
    return;
  }

  legacySessionCleanupStarted = true;
  void removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
}

async function shouldIgnoreNullInitialSession(): Promise<boolean> {
  const inMemorySession = getInMemorySession();
  if (inMemorySession && isLikelyJwt(inMemorySession.access_token)) {
    return true;
  }

  const storedRefreshToken = await loadRefreshToken().catch(() => null);
  return Boolean(String(storedRefreshToken ?? "").trim());
}

function ensureAuthStateSync(): void {
  if (authStateSyncInitialized) {
    return;
  }

  authStateSyncInitialized = true;
  ensureLegacySessionCleanup();
  supabase.auth.onAuthStateChange((event, nextSession) => {
    if (event === "INITIAL_SESSION" && !nextSession) {
      void shouldIgnoreNullInitialSession().then((shouldIgnore) => {
        if (!shouldIgnore) {
          setInMemorySession(null);
          lastValidatedEdgeAccessToken = null;
        }
      });
      return;
    }

    setInMemorySession(nextSession);
    lastValidatedEdgeAccessToken = null;

    if (nextSession?.refresh_token) {
      void saveRefreshToken(nextSession.refresh_token).catch(() => undefined);
      return;
    }

    if (event === "SIGNED_OUT") {
      void clearRefreshToken().catch(() => undefined);
    }
  });
}

function canUseDirectSupabaseAuthFallback(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }

  return String(import.meta.env.VITE_MESSLY_ALLOW_DIRECT_SUPABASE_AUTH_FALLBACK ?? "").trim().toLowerCase() === "true";
}

function shouldFallbackToDirectSupabaseLogin(error: unknown): boolean {
  if (!canUseDirectSupabaseAuthFallback()) {
    return false;
  }

  if (!(error instanceof AuthApiError)) {
    return false;
  }

  const code = String(error.code ?? "").trim().toUpperCase();
  if (code !== "AUTH_NETWORK_ERROR") {
    return false;
  }

  const details =
    error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? (error.details as { url?: unknown })
      : null;
  const failedUrl = String(details?.url ?? "").trim().toLowerCase();

  if (failedUrl.includes("localhost:8788") || failedUrl.includes("127.0.0.1:8788")) {
    return false;
  }

  return true;
}

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI);
}

function isInstalledDesktopRuntime(): boolean {
  if (!isDesktopRuntime()) {
    return false;
  }
  return Boolean(window.electronAPI?.isPackaged);
}

function shouldFallbackToDirectSupabaseSignup(error: unknown): boolean {
  if (isInstalledDesktopRuntime()) {
    return false;
  }
  return shouldFallbackToDirectSupabaseLogin(error);
}

function shouldPreferDirectSupabaseLogin(): boolean {
  if (!isDesktopRuntime()) {
    return false;
  }

  // Installed desktop must use API-based auth flow (Turnstile + verification code).
  if (isInstalledDesktopRuntime()) {
    return false;
  }

  const explicitAuthApiUrl = String(import.meta.env.VITE_MESSLY_AUTH_API_URL ?? "").trim();
  const explicitAppApiUrl = String(import.meta.env.VITE_MESSLY_API_URL ?? "").trim();
  return !explicitAuthApiUrl && !explicitAppApiUrl && !getRuntimeAuthApiUrl() && !getRuntimeAppApiUrl();
}

function shouldPreferDirectSupabaseSignup(): boolean {
  if (isInstalledDesktopRuntime()) {
    return false;
  }
  return shouldPreferDirectSupabaseLogin();
}

async function applyRemoteSession(accessToken: string, refreshToken: string): Promise<Session> {
  const sessionResult = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (sessionResult.error || !sessionResult.data.session) {
    throw sessionResult.error ?? new Error("Supabase session was not returned.");
  }
  const session = sessionResult.data.session;
  await persistSessionState(session, refreshToken);
  return session;
}

async function signInWithDirectSupabase(email: string, password: string): Promise<Session> {
  const signInResult = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInResult.error || !signInResult.data.session) {
    throw signInResult.error ?? new Error("Supabase session was not returned.");
  }

  const session = signInResult.data.session;
  await persistSessionState(session, session.refresh_token ?? null);
  return session;
}

async function signUpWithDirectSupabase(input: SignupInput): Promise<Session | null> {
  const metadata: Record<string, string> = {};
  const displayName = String(input.profile?.displayName ?? "").trim();
  const username = String(input.profile?.username ?? "").trim();
  if (displayName) {
    metadata.display_name = displayName;
  }
  if (username) {
    metadata.username = username;
  }

  const signUpResult = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: metadata,
    },
  });

  if (signUpResult.error) {
    throw signUpResult.error;
  }

  if (signUpResult.data.session) {
    const session = signUpResult.data.session;
    await persistSessionState(session, session.refresh_token ?? null);
    return session;
  }
  return null;
}

async function refreshSessionWithStoredToken(refreshTokenRaw?: string | null): Promise<Session | null> {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  refreshSessionPromise = (async () => {
    const fallbackRefreshToken = String(refreshTokenRaw ?? "").trim() || (await loadRefreshToken());
    if (!fallbackRefreshToken) {
      await clearSessionState();
      return null;
    }

    const result = await supabase.auth.refreshSession({
      refresh_token: fallbackRefreshToken,
    });

    if (result.error) {
      if (isInvalidRefreshTokenError(result.error)) {
        await clearSessionState();
        return null;
      }
      throw result.error;
    }

    const session = result.data.session ?? null;
    await persistSessionState(session, fallbackRefreshToken);
    return session;
  })();

  try {
    return await refreshSessionPromise;
  } finally {
    refreshSessionPromise = null;
  }
}

ensureAuthStateSync();

class AuthService {
  requiresSignupSecurityVerification(): boolean {
    return !shouldPreferDirectSupabaseSignup();
  }

  private canReuseValidatedEdgeAccessToken(accessTokenRaw: string | null | undefined): boolean {
    const accessToken = String(accessTokenRaw ?? "").trim();
    if (!accessToken || !lastValidatedEdgeAccessToken) {
      return false;
    }

    return (
      lastValidatedEdgeAccessToken.token === accessToken &&
      Date.now() - lastValidatedEdgeAccessToken.validatedAt < EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS
    );
  }

  private markValidatedEdgeAccessToken(accessTokenRaw: string | null | undefined): void {
    const accessToken = String(accessTokenRaw ?? "").trim();
    if (!accessToken) {
      lastValidatedEdgeAccessToken = null;
      return;
    }

    lastValidatedEdgeAccessToken = {
      token: accessToken,
      validatedAt: Date.now(),
    };
  }

  private async isAccessTokenAcceptedBySupabase(accessTokenRaw: string | null | undefined): Promise<boolean> {
    const accessToken = String(accessTokenRaw ?? "").trim();
    if (!isLikelyJwt(accessToken)) {
      return false;
    }

    if (this.canReuseValidatedEdgeAccessToken(accessToken)) {
      return true;
    }

    try {
      const result = await supabase.auth.getUser(accessToken);
      const accepted = !result.error && Boolean(result.data.user?.id);
      if (accepted) {
        this.markValidatedEdgeAccessToken(accessToken);
        return true;
      }

      if (isSupabaseSessionCorruptedError(result.error)) {
        await clearSessionState();
      }
      if (lastValidatedEdgeAccessToken?.token === accessToken) {
        lastValidatedEdgeAccessToken = null;
      }
      return false;
    } catch (error) {
      if (isSupabaseSessionCorruptedError(error)) {
        await clearSessionState();
        if (lastValidatedEdgeAccessToken?.token === accessToken) {
          lastValidatedEdgeAccessToken = null;
        }
        return false;
      }
      throw error;
    }
  }

  async signup(input: SignupInput): Promise<PendingVerificationState> {
    if (shouldPreferDirectSupabaseSignup()) {
      await signUpWithDirectSupabase(input);
      await setPendingVerificationState(null);
      return {
        email: input.email,
        expiresAt: null,
        maxAttempts: null,
        createdAt: Date.now(),
      };
    }

    let response;
    try {
      response = await signupRequest({
        email: input.email,
        password: input.password,
        turnstileToken: input.turnstileToken,
        registrationFingerprint: input.registrationFingerprint,
        profile: input.profile,
        client: resolveClientDescriptor(),
      });
    } catch (error) {
      if (!shouldFallbackToDirectSupabaseSignup(error)) {
        throw error;
      }
      await signUpWithDirectSupabase(input);
      await setPendingVerificationState(null);
      return {
        email: input.email,
        expiresAt: null,
        maxAttempts: null,
        createdAt: Date.now(),
      };
    }

    const state: PendingVerificationState = {
      email: response.email,
      expiresAt: response.expires_at ?? null,
      maxAttempts: response.max_attempts ?? null,
      createdAt: Date.now(),
    };
    await setPendingVerificationState(state);
    return state;
  }

  async resendVerification(emailRaw?: string | null): Promise<PendingVerificationState> {
    const current = await this.getPendingVerification();
    const email = String(emailRaw ?? current?.email ?? "").trim();
    if (!email) {
      throw new Error("Pending verification email is missing.");
    }

    const response = await resendVerificationRequest(email);
    const state: PendingVerificationState = {
      email: response.email,
      expiresAt: response.expires_at ?? null,
      maxAttempts: response.max_attempts ?? null,
      createdAt: Date.now(),
    };
    await setPendingVerificationState(state);
    return state;
  }

  async verifyEmailCode(email: string, code: string): Promise<Session> {
    const response = await verifyEmailRequest({
      email,
      code,
      client: resolveClientDescriptor(),
    });
    const session = await applyRemoteSession(response.access_token, response.refresh_token);
    await setPendingVerificationState(null);
    return session;
  }

  async login(email: string, password: string): Promise<Session> {
    if (shouldPreferDirectSupabaseLogin()) {
      const session = await signInWithDirectSupabase(email, password);
      await setPendingVerificationState(null);
      return session;
    }

    let session: Session;
    try {
      const response = await loginRequest({
        email,
        password,
        client: resolveClientDescriptor(),
      });
      session = await applyRemoteSession(response.access_token, response.refresh_token);

      const remoteAccessTokenAccepted = await this.isAccessTokenAcceptedBySupabase(session.access_token);
      if (!remoteAccessTokenAccepted) {
        await clearSessionState();
        session = await signInWithDirectSupabase(email, password);
      }
    } catch (error) {
      const canFallbackToDirectSupabase =
        shouldFallbackToDirectSupabaseLogin(error) ||
        (!(error instanceof AuthApiError) && isSupabaseSessionCorruptedError(error));
      if (!canFallbackToDirectSupabase) {
        throw error;
      }
      await clearSessionState().catch(() => undefined);
      session = await signInWithDirectSupabase(email, password);
    }

    await setPendingVerificationState(null);
    return session;
  }

  async logout(): Promise<void> {
    const currentSession = getInMemorySession() ?? (await this.getCurrentSession());
    const accessToken = String(currentSession?.access_token ?? "").trim();

    if (accessToken && !shouldPreferDirectSupabaseLogin()) {
      try {
        await logoutRequest(accessToken);
      } catch {
        // Best effort only. Local sign-out still runs below.
      }
    }

    const localSignOut = await supabase.auth.signOut({ scope: "local" });
    if (localSignOut.error) {
      throw localSignOut.error;
    }
    await clearSessionState();
    await setPendingVerificationState(null);
  }

  async clearLocalSession(): Promise<void> {
    await clearSessionState();
    await setPendingVerificationState(null);
  }

  async refreshSession(): Promise<Session | null> {
    const currentSession = getInMemorySession();
    const supabaseSession = await readSupabaseClientSession();
    const refreshToken =
      String(currentSession?.refresh_token ?? "").trim() ||
      String(supabaseSession?.refresh_token ?? "").trim() ||
      (await loadRefreshToken());
    if (!refreshToken) {
      await clearSessionState();
      return null;
    }

    const nextSession = await refreshSessionWithStoredToken(refreshToken);
    if (nextSession?.access_token && !isLikelyJwt(nextSession.access_token)) {
      await clearSessionState();
      return null;
    }
    return nextSession;
  }

  async getCurrentSession(): Promise<Session | null> {
    const currentSession = getInMemorySession();
    if (currentSession && isLikelyJwt(currentSession.access_token) && !isSessionExpiringSoon(currentSession)) {
      return currentSession;
    }

    const supabaseSession = await readSupabaseClientSession();
    if (supabaseSession && isLikelyJwt(supabaseSession.access_token) && !isSessionExpiringSoon(supabaseSession)) {
      return supabaseSession;
    }

    const refreshToken =
      String(currentSession?.refresh_token ?? "").trim() ||
      String(supabaseSession?.refresh_token ?? "").trim();

    if (refreshToken) {
      return refreshSessionWithStoredToken(refreshToken);
    }

    return refreshSessionWithStoredToken();
  }

  async getCurrentAccessToken(): Promise<string | null> {
    const currentSession = getInMemorySession();
    const currentAccessToken = String(currentSession?.access_token ?? "").trim();
    if (currentAccessToken && isLikelyJwt(currentAccessToken) && !isSessionExpiringSoon(currentSession)) {
      return currentAccessToken;
    }

    const session = await this.getCurrentSession();
    const accessToken = String(session?.access_token ?? "").trim();
    return isLikelyJwt(accessToken) ? accessToken : null;
  }

  async getValidatedEdgeAccessToken(): Promise<string | null> {
    const currentAccessToken = await this.getCurrentAccessToken();
    if (await this.isAccessTokenAcceptedBySupabase(currentAccessToken)) {
      return currentAccessToken;
    }

    let refreshedSession: Session | null;
    try {
      refreshedSession = await this.refreshSession();
    } catch {
      await clearSessionState();
      return null;
    }
    const refreshedAccessToken = String(refreshedSession?.access_token ?? "").trim();
    if (await this.isAccessTokenAcceptedBySupabase(refreshedAccessToken)) {
      return refreshedAccessToken;
    }

    await clearSessionState();
    return null;
  }

  async getCurrentUserId(): Promise<string | null> {
    const currentUserId = getCurrentUserIdFromStore();
    if (currentUserId) {
      return currentUserId;
    }

    const session = await this.getCurrentSession();
    return String(session?.user?.id ?? "").trim() || null;
  }

  async hasStoredSessionHint(): Promise<boolean> {
    const memorySession = getInMemorySession();
    const memoryAccessToken = String(memorySession?.access_token ?? "").trim();
    const memoryRefreshToken = String(memorySession?.refresh_token ?? "").trim();
    if (isLikelyJwt(memoryAccessToken) || Boolean(memoryRefreshToken)) {
      return true;
    }

    const clientSession = await readSupabaseClientSession();
    const clientAccessToken = String(clientSession?.access_token ?? "").trim();
    const clientRefreshToken = String(clientSession?.refresh_token ?? "").trim();
    if (isLikelyJwt(clientAccessToken) || Boolean(clientRefreshToken)) {
      return true;
    }

    const storedRefreshToken = await loadRefreshToken();
    return Boolean(String(storedRefreshToken ?? "").trim());
  }

  async getPendingVerification(): Promise<PendingVerificationState | null> {
    return getSecureJson<PendingVerificationState>(PENDING_VERIFICATION_KEY);
  }
}

export const authService = new AuthService();
