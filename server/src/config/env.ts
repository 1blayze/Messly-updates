import { z } from "zod";
import type { LoggerLevel } from "../logging/logger";

const NODE_ENV_VALUES = ["development", "test", "production"] as const;

const DEFAULT_MEDIA_CDN_URL = "https://cdn.messly.site";
const DEFAULT_GATEWAY_METRICS_PATH = "/metrics";
const DEFAULT_DISPATCH_CHANNEL = "messly:gateway:dispatch";
const DEFAULT_CONTROL_CHANNEL = "messly:gateway:control";
const DEFAULT_BRIDGE_LEASE_KEY = "messly:gateway:bridge:leader";
const DEFAULT_NODE_ENV = "development";
const DEFAULT_GATEWAY_PORT = "8788";
const DEFAULT_GATEWAY_REDIS_URL = "redis://127.0.0.1:6379";
const DEFAULT_ALLOWED_ORIGINS =
  "https://app.messly.com,http://localhost:5173,electron://app";
const DEFAULT_GATEWAY_HEARTBEAT_INTERVAL_MS = "15000";
const DEFAULT_GATEWAY_CLIENT_TIMEOUT_MS = "45000";
const DEFAULT_GATEWAY_RESUME_TTL_SECONDS = "180";
const DEFAULT_GATEWAY_SESSION_BUFFER_SIZE = "200";
const DEFAULT_GATEWAY_LOG_LEVEL = "info";
const DEFAULT_GATEWAY_METRICS_ENABLED = "true";
const DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS = "15000";
const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = "65536";
const DEFAULT_GATEWAY_RATE_LIMIT_ENABLED = "true";

function toNonEmptyString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = toNonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function withFallback(value: unknown, fallback: string): string {
  return firstNonEmpty(value) ?? fallback;
}

