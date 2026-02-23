import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import AppShell from "../app/AppShell";
import LoginPage from "../auth/LoginPage";
import RegisterPage from "../auth/RegisterPage";
import VerifyEmailPage from "../auth/VerifyEmailPage";
import { useAuthSession } from "../auth/AuthProvider";

function LoadingScreen() {
  return <div className="auth-loading" aria-hidden="true" />;
}

function RootRedirect() {
  const { user, isLoading } = useAuthSession();
  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/auth/login" replace />;
  }

  if (!user.emailVerified) {
    return <Navigate to="/auth/verify" replace />;
  }

  return <Navigate to="/app" replace />;
}

function AppRoute() {
  const { user, isLoading } = useAuthSession();
  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/auth/login" replace />;
  }

  if (!user.emailVerified) {
    return <Navigate to="/auth/verify" replace />;
  }

  return <AppShell />;
}

function RegisterRoute() {
  const { user, isLoading } = useAuthSession();
  if (isLoading) {
    return <LoadingScreen />;
  }

  if (user?.emailVerified) {
    return <Navigate to="/app" replace />;
  }

  if (user && !user.emailVerified) {
    return <Navigate to="/auth/verify" replace />;
  }

  return <RegisterPage />;
}

function VerifyRoute() {
  const { user, isLoading } = useAuthSession();
  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/auth/login" replace />;
  }

  if (user.emailVerified) {
    return <Navigate to="/app" replace />;
  }

  return <VerifyEmailPage />;
}

function LoginRoute() {
  const { user, isLoading } = useAuthSession();
  if (isLoading) {
    return <LoadingScreen />;
  }

  if (user?.emailVerified) {
    return <Navigate to="/app" replace />;
  }

  return <LoginPage />;
}

export default function AppRoutes() {
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
