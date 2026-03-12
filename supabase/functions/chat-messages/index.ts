/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseError,
  responseJson,
  responseNoContent,
  type RequestContext,
} from "../_shared/http.ts";
import { sanitizeMediaKey } from "../_shared/mediaSecurity.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { assertConversationCanSendMessages, assertConversationMembership, resolveUserId } from "../_shared/user.ts";

const ROUTE = "chat-messages";
const MESSAGE_TYPES = ["text", "image", "video", "file"] as const;
const MAX_TEXT_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_ATTACHMENT_BATCH_SIZE = 100;
const EDIT_WINDOW_MINUTES = 15;
const EDIT_WINDOW_MS = EDIT_WINDOW_MINUTES * 60 * 1000;
const REPLY_SNAPSHOT_MAX_KEYS = 6;
const REPLY_SNAPSHOT_MAX_BYTES = 2048;
const EDIT_HISTORY_LIMIT = 5;
const EDIT_HISTORY_MAX_BYTES = 8192;
const MESSAGE_SELECT_COLUMNS =
  "id,conversation_id,sender_id,client_id,content,type,created_at,edited_at,deleted_at,reply_to_id,reply_to_snapshot,call_id,payload";
const ATTACHMENT_SELECT_COLUMNS =
  "message_id,file_key,original_key,thumb_key,mime_type,file_size,width,height,thumb_width,thumb_height,codec,duration_ms";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKED_MEDIA_KEY_SEQUENCES = ["..", "%2e", "%2f", "%5c", "\\", "//"];
const textEncoder = new TextEncoder();

type MessageType = (typeof MESSAGE_TYPES)[number];

const replySnapshotSchema = z
  .object({
    author_id: z.string().max(64).optional().nullable(),
    author_name: z.string().max(120).optional().nullable(),
    author_avatar: z.string().max(1024).optional().nullable(),
    snippet: z.string().max(240).optional().nullable(),
    message_type: z.enum(MESSAGE_TYPES).optional().nullable(),
    created_at: z.string().max(64).optional().nullable(),
  })
  .strict()
  .nullable()
  .optional();

const attachmentPayloadSchema = z
  .object({
    fileKey: z.string().min(1).max(512),
    originalKey: z.string().min(1).max(512).optional().nullable(),
    thumbKey: z.string().min(1).max(512).optional().nullable(),
    mimeType: z.string().max(120).optional().nullable(),
    fileSize: z.number().int().min(1).max(100 * 1024 * 1024).optional().nullable(),
    width: z.number().int().min(1).max(12000).optional().nullable(),
    height: z.number().int().min(1).max(12000).optional().nullable(),
    thumbWidth: z.number().int().min(1).max(4000).optional().nullable(),
    thumbHeight: z.number().int().min(1).max(4000).optional().nullable(),
    codec: z.string().max(80).optional().nullable(),
    durationMs: z.number().int().min(1).max(60 * 60 * 1000).optional().nullable(),
  })
  .strict();

const messagePayloadSchema = z
  .object({
    fileName: z.string().max(240).optional().nullable(),
  })
  .strict()
  .optional()
  .nullable();

const sendPayloadSchema = z
  .object({
    action: z.literal("send"),
    conversationId: z.string().uuid(),
    clientId: z.string().min(8).max(128),
    content: z.string().max(MAX_TEXT_LENGTH).optional().nullable(),
    type: z.enum(MESSAGE_TYPES).default("text"),
    replyToId: z.string().uuid().optional().nullable(),
    replyToSnapshot: replySnapshotSchema,
    attachment: attachmentPayloadSchema.optional().nullable(),
    payload: messagePayloadSchema,
  })
  .strict();

const editPayloadSchema = z
  .object({
    action: z.literal("edit"),
    messageId: z.string().uuid(),
    content: z.string().max(MAX_TEXT_LENGTH),
  })
  .strict();

const deletePayloadSchema = z
  .object({
    action: z.literal("delete"),
    messageId: z.string().uuid(),
  })
  .strict();

const listPayloadSchema = z
  .object({
    action: z.literal("list"),
    conversationId: z.string().uuid(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    cursorCreatedAt: z.string().max(64).optional().nullable(),
    cursorId: z.string().max(64).optional().nullable(),
  })
  .strict();

const inputSchema = z.discriminatedUnion("action", [sendPayloadSchema, editPayloadSchema, deletePayloadSchema, listPayloadSchema]);

type SendPayload = z.infer<typeof sendPayloadSchema>;
type EditPayload = z.infer<typeof editPayloadSchema>;
type DeletePayload = z.infer<typeof deletePayloadSchema>;
type ListPayload = z.infer<typeof listPayloadSchema>;
type InputPayload = z.infer<typeof inputSchema>;

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string | null;
  content: string | null;
  type: MessageType;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  reply_to_snapshot: Record<string, unknown> | null;
  call_id: string | null;
  payload: Record<string, unknown> | null;
}

