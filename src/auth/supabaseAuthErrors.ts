export function toFriendlySupabaseAuthError(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  const normalized = message.toLowerCase();
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim();
  const rawDetails = (error as { details?: unknown } | null)?.details;
  const details =
    typeof rawDetails === "string"
      ? rawDetails.toLowerCase()
      : rawDetails && typeof rawDetails === "object"
        ? JSON.stringify(rawDetails).toLowerCase()
        : "";
  const normalizedCode = code.toUpperCase();

  if (normalized.includes("blocked_by_client") || normalized.includes("err_blocked_by_client")) {
    return "A requisição foi bloqueada por um ad-blocker ou extensão. Desative para prosseguir.";
  }

  if (normalizedCode === "EMAIL_ALREADY_REGISTERED") {
    return "Este e-mail já está cadastrado.";
  }

  if (normalizedCode === "EMAIL_VERIFICATION_REQUIRED") {
    return "Confirme seu e-mail para continuar.";
  }

  if (normalizedCode === "INVALID_VERIFICATION_CODE") {
    return "Código inválido. Tente novamente.";
  }

  if (normalizedCode === "OTP_MAX_ATTEMPTS") {
    return "Limite de tentativas atingido. Solicite um novo código.";
  }

  if (normalizedCode === "VERIFICATION_NOT_FOUND") {
    return "Nenhum código de verificação ativo foi encontrado para este e-mail.";
  }

  if (normalizedCode === "AUTH_RATE_LIMITED") {
    return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  }

  if (normalizedCode === "REGISTRATION_TEMPORARILY_BLOCKED" || normalizedCode === "REGISTRATION_BLOCKED") {
    return "Cadastro temporariamente bloqueado. Tente novamente mais tarde.";
  }

  if (normalizedCode === "REGISTRATION_TOO_MANY_ATTEMPTS") {
    return "Muitas tentativas de cadastro. Tente novamente mais tarde.";
  }

  if (
    normalizedCode === "CAPTCHA_REQUIRED" ||
    normalizedCode === "CAPTCHA_INVALID" ||
    normalizedCode === "CAPTCHA_EXPIRED" ||
    normalizedCode === "CAPTCHA_TIMEOUT" ||
    normalizedCode === "CAPTCHA_NETWORK_ERROR" ||
    normalizedCode === "CAPTCHA_VALIDATION_FAILED"
  ) {
    return "Falha na verificação de segurança. Tente novamente.";
  }

  if (
    normalized.includes("invalid login credentials") ||
    normalized.includes("invalid credentials") ||
    normalizedCode === "INVALID_CREDENTIALS"
  ) {
    return "Email ou senha incorretos.";
  }

  if ((status === 401 || status === 403) && !normalized.includes("verification") && !normalized.includes("otp")) {
    return "Email ou senha incorretos.";
  }

  if (normalized.includes("user already registered")) {
    return "Este e-mail já está cadastrado.";
  }

  if (normalized.includes("email not confirmed")) {
    return "Confirme seu e-mail para concluir o login.";
  }

  if (normalized.includes("verification") && normalized.includes("email")) {
    return "Verifique seu e-mail para continuar.";
  }

  if (normalized.includes("otp") || normalized.includes("token")) {
    if (normalized.includes("expire")) {
      return "O código expirou. Reenvie um novo código.";
    }
    if (normalized.includes("invalid") || normalized.includes("mismatch")) {
      return "Código inválido. Tente novamente.";
    }
    return "Não foi possível validar o código. Reenvie e tente de novo.";
  }

  if (code === "USERNAME_TAKEN" || normalized.includes("nome de usuário já está em uso")) {
    return "Este nome de usuário já está em uso.";
  }

  if (code === "23505" && (normalized.includes("username") || details.includes("username"))) {
    return "Este nome de usuário já está em uso.";
  }

  if (normalized.includes("password should be at least") || normalized.includes("password must be at least")) {
    return "A senha deve ter pelo menos 8 caracteres.";
  }

  if (normalized.includes("rate limit") || normalized.includes("too many")) {
    return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  }

  if (normalized.includes("request this after") || normalized.includes("for security purposes")) {
    return "Aguarde alguns segundos antes de reenviar o código.";
  }

  if (
    normalizedCode === "AUTH_NETWORK_ERROR" ||
    normalized.includes("failed to fetch") ||
    normalized.includes("network") ||
    normalized.includes("connection refused")
  ) {
    if (
      details.includes("localhost:8788") ||
      details.includes("127.0.0.1:8788") ||
      normalized.includes("localhost:8788") ||
      normalized.includes("127.0.0.1:8788")
    ) {
      return "Falha ao conectar com o gateway local de autenticação. Reinicie o ambiente com npm run dev:electron.";
    }
    return "Falha de rede ao autenticar. Verifique sua conexão.";
  }

  if (message) {
    return message;
  }

  return "Não foi possível concluir a autenticação. Tente novamente.";
}
