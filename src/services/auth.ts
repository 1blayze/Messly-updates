import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
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
  type AuthTokenApiResponse,
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

/** ------------------------------------------------------------------------
 * Constantes
 * --------------------------------------------------------------------- */
const PENDING_VERIFICATION_KEY = "messly.auth.pending-verification";
const LEGACY_SESSION_STORAGE_KEY = "messly.auth.session";
const SESSION_REFRESH_BUFFER_MS = 30_000;
const EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS = 15_000;
const AUTH_SESSION_READ_TIMEOUT_MS = 8_000;
const AUTH_SESSION_REFRESH_TIMEOUT_MS = 10_000;
const AUTH_LOGIN_TIMEOUT_MS = 12_000;
const AUTH_TOKEN_VALIDATION_TIMEOUT_MS = 8_000;

/** ------------------------------------------------------------------------
 * Tipos
 * --------------------------------------------------------------------- */
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

interface NormalizedErrorInfo {
  status: number;
  code: string;
  name: string;
  message: string;
  details: string;
}

/** ------------------------------------------------------------------------
 * Helpers puros
 * --------------------------------------------------------------------- */
function resolveClientDescriptor(): AuthClientDescriptor {
  const descriptor = buildAuthClientDescriptor();
  return { ...descriptor, version: String(descriptor.version || appPackage.version || "0.0.5") };
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), Math.max(1_000, timeoutMs));
  });
  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function isBase64Url(str: string): boolean {
  return /^[A-Za-z0-9\-_]+$/.test(str) && str.length % 4 !== 1;
}

function isLikelyJwt(tokenRaw: string | null | undefined): tokenRaw is string {
  const token = String(tokenRaw ?? "").trim();
  if (!token) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0 && isBase64Url(p));
}

function normalizeErrorInfo(error: unknown): NormalizedErrorInfo {
  const toStr = (v: unknown) => (typeof v === "string" ? v : "");
  const statusCandidate = (error as { status?: unknown })?.status;
  const statusNum = typeof statusCandidate === "number" ? statusCandidate : Number(statusCandidate ?? 0);
  return {
    status: Number.isFinite(statusNum) ? statusNum : 0,
    code: toStr((error as { code?: unknown })?.code).toUpperCase(),
    name: toStr((error as { name?: unknown })?.name),
    message: toStr((error as { message?: unknown })?.message),
    details: toStr((error as { details?: unknown })?.details).toLowerCase(),
  };
}

function isInvalidRefreshTokenError(error: unknown): boolean {
  const { status, code, name, message, details } = normalizeErrorInfo(error);
  const combined = `${code} ${name} ${message} ${details}`.toLowerCase();
  return (
    name === "AuthSessionMissingError" ||
    [400, 401, 403].includes(status) ||
    ["INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_NOT_FOUND", "SESSION_NOT_FOUND", "INVALID_GRANT", "OTP_REQUIRED"].includes(code) ||
    combined.includes("refresh token") ||
    combined.includes("session not found") ||
    combined.includes("session_id claim") ||
    combined.includes("token expired") ||
    combined.includes("invalid grant")
  );
}

function isSupabaseSessionCorruptedError(error: unknown): boolean {
  const { status, code, message, details } = normalizeErrorInfo(error);
  const combined = `${code} ${message} ${details}`.toLowerCase();
  return (
    [400, 401, 403].includes(status) ||
    ["AUTH_SESSION_MISSING", "INVALID_JWT", "JWT_EXPIRED", "PGRST301", "SESSION_NOT_FOUND"].includes(code) ||
    combined.includes("invalid jwt") ||
    combined.includes("session not found") ||
    combined.includes("session_id claim") ||
    combined.includes("invalid session") ||
    combined.includes("not able to parse auth token")
  );
}

function shouldFallbackToDirectSupabaseLogin(error: unknown): boolean {
  const { status, code, message, details } = normalizeErrorInfo(error);
  const combined = `${code} ${message} ${details}`.toLowerCase();
  return (
    [502, 503, 504].includes(status) ||
    code === "ECONNREFUSED" ||
    combined.includes("fetch failed") ||
    combined.includes("network error")
  );
}