interface AttachmentRow {
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

interface MessageWithAttachment {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string | null;
  content: string;
  type: MessageType;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  reply_to_snapshot: Record<string, unknown> | null;
  call_id: string | null;
  payload: Record<string, unknown> | null;
  attachment: {
    fileKey: string;
    originalKey: string | null;
    thumbKey: string | null;
    mimeType: string | null;
    fileSize: number | null;
    width: number | null;
    height: number | null;
    thumbWidth: number | null;
    thumbHeight: number | null;
    codec: string | null;
    durationMs: number | null;
  } | null;
}

interface ListCursor {
  createdAt: string;
  id: string;
}

interface NormalizedAttachmentPayload {
  fileKey: string;
  originalKey: string | null;
  thumbKey: string | null;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  thumbWidth: number | null;
  thumbHeight: number | null;
  codec: string | null;
  durationMs: number | null;
}

interface NormalizedMessagePayload {
  fileName: string | null;
}

function normalizeTextContent(rawContent: string | null | undefined): string {
  const value = String(rawContent ?? "");
  const withoutNullBytes = value.replace(/\u0000/g, "");
  const sanitized = withoutNullBytes.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return sanitized.slice(0, MAX_TEXT_LENGTH);
}

function getSafeElapsedMs(context: RequestContext): number {
  return Math.max(0, Date.now() - context.startedAt);
}

function sanitizeFreeformString(rawValue: unknown, maxLength: number): string | null {
  if (rawValue == null) {
    return null;
  }
  const normalized = normalizeTextContent(String(rawValue)).trim().slice(0, maxLength);
  return normalized ? normalized : null;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function isValidUuid(value: string | null | undefined): boolean {
  return Boolean(value) && UUID_REGEX.test(String(value).trim());
}

function normalizeMessageType(rawType: unknown): MessageType {
  const normalized = String(rawType ?? "").trim().toLowerCase();
  return MESSAGE_TYPES.includes(normalized as MessageType) ? (normalized as MessageType) : "text";
}

function sanitizeReplySnapshot(value: SendPayload["replyToSnapshot"]): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).length > REPLY_SNAPSHOT_MAX_KEYS) {
    throw new HttpError(400, "INVALID_REPLY_SNAPSHOT", "replyToSnapshot excede o tamanho permitido.");
  }

  const sanitized: Record<string, unknown> = {};
  const authorId = sanitizeFreeformString(snapshot.author_id, 64);
  const authorName = sanitizeFreeformString(snapshot.author_name, 120);
  const authorAvatar = sanitizeFreeformString(snapshot.author_avatar, 1024);
  const snippet = sanitizeFreeformString(snapshot.snippet, 240);
  const messageType = sanitizeFreeformString(snapshot.message_type, 24);
  const createdAt = sanitizeFreeformString(snapshot.created_at, 64);

  if (authorId) sanitized.author_id = authorId;
  if (authorName) sanitized.author_name = authorName;
  if (authorAvatar) sanitized.author_avatar = authorAvatar;
  if (snippet) sanitized.snippet = snippet;
  if (messageType) sanitized.message_type = normalizeMessageType(messageType);
  if (createdAt) sanitized.created_at = createdAt;

  if (byteLength(JSON.stringify(sanitized)) > REPLY_SNAPSHOT_MAX_BYTES) {
    throw new HttpError(400, "INVALID_REPLY_SNAPSHOT", "replyToSnapshot excede o tamanho permitido.");
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function parsePayload(payload: unknown): InputPayload {
  const result = inputSchema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
    issues: result.error.issues.map((issue: { path: PropertyKey[]; message: string; code: string }) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  });
}

function parseListCursor(payload: ListPayload): ListCursor | null {
  const rawCreatedAt = String(payload.cursorCreatedAt ?? "").trim();
  const rawCursorId = String(payload.cursorId ?? "").trim();

  if (!rawCreatedAt && !rawCursorId) {
    return null;
  }
  if (!rawCreatedAt || !rawCursorId) {
    throw new HttpError(400, "INVALID_CURSOR", "Cursor invalido.");
  }

  const createdAtMs = Date.parse(rawCreatedAt);
  if (!Number.isFinite(createdAtMs) || !isValidUuid(rawCursorId)) {
    throw new HttpError(400, "INVALID_CURSOR", "Cursor invalido.");
  }

  return {
    createdAt: new Date(createdAtMs).toISOString(),
    id: rawCursorId,
  };
}

function buildSeekCursorFilter(cursor: ListCursor): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

