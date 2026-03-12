import type { DispatchPublisher } from "../pubsub/dispatchPublisher";

interface TypingTimerEntry {
  timer: NodeJS.Timeout;
}

export class TypingCoordinator {
  private readonly timers = new Map<string, TypingTimerEntry>();

  constructor(
    private readonly publisher: DispatchPublisher,
    private readonly typingTtlMs: number,
  ) {}

  async startTyping(conversationId: string, userId: string): Promise<void> {
    const key = `${conversationId}:${userId}`;
    this.stopLocalTimer(key);
    const expiresAt = new Date(Date.now() + this.typingTtlMs).toISOString();
    this.timers.set(key, {
      timer: setTimeout(() => {
        void this.stopTyping(conversationId, userId);
      }, this.typingTtlMs),
    });
    await this.publisher.publishTyping("TYPING_START", conversationId, userId, expiresAt);
  }

  async stopTyping(conversationId: string, userId: string): Promise<void> {
    const key = `${conversationId}:${userId}`;
    this.stopLocalTimer(key);
    await this.publisher.publishTyping("TYPING_STOP", conversationId, userId, new Date().toISOString());
  }

  stopAllForUser(userId: string): void {
    [...this.timers.keys()]
      .filter((key) => key.endsWith(`:${userId}`))
      .forEach((key) => this.stopLocalTimer(key));
  }

  private stopLocalTimer(key: string): void {
    const existing = this.timers.get(key);
    if (!existing) {
      return;
    }
    clearTimeout(existing.timer);
    this.timers.delete(key);
  }
}
