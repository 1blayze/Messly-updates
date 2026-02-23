interface SentryLike {
  captureException?: (error: unknown, context?: Record<string, unknown>) => void;
  captureMessage?: (message: string, context?: Record<string, unknown>) => void;
}

interface WindowWithSentry {
  Sentry?: SentryLike;
}

const metrics = new Map<string, number>();

export function incrementMetric(metricName: string, value = 1): void {
  const current = metrics.get(metricName) ?? 0;
  metrics.set(metricName, current + value);
}

export function getMetricSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  metrics.forEach((value, key) => {
    snapshot[key] = value;
  });
  return snapshot;
}

export function reportClientError(error: unknown, context?: Record<string, unknown>): void {
  incrementMetric("client_errors_total", 1);

  const sentry = (window as unknown as WindowWithSentry).Sentry;
  if (sentry?.captureException) {
    sentry.captureException(error, context);
    return;
  }

  const message = error instanceof Error ? error.message : String(error ?? "Unknown client error");
  console.error("[messly-client-error]", {
    message,
    context: context ?? null,
    error,
  });
}

export function recordLatency(metricName: string, startedAtMs: number): void {
  const latency = Math.max(0, Date.now() - startedAtMs);
  const key = `${metricName}_total_ms`;
  const countKey = `${metricName}_count`;
  incrementMetric(key, latency);
  incrementMetric(countKey, 1);
}