function normalizeMessageRow(raw: unknown): MessageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const row = raw as Record<string, unknown>;

  const id = toOptionalString(row.id);
  const conversationId = toOptionalString(row.conversation_id);
  const createdAt = toOptionalString(row.created_at);

  if (!id || !conversationId || !createdAt) {
    return null;
  }

  const senderId = toOptionalString(row.sender_id) ?? toOptionalString(row.author_id) ?? "";
  const messageType = normalizeMessageType(toOptionalString(row.type) ?? toOptionalString(row.message_type) ?? "text");

  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    client_id: toOptionalString(row.client_id),
    content: row.content == null ? null : String(row.content),
    type: messageType,
    created_at: createdAt,
    edited_at: toOptionalString(row.edited_at),
    deleted_at: toOptionalString(row.deleted_at),
    reply_to_id: toOptionalString(row.reply_to_id),
    reply_to_snapshot: toOptionalObject(row.reply_to_snapshot),
    call_id: toOptionalString(row.call_id),
    payload: toOptionalObject(row.payload),
  };
}

function normalizeAttachmentRow(raw: unknown): AttachmentRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const row = raw as Record<string, unknown>;
  const messageId = toOptionalString(row.message_id);
  const fileKey = toOptionalString(row.file_key);

  if (!messageId || !fileKey) {
    return null;
  }

  return {
    message_id: messageId,
    file_key: fileKey,
    original_key: toOptionalString(row.original_key),
    thumb_key: toOptionalString(row.thumb_key),
    mime_type: toOptionalString(row.mime_type),
    file_size: toOptionalNumber(row.file_size),
    width: toOptionalNumber(row.width),
    height: toOptionalNumber(row.height),
    thumb_width: toOptionalNumber(row.thumb_width),
    thumb_height: toOptionalNumber(row.thumb_height),
    codec: toOptionalString(row.codec),
    duration_ms: toOptionalNumber(row.duration_ms),
  };
}

function mapMessage(row: MessageRow, attachmentRow: AttachmentRow | null): MessageWithAttachment {
  const messageType = normalizeMessageType(row.type);
  const attachment =
    messageType === "text" || !attachmentRow
      ? null
      : {
          fileKey: String(attachmentRow.file_key ?? ""),
          originalKey: attachmentRow.original_key ? String(attachmentRow.original_key) : null,
          thumbKey: attachmentRow.thumb_key ? String(attachmentRow.thumb_key) : null,
          mimeType: attachmentRow.mime_type ? String(attachmentRow.mime_type) : null,
          fileSize: typeof attachmentRow.file_size === "number" ? attachmentRow.file_size : null,
          width: typeof attachmentRow.width === "number" ? attachmentRow.width : null,
          height: typeof attachmentRow.height === "number" ? attachmentRow.height : null,
          thumbWidth: typeof attachmentRow.thumb_width === "number" ? attachmentRow.thumb_width : null,
          thumbHeight: typeof attachmentRow.thumb_height === "number" ? attachmentRow.thumb_height : null,
          codec: attachmentRow.codec ? String(attachmentRow.codec) : null,
          durationMs: typeof attachmentRow.duration_ms === "number" ? attachmentRow.duration_ms : null,
        };

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    client_id: row.client_id ?? null,
    content: String(row.content ?? ""),
    type: messageType,
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
    deleted_at: row.deleted_at ?? null,
    reply_to_id: row.reply_to_id ?? null,
    reply_to_snapshot: row.reply_to_snapshot ?? null,
    call_id: row.call_id ?? null,
    payload: row.payload ?? null,
    attachment,
  };
}

function compareDesc(a: MessageRow, b: MessageRow): number {
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at ? -1 : 1;
  }
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

function compareAsc(a: MessageWithAttachment, b: MessageWithAttachment): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function loadAttachmentMap(
  messageIds: string[],
  context: RequestContext,
  extras?: Record<string, unknown>,
): Promise<Map<string, AttachmentRow>> {
  const uniqueIds = [...new Set(messageIds.filter((id) => Boolean(id)))];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const mapped = new Map<string, AttachmentRow>();
  const supabase = getSupabaseAdminClient();

  for (const batch of chunkArray(uniqueIds, MAX_ATTACHMENT_BATCH_SIZE)) {
    const batchStartedAt = Date.now();
    const { data, error } = await supabase
      .from("attachments")
      .select(ATTACHMENT_SELECT_COLUMNS)
      .in("message_id", batch);

    if (error) {
      logStructured("warn", "chat_message_attachments_lookup_failed", context, {
        ...extras,
        batchSize: batch.length,
        queryMs: Date.now() - batchStartedAt,
        supabaseCode: error.code ?? null,
      });
      continue;
    }

    for (const rawRow of data ?? []) {
      const row = normalizeAttachmentRow(rawRow);
      if (!row || mapped.has(row.message_id)) {
        continue;
      }
      mapped.set(row.message_id, row);
    }
  }

  return mapped;
}

async function loadMessageRowById(messageId: string): Promise<MessageRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("id", messageId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "MESSAGE_FETCH_FAILED", "Falha ao carregar mensagem.");
  }

  return normalizeMessageRow(data);
}

