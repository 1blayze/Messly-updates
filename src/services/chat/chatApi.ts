import { invokeEdgeJson } from "../edge/edgeClient";

export type ChatMessageType = "text" | "image" | "video" | "file" | "call_event";
export type SendableChatMessageType = Exclude<ChatMessageType, "call_event">;

export interface ReplySnapshot {
  author_id?: string | null;
  author_name?: string | null;
  author_avatar?: string | null;
  snippet?: string | null;
  message_type?: string | null;
  created_at?: string | null;
}

export interface ChatAttachmentMetadata {
  fileKey: string;
  originalKey?: string | null;
  thumbKey?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  thumbWidth?: number | null;
  thumbHeight?: number | null;
  codec?: string | null;
  durationMs?: number | null;
}

export interface ChatMessageServer {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string | null;
  content: string;
  type: ChatMessageType;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  reply_to_snapshot: ReplySnapshot | null;
  call_id: string | null;
  payload: Record<string, unknown> | null;
  attachment: ChatAttachmentMetadata | null;
}

export interface MessageListCursor {
  createdAt: string;
  id: string;
}

interface ListMessagesRequest {
  action: "list";
  conversationId: string;
  limit?: number;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
}

interface ListMessagesResponse {
  messages: ChatMessageServer[];
  nextCursor: MessageListCursor | null;
}

interface CachedInitialMessagesEntry {
  conversationId: string;
  response: ListMessagesResponse;
  cachedAt: number;
}

interface CachedInitialMessagesPayload {
  version: number;
  entries: CachedInitialMessagesEntry[];
}

interface SendMessageRequest {
  action: "send";
  conversationId: string;
  clientId: string;
  content?: string | null;
  type: SendableChatMessageType;
  replyToId?: string | null;
  replyToSnapshot?: ReplySnapshot | null;
  attachment?: ChatAttachmentMetadata | null;
}

interface EditMessageRequest {
  action: "edit";
  messageId: string;
  content: string;
}

interface DeleteMessageRequest {
  action: "delete";
  messageId: string;
}

interface MessageMutationResponse {
  message: ChatMessageServer;
}

const FUNCTION_NAME = "chat-messages";
const INITIAL_MESSAGES_CACHE_KEY = "messly:chat-initial-messages:v1";
const INITIAL_MESSAGES_CACHE_VERSION = 1;
const INITIAL_MESSAGES_CACHE_TTL_MS = 5 * 60_000;
const INITIAL_MESSAGES_CACHE_MAX_ENTRIES = 24;
const initialMessagesCache = new Map<string, CachedInitialMessagesEntry>();
const initialMessagesInFlight = new Map<string, Promise<ListMessagesResponse>>();
let initialMessagesCacheHydrated = false;

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cloneChatAttachment(attachment: ChatAttachmentMetadata | null): ChatAttachmentMetadata | null {
  if (!attachment) {
    return null;
  }

  return {
    fileKey: attachment.fileKey,
    originalKey: attachment.originalKey ?? null,
    thumbKey: attachment.thumbKey ?? null,
    mimeType: attachment.mimeType ?? null,
    fileSize: attachment.fileSize ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    thumbWidth: attachment.thumbWidth ?? null,
    thumbHeight: attachment.thumbHeight ?? null,
    codec: attachment.codec ?? null,
    durationMs: attachment.durationMs ?? null,
  };
}

function cloneChatMessage(message: ChatMessageServer): ChatMessageServer {
  const replySnapshot = toOptionalObject(message.reply_to_snapshot);
  const messagePayload = toOptionalObject(message.payload);

  return {
    id: message.id,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    client_id: message.client_id ?? null,
    content: message.content,
    type: message.type,
    created_at: message.created_at,
    edited_at: message.edited_at ?? null,
    deleted_at: message.deleted_at ?? null,
    reply_to_id: message.reply_to_id ?? null,
    reply_to_snapshot: replySnapshot ? { ...(replySnapshot as ReplySnapshot) } : null,
    call_id: message.call_id ?? null,
    payload: messagePayload ? { ...messagePayload } : null,
    attachment: cloneChatAttachment(message.attachment),
  };
}

function cloneListMessagesResponse(response: ListMessagesResponse): ListMessagesResponse {
  return {
    messages: (response.messages ?? []).map(cloneChatMessage),
    nextCursor: response.nextCursor ? { ...response.nextCursor } : null,
  };
}

function hydrateInitialMessagesCacheFromStorage(): void {
  if (initialMessagesCacheHydrated) {
    return;
  }

  initialMessagesCacheHydrated = true;

  if (typeof window === "undefined") {
    return;
  }

  try {
    const raw = window.localStorage.getItem(INITIAL_MESSAGES_CACHE_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as CachedInitialMessagesPayload | null;
    if (!parsed || parsed.version !== INITIAL_MESSAGES_CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }

    for (const entry of parsed.entries) {
      const conversationId = String(entry?.conversationId ?? "").trim();
      if (!conversationId || !entry?.response || !Array.isArray(entry.response.messages)) {
        continue;
      }

      initialMessagesCache.set(conversationId, {
        conversationId,
        response: cloneListMessagesResponse(entry.response),
        cachedAt: Number.isFinite(entry.cachedAt) ? Number(entry.cachedAt) : Date.now(),
      });
    }
  } catch {
    // ignore local cache parse failures
  }
}

function persistInitialMessagesCacheToStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const entries = Array.from(initialMessagesCache.values())
      .slice(-INITIAL_MESSAGES_CACHE_MAX_ENTRIES)
      .map((entry) => ({
        conversationId: entry.conversationId,
        response: cloneListMessagesResponse(entry.response),
        cachedAt: entry.cachedAt,
      }));

    const payload: CachedInitialMessagesPayload = {
      version: INITIAL_MESSAGES_CACHE_VERSION,
      entries,
    };

    window.localStorage.setItem(INITIAL_MESSAGES_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore local cache write failures
  }
}

