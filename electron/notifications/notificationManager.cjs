const { NotificationDedupStore } = require("./notificationDedupStore.cjs");
const { NotificationBatchingOrGroupingService } = require("./notificationBatchingOrGroupingService.cjs");
const { AvatarCacheService } = require("./avatarCacheService.cjs");

const MESSAGE_NOTIFICATION_MAX_ID_LENGTH = 160;
const MESSAGE_NOTIFICATION_MAX_AUTHOR_NAME_LENGTH = 80;
const MESSAGE_NOTIFICATION_MAX_PREVIEW_LENGTH = 180;
const MESSAGE_NOTIFICATION_MAX_CONTEXT_LENGTH = 96;
const CALL_NOTIFICATION_MAX_AVATAR_URL_LENGTH = 2_048;
const SHOULD_GROUP_MESSAGE_NOTIFICATIONS = process.platform !== "win32";

function sanitizeIdentifier(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized || normalized.length > MESSAGE_NOTIFICATION_MAX_ID_LENGTH) {
    return "";
  }
  return normalized;
}

function sanitizeText(rawValue, maxLength) {
  const normalized = String(rawValue ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, Math.max(1, Number(maxLength) || MESSAGE_NOTIFICATION_MAX_PREVIEW_LENGTH));
}

function resolveAttachmentFallback(payload) {
  const attachmentCount = Math.max(0, Number(payload.attachmentCount ?? 0));
  if (attachmentCount > 1) {
    return `📎 Enviou ${attachmentCount} anexos`;
  }

  const messageType = String(payload.messageType ?? "").trim().toLowerCase();
  const mimeType = String(payload.attachmentMimeType ?? "").trim().toLowerCase();
  if (messageType === "image" || mimeType.startsWith("image/")) {
    return "📷 Enviou uma imagem";
  }
  if (messageType === "video" || mimeType.startsWith("video/")) {
    return "🎥 Enviou um vídeo";
  }
  if (mimeType.startsWith("audio/")) {
    return "🎤 Enviou um áudio";
  }
  if (messageType === "file") {
    if (mimeType.startsWith("image/")) {
      return "🖼️ Enviou uma imagem";
    }
    if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
      return "🎬 Enviou uma mídia";
    }
    return "📎 Enviou um arquivo";
  }
  if (mimeType.startsWith("image/")) {
    return "🖼️ Enviou uma imagem";
  }
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    return "🎬 Enviou uma mídia";
  }
  return "Mensagem sem texto";
}

function normalizeMessageNotificationPayload(rawPayload) {
  const conversationId = sanitizeIdentifier(rawPayload?.conversationId);
  const messageId = sanitizeIdentifier(rawPayload?.messageId) || sanitizeIdentifier(rawPayload?.eventId);
  const eventId = sanitizeIdentifier(rawPayload?.eventId);
  const authorId = sanitizeIdentifier(rawPayload?.authorId) || `conversation:${conversationId || "unknown"}`;
  if (!conversationId || !messageId) {
    return null;
  }

  const authorName =
    sanitizeText(rawPayload?.authorName, MESSAGE_NOTIFICATION_MAX_AUTHOR_NAME_LENGTH) || "Nova mensagem";
  const contentPreview = sanitizeText(rawPayload?.contentPreview, MESSAGE_NOTIFICATION_MAX_PREVIEW_LENGTH);
  const contextLabel = sanitizeText(rawPayload?.contextLabel, MESSAGE_NOTIFICATION_MAX_CONTEXT_LENGTH);
  const conversationType = sanitizeText(rawPayload?.conversationType, 24).toLowerCase() || "dm";
  const avatarUrl = sanitizeText(rawPayload?.avatarUrl, 2_048) || null;
  const createdAt = sanitizeText(rawPayload?.createdAt, 64) || null;
  const messageType = sanitizeText(rawPayload?.messageType, 32) || "text";
  const attachmentMimeType = sanitizeText(rawPayload?.attachmentMimeType, 128) || null;
  const attachmentCount = Math.max(0, Number(rawPayload?.attachmentCount ?? 0));
  const batchCount = Math.max(1, Number(rawPayload?.batchCount ?? 1));
  const muted = Boolean(rawPayload?.muted);

  return {
    conversationId,
    messageId,
    eventId: eventId || null,
    authorId,
    authorName,
    contentPreview: contentPreview || resolveAttachmentFallback({ messageType, attachmentMimeType, attachmentCount }),
    contextLabel: contextLabel || null,
    conversationType,
    avatarUrl,
    createdAt,
    messageType,
    attachmentMimeType,
    attachmentCount,
    batchCount,
    muted,
  };
}

