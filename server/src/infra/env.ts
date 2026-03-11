export interface GatewayEnv {
  port: number;
  shardCount: number;
  localShardIndex: number | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  redisUrl: string;
  eventBusChannel: string;
  presenceTtlSeconds: number;
  typingTtlMs: number;
  gatewayMetricsPath: string;
  redisPubSubRetryAttempts: number;
  authOtpTtlSeconds: number;
  authOtpMaxAttempts: number;
  turnstileSecretKey: string;
  registrationIpLimitMax: number;
  registrationIpLimitWindowHours: number;
  captchaFailLimit: number;
  captchaFailWindowMinutes: number;
  captchaBlockHours: number;
  fingerprintLimitMax: number;
  fingerprintLimitWindowHours: number;
  registrationLeaseTtlMinutes: number;
  enableDisposableEmailBlock: boolean;
  fingerprintDistinctIpThreshold: number;
  ipDistinctFingerprintThreshold: number;
  domainBurstThreshold: number;
  maxCorrelationSample: number;
  correlationWindowMinutes: number;
  suspiciousEventWindowHours: number;
  suspiciousReincidenceThreshold: number;
  allowedOrigins: string[];
  allowElectronOrigin: boolean;
  r2Bucket: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Region: string;
  r2ForcePathStyle: boolean;
  mediaCdnBaseUrl: string;
}

function parseOrigins(...values: Array<string | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => unique.add(entry));
  }

  return [...unique];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function readGatewayEnv(): GatewayEnv {
  const shardIndex = Number.parseInt(process.env.MESSLY_GATEWAY_SHARD_INDEX ?? "", 10);
  const eventBusChannel = String(process.env.MESSLY_GATEWAY_EVENT_CHANNEL ?? "messly:eventbus").trim();
  const supabaseUrl = String(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").trim();
  const supabaseAnonKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_ANON_KEY ??
      process.env.VITE_SUPABASE_ANON_KEY ??
      "",
  ).trim();
  const supabaseServiceRoleKey = String(
    process.env.MESSLY_SERVICE_ROLE_JWT ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_SECRET_KEY ??
      "",
  ).trim();
  const mediaCdnBaseUrl = String(
    process.env.MESSLY_CDN_URL ??
      process.env.VITE_MESSLY_CDN_URL ??
      process.env.VITE_MEDIA_PUBLIC_BASE_URL ??
      process.env.VITE_R2_PUBLIC_BASE_URL ??
      "https://cdn.messly.site",
  )
    .trim()
    .replace(/\/+$/, "");

  return {
    port: Number.parseInt(process.env.MESSLY_GATEWAY_PORT ?? "8788", 10),
    shardCount: Number.parseInt(process.env.MESSLY_GATEWAY_SHARD_COUNT ?? "3", 10),
    localShardIndex: Number.isFinite(shardIndex) ? Math.max(0, shardIndex) : null,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    redisUrl: String(process.env.REDIS_URL ?? process.env.MESSLY_REDIS_URL ?? "").trim(),
    eventBusChannel,
    presenceTtlSeconds: Math.max(60, Number.parseInt(process.env.MESSLY_PRESENCE_TTL_SECONDS ?? "120", 10)),
    typingTtlMs: Math.max(3_000, Number.parseInt(process.env.MESSLY_TYPING_TTL_MS ?? "5000", 10)),
    gatewayMetricsPath: String(process.env.MESSLY_GATEWAY_METRICS_PATH ?? "/metrics"),
    redisPubSubRetryAttempts: Number.parseInt(process.env.MESSLY_REDIS_RETRY_ATTEMPTS ?? "3", 10),
    authOtpTtlSeconds: Math.max(60, Number.parseInt(process.env.MESSLY_AUTH_OTP_TTL_SECONDS ?? "600", 10)),
    authOtpMaxAttempts: Math.min(
      10,
      Math.max(1, Number.parseInt(process.env.MESSLY_AUTH_OTP_MAX_ATTEMPTS ?? "5", 10)),
    ),
    turnstileSecretKey: String(process.env.TURNSTILE_SECRET_KEY ?? "").trim(),
    registrationIpLimitMax: Math.max(1, Number.parseInt(process.env.REGISTRATION_IP_LIMIT_MAX ?? "3", 10)),
    registrationIpLimitWindowHours: Math.max(
      1,
      Number.parseInt(process.env.REGISTRATION_IP_LIMIT_WINDOW_HOURS ?? "24", 10),
    ),
    captchaFailLimit: Math.max(1, Number.parseInt(process.env.CAPTCHA_FAIL_LIMIT ?? "5", 10)),
    captchaFailWindowMinutes: Math.max(1, Number.parseInt(process.env.CAPTCHA_FAIL_WINDOW_MINUTES ?? "10", 10)),
    captchaBlockHours: Math.max(1, Number.parseInt(process.env.CAPTCHA_BLOCK_HOURS ?? "24", 10)),
    fingerprintLimitMax: Math.max(1, Number.parseInt(process.env.FINGERPRINT_LIMIT_MAX ?? "2", 10)),
    fingerprintLimitWindowHours: Math.max(
      1,
      Number.parseInt(process.env.FINGERPRINT_LIMIT_WINDOW_HOURS ?? "24", 10),
    ),
    registrationLeaseTtlMinutes: Math.max(1, Number.parseInt(process.env.REGISTRATION_LEASE_TTL_MINUTES ?? "20", 10)),
    enableDisposableEmailBlock: parseBoolean(process.env.ENABLE_DISPOSABLE_EMAIL_BLOCK, true),
    fingerprintDistinctIpThreshold: Math.max(
      2,
      Number.parseInt(process.env.FINGERPRINT_DISTINCT_IP_THRESHOLD ?? "4", 10),
    ),
    ipDistinctFingerprintThreshold: Math.max(
      2,
      Number.parseInt(process.env.IP_DISTINCT_FINGERPRINT_THRESHOLD ?? "6", 10),
    ),
    domainBurstThreshold: Math.max(2, Number.parseInt(process.env.DOMAIN_BURST_THRESHOLD ?? "8", 10)),
    maxCorrelationSample: Math.max(20, Number.parseInt(process.env.MAX_CORRELATION_SAMPLE ?? "120", 10)),
    correlationWindowMinutes: Math.max(5, Number.parseInt(process.env.CORRELATION_WINDOW_MINUTES ?? "60", 10)),
    suspiciousEventWindowHours: Math.max(1, Number.parseInt(process.env.SUSPICIOUS_EVENT_WINDOW_HOURS ?? "24", 10)),
    suspiciousReincidenceThreshold: Math.max(
      1,
      Number.parseInt(process.env.SUSPICIOUS_REINCIDENCE_THRESHOLD ?? "2", 10),
    ),
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS, process.env.CORS_ALLOWED_ORIGINS),
    allowElectronOrigin: String(process.env.ALLOW_ELECTRON_ORIGIN ?? "").trim().toLowerCase() === "true",
    r2Bucket: String(process.env.R2_BUCKET ?? "").trim(),
    r2Endpoint: String(process.env.R2_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
    r2AccessKeyId: String(process.env.R2_ACCESS_KEY_ID ?? "").trim(),
    r2SecretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
    r2Region: String(process.env.R2_REGION ?? "auto").trim() || "auto",
    r2ForcePathStyle: parseBoolean(process.env.R2_FORCE_PATH_STYLE, true),
    mediaCdnBaseUrl,
  };
}
