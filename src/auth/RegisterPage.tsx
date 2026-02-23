import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { firebaseAuth } from "../services/firebase";
import {
  isEmailAvailable,
  isUsernameAvailable,
  normalizeEmail,
  sanitizeDisplayName,
  validateUsernameInput,
} from "../services/usernameAvailability";
import { savePendingProfile } from "../services/userSync";
import { presenceController } from "../services/presence/presenceController";
import "./auth.css";

type UsernameCheckStatus = "idle" | "invalid" | "checking" | "available" | "unavailable" | "error";

interface FieldErrors {
  displayName?: string;
  username?: string;
  email?: string;
  password?: string;
  birthDate?: string;
}

function parseBirthDateParts(dayValue: string, monthValue: string, yearValue: string): Date | null {
  if (!dayValue || !monthValue || !yearValue) {
    return null;
  }

  if (yearValue.length !== 4) {
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

function sanitizeDigits(value: string, maxLength: number): string {
  return value.replace(/\D/g, "").slice(0, maxLength);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password: string): boolean {
  return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password);
}

function mapRegisterError(code: string): string {
  switch (code) {
    case "auth/email-already-in-use":
      return "Esse e-mail ja esta em uso.";
    case "auth/invalid-email":
      return "Informe um e-mail valido.";
    case "auth/weak-password":
      return "Sua senha esta muito fraca.";
    case "auth/too-many-requests":
      return "Muitas tentativas. Aguarde alguns minutos.";
    default:
      return "Nao foi possivel criar sua conta agora.";
  }
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<UsernameCheckStatus>("idle");
  const [usernameStatusText, setUsernameStatusText] = useState("");

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
      setUsernameStatusText(validation.message ?? "Username invalido.");
      return;
    }

    setUsernameStatus("checking");
    setUsernameStatusText("Verificando disponibilidade...");

    let isCancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const available = await isUsernameAvailable(trimmedUsername);
        if (isCancelled) {
          return;
        }

        if (available) {
          setUsernameStatus("available");
          setUsernameStatusText("Username disponivel.");
        } else {
          setUsernameStatus("unavailable");
          setUsernameStatusText("Username indisponivel.");
        }
      } catch {
        if (isCancelled) {
          return;
        }
        setUsernameStatus("error");
        setUsernameStatusText("Validacao de disponibilidade indisponivel no momento.");
      }
    }, 400);

    return () => {
      isCancelled = true;
      window.clearTimeout(timer);
    };
  }, [username]);

  async function validateBeforeSubmit(): Promise<boolean> {
    const nextErrors: FieldErrors = {};
    const cleanDisplayName = sanitizeDisplayName(displayName);
    const cleanUsername = username.trim();
    const normalizedEmail = normalizeEmail(email);
    const parsedBirthDate = parseBirthDateParts(birthDay, birthMonth, birthYear);

    if (cleanDisplayName.length < 2 || cleanDisplayName.length > 32) {
      nextErrors.displayName = "Use de 2 a 32 caracteres.";
    }

    const usernameValidation = validateUsernameInput(cleanUsername);
    if (!usernameValidation.isValid) {
      nextErrors.username = usernameValidation.message ?? "Username invalido.";
    }

    if (!isValidEmail(normalizedEmail)) {
      nextErrors.email = "Informe um e-mail valido.";
    }

    if (!isValidPassword(password)) {
      nextErrors.password = "A senha precisa ter no minimo 8 caracteres, com letra e numero.";
    }

    if (!parsedBirthDate) {
      nextErrors.birthDate = "Informe uma data de nascimento valida.";
    } else if (calculateAge(parsedBirthDate) < 13) {
      nextErrors.birthDate = "E necessario ter pelo menos 13 anos para criar conta.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return false;
    }

    try {
      const [usernameAvailable, emailAvailable] = await Promise.all([
        isUsernameAvailable(cleanUsername),
        isEmailAvailable(normalizedEmail),
      ]);

      if (!usernameAvailable) {
        nextErrors.username = "Esse username ja esta em uso.";
      }

      if (!emailAvailable) {
        nextErrors.email = "Esse e-mail ja esta em uso.";
      }
    } catch {
      setFormMessage("Nao foi possivel validar username e e-mail agora. Tente novamente em instantes.");
      return false;
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return false;
    }

    return true;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormMessage(null);
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const isValid = await validateBeforeSubmit();
      if (!isValid) {
        return;
      }

      const cleanDisplayName = sanitizeDisplayName(displayName);
      const cleanUsername = username.trim();
      const normalizedEmail = normalizeEmail(email);

      const credentials = await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password);
      const createdUser = credentials.user;

      await sendEmailVerification(createdUser);
      savePendingProfile({
        firebaseUid: createdUser.uid,
        username: cleanUsername,
        displayName: cleanDisplayName,
        createdAt: Date.now(),
      });
      presenceController.start(createdUser.uid);

      navigate("/auth/verify", { replace: true });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: string }).code ?? "")
          : "";
      setFormMessage(mapRegisterError(code));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Criar conta no Messly</h1>
        <p className="auth-subtitle">Preencha os dados para ativar sua conta.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="register-display-name">
              Display name
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
            <label className="auth-label" htmlFor="register-username">
              Username
            </label>
            <input
              id="register-username"
              className="auth-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              maxLength={20}
              disabled={isSubmitting}
              required
            />
            {usernameStatus !== "idle" ? (
              <p
                className={`auth-availability ${
                  usernameStatus === "available"
                    ? "auth-availability--available"
                    : usernameStatus === "checking"
                      ? "auth-availability--checking"
                      : "auth-availability--unavailable"
                }`}
              >
                {usernameStatusText}
              </p>
            ) : null}
            {fieldErrors.username ? <p className="auth-feedback auth-feedback--error">{fieldErrors.username}</p> : null}
          </div>

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
            <label className="auth-label" htmlFor="register-password">
              Senha
            </label>
            <input
              id="register-password"
              className="auth-input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
              required
            />
            <p className="auth-note">Minimo de 8 caracteres, com pelo menos 1 letra e 1 numero.</p>
            {fieldErrors.password ? (
              <p className="auth-feedback auth-feedback--error">{fieldErrors.password}</p>
            ) : null}
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="register-birth-day">
              Data de nascimento
            </label>
            <div className="auth-birth-grid">
              <input
                id="register-birth-day"
                className="auth-input auth-input--birth"
                type="text"
                inputMode="numeric"
                autoComplete="bday-day"
                placeholder="DD"
                value={birthDay}
                onChange={(event) => setBirthDay(sanitizeDigits(event.target.value, 2))}
                disabled={isSubmitting}
                required
                aria-label="Dia de nascimento"
              />
              <input
                className="auth-input auth-input--birth"
                type="text"
                inputMode="numeric"
                autoComplete="bday-month"
                placeholder="MM"
                value={birthMonth}
                onChange={(event) => setBirthMonth(sanitizeDigits(event.target.value, 2))}
                disabled={isSubmitting}
                required
                aria-label="Mes de nascimento"
              />
              <input
                className="auth-input auth-input--birth"
                type="text"
                inputMode="numeric"
                autoComplete="bday-year"
                placeholder="AAAA"
                value={birthYear}
                onChange={(event) => setBirthYear(sanitizeDigits(event.target.value, 4))}
                disabled={isSubmitting}
                required
                aria-label="Ano de nascimento"
              />
            </div>
            <p className="auth-note">E necessario ter pelo menos 13 anos para criar uma conta.</p>
            {fieldErrors.birthDate ? (
              <p className="auth-feedback auth-feedback--error">{fieldErrors.birthDate}</p>
            ) : null}
          </div>

          {formMessage ? <p className="auth-feedback auth-feedback--error">{formMessage}</p> : null}

          <button className="auth-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Criando conta..." : "Criar conta"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Ja possui conta?</span>
          <Link className="auth-link" to="/auth/login">
            Voltar para login
          </Link>
        </div>
      </div>
    </div>
  );
}
