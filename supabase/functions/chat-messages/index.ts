import { z } from "npm:zod@3.25.76";
import { validateFirebaseToken } from "../_shared/auth.ts";
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
} from "../_shared/http.ts";
import { parseAttachmentConversationId, sanitizeMediaKey } from "../_shared/mediaSecurity.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { assertConversationMembership, resolveUserIdByFirebaseUid } from "../_shared/user.ts";

const ROUTE = "chat-messages";
const MAX_TEXT_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MESSAGE_SELECT_COLUMNS =
  "id,conversation_id,sender_id,client_id,content,type,created_at,edited_at,deleted_at,reply_to_id,reply_to_snapshot,call_id,payload";
const ATTACHMENT_SELECT_COLUMNS =
  "message_id,file_key,original_key,thumb_key,mime_type,file_size,width,height,thumb_width,thumb_height,codec,duration_ms";

const replySnapshotSchema = z
  .object({
    author_id: z.string().max(64).optional().nullable(),
    author_name: z.string().max(120).optional().nullable(),
    author_avatar: z.string().max(1024).optional().nullable(),
    snippet: z.string().max(240).optional().nullable(),
    message_type: z.string().max(24).optional().nullable(),
    created_at: z.string().max(64).optional().nullable(),
  })
  .passthrough()
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

const sendPayloadSchema = z
  .object({
    action: z.literal("send"),
    conversationId: z.string().uuid(),
    clientId: z.string().min(8).max(128),
    content: z.string().max(MAX_TEXT_LENGTH).optional().nullable(),
    type: z.enum(["text", "image", "video", "file"]).default("text"),
    replyToId: z.string().uuid().optional().nullable(),
    replyToSnapshot: replySnapshotSchema,
    attachment: attachmentPayloadSchema.optional().nullable(),
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
    cursorCreatedAt: z
      .string()
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value)), "cursorCreatedAt invalido.")
      .optional()
      .nullable(),
    cursorId: z.string().uuid().optional().nullable(),
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
  type: string | null;
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
  type: string;
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

function normalizeTextContent(rawContent: string | null | undefined): string {
  const value = String(rawContent ?? "");
  const withoutNullBytes = value.replace(/\u0000/g, "");
  const sanitized = withoutNullBytes.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return sanitized.slice(0, MAX_TEXT_LENGTH);
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

function parsePayload(payload: unknown): InputPayload {
  const result = inputSchema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  });
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
  const messageType = toOptionalString(row.type) ?? toOptionalString(row.message_type) ?? "text";

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
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    client_id: row.client_id ?? null,
    content: String(row.content ?? ""),
    type: String(row.type ?? "text"),
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
    deleted_at: row.deleted_at ?? null,
    reply_to_id: row.reply_to_id ?? null,
    reply_to_snapshot: row.reply_to_snapshot ?? null,
    call_id: row.call_id ?? null,
    payload: row.payload ?? null,
    attachment: attachmentRow
      ? {
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
        }
      : null,
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

async function loadAttachmentMap(messageIds: string[]): Promise<Map<string, AttachmentRow>> {
  const uniqueIds = [...new Set(messageIds.filter((id) => Boolean(id)))];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from("attachments").select(ATTACHMENT_SELECT_COLUMNS).in("message_id", uniqueIds);

  if (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        route: ROUTE,
        message: "attachments_lookup_failed",
        code: error.code ?? null,
        hint: error.hint ?? null,
      }),
    );
    return new Map();
  }

  const mapped = new Map<string, AttachmentRow>();
  for (const rawRow of data ?? []) {
    const row = normalizeAttachmentRow(rawRow);
    if (!row || mapped.has(row.message_id)) {
      continue;
    }
    mapped.set(row.message_id, row);
  }

  return mapped;
}

async function loadMessageById(messageId: string): Promise<MessageWithAttachment | null> {
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

  const normalized = normalizeMessageRow(data);
  if (!normalized) {
    return null;
  }

  const attachmentMap = await loadAttachmentMap([normalized.id]);
  return mapMessage(normalized, attachmentMap.get(normalized.id) ?? null);
}

interface ListMessagesMetrics {
  queryMs: number;
  attachmentLookupMs: number;
  totalMs: number;
  queriedRows: number;
  returnedRows: number;
}

