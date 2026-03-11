export interface GatewayMetricsSnapshot {
  activeConnections: number;
  reconnectAttempts: number;
  eventsTotal: number;
  eventsPerSecond: number;
  avgHeartbeatLatencyMs: number;
  processId: string;
  droppedEvents: number;
  activeDispatchQueue: number;
  maxDispatchQueueDepth: number;
  fanoutLatencyMsP95: number;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

interface TimedCounter {
  atMs: number;
}

export class GatewayMetrics {
  private activeConnections = 0;
  private reconnectAttempts = 0;
  private eventsTotal = 0;
  private droppedEvents = 0;
  private activeDispatchQueue = 0;
  private maxDispatchQueueDepth = 0;
  private fanoutLatencySamples: number[] = [];
  private heartbeatSamples: number[] = [];
  private eventTimestamps: TimedCounter[] = [];

  constructor(private readonly processId = "gateway-node") {}

  trackConnectionOpen(): void {
    this.activeConnections += 1;
  }

  trackConnectionClose(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  trackReconnectAttempt(): void {
    this.reconnectAttempts += 1;
  }

  trackDispatchedEvent(): void {
    this.eventsTotal += 1;
    const now = Date.now();
    this.eventTimestamps.push({ atMs: now });
    this.eventTimestamps = this.eventTimestamps.filter((item) => now - item.atMs <= 1_000);
  }

  trackFanoutLatency(latencyMs: number): void {
    const parsed = Math.max(0, Math.floor(Number(latencyMs) || 0));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    this.fanoutLatencySamples.push(parsed);
    if (this.fanoutLatencySamples.length > 1_000) {
      this.fanoutLatencySamples = this.fanoutLatencySamples.slice(-500);
    }
  }

  trackDroppedDispatch(eventCount: number): void {
    const sanitized = Math.max(0, Math.floor(eventCount));
    if (sanitized <= 0) {
      return;
    }
    this.droppedEvents += sanitized;
  }

  trackDispatchQueueDepth(depth: number): void {
    const safeDepth = Math.max(0, Math.floor(depth));
    this.activeDispatchQueue = safeDepth;
    if (safeDepth > this.maxDispatchQueueDepth) {
      this.maxDispatchQueueDepth = safeDepth;
    }
  }

  trackHeartbeatAck(clientLatencyMs: number): void {
    this.heartbeatSamples.push(clientLatencyMs);
    if (this.heartbeatSamples.length > 100) {
      this.heartbeatSamples.splice(0, this.heartbeatSamples.length - 100);
    }
  }

  getSnapshot(): GatewayMetricsSnapshot {
    const sum = this.heartbeatSamples.reduce((acc, value) => acc + value, 0);
    const avg = this.heartbeatSamples.length > 0 ? Math.round(sum / this.heartbeatSamples.length) : 0;
    const fanoutP95 = this.fanoutLatencySamples.length > 0
      ? this.fanoutLatencySamples
          .slice()
          .sort((left, right) => left - right)
          .at(Math.max(0, Math.floor(this.fanoutLatencySamples.length * 0.95) - 1))
      ?? 0
      : 0;
    const memory = process.memoryUsage?.() ?? { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };

    return {
      processId: this.processId,
      activeConnections: this.activeConnections,
      reconnectAttempts: this.reconnectAttempts,
      eventsTotal: this.eventsTotal,
      eventsPerSecond: this.eventTimestamps.length,
      avgHeartbeatLatencyMs: avg,
      droppedEvents: this.droppedEvents,
      activeDispatchQueue: this.activeDispatchQueue,
      maxDispatchQueueDepth: this.maxDispatchQueueDepth,
      fanoutLatencyMsP95: fanoutP95,
      memoryUsage: {
        rss: memory.rss ?? 0,
        heapUsed: memory.heapUsed ?? 0,
        heapTotal: memory.heapTotal ?? 0,
        external: memory.external ?? 0,
      },
    };
  }
}
