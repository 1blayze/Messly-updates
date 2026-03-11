import { authService } from "../auth";
import {
  readChatInitialSnapshotsCache,
  trimChatInitialSnapshotsCache,
  writeChatInitialSnapshotCache,
} from "../../cache/repositories";
import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";
import { markRuntimePerf, measureRuntimePerf } from "../observability/runtimePerformance";
import { supabase } from "../supabase";
import { getRuntimeAppApiUrl, getRuntimeAuthApiUrl, getRuntimeGatewayUrl } from "../../config/runtimeApiConfig";

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

export interface ChatMessagePayload {
  fileName?: string | null;
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
  payload?: ChatMessagePayload | null;
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

interface DirectMessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string | null;
  content: string | null;
  type: ChatMessageType;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  reply_to_snapshot: ReplySnapshot | null;
  call_id: string | null;
  payload: Record<string, unknown> | null;
}

interface DirectAttachmentRow {
  message_id: string;
  file_key: string;
  original_key: string | null;
  thumb_key: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  thumb_width: number | null;
  thumb_height: number | null;
  codec: string | null;
  duration_ms: number | null;
}

const FUNCTION_NAME = "chat-messages";
const DIRECT_MESSAGE_SELECT_COLUMNS =
  "id,conversation_id,sender_id,client_id,content,type,created_at,edited_at,deleted_at,reply_to_id,reply_to_snapshot,call_id,payload";
const DIRECT_ATTACHMENT_SELECT_COLUMNS =
  "message_id,file_key,original_key,thumb_key,mime_type,file_size,width,height,thumb_width,thumb_height,codec,duration_ms";
const INITIAL_MESSAGES_CACHE_KEY = "messly:chat-initial-messages:v1";
const INITIAL_MESSAGES_CACHE_VERSION = 1;
const INITIAL_MESSAGES_CACHE_TTL_MS = 5 * 60_000;
const INITIAL_MESSAGES_CACHE_MAX_ENTRIES = 24;
const INITIAL_MESSAGES_PERSIST_MAX_ENTRIES = 18;
const INITIAL_MESSAGES_PERSIST_TTL_MS = 30 * 60_000;
const INITIAL_MESSAGES_PERSIST_DEBOUNCE_MS = 450;
const INITIAL_MESSAGES_UNAUTHORIZED_COOLDOWN_MS = 15_000;
const EDGE_LIST_MESSAGES_UNAUTHORIZED_BYPASS_MS = 5 * 60_000;
const EDGE_SEND_MESSAGES_UNAUTHORIZED_BYPASS_MS = 5 * 60_000;
const EDGE_DELETE_MESSAGES_UNAUTHORIZED_BYPASS_MS = 5 * 60_000;
const EDGE_CHAT_MESSAGES_UNAUTHORIZED_BYPASS_STORAGE_KEY = "messly:chat-edge-bypass-until";
const EDIT_WINDOW_MINUTES = 15;
const EDIT_WINDOW_MS = EDIT_WINDOW_MINUTES * 60 * 1000;
const DELETE_WINDOW_HOURS = 24;
const DELETE_WINDOW_MS = DELETE_WINDOW_HOURS * 60 * 60 * 1000;
const initialMessagesCache = new Map<string, CachedInitialMessagesEntry>();
const initialMessagesInFlight = new Map<string, Promise<ListMessagesResponse>>();
const initialMessagesUnauthorizedCooldown = new Map<string, number>();
const initialMessagesPersistTimers = new Map<string, number>();
let globalInitialMessagesUnauthorizedCooldownUntil = 0;
let initialMessagesCacheHydratedAccountId: string | null = null;
let edgeListMessagesUnauthorizedBypassUntil = 0;
let edgeSendMessagesUnauthorizedBypassUntil = 0;
let edgeDeleteMessagesUnauthorizedBypassUntil = 0;
let initialMessagesCacheAccountId = "guest";
let initialMessagesPersistentWarmupAccountId: string | null = null;
let initialMessagesPersistentWarmupPromise: Promise<void> | null = null;
let edgeChatMessagesUnauthorizedBypassUntil = 0;
let edgeChatMessagesUnauthorizedBypassHydrated = false;

export interface SendChatMessageInput {
  conversationId: string;
  clientId: string;
  type: SendableChatMessageType;
  content?: string | null;
  replyToId?: string | null;
  replyToSnapshot?: ReplySnapshot | null;
  attachment?: ChatAttachmentMetadata | null;
  payload?: ChatMessagePayload | null;
}

function normalizeCacheAccountId(accountIdRaw: string | null | undefined): string {
  return String(accountIdRaw ?? "").trim() || "guest";
}

function getInitialMessagesStorageKey(accountId: string): string {
  return `${INITIAL_MESSAGES_CACHE_KEY}:${normalizeCacheAccountId(accountId)}`;
}

function clearInitialMessagesPersistTimers(): void {
  if (typeof window === "undefined") {
    initialMessagesPersistTimers.clear();
    return;
  }

  initialMessagesPersistTimers.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  initialMessagesPersistTimers.clear();
}

export function setChatMessagesCacheAccountScope(accountIdRaw: string | null | undefined): void {
  const normalizedAccountId = normalizeCacheAccountId(accountIdRaw);
  if (normalizedAccountId === initialMessagesCacheAccountId) {
    return;
  }

  initialMessagesCacheAccountId = normalizedAccountId;
  initialMessagesCache.clear();
  initialMessagesInFlight.clear();
  initialMessagesUnauthorizedCooldown.clear();
  globalInitialMessagesUnauthorizedCooldownUntil = 0;
  initialMessagesCacheHydratedAccountId = null;
  initialMessagesPersistentWarmupAccountId = null;
  initialMessagesPersistentWarmupPromise = null;
  clearInitialMessagesPersistTimers();
}

