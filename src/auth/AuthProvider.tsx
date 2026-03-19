import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { authActions } from "../stores/authSlice";
import { useAppDispatch } from "../stores/store";
import { supabase } from "../lib/supabaseClient";
import { queryProfileById } from "../services/profile/profileReadApi";
import { authService } from "../services/auth";
import { normalizeEmail, validateUsernameInput } from "../services/usernameAvailability";
import { ensureProfileForUser, fetchProfileById, type ProfileRow } from "../services/profile/profileService";
import {
  type KnownAccount as StoredKnownAccount,
  readKnownAccounts,
  removeKnownAccount,
  upsertKnownAccount,
} from "../services/auth/accountRegistry";
import {
  clearCurrentLoginSessionStorage,
  endCurrentLoginSession,
  getCurrentLoginSessionStatus,
  recordLoginSession,
} from "../services/security/loginSessions";
import { normalizeUsername } from "../shared/username";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  raw: User;
}

export interface SessionKnownAccount {
  uid: string;
  email: string;
  alias: string;
  avatarSrc: string | null;
  lastUsedAt: number;
  isActive: boolean;
}

interface AuthenticateAccountParams {
  email: string;
  password: string;
  alias?: string | null;
}

interface UpdateCurrentAccountProfileParams {
  alias?: string | null;
  avatarSrc?: string | null;
}

interface SignUpProfile {
  displayName?: string | null;
  username?: string | null;
}

interface SignUpSecurityInput {
  turnstileToken: string;
  registrationFingerprint: string;
}

interface SignInSecurityInput {
  turnstileToken?: string | null;
  loginFingerprint?: string | null;
  client?: {
    userAgent?: string | null;
    platform?: string | null;
  } | null;
}