function writeInitialMessagesCache(conversationId: string, response: ListMessagesResponse): void {
  hydrateInitialMessagesCacheFromStorage();

  initialMessagesCache.delete(conversationId);
  initialMessagesCache.set(conversationId, {
    conversationId,
    response: cloneListMessagesResponse(response),
    cachedAt: Date.now(),
  });

  while (initialMessagesCache.size > INITIAL_MESSAGES_CACHE_MAX_ENTRIES) {
    const oldestKey = initialMessagesCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    initialMessagesCache.delete(oldestKey);
  }

  persistInitialMessagesCacheToStorage();
}

function readInitialMessagesCache(conversationId: string, maxAgeMs = INITIAL_MESSAGES_CACHE_TTL_MS): ListMessagesResponse | null {
  hydrateInitialMessagesCacheFromStorage();

  const entry = initialMessagesCache.get(conversationId);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.cachedAt > Math.max(1_000, maxAgeMs)) {
    initialMessagesCache.delete(conversationId);
    persistInitialMessagesCacheToStorage();
    return null;
  }

  // Keep recent entries at the tail for LRU eviction.
  initialMessagesCache.delete(conversationId);
  initialMessagesCache.set(conversationId, entry);

  return cloneListMessagesResponse(entry.response);
}

export function getCachedInitialChatMessages(conversationId: string, maxAgeMs = INITIAL_MESSAGES_CACHE_TTL_MS): ListMessagesResponse | null {
  return readInitialMessagesCache(conversationId, maxAgeMs);
}

export async function preloadChatMessages(params: {
  conversationId: string;
  limit?: number;
  maxAgeMs?: number;
  force?: boolean;
}): Promise<ListMessagesResponse | null> {
  const conversationId = String(params.conversationId ?? "").trim();
  if (!conversationId) {
    return null;
  }

  const maxAgeMs = Number.isFinite(params.maxAgeMs) ? Number(params.maxAgeMs) : 60_000;
  if (!params.force) {
    const cached = getCachedInitialChatMessages(conversationId, maxAgeMs);
    if (cached) {
      return cached;
    }
  }

  const inFlight = initialMessagesInFlight.get(conversationId);
  if (inFlight) {
    try {
      return await inFlight;
    } catch {
      return null;
    }
  }

  const request = listChatMessages({
    conversationId,
    limit: Number.isFinite(params.limit) ? Number(params.limit) : 30,
  }).finally(() => {
    initialMessagesInFlight.delete(conversationId);
  });

  initialMessagesInFlight.set(conversationId, request);

  try {
    return await request;
  } catch {
    return null;
  }
}

export async function listChatMessages(params: {
  conversationId: string;
  limit?: number;
  cursor?: MessageListCursor | null;
}): Promise<ListMessagesResponse> {
  const payload: ListMessagesRequest = {
    action: "list",
    conversationId: params.conversationId,
    limit: params.limit,
    cursorCreatedAt: params.cursor?.createdAt ?? null,
    cursorId: params.cursor?.id ?? null,
  };

  const response = await invokeEdgeJson<ListMessagesRequest, ListMessagesResponse>(FUNCTION_NAME, payload, {
    retries: 1,
    timeoutMs: 20_000,
  });

  if (!params.cursor) {
    writeInitialMessagesCache(params.conversationId, response);
  }

  return response;
}

export async function sendChatMessage(payload: {
  conversationId: string;
  clientId: string;
  type: SendableChatMessageType;
  content?: string | null;
  replyToId?: string | null;
  replyToSnapshot?: ReplySnapshot | null;
  attachment?: ChatAttachmentMetadata | null;
}): Promise<ChatMessageServer> {
  const request: SendMessageRequest = {
    action: "send",
    conversationId: payload.conversationId,
    clientId: payload.clientId,
    type: payload.type,
    content: payload.content ?? null,
    replyToId: payload.replyToId ?? null,
    replyToSnapshot: payload.replyToSnapshot ?? null,
    attachment: payload.attachment ?? null,
  };

  const response = await invokeEdgeJson<SendMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
    retries: 1,
    timeoutMs: 20_000,
  });

  return response.message;
}

export async function editChatMessage(messageId: string, content: string): Promise<ChatMessageServer> {
  const request: EditMessageRequest = {
    action: "edit",
    messageId,
    content,
  };

  const response = await invokeEdgeJson<EditMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
    retries: 0,
    timeoutMs: 18_000,
  });

  return response.message;
}

export async function deleteChatMessage(messageId: string): Promise<ChatMessageServer> {
  const request: DeleteMessageRequest = {
    action: "delete",
    messageId,
  };

  const response = await invokeEdgeJson<DeleteMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
    retries: 0,
    timeoutMs: 18_000,
  });

  return response.message;
}
