import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthSession } from "./AuthProvider";
import { toFriendlySupabaseAuthError } from "./supabaseAuthErrors";
import "./auth.css";

export default function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, resendVerificationCode, signOut } = useAuthSession();
  const [isResending, setIsResending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const email = useMemo(() => {
    const queryEmail = new URLSearchParams(location.search).get("email");
    return String(queryEmail ?? user?.email ?? "").trim();
  }, [location.search, user?.email]);

  async function handleResendEmail(): Promise<void> {
    if (!email) {
      setErrorMessage("Não foi possível identificar seu e-mail.");
      return;
    }

    setIsResending(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      await resendVerificationCode(email);
      setStatusMessage("Código de verificação reenviado.");
    } catch (error) {
      setErrorMessage(toFriendlySupabaseAuthError(error));
    } finally {
      setIsResending(false);
    }
  }

  async function handleBackToLogin(): Promise<void> {
    await signOut();
    navigate("/auth/login", { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card--verify">
        <h1 className="auth-title">Confirme seu e-mail</h1>
        <p className="auth-subtitle">
          Verifique sua caixa de entrada para concluir o cadastro.
          <br />
          {email ? (
            <>
              Endereço: <strong>{email}</strong>
            </>
          ) : null}
        </p>

        {errorMessage ? <p className="auth-feedback auth-feedback--error">{errorMessage}</p> : null}
        {statusMessage ? <p className="auth-feedback auth-feedback--success">{statusMessage}</p> : null}

        <div className="auth-form">
          <button className="auth-button" type="button" onClick={handleResendEmail} disabled={isResending}>
            {isResending ? "Reenviando..." : "Reenviar código"}
          </button>

          <button className="auth-button auth-button--ghost" type="button" onClick={handleBackToLogin}>
            Voltar ao login
          </button>
        </div>
      </div>
    </div>
  );
}