function shouldPreferDirectSupabaseLogin(): boolean {
  // Ambientes desktop empacotados podem exigir auth via API; mantemos flag de override.
  const flag = String(import.meta.env.VITE_MESSLY_ALLOW_DIRECT_SUPABASE_AUTH_FALLBACK ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

function shouldPreferDirectSupabaseSignup(): boolean {
  return shouldPreferDirectSupabaseLogin();
}

function isSessionExpiringSoon(session: Session | null): boolean {
  const expiresAt = typeof session?.expires_at === "number" ? session.expires_at * 1000 : 0;
  return !expiresAt || expiresAt <= Date.now() + SESSION_REFRESH_BUFFER_MS;
}

/** Limpa tokens do Supabase no localStorage (inclusive keys legadas). */
function clearSupabaseLocalSessionStorage(): void {
  if (typeof window === "undefined") return;
  let projectRef = "";
  try {
    projectRef = String(new URL(supabaseUrl).hostname.split(".")[0] ?? "").trim();
  } catch {
    projectRef = "";
  }
  const patterns = [
    /^sb-[a-z0-9_-]+-auth-token$/i,
    /^sb-[a-z0-9_-]+-auth-token-code-verifier$/i,
  ];
  if (projectRef) {
    patterns.push(new RegExp(`^sb-${projectRef}-auth-token$`, "i"));
    patterns.push(new RegExp(`^sb-${projectRef}-auth-token-code-verifier$`, "i"));
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = String(window.localStorage.key(i) ?? "");
      if (patterns.some((p) => p.test(key))) keys.push(key);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

async function setPendingVerificationState(state: PendingVerificationState | null): Promise<void> {
  if (!state) {
    await removeSecureItem(PENDING_VERIFICATION_KEY).catch(() => undefined);
    return;
  }
  await setSecureJson(PENDING_VERIFICATION_KEY, state);
}

/** ------------------------------------------------------------------------
 * AuthService
 * --------------------------------------------------------------------- */
class AuthService {
  private refreshSessionPromise: Promise<Session | null> | null = null;
  private edgeTokenCache: { token: string; validatedAt: number } | null = null;
  private authStateSyncInitialized = false;
  private legacySessionCleanupStarted = false;

  /* ------------------------ Infra interna ------------------------ */
  private async ensureLegacyCleanup(): Promise<void> {
    if (this.legacySessionCleanupStarted) return;
    this.legacySessionCleanupStarted = true;
    await removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
  }

  private initAuthStateSync(): void {
    if (this.authStateSyncInitialized) return;
    this.authStateSyncInitialized = true;
    void this.ensureLegacyCleanup();
    supabase.auth.onAuthStateChange((event: AuthChangeEvent, nextSession) => {
      if (event === "SIGNED_OUT") {
        void this.clearLocalSession();
        return;
      }
      if (event === "INITIAL_SESSION" && !nextSession) {
        // Não apaga store se houver refresh token persistido; evita logout indevido.
        void this.hasStoredSessionHint().then((hint) => {
          if (!hint) setInMemorySession(null);
        });
        return;
      }
      setInMemorySession(nextSession);
      this.edgeTokenCache = null;
      if (nextSession?.refresh_token) {
        void saveRefreshToken(nextSession.refresh_token).catch(() => undefined);
      }
    });
  }

  private async clearSessionState(): Promise<void> {
    setInMemorySession(null);
    this.edgeTokenCache = null;
    clearSupabaseLocalSessionStorage();
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    clearSupabaseLocalSessionStorage();
    await removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
    await clearRefreshToken();
    await clearAccessToken();
  }

  private async persistSessionState(session: Session | null, fallbackRefreshToken?: string | null): Promise<void> {
    setInMemorySession(session);
    this.edgeTokenCache = null;
    await removeSecureItem(LEGACY_SESSION_STORAGE_KEY).catch(() => undefined);
    const nextRefresh = String(session?.refresh_token ?? fallbackRefreshToken ?? "").trim();
    if (nextRefresh) {
      await saveRefreshToken(nextRefresh);
    } else {
      await clearRefreshToken();
    }
  }

  private async readSupabaseClientSession(): Promise<Session | null> {
    await this.ensureLegacyCleanup();
    try {
      const result = await withTimeout(
        supabase.auth.getSession(),
        AUTH_SESSION_READ_TIMEOUT_MS,
        "Tempo limite ao ler sessão local do Supabase.",
      );
      if (result.error) {
        if (isSupabaseSessionCorruptedError(result.error)) {
          await this.clearSessionState();
          return null;
        }
        throw result.error;
      }
      const session = result.data.session ?? null;
      if (session) setInMemorySession(session);
      return session;
    } catch (error) {
      if (isSupabaseSessionCorruptedError(error)) {
        await this.clearSessionState();
        return null;
      }
      throw error;
    }
  }

  /** Single-flight para refresh; evita concorrência. */
  private async refreshSessionWithStoredToken(refreshTokenRaw?: string | null): Promise<Session | null> {
    if (this.refreshSessionPromise) return this.refreshSessionPromise;

    this.refreshSessionPromise = (async () => {
      const token = String(refreshTokenRaw ?? "").trim() || (await loadRefreshToken());
      if (!token) {
        await this.clearSessionState();
        return null;
      }

      const result = await withTimeout(
        supabase.auth.refreshSession({ refresh_token: token }),
        AUTH_SESSION_REFRESH_TIMEOUT_MS,
        "Tempo limite ao renovar sessão.",
      );

      if (result.error) {
        if (isInvalidRefreshTokenError(result.error)) {
          await this.clearSessionState();
          return null;
        }
        throw result.error;
      }

      const session = result.data.session ?? null;
      await this.persistSessionState(session, token);
      return session;
    })();

    try {
      return await this.refreshSessionPromise;
    } finally {
      this.refreshSessionPromise = null;
    }
  }

  private canReuseEdgeToken(token: string): boolean {
    return (
      this.edgeTokenCache?.token === token &&
      Date.now() - (this.edgeTokenCache?.validatedAt ?? 0) < EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS
    );
  }

  private markEdgeTokenValidated(token: string): void {
    this.edgeTokenCache = { token, validatedAt: Date.now() };
  }

  private async isAccessTokenAcceptedBySupabaseRemote(accessToken: string | null): Promise<boolean> {
    const token = String(accessToken ?? "").trim();
    if (!isLikelyJwt(token)) return false;
    if (this.canReuseEdgeToken(token)) return true;
    const result = await withTimeout(
      supabase.auth.getUser(token),
      AUTH_TOKEN_VALIDATION_TIMEOUT_MS,
      "Tempo limite ao validar token no Supabase.",
    ).catch((error) => {
      if (isSupabaseSessionCorruptedError(error)) return { error };
      throw error;
    });
    if ((result as { error?: unknown })?.error) {
      await this.clearSessionState();
      return false;
    }
    const ok = Boolean((result as { data?: { user?: unknown } })?.data?.user);
    if (ok) this.markEdgeTokenValidated(token);
    return ok;
  }

  /* ------------------------ API pública ------------------------ */
  requiresSignupSecurityVerification(): boolean {
    return !shouldPreferDirectSupabaseSignup();
  }

  async signup(input: SignupInput): Promise<PendingVerificationState> {
    if (shouldPreferDirectSupabaseSignup()) {
      await this.signUpWithDirectSupabase(input);
      await setPendingVerificationState(null);
      return { email: input.email, expiresAt: null, maxAttempts: null, createdAt: Date.now() };
    }

    try {
      const response = await signupRequest({
        ...input,
        client: resolveClientDescriptor(),
      });
      const state: PendingVerificationState = {
        email: response.email,
        expiresAt: response.expires_at ?? null,
        maxAttempts: response.max_attempts ?? null,
        createdAt: Date.now(),
      };
      await setPendingVerificationState(state);
      const maybeTokenResponse = response as unknown as Partial<AuthTokenApiResponse & { session?: Session }>;
      if (maybeTokenResponse.access_token && maybeTokenResponse.refresh_token) {
        await this.applyRemoteSession(maybeTokenResponse.access_token, maybeTokenResponse.refresh_token);
      }
      return state;
    } catch (error) {
      if (!shouldFallbackToDirectSupabaseLogin(error)) throw error;
      await this.signUpWithDirectSupabase(input);
      await setPendingVerificationState(null);
      return { email: input.email, expiresAt: null, maxAttempts: null, createdAt: Date.now() };
    }
  }

  async resendVerification(emailRaw?: string | null): Promise<PendingVerificationState> {
    const current = await this.getPendingVerification();
    const email = String(emailRaw ?? current?.email ?? "").trim();
    if (!email) throw new Error("Pending verification email is missing.");
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
    const response = await verifyEmailRequest({ email, code, client: resolveClientDescriptor() });
    const session = await this.applyRemoteSession(response.access_token, response.refresh_token);
    await setPendingVerificationState(null);
    return session;
  }

  async login(email: string, password: string): Promise<Session> {
    if (shouldPreferDirectSupabaseLogin()) {
      const session = await this.signInWithDirectSupabase(email, password);
      await setPendingVerificationState(null);
      return session;
    }

    let session: Session;
    try {
      const response = await loginRequest({ email, password, client: resolveClientDescriptor() });
      session = await this.applyRemoteSession(response.access_token, response.refresh_token);

      // valida token emitido pela API própria; se falhar, cai para Supabase direto
      let accepted = true;
      try {
        accepted = await this.isAccessTokenAcceptedBySupabaseRemote(session.access_token);
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[auth:login] validação remota indisponível", err);
        accepted = false;
      }
      if (!accepted) {
        await this.clearSessionState();
        session = await this.signInWithDirectSupabase(email, password);
      }
    } catch (error) {
      const fallback =
        shouldFallbackToDirectSupabaseLogin(error) || (!(error instanceof AuthApiError) && isSupabaseSessionCorruptedError(error));
      if (!fallback) throw error;
      await this.clearSessionState().catch(() => undefined);
      session = await this.signInWithDirectSupabase(email, password);
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
        // best effort
      }
    }

    try {
      const res = await supabase.auth.signOut({ scope: "local" });
      if (res.error) throw res.error;
    } catch (error) {
      if (import.meta.env.DEV) console.warn("[auth] signOut local falhou", error);
    } finally {
      await this.clearSessionState().catch(() => undefined);
      await setPendingVerificationState(null).catch(() => undefined);
    }
  }

  async clearLocalSession(): Promise<void> {
    await this.clearSessionState();
    await setPendingVerificationState(null);
  }

  async refreshSession(): Promise<Session | null> {
    const current = getInMemorySession();
    const clientSession = await this.readSupabaseClientSession();
    const refreshToken =
      String(current?.refresh_token ?? "").trim() || String(clientSession?.refresh_token ?? "").trim();
    if (!refreshToken) {
      await this.clearSessionState();
      return null;
    }
    const next = await this.refreshSessionWithStoredToken(refreshToken);
    if (next?.access_token && !isLikelyJwt(next.access_token)) {
      await this.clearSessionState();
      return null;
    }
    return next;
  }

  async getCurrentSession(): Promise<Session | null> {
    const mem = getInMemorySession();
    if (mem && isLikelyJwt(mem.access_token) && !isSessionExpiringSoon(mem)) return mem;

    const client = await this.readSupabaseClientSession();
    if (client && isLikelyJwt(client.access_token) && !isSessionExpiringSoon(client)) return client;

    const refreshToken =
      String(mem?.refresh_token ?? "").trim() || String(client?.refresh_token ?? "").trim() || (await loadRefreshToken());
    if (refreshToken) return this.refreshSessionWithStoredToken(refreshToken);
    return this.refreshSessionWithStoredToken();
  }

  async getCurrentAccessToken(): Promise<string | null> {
    const session = await this.getCurrentSession();
    const token = String(session?.access_token ?? "").trim();
    return isLikelyJwt(token) ? token : null;
  }

  async getValidatedEdgeAccessToken(): Promise<string | null> {
    const current = await this.getCurrentAccessToken();
    try {
      if (await this.isAccessTokenAcceptedBySupabaseRemote(current)) return current;
    } catch (error) {
      if (import.meta.env.DEV) console.warn("[auth] falha ao validar token atual para Edge", error);
    }

    try {
      const refreshed = await this.refreshSession();
      const token = String(refreshed?.access_token ?? "").trim();
      if (await this.isAccessTokenAcceptedBySupabaseRemote(token)) return token;
    } catch (error) {
      if (import.meta.env.DEV) console.warn("[auth] falha ao validar token renovado para Edge", error);
      return null;
    }

    await this.clearSessionState();
    return null;
  }

  async getCurrentUserId(): Promise<string | null> {
    const storeId = getCurrentUserIdFromStore();
    if (storeId) return storeId;
    const session = await this.getCurrentSession();
    return String(session?.user?.id ?? "").trim() || null;
  }

  async hasStoredSessionHint(): Promise<boolean> {
    const mem = getInMemorySession();
    const memAccess = String(mem?.access_token ?? "").trim();
    const memRefresh = String(mem?.refresh_token ?? "").trim();
    if (isLikelyJwt(memAccess) || Boolean(memRefresh)) return true;

    const client = await this.readSupabaseClientSession();
    const clientAccess = String(client?.access_token ?? "").trim();
    const clientRefresh = String(client?.refresh_token ?? "").trim();
    if (isLikelyJwt(clientAccess) || Boolean(clientRefresh)) return true;

    const storedRefresh = await loadRefreshToken().catch(() => null);
    return Boolean(String(storedRefresh ?? "").trim());
  }

  async getPendingVerification(): Promise<PendingVerificationState | null> {
    return getSecureJson<PendingVerificationState>(PENDING_VERIFICATION_KEY);
  }

  /* ------------------------ Auxiliares privados (signup/login) ------------------------ */
  private async applyRemoteSession(accessToken: string, refreshToken: string): Promise<Session> {
    const result = await withTimeout(
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }),
      AUTH_LOGIN_TIMEOUT_MS,
      "Tempo limite ao aplicar sessão remota.",
    );
    if (result.error || !result.data.session) {
      throw result.error ?? new Error("Supabase session was not returned.");
    }
    const session = result.data.session;
    await this.persistSessionState(session, refreshToken);
    return session;
  }

  private async signInWithDirectSupabase(email: string, password: string): Promise<Session> {
    const res = await withTimeout(
      supabase.auth.signInWithPassword({ email, password }),
      AUTH_LOGIN_TIMEOUT_MS,
      "Tempo limite ao autenticar direto no Supabase.",
    );
    if (res.error || !res.data.session) throw res.error ?? new Error("Supabase session was not returned.");
    const session = res.data.session;
    await this.persistSessionState(session, session.refresh_token ?? null);
    return session;
  }

  private async signUpWithDirectSupabase(input: SignupInput): Promise<Session | null> {
    const meta: Record<string, string> = {};
    const displayName = String(input.profile?.displayName ?? "").trim();
    const username = String(input.profile?.username ?? "").trim();
    if (displayName) meta.display_name = displayName;
    if (username) meta.username = username;

    const res = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: { data: meta, emailRedirectTo: `${getRuntimeAppApiUrl()}/verify-email` },
    });
    if (res.error) throw res.error;
    if (res.data.session) {
      const session = res.data.session;
      await this.persistSessionState(session, session.refresh_token ?? null);
      return session;
    }
    return null; // comum quando email verification é obrigatória
  }
}

export const authService = new AuthService();