function parseBoolean(value: string): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function splitCsv(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function isLocalHostname(hostnameRaw: string | null | undefined): boolean {
  const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isWildcardListenIp(valueRaw: string | null | undefined): boolean {
  const value = String(valueRaw ?? "").trim().toLowerCase();
  return value === "0.0.0.0" || value === "::" || value === "::0";
}

function normalizeHttpUrl(value: string, field: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${field} must be a valid http(s) URL.`);
  }
}

function normalizeGatewayUrl(value: string, nodeEnv: GatewayEnv["nodeEnv"]): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error();
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/gateway";
    if (!parsed.pathname.startsWith("/")) {
      parsed.pathname = `/${parsed.pathname}`;
    }
    if (parsed.pathname !== "/gateway") {
      throw new Error();
    }

    if (nodeEnv === "production") {
      if (parsed.protocol !== "wss:" || isLocalHostname(parsed.hostname)) {
        throw new Error();
      }
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("MESSLY_GATEWAY_PUBLIC_URL must be a valid ws(s) URL ending with /gateway.");
  }
}

function toHttpBaseUrl(publicGatewayUrl: string): string {
  const parsed = new URL(publicGatewayUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENV_VALUES),
    PORT: z.string().trim().min(1),
    MESSLY_GATEWAY_PUBLIC_URL: z.string().trim().min(1),
    MESSLY_REDIS_URL: z.string().trim().min(1),
    MESSLY_ALLOWED_ORIGINS: z.string().trim().min(1),
    MESSLY_HEARTBEAT_INTERVAL_MS: z.string().trim().min(1),
    MESSLY_CLIENT_TIMEOUT_MS: z.string().trim().min(1),
    MESSLY_RESUME_TTL_SECONDS: z.string().trim().min(1),
    MESSLY_SESSION_BUFFER_SIZE: z.string().trim().min(1),
    MESSLY_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
    MESSLY_METRICS_ENABLED: z.string().trim().min(1),
    MESSLY_DRAIN_TIMEOUT_MS: z.string().trim().min(1),
    MESSLY_MAX_PAYLOAD_BYTES: z.string().trim().min(1),
    MESSLY_RATE_LIMIT_ENABLED: z.string().trim().min(1),
    MESSLY_ALLOW_ELECTRON_ORIGIN: z.string().trim().default("false"),
    MESSLY_TYPING_TTL_MS: z.string().trim().default("5000"),
    MESSLY_GATEWAY_METRICS_PATH: z.string().trim().default(DEFAULT_GATEWAY_METRICS_PATH),
    MESSLY_DISPATCH_CHANNEL: z.string().trim().default(DEFAULT_DISPATCH_CHANNEL),
    MESSLY_CONTROL_CHANNEL: z.string().trim().default(DEFAULT_CONTROL_CHANNEL),
    MESSLY_BRIDGE_LEASE_KEY: z.string().trim().default(DEFAULT_BRIDGE_LEASE_KEY),
    MESSLY_BRIDGE_LEASE_TTL_MS: z.string().trim().default("30000"),
    MESSLY_BRIDGE_RENEW_INTERVAL_MS: z.string().trim().default("10000"),
    MESSLY_SESSION_LEASE_DURATION_MS: z.string().trim().default("45000"),
    MESSLY_INSTANCE_HEARTBEAT_INTERVAL_MS: z.string().trim().default("5000"),
    MESSLY_INSTANCE_HEARTBEAT_TTL_MS: z.string().trim().default("20000"),
    MESSLY_GATEWAY_REGION: z.string().trim().default("global"),
    SUPABASE_URL: z.string().trim().min(1),
    SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
    TURNSTILE_SECRET_KEY: z.string().trim().optional().default(""),
    MESSLY_AUTH_OTP_TTL_SECONDS: z.string().trim().default("600"),
    MESSLY_AUTH_OTP_MAX_ATTEMPTS: z.string().trim().default("5"),
    REGISTRATION_IP_LIMIT_MAX: z.string().trim().default("3"),
    REGISTRATION_IP_LIMIT_WINDOW_HOURS: z.string().trim().default("24"),
    CAPTCHA_FAIL_LIMIT: z.string().trim().default("5"),
    CAPTCHA_FAIL_WINDOW_MINUTES: z.string().trim().default("10"),
    CAPTCHA_BLOCK_HOURS: z.string().trim().default("24"),
    FINGERPRINT_LIMIT_MAX: z.string().trim().default("2"),
    FINGERPRINT_LIMIT_WINDOW_HOURS: z.string().trim().default("24"),
    REGISTRATION_LEASE_TTL_MINUTES: z.string().trim().default("20"),
    ENABLE_DISPOSABLE_EMAIL_BLOCK: z.string().trim().default("true"),
    FINGERPRINT_DISTINCT_IP_THRESHOLD: z.string().trim().default("4"),
    IP_DISTINCT_FINGERPRINT_THRESHOLD: z.string().trim().default("6"),
    DOMAIN_BURST_THRESHOLD: z.string().trim().default("8"),
    MAX_CORRELATION_SAMPLE: z.string().trim().default("120"),
    CORRELATION_WINDOW_MINUTES: z.string().trim().default("60"),
    SUSPICIOUS_EVENT_WINDOW_HOURS: z.string().trim().default("24"),
    SUSPICIOUS_REINCIDENCE_THRESHOLD: z.string().trim().default("2"),
    R2_BUCKET: z.string().trim().min(1),
    R2_ENDPOINT: z.string().trim().min(1),
    R2_ACCESS_KEY_ID: z.string().trim().min(1),
    R2_SECRET_ACCESS_KEY: z.string().trim().min(1),
    R2_REGION: z.string().trim().default("auto"),
    R2_FORCE_PATH_STYLE: z.string().trim().default("true"),
    MESSLY_CDN_URL: z.string().trim().default(DEFAULT_MEDIA_CDN_URL),
  })
  .passthrough();

export interface GatewayEnv {
  nodeEnv: (typeof NODE_ENV_VALUES)[number];
  host: "0.0.0.0";
  port: number;
  publicUrl: string;
  publicHttpBaseUrl: string;
  redisUrl: string;
  allowedOrigins: string[];
  allowElectronOrigin: boolean;
  heartbeatIntervalMs: number;
  clientTimeoutMs: number;
  resumeTtlSeconds: number;
  sessionBufferSize: number;
  logLevel: LoggerLevel;
  metricsEnabled: boolean;
  drainTimeoutMs: number;
  maxPayloadBytes: number;
  rateLimitEnabled: boolean;
  typingTtlMs: number;
  gatewayMetricsPath: string;
  dispatchChannel: string;
  controlChannel: string;
  bridgeLeaseKey: string;
  bridgeLeaseTtlMs: number;
  bridgeRenewIntervalMs: number;
  sessionLeaseDurationMs: number;
  instanceHeartbeatIntervalMs: number;
  instanceHeartbeatTtlMs: number;
  region: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  turnstileSecretKey: string;
  authOtpTtlSeconds: number;
  authOtpMaxAttempts: number;
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
  r2Bucket: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Region: string;
  r2ForcePathStyle: boolean;
  mediaCdnBaseUrl: string;
}

function parseInteger(value: string, field: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}.`);
  }
  return parsed;
}