function isUnauthorizedChatMessagesError(error: unknown): boolean {
  if (error instanceof EdgeFunctionError) {
    if (error.status === 401) {
      return true;
    }
    const code = String(error.code ?? "").trim().toUpperCase();
    const message = String(error.message ?? "").trim().toLowerCase();
    return (
      code === "UNAUTHENTICATED" ||
      code === "INVALID_TOKEN" ||
      code === "UNAUTHORIZED" ||
      message.includes("invalid jwt") ||
      message.includes("sessao invalida") ||
      message.includes("sessão inválida") ||
      message.includes("token") && message.includes("expir")
    );
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();
  const statusText = String((error as { name?: unknown } | null)?.name ?? "").trim().toLowerCase();

  return (
    status === 401 ||
    code === "UNAUTHORIZED" ||
    code === "INVALID_TOKEN" ||
    statusText.includes("jwt") ||
    message.includes("invalid jwt") ||
    message.includes("sessão inválida") ||
    message.includes("sessao invalida") ||
    (message.includes("token") && message.includes("expir"))
  );
}

function shouldPreferDirectChatAccess(): boolean {
  if (isEdgeChatMessagesUnauthorizedBypassActive()) {
    return true;
  }

  if (typeof window === "undefined" || !window.electronAPI) {
    return false;
  }

  const explicitAppApiUrl = String(import.meta.env.VITE_MESSLY_API_URL ?? "").trim();
  const explicitAuthApiUrl = String(import.meta.env.VITE_MESSLY_AUTH_API_URL ?? "").trim();
  const explicitGatewayUrl = String(import.meta.env.VITE_MESSLY_GATEWAY_URL ?? "").trim();

  return (
    !explicitAppApiUrl &&
    !explicitAuthApiUrl &&
    !explicitGatewayUrl &&
    !getRuntimeAppApiUrl() &&
    !getRuntimeAuthApiUrl() &&
    !getRuntimeGatewayUrl()
  );
}

function hydrateEdgeChatMessagesUnauthorizedBypass(): void {
  if (edgeChatMessagesUnauthorizedBypassHydrated || typeof window === "undefined") {
    return;
  }

  edgeChatMessagesUnauthorizedBypassHydrated = true;
  try {
    const raw = Number(window.localStorage.getItem(EDGE_CHAT_MESSAGES_UNAUTHORIZED_BYPASS_STORAGE_KEY) ?? NaN);
    if (Number.isFinite(raw) && raw > Date.now()) {
      edgeChatMessagesUnauthorizedBypassUntil = raw;
    } else {
      window.localStorage.removeItem(EDGE_CHAT_MESSAGES_UNAUTHORIZED_BYPASS_STORAGE_KEY);
    }
  } catch {
    edgeChatMessagesUnauthorizedBypassUntil = 0;
  }
}

function persistEdgeChatMessagesUnauthorizedBypass(until: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (until > Date.now()) {
      window.localStorage.setItem(EDGE_CHAT_MESSAGES_UNAUTHORIZED_BYPASS_STORAGE_KEY, String(until));
      return;
    }
    window.localStorage.removeItem(EDGE_CHAT_MESSAGES_UNAUTHORIZED_BYPASS_STORAGE_KEY);
  } catch {
    // ignore persistence failures
  }
}

function isEdgeChatMessagesUnauthorizedBypassActive(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }

  hydrateEdgeChatMessagesUnauthorizedBypass();
  if (edgeChatMessagesUnauthorizedBypassUntil <= 0) {
    return false;
  }

  if (edgeChatMessagesUnauthorizedBypassUntil <= Date.now()) {
    edgeChatMessagesUnauthorizedBypassUntil = 0;
    persistEdgeChatMessagesUnauthorizedBypass(0);
    return false;
  }

  return true;
}

function activateEdgeChatMessagesUnauthorizedBypass(durationMs: number): void {
  const duration = Number.isFinite(durationMs) ? Math.max(10_000, Math.trunc(durationMs)) : EDGE_LIST_MESSAGES_UNAUTHORIZED_BYPASS_MS;
  const nextUntil = Date.now() + duration;
  if (nextUntil > edgeChatMessagesUnauthorizedBypassUntil) {
    edgeChatMessagesUnauthorizedBypassUntil = nextUntil;
  }
  persistEdgeChatMessagesUnauthorizedBypass(edgeChatMessagesUnauthorizedBypassUntil);
}

function clearEdgeChatMessagesUnauthorizedBypass(): void {
  edgeChatMessagesUnauthorizedBypassUntil = 0;
  persistEdgeChatMessagesUnauthorizedBypass(0);
}

function getInitialMessagesCooldownUntil(conversationId: string): number {
  return initialMessagesUnauthorizedCooldown.get(conversationId) ?? 0;
}

function isInitialMessagesCooldownActive(conversationId: string): boolean {
  if (globalInitialMessagesUnauthorizedCooldownUntil > 0) {
    if (globalInitialMessagesUnauthorizedCooldownUntil <= Date.now()) {
      globalInitialMessagesUnauthorizedCooldownUntil = 0;
    } else {
      return true;
    }
  }

  const cooldownUntil = getInitialMessagesCooldownUntil(conversationId);
  if (!cooldownUntil) {
    return false;
  }

  if (cooldownUntil <= Date.now()) {
    initialMessagesUnauthorizedCooldown.delete(conversationId);
    return false;
  }

  return true;
}

function markInitialMessagesUnauthorizedCooldown(conversationId: string): void {
  initialMessagesUnauthorizedCooldown.set(conversationId, Date.now() + INITIAL_MESSAGES_UNAUTHORIZED_COOLDOWN_MS);
  globalInitialMessagesUnauthorizedCooldownUntil = Date.now() + INITIAL_MESSAGES_UNAUTHORIZED_COOLDOWN_MS;
}

function clearInitialMessagesUnauthorizedCooldown(conversationId: string): void {
  initialMessagesUnauthorizedCooldown.delete(conversationId);
  globalInitialMessagesUnauthorizedCooldownUntil = 0;
}

function isEdgeListMessagesUnauthorizedBypassActive(): boolean {
  return isEdgeChatMessagesUnauthorizedBypassActive();
}

function activateEdgeListMessagesUnauthorizedBypass(): void {
  edgeListMessagesUnauthorizedBypassUntil = Date.now() + EDGE_LIST_MESSAGES_UNAUTHORIZED_BYPASS_MS;
  activateEdgeChatMessagesUnauthorizedBypass(EDGE_LIST_MESSAGES_UNAUTHORIZED_BYPASS_MS);
}

function clearEdgeListMessagesUnauthorizedBypass(): void {
  edgeListMessagesUnauthorizedBypassUntil = 0;
  if (edgeSendMessagesUnauthorizedBypassUntil <= Date.now() && edgeDeleteMessagesUnauthorizedBypassUntil <= Date.now()) {
    clearEdgeChatMessagesUnauthorizedBypass();
  }
}

function isEdgeSendMessagesUnauthorizedBypassActive(): boolean {
  return isEdgeChatMessagesUnauthorizedBypassActive();
}

function activateEdgeSendMessagesUnauthorizedBypass(): void {
  edgeSendMessagesUnauthorizedBypassUntil = Date.now() + EDGE_SEND_MESSAGES_UNAUTHORIZED_BYPASS_MS;
  activateEdgeChatMessagesUnauthorizedBypass(EDGE_SEND_MESSAGES_UNAUTHORIZED_BYPASS_MS);
}

function clearEdgeSendMessagesUnauthorizedBypass(): void {
  edgeSendMessagesUnauthorizedBypassUntil = 0;
  if (edgeListMessagesUnauthorizedBypassUntil <= Date.now() && edgeDeleteMessagesUnauthorizedBypassUntil <= Date.now()) {
    clearEdgeChatMessagesUnauthorizedBypass();
  }
}

