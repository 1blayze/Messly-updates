import type { GatewaySubscription } from "../protocol/gateway";
import type { DomainDispatchEnvelope } from "../events/eventTypes";

export interface DispatchableSession {
  sessionId: string;
  userId: string;
  dispatch: (frame: DomainDispatchEnvelope<unknown>) => void;
}

function topicKey(subscription: GatewaySubscription): string {
  return `${subscription.type}:${subscription.id}`;
}

export class SubscriptionManager {
  private readonly sessionsByTopic = new Map<string, Map<string, DispatchableSession>>();
  private readonly topicsBySessionId = new Map<string, Set<string>>();

  registerSession(session: DispatchableSession, subscriptions: GatewaySubscription[]): void {
    this.unregisterSession(session.sessionId);
    this.topicsBySessionId.set(session.sessionId, new Set<string>());
    subscriptions.forEach((subscription) => this.subscribe(session, subscription));
  }

  subscribe(session: DispatchableSession, subscription: GatewaySubscription): void {
    const key = topicKey(subscription);
    const sessions = this.sessionsByTopic.get(key) ?? new Map<string, DispatchableSession>();
    sessions.set(session.sessionId, session);
    this.sessionsByTopic.set(key, sessions);

    const topics = this.topicsBySessionId.get(session.sessionId) ?? new Set<string>();
    topics.add(key);
    this.topicsBySessionId.set(session.sessionId, topics);
  }

  unsubscribe(session: DispatchableSession, subscription: GatewaySubscription): void {
    this.unsubscribeByTopic(session.sessionId, topicKey(subscription));
  }

  unregisterSession(sessionId: string): void {
    const topics = this.topicsBySessionId.get(sessionId);
    if (!topics) {
      return;
    }

    topics.forEach((key) => {
      this.unsubscribeByTopic(sessionId, key);
    });
    this.topicsBySessionId.delete(sessionId);
  }

  fanout(subscription: GatewaySubscription, envelope: DomainDispatchEnvelope<unknown>): void {
    const sessions = this.sessionsByTopic.get(topicKey(subscription));
    if (!sessions) {
      return;
    }

    sessions.forEach((session) => {
      session.dispatch(envelope);
    });
  }

  getTopicsForSession(sessionId: string): GatewaySubscription[] {
    const topics = this.topicsBySessionId.get(sessionId);
    if (!topics) {
      return [];
    }
    return [...topics]
      .map((key) => {
        const [type, id] = key.split(":", 2);
        return { type: type as GatewaySubscription["type"], id } as GatewaySubscription;
      })
      .filter((subscription) => subscription.id.length > 0);
  }

  private unsubscribeByTopic(sessionId: string, key: string): void {
    const sessions = this.sessionsByTopic.get(key);
    sessions?.delete(sessionId);
    if (!sessions || sessions.size === 0) {
      this.sessionsByTopic.delete(key);
    }

    const topics = this.topicsBySessionId.get(sessionId);
    topics?.delete(key);
  }
}
