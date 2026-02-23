import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sendEmailVerification, signInWithEmailAndPassword } from "firebase/auth";
import { firebaseAuth } from "../services/firebase";
import { normalizeEmail } from "../services/usernameAvailability";
import { ensureUser } from "../services/userSync";
import { presenceController } from "../services/presence/presenceController";
import "./auth.css";

function mapLoginError(code: string): string {
  switch (code) {
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-credential":
      return "E-mail ou senha inválidos.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
    case "auth/invalid-email":
      return "Informe um e-mail válido.";
    default:
      return "Não foi possível entrar agora. Tente novamente.";
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [requiresVerification, setRequiresVerification] = useState(false);

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && password.length > 0 && !isSubmitting;
  }, [email, password, isSubmitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);
    setRequiresVerification(false);

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      setErrorMessage("Informe e-mail e senha.");
      return;
    }

    setIsSubmitting(true);
    try {
      const credentials = await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, password);
      const user = credentials.user;

      if (!user.emailVerified) {
        setRequiresVerification(true);
        setErrorMessage("Confirme seu e-mail para continuar.");
        return;
      }

      await ensureUser(user);
      presenceController.start(user.uid);
      navigate("/app", { replace: true });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: string }).code ?? "")
          : "";
      setErrorMessage(mapLoginError(code));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResendVerification(): Promise<void> {
    setErrorMessage(null);
    setInfoMessage(null);
    setIsResending(true);

    try {
      let user = firebaseAuth.currentUser;
      if (!user && email && password) {
        const credentials = await signInWithEmailAndPassword(firebaseAuth, normalizeEmail(email), password);
        user = credentials.user;
      }

      if (!user) {
        setErrorMessage("Entre com sua conta para reenviar a verificação.");
        return;
      }

      if (user.emailVerified) {
        setInfoMessage("Seu e-mail já está confirmado.");
        return;
      }

      await sendEmailVerification(user);
      setRequiresVerification(true);
      setInfoMessage("E-mail de verificação reenviado.");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: string }).code ?? "")
          : "";
      setErrorMessage(mapLoginError(code));
    } finally {
      setIsResending(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Entrar no Messly</h1>
        <p className="auth-subtitle">Use seu e-mail e senha para acessar suas conversas.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="login-email">
              E-mail
            </label>
            <input
              id="login-email"
              className="auth-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="login-password">
              Senha
            </label>
            <input
              id="login-password"
              className="auth-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </div>

          {errorMessage ? <p className="auth-feedback auth-feedback--error">{errorMessage}</p> : null}
          {infoMessage ? <p className="auth-feedback auth-feedback--success">{infoMessage}</p> : null}

          <button className="auth-button" type="submit" disabled={!canSubmit}>
            {isSubmitting ? "Entrando..." : "Entrar"}
          </button>
        </form>

        {requiresVerification ? (
          <div className="auth-footer">
            <span>Conta sem verificação?</span>
            <button className="auth-link" type="button" onClick={handleResendVerification} disabled={isResending}>
              {isResending ? "Enviando..." : "Reenviar verificação"}
            </button>
          </div>
        ) : null}

        <div className="auth-footer">
          <span>Ainda não tem conta?</span>
          <Link className="auth-link" to="/auth/register">
            Criar conta
          </Link>
        </div>
      </div>
    </div>
  );
}