function isEdgeDeleteMessagesUnauthorizedBypassActive(): boolean {
  return isEdgeChatMessagesUnauthorizedBypassActive();
}

function activateEdgeDeleteMessagesUnauthorizedBypass(): void {
  edgeDeleteMessagesUnauthorizedBypassUntil = Date.now() + EDGE_DELETE_MESSAGES_UNAUTHORIZED_BYPASS_MS;
  activateEdgeChatMessagesUnauthorizedBypass(EDGE_DELETE_MESSAGES_UNAUTHORIZED_BYPASS_MS);
}

function clearEdgeDeleteMessagesUnauthorizedBypass(): void {
  edgeDeleteMessagesUnauthorizedBypassUntil = 0;
  if (edgeListMessagesUnauthorizedBypassUntil <= Date.now() && edgeSendMessagesUnauthorizedBypassUntil <= Date.now()) {
    clearEdgeChatMessagesUnauthorizedBypass();
  }
}

function isFallbackEligibleChatMessagesError(error: unknown): boolean {
  return (
    error instanceof EdgeFunctionError &&
    (error.status === 404 || error.code === "EDGE_NETWORK_ERROR")
  );
}

function createUnauthenticatedChatMessagesError(): EdgeFunctionError {
  return new EdgeFunctionError("Sessao invalida ou expirada.", 401, "UNAUTHENTICATED");
}

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mapDirectMessageRow(
  row: DirectMessageRow,
  attachment: DirectAttachmentRow | null,
): ChatMessageServer {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    client_id: row.client_id ?? null,
    content: String(row.content ?? ""),
    type: row.type,
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
    deleted_at: row.deleted_at ?? null,
    reply_to_id: row.reply_to_id ?? null,
    reply_to_snapshot: row.reply_to_snapshot ?? null,
    call_id: row.call_id ?? null,
    payload: row.payload ?? null,
    attachment: attachment
      ? {
          fileKey: attachment.file_key,
          originalKey: attachment.original_key ?? null,
          thumbKey: attachment.thumb_key ?? null,
          mimeType: attachment.mime_type ?? null,
          fileSize: attachment.file_size ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          thumbWidth: attachment.thumb_width ?? null,
          thumbHeight: attachment.thumb_height ?? null,
          codec: attachment.codec ?? null,
          durationMs: attachment.duration_ms ?? null,
        }
      : null,
  };
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

function toNullableTrimmedString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function toNullableFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeChatMessageType(value: unknown): ChatMessageType {
  const normalized = String(value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "image":
    case "video":
    case "file":
    case "call_event":
      return normalized;
    case "text":
    default:
      return "text";
  }
}

function normalizeMessageCursor(value: unknown): MessageListCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const cursor = value as Record<string, unknown>;
  const createdAt = toNullableTrimmedString(cursor.createdAt);
  const id = toNullableTrimmedString(cursor.id);
  if (!createdAt || !id) {
    return null;
  }

  return {
    createdAt,
    id,
  };
}

function normalizeChatAttachment(value: unknown): ChatAttachmentMetadata | null {
  const attachment = toOptionalObject(value);
  if (!attachment) {
    return null;
  }

  const fileKey = toNullableTrimmedString(attachment.fileKey);
  if (!fileKey) {
    return null;
  }

  return {
    fileKey,
    originalKey: toNullableTrimmedString(attachment.originalKey),
    thumbKey: toNullableTrimmedString(attachment.thumbKey),
    mimeType: toNullableTrimmedString(attachment.mimeType),
    fileSize: toNullableFiniteNumber(attachment.fileSize),
    width: toNullableFiniteNumber(attachment.width),
    height: toNullableFiniteNumber(attachment.height),
    thumbWidth: toNullableFiniteNumber(attachment.thumbWidth),
    thumbHeight: toNullableFiniteNumber(attachment.thumbHeight),
    codec: toNullableTrimmedString(attachment.codec),
    durationMs: toNullableFiniteNumber(attachment.durationMs),
  };
}

function normalizeReplySnapshot(value: unknown): ReplySnapshot | null {
  const snapshot = toOptionalObject(value);
  if (!snapshot) {
    return null;
  }

  const normalized: ReplySnapshot = {};
  const authorId = toNullableTrimmedString(snapshot.author_id);
  const authorName = toNullableTrimmedString(snapshot.author_name);
  const authorAvatar = toNullableTrimmedString(snapshot.author_avatar);
  const snippet = toNullableTrimmedString(snapshot.snippet);
  const messageType = toNullableTrimmedString(snapshot.message_type);
  const createdAt = toNullableTrimmedString(snapshot.created_at);

  if (authorId) {
    normalized.author_id = authorId;
  }
  if (authorName) {
    normalized.author_name = authorName;
  }
  if (authorAvatar) {
    normalized.author_avatar = authorAvatar;
  }
  if (snippet) {
    normalized.snippet = snippet;
  }
  if (messageType) {
    normalized.message_type = messageType;
  }
  if (createdAt) {
    normalized.created_at = createdAt;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function toSerializableChatMessageRecord(message: ChatMessageServer): Record<string, unknown> {
  return {
    ...cloneChatMessage(message),
  };
}

function toSerializableListMessagesResponse(
  response: ListMessagesResponse,
): { messages: Array<Record<string, unknown>>; nextCursor: MessageListCursor | null } {
  const cloned = cloneListMessagesResponse(response);
  return {
    messages: cloned.messages.map(toSerializableChatMessageRecord),
    nextCursor: cloned.nextCursor ? { ...cloned.nextCursor } : null,
  };
}

function deserializeCachedChatMessage(value: unknown): ChatMessageServer | null {
  const message = toOptionalObject(value);
  if (!message) {
    return null;
  }

  const id = toNullableTrimmedString(message.id);
  const conversationId = toNullableTrimmedString(message.conversation_id);
  const senderId = toNullableTrimmedString(message.sender_id);
  const createdAt = toNullableTrimmedString(message.created_at);
  if (!id || !conversationId || !senderId || !createdAt) {
    return null;
  }

  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    client_id: toNullableTrimmedString(message.client_id),
    content: typeof message.content === "string" ? message.content : String(message.content ?? ""),
    type: normalizeChatMessageType(message.type),
    created_at: createdAt,
    edited_at: toNullableTrimmedString(message.edited_at),
    deleted_at: toNullableTrimmedString(message.deleted_at),
    reply_to_id: toNullableTrimmedString(message.reply_to_id),
    reply_to_snapshot: normalizeReplySnapshot(message.reply_to_snapshot),
    call_id: toNullableTrimmedString(message.call_id),
    payload: toOptionalObject(message.payload),
    attachment: normalizeChatAttachment(message.attachment),
  };
}

function deserializeCachedListMessagesResponse(value: unknown): ListMessagesResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const response = value as Record<string, unknown>;
  const rawMessages = Array.isArray(response.messages) ? response.messages : [];
  const messages: ChatMessageServer[] = [];

  for (const item of rawMessages) {
    const normalized = deserializeCachedChatMessage(item);
    if (normalized) {
      messages.push(normalized);
    }
  }

  return {
    messages,
    nextCursor: normalizeMessageCursor(response.nextCursor),
  };
}