async function listMessages(payload: ListPayload, userId: string): Promise<{
  messages: MessageWithAttachment[];
  nextCursor: null | { createdAt: string; id: string };
  metrics: ListMessagesMetrics;
}> {
  const supabase = getSupabaseAdminClient();
  await assertConversationMembership(payload.conversationId, userId);

  const limit = payload.limit ?? DEFAULT_PAGE_SIZE;
  const paginationSlack = payload.cursorCreatedAt && payload.cursorId ? 60 : 1;
  const totalStartedAt = Date.now();

  const queryStartedAt = Date.now();
  let query = supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", payload.conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + paginationSlack);

  if (payload.cursorCreatedAt) {
    query = query.lte("created_at", payload.cursorCreatedAt);
  }

  const { data, error } = await query;
  const queryMs = Date.now() - queryStartedAt;

  if (error) {
    throw new HttpError(500, "LIST_MESSAGES_FAILED", "Falha ao listar mensagens.", {
      code: error.code ?? null,
      hint: error.hint ?? null,
      details: error.details ?? null,
    });
  }

  let rows = (data ?? []).map(normalizeMessageRow).filter((row): row is MessageRow => Boolean(row)).sort(compareDesc);

  if (payload.cursorCreatedAt && payload.cursorId) {
    rows = rows.filter((row) => {
      if (row.created_at < payload.cursorCreatedAt!) {
        return true;
      }
      if (row.created_at > payload.cursorCreatedAt!) {
        return false;
      }
      return row.id < payload.cursorId!;
    });
  }

  const hasMore = rows.length > limit;
  const windowedRows = rows.slice(0, limit);
  const attachmentLookupStartedAt = Date.now();
  const attachmentMap = await loadAttachmentMap(windowedRows.map((row) => row.id));
  const attachmentLookupMs = Date.now() - attachmentLookupStartedAt;
  const mapped = windowedRows
    .map((row) => mapMessage(row, attachmentMap.get(row.id) ?? null))
    .sort(compareAsc);

  const oldest = windowedRows[windowedRows.length - 1];

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
    throw new HttpError(500, "REPLY_VALIDATION_FAILED", "Falha ao validar reply_to_id.");
  }

  const row = data as { id?: string; conversation_id?: string } | null;
  if (!row?.id || !row.conversation_id) {
    throw new HttpError(400, "INVALID_REPLY", "reply_to_id nao encontrado.");
  }

  if (row.conversation_id !== conversationId) {
    throw new HttpError(400, "INVALID_REPLY", "reply_to_id nao pertence a mesma conversa.");
  }
}

async function insertAttachmentMetadata(
  messageId: string,
  conversationId: string,
  attachment: NonNullable<SendPayload["attachment"]>,
): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const primaryInsert = await supabase.from("attachments").insert({
    message_id: messageId,
    conversation_id: conversationId,
    file_key: attachment.fileKey,
    original_key: attachment.originalKey ?? null,
    thumb_key: attachment.thumbKey ?? null,
    file_size: attachment.fileSize ?? null,
    mime_type: attachment.mimeType ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    thumb_width: attachment.thumbWidth ?? null,
    thumb_height: attachment.thumbHeight ?? null,
    codec: attachment.codec ?? null,
    duration_ms: attachment.durationMs ?? null,
  });

  if (!primaryInsert.error) {
    return;
  }

  const fallbackInsert = await supabase.from("attachments").insert({
    message_id: messageId,
    file_key: attachment.fileKey,
    file_size: attachment.fileSize ?? null,
    mime_type: attachment.mimeType ?? null,
  });

  if (fallbackInsert.error) {
    throw new HttpError(500, "ATTACHMENT_SAVE_FAILED", "Falha ao registrar metadados do anexo.");
  }
}