async function loadHydratedMessages(
  rows: MessageRow[],
  context: RequestContext,
  extras?: Record<string, unknown>,
): Promise<MessageWithAttachment[]> {
  if (rows.length === 0) {
    return [];
  }

  const attachmentMessageIds = rows
    .filter((row) => row.type !== "text")
    .map((row) => row.id);
  if (attachmentMessageIds.length === 0) {
    return rows.map((row) => mapMessage(row, null));
  }

  const attachmentMap = await loadAttachmentMap(
    attachmentMessageIds,
    context,
    extras,
  );

  return rows.map((row) => mapMessage(row, attachmentMap.get(row.id) ?? null));
}

async function loadHydratedMessageByConversationAndClientId(
  conversationId: string,
  clientId: string,
  context: RequestContext,
): Promise<MessageWithAttachment | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("client_id", clientId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "MESSAGE_FETCH_FAILED", "Falha ao carregar mensagem.");
  }

  const row = normalizeMessageRow(data);
  if (!row) {
    return null;
  }

  const [message] = await loadHydratedMessages([row], context, {
    conversationId,
    messageId: row.id,
  });
  return message ?? null;
}

interface ListMessagesMetrics {
  queryMs: number;
  attachmentLookupMs: number;
  totalMs: number;
  queriedRows: number;
  returnedRows: number;
}

async function listMessages(payload: ListPayload, userId: string, context: RequestContext): Promise<{
  messages: MessageWithAttachment[];
  nextCursor: null | { createdAt: string; id: string };
  metrics: ListMessagesMetrics;
}> {
  const supabase = getSupabaseAdminClient();
  await assertConversationMembership(payload.conversationId, userId);

  const limit = payload.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = parseListCursor(payload);
  const totalStartedAt = Date.now();

  const queryStartedAt = Date.now();
  let query = supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", payload.conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.or(buildSeekCursorFilter(cursor));
  }

  const { data, error } = await query;
  const queryMs = Date.now() - queryStartedAt;

  if (error) {
    logStructured("error", "chat_messages_list_query_failed", context, {
      conversationId: payload.conversationId,
      queryMs,
      supabaseCode: error.code ?? null,
    });
    throw new HttpError(500, "LIST_MESSAGES_FAILED", "Falha ao listar mensagens.");
  }

  const rows = (data ?? [])
    .map(normalizeMessageRow)
    .filter((row: MessageRow | null): row is MessageRow => Boolean(row))
    .sort(compareDesc);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const attachmentLookupStartedAt = Date.now();
  const mapped = (await loadHydratedMessages(pageRows, context, {
    conversationId: payload.conversationId,
  }))
    .sort(compareAsc);
  const attachmentLookupMs = Date.now() - attachmentLookupStartedAt;

  const oldest = pageRows[pageRows.length - 1];

  return {
    messages: mapped,
    nextCursor: hasMore && oldest
      ? {
          createdAt: oldest.created_at,
          id: oldest.id,
        }
      : null,
    metrics: {
      queryMs,
      attachmentLookupMs,
      totalMs: Date.now() - totalStartedAt,
      queriedRows: rows.length,
      returnedRows: mapped.length,
    },
  };
}

async function assertReplyMessageBelongsToConversation(replyToId: string, conversationId: string): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select("id,conversation_id")
    .eq("id", replyToId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "REPLY_VALIDATION_FAILED", "Falha ao validar replyToId.");
  }

  const row = data as { id?: string; conversation_id?: string } | null;
  if (!row?.id || !row.conversation_id) {
    throw new HttpError(400, "INVALID_REPLY", "replyToId nao encontrado.");
  }

  if (row.conversation_id !== conversationId) {
    throw new HttpError(400, "INVALID_REPLY", "replyToId nao pertence a mesma conversa.");
  }
}

function assertSafeChatAttachmentKey(rawKey: string, fieldName: string): string {
  const candidate = String(rawKey ?? "").trim();
  if (!candidate) {
    throw new HttpError(400, "INVALID_ATTACHMENT_KEY", `${fieldName} invalido.`);
  }

  const lowered = candidate.toLowerCase();
  if (/[\u0000-\u001F\u007F]/.test(candidate) || BLOCKED_MEDIA_KEY_SEQUENCES.some((sequence) => lowered.includes(sequence))) {
    throw new HttpError(400, "INVALID_ATTACHMENT_KEY", `${fieldName} invalido.`);
  }

  let safeKey: string;
  try {
    safeKey = sanitizeMediaKey(candidate);
  } catch {
    throw new HttpError(400, "INVALID_ATTACHMENT_KEY", `${fieldName} invalido.`);
  }

  return safeKey;
}