function parseCachedInitialMessagesPayload(raw: string): CachedInitialMessagesEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const payload = parsed as Record<string, unknown>;
  if (Number(payload.version) !== INITIAL_MESSAGES_CACHE_VERSION || !Array.isArray(payload.entries)) {
    return [];
  }

  const normalizedEntries: CachedInitialMessagesEntry[] = [];
  for (const item of payload.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const conversationId = toNullableTrimmedString(entry.conversationId);
    if (!conversationId) {
      continue;
    }

    const response = deserializeCachedListMessagesResponse(entry.response);
    if (!response) {
      continue;
    }

    const cachedAt = toNullableFiniteNumber(entry.cachedAt) ?? Date.now();
    normalizedEntries.push({
      conversationId,
      response,
      cachedAt,
    });
  }

  return normalizedEntries;
}

function hydrateInitialMessagesCacheFromStorage(): void {
  const accountId = normalizeCacheAccountId(initialMessagesCacheAccountId);
  if (initialMessagesCacheHydratedAccountId === accountId) {
    return;
  }

  initialMessagesCacheHydratedAccountId = accountId;

  if (typeof window === "undefined") {
    return;
  }

  const scopedStorageKey = getInitialMessagesStorageKey(accountId);

  try {
    const entryMap = new Map<string, CachedInitialMessagesEntry>();
    const scopedRaw = window.localStorage.getItem(scopedStorageKey);
    const scopedEntries = scopedRaw ? parseCachedInitialMessagesPayload(scopedRaw) : [];
    for (const entry of scopedEntries) {
      entryMap.set(entry.conversationId, entry);
    }

    if (entryMap.size === 0) {
      const legacyRaw = window.localStorage.getItem(INITIAL_MESSAGES_CACHE_KEY);
      const legacyEntries = legacyRaw ? parseCachedInitialMessagesPayload(legacyRaw) : [];
      for (const entry of legacyEntries) {
        const current = entryMap.get(entry.conversationId);
        if (!current || entry.cachedAt > current.cachedAt) {
          entryMap.set(entry.conversationId, entry);
        }
      }
    }

    const mergedEntries = Array.from(entryMap.values())
      .sort((left, right) => Number(left.cachedAt ?? 0) - Number(right.cachedAt ?? 0))
      .slice(-INITIAL_MESSAGES_CACHE_MAX_ENTRIES);

    for (const entry of mergedEntries) {
      if (Date.now() - entry.cachedAt > INITIAL_MESSAGES_PERSIST_TTL_MS) {
        continue;
      }

      initialMessagesCache.set(entry.conversationId, {
        conversationId: entry.conversationId,
        response: cloneListMessagesResponse(entry.response),
        cachedAt: Number(entry.cachedAt) || Date.now(),
      });
    }

    if (entryMap.size > 0) {
      const payload: CachedInitialMessagesPayload = {
        version: INITIAL_MESSAGES_CACHE_VERSION,
        entries: mergedEntries.map((entry) => ({
          conversationId: entry.conversationId,
          response: cloneListMessagesResponse(entry.response),
          cachedAt: entry.cachedAt,
        })),
      };
      window.localStorage.setItem(scopedStorageKey, JSON.stringify(payload));
    }

    if (scopedStorageKey !== INITIAL_MESSAGES_CACHE_KEY) {
      window.localStorage.removeItem(INITIAL_MESSAGES_CACHE_KEY);
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
    const accountId = normalizeCacheAccountId(initialMessagesCacheAccountId);
    const storageKey = getInitialMessagesStorageKey(accountId);
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

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    if (storageKey !== INITIAL_MESSAGES_CACHE_KEY) {
      window.localStorage.removeItem(INITIAL_MESSAGES_CACHE_KEY);
    }
  } catch {
    // ignore local cache write failures
  }
}

function persistInitialMessagesSnapshotDebounced(conversationIdRaw: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const conversationId = String(conversationIdRaw ?? "").trim();
  if (!conversationId) {
    return;
  }

  const existingTimer = initialMessagesPersistTimers.get(conversationId);
  if (typeof existingTimer === "number") {
    window.clearTimeout(existingTimer);
  }

  const accountIdAtSchedule = normalizeCacheAccountId(initialMessagesCacheAccountId);
  const timerId = window.setTimeout(() => {
    initialMessagesPersistTimers.delete(conversationId);

    if (accountIdAtSchedule !== normalizeCacheAccountId(initialMessagesCacheAccountId)) {
      return;
    }

    const cacheEntry = initialMessagesCache.get(conversationId);
    if (!cacheEntry) {
      return;
    }

    const serializable = toSerializableListMessagesResponse(cacheEntry.response);
    void writeChatInitialSnapshotCache(accountIdAtSchedule, conversationId, {
      messages: serializable.messages,
      nextCursor: serializable.nextCursor,
      updatedAtMs: cacheEntry.cachedAt,
    })
      .then(() =>
        trimChatInitialSnapshotsCache(accountIdAtSchedule, {
          maxEntries: INITIAL_MESSAGES_PERSIST_MAX_ENTRIES,
          minUpdatedAtMs: Date.now() - INITIAL_MESSAGES_PERSIST_TTL_MS,
        }),
      )
      .catch(() => undefined);
  }, INITIAL_MESSAGES_PERSIST_DEBOUNCE_MS);

  initialMessagesPersistTimers.set(conversationId, timerId);
}

export async function primeInitialChatCacheForStartup(options: {
  accountId?: string | null;
  maxEntries?: number;
  maxAgeMs?: number;
} = {}): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const accountId = normalizeCacheAccountId(options.accountId ?? initialMessagesCacheAccountId);
  if (accountId !== normalizeCacheAccountId(initialMessagesCacheAccountId)) {
    return;
  }

  markRuntimePerf("chat:prime-cache:start", {
    accountId,
    requestedEntries: options.maxEntries ?? null,
    requestedMaxAgeMs: options.maxAgeMs ?? null,
  });

  hydrateInitialMessagesCacheFromStorage();

  if (
    initialMessagesPersistentWarmupAccountId === accountId &&
    initialMessagesPersistentWarmupPromise
  ) {
    await initialMessagesPersistentWarmupPromise;
    return;
  }

  const maxEntries = Math.max(
    1,
    Math.min(
      INITIAL_MESSAGES_CACHE_MAX_ENTRIES,
      Math.trunc(Number(options.maxEntries ?? INITIAL_MESSAGES_PERSIST_MAX_ENTRIES) || INITIAL_MESSAGES_PERSIST_MAX_ENTRIES),
    ),
  );
  const maxAgeMs = Math.max(
    1_000,
    Math.trunc(Number(options.maxAgeMs ?? INITIAL_MESSAGES_PERSIST_TTL_MS) || INITIAL_MESSAGES_PERSIST_TTL_MS),
  );
  const minUpdatedAtMs = Date.now() - maxAgeMs;

  const warmupPromise = (async () => {
    let snapshots = await readChatInitialSnapshotsCache(accountId, maxEntries).catch(() => [] as Array<{
      conversationId: string;
      messages: Array<Record<string, unknown>>;
      nextCursor: { createdAt: string; id: string } | null;
      updatedAtMs: number;
    }>);
    if (accountId !== normalizeCacheAccountId(initialMessagesCacheAccountId)) {
      return;
    }

    snapshots = snapshots
      .filter((snapshot) => Number(snapshot.updatedAtMs ?? 0) >= minUpdatedAtMs)
      .sort((left, right) => Number(left.updatedAtMs ?? 0) - Number(right.updatedAtMs ?? 0));

    for (const snapshot of snapshots) {
      const conversationId = String(snapshot.conversationId ?? "").trim();
      if (!conversationId) {
        continue;
      }

      const response = deserializeCachedListMessagesResponse({
        messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
        nextCursor: snapshot.nextCursor ?? null,
      });
      if (!response) {
        continue;
      }

      const existing = initialMessagesCache.get(conversationId);
      if (existing && Number(existing.cachedAt ?? 0) >= Number(snapshot.updatedAtMs ?? 0)) {
        continue;
      }

      initialMessagesCache.delete(conversationId);
      initialMessagesCache.set(conversationId, {
        conversationId,
        response: cloneListMessagesResponse(response),
        cachedAt: Number(snapshot.updatedAtMs ?? Date.now()) || Date.now(),
      });
    }

    while (initialMessagesCache.size > INITIAL_MESSAGES_CACHE_MAX_ENTRIES) {
      const oldestKey = initialMessagesCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      initialMessagesCache.delete(oldestKey);
    }

    persistInitialMessagesCacheToStorage();
    await trimChatInitialSnapshotsCache(accountId, {
      maxEntries: INITIAL_MESSAGES_PERSIST_MAX_ENTRIES,
      minUpdatedAtMs,
    }).catch(() => undefined);
  })();

  initialMessagesPersistentWarmupAccountId = accountId;
  initialMessagesPersistentWarmupPromise = warmupPromise;
  try {
    await warmupPromise;
  } finally {
    markRuntimePerf("chat:prime-cache:done", {
      accountId,
      cacheEntries: initialMessagesCache.size,
    });
    measureRuntimePerf(
      "chat_prime_cache_duration",
      "chat:prime-cache:start",
      "chat:prime-cache:done",
      { accountId, cacheEntries: initialMessagesCache.size },
    );

    if (initialMessagesPersistentWarmupPromise === warmupPromise) {
      initialMessagesPersistentWarmupPromise = null;
    }
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
  persistInitialMessagesSnapshotDebounced(conversationId);
}

function compareMessagesAsc(left: ChatMessageServer, right: ChatMessageServer): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function upsertCachedInitialChatMessages(
  conversationIdRaw: string,
  messages: ChatMessageServer | ChatMessageServer[],
): void {
  const conversationId = String(conversationIdRaw ?? "").trim();
  if (!conversationId) {
    return;
  }

  const incomingMessages = (Array.isArray(messages) ? messages : [messages])
    .filter((message): message is ChatMessageServer => Boolean(message))
    .map(cloneChatMessage)
    .filter((message) => String(message.conversation_id ?? "").trim() === conversationId);

  if (incomingMessages.length === 0) {
    return;
  }

  const current = readInitialMessagesCache(conversationId, Number.MAX_SAFE_INTEGER) ?? {
    messages: [],
    nextCursor: null,
  };
  const nextMessages = [...(current.messages ?? [])];
  const indexById = new Map<string, number>();
  const indexByClientId = new Map<string, number>();

  nextMessages.forEach((message, index) => {
    indexById.set(message.id, index);
    if (message.client_id) {
      indexByClientId.set(message.client_id, index);
    }
  });

  for (const incoming of incomingMessages) {
    const existingIndex = indexById.get(incoming.id) ?? (incoming.client_id ? indexByClientId.get(incoming.client_id) : undefined);
    if (typeof existingIndex === "number") {
      nextMessages[existingIndex] = {
        ...nextMessages[existingIndex],
        ...incoming,
      };
      indexById.set(nextMessages[existingIndex].id, existingIndex);
      if (nextMessages[existingIndex].client_id) {
        indexByClientId.set(nextMessages[existingIndex].client_id as string, existingIndex);
      }
      continue;
    }

    nextMessages.push(incoming);
    const addedIndex = nextMessages.length - 1;
    indexById.set(incoming.id, addedIndex);
    if (incoming.client_id) {
      indexByClientId.set(incoming.client_id, addedIndex);
    }
  }

  nextMessages.sort(compareMessagesAsc);
  writeInitialMessagesCache(conversationId, {
    messages: nextMessages,
    nextCursor: current.nextCursor ?? null,
  });
}

export function removeCachedInitialChatMessageByClientId(conversationIdRaw: string, clientIdRaw: string): void {
  const conversationId = String(conversationIdRaw ?? "").trim();
  const clientId = String(clientIdRaw ?? "").trim();
  if (!conversationId || !clientId) {
    return;
  }

  const current = readInitialMessagesCache(conversationId, Number.MAX_SAFE_INTEGER);
  if (!current || !Array.isArray(current.messages) || current.messages.length === 0) {
    return;
  }

  const nextMessages = current.messages.filter((message) => String(message.client_id ?? "").trim() !== clientId);
  if (nextMessages.length === current.messages.length) {
    return;
  }

  writeInitialMessagesCache(conversationId, {
    messages: nextMessages,
    nextCursor: current.nextCursor ?? null,
  });
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

  markRuntimePerf("chat:preload:start", {
    conversationId,
    force: Boolean(params.force),
    limit: Number.isFinite(params.limit) ? Number(params.limit) : null,
  });

  const maxAgeMs = Number.isFinite(params.maxAgeMs) ? Number(params.maxAgeMs) : 60_000;
  if (!params.force) {
    const cached = getCachedInitialChatMessages(conversationId, maxAgeMs);
    if (cached) {
      markRuntimePerf("chat:preload:done", {
        conversationId,
        source: "memory-cache",
      });
      measureRuntimePerf("chat_preload_duration", "chat:preload:start", "chat:preload:done", {
        conversationId,
        source: "memory-cache",
      });
      return cached;
    }

    await primeInitialChatCacheForStartup({
      accountId: initialMessagesCacheAccountId,
      maxEntries: INITIAL_MESSAGES_PERSIST_MAX_ENTRIES,
      maxAgeMs,
    });
    const warmCached = getCachedInitialChatMessages(conversationId, maxAgeMs);
    if (warmCached) {
      markRuntimePerf("chat:preload:done", {
        conversationId,
        source: "persistent-cache",
      });
      measureRuntimePerf("chat_preload_duration", "chat:preload:start", "chat:preload:done", {
        conversationId,
        source: "persistent-cache",
      });
      return warmCached;
    }
  }

  const inFlight = initialMessagesInFlight.get(conversationId);
  if (inFlight) {
    try {
      const response = await inFlight;
      markRuntimePerf("chat:preload:done", {
        conversationId,
        source: "in-flight",
      });
      measureRuntimePerf("chat_preload_duration", "chat:preload:start", "chat:preload:done", {
        conversationId,
        source: "in-flight",
      });
      return response;
    } catch {
      return null;
    }
  }

  if (!params.force && isInitialMessagesCooldownActive(conversationId)) {
    return null;
  }

  if (!shouldPreferDirectChatAccess()) {
    const accessToken = await authService.getValidatedEdgeAccessToken();
    if (!accessToken) {
      return null;
    }
  }

  // A sidebar prefetch and an open-triggered preload can start in the same tick.
  // Re-check in-flight after awaiting auth to dedupe that race.
  const inFlightAfterAuth = initialMessagesInFlight.get(conversationId);
  if (inFlightAfterAuth) {
    try {
      const response = await inFlightAfterAuth;
      markRuntimePerf("chat:preload:done", {
        conversationId,
        source: "in-flight",
      });
      measureRuntimePerf("chat_preload_duration", "chat:preload:start", "chat:preload:done", {
        conversationId,
        source: "in-flight",
      });
      return response;
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
    const response = await request;
    clearInitialMessagesUnauthorizedCooldown(conversationId);
    markRuntimePerf("chat:preload:done", {
      conversationId,
      source: "network",
      messageCount: response.messages.length,
    });
    measureRuntimePerf("chat_preload_duration", "chat:preload:start", "chat:preload:done", {
      conversationId,
      source: "network",
      messageCount: response.messages.length,
    });
    return response;
  } catch (error) {
    if (isUnauthorizedChatMessagesError(error)) {
      markInitialMessagesUnauthorizedCooldown(conversationId);
    }
    return null;
  }
}

export async function listChatMessages(params: {
  conversationId: string;
  limit?: number;
  cursor?: MessageListCursor | null;
}): Promise<ListMessagesResponse> {
  if (shouldPreferDirectChatAccess()) {
    const response = await listChatMessagesDirect(params);
    clearInitialMessagesUnauthorizedCooldown(params.conversationId);
    if (!params.cursor) {
      writeInitialMessagesCache(params.conversationId, response);
    }
    return response;
  }

  if (isInitialMessagesCooldownActive(params.conversationId)) {
    throw createUnauthenticatedChatMessagesError();
  }

  const accessToken = await authService.getValidatedEdgeAccessToken();
  if (!accessToken) {
    activateEdgeListMessagesUnauthorizedBypass();
    try {
      const fallbackResponse = await listChatMessagesDirect(params);
      clearInitialMessagesUnauthorizedCooldown(params.conversationId);
      if (!params.cursor) {
        writeInitialMessagesCache(params.conversationId, fallbackResponse);
      }
      return fallbackResponse;
    } catch (directError) {
      if (isUnauthorizedChatMessagesError(directError)) {
        markInitialMessagesUnauthorizedCooldown(params.conversationId);
      }
      throw directError;
    }
  }

  const payload: ListMessagesRequest = {
    action: "list",
    conversationId: params.conversationId,
    limit: params.limit,
    cursorCreatedAt: params.cursor?.createdAt ?? null,
    cursorId: params.cursor?.id ?? null,
  };

  let response: ListMessagesResponse;

  if (isEdgeListMessagesUnauthorizedBypassActive()) {
    try {
      response = await listChatMessagesDirect(params);
    } catch (directError) {
      if (isUnauthorizedChatMessagesError(directError)) {
        markInitialMessagesUnauthorizedCooldown(params.conversationId);
      }
      throw directError;
    }

    clearInitialMessagesUnauthorizedCooldown(params.conversationId);

    if (!params.cursor) {
      writeInitialMessagesCache(params.conversationId, response);
    }

    return response;
  }

  try {
    response = await invokeEdgeJson<ListMessagesRequest, ListMessagesResponse>(FUNCTION_NAME, payload, {
      requireAuth: true,
      retries: 1,
      timeoutMs: 20_000,
    });
  } catch (error) {
    if (isUnauthorizedChatMessagesError(error)) {
      activateEdgeListMessagesUnauthorizedBypass();
      try {
        response = await listChatMessagesDirect(params);
      } catch (listError) {
        if (isUnauthorizedChatMessagesError(listError)) {
          markInitialMessagesUnauthorizedCooldown(params.conversationId);
        }
        throw listError;
      }
    } else {
      if (!isFallbackEligibleChatMessagesError(error)) {
        throw error;
      }

      try {
        response = await listChatMessagesDirect(params);
      } catch (listError) {
        if (isUnauthorizedChatMessagesError(listError)) {
          markInitialMessagesUnauthorizedCooldown(params.conversationId);
        }
        throw listError;
      }
    }
  }

  clearEdgeListMessagesUnauthorizedBypass();
  clearInitialMessagesUnauthorizedCooldown(params.conversationId);

  if (!params.cursor) {
    writeInitialMessagesCache(params.conversationId, response);
  }

  return response;
}

async function listChatMessagesDirect(params: {
  conversationId: string;
  limit?: number;
  cursor?: MessageListCursor | null;
}): Promise<ListMessagesResponse> {
  const conversationId = String(params.conversationId ?? "").trim();
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(100, Number(params.limit))) : 50;

  let query = supabase
    .from("messages")
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  const cursorCreatedAt = String(params.cursor?.createdAt ?? "").trim();
  if (cursorCreatedAt) {
    query = query.lt("created_at", cursorCreatedAt);
  }

  const messagesResult = await query;
  if (messagesResult.error) {
    throw messagesResult.error;
  }

  const rows = ((messagesResult.data ?? []) as DirectMessageRow[]).slice();
  const messageIds = rows.map((row) => row.id).filter(Boolean);

  let attachmentsByMessageId = new Map<string, DirectAttachmentRow>();
  if (messageIds.length > 0) {
    const attachmentsResult = await supabase
      .from("attachments")
      .select(DIRECT_ATTACHMENT_SELECT_COLUMNS)
      .in("message_id", messageIds);

    if (attachmentsResult.error) {
      throw attachmentsResult.error;
    }

    attachmentsByMessageId = new Map(
      ((attachmentsResult.data ?? []) as DirectAttachmentRow[]).map((row) => [row.message_id, row] as const),
    );
  }

  const messages = rows
    .map((row): ChatMessageServer => mapDirectMessageRow(row, attachmentsByMessageId.get(row.id) ?? null))
    .sort(compareMessagesAsc);

  const oldestMessage = rows.length === limit ? rows[rows.length - 1] : null;
  return {
    messages,
    nextCursor: oldestMessage
      ? {
          createdAt: oldestMessage.created_at,
          id: oldestMessage.id,
        }
      : null,
  };
}

function isDirectSendFallbackCandidate(payload: SendChatMessageInput): boolean {
  return payload.type === "text" && !payload.attachment;
}

async function sendChatMessageDirect(payload: SendChatMessageInput): Promise<ChatMessageServer> {
  const conversationId = String(payload.conversationId ?? "").trim();
  const clientId = String(payload.clientId ?? "").trim();
  const content = String(payload.content ?? "").trim();
  if (!conversationId || !clientId || !content) {
    throw new EdgeFunctionError("Mensagem invalida.", 400, "INVALID_PAYLOAD");
  }

  const existingResult = await supabase
    .from("messages")
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("client_id", clientId)
    .limit(1)
    .maybeSingle();
  if (!existingResult.error && existingResult.data) {
    return mapDirectMessageRow(existingResult.data as DirectMessageRow, null);
  }

  const senderId = String(await authService.getCurrentUserId() ?? "").trim();
  if (!senderId) {
    throw createUnauthenticatedChatMessagesError();
  }

  const insertResult = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      client_id: clientId,
      content,
      type: payload.type,
      reply_to_id: payload.replyToId ?? null,
      reply_to_snapshot: payload.replyToSnapshot ?? null,
      payload: payload.payload ?? null,
    })
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .single();

  if (insertResult.error || !insertResult.data) {
    if (insertResult.error?.code === "23505") {
      const conflictResult = await supabase
        .from("messages")
        .select(DIRECT_MESSAGE_SELECT_COLUMNS)
        .eq("conversation_id", conversationId)
        .eq("client_id", clientId)
        .limit(1)
        .maybeSingle();
      if (!conflictResult.error && conflictResult.data) {
        return mapDirectMessageRow(conflictResult.data as DirectMessageRow, null);
      }
    }

    throw insertResult.error ?? new EdgeFunctionError("Falha ao enviar mensagem.", 500, "SEND_MESSAGE_FAILED");
  }

  return mapDirectMessageRow(insertResult.data as DirectMessageRow, null);
}