interface AuthContextValue {
  session: Session | null;
  user: AuthUser | null;
  profile: ProfileRow | null;
  isLoading: boolean;
  loading: boolean;
  authReady: boolean;
  requiresSignupSecurityVerification: boolean;
  hasSessionHint: boolean;
  sessionHintResolved: boolean;
  error: string | null;
  knownAccounts: SessionKnownAccount[];
  signUp: (
    email: string,
    password: string,
    profile?: SignUpProfile,
    security?: SignUpSecurityInput,
  ) => Promise<{ user: AuthUser | null; profile: ProfileRow | null; needsEmailConfirmation: boolean }>;
  verifyEmailCode: (email: string, code: string) => Promise<{ user: AuthUser; profile: ProfileRow | null }>;
  resendVerificationCode: (email: string) => Promise<void>;
  signIn: (
    email: string,
    password: string,
    security?: SignInSecurityInput,
  ) => Promise<{ user: AuthUser; profile: ProfileRow | null }>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<Session | null>;
  getCurrentSession: () => Promise<Session | null>;
  authenticateAccount: (params: AuthenticateAccountParams) => Promise<AuthUser>;
  signOutCurrent: () => Promise<void>;
  forgetKnownAccount: (uid: string) => Promise<void>;
  refreshKnownAccounts: () => void;
  refreshProfile: () => Promise<ProfileRow | null>;
  updateCurrentAccountProfile: (params: UpdateCurrentAccountProfileParams) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const FALLBACK_AUTH_CONTEXT: AuthContextValue = {
  session: null,
  user: null,
  profile: null,
  isLoading: false,
  loading: false,
  authReady: false,
  requiresSignupSecurityVerification: true,
  hasSessionHint: false,
  sessionHintResolved: true,
  error: null,
  knownAccounts: [],
  signUp: async () => ({ user: null, profile: null, needsEmailConfirmation: true }),
  verifyEmailCode: async () => {
    throw new Error("Sessão de autenticação indisponível.");
  },
  resendVerificationCode: async () => undefined,
  signIn: async () => {
    throw new Error("Sessão de autenticação indisponível.");
  },
  signOut: async () => undefined,
  refreshSession: async () => null,
  getCurrentSession: async () => null,
  authenticateAccount: async () => {
    throw new Error("Sessão de autenticação indisponível.");
  },
  signOutCurrent: async () => undefined,
  forgetKnownAccount: async () => undefined,
  refreshKnownAccounts: () => undefined,
  refreshProfile: async () => null,
  updateCurrentAccountProfile: () => undefined,
};

function mapSupabaseUser(rawUser: User | null): AuthUser | null {
  if (!rawUser) {
    return null;
  }

  const metadata = (rawUser.user_metadata ?? {}) as Record<string, unknown>;
  const displayNameCandidate = metadata.display_name ?? metadata.displayName ?? metadata.name ?? null;
  const displayName = String(displayNameCandidate ?? "").trim() || null;
  const email = String(rawUser.email ?? "").trim() || null;
  const photoUrlCandidate =
    metadata.avatar_url ??
    metadata.avatarUrl ??
    metadata.photo_url ??
    metadata.photoURL ??
    metadata.picture ??
    null;
  const photoURL = String(photoUrlCandidate ?? "").trim() || null;
  const emailVerified = Boolean(rawUser.email_confirmed_at || rawUser.confirmed_at);

  return {
    uid: rawUser.id,
    email,
    displayName,
    photoURL,
    emailVerified,
    raw: rawUser,
  };
}

let bootstrapSessionPromise: Promise<Session | null> | null = null;
const AUTH_BOOTSTRAP_SESSION_TIMEOUT_MS = 10_000;
const AUTH_SESSION_HINT_TIMEOUT_MS = 4_000;
const AUTH_APPLY_SESSION_TIMEOUT_MS = 15_000;
const AUTH_PROFILE_FETCH_TIMEOUT_MS = 10_000;
const AUTH_HARD_LOADING_TIMEOUT_MS = 20_000;
const AUTH_BACKGROUND_RECOVERY_TIMEOUT_MS = 15_000;

function hasValidSignupPassword(passwordRaw: string): boolean {
  const password = String(passwordRaw ?? "");
  return /^(?=.*\d)(?=.*[^A-Za-z0-9\s]).{8,}$/.test(password);
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, Math.max(800, timeoutMs));
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function getInitialSessionOnce(): Promise<Session | null> {
  if (!bootstrapSessionPromise) {
    bootstrapSessionPromise = (async () => {
      return withTimeout(
        authService.getCurrentSession(),
        AUTH_BOOTSTRAP_SESSION_TIMEOUT_MS,
        "Tempo limite ao carregar sessao inicial.",
      );
    })().catch((error) => {
      bootstrapSessionPromise = null;
      throw error;
    });
  }

  return bootstrapSessionPromise;
}

function isTableMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const casted = error as { code?: string; status?: number; message?: string };
  const code = String(casted.code ?? "").trim();
  const status = Number(casted.status ?? 0);
  const message = String(casted.message ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST114" || status === 404 || message.includes("does not exist");
}

function isAuthSessionInvalidError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const casted = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    details?: unknown;
    name?: unknown;
  };
  const status = Number(casted.status ?? 0);
  const code = String(casted.code ?? "").trim().toUpperCase();
  const name = String(casted.name ?? "").trim().toUpperCase();
  const message = String(casted.message ?? "").trim().toLowerCase();
  const details = String(casted.details ?? "").trim().toLowerCase();
  const combined = `${code} ${name} ${message} ${details}`;

  return (
    status === 401 ||
    status === 403 ||
    code === "UNAUTHENTICATED" ||
    code === "UNAUTHORIZED" ||
    code === "INVALID_TOKEN" ||
    code === "INVALID_JWT" ||
    code === "JWT_EXPIRED" ||
    code === "SESSION_NOT_FOUND" ||
    code === "PGRST301" ||
    combined.includes("invalid jwt") ||
    combined.includes("jwt expired") ||
    combined.includes("session not found") ||
    combined.includes("session from session_id claim in jwt does not exist") ||
    combined.includes("session_id claim") ||
    combined.includes("token has expired") ||
    combined.includes("token expired")
  );
}

