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
import { authService } from "../services/auth";
import { normalizeEmail, validateUsernameInput } from "../services/usernameAvailability";
import { ensureProfileForUser, fetchProfileById, type ProfileRow } from "../services/profile/profileService";
import {
  type KnownAccount as StoredKnownAccount,
  readKnownAccounts,
  removeKnownAccount,
  upsertKnownAccount,
} from "../services/auth/accountRegistry";
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
  signIn: (email: string, password: string) => Promise<{ user: AuthUser; profile: ProfileRow | null }>;
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

async function getInitialSessionOnce(): Promise<Session | null> {
  if (!bootstrapSessionPromise) {
    bootstrapSessionPromise = (async () => {
      const validatedAccessToken = await authService.getValidatedEdgeAccessToken();
      if (!validatedAccessToken) {
        return null;
      }

      return authService.getCurrentSession();
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

async function profileExists(uid: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("profiles").select("id").eq("id", uid).limit(1).maybeSingle();
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

      setIsLoading(true);
      try {
        let ensuredProfile = await ensureProfileForUser(mappedUser.raw, {
          preferredUsername: options.preferredUsername ?? mappedUser.raw.user_metadata?.username,
          displayName: options.displayName ?? mappedUser.displayName ?? mappedUser.email ?? null,
        });

        if (!ensuredProfile) {
          const exists = await profileExists(mappedUser.uid);
          if (!exists) {
            await supabase.auth.signOut({ scope: "local" });
            setSession(null);
            setUser(null);
            setProfile(null);
            setError("Sua conta não existe mais. Faça login novamente.");
            dispatch(authActions.authSignedOut());
            setAuthReady(true);
            setIsLoading(false);
            return;
          }
          ensuredProfile = await fetchProfileById(mappedUser.uid);
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

    void authService
      .hasStoredSessionHint()
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
        await applySessionAndProfile(initialSession);
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
        if (event === "INITIAL_SESSION" && nextSession?.access_token) {
          const validatedAccessToken = await authService.getValidatedEdgeAccessToken();
          if (!validatedAccessToken) {
            await applySessionAndProfile(null, { skipProfile: true });
            return;
          }
        }

        await applySessionAndProfile(nextSession);
      })();
    });

    subscriptionRef.current = authState.data.subscription;

    return () => {
      isMounted = false;
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [applySessionAndProfile, dispatch]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<{ user: AuthUser; profile: ProfileRow | null }> => {
      const normalizedUserEmail = normalizeEmail(email);
      const normalizedPassword = String(password ?? "");
      if (!normalizedUserEmail || !normalizedPassword) {
        throw new Error("Informe e-mail e senha para continuar.");
      }

      const nextSession = await authService.login(normalizedUserEmail, normalizedPassword);
      const signedUser = mapSupabaseUser(nextSession.user ?? null);
      if (!signedUser) {
        throw new Error("Sessão não retornada pelo Supabase.");
      }

      await applySessionAndProfile(nextSession);
      setHasSessionHint(true);
      setSessionHintResolved(true);
      const ensuredProfile = await fetchProfileById(signedUser.uid);
      syncKnownAccount(signedUser);
      setError(null);
      dispatch(authActions.authErrorChanged(null));
      return { user: signedUser, profile: ensuredProfile };
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
      if (!normalizedUserEmail || normalizedPassword.length < 8) {
        throw new Error("Informe e-mail válido e senha com pelo menos 8 caracteres.");
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
      if (requiresSignupSecurityVerification) {
        if (!turnstileToken) {
          throw new Error("Verificação de segurança obrigatória.");
        }
        if (!registrationFingerprint) {
          throw new Error("Não foi possível validar este dispositivo.");
        }
      }

      await authService.signup({
        email: normalizedUserEmail,
        password: normalizedPassword,
        turnstileToken: turnstileToken || "desktop-direct-signup",
        registrationFingerprint: registrationFingerprint || `desktop:${Date.now()}`,
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
        const ensuredProfile = await fetchProfileById(signedUser.uid);
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

      if (!requiresSignupSecurityVerification) {
        throw new Error("Cadastro criado. Confirme seu e-mail pelo link recebido e depois faça login.");
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
    [applySessionAndProfile, dispatch, requiresSignupSecurityVerification, syncKnownAccount],
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
      const ensuredProfile = await fetchProfileById(verifiedUser.uid);
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
    await authService.logout();
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