async function loadDirectAttachmentByMessageId(messageId: string): Promise<DirectAttachmentRow | null> {
  const attachmentResult = await supabase
    .from("attachments")
    .select(DIRECT_ATTACHMENT_SELECT_COLUMNS)
    .eq("message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (attachmentResult.error) {
    throw attachmentResult.error;
  }

  return (attachmentResult.data as DirectAttachmentRow | null) ?? null;
}

async function deleteChatMessageDirect(messageIdRaw: string): Promise<ChatMessageServer> {
  const messageId = String(messageIdRaw ?? "").trim();
  if (!messageId) {
    throw new EdgeFunctionError("Mensagem invalida.", 400, "INVALID_PAYLOAD");
  }

  const currentUserId = String(await authService.getCurrentUserId() ?? "").trim();
  if (!currentUserId) {
    throw createUnauthenticatedChatMessagesError();
  }

  const currentResult = await supabase
    .from("messages")
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .eq("id", messageId)
    .limit(1)
    .maybeSingle();

  if (currentResult.error) {
    throw currentResult.error;
  }

  const currentRow = currentResult.data as DirectMessageRow | null;
  if (!currentRow) {
    throw new EdgeFunctionError("Mensagem nao encontrada.", 404, "MESSAGE_NOT_FOUND");
  }

  if (String(currentRow.sender_id ?? "").trim() !== currentUserId) {
    throw new EdgeFunctionError("Somente o autor pode excluir a mensagem.", 403, "FORBIDDEN");
  }

  if (!currentRow.deleted_at) {
    const createdAtMs = Date.parse(String(currentRow.created_at ?? ""));
    if (!Number.isFinite(createdAtMs)) {
      throw new EdgeFunctionError("Falha ao validar o estado da mensagem.", 500, "MESSAGE_STATE_INVALID");
    }

    if (Date.now() - createdAtMs > DELETE_WINDOW_MS) {
      throw new EdgeFunctionError(
        `Mensagens so podem ser excluidas em ate ${DELETE_WINDOW_HOURS} horas.`,
        400,
        "MESSAGE_DELETE_WINDOW_EXPIRED",
      );
    }
  }

  if (currentRow.deleted_at) {
    const attachment = currentRow.type === "text" ? null : await loadDirectAttachmentByMessageId(currentRow.id);
    return mapDirectMessageRow(currentRow, attachment);
  }

  const updateResult = await supabase
    .from("messages")
    .update({
      deleted_at: new Date().toISOString(),
      content: "",
    })
    .eq("id", messageId)
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .single();

  if (updateResult.error || !updateResult.data) {
    throw updateResult.error ?? new EdgeFunctionError("Falha ao excluir mensagem.", 500, "DELETE_MESSAGE_FAILED");
  }

  const updatedRow = updateResult.data as DirectMessageRow;
  const attachment = updatedRow.type === "text" ? null : await loadDirectAttachmentByMessageId(updatedRow.id);
  return mapDirectMessageRow(updatedRow, attachment);
}

