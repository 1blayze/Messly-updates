export interface NotificationBatchInput {
  notificationId: string;
  payload: MessageNotificationPayload;
}

export interface NotificationBatchResult {
  notificationIds: string[];
  payload: MessageNotificationPayload;
}

interface NotificationBatchingOrGroupingServiceOptions {
  windowMs?: number;
  maxBucketSize?: number;
  onFlush: (batch: NotificationBatchResult) => void;
}

interface NotificationConversationBucket {
  conversationId: string;
  notificationIds: string[];
  payloads: MessageNotificationPayload[];
  timer: number | null;
}

const DEFAULT_GROUP_WINDOW_MS = 260;
const DEFAULT_MAX_BUCKET_SIZE = 5;
const NOTIFICATION_DEBUG_ENABLED = import.meta.env.DEV;

function logNotificationDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!NOTIFICATION_DEBUG_ENABLED) {
    return;
  }
  console.debug(`[notifications:renderer] ${event}`, details);
}

export class NotificationBatchingOrGroupingService {
  private readonly groupWindowMs: number;

  private readonly maxBucketSize: number;

  private readonly onFlush: (batch: NotificationBatchResult) => void;

  private readonly buckets = new Map<string, NotificationConversationBucket>();

  constructor(options: NotificationBatchingOrGroupingServiceOptions) {
    this.groupWindowMs = Math.max(40, Number(options.windowMs ?? DEFAULT_GROUP_WINDOW_MS));
    this.maxBucketSize = Math.max(1, Number(options.maxBucketSize ?? DEFAULT_MAX_BUCKET_SIZE));
    this.onFlush = options.onFlush;
  }

  enqueue(input: NotificationBatchInput): void {
    const notificationId = String(input.notificationId ?? "").trim();
    const conversationId = String(input.payload?.conversationId ?? "").trim();
    if (!notificationId || !conversationId) {
      this.onFlush({
        notificationIds: notificationId ? [notificationId] : [],
        payload: {
          ...input.payload,
          batchCount: 1,
        },
      });
      return;
    }

    const existingBucket = this.buckets.get(conversationId);
    const bucket =
      existingBucket ??
      ({
        conversationId,
        notificationIds: [],
        payloads: [],
        timer: null,
      } satisfies NotificationConversationBucket);

    if (!bucket.notificationIds.includes(notificationId)) {
      bucket.notificationIds.push(notificationId);
      bucket.payloads.push(input.payload);
    } else {
      const existingIndex = bucket.notificationIds.indexOf(notificationId);
      if (existingIndex >= 0) {
        bucket.payloads[existingIndex] = input.payload;
      }
    }

    this.buckets.set(conversationId, bucket);

    if (bucket.notificationIds.length >= this.maxBucketSize) {
      this.flushConversation(conversationId);
      return;
    }

    this.restartTimer(bucket);
  }

  flushAll(): void {
    for (const conversationId of this.buckets.keys()) {
      this.flushConversation(conversationId);
    }
  }

  clear(): void {
    for (const bucket of this.buckets.values()) {
      this.clearTimer(bucket);
    }
    this.buckets.clear();
  }

  private flushConversation(conversationIdRaw: string): void {
    const conversationId = String(conversationIdRaw ?? "").trim();
    if (!conversationId) {
      return;
    }

    const bucket = this.buckets.get(conversationId);
    if (!bucket) {
      return;
    }
    this.buckets.delete(conversationId);
    this.clearTimer(bucket);

    const latestPayload = bucket.payloads[bucket.payloads.length - 1];
    if (!latestPayload) {
      return;
    }

    const uniqueMessageIds = new Set(
      bucket.payloads
        .map((payload) => String(payload.messageId ?? "").trim())
        .filter((messageId) => Boolean(messageId)),
    );
    const batchCount = Math.max(1, uniqueMessageIds.size || bucket.payloads.length);
    if (batchCount > 1) {
      logNotificationDebug("grouped", {
        conversationId,
        batchCount,
        queuedNotifications: bucket.notificationIds.length,
      });
    }

    this.onFlush({
      notificationIds: [...bucket.notificationIds],
      payload: {
        ...latestPayload,
        batchCount,
      },
    });
  }

  private restartTimer(bucket: NotificationConversationBucket): void {
    this.clearTimer(bucket);
    bucket.timer = window.setTimeout(() => {
      this.flushConversation(bucket.conversationId);
    }, this.groupWindowMs);
  }

  private clearTimer(bucket: NotificationConversationBucket): void {
    if (bucket.timer === null) {
      return;
    }
    window.clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}