function normalizeVoiceCallNotificationPayload(rawPayload) {
  const conversationId = sanitizeIdentifier(rawPayload?.conversationId);
  const roomId = sanitizeIdentifier(rawPayload?.roomId);
  const callerUserId = sanitizeIdentifier(rawPayload?.callerUserId);
  if (!conversationId || !roomId || !callerUserId) {
    return null;
  }

  const callerName =
    sanitizeText(rawPayload?.callerName, MESSAGE_NOTIFICATION_MAX_AUTHOR_NAME_LENGTH) || "Nova chamada";
  const callerAvatarUrl = sanitizeText(rawPayload?.callerAvatarUrl, CALL_NOTIFICATION_MAX_AVATAR_URL_LENGTH) || null;
  const sentAtRaw = Number(rawPayload?.sentAt);
  const sentAt = Number.isFinite(sentAtRaw) ? Math.max(0, Math.trunc(sentAtRaw)) : Date.now();

  return {
    conversationId,
    roomId,
    callerUserId,
    callerName,
    callerAvatarUrl,
    sentAt,
  };
}

function createNotificationManager(options = {}) {
  return new NotificationManager(options);
}

class NotificationManager {
  constructor(options = {}) {
    this.appName = String(options.appName ?? "Messly").trim() || "Messly";
    this.appId = sanitizeIdentifier(options.appId) || null;
    this.NotificationCtor = options.NotificationCtor;
    this.getAppNotificationIcon = options.getAppNotificationIcon;
    this.navigationCoordinator = options.navigationCoordinator;
    this.debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
    this.dedupStore = new NotificationDedupStore({
      ttlMs: 5 * 60_000,
      maxEntries: 12_000,
    });
    this.avatarCacheService = new AvatarCacheService({
      app: options.app,
      nativeImage: options.nativeImage,
      fetchImpl: options.fetchImpl,
      cacheTtlMs: 14 * 24 * 60 * 60 * 1000,
      maxCacheFiles: 320,
      requestTimeoutMs: 4_500,
      cleanupIntervalMs: 15 * 60_000,
      imageSize: 96,
      debugLog: this.debugLog,
    });
    this.groupingService = new NotificationBatchingOrGroupingService({
      groupWindowMs: 320,
      maxBucketSize: 8,
      debugLog: this.debugLog,
      onFlush: (batch) => {
        void this.dispatchGroupedNotification(batch);
      },
    });
  }

  async notifyMessage(rawPayload) {
    const payload = normalizeMessageNotificationPayload(rawPayload);
    if (!payload) {
      return { ok: false, reason: "invalid_payload" };
    }
    if (typeof this.NotificationCtor !== "function") {
      this.debugLog("notification_unavailable", {
        reason: "notification_ctor_missing",
      });
      return { ok: false, reason: "notification_unavailable" };
    }
    if (typeof this.NotificationCtor.isSupported === "function" && !this.NotificationCtor.isSupported()) {
      this.debugLog("notification_unavailable", {
        reason: "notification_not_supported",
      });
      return { ok: false, reason: "not_supported" };
    }
    if (payload.muted) {
      return { ok: true, reason: "muted" };
    }

    const dedupKeys = this.buildDedupKeys(payload);
    if (this.dedupStore.checkAndMark(dedupKeys)) {
      this.debugLog("deduplicated", {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        eventId: payload.eventId ?? null,
      });
      return { ok: true, reason: "duplicate" };
    }

    if (!SHOULD_GROUP_MESSAGE_NOTIFICATIONS) {
      const shown = await this.dispatchSingleMessageNotification({
        ...payload,
        batchCount: 1,
      });
      return { ok: shown, reason: shown ? "shown" : "show_failed" };
    }

    this.groupingService.enqueue(payload);
    return { ok: true, reason: "queued" };
  }

