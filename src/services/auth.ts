import type { Session, User } from "@supabase/supabase-js";
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

/** ---------------------------- Constantes ----------------------------- */
const PENDING_VERIFICATION_KEY = "messly.auth.pending-verification";
const LEGACY_SESSION_STORAGE_KEY = "messly.auth.session";
const SESSION_REFRESH_BUFFER_MS = 30_000;
const EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS = 15_000;
const AUTH_SESSION_READ_TIMEOUT_MS = 8_000;
const AUTH_SESSION_REFRESH_TIMEOUT_MS = 10_000;
const AUTH_LOGIN_TIMEOUT_MS = 12_000;
const AUTH_TOKEN_VALIDATION_TIMEOUT_MS = 8_000;

/** ---------------------------- Tipos ----------------------------- */
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

/** ---------------------------- Helpers ----------------------------- */
function resolveClientDescriptor(): AuthClientDescriptor {
  const descriptor = buildAuthClientDescriptor();
  return {
    ...descriptor,
    version: String(descriptor.version || appPackage.version || "0.0.5"),
  };
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

function isBase64Url(str: string): boolean {
  return /^[A-Za-z0-9\-_]+$/.test(str) && str.length % 4 !== 1;
}

function isLikelyJwt(tokenRaw: string | null | undefined): boolean {
  const token = String(tokenRaw ?? "").trim();
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && isBase64Url(p));
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
  const flag = String(import.meta.env.VITE_MESSLY_ALLOW_DIRECT_SUPABASE_AUTH_FALLBACK ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** ---------------------------- AuthService ----------------------------- */
class AuthService {
  /** Single-flight para refresh de sessão. */
  private refreshSessionPromise: Promise<Session | null> | null = null;
  /** Cache de validação de token para Edge Function. */
  private edgeTokenCache: { token: string; validatedAt: number } | null = null;
  /** Flags de inicialização. */
  private authStateSyncInitialized = false;
  private legacySessionCleanupStarted = false;

  /** Single-flight helper para evitar corridas. */
  private runSingleFlight<T>(key: "refresh" | "edge", fn: () => Promise<T>): Promise<T> {
    if (key === "refresh") {
      if (this.refreshSessionPromise) return this.refreshSessionPromise as Promise<T>;
      const task = fn().finally(() => {
        this.refreshSessionPromise = null;
      }) as Promise<T>;
      this.refreshSessionPromise = task as Promise<Session | null>;
      return task;
    }
    return fn(); // edge: não reusa promise, só evita globais.
  }

  /** Limpa sessão local (memória + storage). */
  private async clearSessionState(): Promise<void> {
    setInMemorySession(null);
    await clearAccessToken();
    await clearRefreshToken();
  }

  /** Remove storage legado uma vez. */
  private async cleanupLegacySessionOnce(): Promise<void> {
    if (this.legacySessionCleanupStarted) return;
    this.legacySessionCleanupStarted = true;
    try {
      await removeSecureItem(LEGACY_SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  /** Escuta eventos do Supabase e mantém store local em sincronia. */
  private initAuthStateSync(): void {
    if (this.authStateSyncInitialized) return;
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        void this.clearLocalSession();
        return;
      }
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) {
        setInMemorySession(session);
      }
    });
    this.authStateSyncInitialized = true;
  }

  /** Obtém sessão atual do Supabase com timeout. */
  private async getCurrentSession(): Promise<Session | null> {
    await this.cleanupLegacySessionOnce();
    return withTimeout(
      supabase.auth.getSession().then((r) => r.data.session ?? null),
      AUTH_SESSION_READ_TIMEOUT_MS,
      "Timeout ao ler sessão."
    );
  }

  /** Valida token com Supabase (usado para Edge Functions). */
  private async isAccessTokenAcceptedBySupabase(token: string | null): Promise<boolean> {
    if (!isLikelyJwt(token)) return false;
    return withTimeout(
      supabase.auth.getUser(token!).then((r) => Boolean(r.data.user)),
      AUTH_TOKEN_VALIDATION_TIMEOUT_MS,
      "Timeout ao validar token."
    ).catch(() => false);
  }

  /** Token atual, se não expira logo. */
  async getCurrentAccessToken(): Promise<string | null> {
    const currentSession = getInMemorySession();
    const currentToken = String(currentSession?.access_token ?? "").trim();
    if (currentToken && isLikelyJwt(currentToken) && !isSessionExpiringSoon(currentSession)) {
      return currentToken;
    }
    const session = await this.getCurrentSession();
    const accessToken = String(session?.access_token ?? "").trim();
    return isLikelyJwt(accessToken) ? accessToken : null;
  }

  /** Token validado para Edge Functions (cache 15s + single-flight). */
  async getValidatedEdgeAccessToken(): Promise<string | null> {
    return this.runSingleFlight("edge", async () => {
      const now = Date.now();
      if (this.edgeTokenCache && this.edgeTokenCache.validatedAt + EDGE_ACCESS_TOKEN_VALIDATION_TTL_MS > now) {
        return this.edgeTokenCache.token;
      }

      const tryValidate = async (token: string | null): Promise<string | null> => {
        if (!isLikelyJwt(token)) return null;
        if (await this.isAccessTokenAcceptedBySupabase(token)) return token;
        return null;
      };

      const current = await this.getCurrentAccessToken();
      const validatedCurrent = await tryValidate(current);
      if (validatedCurrent) {
        this.edgeTokenCache = { token: validatedCurrent, validatedAt: now };
        return validatedCurrent;
      }

      const refreshed = await this.refreshSession();
      const refreshedToken = String(refreshed?.access_token ?? "").trim();
      const validatedRefreshed = await tryValidate(refreshedToken);
      if (validatedRefreshed) {
        this.edgeTokenCache = { token: validatedRefreshed, validatedAt: Date.now() };
        return validatedRefreshed;
      }

      await this.clearSessionState();
      return null;
    });
  }

  /** Refresh de sessão protegido contra corrida. */
  async refreshSession(): Promise<Session | null> {
    return this.runSingleFlight("refresh", async () => {
      const currentSession = getInMemorySession();
      const supabaseSession = await this.getCurrentSession();
      const refreshToken =
        String(currentSession?.refresh_token ?? "").trim() ||
        String(supabaseSession?.refresh_token ?? "").trim() ||
        (await loadRefreshToken());

      if (!refreshToken) {
        await this.clearSessionState();
        return null;
      }

      try {
        const refreshed = await withTimeout(
          supabase.auth.refreshSession({ refresh_token: refreshToken }).then((r) => r.data.session ?? null),
          AUTH_SESSION_REFRESH_TIMEOUT_MS,
          "Timeout ao atualizar sessão."
        );
        if (refreshed?.access_token) {
          setInMemorySession(refreshed);
          await saveRefreshToken(String(refreshed.refresh_token ?? ""));
          return refreshed;
        }
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          await this.clearSessionState();
          return null;
        }
        throw error;
      }

      await this.clearSessionState();
      return null;
    });
  }

  /** Login via API própria com fallback Supabase direto. */
  async login(email: string, password: string): Promise<Session | null> {
    this.initAuthStateSync();
    await this.cleanupLegacySessionOnce();

    const descriptor = resolveClientDescriptor();

    const signInWithDirectSupabase = async (e: string, p: string): Promise<Session> => {
      const { data, error } = await supabase.auth.signInWithPassword({ email: e, password: p });
      if (error || !data.session) throw error ?? new Error("Falha no login Supabase.");
      setInMemorySession(data.session);
      await saveRefreshToken(String(data.session.refresh_token ?? ""));
      return data.session;
    };

    let session: Session;
    try {
      const response = await withTimeout(
        loginRequest({ email, password, client: descriptor }),
        AUTH_LOGIN_TIMEOUT_MS,
        "Timeout ao fazer login."
      );
      if (!response?.access_token || !response?.refresh_token) {
        throw new Error("Resposta de login incompleta.");
      }

      const applied = await supabase.auth.setSession({
        access_token: response.access_token,
        refresh_token: response.refresh_token,
      });

      session = applied.data.session ?? null;
      if (!session) {
        await clearRefreshToken();
        await clearAccessToken();
        throw new Error("Sessão não retornada; verificação de email pode ser necessária.");
      }

      let tokenAccepted = true;
      try {
        tokenAccepted = await this.isAccessTokenAcceptedBySupabase(session.access_token);
      } catch {
        tokenAccepted = false;
      }
      if (!tokenAccepted) {
        await this.clearSessionState();
        session = await signInWithDirectSupabase(email, password);
      }
    } catch (error) {
      const canFallback = shouldFallbackToDirectSupabaseLogin(error) || isSupabaseSessionCorruptedError(error);
      if (!canFallback) throw error;
      await this.clearSessionState().catch(() => undefined);
      session = await signInWithDirectSupabase(email, password);
    }

    return session;
  }

  /** Signup via API própria com fallback Supabase direto; guarda estado pendente. */
  async signup(input: SignupInput): Promise<void> {
    this.initAuthStateSync();
    await this.cleanupLegacySessionOnce();

    const descriptor = resolveClientDescriptor();

    const signUpDirect = async (): Promise<void> => {
      const { data, error } = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: {
          emailRedirectTo: `${getRuntimeAppApiUrl()}/verify-email`,
          data: {
            display_name: input.profile?.displayName ?? null,
            username: input.profile?.username ?? null,
          },
        },
      });
      if (error) throw error;
      if (!data.session) {
        await setPendingVerificationState({
          email: input.email,
          expiresAt: null,
          maxAttempts: null,
          createdAt: Date.now(),
        });
      }
    };

    try {
      const response = await signupRequest({
        ...input,
        client: descriptor,
        appUrl: getRuntimeAppApiUrl(),
        authUrl: getRuntimeAuthApiUrl(),
      });

      if (response?.pendingVerification) {
        await setPendingVerificationState({
          email: input.email,
          expiresAt: response.pendingVerification.expiresAt ?? null,
          maxAttempts: response.pendingVerification.maxAttempts ?? null,
          createdAt: Date.now(),
        });
      }

      if (response?.session) {
        const s = response.session as Session;
        setInMemorySession(s);
        await saveRefreshToken(String(s.refresh_token ?? ""));
      }
    } catch (error) {
      const canFallback = shouldFallbackToDirectSupabaseLogin(error);
      if (!canFallback) throw error;
      await signUpDirect();
    }
  }

  async resendVerification(email: string): Promise<void> {
    await resendVerificationRequest({ email, client: resolveClientDescriptor() });
  }

  async verifyEmail(code: string): Promise<void> {
    await verifyEmailRequest({ code, client: resolveClientDescriptor() });
  }

  /** Logout: tenta API própria e Supabase; sempre limpa estado local. */
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
      const localSignOut = await supabase.auth.signOut({ scope: "local" });
      if (localSignOut.error) throw localSignOut.error;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("[auth] logout local fallback after signOut error", error);
      }
    } finally {
      await this.clearSessionState().catch(() => undefined);
      await setPendingVerificationState(null).catch(() => undefined);
    }
  }

  async clearLocalSession(): Promise<void> {
    await this.clearSessionState();
    await setPendingVerificationState(null);
  }

  async getCurrentUserId(): Promise<string | null> {
    const fromStore = getCurrentUserIdFromStore();
    if (fromStore) return fromStore;
    const session = await this.getCurrentSession();
    return String(session?.user?.id ?? "").trim() || null;
  }

  async hasStoredSessionHint(): Promise<boolean> {
    const memorySession = getInMemorySession();
    const memoryAccessToken = String(memorySession?.access_token ?? "").trim();
    const memoryRefreshToken = String(memorySession?.refresh_token ?? "").trim();
    if (isLikelyJwt(memoryAccessToken) || Boolean(memoryRefreshToken)) return true;

    const clientSession = await this.getCurrentSession();
    const clientAccessToken = String(clientSession?.access_token ?? "").trim();
    const clientRefreshToken = String(clientSession?.refresh_token ?? "").trim();
    if (isLikelyJwt(clientAccessToken) || Boolean(clientRefreshToken)) return true;

    const storedRefresh = await loadRefreshToken();
    return Boolean(storedRefresh);
  }

  getSupabasePublishableKey(): string {
    const key = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
    if (key) return key;
    const legacyAnon = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
    return legacyAnon;
  }

  getSupabaseUrl(): string {
    return supabaseUrl;
  }
}

export const authService = new AuthService();