function normalizeAttachmentPayload(
  attachment: NonNullable<SendPayload["attachment"]>,
): NormalizedAttachmentPayload {
  return {
    fileKey: assertSafeChatAttachmentKey(attachment.fileKey, "fileKey"),
    originalKey: attachment.originalKey ? assertSafeChatAttachmentKey(attachment.originalKey, "originalKey") : null,
    thumbKey: attachment.thumbKey ? assertSafeChatAttachmentKey(attachment.thumbKey, "thumbKey") : null,
    mimeType: sanitizeFreeformString(attachment.mimeType, 120),
    fileSize: typeof attachment.fileSize === "number" ? attachment.fileSize : null,
    width: typeof attachment.width === "number" ? attachment.width : null,
    height: typeof attachment.height === "number" ? attachment.height : null,
    thumbWidth: typeof attachment.thumbWidth === "number" ? attachment.thumbWidth : null,
    thumbHeight: typeof attachment.thumbHeight === "number" ? attachment.thumbHeight : null,
    codec: sanitizeFreeformString(attachment.codec, 80),
    durationMs: typeof attachment.durationMs === "number" ? attachment.durationMs : null,
  };
}

async function assertAttachmentAuthorization(
  userId: string,
  conversationId: string,
  attachment: NormalizedAttachmentPayload,
): Promise<void> {
  const uniqueKeys = [...new Set([attachment.fileKey, attachment.originalKey, attachment.thumbKey].filter(Boolean))] as string[];
  if (uniqueKeys.length === 0) {
    throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Nenhuma chave de anexo foi informada.");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("media_uploads")
    .select("file_key,status")
    .eq("owner_user_id", userId)
    .eq("conversation_id", conversationId)
    .in("file_key", uniqueKeys);

  if (error) {
    throw new HttpError(500, "MEDIA_UPLOAD_LOOKUP_FAILED", "Falha ao validar upload do anexo.");
  }

  const authorizationByKey = new Map<string, string>();
  for (const row of data ?? []) {
    const fileKey = String((row as { file_key?: string }).file_key ?? "").trim();
    const status = String((row as { status?: string }).status ?? "").trim().toLowerCase();
    if (fileKey) {
      authorizationByKey.set(fileKey, status);
    }
  }

  const missingKey = uniqueKeys.find((key) => !authorizationByKey.has(key));
  if (missingKey) {
    throw new HttpError(403, "ATTACHMENT_NOT_AUTHORIZED", "Anexo nao autorizado para essa conversa.", {
      fileKey: missingKey,
    });
  }

  const invalidStatusKey = uniqueKeys.find((key) => {
    const status = authorizationByKey.get(key);
    return status !== "pending" && status !== "uploaded" && status !== "attached";
  });
  if (invalidStatusKey) {
    throw new HttpError(409, "ATTACHMENT_UPLOAD_INVALID", "O upload do anexo nao esta disponivel para uso.", {
      fileKey: invalidStatusKey,
      status: authorizationByKey.get(invalidStatusKey) ?? null,
    });
  }

  const nowIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("media_uploads")
    .update({
      status: "attached",
      updated_at: nowIso,
      last_seen_at: nowIso,
    })
    .eq("owner_user_id", userId)
    .eq("conversation_id", conversationId)
    .in("file_key", uniqueKeys);

  if (updateError) {
    throw new HttpError(500, "MEDIA_UPLOAD_MARK_FAILED", "Falha ao vincular upload ao anexo.");
  }
}

function sanitizeAttachmentDisplayName(rawValue: unknown): string | null {
  if (rawValue == null) {
    return null;
  }

  const normalized = normalizeTextContent(String(rawValue))
    .replace(/[\\/]+/g, "/")
    .split("/")
    .pop()
    ?.trim()
    .slice(0, 240) ?? "";

  return normalized ? normalized : null;
}

function normalizeMessagePayload(payload: SendPayload["payload"], messageType: MessageType): NormalizedMessagePayload | null {
  if (!payload || messageType !== "file") {
    return null;
  }

  const fileName = sanitizeAttachmentDisplayName(payload.fileName);
  if (!fileName) {
    return null;
  }

  return {
    fileName,
  };
}

function createAttachmentRowFromPayload(messageId: string, attachment: NormalizedAttachmentPayload): AttachmentRow {
  return {
    message_id: messageId,
    file_key: attachment.fileKey,
    original_key: attachment.originalKey,
    thumb_key: attachment.thumbKey,
    mime_type: attachment.mimeType,
    file_size: attachment.fileSize,
    width: attachment.width,
    height: attachment.height,
    thumb_width: attachment.thumbWidth,
    thumb_height: attachment.thumbHeight,
    codec: attachment.codec,
    duration_ms: attachment.durationMs,
  };
}

function isSchemaCompatibilityInsertError(error: { code?: string | null; message?: string | null; details?: string | null }): boolean {
  const combined = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return combined.includes("original_key")
    || combined.includes("thumb_key")
    || combined.includes("thumb_width")
    || combined.includes("thumb_height")
    || combined.includes("duration_ms")
    || combined.includes("codec")
    || combined.includes("conversation_id");
}

async function insertAttachmentMetadata(
  messageId: string,
  conversationId: string,
  attachment: NormalizedAttachmentPayload,
): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const primaryInsert = await supabase.from("attachments").insert({
    message_id: messageId,
    conversation_id: conversationId,
    file_key: attachment.fileKey,
    original_key: attachment.originalKey,
    thumb_key: attachment.thumbKey,
    file_size: attachment.fileSize,
    mime_type: attachment.mimeType,
    width: attachment.width,
    height: attachment.height,
    thumb_width: attachment.thumbWidth,
    thumb_height: attachment.thumbHeight,
    codec: attachment.codec,
    duration_ms: attachment.durationMs,
  });

  if (!primaryInsert.error) {
    return;
  }

  if (!isSchemaCompatibilityInsertError(primaryInsert.error)) {
    throw new HttpError(500, "ATTACHMENT_SAVE_FAILED", "Falha ao registrar metadados do anexo.");
  }

  const fallbackInsert = await supabase.from("attachments").insert({
    message_id: messageId,
    conversation_id: conversationId,
    file_key: attachment.fileKey,
    file_size: attachment.fileSize,
    mime_type: attachment.mimeType,
  });

  if (fallbackInsert.error) {
    throw new HttpError(500, "ATTACHMENT_SAVE_FAILED", "Falha ao registrar metadados do anexo.");
  }
}

