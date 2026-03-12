interface HistogramSnapshot {
  count: number;
  min: number;
  max: number;
  avg: number;
  p95: number;
}

function summarize(samples: number[]): HistogramSnapshot {
  if (samples.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p95: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: Math.round(total / samples.length),
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
  };
}

export interface GatewayMetricsSnapshot {
  instanceId: string;
  uptimeSeconds: number;
  ready: boolean;
  draining: boolean;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  memory: NodeJS.MemoryUsage;
}

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly startedAt = Date.now();
  private ready = false;
  private draining = false;

  constructor(
    private readonly instanceId: string,
    private readonly enabled = true,
  ) {}

  increment(name: string, value = 1): void {
    if (!this.enabled) {
      return;
    }
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  setGauge(name: string, value: number): void {
    if (!this.enabled) {
      return;
    }
    this.gauges.set(name, value);
  }

  observe(name: string, value: number, maxSamples = 512): void {
    if (!this.enabled) {
      return;
    }
    const samples = this.histograms.get(name) ?? [];
    samples.push(Math.max(0, Math.round(value)));
    if (samples.length > maxSamples) {
      samples.splice(0, samples.length - maxSamples);
    }
    this.histograms.set(name, samples);
  }

  setReady(ready: boolean): void {
    this.ready = ready;
  }

  setDraining(draining: boolean): void {
    this.draining = draining;
  }

  trackConnectionOpen(activeConnections: number): void {
    this.increment("connections_opened_total");
    this.setGauge("active_connections", activeConnections);
    this.setGauge("connections_per_instance", activeConnections);
  }

  trackConnectionClose(activeConnections: number): void {
    this.increment("connections_closed_total");
    this.setGauge("active_connections", activeConnections);
    this.setGauge("connections_per_instance", activeConnections);
  }

  trackIdentifySuccess(): void {
    this.increment("identifies_total");
  }

  trackIdentifyFailure(): void {
    this.increment("identify_failures_total");
  }

  trackResumeSuccess(): void {
    this.increment("resumes_success_total");
  }

  trackResumeFailure(): void {
    this.increment("resumes_failure_total");
  }

  trackReconnectSignal(): void {
    this.increment("reconnects_total");
  }

  trackHeartbeatTimeout(): void {
    this.increment("heartbeat_timeouts_total");
  }

  trackInvalidPayload(): void {
    this.increment("invalid_payloads_total");
  }

  trackDispatch(): void {
    this.increment("dispatch_total");
  }

  trackFanoutDelivery(deliveredToConnections: number): void {
    this.increment("fanout_total");
    this.increment("fanout_deliveries_total", deliveredToConnections);
  }

  trackRedisError(): void {
    this.increment("redis_errors_total");
  }

  trackPublishFailure(): void {
    this.increment("publish_failures_total");
  }

  trackBackpressure(): void {
    this.increment("backpressure_total");
  }

  setInternalQueueDepth(depth: number): void {
    this.setGauge("internal_queue_depth", depth);
  }

  setReadyState(ready: boolean, draining: boolean): void {
    this.setReady(ready);
    this.setDraining(draining);
  }

  getSnapshot(): GatewayMetricsSnapshot {
    return {
      instanceId: this.instanceId,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1_000),
      ready: this.ready,
      draining: this.draining,
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([name, samples]) => [name, summarize(samples)]),
      ),
      memory: process.memoryUsage(),
    };
  }
}
