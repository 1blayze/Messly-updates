import { Suspense, lazy, type ReactNode, useEffect, useRef } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuthSession } from "../auth/AuthProvider";
import LoginPage from "../auth/LoginPage";
import AppShellFallback from "../app/AppShellFallback";
import { useAppBootstrapSnapshot } from "../core/appBootstrap";
import { markStartupUiReady } from "../app/startupUi";

type AppShellModule = typeof import("../app/AppShell");

let appShellPreloadPromise: Promise<AppShellModule> | null = null;

function preloadAppShell(): Promise<AppShellModule> {
  if (!appShellPreloadPromise) {
    appShellPreloadPromise = import("../app/AppShell");
  }
  return appShellPreloadPromise;
}

const AppShell = lazy(preloadAppShell);
const RegisterPage = lazy(() => import("../auth/RegisterPage"));
const VerifyEmailPage = lazy(() => import("../auth/VerifyEmailPage"));

function LoadingScreen() {
  return <div className="auth-loading" aria-hidden="true" />;
}

function RouteLoader({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingScreen />}>{children}</Suspense>;
}

function AuthSurface({ children }: { children: ReactNode }) {
  return (
    <div className="startup-auth-surface" data-messly-startup-surface="auth">
      {children}
    </div>
  );
}

function AuthBootstrapSplash() {
  return (
    <AppShellFallback
      statusText="Restaurando sessao"
      detailText="Carregando sessao, cache e shell inicial"
    />
  );
}

function shouldRenderLoginImmediately(params: {
  user: ReturnType<typeof useAuthSession>["user"];
  isLoading: boolean;
  authReady: boolean;
  hasSessionHint: boolean;
  sessionHintResolved: boolean;
}): boolean {
  if (params.user) {
    return false;
  }

  // Prevent login flicker: wait until session hint sources (preload/local store) settle.
  if (!params.sessionHintResolved) {
    return false;
  }

  if (!params.hasSessionHint) {
    return true;
  }

  if (params.authReady || !params.isLoading) {
    return true;
  }

  return false;
}

function AppShellRoute() {
  const { user } = useAuthSession();
  const currentUserId = String(user?.uid ?? "").trim();

  if (!currentUserId) {
    return (
      <AuthSurface>
        <RouteLoader>
          <LoginPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  return (
    <Suspense
      fallback={(
        <AppShellFallback
          statusText="Abrindo Messly"
          detailText="Montando o shell principal e aquecendo modulos criticos"
        />
      )}
    >
      <AppShell />
    </Suspense>
  );
}

function RootRedirect() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();

  if (shouldRenderLoginImmediately({ user, isLoading, authReady, hasSessionHint, sessionHintResolved })) {
    return (
      <AuthSurface>
        <RouteLoader>
          <LoginPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  if (!user) {
    return <AuthBootstrapSplash />;
  }

  return <AppShellRoute />;
}

function AppRoute() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();

  if (shouldRenderLoginImmediately({ user, isLoading, authReady, hasSessionHint, sessionHintResolved })) {
    return (
      <AuthSurface>
        <RouteLoader>
          <LoginPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  if (!user) {
    return <AuthBootstrapSplash />;
  }

  return <AppShellRoute />;
}

function RegisterRoute() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();
  if (user) {
    return <AppShellRoute />;
  }

  if (shouldRenderLoginImmediately({ user, isLoading, authReady, hasSessionHint, sessionHintResolved })) {
    return (
      <AuthSurface>
        <RouteLoader>
          <RegisterPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  return <AuthBootstrapSplash />;
}

function LoginRoute() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();
  if (user) {
    return <AppShellRoute />;
  }

  if (shouldRenderLoginImmediately({ user, isLoading, authReady, hasSessionHint, sessionHintResolved })) {
    return (
      <AuthSurface>
        <RouteLoader>
          <LoginPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  return <AuthBootstrapSplash />;
}

function VerifyRoute() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();
  if (user) {
    return <AppShellRoute />;
  }

  if (shouldRenderLoginImmediately({ user, isLoading, authReady, hasSessionHint, sessionHintResolved })) {
    return (
      <AuthSurface>
        <RouteLoader>
          <VerifyEmailPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  return <AuthBootstrapSplash />;
}

export default function AppRoutes() {
  const { user, isLoading, authReady, hasSessionHint, sessionHintResolved } = useAuthSession();
  const bootstrap = useAppBootstrapSnapshot();
  const hasDispatchedInitialReadyRef = useRef(false);
  const currentUserId = String(user?.uid ?? "").trim();
  const shouldShowLoginNow = shouldRenderLoginImmediately({
    user,
    isLoading,
    authReady,
    hasSessionHint,
    sessionHintResolved,
  });
  const shouldShowRestorationShell =
    !currentUserId && sessionHintResolved && hasSessionHint && !shouldShowLoginNow;

  useEffect(() => {
    if (currentUserId || hasSessionHint) {
      void preloadAppShell();
    }
  }, [currentUserId, hasSessionHint]);

  useEffect(() => {
    if (hasDispatchedInitialReadyRef.current) {
      return;
    }

    const startupSurface = shouldShowLoginNow
      ? { surface: "auth" as const, route: "/auth" }
      : currentUserId || shouldShowRestorationShell
        ? { surface: "shell" as const, route: currentUserId ? "/app" : "/session-restore" }
        : null;

    if (!startupSurface || typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let firstFrameId = 0;
    let secondFrameId = 0;

    const commitReady = (): void => {
      if (cancelled) {
        return;
      }

      const surfaceNode = document.querySelector<HTMLElement>(
        `[data-messly-startup-surface="${startupSurface.surface}"]`,
      );
      const rect = surfaceNode?.getBoundingClientRect();
      if (!surfaceNode || !rect || rect.width <= 0 || rect.height <= 0) {
        return;
      }

      hasDispatchedInitialReadyRef.current = true;
      markStartupUiReady({
        surface: startupSurface.surface,
        route: startupSurface.route,
        bootstrapPhase: bootstrap.phase,
      });
    };

    firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(commitReady);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrameId);
      window.cancelAnimationFrame(secondFrameId);
    };
  }, [bootstrap.phase, currentUserId, shouldShowLoginNow, shouldShowRestorationShell]);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/auth/login" element={<LoginRoute />} />
        <Route path="/auth/register" element={<RegisterRoute />} />
        <Route path="/auth/verify" element={<VerifyRoute />} />
        <Route path="/app" element={<AppRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