async function sendMessage(payload: SendPayload, userId: string): Promise<MessageWithAttachment> {
  await assertConversationMembership(payload.conversationId, userId);

  if (payload.replyToId) {
    await assertReplyMessageBelongsToConversation(payload.replyToId, payload.conversationId);
  }

  const messageType = payload.type;
  let normalizedContent = normalizeTextContent(payload.content ?? "");

  if (messageType === "text") {
    normalizedContent = normalizedContent.trim();
    if (!normalizedContent) {
      throw new HttpError(400, "EMPTY_MESSAGE", "Mensagem vazia nao pode ser enviada.");
    }
  } else {
    const attachmentKey = payload.attachment?.fileKey ?? payload.content;
    const safeKey = sanitizeMediaKey(attachmentKey);
    normalizedContent = safeKey;

    if (!safeKey.startsWith("attachments/")) {
      throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Anexos devem usar prefixo attachments/.");
    }

    const keyConversationId = parseAttachmentConversationId(safeKey);
    if (!keyConversationId || keyConversationId !== payload.conversationId) {
      throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Anexo nao pertence a conversationId informada.");
    }
  }

  if (payload.attachment) {
    const attachmentKeys = [
      payload.attachment.fileKey,
      payload.attachment.thumbKey ?? null,
      payload.attachment.originalKey ?? null,
    ].filter((value): value is string => Boolean(value));

    for (const key of attachmentKeys) {
      const safeAttachmentKey = sanitizeMediaKey(key);
      const keyConversationId = parseAttachmentConversationId(safeAttachmentKey);
      if (!keyConversationId || keyConversationId !== payload.conversationId) {
        throw new HttpError(400, "INVALID_ATTACHMENT_KEY", "Metadado de anexo fora da conversa.");
      }
    }
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
      reply_to_snapshot: payload.replyToSnapshot ?? null,
    })
    .select(MESSAGE_SELECT_COLUMNS)
    .limit(1)
    .single();

  if (insertResult.error || !insertResult.data) {
    if (insertResult.error?.code === "23505") {
      const existing = await supabase
        .from("messages")
        .select(MESSAGE_SELECT_COLUMNS)
        .eq("conversation_id", payload.conversationId)
        .eq("client_id", payload.clientId)
        .limit(1)
        .maybeSingle();

      if (!existing.error) {
        const existingRow = normalizeMessageRow(existing.data);
        if (existingRow) {
          const hydrated = await loadMessageById(existingRow.id);
          if (hydrated) {
            return hydrated;
          }

          return mapMessage(existingRow, null);
        }
      }
    }

    throw new HttpError(500, "SEND_MESSAGE_FAILED", "Falha ao enviar mensagem.");
  }

  const insertedMessage = normalizeMessageRow(insertResult.data);
  if (!insertedMessage) {
    throw new HttpError(500, "SEND_MESSAGE_FAILED", "Falha ao enviar mensagem.");
  }

  if (payload.attachment && messageType !== "text") {
    await insertAttachmentMetadata(insertedMessage.id, payload.conversationId, payload.attachment);
  }

  const hydrated = await loadMessageById(insertedMessage.id);
  if (hydrated) {
    return hydrated;
  }

  const payloadAttachment: AttachmentRow | null = payload.attachment
    ? {
        message_id: insertedMessage.id,
        file_key: payload.attachment.fileKey,
        original_key: payload.attachment.originalKey ?? null,
        thumb_key: payload.attachment.thumbKey ?? null,
        mime_type: payload.attachment.mimeType ?? null,
        file_size: payload.attachment.fileSize ?? null,
        width: payload.attachment.width ?? null,
        height: payload.attachment.height ?? null,
        thumb_width: payload.attachment.thumbWidth ?? null,
        thumb_height: payload.attachment.thumbHeight ?? null,
        codec: payload.attachment.codec ?? null,
        duration_ms: payload.attachment.durationMs ?? null,
      }
    : null;

  return mapMessage(insertedMessage, payloadAttachment);
}

