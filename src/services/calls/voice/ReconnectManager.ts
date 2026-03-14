import { SingleFlight } from "./operationLocks";
import type { CallDebugLogger } from "./types";

interface ReconnectManagerOptions {
  shouldReconnect: () => boolean;
  performReconnect: () => Promise<void>;
  onReconnectFailed?: (error: Error) => void;
  debugLog?: CallDebugLogger;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class ReconnectManager {
  private readonly shouldReconnect: () => boolean;
  private readonly performReconnect: () => Promise<void>;
  private readonly onReconnectFailed: (error: Error) => void;
  private readonly debugLog: CallDebugLogger;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectFlight = new SingleFlight<void>();
  private disposed = false;

  constructor(options: ReconnectManagerOptions) {
    this.shouldReconnect = options.shouldReconnect;
    this.performReconnect = options.performReconnect;
    this.onReconnectFailed = typeof options.onReconnectFailed === "function" ? options.onReconnectFailed : () => {};
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
    this.baseDelayMs = Math.max(100, Math.floor(options.baseDelayMs ?? 500));
    this.maxDelayMs = Math.max(this.baseDelayMs, Math.floor(options.maxDelayMs ?? 8_000));
  }

  schedule(reason: string): void {
    if (this.disposed || this.timer || !this.shouldReconnect()) {
      return;
    }

    const delay = Math.min(this.baseDelayMs * (2 ** Math.min(this.attempt, 5)), this.maxDelayMs);
    this.attempt += 1;
    this.debugLog("reconnect_scheduled", {
      reason,
      attempt: this.attempt,
      delayMs: delay,
    });

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(`scheduled:${reason}`);
    }, delay);
  }

  async run(reason: string): Promise<void> {
    if (this.disposed || !this.shouldReconnect()) {
      return;
    }
    return this.reconnectFlight.run(async () => {
      if (this.disposed || !this.shouldReconnect()) {
        return;
      }
      this.clearTimer();
      this.debugLog("reconnect_started", {
        reason,
        attempt: this.attempt,
      });
      try {
        await this.performReconnect();
        this.attempt = 0;
        this.debugLog("reconnect_succeeded", {
          reason,
        });
      } catch (error) {
        const casted = error instanceof Error ? error : new Error(String(error ?? "Reconnect failed."));
        this.debugLog("reconnect_failed", {
          reason,
          message: casted.message,
        });
        this.onReconnectFailed(casted);
        this.schedule("retry");
      }
    });
  }

  clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  resetAttempts(): void {
    this.attempt = 0;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
  }
}
