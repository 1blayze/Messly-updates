import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { reload, sendEmailVerification, signOut } from "firebase/auth";
import { firebaseAuth } from "../services/firebase";
import { clearPendingProfile, ensureUser } from "../services/userSync";
import { presenceController } from "../services/presence/presenceController";
import { useAuthSession } from "./AuthProvider";
import "./auth.css";

export default function VerifyEmailPage() {
  const navigate = useNavigate();
  const { user } = useAuthSession();
  const [isChecking, setIsChecking] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleAlreadyVerified(): Promise<void> {
    setIsChecking(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const currentUser = firebaseAuth.currentUser;
      if (!currentUser) {
        navigate("/auth/login", { replace: true });
        return;
      }

      await reload(currentUser);
      if (!currentUser.emailVerified) {
        setErrorMessage("Seu e-mail ainda não foi confirmado.");
        return;
      }

      await ensureUser(currentUser);
      clearPendingProfile(currentUser.uid);
      presenceController.start(currentUser.uid);
      navigate("/app", { replace: true });
    } catch {
      setErrorMessage("Falha ao validar seu e-mail. Tente novamente.");
    } finally {
      setIsChecking(false);
    }
  }

  async function handleResendEmail(): Promise<void> {
    setIsResending(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const currentUser = firebaseAuth.currentUser;
      if (!currentUser) {
        navigate("/auth/login", { replace: true });
        return;
      }

      await sendEmailVerification(currentUser);
      setStatusMessage("Enviamos um novo e-mail de verificação.");
    } catch {
      setErrorMessage("Não foi possível reenviar o e-mail agora.");
    } finally {
      setIsResending(false);
    }
  }

  async function handleBackToLogin(): Promise<void> {
    presenceController.stop();
    clearPendingProfile(user?.uid);
    await signOut(firebaseAuth);
    navigate("/auth/login", { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card--verify">
        <h1 className="auth-title">Confirme seu e-mail</h1>
        <p className="auth-subtitle">
          Enviamos um link de verificação para <strong>{user?.email ?? "seu e-mail"}</strong>. Abra sua caixa de
          entrada e conclua a confirmação.
        </p>

        {errorMessage ? <p className="auth-feedback auth-feedback--error">{errorMessage}</p> : null}
        {statusMessage ? <p className="auth-feedback auth-feedback--success">{statusMessage}</p> : null}

        <div className="auth-form">
          <button className="auth-button" type="button" onClick={handleAlreadyVerified} disabled={isChecking}>
            {isChecking ? "Validando..." : "Já verifiquei"}
          </button>

          <button
            className="auth-button auth-button--secondary"
            type="button"
            onClick={handleResendEmail}
            disabled={isResending}
          >
            {isResending ? "Reenviando..." : "Reenviar e-mail"}
          </button>

          <button className="auth-button auth-button--ghost" type="button" onClick={handleBackToLogin}>
            Voltar para login
          </button>
        </div>
      </div>
    </div>
  );
}
