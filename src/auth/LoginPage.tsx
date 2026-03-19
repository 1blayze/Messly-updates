import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthSession } from "./AuthProvider";
import { toFriendlySupabaseAuthError } from "./supabaseAuthErrors";
import { AuthApiError } from "../api/authApi";
import TurnstileWidget, { type TurnstileWidgetHandle } from "../components/security/TurnstileWidget";
import { createRegistrationFingerprint } from "../security/createRegistrationFingerprint";
import MaterialSymbolIcon from "../components/ui/MaterialSymbolIcon";
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

const CAPTCHA_ERROR_CODES = new Set([
  "CAPTCHA_REQUIRED",
  "CAPTCHA_INVALID",
  "CAPTCHA_EXPIRED",
  "CAPTCHA_TIMEOUT",
  "CAPTCHA_NETWORK_ERROR",
]);

export default function LoginPage() {
  const navigate = useNavigate();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const { signIn } = useAuthSession();
  const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [loginFingerprint, setLoginFingerprint] = useState("");
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [showCaptcha, setShowCaptcha] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void createRegistrationFingerprint()
      .then((fingerprint) => {
        if (cancelled) {
          return;
        }
        setLoginFingerprint(fingerprint);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLoginFingerprint("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = useMemo(() => {
    if (!isValidEmail(email) || password.length < 8 || isSubmitting) {
      return false;
    }
    if (showCaptcha) {
      return Boolean(turnstileSiteKey) && Boolean(turnstileToken);
    }
    return true;
  }, [email, password, isSubmitting, showCaptcha, turnstileSiteKey, turnstileToken]);

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

    if (showCaptcha && !turnstileToken) {
      setErrorMessage("Conclua a verificacao de seguranca para continuar.");
      return;
    }

    setIsSubmitting(true);
    try {
      await signIn(email, password, {
        turnstileToken: turnstileToken || null,
        loginFingerprint: loginFingerprint || null,
        client: {
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          platform: typeof navigator !== "undefined" ? navigator.platform : null,
        },
      });
      setFailedAttempts(0);
      setShowCaptcha(false);
      setTurnstileToken("");
      navigate("/app", { replace: true });
    } catch (error) {
      if (import.meta.env.DEV && !isExpectedAuthFailure(error)) {
        console.error("[auth:sign-in]", error);
      }
      const errorCode =
        error instanceof AuthApiError
          ? String(error.code ?? "").trim().toUpperCase()
          : String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
      if (CAPTCHA_ERROR_CODES.has(errorCode)) {
        setShowCaptcha(true);
        setTurnstileToken("");
        turnstileRef.current?.reset();
      }
      if (isExpectedAuthFailure(error)) {
        setFailedAttempts((current) => {
          const next = current + 1;
          if (next >= 2) {
            setShowCaptcha(true);
          }
          return next;
        });
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
      <div className="auth-brand" aria-label="Azyoon">
        <img className="auth-brand__logo" src={mewsLogo} alt="Azyoon" />
        <span className="auth-brand__name">Azyoon</span>
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
                <MaterialSymbolIcon name={showPassword ? "visibility_off" : "visibility"} size={18} />
              </button>
            </div>
          </div>

          {showCaptcha ? (
            <div className="auth-field auth-field--captcha" aria-live="polite">
              {turnstileSiteKey ? (
                <TurnstileWidget
                  ref={turnstileRef}
                  className="auth-turnstile"
                  siteKey={turnstileSiteKey}
                  showErrors
                  onVerify={(token) => {
                    setTurnstileToken(token);
                    setErrorMessage(null);
                  }}
                  onError={() => {
                    setTurnstileToken("");
                  }}
                  onExpire={() => {
                    setTurnstileToken("");
                    turnstileRef.current?.reset();
                  }}
                  onTimeout={() => {
                    setTurnstileToken("");
                    turnstileRef.current?.reset();
                  }}
                />
              ) : (
                <p className="auth-feedback auth-feedback--error">
                  Chave do Turnstile nao configurada. Defina VITE_TURNSTILE_SITE_KEY.
                </p>
              )}
            </div>
          ) : null}

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
