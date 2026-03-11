interface NotificationNavigationStatePayload extends MessageNotificationOpenPayload {
  conversationId: string;
}

type NotificationOpenConversationHandler = (payload: NotificationNavigationStatePayload) => void;

const MAX_PENDING_NAVIGATIONS = 16;
const NOTIFICATION_DEBUG_ENABLED = import.meta.env.DEV;

function logNotificationDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!NOTIFICATION_DEBUG_ENABLED) {
    return;
  }
  console.debug(`[notifications:renderer] ${event}`, details);
}

function normalizeOpenPayload(rawPayload: MessageNotificationOpenPayload | null | undefined): NotificationNavigationStatePayload | null {
  const conversationId = String(rawPayload?.conversationId ?? "").trim();
  if (!conversationId) {
    return null;
  }

  const messageId = String(rawPayload?.messageId ?? "").trim() || undefined;
  const eventId = String(rawPayload?.eventId ?? "").trim() || undefined;
  const source = String(rawPayload?.source ?? "").trim() || undefined;
  return {
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(source ? { source } : {}),
  };
}

export class NotificationNavigationCoordinator {
  private started = false;

  private pendingQueue: NotificationNavigationStatePayload[] = [];

  private activeHandler: NotificationOpenConversationHandler | null = null;

  private bridgeUnsubscribe: (() => void) | null = null;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const subscribeOpenConversation = window.notifications?.onOpenConversation;
    if (typeof subscribeOpenConversation === "function") {
      this.bridgeUnsubscribe = subscribeOpenConversation((payload) => {
        this.enqueue(payload);
      });
    }

    const consumePendingOpenConversations = window.notifications?.consumePendingOpenConversations;
    if (typeof consumePendingOpenConversations === "function") {
      const pending = consumePendingOpenConversations();
      if (Array.isArray(pending)) {
        if (pending.length > 0) {
          logNotificationDebug("pending_navigation_consumed", {
            source: "preload-queue",
            count: pending.length,
          });
        }
        pending.forEach((payload) => this.enqueue(payload));
      }
    }
  }

  stop(): void {
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = null;
    this.activeHandler = null;
    this.pendingQueue = [];
    this.started = false;
  }

  notifyRendererReady(): void {
    const notifyRendererReady = window.notifications?.notifyRendererReady;
    if (typeof notifyRendererReady === "function") {
      notifyRendererReady();
    }
  }

  setOpenConversationHandler(handler: NotificationOpenConversationHandler): () => void {
    this.activeHandler = handler;
    this.flushPending();
    return () => {
      if (this.activeHandler === handler) {
        this.activeHandler = null;
      }
    };
  }

  private enqueue(payload: MessageNotificationOpenPayload | null | undefined): void {
    const normalizedPayload = normalizeOpenPayload(payload);
    if (!normalizedPayload) {
      return;
    }

    this.pendingQueue = this.pendingQueue.filter((item) => {
      const sameConversation = item.conversationId === normalizedPayload.conversationId;
      const sameMessage = (item.messageId ?? "") === (normalizedPayload.messageId ?? "");
      return !(sameConversation && sameMessage);
    });
    this.pendingQueue.push(normalizedPayload);
    if (this.pendingQueue.length > MAX_PENDING_NAVIGATIONS) {
      this.pendingQueue.splice(0, this.pendingQueue.length - MAX_PENDING_NAVIGATIONS);
    }

    this.flushPending();
  }

  private flushPending(): void {
    if (!this.activeHandler || this.pendingQueue.length === 0) {
      return;
    }

    const queue = [...this.pendingQueue];
    this.pendingQueue = [];
    logNotificationDebug("pending_navigation_consumed", {
      source: "renderer-queue",
      count: queue.length,
    });
    for (const payload of queue) {
      this.activeHandler(payload);
    }
  }
}

export const notificationNavigationCoordinator = new NotificationNavigationCoordinator();
