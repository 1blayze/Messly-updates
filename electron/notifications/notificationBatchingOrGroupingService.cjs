class NotificationBatchingOrGroupingService {
  constructor(options = {}) {
    this.groupWindowMs = Math.max(60, Number(options.groupWindowMs ?? 1_800));
    this.maxBucketSize = Math.max(1, Number(options.maxBucketSize ?? 8));
    this.onFlush = typeof options.onFlush === "function" ? options.onFlush : () => {};
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
    this.buckets = new Map();
  }

  enqueue(payload) {
    const conversationId = String(payload?.conversationId ?? "").trim();
    if (!conversationId) {
      this.onFlush({
        conversationId: "",
        count: 1,
        latestPayload: payload,
        messageIds: [],
        eventIds: [],
      });
      return;
    }

    const existingBucket = this.buckets.get(conversationId);
    const bucket = existingBucket ?? {
      conversationId,
      payloads: [],
      messageIds: new Set(),
      eventIds: new Set(),
      timer: null,
    };

    bucket.payloads.push(payload);
    const messageId = String(payload?.messageId ?? "").trim();
    if (messageId) {
      bucket.messageIds.add(messageId);
    }
    const eventId = String(payload?.eventId ?? "").trim();
    if (eventId) {
      bucket.eventIds.add(eventId);
    }

    this.buckets.set(conversationId, bucket);

    if (bucket.payloads.length >= this.maxBucketSize) {
      this.flushConversation(conversationId);
      return;
    }

    this.restartTimer(bucket);
  }

  flushAll() {
    for (const conversationId of this.buckets.keys()) {
      this.flushConversation(conversationId);
    }
  }

  clear() {
    for (const bucket of this.buckets.values()) {
      this.clearTimer(bucket);
    }
    this.buckets.clear();
  }

  flushConversation(conversationIdRaw) {
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

    const count = Math.max(1, bucket.messageIds.size || bucket.payloads.length);
    if (count > 1) {
      this.debugLog("grouped", {
        conversationId,
        batchCount: count,
        payloadCount: bucket.payloads.length,
      });
    }
    this.onFlush({
      conversationId,
      count,
      latestPayload: {
        ...latestPayload,
        batchCount: count,
      },
      messageIds: [...bucket.messageIds],
      eventIds: [...bucket.eventIds],
    });
  }

  restartTimer(bucket) {
    this.clearTimer(bucket);
    bucket.timer = setTimeout(() => {
      this.flushConversation(bucket.conversationId);
    }, this.groupWindowMs);
  }

  clearTimer(bucket) {
    if (!bucket || !bucket.timer) {
      return;
    }
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}

module.exports = {
  NotificationBatchingOrGroupingService,
};
