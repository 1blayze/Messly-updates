export interface ReconnectStrategyOptions {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

export function computeReconnectDelayMs(options: ReconnectStrategyOptions): number {
  const attempt = Math.max(0, Math.floor(options.attempt));
  const baseDelayMs = Math.max(250, Math.floor(options.baseDelayMs ?? 1_000));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? 30_000));
  const jitterRatio = Math.min(0.5, Math.max(0, options.jitterRatio ?? 0.2));

  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitterWindowMs = Math.round(exponentialDelay * jitterRatio);
  const jitterMs = jitterWindowMs > 0 ? Math.floor(Math.random() * (jitterWindowMs + 1)) : 0;
  return Math.min(maxDelayMs, exponentialDelay + jitterMs);
}
