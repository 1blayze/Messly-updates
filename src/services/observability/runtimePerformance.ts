interface RuntimePerfMark {
  name: string;
  atMs: number;
  details?: Record<string, unknown>;
}

const runtimePerfMarks = new Map<string, RuntimePerfMark>();

function isPerfDebugEnabled(): boolean {
  return import.meta.env.DEV;
}

function safeNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

async function emitPerfDiagnostic(event: string, details: Record<string, unknown>): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const logDiagnostic = window.electronAPI?.logDiagnostic;
  if (typeof logDiagnostic !== "function") {
    return;
  }

  await logDiagnostic({
    source: "renderer-perf",
    event,
    level: "debug",
    details,
  }).catch(() => undefined);
}

export function markRuntimePerf(name: string, details: Record<string, unknown> = {}): void {
  if (!isPerfDebugEnabled()) {
    return;
  }

  const normalizedName = String(name ?? "").trim();
  if (!normalizedName) {
    return;
  }

  const atMs = safeNowMs();
  runtimePerfMarks.set(normalizedName, {
    name: normalizedName,
    atMs,
    details,
  });

  void emitPerfDiagnostic(`mark:${normalizedName}`, {
    atMs: Number(atMs.toFixed(2)),
    ...details,
  });
}

export function measureRuntimePerf(
  label: string,
  startMark: string,
  endMark: string,
  details: Record<string, unknown> = {},
): number | null {
  if (!isPerfDebugEnabled()) {
    return null;
  }

  const normalizedLabel = String(label ?? "").trim();
  const normalizedStart = String(startMark ?? "").trim();
  const normalizedEnd = String(endMark ?? "").trim();
  if (!normalizedLabel || !normalizedStart || !normalizedEnd) {
    return null;
  }

  const start = runtimePerfMarks.get(normalizedStart);
  const end = runtimePerfMarks.get(normalizedEnd);
  if (!start || !end) {
    return null;
  }

  const durationMs = Math.max(0, end.atMs - start.atMs);
  void emitPerfDiagnostic(`measure:${normalizedLabel}`, {
    start: normalizedStart,
    end: normalizedEnd,
    durationMs: Number(durationMs.toFixed(2)),
    ...details,
  });
  return durationMs;
}

export function getRuntimePerfMarksSnapshot(): Array<RuntimePerfMark> {
  return Array.from(runtimePerfMarks.values()).map((entry) => ({
    ...entry,
    details: entry.details ? { ...entry.details } : undefined,
  }));
}

