import type { NotificationEntity } from "../stores/entities";
import { notificationsActions } from "../stores/notificationsSlice";
import { messlyStore } from "../stores/store";
import {
  NotificationBatchingOrGroupingService,
  type NotificationBatchResult,
} from "./notification/NotificationBatchingOrGroupingService";
import { NotificationDedupStore } from "./notification/NotificationDedupStore";
import { NotificationPayloadBuilder } from "./notification/NotificationPayloadBuilder";
import { NotificationPolicyService, type NotificationRuntimeContext } from "./notification/NotificationPolicyService";
import { notificationSoundService } from "./notification/NotificationSoundService";

const NOTIFICATION_DEBUG_ENABLED = import.meta.env.DEV;
const NOTIFICATION_RETRY_DELAY_MS = 1_200;

function logNotificationDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!NOTIFICATION_DEBUG_ENABLED) {
    return;
  }
  console.debug(`[notifications:renderer] ${event}`, details);
}

class NotificationsService {
  private unsubscribeStore: (() => void) | null = null;

  private readonly inFlightIds = new Set<string>();

  private retryTimerId: number | null = null;

  private hasLoggedMissingBridge = false;

  private readonly dedupStore = new NotificationDedupStore({
    ttlMs: 5 * 60_000,
    maxEntries: 8_000,
  });

  private readonly policyService = new NotificationPolicyService();

  private readonly payloadBuilder = new NotificationPayloadBuilder();

  private readonly batchingService = new NotificationBatchingOrGroupingService({
    windowMs: 260,
    maxBucketSize: 5,
    onFlush: (batch) => {
      void this.dispatchBatch(batch);
    },
  });

  private isRunning = false;

  setRuntimeContext(context: Partial<NotificationRuntimeContext>): void {
    this.policyService.updateContext(context);
  }

  start(): void {
    if (this.unsubscribeStore) {
      return;
    }

    this.isRunning = true;
    this.hasLoggedMissingBridge = false;
    const permissionState = typeof Notification === "function" ? Notification.permission : "unsupported";
    logNotificationDebug("service_started", {
      bridgeAvailable: typeof window.notifications?.notifyMessage === "function",
      notificationPermission: permissionState,
    });
    this.unsubscribeStore = messlyStore.subscribe(() => {
      void this.flushQueue();
    });
    void this.flushQueue();
  }

  stop(): void {
    this.isRunning = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.clearRetryTimer();
    this.inFlightIds.clear();
    this.dedupStore.clear();
    this.batchingService.clear();
    notificationSoundService.dispose();
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId !== null && typeof window !== "undefined") {
      window.clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
  }

  private scheduleRetry(reason: string): void {
    if (!this.isRunning || typeof window === "undefined" || this.retryTimerId !== null) {
      return;
    }

    logNotificationDebug("retry_scheduled", {
      reason,
      delayMs: NOTIFICATION_RETRY_DELAY_MS,
    });
    this.retryTimerId = window.setTimeout(() => {
      this.retryTimerId = null;
      void this.flushQueue();
    }, NOTIFICATION_RETRY_DELAY_MS);
  }

  private releaseInFlight(notificationIds: readonly string[]): void {
    notificationIds.forEach((notificationId) => {
      this.inFlightIds.delete(notificationId);
    });
  }

  private markDelivered(notificationId: string): void {
    const normalizedNotificationId = String(notificationId ?? "").trim();
    if (!normalizedNotificationId) {
      return;
    }
    this.inFlightIds.delete(normalizedNotificationId);
    messlyStore.dispatch(notificationsActions.notificationDelivered(normalizedNotificationId));
  }