async function editChatMessageDirect(messageIdRaw: string, contentRaw: string): Promise<ChatMessageServer> {
  const messageId = String(messageIdRaw ?? "").trim();
  const content = String(contentRaw ?? "").trim();
  if (!messageId) {
    throw new EdgeFunctionError("Mensagem invalida.", 400, "INVALID_PAYLOAD");
  }

  if (!content) {
    throw new EdgeFunctionError("Mensagem vazia nao pode ser salva.", 400, "EMPTY_MESSAGE");
  }

  const currentUserId = String(await authService.getCurrentUserId() ?? "").trim();
  if (!currentUserId) {
    throw createUnauthenticatedChatMessagesError();
  }

  const currentResult = await supabase
    .from("messages")
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .eq("id", messageId)
    .limit(1)
    .maybeSingle();

  if (currentResult.error) {
    throw currentResult.error;
  }

  const currentRow = currentResult.data as DirectMessageRow | null;
  if (!currentRow) {
    throw new EdgeFunctionError("Mensagem nao encontrada.", 404, "MESSAGE_NOT_FOUND");
  }

  if (String(currentRow.sender_id ?? "").trim() !== currentUserId) {
    throw new EdgeFunctionError("Somente o autor pode editar a mensagem.", 403, "FORBIDDEN");
  }

  if (currentRow.type !== "text") {
    throw new EdgeFunctionError("Somente mensagens de texto podem ser editadas.", 400, "MESSAGE_NOT_EDITABLE");
  }

  if (currentRow.deleted_at) {
    throw new EdgeFunctionError("Mensagem excluida nao pode ser editada.", 400, "MESSAGE_DELETED");
  }

  const createdAtMs = Date.parse(String(currentRow.created_at ?? ""));
  if (!Number.isFinite(createdAtMs)) {
    throw new EdgeFunctionError("Falha ao validar o estado da mensagem.", 500, "MESSAGE_STATE_INVALID");
  }

  if (Date.now() - createdAtMs > EDIT_WINDOW_MS) {
    throw new EdgeFunctionError(
      `Mensagens so podem ser editadas em ate ${EDIT_WINDOW_MINUTES} minutos.`,
      400,
      "MESSAGE_EDIT_WINDOW_EXPIRED",
    );
  }

  if (String(currentRow.content ?? "") === content) {
    return mapDirectMessageRow(currentRow, null);
  }

  const updateResult = await supabase
    .from("messages")
    .update({
      content,
      edited_at: new Date().toISOString(),
    })
    .eq("id", messageId)
    .select(DIRECT_MESSAGE_SELECT_COLUMNS)
    .single();

  if (updateResult.error || !updateResult.data) {
    throw updateResult.error ?? new EdgeFunctionError("Falha ao editar mensagem.", 500, "EDIT_MESSAGE_FAILED");
  }

  return mapDirectMessageRow(updateResult.data as DirectMessageRow, null);
}

