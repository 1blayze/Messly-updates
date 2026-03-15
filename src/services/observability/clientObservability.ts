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

  const typedError = error as Record<string, unknown> | null;
  const details = typedError && typeof typedError === "object" ? typedError : null;
  const message = (() => {
    if (error instanceof Error) {
      return error.message || error.name || "Unknown client error";
    }

    const recordMessage = typeof details?.message === "string" ? details.message : null;
    if (recordMessage && recordMessage.trim()) {
      return recordMessage;
    }

    const recordName = typeof details?.name === "string" ? details.name : null;
    if (recordName && recordName.trim()) {
      return recordName;
    }

    return String(error ?? "Unknown client error");
  })();
  const code = typedError && typeof details?.code !== "undefined" ? details.code : undefined;
  const status = details && typeof details.status !== "undefined" ? details.status : undefined;
  const payload =
    details && typeof details.details !== "undefined"
      ? details.details
      : (details && typeof details.hint !== "undefined" ? details.hint : null);

  console.error("[messly-client-error]", {
    message,
    context: context ?? null,
    code: code ?? null,
    status: status ?? null,
    details: payload,
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