  async notifyCall(rawPayload) {
    const payload = normalizeVoiceCallNotificationPayload(rawPayload);
    if (!payload) {
      return { ok: false, reason: "invalid_payload" };
    }
    if (typeof this.NotificationCtor !== "function") {
      this.debugLog("notification_unavailable", {
        reason: "notification_ctor_missing",
      });
      return { ok: false, reason: "notification_unavailable" };
    }
    if (typeof this.NotificationCtor.isSupported === "function" && !this.NotificationCtor.isSupported()) {
      this.debugLog("notification_unavailable", {
        reason: "notification_not_supported",
      });
      return { ok: false, reason: "not_supported" };
    }

    const dedupSecondBucket = Math.floor(payload.sentAt / 1_000);
    const dedupKeys = [
      `call:room:${payload.roomId}:second:${dedupSecondBucket}`,
      `call:room:${payload.roomId}:caller:${payload.callerUserId}:second:${dedupSecondBucket}`,
      `call:conversation:${payload.conversationId}:caller:${payload.callerUserId}:second:${dedupSecondBucket}`,
    ];
    if (this.dedupStore.checkAndMark(dedupKeys)) {
      this.debugLog("call_deduplicated", {
        conversationId: payload.conversationId,
        roomId: payload.roomId,
        callerUserId: payload.callerUserId,
      });
      return { ok: true, reason: "duplicate" };
    }

    const notificationOptions = await this.buildCallNotificationOptions(payload);
    if (!notificationOptions) {
      return { ok: false, reason: "invalid_options" };
    }

    const shown = this.showNotificationWithFallback(notificationOptions, {
      conversationId: payload.conversationId,
      source: "voice-call-notification",
    });

    if (!shown) {
      return { ok: false, reason: "show_failed" };
    }

    this.debugLog("call_shown", {
      conversationId: payload.conversationId,
      roomId: payload.roomId,
      callerUserId: payload.callerUserId,
    });
    return { ok: true, reason: "shown" };
  }

  dispose() {
    this.groupingService.clear();
    this.dedupStore.clear();
    this.avatarCacheService.clear();
  }

  buildDedupKeys(payload) {
    const keys = new Set();
    keys.add(`message:${payload.messageId}`);
    keys.add(`conversation:${payload.conversationId}:message:${payload.messageId}`);
    if (payload.eventId) {
      keys.add(`event:${payload.eventId}`);
      keys.add(`conversation:${payload.conversationId}:event:${payload.eventId}`);
    }
    return [...keys];
  }

  async dispatchGroupedNotification(grouped) {
    if (typeof this.NotificationCtor !== "function" || !this.navigationCoordinator) {
      this.debugLog("dispatch_skipped", {
        reason: "notification_ctor_or_navigation_missing",
      });
      return;
    }
    if (typeof this.NotificationCtor.isSupported === "function" && !this.NotificationCtor.isSupported()) {
      this.debugLog("dispatch_skipped", {
        reason: "notification_not_supported",
      });
      return;
    }
    const payload = grouped?.latestPayload;
    if (!payload) {
      this.debugLog("dispatch_skipped", {
        reason: "missing_payload",
      });
      return;
    }

    const batchCount = Math.max(1, Number(grouped.count ?? payload.batchCount ?? 1));
    const notificationPayload = {
      ...payload,
      batchCount,
    };
    const shown = await this.dispatchSingleMessageNotification(notificationPayload);
    if (!shown) {
      this.debugLog("dispatch_skipped", {
        reason: "show_failed",
        conversationId: notificationPayload.conversationId,
        messageId: notificationPayload.messageId,
      });
      return;
    }
    this.debugLog("shown", {
      conversationId: notificationPayload.conversationId,
      messageId: notificationPayload.messageId,
      eventId: notificationPayload.eventId ?? null,
      batchCount,
    });
  }

  async buildNotificationOptions(payload) {
    const title = this.buildTitle(payload);
    const body = this.buildBody(payload);
    if (!title || !body) {
      return null;
    }

    const options = {
      title,
      body,
      subtitle: this.appName,
      silent: Boolean(payload.muted),
    };
    if (this.appId) {
      options.appID = this.appId;
    }

    const avatarPath = await this.avatarCacheService.resolveAvatarPath({
      authorId: payload.authorId,
      avatarUrl: payload.avatarUrl,
      avatarVersion: payload.createdAt ?? payload.messageId,
    });
    if (avatarPath) {
      options.icon = avatarPath;
      return options;
    }

    const fallbackIcon = this.getAppNotificationIcon?.();
    if (fallbackIcon) {
      options.icon = fallbackIcon;
    }
    return options;
  }