function toGatewayEnv(raw: z.infer<typeof envSchema>): GatewayEnv {
  const nodeEnv = raw.NODE_ENV;
  const publicUrl = normalizeGatewayUrl(raw.MESSLY_GATEWAY_PUBLIC_URL, nodeEnv);
  const heartbeatIntervalMs = parseInteger(raw.MESSLY_HEARTBEAT_INTERVAL_MS, "MESSLY_HEARTBEAT_INTERVAL_MS", 5_000);
  const clientTimeoutMs = parseInteger(raw.MESSLY_CLIENT_TIMEOUT_MS, "MESSLY_CLIENT_TIMEOUT_MS", heartbeatIntervalMs * 2);

  return {
    nodeEnv,
    host: "0.0.0.0",
    port: parseInteger(raw.PORT, "PORT", 1),
    publicUrl,
    publicHttpBaseUrl: toHttpBaseUrl(publicUrl),
    redisUrl: raw.MESSLY_REDIS_URL,
    allowedOrigins: splitCsv(raw.MESSLY_ALLOWED_ORIGINS),
    allowElectronOrigin: parseBoolean(raw.MESSLY_ALLOW_ELECTRON_ORIGIN),
    heartbeatIntervalMs,
    clientTimeoutMs,
    resumeTtlSeconds: parseInteger(raw.MESSLY_RESUME_TTL_SECONDS, "MESSLY_RESUME_TTL_SECONDS", 5),
    sessionBufferSize: parseInteger(raw.MESSLY_SESSION_BUFFER_SIZE, "MESSLY_SESSION_BUFFER_SIZE", 1),
    logLevel: raw.MESSLY_LOG_LEVEL,
    metricsEnabled: parseBoolean(raw.MESSLY_METRICS_ENABLED),
    drainTimeoutMs: parseInteger(raw.MESSLY_DRAIN_TIMEOUT_MS, "MESSLY_DRAIN_TIMEOUT_MS", 1_000),
    maxPayloadBytes: parseInteger(raw.MESSLY_MAX_PAYLOAD_BYTES, "MESSLY_MAX_PAYLOAD_BYTES", 1_024),
    rateLimitEnabled: parseBoolean(raw.MESSLY_RATE_LIMIT_ENABLED),
    typingTtlMs: parseInteger(raw.MESSLY_TYPING_TTL_MS, "MESSLY_TYPING_TTL_MS", 1_000),
    gatewayMetricsPath: raw.MESSLY_GATEWAY_METRICS_PATH.startsWith("/")
      ? raw.MESSLY_GATEWAY_METRICS_PATH
      : `/${raw.MESSLY_GATEWAY_METRICS_PATH}`,
    dispatchChannel: raw.MESSLY_DISPATCH_CHANNEL,
    controlChannel: raw.MESSLY_CONTROL_CHANNEL,
    bridgeLeaseKey: raw.MESSLY_BRIDGE_LEASE_KEY,
    bridgeLeaseTtlMs: parseInteger(raw.MESSLY_BRIDGE_LEASE_TTL_MS, "MESSLY_BRIDGE_LEASE_TTL_MS", 5_000),
    bridgeRenewIntervalMs: parseInteger(
      raw.MESSLY_BRIDGE_RENEW_INTERVAL_MS,
      "MESSLY_BRIDGE_RENEW_INTERVAL_MS",
      1_000,
    ),
    sessionLeaseDurationMs: parseInteger(
      raw.MESSLY_SESSION_LEASE_DURATION_MS,
      "MESSLY_SESSION_LEASE_DURATION_MS",
      5_000,
    ),
    instanceHeartbeatIntervalMs: parseInteger(
      raw.MESSLY_INSTANCE_HEARTBEAT_INTERVAL_MS,
      "MESSLY_INSTANCE_HEARTBEAT_INTERVAL_MS",
      1_000,
    ),
    instanceHeartbeatTtlMs: parseInteger(
      raw.MESSLY_INSTANCE_HEARTBEAT_TTL_MS,
      "MESSLY_INSTANCE_HEARTBEAT_TTL_MS",
      2_000,
    ),
    region: raw.MESSLY_GATEWAY_REGION,
    supabaseUrl: normalizeHttpUrl(raw.SUPABASE_URL, "SUPABASE_URL"),
    supabaseAnonKey: raw.SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
    turnstileSecretKey: raw.TURNSTILE_SECRET_KEY,
    authOtpTtlSeconds: parseInteger(raw.MESSLY_AUTH_OTP_TTL_SECONDS, "MESSLY_AUTH_OTP_TTL_SECONDS", 60),
    authOtpMaxAttempts: parseInteger(raw.MESSLY_AUTH_OTP_MAX_ATTEMPTS, "MESSLY_AUTH_OTP_MAX_ATTEMPTS", 1),
    registrationIpLimitMax: parseInteger(raw.REGISTRATION_IP_LIMIT_MAX, "REGISTRATION_IP_LIMIT_MAX", 1),
    registrationIpLimitWindowHours: parseInteger(
      raw.REGISTRATION_IP_LIMIT_WINDOW_HOURS,
      "REGISTRATION_IP_LIMIT_WINDOW_HOURS",
      1,
    ),
    captchaFailLimit: parseInteger(raw.CAPTCHA_FAIL_LIMIT, "CAPTCHA_FAIL_LIMIT", 1),
    captchaFailWindowMinutes: parseInteger(raw.CAPTCHA_FAIL_WINDOW_MINUTES, "CAPTCHA_FAIL_WINDOW_MINUTES", 1),
    captchaBlockHours: parseInteger(raw.CAPTCHA_BLOCK_HOURS, "CAPTCHA_BLOCK_HOURS", 1),
    fingerprintLimitMax: parseInteger(raw.FINGERPRINT_LIMIT_MAX, "FINGERPRINT_LIMIT_MAX", 1),
    fingerprintLimitWindowHours: parseInteger(
      raw.FINGERPRINT_LIMIT_WINDOW_HOURS,
      "FINGERPRINT_LIMIT_WINDOW_HOURS",
      1,
    ),
    registrationLeaseTtlMinutes: parseInteger(
      raw.REGISTRATION_LEASE_TTL_MINUTES,
      "REGISTRATION_LEASE_TTL_MINUTES",
      1,
    ),
    enableDisposableEmailBlock: parseBoolean(raw.ENABLE_DISPOSABLE_EMAIL_BLOCK),
    fingerprintDistinctIpThreshold: parseInteger(
      raw.FINGERPRINT_DISTINCT_IP_THRESHOLD,
      "FINGERPRINT_DISTINCT_IP_THRESHOLD",
      1,
    ),
    ipDistinctFingerprintThreshold: parseInteger(
      raw.IP_DISTINCT_FINGERPRINT_THRESHOLD,
      "IP_DISTINCT_FINGERPRINT_THRESHOLD",
      1,
    ),
    domainBurstThreshold: parseInteger(raw.DOMAIN_BURST_THRESHOLD, "DOMAIN_BURST_THRESHOLD", 1),
    maxCorrelationSample: parseInteger(raw.MAX_CORRELATION_SAMPLE, "MAX_CORRELATION_SAMPLE", 1),
    correlationWindowMinutes: parseInteger(raw.CORRELATION_WINDOW_MINUTES, "CORRELATION_WINDOW_MINUTES", 1),
    suspiciousEventWindowHours: parseInteger(
      raw.SUSPICIOUS_EVENT_WINDOW_HOURS,
      "SUSPICIOUS_EVENT_WINDOW_HOURS",
      1,
    ),
    suspiciousReincidenceThreshold: parseInteger(
      raw.SUSPICIOUS_REINCIDENCE_THRESHOLD,
      "SUSPICIOUS_REINCIDENCE_THRESHOLD",
      1,
    ),
    r2Bucket: raw.R2_BUCKET,
    r2Endpoint: normalizeHttpUrl(raw.R2_ENDPOINT, "R2_ENDPOINT"),
    r2AccessKeyId: raw.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: raw.R2_SECRET_ACCESS_KEY,
    r2Region: raw.R2_REGION,
    r2ForcePathStyle: parseBoolean(raw.R2_FORCE_PATH_STYLE),
    mediaCdnBaseUrl: normalizeHttpUrl(raw.MESSLY_CDN_URL, "MESSLY_CDN_URL"),
  };
}

