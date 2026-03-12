export interface GatewayHeartbeatOptions {
  intervalMs: number;
  ackTimeoutMs?: number;
  onHeartbeat: () => void;
  onTimeout: () => void;
}

export class GatewayHeartbeat {
  private readonly intervalMs: number;
  private readonly ackTimeoutMs: number;
  private readonly onHeartbeat: () => void;
  private readonly onTimeout: () => void;
  private intervalId: number | null = null;
  private ackTimeoutId: number | null = null;

  constructor(options: GatewayHeartbeatOptions) {
    this.intervalMs = Math.max(1_000, Math.floor(options.intervalMs));
    this.ackTimeoutMs = Math.max(this.intervalMs, Math.floor(options.ackTimeoutMs ?? options.intervalMs * 2));
    this.onHeartbeat = options.onHeartbeat;
    this.onTimeout = options.onTimeout;
  }

  start(): void {
    this.stop();
    this.intervalId = window.setInterval(() => {
      this.expectAck();
      this.onHeartbeat();
    }, this.intervalMs);
  }

  ack(): void {
    if (this.ackTimeoutId != null) {
      window.clearTimeout(this.ackTimeoutId);
      this.ackTimeoutId = null;
    }
  }

  stop(): void {
    if (this.intervalId != null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.ackTimeoutId != null) {
      window.clearTimeout(this.ackTimeoutId);
      this.ackTimeoutId = null;
    }
  }

  private expectAck(): void {
    if (this.ackTimeoutId != null) {
      window.clearTimeout(this.ackTimeoutId);
    }

    this.ackTimeoutId = window.setTimeout(() => {
      this.ackTimeoutId = null;
      this.onTimeout();
    }, this.ackTimeoutMs);
  }
}
