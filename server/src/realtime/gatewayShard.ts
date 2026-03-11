import type { GatewaySubscription } from "../protocol/gateway";
import type { DomainDispatchEnvelope } from "../events/eventTypes";
import { SubscriptionManager, type DispatchableSession } from "../subscriptions/subscriptionManager";

export interface GatewayShardPresence {
  userId: string;
  online: boolean;
  updatedAt: string;
}

export class GatewayShard {
  private readonly sessionsById = new Map<string, DispatchableSession>();
  private readonly usersBySessionId = new Map<string, string>();
  private readonly sessionCountsByUserId = new Map<string, number>();

  private readonly sessionsByConnection = new Set<string>();

  constructor(
    public readonly shardId: number,
    private readonly subscriptions: SubscriptionManager = new SubscriptionManager(),
  ) {}

  attachSession(session: DispatchableSession, subscriptions: GatewaySubscription[]): void {
    this.sessionsById.set(session.sessionId, session);
    this.sessionsByConnection.add(session.sessionId);
    this.usersBySessionId.set(session.sessionId, session.userId);
    this.sessionCountsByUserId.set(
      session.userId,
      (this.sessionCountsByUserId.get(session.userId) ?? 0) + 1,
    );
    this.subscriptions.registerSession(session, subscriptions);
  }

  detachSession(sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    const userId = this.usersBySessionId.get(sessionId);
    if (userId) {
      const nextCount = (this.sessionCountsByUserId.get(userId) ?? 1) - 1;
      if (nextCount <= 0) {
        this.sessionCountsByUserId.delete(userId);
      } else {
        this.sessionCountsByUserId.set(userId, nextCount);
      }
    }
    this.subscriptions.unregisterSession(sessionId);
    this.sessionsById.delete(sessionId);
    this.usersBySessionId.delete(sessionId);
    this.sessionsByConnection.delete(sessionId);
  }

  updateSubscriptions(sessionId: string, subscriptions: GatewaySubscription[]): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    this.subscriptions.registerSession(session, subscriptions);
  }

  dispatch(subscription: GatewaySubscription, envelope: DomainDispatchEnvelope<unknown>): void {
    this.subscriptions.fanout(
      subscription,
      envelope,
    );
  }

  hasSession(sessionId: string): boolean {
    return this.sessionsById.has(sessionId);
  }

  getConnectionCount(): number {
    return this.sessionsByConnection.size;
  }

  isUserOnline(userId: string): boolean {
    return (this.sessionCountsByUserId.get(userId) ?? 0) > 0;
  }

  snapshotPresence(): GatewayShardPresence[] {
    return [...this.sessionCountsByUserId.entries()].map(([userId]) => ({
      userId,
      online: true,
      updatedAt: new Date().toISOString(),
    }));
  }
}