export function readGatewayEnv(envSource: NodeJS.ProcessEnv = process.env): GatewayEnv {
  const resolvedPort = withFallback(envSource.PORT, DEFAULT_GATEWAY_PORT);
  const resolvedPublicGatewayUrl = withFallback(
    firstNonEmpty(envSource.MESSLY_GATEWAY_PUBLIC_URL, envSource.VITE_MESSLY_GATEWAY_URL),
    `ws://127.0.0.1:${resolvedPort}/gateway`,
  );
  const normalizedSource: NodeJS.ProcessEnv = {
    ...envSource,
    NODE_ENV: withFallback(envSource.NODE_ENV, DEFAULT_NODE_ENV),
    PORT: resolvedPort,
    MESSLY_GATEWAY_PUBLIC_URL: resolvedPublicGatewayUrl,
    MESSLY_REDIS_URL: withFallback(envSource.MESSLY_REDIS_URL, DEFAULT_GATEWAY_REDIS_URL),
    MESSLY_ALLOWED_ORIGINS: withFallback(envSource.MESSLY_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    MESSLY_HEARTBEAT_INTERVAL_MS: withFallback(
      envSource.MESSLY_HEARTBEAT_INTERVAL_MS,
      DEFAULT_GATEWAY_HEARTBEAT_INTERVAL_MS,
    ),
    MESSLY_CLIENT_TIMEOUT_MS: withFallback(envSource.MESSLY_CLIENT_TIMEOUT_MS, DEFAULT_GATEWAY_CLIENT_TIMEOUT_MS),
    MESSLY_RESUME_TTL_SECONDS: withFallback(
      envSource.MESSLY_RESUME_TTL_SECONDS,
      DEFAULT_GATEWAY_RESUME_TTL_SECONDS,
    ),
    MESSLY_SESSION_BUFFER_SIZE: withFallback(
      envSource.MESSLY_SESSION_BUFFER_SIZE,
      DEFAULT_GATEWAY_SESSION_BUFFER_SIZE,
    ),
    MESSLY_LOG_LEVEL: withFallback(envSource.MESSLY_LOG_LEVEL, DEFAULT_GATEWAY_LOG_LEVEL),
    MESSLY_METRICS_ENABLED: withFallback(envSource.MESSLY_METRICS_ENABLED, DEFAULT_GATEWAY_METRICS_ENABLED),
    MESSLY_DRAIN_TIMEOUT_MS: withFallback(envSource.MESSLY_DRAIN_TIMEOUT_MS, DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS),
    MESSLY_MAX_PAYLOAD_BYTES: withFallback(
      envSource.MESSLY_MAX_PAYLOAD_BYTES,
      DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES,
    ),
    MESSLY_RATE_LIMIT_ENABLED: withFallback(
      envSource.MESSLY_RATE_LIMIT_ENABLED,
      DEFAULT_GATEWAY_RATE_LIMIT_ENABLED,
    ),
    SUPABASE_URL: withFallback(
      firstNonEmpty(envSource.SUPABASE_URL, envSource.VITE_SUPABASE_URL),
      "",
    ),
    SUPABASE_PUBLISHABLE_KEY: withFallback(
      firstNonEmpty(
        envSource.SUPABASE_PUBLISHABLE_KEY,
        envSource.VITE_SUPABASE_PUBLISHABLE_KEY,
        envSource.VITE_SUPABASE_ANON_KEY,
      ),
      "",
    ),
  };

  const parsed = envSchema.safeParse(normalizedSource);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid gateway environment: ${formatted}`);
  }
  return toGatewayEnv(parsed.data);
}
