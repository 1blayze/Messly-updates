import type { NotificationEntity } from "../../stores/entities";

export interface NotificationRuntimeContext {
  currentUserId: string | null;
  activeConversationId: string | null;
  isWindowFocused: boolean;
}

export interface NotificationPolicyDecision {
  allow: boolean;
  reason:
    | "allowed"
    | "invalid_payload"
    | "self_message"
    | "same_conversation_visible"
    | "stale_message";
}

const MESSAGE_STALE_LIMIT_MS = 30 * 60_000;

export class NotificationPolicyService {
  private context: NotificationRuntimeContext = {
    currentUserId: null,
    activeConversationId: null,
    isWindowFocused: true,
  };

  updateContext(next: Partial<NotificationRuntimeContext>): void {
    this.context = {
      ...this.context,
      ...next,
      currentUserId: this.normalizeIdentifier(next.currentUserId ?? this.context.currentUserId),
      activeConversationId: this.normalizeIdentifier(next.activeConversationId ?? this.context.activeConversationId),
      isWindowFocused: Boolean(next.isWindowFocused ?? this.context.isWindowFocused),
    };
  }

  shouldNotify(notification: NotificationEntity): NotificationPolicyDecision {
    const messageId = this.normalizeIdentifier(notification.messageId);
    const authorId = this.normalizeIdentifier(notification.authorId);
    const conversationId = this.normalizeIdentifier(notification.conversationId);
    if (!messageId || !conversationId) {
      return { allow: false, reason: "invalid_payload" };
    }

    const currentUserId = this.normalizeIdentifier(this.context.currentUserId);
    if (currentUserId && authorId && currentUserId === authorId) {
      return { allow: false, reason: "self_message" };
    }

    const isWindowFocused = this.context.isWindowFocused;
    const activeConversationId = this.normalizeIdentifier(this.context.activeConversationId);
    if (isWindowFocused && activeConversationId && activeConversationId === conversationId) {
      return { allow: false, reason: "same_conversation_visible" };
    }

    const createdAtMs = Date.parse(String(notification.createdAt ?? ""));
    if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > MESSAGE_STALE_LIMIT_MS) {
      return { allow: false, reason: "stale_message" };
    }

    return { allow: true, reason: "allowed" };
  }

  getContext(): NotificationRuntimeContext {
    return { ...this.context };
  }

  private normalizeIdentifier(value: unknown): string | null {
    const normalized = String(value ?? "").trim();
    return normalized || null;
  }
}
