import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthSession } from "./AuthProvider";
import { toFriendlySupabaseAuthError } from "./supabaseAuthErrors";
import { AuthApiError } from "../api/authApi";
import {
  isUsernameAvailable,
  normalizeEmail,
  sanitizeDisplayName,
  validateUsernameInput,
} from "../services/usernameAvailability";
import { formatUsernameForDisplay, normalizeUsername } from "../shared/username";
import { ensureUser, savePendingProfile } from "../services/userSync";
import TurnstileWidget, { type TurnstileWidgetHandle } from "../components/security/TurnstileWidget";
import MaterialSymbolIcon from "../components/ui/MaterialSymbolIcon";
import { createRegistrationFingerprint } from "../security/createRegistrationFingerprint";
import mewsLogo from "../assets/icons/ui/messly.svg";
import "./auth.css";

type UsernameCheckStatus = "idle" | "checking" | "invalid" | "available";
type BirthField = "day" | "month" | "year";
type RegisterStage = "form" | "otp";
type CaptchaVerificationState = "idle" | "verified" | "error" | "expired" | "timeout";

const CAPTCHA_RESET_ERROR_CODES = new Set([
  "CAPTCHA_REQUIRED",
  "CAPTCHA_INVALID",
  "CAPTCHA_EXPIRED",
  "CAPTCHA_TIMEOUT",
  "CAPTCHA_NETWORK_ERROR",
  "CAPTCHA_VALIDATION_FAILED",
  "REGISTER_BLOCKED_HIGH_RISK",
]);

interface FieldErrors {
  displayName?: string;
  username?: string;
  email?: string;
  password?: string;
  birthDate?: string;
}

interface BirthOption {
  value: string;
  label: string;
}

interface BirthSelectProps {
  id?: string;
  ariaLabel: string;
  placeholder: string;
  value: string;
  options: BirthOption[];
  disabled: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (nextValue: string) => void;
}

const MONTH_OPTIONS: BirthOption[] = [
  { value: "1", label: "janeiro" },
  { value: "2", label: "fevereiro" },
  { value: "3", label: "março" },
  { value: "4", label: "abril" },
  { value: "5", label: "maio" },
  { value: "6", label: "junho" },
  { value: "7", label: "julho" },
  { value: "8", label: "agosto" },
  { value: "9", label: "setembro" },
  { value: "10", label: "outubro" },
  { value: "11", label: "novembro" },
  { value: "12", label: "dezembro" },
];

function parseBirthDateParts(dayValue: string, monthValue: string, yearValue: string): Date | null {
  if (!dayValue || !monthValue || !yearValue || yearValue.length !== 4) {
    return null;
  }

  const day = Number(dayValue);
  const month = Number(monthValue);
  const year = Number(yearValue);
  const currentYear = new Date().getFullYear();

  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null;
  }
  if (day < 1 || day > 31) {
    return null;
  }
  if (month < 1 || month > 12) {
    return null;
  }
  if (year < 1900 || year > currentYear) {
    return null;
  }

  const parsedDate = new Date(year, month - 1, day);
  const isSameDate =
    parsedDate.getFullYear() === year &&
    parsedDate.getMonth() === month - 1 &&
    parsedDate.getDate() === day;

  return isSameDate ? parsedDate : null;
}

function calculateAge(birthDate: Date): number {
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const monthDiff = now.getMonth() - birthDate.getMonth();
  const dayDiff = now.getDate() - birthDate.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }
  return age;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password: string): boolean {
  return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password);
}

function resolveAuthApiErrorCode(error: unknown): string {
  if (error instanceof AuthApiError) {
    return String(error.code ?? "").trim().toUpperCase();
  }
  return String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
}

