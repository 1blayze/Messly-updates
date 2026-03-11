import { getGatewayUrl, getSupabaseAccessToken } from "../api/client";
import { GatewayClient, type GatewayClientState } from "../gateway/client";
import { createGatewayEventRouter } from "../gateway/router";
import type {
  GatewayDispatchEventType,
  GatewayDispatchPayloadMap,
  GatewayFrame,
  GatewayPublishEventType,
  GatewayPublishPayloadMap,
  GatewaySubscription,
} from "../gateway/protocol";
import { gatewayActions } from "../stores/gatewaySlice";
import { messlyStore } from "../stores/store";

export type MesslyGatewayEventType =
  | "MESSAGE_CREATE"
  | "MESSAGE_DELETE"
  | "PRESENCE_UPDATE"
  | "TYPING_START"
  | "MEDIA_DELETE"
  | "USER_UPDATE";

type GatewayEventListener<TEvent extends MesslyGatewayEventType> = (payload: GatewayDispatchPayloadMap[TEvent]) => void;

class MesslyGatewayService {
  private client: GatewayClient | null = null;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private currentUserId: string | null = null;
  private readonly subscriptions = new Map<string, GatewaySubscription>();
  private readonly eventListeners = new Map<MesslyGatewayEventType, Set<(payload: unknown) => void>>();

  async start(userId: string | null | undefined): Promise<void> {
    const normalizedUserId = String(userId ?? "").trim() || null;
    if (!normalizedUserId) {
      this.stop();
      return;
    }

    this.currentUserId = normalizedUserId;
    if (!this.client) {
      this.client = new GatewayClient({
        url: getGatewayUrl(),
        tokenProvider: getSupabaseAccessToken,
        clientInfo: {
          name: "messly-desktop",
          version: String(import.meta.env.VITE_MESSLY_GATEWAY_CLIENT_VERSION ?? "0.0.5"),
          platform: typeof window !== "undefined" ? String(window.electronAPI?.platform ?? "web") : "web",
        },
      });

      const router = createGatewayEventRouter(messlyStore.dispatch, () => ({
        currentUserId: this.currentUserId,
      }));

      this.unsubscribeState = this.client.subscribeState((state) => this.handleClientState(state));
      this.unsubscribeFrames = this.client.subscribeFrames((frame) => {
        this.handleGatewayFrame(frame);
        router.routeFrame(frame);
      });
    }

    this.replaceSubscriptions([
      { type: "user", id: normalizedUserId },
      { type: "friends", id: normalizedUserId },
      { type: "notifications", id: normalizedUserId },
    ]);

    await this.client.connect();
  }

  stop(): void {
    this.currentUserId = null;
    this.client?.disconnect();
    this.unsubscribeFrames?.();
    this.unsubscribeState?.();
    this.unsubscribeFrames = null;
    this.unsubscribeState = null;
    this.client = null;
    this.subscriptions.clear();
    messlyStore.dispatch(gatewayActions.gatewayReset());
  }

  isConfigured(): boolean {
    return Boolean(getGatewayUrl());
  }

  subscribeConversation(conversationId: string): void {
    this.upsertSubscription({
      type: "conversation",
      id: conversationId,
    });
  }

  unsubscribeConversation(conversationId: string): void {
    this.removeSubscription({
      type: "conversation",
      id: conversationId,
    });
  }

  async publish<TEvent extends GatewayPublishEventType>(
    eventType: TEvent,
    payload: GatewayPublishPayloadMap[TEvent],
  ): Promise<void> {
    if (!this.client || !this.isConfigured()) {
      return;
    }
    await this.client.publish(eventType, payload);
  }

  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  subscribeEvent<TEvent extends MesslyGatewayEventType>(
    eventType: TEvent,
    listener: GatewayEventListener<TEvent>,
  ): () => void {
    const listeners = this.eventListeners.get(eventType) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as (payload: unknown) => void);
    this.eventListeners.set(eventType, listeners);

    return () => {
      const current = this.eventListeners.get(eventType);
      current?.delete(listener as (payload: unknown) => void);
      if (current && current.size === 0) {
        this.eventListeners.delete(eventType);
      }
    };
  }

  private replaceSubscriptions(subscriptions: GatewaySubscription[]): void {
    this.subscriptions.clear();
    subscriptions.forEach((subscription) => {
      this.subscriptions.set(`${subscription.type}:${subscription.id}`, subscription);
    });
    const nextSubscriptions = [...this.subscriptions.values()];
    messlyStore.dispatch(gatewayActions.gatewaySubscriptionsReplaced(nextSubscriptions));
    this.client?.replaceSubscriptions(nextSubscriptions);
  }

  private upsertSubscription(subscription: GatewaySubscription): void {
    this.subscriptions.set(`${subscription.type}:${subscription.id}`, subscription);
    const nextSubscriptions = [...this.subscriptions.values()];
    messlyStore.dispatch(gatewayActions.gatewaySubscriptionsReplaced(nextSubscriptions));
    this.client?.replaceSubscriptions(nextSubscriptions);
  }

  private removeSubscription(subscription: GatewaySubscription): void {
    this.subscriptions.delete(`${subscription.type}:${subscription.id}`);
    const nextSubscriptions = [...this.subscriptions.values()];
    messlyStore.dispatch(gatewayActions.gatewaySubscriptionsReplaced(nextSubscriptions));
    this.client?.replaceSubscriptions(nextSubscriptions);
  }

  private handleClientState(state: GatewayClientState): void {
    messlyStore.dispatch(
      gatewayActions.gatewayStateChanged({
        status: state.status,
        reconnectAttempt: state.reconnectAttempt,
        lastError: state.lastError,
      }),
    );
    messlyStore.dispatch(
      gatewayActions.gatewaySessionUpdated({
        sessionId: state.sessionId,
        seq: state.seq,
      }),
    );
    messlyStore.dispatch(gatewayActions.gatewayLatencyUpdated(state.latencyMs));
  }

  private handleGatewayFrame(frame: GatewayFrame): void {
    if (frame.op !== "DISPATCH" || !frame.t) {
      return;
    }

    const eventType = frame.t as GatewayDispatchEventType;
    if (
      eventType !== "MESSAGE_CREATE" &&
      eventType !== "MESSAGE_DELETE" &&
      eventType !== "PRESENCE_UPDATE" &&
      eventType !== "TYPING_START" &&
      eventType !== "MEDIA_DELETE" &&
      eventType !== "USER_UPDATE"
    ) {
      return;
    }

    const listeners = this.eventListeners.get(eventType);
    if (!listeners || listeners.size === 0) {
      return;
    }

    listeners.forEach((listener) => {
      listener(frame.d);
    });
  }
}

export const gatewayService = new MesslyGatewayService();