async function rollbackMessageInsert(messageId: string, context: RequestContext): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("messages").delete().eq("id", messageId);
  if (error) {
    logStructured("warn", "chat_message_rollback_failed", context, {
      messageId,
      supabaseCode: error.code ?? null,
    });
  }
}

async function sendMessage(payload: SendPayload, userId: string, context: RequestContext): Promise<MessageWithAttachment> {
  await assertConversationMembership(payload.conversationId, userId);

  const existingMessage = await loadHydratedMessageByConversationAndClientId(
    payload.conversationId,
    payload.clientId,
    context,
  );
  if (existingMessage) {
    return existingMessage;
  }

  await assertConversationCanSendMessages(payload.conversationId, userId);

  if (payload.replyToId) {
    await assertReplyMessageBelongsToConversation(payload.replyToId, payload.conversationId);
  }

  const messageType = normalizeMessageType(payload.type);
  const replyToSnapshot = sanitizeReplySnapshot(payload.replyToSnapshot);
  const normalizedPayload = normalizeMessagePayload(payload.payload, messageType);
  let normalizedContent = normalizeTextContent(payload.content ?? "").trim();
  let attachment: NormalizedAttachmentPayload | null = null;

  if (messageType === "text") {
    if (payload.attachment) {
      throw new HttpError(400, "INVALID_ATTACHMENT", "Mensagem de texto nao aceita anexo.");
    }
    if (!normalizedContent) {
      throw new HttpError(400, "EMPTY_MESSAGE", "Mensagem vazia nao pode ser enviada.");
    }
  } else {
    if (!payload.attachment) {
      throw new HttpError(400, "MISSING_ATTACHMENT", "Anexo obrigatorio para este tipo de mensagem.");
    }
    attachment = normalizeAttachmentPayload(payload.attachment);
    await assertAttachmentAuthorization(userId, payload.conversationId, attachment);
    normalizedContent = attachment.fileKey;
  }

  const supabase = getSupabaseAdminClient();
  const insertResult = await supabase
    .from("messages")
    .insert({
      conversation_id: payload.conversationId,
      sender_id: userId,
      client_id: payload.clientId,
      content: normalizedContent,
      type: messageType,
      reply_to_id: payload.replyToId ?? null,
      reply_to_snapshot: replyToSnapshot,
      payload: normalizedPayload,
    })
    .select(MESSAGE_SELECT_COLUMNS)
    .limit(1)
    .single();

  if (insertResult.error || !insertResult.data) {
    if (insertResult.error?.code === "23505") {
      const conflictedMessage = await loadHydratedMessageByConversationAndClientId(
        payload.conversationId,
        payload.clientId,
        context,
      );
      if (conflictedMessage) {
        return conflictedMessage;
      }
    }

    throw new HttpError(500, "SEND_MESSAGE_FAILED", "Falha ao enviar mensagem.");
  }

  const insertedMessage = normalizeMessageRow(insertResult.data);
  if (!insertedMessage) {
    throw new HttpError(500, "SEND_MESSAGE_FAILED", "Falha ao enviar mensagem.");
  }

  if (attachment) {
    try {
      await insertAttachmentMetadata(insertedMessage.id, payload.conversationId, attachment);
    } catch (error) {
      await rollbackMessageInsert(insertedMessage.id, context);
      throw error;
    }
  }

  return mapMessage(insertedMessage, attachment ? createAttachmentRowFromPayload(insertedMessage.id, attachment) : null);
}
async function hydrateSingleMessageRow(row: MessageRow, context: RequestContext): Promise<MessageWithAttachment> {
  if (row.type === "text") {
    return mapMessage(row, null);
  }

  const [message] = await loadHydratedMessages([row], context, {
    conversationId: row.conversation_id,
    messageId: row.id,
  });
  return message ?? mapMessage(row, null);
}