  async dispatchSingleMessageNotification(notificationPayload) {
    const notificationOptions = await this.buildNotificationOptions(notificationPayload);
    if (!notificationOptions) {
      return false;
    }
    return this.showNotificationWithFallback(notificationOptions, {
      conversationId: notificationPayload.conversationId,
      messageId: notificationPayload.messageId,
      eventId: notificationPayload.eventId,
      source: "native-notification",
    });
  }

  async buildCallNotificationOptions(payload) {
    const callerName = sanitizeText(payload.callerName, MESSAGE_NOTIFICATION_MAX_AUTHOR_NAME_LENGTH) || "Nova chamada";
    const appName = sanitizeText(this.appName, 40);
    const title = appName && !callerName.toLowerCase().includes(appName.toLowerCase())
      ? `${callerName} • ${appName}`
      : callerName;
    const body = `${callerName} iniciou uma chamada.`;

    if (!title || !body) {
      return null;
    }

    const options = {
      title,
      body,
      subtitle: this.appName,
      silent: false,
    };
    if (this.appId) {
      options.appID = this.appId;
    }

    const avatarPath = await this.avatarCacheService.resolveAvatarPath({
      authorId: payload.callerUserId,
      avatarUrl: payload.callerAvatarUrl,
      avatarVersion: String(payload.sentAt),
    });
    if (avatarPath) {
      options.icon = avatarPath;
      return options;
    }

    const fallbackIcon = this.getAppNotificationIcon?.();
    if (fallbackIcon) {
      options.icon = fallbackIcon;
    }
    return options;
  }

  showNotificationWithFallback(notificationOptions, openPayload) {
    if (typeof this.NotificationCtor !== "function" || !notificationOptions) {
      return false;
    }

    const showWithOptions = (options) => {
      const notification = new this.NotificationCtor(options);
      if (openPayload && this.navigationCoordinator) {
        notification.once("click", () => {
          this.navigationCoordinator.handleNotificationClick(openPayload);
        });
      }
      notification.show();
    };

    try {
      showWithOptions(notificationOptions);
      return true;
    } catch (error) {
      const hasIcon = Boolean(notificationOptions.icon);
      if (!hasIcon) {
        this.debugLog("show_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      const fallbackOptions = { ...notificationOptions };
      delete fallbackOptions.icon;

      try {
        showWithOptions(fallbackOptions);
        return true;
      } catch (fallbackError) {
        this.debugLog("show_failed", {
          reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return false;
      }
    }
  }

  buildTitle(payload) {
    const batchCount = Math.max(1, Number(payload.batchCount ?? 1));
    let baseTitle = "";
    if (batchCount > 1 && payload.conversationType !== "dm") {
      const contextLabel = sanitizeText(payload.contextLabel, MESSAGE_NOTIFICATION_MAX_CONTEXT_LENGTH);
      if (contextLabel) {
        baseTitle = contextLabel;
      }
    }
    if (!baseTitle) {
      baseTitle = sanitizeText(payload.authorName, MESSAGE_NOTIFICATION_MAX_AUTHOR_NAME_LENGTH) || "Nova mensagem";
    }

    const appName = sanitizeText(this.appName, 40);
    if (!appName) {
      return baseTitle;
    }

    if (baseTitle.toLowerCase().includes(appName.toLowerCase())) {
      return baseTitle;
    }
    return `${baseTitle} • ${appName}`;
  }

  buildBody(payload) {
    const batchCount = Math.max(1, Number(payload.batchCount ?? 1));
    const normalizedContext = sanitizeText(payload.contextLabel, MESSAGE_NOTIFICATION_MAX_CONTEXT_LENGTH);
    const preview =
      sanitizeText(payload.contentPreview, MESSAGE_NOTIFICATION_MAX_PREVIEW_LENGTH) || resolveAttachmentFallback(payload);

    if (batchCount > 1) {
      if (normalizedContext) {
        return `${batchCount} novas mensagens em ${normalizedContext}`;
      }
      return `${batchCount} novas mensagens`;
    }

    if (payload.conversationType === "dm") {
      return preview;
    }

    if (normalizedContext) {
      return `${normalizedContext}: ${preview}`;
    }
    return preview;
  }
}

module.exports = {
  createNotificationManager,
  normalizeMessageNotificationPayload,
  normalizeVoiceCallNotificationPayload,
};