async function profileExists(uid: string): Promise<boolean> {
  try {
    const { data, error } = await queryProfileById(uid);
    if (error) {
      if (isTableMissing(error)) {
        return false;
      }
      throw error;
    }
    return Boolean((data as { id?: string } | null)?.id);
  } catch (error) {
    if (isTableMissing(error)) {
      return false;
    }
    throw error;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [hasSessionHint, setHasSessionHint] = useState(false);
  const [sessionHintResolved, setSessionHintResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedKnownAccounts, setStoredKnownAccounts] = useState<StoredKnownAccount[]>(() => readKnownAccounts());
  const requiresSignupSecurityVerification = authService.requiresSignupSecurityVerification();
  const subscriptionRef = useRef<ReturnType<typeof supabase.auth.onAuthStateChange>["data"]["subscription"] | null>(null);
  const lastSessionAccessTokenRef = useRef<string | null>(null);
  const backgroundRecoveryAttemptedRef = useRef(false);

  const refreshKnownAccounts = useCallback((): void => {
    setStoredKnownAccounts(readKnownAccounts());
  }, []);

  const syncKnownAccount = useCallback((nextUser: AuthUser | null): void => {
    const normalizedUserEmail = normalizeEmail(nextUser?.email ?? "");
    if (!nextUser || !normalizedUserEmail) {
      setStoredKnownAccounts(readKnownAccounts());
      return;
    }

    setStoredKnownAccounts(
      upsertKnownAccount({
        uid: nextUser.uid,
        email: normalizedUserEmail,
        alias: nextUser.displayName,
        touchLastUsedAt: true,
      }),
    );
  }, []);

  const applySessionAndProfile = useCallback(
    async (
      nextSession: Session | null,
      options: { preferredUsername?: string | null; displayName?: string | null; skipProfile?: boolean } = {},
    ): Promise<void> => {
      const mappedUser = mapSupabaseUser(nextSession?.user ?? null);
      const accessToken = nextSession?.access_token ?? null;

      if (accessToken && lastSessionAccessTokenRef.current === accessToken && authReady && !options.preferredUsername) {
        setSession(nextSession);
        setUser(mappedUser);
        if (mappedUser) {
          dispatch(
            authActions.authSessionChanged({
              userId: mappedUser.uid,
              email: mappedUser.email,
              emailVerified: mappedUser.emailVerified,
              expiresAt: nextSession?.expires_at ?? null,
            }),
          );
        }
        return;
      }

      lastSessionAccessTokenRef.current = accessToken;
      setSession(nextSession);
      setUser(mappedUser);
      setHasSessionHint(Boolean(mappedUser));
      setSessionHintResolved(true);
      syncKnownAccount(mappedUser);

      if (!mappedUser || options.skipProfile) {
        setProfile(null);
        setError(null);
        if (!mappedUser) {
          dispatch(authActions.authSignedOut());
        } else {
          dispatch(
            authActions.authSessionChanged({
              userId: mappedUser.uid,
              email: mappedUser.email,
              emailVerified: mappedUser.emailVerified,
              expiresAt: nextSession?.expires_at ?? null,
            }),
          );
        }
        setAuthReady(true);
        setIsLoading(false);
        return;
      }

      const loadEnsuredProfile = async (targetUser: AuthUser): Promise<ProfileRow | null> => {
        let ensuredProfile = await withTimeout(
          ensureProfileForUser(targetUser.raw, {
            preferredUsername: options.preferredUsername ?? targetUser.raw.user_metadata?.username,
            displayName: options.displayName ?? targetUser.displayName ?? targetUser.email ?? null,
          }),
          AUTH_PROFILE_FETCH_TIMEOUT_MS,
          "Tempo limite ao carregar perfil do usuario.",
        );

        if (!ensuredProfile) {
          const exists = await withTimeout(
            profileExists(targetUser.uid),
            AUTH_PROFILE_FETCH_TIMEOUT_MS,
            "Tempo limite ao verificar existencia do perfil.",
          );
          if (!exists) {
            return null;
          }
          ensuredProfile = await withTimeout(
            fetchProfileById(targetUser.uid),
            AUTH_PROFILE_FETCH_TIMEOUT_MS,
            "Tempo limite ao buscar perfil por ID.",
          );
        }

        return ensuredProfile;
      };

      setIsLoading(true);
      try {
        const ensuredProfile = await loadEnsuredProfile(mappedUser);
        if (!ensuredProfile) {
          await authService.clearLocalSession().catch(() => undefined);
          setSession(null);
          setUser(null);
          setProfile(null);
          setHasSessionHint(false);
          setSessionHintResolved(true);
          setError("Sua conta nao existe mais. Faca login novamente.");
          dispatch(authActions.authSignedOut());
          setAuthReady(true);
          setIsLoading(false);
          return;
        }

        setProfile(ensuredProfile);
        setError(null);
        dispatch(authActions.authErrorChanged(null));
        dispatch(
          authActions.authSessionChanged({
            userId: mappedUser.uid,
            email: mappedUser.email,
            emailVerified: mappedUser.emailVerified,
            expiresAt: nextSession?.expires_at ?? null,
          }),
        );
      } catch (profileError) {
        if (import.meta.env.DEV) {
          console.error("[auth:profile]", profileError);
        }
        if (isAuthSessionInvalidError(profileError)) {
          const refreshedSession = await authService.refreshSession().catch(() => null);
          const refreshedUser = mapSupabaseUser(refreshedSession?.user ?? null);
          if (refreshedSession && refreshedUser && refreshedUser.uid === mappedUser.uid) {
            try {
              lastSessionAccessTokenRef.current = refreshedSession.access_token ?? null;
              setSession(refreshedSession);
              setUser(refreshedUser);
              syncKnownAccount(refreshedUser);

              const recoveredProfile = await loadEnsuredProfile(refreshedUser);
              if (!recoveredProfile) {
                await authService.clearLocalSession().catch(() => undefined);
                setSession(null);
                setUser(null);
                setProfile(null);
                setHasSessionHint(false);
                setSessionHintResolved(true);
                setError("Sua conta nao existe mais. Faca login novamente.");
                dispatch(authActions.authSignedOut());
                return;
              }

              setProfile(recoveredProfile);
              setError(null);
              dispatch(authActions.authErrorChanged(null));
              dispatch(
                authActions.authSessionChanged({
                  userId: refreshedUser.uid,
                  email: refreshedUser.email,
                  emailVerified: refreshedUser.emailVerified,
                  expiresAt: refreshedSession?.expires_at ?? null,
                }),
              );
              return;
            } catch (recoveryError) {
              if (import.meta.env.DEV) {
                console.error("[auth:profile:recovery]", recoveryError);
              }
              if (!isAuthSessionInvalidError(recoveryError)) {
                setError("Falha ao carregar ou criar o perfil.");
                setProfile(null);
                dispatch(authActions.authErrorChanged("Falha ao carregar ou criar o perfil."));
                return;
              }
            }
          }

          await authService.clearLocalSession().catch(() => undefined);
          setSession(null);
          setUser(null);
          setProfile(null);
          setHasSessionHint(false);
          setSessionHintResolved(true);
          setError("Sessao invalida ou expirada. Faca login novamente.");
          dispatch(authActions.authErrorChanged("Sessao invalida ou expirada. Faca login novamente."));
          dispatch(authActions.authSignedOut());
          return;
        }

        setError("Falha ao carregar ou criar o perfil.");
        setProfile(null);
        dispatch(authActions.authErrorChanged("Falha ao carregar ou criar o perfil."));
      } finally {
        setAuthReady(true);
        setIsLoading(false);
      }
    },
    [authReady, dispatch, syncKnownAccount],
  );

  useEffect(() => {
    let isMounted = true;
    let preloadResolved = false;
    let storeResolved = false;
    let preloadHasHint = false;
    let storeHasHint = false;

    const publishHint = (): void => {
      if (!isMounted) {
        return;
      }

      if (preloadHasHint || storeHasHint) {
        setHasSessionHint(true);
        setSessionHintResolved(true);
        return;
      }

      if (preloadResolved && storeResolved) {
        setHasSessionHint(false);
        setSessionHintResolved(true);
      }
    };

    const preloadSnapshot = window.electronAPI?.getStartupSnapshot;
    if (typeof preloadSnapshot === "function") {
      void preloadSnapshot()
        .then((snapshot) => {
          if (!isMounted) {
            return;
          }
          preloadResolved = true;
          preloadHasHint = Boolean(snapshot?.hasRefreshToken);
          publishHint();
        })
        .catch(() => {
          if (!isMounted) {
            return;
          }
          preloadResolved = true;
          preloadHasHint = false;
          publishHint();
        });
    } else {
      preloadResolved = true;
      publishHint();
    }

    void withTimeout(
      authService.hasStoredSessionHint(),
      AUTH_SESSION_HINT_TIMEOUT_MS,
      "Tempo limite ao verificar indicio de sessao.",
    )
      .then((hasHint) => {
        if (!isMounted) {
          return;
        }
        storeResolved = true;
        storeHasHint = Boolean(hasHint);
        publishHint();
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        storeResolved = true;
        storeHasHint = false;
        publishHint();
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let bootstrapSettled = false;
    dispatch(authActions.authBootstrapStarted());

    const bootstrap = async (): Promise<void> => {
      try {
        const initialSession = await getInitialSessionOnce();
        if (!isMounted) {
          return;
        }
        await withTimeout(
          applySessionAndProfile(initialSession),
          AUTH_APPLY_SESSION_TIMEOUT_MS,
          "Tempo limite ao aplicar sessao inicial.",
        );
      } catch (bootstrapError) {
        if (!isMounted) {
          return;
        }
        const message = bootstrapError instanceof Error ? bootstrapError.message : "Falha ao inicializar sessão.";
        setError(message);
        dispatch(authActions.authErrorChanged(message));
      } finally {
        bootstrapSettled = true;
        if (isMounted) {
          setIsLoading(false);
          setAuthReady(true);
        }
      }
    };

    void bootstrap();

    const authState = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!bootstrapSettled && event === "INITIAL_SESSION" && !nextSession) {
        return;
      }

      void (async () => {
        const canonicalSession = nextSession?.access_token ? await authService.getCurrentSession() : null;
        await withTimeout(
          applySessionAndProfile(canonicalSession),
          AUTH_APPLY_SESSION_TIMEOUT_MS,
          "Tempo limite ao atualizar sessao de autenticacao.",
        );
      })().catch((authStateError) => {
        if (!isMounted) {
          return;
        }
        const message = authStateError instanceof Error
          ? authStateError.message
          : "Falha ao atualizar sessao de autenticacao.";
        setError(message);
        dispatch(authActions.authErrorChanged(message));
        setIsLoading(false);
        setAuthReady(true);
      });
    });

    subscriptionRef.current = authState.data.subscription;

    return () => {
      isMounted = false;
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [applySessionAndProfile, dispatch]);

  useEffect(() => {
    // Safety net: never allow auth bootstrap to keep startup UI blocked indefinitely.
    if (authReady && !isLoading && sessionHintResolved) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSessionHintResolved(true);
      setIsLoading(false);
      setAuthReady(true);
      setError((currentError) => currentError ?? "Tempo limite ao restaurar sessão. Continue com login manual.");
    }, AUTH_HARD_LOADING_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [authReady, isLoading, sessionHintResolved]);

  useEffect(() => {
    const currentAccessToken = String(session?.access_token ?? "").trim();
    const currentUserId = String(session?.user?.id ?? "").trim();
    if (!currentAccessToken || !currentUserId) {
      return;
    }

    void recordLoginSession().catch((error) => {
      if (import.meta.env.DEV) {
        console.warn("[auth:record-login-session]", error);
      }
    });
  }, [session?.access_token, session?.user?.id]);

  useEffect(() => {
    const currentAccessToken = String(session?.access_token ?? "").trim();
    const currentUserId = String(session?.user?.id ?? "").trim();
    if (!currentAccessToken || !currentUserId) {
      return;
    }

    let cancelled = false;

    const assertCurrentSessionActive = async (): Promise<void> => {
      try {
        const status = await getCurrentLoginSessionStatus();
        if (cancelled || status !== "ended") {
          return;
        }

        await authService.logout().catch(async () => {
          await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        });
        clearCurrentLoginSessionStorage();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn("[auth:session-status]", error);
        }
      }
    };

    const intervalId = window.setInterval(() => {
      void assertCurrentSessionActive();
    }, 60_000);

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void assertCurrentSessionActive();
      }
    };

    const handleFocus = (): void => {
      void assertCurrentSessionActive();
    };

    void assertCurrentSessionActive();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [session?.access_token, session?.user?.id]);

  useEffect(() => {
    if (user || !hasSessionHint) {
      backgroundRecoveryAttemptedRef.current = false;
    }
  }, [hasSessionHint, user?.uid]);

  useEffect(() => {
    if (user || isLoading || !authReady || !sessionHintResolved || !hasSessionHint) {
      return;
    }
    if (backgroundRecoveryAttemptedRef.current) {
      return;
    }
    backgroundRecoveryAttemptedRef.current = true;

    let cancelled = false;
    setIsLoading(true);

    void withTimeout(
      authService.getCurrentSession(),
      AUTH_BACKGROUND_RECOVERY_TIMEOUT_MS,
      "Tempo limite ao recuperar sessao em segundo plano.",
    )
      .then(async (recoveredSession) => {
        if (cancelled) {
          return;
        }
        if (!recoveredSession?.user) {
          setHasSessionHint(false);
          return;
        }
        await withTimeout(
          applySessionAndProfile(recoveredSession),
          AUTH_APPLY_SESSION_TIMEOUT_MS,
          "Tempo limite ao aplicar sessao recuperada.",
        );
      })
      .catch((recoveryError) => {
        if (import.meta.env.DEV) {
          console.warn("[auth:background-recovery]", recoveryError);
        }
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setIsLoading(false);
        setAuthReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [applySessionAndProfile, authReady, hasSessionHint, isLoading, sessionHintResolved, user]);

  const signIn = useCallback(
    async (
      email: string,
      password: string,
      securityInput?: SignInSecurityInput,
    ): Promise<{ user: AuthUser; profile: ProfileRow | null }> => {
      const normalizedUserEmail = normalizeEmail(email);
      const normalizedPassword = String(password ?? "");
      if (!normalizedUserEmail || normalizedPassword.length < 8) {
        throw new Error("Informe e-mail e senha para continuar.");
      }

      const nextSession = await authService.login(normalizedUserEmail, normalizedPassword, {
        turnstileToken: String(securityInput?.turnstileToken ?? "").trim() || null,
        loginFingerprint: String(securityInput?.loginFingerprint ?? "").trim() || null,
        client: {
          userAgent: String(securityInput?.client?.userAgent ?? "").trim() || null,
          platform: String(securityInput?.client?.platform ?? "").trim() || null,
        },
      });
      const signedUser = mapSupabaseUser(nextSession.user ?? null);
      if (!signedUser) {
        throw new Error("Sessao nao retornada pelo Supabase.");
      }

      await applySessionAndProfile(nextSession);
      setHasSessionHint(true);
      setSessionHintResolved(true);
      syncKnownAccount(signedUser);
      setError(null);
      dispatch(authActions.authErrorChanged(null));
      return { user: signedUser, profile: null };
    },
    [applySessionAndProfile, dispatch, syncKnownAccount],
  );

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      profileInput: SignUpProfile = {},
      securityInput?: SignUpSecurityInput,
    ): Promise<{ user: AuthUser | null; profile: ProfileRow | null; needsEmailConfirmation: boolean }> => {
      const normalizedUserEmail = normalizeEmail(email);
      const normalizedPassword = String(password ?? "");
      if (!normalizedUserEmail || !hasValidSignupPassword(normalizedPassword)) {
        throw new Error("Informe e-mail válido e senha com no mínimo 8 caracteres, número e símbolo.");
      }

      const displayName = String(profileInput.displayName ?? "").trim();
      const usernameInput = String(profileInput.username ?? "");
      const username = normalizeUsername(usernameInput);

      if (!displayName) {
        throw new Error("Informe um nome de exibição.");
      }

      const usernameValidation = validateUsernameInput(usernameInput);
      if (!usernameValidation.isValid) {
        throw new Error(usernameValidation.message ?? "Nome de usuário inválido.");
      }

      const turnstileToken = String(securityInput?.turnstileToken ?? "").trim();
      const registrationFingerprint = String(securityInput?.registrationFingerprint ?? "").trim();
      if (!turnstileToken) {
        throw new Error("Verificacao de seguranca obrigatoria.");
      }
      if (!registrationFingerprint) {
        throw new Error("Nao foi possivel validar este dispositivo.");
      }

      await authService.signup({
        email: normalizedUserEmail,
        password: normalizedPassword,
        turnstileToken,
        registrationFingerprint,
        profile: {
          displayName,
          username,
        },
      });

      const nextSession = await authService.getCurrentSession();
      const signedUser = mapSupabaseUser(nextSession?.user ?? null);
      if (nextSession && signedUser) {
        await applySessionAndProfile(nextSession, {
          preferredUsername: username,
          displayName,
        });
        const ensuredProfile = await withTimeout(
          fetchProfileById(signedUser.uid).catch(() => null),
          AUTH_PROFILE_FETCH_TIMEOUT_MS,
          "Tempo limite ao buscar perfil autenticado.",
        ).catch(() => null);
        syncKnownAccount(signedUser);
        setHasSessionHint(true);
        setSessionHintResolved(true);
        setError(null);
        dispatch(authActions.authErrorChanged(null));
        return {
          user: signedUser,
          profile: ensuredProfile,
          needsEmailConfirmation: false,
        };
      }
      setError(null);
      dispatch(authActions.authErrorChanged(null));
      dispatch(authActions.authVerificationRequired({ email: normalizedUserEmail }));

      return {
        user: null,
        profile: null,
        needsEmailConfirmation: true,
      };
    },
    [applySessionAndProfile, dispatch, syncKnownAccount],
  );

  const verifyEmailCode = useCallback(
    async (email: string, code: string): Promise<{ user: AuthUser; profile: ProfileRow | null }> => {
      const normalizedUserEmail = normalizeEmail(email);
      const normalizedCode = String(code ?? "").trim();
      if (!normalizedUserEmail || !normalizedCode) {
        throw new Error("Informe e-mail e código para continuar.");
      }

      const nextSession = await authService.verifyEmailCode(normalizedUserEmail, normalizedCode);
      const verifiedUser = mapSupabaseUser(nextSession.user ?? null);
      if (!verifiedUser) {
        throw new Error("Sessão não retornada pelo Supabase.");
      }

      await applySessionAndProfile(nextSession);
      const ensuredProfile = await withTimeout(
        fetchProfileById(verifiedUser.uid).catch(() => null),
        AUTH_PROFILE_FETCH_TIMEOUT_MS,
        "Tempo limite ao buscar perfil autenticado.",
      ).catch(() => null);
      syncKnownAccount(verifiedUser);
      setError(null);
      dispatch(authActions.authErrorChanged(null));
      return {
        user: verifiedUser,
        profile: ensuredProfile,
      };
    },
    [applySessionAndProfile, dispatch, syncKnownAccount],
  );

  const resendVerificationCode = useCallback(
    async (email: string): Promise<void> => {
      const normalizedUserEmail = normalizeEmail(email);
      if (!normalizedUserEmail) {
        throw new Error("Informe um e-mail válido.");
      }

      await authService.resendVerification(normalizedUserEmail);
      dispatch(authActions.authVerificationRequired({ email: normalizedUserEmail }));
    },
    [dispatch],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await endCurrentLoginSession();
    } catch {
      // Best effort only. Local sign-out continues below.
    }
    await authService.logout();
    clearCurrentLoginSessionStorage();
    setSession(null);
    setUser(null);
    setProfile(null);
    setStoredKnownAccounts(readKnownAccounts());
    setError(null);
    setAuthReady(true);
    setHasSessionHint(false);
    setSessionHintResolved(true);
    lastSessionAccessTokenRef.current = null;
    dispatch(authActions.authSignedOut());
  }, [dispatch]);

  const refreshSession = useCallback(async (): Promise<Session | null> => {
    const nextSession = await authService.refreshSession();
    await applySessionAndProfile(nextSession, {
      skipProfile: !nextSession?.user,
    });
    return nextSession;
  }, [applySessionAndProfile]);

  const getCurrentSession = useCallback(async (): Promise<Session | null> => {
    return authService.getCurrentSession();
  }, []);

  const authenticateAccount = useCallback(
    async ({ email, password, alias }: AuthenticateAccountParams): Promise<AuthUser> => {
      const { user: signedUser } = await signIn(email, password);

      if (alias) {
        const normalizedUserEmail = normalizeEmail(signedUser.email ?? "");
        if (normalizedUserEmail) {
          setStoredKnownAccounts(
            upsertKnownAccount({
              uid: signedUser.uid,
              email: normalizedUserEmail,
              alias,
              touchLastUsedAt: true,
            }),
          );
        }
      }

      return signedUser;
    },
    [signIn],
  );

  const signOutCurrent = useCallback(async (): Promise<void> => {
    await signOut();
  }, [signOut]);

  const forgetKnownAccount = useCallback(
    async (uidRaw: string): Promise<void> => {
      const uid = String(uidRaw ?? "").trim();
      if (!uid) {
        return;
      }

      if (user?.uid === uid) {
        await signOut();
      }

      setStoredKnownAccounts(removeKnownAccount(uid));
    },
    [signOut, user?.uid],
  );

  const updateCurrentAccountProfile = useCallback(
    ({ alias, avatarSrc }: UpdateCurrentAccountProfileParams): void => {
      if (!user?.uid) {
        return;
      }

      const normalizedUserEmail = normalizeEmail(user.email ?? "");
      if (!normalizedUserEmail) {
        return;
      }

      const normalizedAlias = String(alias ?? user.displayName ?? "").trim();
      const normalizedAvatar =
        typeof avatarSrc === "string" ? (avatarSrc.trim().length > 0 ? avatarSrc.trim() : null) : avatarSrc ?? null;

      setStoredKnownAccounts(
        upsertKnownAccount({
          uid: user.uid,
          email: normalizedUserEmail,
          alias: normalizedAlias || user.displayName,
          avatarSrc: normalizedAvatar,
          touchLastUsedAt: false,
        }),
      );
    },
    [user?.displayName, user?.email, user?.uid],
  );

  const refreshProfile = useCallback(async (): Promise<ProfileRow | null> => {
    const currentUserId = user?.uid;
    if (!currentUserId) {
      setProfile(null);
      return null;
    }

    const refreshed = await fetchProfileById(currentUserId);
    setProfile(refreshed);
    return refreshed;
  }, [user?.uid]);

  const knownAccounts = useMemo<SessionKnownAccount[]>(() => {
    const activeUid = user?.uid ?? null;
    return storedKnownAccounts.map((account) => ({
      uid: account.uid,
      email: account.email,
      alias: account.alias,
      avatarSrc: account.avatarSrc,
      lastUsedAt: account.lastUsedAt,
      isActive: Boolean(activeUid && activeUid === account.uid),
    }));
  }, [storedKnownAccounts, user?.uid]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      isLoading,
      loading: isLoading,
      authReady,
      requiresSignupSecurityVerification,
      hasSessionHint,
      sessionHintResolved,
      error,
      knownAccounts,
      signUp,
      verifyEmailCode,
      resendVerificationCode,
      signIn,
      signOut,
      refreshSession,
      getCurrentSession,
      authenticateAccount,
      signOutCurrent,
      forgetKnownAccount,
      refreshKnownAccounts,
      refreshProfile,
      updateCurrentAccountProfile,
    }),
    [
      session,
      user,
      profile,
      isLoading,
      authReady,
      requiresSignupSecurityVerification,
      hasSessionHint,
      sessionHintResolved,
      error,
      knownAccounts,
      signUp,
      verifyEmailCode,
      resendVerificationCode,
      signIn,
      signOut,
      refreshSession,
      getCurrentSession,
      authenticateAccount,
      signOutCurrent,
      forgetKnownAccount,
      refreshKnownAccounts,
      refreshProfile,
      updateCurrentAccountProfile,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuthSession(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    console.error("useAuthSession called without AuthProvider.");
    return FALLBACK_AUTH_CONTEXT;
  }
  return context;
}