async function editMessage(payload: EditPayload, userId: string): Promise<MessageWithAttachment> {
  const supabase = getSupabaseAdminClient();
  const existing = await supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("id", payload.messageId)
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    throw new HttpError(500, "EDIT_LOOKUP_FAILED", "Falha ao carregar mensagem para edicao.");
  }

  const row = normalizeMessageRow(existing.data);
  if (!row?.id || !row.sender_id) {
    throw new HttpError(404, "MESSAGE_NOT_FOUND", "Mensagem nao encontrada.");
  }

  if (row.sender_id !== userId) {
    throw new HttpError(403, "FORBIDDEN", "Somente o autor pode editar a mensagem.");
  }

  if (row.type !== "text") {
    throw new HttpError(400, "MESSAGE_NOT_EDITABLE", "Somente mensagens de texto podem ser editadas.");
  }

  if (row.deleted_at) {
    throw new HttpError(400, "MESSAGE_DELETED", "Mensagem excluida nao pode ser editada.");
  }

  const normalizedContent = normalizeTextContent(payload.content).trim();
  if (!normalizedContent) {
    throw new HttpError(400, "EMPTY_MESSAGE", "Mensagem vazia nao pode ser salva.");
  }

  const { data, error } = await supabase
    .from("messages")
    .update({
      content: normalizedContent,
      edited_at: new Date().toISOString(),
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

  const hydrated = await loadMessageById(normalized.id);
  if (hydrated) {
    return hydrated;
  }

  return mapMessage(normalized, null);
}

async function deleteMessage(payload: DeletePayload, userId: string): Promise<MessageWithAttachment> {
  const supabase = getSupabaseAdminClient();
  const existing = await supabase
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("id", payload.messageId)
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    throw new HttpError(500, "DELETE_LOOKUP_FAILED", "Falha ao carregar mensagem para exclusao.");
  }

  const row = normalizeMessageRow(existing.data);
  if (!row?.id || !row.sender_id) {
    throw new HttpError(404, "MESSAGE_NOT_FOUND", "Mensagem nao encontrada.");
  }

  if (row.sender_id !== userId) {
    throw new HttpError(403, "FORBIDDEN", "Somente o autor pode excluir a mensagem.");
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

  const hydrated = await loadMessageById(normalized.id);
  if (hydrated) {
    return hydrated;
  }

  return mapMessage(normalized, null);
}

async function enforceActionRateLimits(uid: string, payload: InputPayload): Promise<void> {
  if (payload.action === "send") {
    await enforceRateLimit(`send:${uid}`, 5, 5_000, ROUTE, {
      action: payload.action,
    });
    await enforceRateLimit(`send-burst:${uid}`, 3, 1_000, ROUTE, {
      action: payload.action,
    });
    if (payload.type !== "text") {
      await enforceRateLimit(`send-attachment:${uid}`, 20, 60_000, ROUTE, {
        action: payload.action,
      });
    }
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

Deno.serve(async (request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");

    const auth = await validateFirebaseToken(request);
    context.uid = auth.uid;

    const rawPayload = await parseJsonBody<unknown>(request);
    const payload = parsePayload(rawPayload);
    context.action = payload.action;

    await enforceActionRateLimits(auth.uid, payload);

    const userId = await resolveUserIdByFirebaseUid(auth.uid, auth.email);

    if (payload.action === "list") {
      const listed = await listMessages(payload, userId);
      const responsePayload = {
        messages: listed.messages,
        nextCursor: listed.nextCursor,
      };
      logStructured("info", "chat_messages_list_success", context, {
        status: 200,
        count: listed.messages.length,
        queryMs: listed.metrics.queryMs,
        attachmentLookupMs: listed.metrics.attachmentLookupMs,
        totalMs: listed.metrics.totalMs,
        queriedRows: listed.metrics.queriedRows,
        returnedRows: listed.metrics.returnedRows,
      });
      return responseJson(request, responsePayload, 200);
    }

    if (payload.action === "send") {
      const message = await sendMessage(payload, userId);
      logStructured("info", "chat_message_send_success", context, {
        status: 200,
        messageId: message.id,
        type: message.type,
      });
      return responseJson(request, { message }, 200);
    }

    if (payload.action === "edit") {
      const message = await editMessage(payload, userId);
      logStructured("info", "chat_message_edit_success", context, {
        status: 200,
        messageId: message.id,
      });
      return responseJson(request, { message }, 200);
    }

    const message = await deleteMessage(payload, userId);
    logStructured("info", "chat_message_delete_success", context, {
      status: 200,
      messageId: message.id,
    });
    return responseJson(request, { message }, 200);
  } catch (error) {
    logStructured("error", "chat_messages_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });

    return responseError(request, context, error);
  }
});