function BirthSelect({
  id,
  ariaLabel,
  placeholder,
  value,
  options,
  disabled,
  isOpen,
  onToggle,
  onSelect,
}: BirthSelectProps) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <div className="auth-birth-select">
      <button
        id={id}
        type="button"
        className={`auth-birth-trigger ${isOpen ? "auth-birth-trigger--open" : ""}`}
        onClick={onToggle}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="auth-birth-trigger-text">{selectedOption?.label ?? placeholder}</span>
        <span className={`auth-birth-chevron ${isOpen ? "auth-birth-chevron--open" : ""}`} aria-hidden="true">
          <MaterialSymbolIcon className="auth-birth-chevron-icon" name="expand_more" size={14} />
        </span>
      </button>

      {isOpen ? (
        <div className="auth-birth-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`auth-birth-option ${value === option.value ? "auth-birth-option--active" : ""}`}
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const { signUp, verifyEmailCode, resendVerificationCode, requiresSignupSecurityVerification } = useAuthSession();
  const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();
  const shouldRenderCaptcha = Boolean(turnstileSiteKey);
  const currentYear = new Date().getFullYear();
  const birthGridRef = useRef<HTMLDivElement | null>(null);
  const usernameCheckRef = useRef<number | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);

  const [stage, setStage] = useState<RegisterStage>("form");
  const [pendingEmail, setPendingEmail] = useState("");
  const [pendingUsername, setPendingUsername] = useState("");
  const [pendingDisplayName, setPendingDisplayName] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formMessageTone, setFormMessageTone] = useState<"error" | "success">("error");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<UsernameCheckStatus>("idle");
  const [usernameStatusText, setUsernameStatusText] = useState("");
  const [openBirthField, setOpenBirthField] = useState<BirthField | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [verificationState, setVerificationState] = useState<CaptchaVerificationState>("idle");
  const [registrationFingerprint, setRegistrationFingerprint] = useState<string>("");
  const [captchaDiagnostic, setCaptchaDiagnostic] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) {
      return;
    }
    const id = window.setInterval(() => {
      setResendCooldown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendCooldown]);

  useEffect(() => {
    let cancelled = false;

    void createRegistrationFingerprint()
      .then((fingerprint) => {
        if (cancelled) {
          return;
        }
        setRegistrationFingerprint(fingerprint);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setRegistrationFingerprint("");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setUsernameStatus("idle");
      setUsernameStatusText("");
      return;
    }

    const validation = validateUsernameInput(trimmedUsername);
    if (!validation.isValid) {
      setUsernameStatus("invalid");
      setUsernameStatusText(validation.message ?? "Nome de usuário inválido.");
      return;
    }

    setUsernameStatus("checking");
    setUsernameStatusText("Verificando disponibilidade...");

    window.clearTimeout(usernameCheckRef.current ?? 0);
    usernameCheckRef.current = window.setTimeout(async () => {
      try {
        const available = await isUsernameAvailable(trimmedUsername);
        setUsernameStatus(available ? "available" : "invalid");
        setUsernameStatusText(
          available ? "Nome de usuário disponível." : "Este nome de usuário já está em uso.",
        );
      } catch {
        setUsernameStatus("invalid");
        setUsernameStatusText("Não foi possível verificar o nome de usuário.");
      }
    }, 250);
  }, [username]);

  useEffect(() => {
    if (!openBirthField) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!birthGridRef.current?.contains(target)) {
        setOpenBirthField(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpenBirthField(null);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openBirthField]);

  function validateBeforeSubmit(): boolean {
    const nextErrors: FieldErrors = {};
    const cleanDisplayName = sanitizeDisplayName(displayName);
    const cleanUsername = username.trim();
    const normalizedEmailValue = normalizeEmail(email);
    const parsedBirthDate = parseBirthDateParts(birthDay, birthMonth, birthYear);

    if (cleanDisplayName.length < 2 || cleanDisplayName.length > 32) {
      nextErrors.displayName = "Use entre 2 e 32 caracteres.";
    }

    const usernameValidation = validateUsernameInput(cleanUsername);
    if (!usernameValidation.isValid) {
      nextErrors.username = usernameValidation.message ?? "Nome de usuário inválido.";
    }

    if (!isValidEmail(normalizedEmailValue)) {
      nextErrors.email = "Informe um e-mail válido.";
    }

    if (!isValidPassword(password)) {
      nextErrors.password = "Use pelo menos 8 caracteres, com letra e número.";
    }

    if (!parsedBirthDate) {
      nextErrors.birthDate = "Informe uma data de nascimento válida.";
    } else if (calculateAge(parsedBirthDate) < 13) {
      nextErrors.birthDate = "Você precisa ter pelo menos 13 anos para criar a conta.";
    }

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormMessage(null);
    setFieldErrors({});
    setCaptchaError(null);

    if (!validateBeforeSubmit()) {
      return;
    }

    if (requiresSignupSecurityVerification && !turnstileSiteKey) {
      setFormMessageTone("error");
      setFormMessage("Não foi possível iniciar a verificação de segurança. Tente novamente em instantes.");
      return;
    }

    if (requiresSignupSecurityVerification && !turnstileToken) {
      setVerificationState("error");
      setCaptchaError("Conclua a verificação de segurança antes de continuar.");
      turnstileRef.current?.reset();
      return;
    }

    if (requiresSignupSecurityVerification && !registrationFingerprint) {
      setFormMessageTone("error");
      setFormMessage("Não foi possível validar este dispositivo. Recarregue a tela e tente novamente.");
      return;
    }

    setIsSubmitting(true);
    try {
      const cleanDisplayName = sanitizeDisplayName(displayName);
      const cleanUsername = normalizeUsername(username);
      const normalizedEmailValue = normalizeEmail(email);

      const available = await isUsernameAvailable(cleanUsername, { requireRemote: true });
      if (!available) {
        setFieldErrors({ username: "Este nome de usuário já está em uso." });
        setUsernameStatus("invalid");
        setUsernameStatusText("Este nome de usuário já está em uso.");
        return;
      }

      const signUpResult = await signUp(normalizedEmailValue, password, {
        displayName: cleanDisplayName,
        username: cleanUsername,
      }, {
        turnstileToken,
        registrationFingerprint,
      });

      if (signUpResult.user && !signUpResult.needsEmailConfirmation) {
        navigate("/app", { replace: true });
        return;
      }

      savePendingProfile({
        username: cleanUsername,
        displayName: cleanDisplayName,
        createdAt: Date.now(),
      });

      setPendingEmail(normalizedEmailValue);
      setPendingUsername(cleanUsername);
      setPendingDisplayName(cleanDisplayName);
      setPassword("");
      setOtpCode("");
      setOtpMessage(null);
      setOtpError(null);
      setResendCooldown(35);
      setTurnstileToken("");
      setVerificationState("idle");
      setCaptchaError(null);
      setStage("otp");
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[auth:sign-up]", error);
      }

      const errorCode = resolveAuthApiErrorCode(error);
      if (requiresSignupSecurityVerification && CAPTCHA_RESET_ERROR_CODES.has(errorCode)) {
        setTurnstileToken("");
        setVerificationState(errorCode === "CAPTCHA_EXPIRED" ? "expired" : "error");
        setCaptchaError("A verificação de segurança expirou ou falhou. Confirme novamente.");
        turnstileRef.current?.reset();
      }
      const friendly = toFriendlySupabaseAuthError(error);
      if (friendly.toLowerCase().startsWith("cadastro criado.")) {
        setFormMessageTone("success");
        setFormMessage(friendly);
      } else {
        setFormMessageTone("error");
        setFormMessage(friendly);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResendOtp(): Promise<void> {
    if (!pendingEmail || resendCooldown > 0) {
      return;
    }
    setOtpError(null);
    setOtpMessage(null);
    try {
      await resendVerificationCode(pendingEmail);
      setOtpMessage("Reenviamos um novo código para seu e-mail.");
      setResendCooldown(35);
    } catch (error) {
      setOtpError(toFriendlySupabaseAuthError(error));
      setOtpMessage(null);
    }
  }

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const sanitizedCode = otpCode.trim();
    if (!pendingEmail) {
      setOtpError("E-mail não encontrado para verificar. Refaça o cadastro.");
      return;
    }
    if (!sanitizedCode) {
      setOtpError("Digite o código recebido por e-mail.");
      return;
    }
    if (sanitizedCode.length !== 6) {
      setOtpError("Digite os 6 dígitos do código.");
      return;
    }

    setOtpError(null);
    setOtpMessage(null);
    setIsVerifyingOtp(true);
    try {
      const { user } = await verifyEmailCode(pendingEmail, sanitizedCode);

      if (user) {
        try {
          await ensureUser(user.raw ?? user, {
            username: pendingUsername,
            displayName: pendingDisplayName || user.displayName || "",
          });
        } catch (userSyncError) {
          setOtpError(toFriendlySupabaseAuthError(userSyncError));
          setUsernameStatus("invalid");
          setUsernameStatusText(toFriendlySupabaseAuthError(userSyncError));
          setIsVerifyingOtp(false);
          return;
        }
      }

      setOtpMessage("Conta confirmada! Redirecionando...");
      navigate("/app", { replace: true });
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[auth:verify-otp]", error);
      }
      setOtpError(toFriendlySupabaseAuthError(error));
      setOtpMessage(null);
    } finally {
      setIsVerifyingOtp(false);
    }
  }
  const dayOptions: BirthOption[] = Array.from({ length: 31 }, (_, index) => {
    const day = String(index + 1);
    return { value: day, label: day };
  });

  const yearOptions: BirthOption[] = Array.from({ length: currentYear - 1899 }, (_, index) => {
    const year = String(currentYear - index);
    return { value: year, label: year };
  });

  const normalizedUsernamePreview = formatUsernameForDisplay(username);
  const canSubmitRegistration =
    !isSubmitting;
  const shouldShowCaptchaDiagnostic = import.meta.env.DEV && Boolean(captchaDiagnostic);

  const title = stage === "form" ? "Criar conta" : "Confirme seu e-mail";
  const subtitle = stage === "form" ? "Crie sua conta para começar a conversar." : "Confirme seu e-mail para continuar.";

  return (
    <div className="auth-page auth-page--register">
      <div className="auth-brand" aria-label="Messly">
        <img className="auth-brand__logo" src={mewsLogo} alt="Messly" />
        <span className="auth-brand__name">Messly</span>
      </div>
      <div className="auth-card auth-card--register">
        <h1 className="auth-title">{title}</h1>
        <p className="auth-subtitle">{subtitle}</p>

        {stage === "form" ? (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-field">
              <label className="auth-label" htmlFor="register-email">
                E-mail
              </label>
              <input
                id="register-email"
                className="auth-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={isSubmitting}
                required
              />
              {fieldErrors.email ? <p className="auth-feedback auth-feedback--error">{fieldErrors.email}</p> : null}
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="register-display-name">
                Nome de exibição
              </label>
              <input
                id="register-display-name"
                className="auth-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={32}
                disabled={isSubmitting}
                required
              />
              {fieldErrors.displayName ? (
                <p className="auth-feedback auth-feedback--error">{fieldErrors.displayName}</p>
              ) : null}
            </div>

            <div className="auth-field">
              <div className="auth-label-row">
                <label className="auth-label" htmlFor="register-username">
                  Nome de usuário
                </label>
                {normalizedUsernamePreview ? (
                  <span className="auth-username-preview">{normalizedUsernamePreview}</span>
                ) : null}
              </div>
              <input
                id="register-username"
                className="auth-input"
                value={username}
                onChange={(event) => {
                  const next = event.target.value;
                  setUsername(next);
                  setFieldErrors((prev) => ({ ...prev, username: undefined }));
                }}
                autoComplete="username"
                maxLength={32}
                disabled={isSubmitting}
                required
              />
              {fieldErrors.username ? (
                <p className="auth-feedback auth-feedback--error">{fieldErrors.username}</p>
              ) : usernameStatus !== "idle" ? (
                <p
                  className={`auth-availability ${
                    usernameStatus === "available" ? "auth-availability--available" : "auth-availability--unavailable"
                  }`}
                >
                  {usernameStatusText}
                </p>
              ) : null}
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="register-password">
                Senha
              </label>
              <div className="auth-input-shell">
                <input
                  id="register-password"
                  className="auth-input auth-input--bare"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isSubmitting}
                  required
                />
                <button
                  type="button"
                  className="auth-input-addon"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  <MaterialSymbolIcon name={showPassword ? "visibility_off" : "visibility"} size={18} />
                </button>
              </div>
              <p className="auth-note">Use no mínimo 8 caracteres, com pelo menos 1 letra e 1 número.</p>
              {fieldErrors.password ? (
                <p className="auth-feedback auth-feedback--error">{fieldErrors.password}</p>
              ) : null}
            </div>

            <div className="auth-field">
              <label className="auth-label">Data de nascimento</label>
              <div className="auth-birth-grid" ref={birthGridRef}>
                <BirthSelect
                  id="register-birth-day"
                  ariaLabel="Dia de nascimento"
                  placeholder="Dia"
                  value={birthDay}
                  options={dayOptions}
                  disabled={isSubmitting}
                  isOpen={openBirthField === "day"}
                  onToggle={() => setOpenBirthField((current) => (current === "day" ? null : "day"))}
                  onSelect={(nextValue) => {
                    setBirthDay(nextValue);
                    setOpenBirthField(null);
                  }}
                />
                <BirthSelect
                  ariaLabel="Mês de nascimento"
                  placeholder="Mês"
                  value={birthMonth}
                  options={MONTH_OPTIONS}
                  disabled={isSubmitting}
                  isOpen={openBirthField === "month"}
                  onToggle={() => setOpenBirthField((current) => (current === "month" ? null : "month"))}
                  onSelect={(nextValue) => {
                    setBirthMonth(nextValue);
                    setOpenBirthField(null);
                  }}
                />
                <BirthSelect
                  ariaLabel="Ano de nascimento"
                  placeholder="Ano"
                  value={birthYear}
                  options={yearOptions}
                  disabled={isSubmitting}
                  isOpen={openBirthField === "year"}
                  onToggle={() => setOpenBirthField((current) => (current === "year" ? null : "year"))}
                  onSelect={(nextValue) => {
                    setBirthYear(nextValue);
                    setOpenBirthField(null);
                  }}
                />
              </div>
              <p className="auth-note">É necessário ter pelo menos 13 anos para criar uma conta.</p>
              {fieldErrors.birthDate ? (
                <p className="auth-feedback auth-feedback--error">{fieldErrors.birthDate}</p>
              ) : null}
            </div>

            {shouldRenderCaptcha ? (
              <div className="auth-field auth-field--captcha" aria-live="polite">
                <TurnstileWidget
                  ref={turnstileRef}
                  className="auth-turnstile"
                  siteKey={turnstileSiteKey}
                  showErrors={requiresSignupSecurityVerification}
                  onVerify={(token) => {
                    setTurnstileToken(token);
                    setVerificationState("verified");
                    setCaptchaDiagnostic(null);
                    if (requiresSignupSecurityVerification) {
                      setCaptchaError(null);
                    }
                  }}
                  onError={() => {
                    setTurnstileToken("");
                    if (requiresSignupSecurityVerification) {
                      setVerificationState("error");
                      setCaptchaError("A verificação de segurança falhou. Tente novamente.");
                    }
                  }}
                  onExpire={() => {
                    setTurnstileToken("");
                    if (requiresSignupSecurityVerification) {
                      setVerificationState("expired");
                      setCaptchaError("A verificação expirou. Confirme novamente para continuar.");
                      turnstileRef.current?.reset();
                    }
                  }}
                  onTimeout={() => {
                    setTurnstileToken("");
                    if (requiresSignupSecurityVerification) {
                      setVerificationState("timeout");
                      setCaptchaError("Tempo esgotado na verificação. Tente novamente.");
                      turnstileRef.current?.reset();
                    }
                  }}
                  onDiagnostic={(event) => {
                    const parts = [
                      event.code,
                      `tentativa=${event.attempt}`,
                      `online=${event.online ? "1" : "0"}`,
                      event.rawError ? `erro=${event.rawError}` : "",
                    ].filter(Boolean);
                    setCaptchaDiagnostic(parts.join(" | "));
                  }}
                />
                {!registrationFingerprint && requiresSignupSecurityVerification ? (
                  <p className="auth-note">Preparando verificação do dispositivo...</p>
                ) : null}
                {!requiresSignupSecurityVerification ? (
                  <p className="auth-note">Verificação de segurança opcional no aplicativo instalado.</p>
                ) : null}
                {shouldShowCaptchaDiagnostic ? (
                  <p className="auth-note auth-note--diagnostic">Diagnóstico do captcha: {captchaDiagnostic}</p>
                ) : null}
                {captchaError ? <p className="auth-feedback auth-feedback--error">{captchaError}</p> : null}
              </div>
            ) : null}

            {formMessage ? (
              <p
                className={`auth-feedback ${
                  formMessageTone === "error" ? "auth-feedback--error" : "auth-feedback--success"
                }`}
              >
                {formMessage}
              </p>
            ) : null}

            <button className="auth-button" type="submit" disabled={!canSubmitRegistration}>
              {isSubmitting ? "Continuando..." : "Continuar"}
            </button>
            <p className="auth-legal">
              Ao se registrar, você concorda com os <a href="#">Termos de Serviço</a> e a{" "}
              <a href="#">Política de Privacidade</a>.
            </p>
            <div className="auth-footer">
              <span>Já tem uma conta?</span>
              <Link className="auth-link" to="/auth/login">
                Entrar
              </Link>
            </div>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleVerifyOtp}>
            <div className="auth-otp-hint">
              <p className="auth-otp-hint-text">
                Enviamos um código para <span className="auth-otp-email">{pendingEmail}</span>. Digite abaixo para
                confirmar sua conta.
              </p>
            </div>
            <div className="auth-field">
              <label className="auth-label auth-label--spaced" htmlFor="register-otp">
                CÓDIGO DE VERIFICAÇÃO
              </label>
              <input
                id="register-otp"
                className="auth-input auth-otp-input"
                inputMode="numeric"
                maxLength={6}
                value={otpCode}
                onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))}
                autoComplete="one-time-code"
                disabled={isVerifyingOtp}
                required
              />
            </div>

            {otpError ? <p className="auth-feedback auth-feedback--error">{otpError}</p> : null}
            {otpMessage ? <p className="auth-feedback auth-feedback--success">{otpMessage}</p> : null}

            <button className="auth-button" type="submit" disabled={isVerifyingOtp || otpCode.length < 4}>
              {isVerifyingOtp ? "Verificando..." : "CONFIRMAR CÓDIGO"}
            </button>

            <button
              className="auth-button auth-button--ghost"
              type="button"
              onClick={() => void handleResendOtp()}
              disabled={isVerifyingOtp || resendCooldown > 0}
            >
              {resendCooldown > 0 ? `Reenviar em ${resendCooldown}s` : "REENVIAR CÓDIGO"}
            </button>

            <p className="auth-legal auth-legal--center">
              Não recebeu? Verifique o spam ou aguarde alguns segundos antes de reenviar.
            </p>

            <div className="auth-footer auth-footer--otp">
              <span>Já tem uma conta?</span>
              <Link className="auth-link" to="/auth/login">
                Entrar
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}