function assertMutationWindow(createdAt: string, windowMs: number, code: string, message: string): void {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new HttpError(500, "MESSAGE_STATE_INVALID", "Falha ao validar o estado da mensagem.");
  }

  if (Date.now() - createdAtMs > windowMs) {
    throw new HttpError(400, code, message);
  }
}

function sanitizeEditHistoryItem(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const replacedAt = sanitizeFreeformString(raw.replaced_at, 64);
  const previousEditedAt = sanitizeFreeformString(raw.previous_edited_at, 64);
  const previousContentLength = toOptionalNumber(raw.previous_content_length);
  const sanitized: Record<string, unknown> = {};

  if (replacedAt) sanitized.replaced_at = replacedAt;
  if (previousEditedAt) sanitized.previous_edited_at = previousEditedAt;
  if (typeof previousContentLength === "number") sanitized.previous_content_length = previousContentLength;

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function buildEditedPayload(row: MessageRow, nextEditedAt: string): Record<string, unknown> | null {
  const nextPayload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? { ...row.payload }
    : {};

  const existingHistory = Array.isArray(nextPayload.edit_history)
    ? nextPayload.edit_history.map(sanitizeEditHistoryItem).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

  existingHistory.push({
    replaced_at: nextEditedAt,
    previous_edited_at: row.edited_at ?? row.created_at,
    previous_content_length: String(row.content ?? "").length,
  });

  const nextHistory = existingHistory.slice(-EDIT_HISTORY_LIMIT);
  nextPayload.edit_history = nextHistory;
  nextPayload.edit_count = nextHistory.length;

  if (byteLength(JSON.stringify(nextPayload)) > EDIT_HISTORY_MAX_BYTES) {
    return {
      edit_count: nextHistory.length,
    };
  }

  return nextPayload;
}

async function editMessage(payload: EditPayload, userId: string, context: RequestContext): Promise<MessageWithAttachment> {
  const supabase = getSupabaseAdminClient();
  const row = await loadMessageRowById(payload.messageId);

  if (!row?.id || !row.sender_id) {
    throw new HttpError(404, "MESSAGE_NOT_FOUND", "Mensagem nao encontrada.");
  }

  await assertConversationMembership(row.conversation_id, userId);

  if (row.sender_id !== userId) {
    throw new HttpError(403, "FORBIDDEN", "Somente o autor pode editar a mensagem.");
  }

  if (row.type !== "text") {
    throw new HttpError(400, "MESSAGE_NOT_EDITABLE", "Somente mensagens de texto podem ser editadas.");
  }

  if (row.deleted_at) {
    throw new HttpError(400, "MESSAGE_DELETED", "Mensagem excluida nao pode ser editada.");
  }

  assertMutationWindow(
    row.created_at,
    EDIT_WINDOW_MS,
    "MESSAGE_EDIT_WINDOW_EXPIRED",
    `Mensagens so podem ser editadas em ate ${EDIT_WINDOW_MINUTES} minutos.`,
  );

  const normalizedContent = normalizeTextContent(payload.content).trim();
  if (!normalizedContent) {
    throw new HttpError(400, "EMPTY_MESSAGE", "Mensagem vazia nao pode ser salva.");
  }

  if (normalizedContent === String(row.content ?? "")) {
    return mapMessage(row, null);
  }

  const editedAt = new Date().toISOString();
  const nextPayload = buildEditedPayload(row, editedAt);
  const { data, error } = await supabase
    .from("messages")
    .update({
      content: normalizedContent,
      edited_at: editedAt,
      payload: nextPayload,
    })
    .eq("id", payload.messageId)
    .select(MESSAGE_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new HttpError(500, "EDIT_MESSAGE_FAILED", "Falha ao editar mensagem.");
  }

  const normalized = normalizeMessageRow(data);
  if (!normalized) {
    throw new HttpError(500, "EDIT_MESSAGE_FAILED", "Falha ao editar mensagem.");
  }

  return mapMessage(normalized, null);
}

async function deleteMessage(payload: DeletePayload, userId: string, context: RequestContext): Promise<MessageWithAttachment> {
  const supabase = getSupabaseAdminClient();
  const row = await loadMessageRowById(payload.messageId);

  if (!row?.id || !row.sender_id) {
    throw new HttpError(404, "MESSAGE_NOT_FOUND", "Mensagem nao encontrada.");
  }

  await assertConversationMembership(row.conversation_id, userId);

  if (row.sender_id !== userId) {
    throw new HttpError(403, "FORBIDDEN", "Somente o autor pode excluir a mensagem.");
  }

  if (row.deleted_at) {
    return await hydrateSingleMessageRow(row, context);
  }

  const { data, error } = await supabase
    .from("messages")
    .update({
      deleted_at: new Date().toISOString(),
      content: "",
    })
    .eq("id", payload.messageId)
    .select(MESSAGE_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new HttpError(500, "DELETE_MESSAGE_FAILED", "Falha ao excluir mensagem.");
  }

  const normalized = normalizeMessageRow(data);
  if (!normalized) {
    throw new HttpError(500, "DELETE_MESSAGE_FAILED", "Falha ao excluir mensagem.");
  }

  return await hydrateSingleMessageRow(normalized, context);
}
async function enforceActionRateLimits(uid: string, payload: InputPayload): Promise<void> {
  if (payload.action === "send") {
    const checks: Array<Promise<unknown>> = [
      enforceRateLimit(`send:${uid}`, 5, 5_000, ROUTE, {
        action: payload.action,
      }),
      enforceRateLimit(`send-burst:${uid}`, 3, 1_000, ROUTE, {
        action: payload.action,
      }),
    ];

    if (payload.type !== "text") {
      checks.push(
        enforceRateLimit(`send-attachment:${uid}`, 20, 60_000, ROUTE, {
          action: payload.action,
        }),
      );
    }

    await Promise.all(checks);
    return;
  }

  if (payload.action === "edit") {
    await enforceRateLimit(`edit:${uid}`, 8, 60_000, ROUTE, {
      action: payload.action,
    });
    return;
  }

  if (payload.action === "delete") {
    await enforceRateLimit(`delete:${uid}`, 6, 60_000, ROUTE, {
      action: payload.action,
    });
    return;
  }

  await enforceRateLimit(`list:${uid}`, 240, 60_000, ROUTE, {
    action: payload.action,
  });
}

function sanitizeErrorForClient(error: unknown): HttpError {
  if (!(error instanceof HttpError)) {
    return new HttpError(500, "INTERNAL_ERROR", "Erro interno.");
  }

  if (error.code === "INVALID_PAYLOAD") {
    return error;
  }

  return new HttpError(error.status, error.code, error.message);
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE);
  let payload: InputPayload | null = null;
  let userId: string | null = null;
  let conversationId: string | null = null;
  let messageId: string | null = null;

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");

    const auth = await validateSupabaseToken(request);
    context.uid = auth.uid;

    const rawPayload = await parseJsonBody<unknown>(request);
    payload = parsePayload(rawPayload);
    context.action = payload.action;

    if ("conversationId" in payload && payload.conversationId) {
      conversationId = payload.conversationId;
    }
    if ("messageId" in payload && payload.messageId) {
      messageId = payload.messageId;
    }

    await enforceActionRateLimits(auth.uid, payload);

    userId = await resolveUserId(auth.uid, auth.email);

    if (payload.action === "list") {
      const listed = await listMessages(payload, userId, context);
      logStructured("info", "chat_messages_list_success", context, {
        status: 200,
        uid: auth.uid,
        userId,
        conversationId,
        count: listed.messages.length,
        queryMs: listed.metrics.queryMs,
        attachmentLookupMs: listed.metrics.attachmentLookupMs,
        totalMs: listed.metrics.totalMs,
        queriedRows: listed.metrics.queriedRows,
        returnedRows: listed.metrics.returnedRows,
      });
      return responseJson(request, {
        messages: listed.messages,
        nextCursor: listed.nextCursor,
      }, 200);
    }

    if (payload.action === "send") {
      const message = await sendMessage(payload, userId, context);
      conversationId = message.conversation_id;
      messageId = message.id;
      logStructured("info", "chat_message_send_success", context, {
        status: 200,
        uid: auth.uid,
        userId,
        conversationId,
        messageId,
        type: message.type,
        totalMs: getSafeElapsedMs(context),
      });
      return responseJson(request, { message }, 200);
    }

    if (payload.action === "edit") {
      const message = await editMessage(payload, userId, context);
      conversationId = message.conversation_id;
      messageId = message.id;
      logStructured("info", "chat_message_edit_success", context, {
        status: 200,
        uid: auth.uid,
        userId,
        conversationId,
        messageId,
        totalMs: getSafeElapsedMs(context),
      });
      return responseJson(request, { message }, 200);
    }

    const message = await deleteMessage(payload, userId, context);
    conversationId = message.conversation_id;
    messageId = message.id;
    logStructured("info", "chat_message_delete_success", context, {
      status: 200,
      uid: auth.uid,
      userId,
      conversationId,
      messageId,
      totalMs: getSafeElapsedMs(context),
    });
    return responseJson(request, { message }, 200);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    logStructured(status >= 500 ? "error" : "warn", "chat_messages_failure", context, {
      status,
      code,
      uid: context.uid ?? null,
      userId,
      conversationId,
      messageId,
      totalMs: getSafeElapsedMs(context),
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseError(request, context, sanitizeErrorForClient(error));
  }
});

/*
Recommended SQL for idempotent send:
create unique index if not exists messages_conversation_client_unique_idx
  on public.messages (conversation_id, client_id)
  where client_id is not null;
*/

