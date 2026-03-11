import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthSession } from "./AuthProvider";
import { toFriendlySupabaseAuthError } from "./supabaseAuthErrors";
import mewsLogo from "../assets/icons/ui/messly.svg";
import "./auth.css";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isExpectedAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    code === "INVALID_CREDENTIALS" ||
    code === "EMAIL_VERIFICATION_REQUIRED" ||
    code === "AUTH_RATE_LIMITED" ||
    message.includes("invalid login credentials")
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return isValidEmail(email) && password.length >= 8 && !isSubmitting;
  }, [email, password, isSubmitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (!isValidEmail(email)) {
      setErrorMessage("Informe um e-mail válido.");
      return;
    }

    if (password.length < 8) {
      setErrorMessage("A senha deve ter pelo menos 8 caracteres.");
      return;
    }

    setIsSubmitting(true);
    try {
      await signIn(email, password);
      navigate("/app", { replace: true });
    } catch (error) {
      if (import.meta.env.DEV && !isExpectedAuthFailure(error)) {
        console.error("[auth:sign-in]", error);
      }
      setErrorMessage(toFriendlySupabaseAuthError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleForgotPassword(): void {
    setInfoMessage("A recuperação de senha estará disponível em breve.");
  }

  return (
    <div className="auth-page">
      <div className="auth-brand" aria-label="Messly">
        <img className="auth-brand__logo" src={mewsLogo} alt="Messly" />
        <span className="auth-brand__name">Messly</span>
      </div>
      <div className="auth-card">
        <h1 className="auth-title auth-title--welcome">Boas-vindas de volta!</h1>
        <p className="auth-subtitle">Acesse sua conta para continuar.</p>

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
            <div className="auth-label-row">
              <label className="auth-label" htmlFor="login-password">
                Senha
              </label>
              <button className="auth-forgot-link" type="button" onClick={handleForgotPassword}>
                Esqueceu a senha?
              </button>
            </div>
            <div className="auth-input-shell">
              <input
                id="login-password"
                className="auth-input auth-input--bare"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={isSubmitting}
                required
              />
              <button
                type="button"
                className="auth-input-addon"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                disabled={isSubmitting}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a21.77 21.77 0 0 1 4.42-5.66M9.53 9.53A3 3 0 0 0 12 15a3 3 0 0 0 2.12-.88" />
                    <path d="M1 1l22 22" />
                    <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
                    <path d="M10.73 5.08A10.94 10.94 0 0 1 12 4c7 0 10 8 10 8a21.77 21.77 0 0 1-3.17 4.11" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s3-8 11-8 11 8 11 8-3 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {errorMessage ? <p className="auth-feedback auth-feedback--error">{errorMessage}</p> : null}
          {infoMessage ? <p className="auth-feedback auth-feedback--success">{infoMessage}</p> : null}

          <button className="auth-button" type="submit" disabled={!canSubmit}>
            {isSubmitting ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Ainda não tem uma conta?</span>
          <Link className="auth-link" to="/auth/register">
            Criar conta
          </Link>
        </div>
      </div>
    </div>
  );
}