  private async setWindowAttention(enabled: boolean): Promise<void> {
    const setWindowAttention = window.electronAPI?.setWindowAttention;
    if (typeof setWindowAttention !== "function") {
      return;
    }
    try {
      await setWindowAttention({ enabled });
      logNotificationDebug("window_attention_updated", { enabled });
    } catch (error) {
      logNotificationDebug("window_attention_failed", {
        enabled,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchBatch(batch: NotificationBatchResult): Promise<void> {
    if (!this.isRunning) {
      this.releaseInFlight(batch.notificationIds);
      return;
    }

    const notifyMessage = window.notifications?.notifyMessage;
    if (typeof notifyMessage !== "function") {
      if (!this.hasLoggedMissingBridge) {
        this.hasLoggedMissingBridge = true;
        logNotificationDebug("bridge_unavailable", {
          reason: "notify_message_function_missing",
        });
      }
      this.releaseInFlight(batch.notificationIds);
      this.scheduleRetry("bridge-unavailable");
      return;
    }
    this.hasLoggedMissingBridge = false;

    try {
      const result = await notifyMessage(batch.payload);
      const normalizedReason = String(result?.reason ?? "").trim().toLowerCase();
      const shouldPlaySound = Boolean(result?.ok) && normalizedReason === "queued";
      if (shouldPlaySound) {
        notificationSoundService.play();
        if (!this.policyService.getContext().isWindowFocused) {
          void this.setWindowAttention(true);
        }
      }
      logNotificationDebug("dispatch_result", {
        conversationId: batch.payload.conversationId,
        messageId: batch.payload.messageId,
        batchCount: batch.payload.batchCount ?? 1,
        reason: normalizedReason || "unknown",
        ok: Boolean(result?.ok),
        soundPlayed: shouldPlaySound,
      });

      if (!result?.ok) {
        if (normalizedReason === "notification_unavailable" || normalizedReason === "not_supported") {
          this.releaseInFlight(batch.notificationIds);
          this.scheduleRetry(normalizedReason || "main-not-ready");
          return;
        }

        batch.notificationIds.forEach((notificationId) => {
          this.markDelivered(notificationId);
        });
        return;
      }

      batch.notificationIds.forEach((notificationId) => {
        this.markDelivered(notificationId);
      });
    } catch (error) {
      logNotificationDebug("dispatch_failed", {
        reason: error instanceof Error ? error.message : String(error),
        conversationId: batch.payload.conversationId,
        messageId: batch.payload.messageId,
      });
      this.releaseInFlight(batch.notificationIds);
      this.scheduleRetry("dispatch-failed");
    }
  }

  private buildDedupKeys(notification: NotificationEntity): string[] {
    const keys = new Set<string>();
    const messageId = String(notification.messageId ?? "").trim();
    const eventId = String(notification.eventId ?? "").trim();
    const conversationId = String(notification.conversationId ?? "").trim();

    if (messageId) {
      keys.add(`message:${messageId}`);
      if (conversationId) {
        keys.add(`conversation:${conversationId}:message:${messageId}`);
      }
    }
    if (eventId) {
      keys.add(`event:${eventId}`);
      if (conversationId) {
        keys.add(`conversation:${conversationId}:event:${eventId}`);
      }
    }

    return [...keys];
  }

  private async flushQueue(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const notifyMessage = window.notifications?.notifyMessage;
    if (typeof notifyMessage !== "function") {
      if (!this.hasLoggedMissingBridge) {
        this.hasLoggedMissingBridge = true;
        logNotificationDebug("bridge_unavailable", {
          reason: "notify_message_function_missing",
        });
      }
      this.scheduleRetry("bridge-unavailable");
      return;
    }
    this.hasLoggedMissingBridge = false;

    const notificationsState = messlyStore.getState().notifications;
    const queue = notificationsState.ids
      .map((id) => notificationsState.entities[id])
      .filter((notification): notification is NotificationEntity => Boolean(notification));

    for (const notification of queue) {
      if (notification.deliveredAt || this.inFlightIds.has(notification.id)) {
        continue;
      }

      logNotificationDebug("candidate_received", {
        notificationId: notification.id,
        conversationId: notification.conversationId,
        messageId: notification.messageId,
        eventId: notification.eventId ?? null,
        source: notification.source ?? "unknown",
      });

      const policyDecision = this.policyService.shouldNotify(notification);
      if (!policyDecision.allow) {
        logNotificationDebug("policy_suppressed", {
          reason: policyDecision.reason,
          notificationId: notification.id,
          conversationId: notification.conversationId,
          messageId: notification.messageId,
          authorId: notification.authorId,
        });
        this.markDelivered(notification.id);
        continue;
      }

      if (this.dedupStore.checkAndMark(this.buildDedupKeys(notification))) {
        logNotificationDebug("deduplicated", {
          notificationId: notification.id,
          conversationId: notification.conversationId,
          messageId: notification.messageId,
          eventId: notification.eventId ?? null,
        });
        this.markDelivered(notification.id);
        continue;
      }

      this.inFlightIds.add(notification.id);
      this.batchingService.enqueue({
        notificationId: notification.id,
        payload: this.payloadBuilder.build(notification),
      });
    }
  }
}

export const notificationsService = new NotificationsService();