export async function sendChatMessage(payload: SendChatMessageInput): Promise<ChatMessageServer> {
  if (shouldPreferDirectChatAccess() && isDirectSendFallbackCandidate(payload)) {
    return sendChatMessageDirect(payload);
  }

  if (isDirectSendFallbackCandidate(payload) && isEdgeSendMessagesUnauthorizedBypassActive()) {
    return sendChatMessageDirect(payload);
  }

  if (isDirectSendFallbackCandidate(payload)) {
    const accessToken = await authService.getValidatedEdgeAccessToken();
    if (!accessToken) {
      activateEdgeSendMessagesUnauthorizedBypass();
      return sendChatMessageDirect(payload);
    }
  }

  const buildRequest = (includePayload: boolean): SendMessageRequest => ({
    action: "send",
    conversationId: payload.conversationId,
    clientId: payload.clientId,
    type: payload.type,
    content: payload.content ?? null,
    replyToId: payload.replyToId ?? null,
    replyToSnapshot: payload.replyToSnapshot ?? null,
    attachment: payload.attachment ?? null,
    ...(includePayload && payload.payload ? { payload: payload.payload } : {}),
  });

  const trySend = async (request: SendMessageRequest): Promise<MessageMutationResponse> =>
    invokeEdgeJson<SendMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
      requireAuth: true,
      retries: 1,
      timeoutMs: 20_000,
    });

  const requestWithPayload = buildRequest(true);

  try {
    const response = await trySend(requestWithPayload);
    clearEdgeSendMessagesUnauthorizedBypass();
    return response.message;
  } catch (error) {
    const unauthorized = isUnauthorizedChatMessagesError(error);
    const invalidPayload =
      payload.payload &&
      error instanceof EdgeFunctionError &&
      error.status === 400 &&
      (error.code === "INVALID_PAYLOAD" || error.code === "HTTP_400");

    if (unauthorized) {
      activateEdgeSendMessagesUnauthorizedBypass();
      const refreshed = await authService.refreshSession();
      if (refreshed?.access_token) {
        try {
          const retryResponse = await trySend(buildRequest(true));
          clearEdgeSendMessagesUnauthorizedBypass();
          return retryResponse.message;
        } catch {
          // fall through to payload stripping / final throw
        }
      }

      if (isDirectSendFallbackCandidate(payload)) {
        return sendChatMessageDirect(payload);
      }
    }

    if (!invalidPayload) {
      throw error;
    }

    const fallbackResponse = await trySend(buildRequest(false));
    return fallbackResponse.message;
  }
}

