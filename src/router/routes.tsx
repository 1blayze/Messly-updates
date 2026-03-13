import { Suspense, lazy, type ReactNode, useEffect, useRef, useState } from "react";
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuthSession } from "../auth/AuthProvider";
import LoginPage from "../auth/LoginPage";
import { appBootstrap, useAppBootstrapSnapshot } from "../core/appBootstrap";
import { markStartupUiReady } from "../app/startupUi";
import AppStartupScreen from "../app/AppStartupScreen";

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
const STARTUP_FONTS_TIMEOUT_MS = 900;
const STARTUP_READY_MAX_RETRIES = 10;
const STARTUP_LAYOUT_STABILITY_DELTA = 1;
const APP_BOOTSTRAP_STALL_TIMEOUT_MS = 25_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForFontsReady(timeoutMs: number): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return;
  }
  const fontSet = (document as Document & {
    fonts?: {
      ready: Promise<unknown>;
    };
  }).fonts;
  if (!fontSet?.ready) {
    return;
  }
  await Promise.race([
    fontSet.ready.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, Math.max(180, timeoutMs));
    }),
  ]);
}

function isStartupSurfaceReady(node: HTMLElement | null): node is HTMLElement {
  if (!node) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const opacity = Number.parseFloat(style.opacity || "1");
  return Number.isFinite(opacity) ? opacity > 0.92 : true;
}

async function hasStableLayout(node: HTMLElement): Promise<boolean> {
  const before = node.getBoundingClientRect();
  await nextFrame();
  const after = node.getBoundingClientRect();
  const widthDelta = Math.abs(before.width - after.width);
  const heightDelta = Math.abs(before.height - after.height);
  return widthDelta <= STARTUP_LAYOUT_STABILITY_DELTA && heightDelta <= STARTUP_LAYOUT_STABILITY_DELTA;
}

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
    <div className="startup-auth-surface" data-messly-startup-surface="shell">
      <AppStartupScreen statusText="Carregando Messly" detailText="Preparando aplicativo" progress={0.1} phase="running" />
    </div>
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
    return params.authReady || !params.isLoading;
  }

  // When we still have a session hint and auth is actively resolving, keep splash.
  if (params.isLoading) {
    return false;
  }

  return params.authReady || !params.isLoading;
}

function AppShellRoute() {
  const { user } = useAuthSession();
  const bootstrap = useAppBootstrapSnapshot();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const currentUserId = String(user?.uid ?? "").trim();
  const isBootstrapReady = bootstrap.phase === "ready" && bootstrap.userId === currentUserId;
  const shouldRenderAppShell =
    isBootstrapReady || (bootstrap.phase === "error" && bootstrap.userId === currentUserId);
  const isBootstrapStalled =
    Boolean(currentUserId) &&
    !shouldRenderAppShell &&
    (bootstrap.phase === "running" || bootstrap.phase === "idle") &&
    nowMs - Number(bootstrap.updatedAt || 0) >= APP_BOOTSTRAP_STALL_TIMEOUT_MS;

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    if (bootstrap.userId !== currentUserId || bootstrap.phase === "idle") {
      void appBootstrap.start(currentUserId).catch(() => undefined);
    }
  }, [bootstrap.phase, bootstrap.userId, currentUserId]);

  useEffect(() => {
    if (!currentUserId || shouldRenderAppShell) {
      return;
    }

    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [currentUserId, shouldRenderAppShell]);

  if (!currentUserId) {
    return (
      <AuthSurface>
        <RouteLoader>
          <LoginPage />
        </RouteLoader>
      </AuthSurface>
    );
  }

  if (!shouldRenderAppShell) {
    if (isBootstrapStalled) {
      return (
        <Suspense
          fallback={(
            <AppStartupScreen statusText="Abrindo interface" detailText="Inicializacao em modo de recuperacao" progress={0.98} phase="ready" />
          )}
        >
          <AppShell />
        </Suspense>
      );
    }

    return (
      <div className="startup-auth-surface" data-messly-startup-surface="shell">
        <AppStartupScreen
          statusText={bootstrap.statusText}
          detailText={bootstrap.detailText}
          progress={bootstrap.progress}
          phase={bootstrap.phase === "idle" ? "running" : bootstrap.phase}
          errorText={bootstrap.error}
        />
      </div>
    );
  }

  return (
    <Suspense
      fallback={(
        <AppStartupScreen statusText="Carregando Messly" detailText="Abrindo interface" progress={0.98} phase="ready" />
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
    const commitReady = async (): Promise<void> => {
      await waitForFontsReady(STARTUP_FONTS_TIMEOUT_MS);

      for (let attempt = 0; attempt < STARTUP_READY_MAX_RETRIES; attempt += 1) {
        if (cancelled) {
          return;
        }

        await nextFrame();
        await nextFrame();

        const surfaceNode = document.querySelector<HTMLElement>(
          `[data-messly-startup-surface="${startupSurface.surface}"]`,
        );
        if (!isStartupSurfaceReady(surfaceNode)) {
          continue;
        }

        if (!(await hasStableLayout(surfaceNode))) {
          continue;
        }

        hasDispatchedInitialReadyRef.current = true;
        markStartupUiReady({
          surface: startupSurface.surface,
          route: startupSurface.route,
          bootstrapPhase: bootstrap.phase,
        });
        return;
      }

      if (cancelled) {
        return;
      }
      hasDispatchedInitialReadyRef.current = true;
      markStartupUiReady({
        surface: startupSurface.surface,
        route: startupSurface.route,
        bootstrapPhase: bootstrap.phase,
      });
    };

    void commitReady();

    return () => {
      cancelled = true;
    };
  }, [bootstrap.phase, currentUserId, shouldShowLoginNow, shouldShowRestorationShell]);

  const Router = typeof window !== "undefined" && window.electronAPI ? HashRouter : BrowserRouter;

  return (
    <Router>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/auth/login" element={<LoginRoute />} />
        <Route path="/auth/register" element={<RegisterRoute />} />
        <Route path="/auth/verify" element={<VerifyRoute />} />
        <Route path="/app" element={<AppRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
