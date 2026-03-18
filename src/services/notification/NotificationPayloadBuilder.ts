import type { NotificationEntity } from "../../stores/entities";

const PREVIEW_MAX_LENGTH = 180;
const AUTHOR_MAX_LENGTH = 80;
const CONTEXT_MAX_LENGTH = 90;

function stripHtml(rawValue: string): string {
  return rawValue.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(rawValue: string): string {
  return rawValue.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeText(rawValue: unknown, maxLength: number): string {
  const source = normalizeWhitespace(stripHtml(String(rawValue ?? "")));
  if (!source) {
    return "";
  }
  return source.slice(0, Math.max(1, Math.floor(maxLength)));
}

function resolveFallbackPreview(notification: NotificationEntity): string {
  const attachmentCount = Math.max(0, Number(notification.attachmentCount ?? 0));
  if (attachmentCount > 1) {
    return `📎 Enviou ${attachmentCount} anexos`;
  }

  const normalizedMessageType = String(notification.messageType ?? "").trim().toLowerCase();
  const normalizedMime = String(notification.attachmentMimeType ?? "").trim().toLowerCase();
  if (normalizedMessageType === "image" || normalizedMime.startsWith("image/")) {
    return "📷 Enviou uma imagem";
  }
  if (normalizedMessageType === "video" || normalizedMime.startsWith("video/")) {
    return "🎥 Enviou um vídeo";
  }
  if (normalizedMime.startsWith("audio/")) {
    return "🎤 Enviou um áudio";
  }
  if (normalizedMessageType === "file") {
    if (normalizedMime.startsWith("image/")) {
      return "🖼️ Enviou uma imagem";
    }
    if (normalizedMime.startsWith("video/") || normalizedMime.startsWith("audio/")) {
      return "🎬 Enviou uma mídia";
    }
    return "📎 Enviou um arquivo";
  }
  if (normalizedMime.startsWith("image/")) {
    return "🖼️ Enviou uma imagem";
  }
  if (normalizedMime.startsWith("video/") || normalizedMime.startsWith("audio/")) {
    return "🎬 Enviou uma mídia";
  }
  return "Mensagem sem texto";
}

function normalizeConversationType(
  conversationTypeRaw: unknown,
): "dm" | "channel" | "guild" | "unknown" {
  const value = String(conversationTypeRaw ?? "").trim().toLowerCase();
  if (value === "dm" || value === "channel" || value === "guild") {
    return value;
  }
  return "unknown";
}

function normalizeMessageType(messageTypeRaw: unknown): "text" | "image" | "video" | "file" {
  const value = String(messageTypeRaw ?? "").trim().toLowerCase();
  if (value === "image" || value === "video" || value === "file") {
    return value;
  }
  return "text";
}

export class NotificationPayloadBuilder {
  build(notification: NotificationEntity): MessageNotificationPayload {
    const authorName = sanitizeText(notification.title, AUTHOR_MAX_LENGTH) || "Nova mensagem";
    const contentPreview = sanitizeText(notification.body, PREVIEW_MAX_LENGTH) || resolveFallbackPreview(notification);
    const contextLabel = sanitizeText(notification.contextLabel, CONTEXT_MAX_LENGTH);
    const conversationType = normalizeConversationType(notification.conversationType);
    const messageType = normalizeMessageType(notification.messageType);
    const attachmentMimeType = sanitizeText(notification.attachmentMimeType, 140);

    return {
      conversationId: notification.conversationId,
      messageId: notification.messageId,
      eventId: sanitizeText(notification.eventId ?? notification.id, 160) || undefined,
      authorId: notification.authorId,
      authorName,
      contentPreview,
      createdAt: notification.createdAt,
      muted: Boolean(notification.muted),
      avatarUrl: sanitizeText(notification.avatarUrl, 1_024) || undefined,
      conversationType,
      contextLabel: contextLabel || undefined,
      messageType,
      attachmentMimeType: attachmentMimeType || undefined,
      attachmentCount: Number.isFinite(Number(notification.attachmentCount))
        ? Math.max(0, Number(notification.attachmentCount))
        : undefined,
    };
  }
}