export async function editChatMessage(messageId: string, content: string): Promise<ChatMessageServer> {
  if (shouldPreferDirectChatAccess() || isEdgeChatMessagesUnauthorizedBypassActive()) {
    return editChatMessageDirect(messageId, content);
  }

  const accessToken = await authService.getValidatedEdgeAccessToken();
  if (!accessToken) {
    activateEdgeDeleteMessagesUnauthorizedBypass();
    return editChatMessageDirect(messageId, content);
  }

  const request: EditMessageRequest = {
    action: "edit",
    messageId,
    content,
  };

  try {
    const response = await invokeEdgeJson<EditMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 18_000,
    });
    clearEdgeDeleteMessagesUnauthorizedBypass();
    return response.message;
  } catch (error) {
    if (!isUnauthorizedChatMessagesError(error) && !isFallbackEligibleChatMessagesError(error)) {
      throw error;
    }
    activateEdgeDeleteMessagesUnauthorizedBypass();
    return editChatMessageDirect(messageId, content);
  }
}

export async function deleteChatMessage(messageId: string): Promise<ChatMessageServer> {
  if (shouldPreferDirectChatAccess()) {
    return deleteChatMessageDirect(messageId);
  }

  if (isEdgeDeleteMessagesUnauthorizedBypassActive()) {
    return deleteChatMessageDirect(messageId);
  }

  const request: DeleteMessageRequest = {
    action: "delete",
    messageId,
  };

  try {
    const response = await invokeEdgeJson<DeleteMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 18_000,
    });
    clearEdgeDeleteMessagesUnauthorizedBypass();
    return response.message;
  } catch (error) {
    const unauthorized = isUnauthorizedChatMessagesError(error);
    const fallbackEligible = isFallbackEligibleChatMessagesError(error);
    if (!unauthorized && !fallbackEligible) {
      throw error;
    }

    if (unauthorized) {
      activateEdgeDeleteMessagesUnauthorizedBypass();
      const refreshed = await authService.refreshSession();
      if (refreshed?.access_token) {
        try {
          const retryResponse = await invokeEdgeJson<DeleteMessageRequest, MessageMutationResponse>(FUNCTION_NAME, request, {
            requireAuth: true,
            retries: 0,
            timeoutMs: 18_000,
          });
          clearEdgeDeleteMessagesUnauthorizedBypass();
          return retryResponse.message;
        } catch {
          // Fall through to direct fallback.
        }
      }
    }

    return deleteChatMessageDirect(messageId);
  }
}
