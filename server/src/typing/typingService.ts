import type { EventBus } from "../events/eventBus";
import { normalizeEventIdentity } from "../events/eventTypes";

interface TypingTimer {
  timer: ReturnType<typeof setTimeout>;
}

interface TypingStore {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  clear(key: string): Promise<void>;
}

export class TypingService {
  private readonly timers = new Map<string, TypingTimer>();
  private readonly localStore = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly eventBus: EventBus,
    private readonly typingTtlMs = 5_000,
    private readonly typingStore?: TypingStore,
  ) {}

  async startTyping(conversationId: string, userId: string): Promise<void> {
    const key = `${conversationId}:${userId}`;

    if (this.localStore.has(key)) {
      clearTimeout(this.localStore.get(key));
    }
    const stopAt = Date.now() + this.typingTtlMs;
    const timer = setTimeout(() => {
      this.localStore.delete(key);
      void this.stopTyping(conversationId, userId);
    }, this.typingTtlMs);
    this.localStore.set(key, timer);

    const timerEntry = this.timers.get(key);
    if (timerEntry) {
      clearTimeout(timerEntry.timer);
    }
    this.timers.set(key, { timer });

    await this.typingStore?.set(key, String(stopAt), this.typingTtlMs);
    const startIdentity = normalizeEventIdentity("TYPING_START");
    await this.eventBus.publish({
      ...startIdentity,
      event: "TYPING_START",
      scopeType: "dm",
      scopeId: conversationId,
      routingKey: `conversation:${conversationId}`,
      payload: {
        conversationId,
        userId,
        expiresAt: new Date(stopAt).toISOString(),
      },
      occurredAt: startIdentity.occurredAt,
    });
  }

  async stopTyping(conversationId: string, userId: string): Promise<void> {
    const key = `${conversationId}:${userId}`;
    const timer = this.localStore.get(key);
    if (timer) {
      clearTimeout(timer);
      this.localStore.delete(key);
    }

    const active = this.timers.get(key);
    if (active) {
      clearTimeout(active.timer);
      this.timers.delete(key);
    }

    await this.typingStore?.clear(key);
    const stopIdentity = normalizeEventIdentity("TYPING_STOP");
    await this.eventBus.publish({
      ...stopIdentity,
      event: "TYPING_STOP",
      scopeType: "dm",
      scopeId: conversationId,
      routingKey: `conversation:${conversationId}`,
      payload: {
        conversationId,
        userId,
        expiresAt: new Date().toISOString(),
      },
      occurredAt: stopIdentity.occurredAt,
    });
  }
}
