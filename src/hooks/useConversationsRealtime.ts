import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "../services/supabase";
import type { ChatMessageType } from "../services/chat/chatApi";
import { getSchemaCapability, setSchemaCapability } from "../services/database/schemaCapabilities";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATIONS_QUERY_VERSION = "v2";
const CONVERSATION_SELECT_COLUMNS = "id,type,created_by,name,avatar_url,user1_id,user2_id,created_at";
const LEGACY_CONVERSATION_SELECT_COLUMNS = "id,user1_id,user2_id,created_at";

export interface ConversationRealtimeRow {
  id: string;
  type: "dm" | "group_dm";
  created_by: string | null;
  name: string | null;
  avatar_url: string | null;
  user1_id: string | null;
  user2_id: string | null;
  created_at: string | null;
  last_activity_at: string | null;
}

interface ConversationRecord {
  id?: string | null;
  type?: string | null;
  created_by?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  user1_id?: string | null;
  user2_id?: string | null;
  created_at?: string | null;
}

interface MessageRecord {
  id?: string | null;
  conversation_id?: string | null;
  sender_id?: string | null;
  content?: string | null;
  type?: string | null;
  attachment?: unknown | null;
  created_at?: string | null;
}

interface ConversationMemberRecord {
  conversation_id?: string | null;
  user_id?: string | null;
}

export interface ConversationMessageInsertEvent {
  messageId: string;
  conversationId: string;
  authorId: string;
  contentPreview: string;
  messageType: ChatMessageType | null;
  attachmentMimeType: string | null;
  attachmentCount: number;
  createdAt: string | null;
}

interface UseConversationsRealtimeOptions {
  onMessageInsert?: ((event: ConversationMessageInsertEvent) => void) | null;
}

function isConversationSchemaCompatibilityError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string };
  const code = String(candidate.code ?? "").trim().toUpperCase();
  const message = String(candidate.message ?? "").toLowerCase();
  const details = String(candidate.details ?? "").toLowerCase();
  const hint = String(candidate.hint ?? "").toLowerCase();
  if (code === "PGRST204" || code === "42703") {
    return true;
  }
  return (
    message.includes("conversations") &&
    (message.includes("column") || details.includes("column") || hint.includes("column")) &&
    (
      message.includes("type")
      || message.includes("created_by")
      || message.includes("avatar_url")
      || message.includes("name")
      || details.includes("type")
      || details.includes("created_by")
      || details.includes("avatar_url")
      || details.includes("name")
    )
  );
}

function normalizeConversation(
  record: ConversationRecord | null | undefined,
  lastActivityAtOverride?: string | null,
): ConversationRealtimeRow | null {
  const id = String(record?.id ?? "").trim();
  if (!id) {
    return null;
  }

  const normalizedType = String(record?.type ?? "").trim().toLowerCase() === "group_dm" ? "group_dm" : "dm";
  const user1Id = String(record?.user1_id ?? "").trim() || null;
  const user2Id = String(record?.user2_id ?? "").trim() || null;
  if (normalizedType === "dm" && (!user1Id || !user2Id)) {
    return null;
  }

  return {
    id,
    type: normalizedType,
    created_by: String(record?.created_by ?? "").trim() || null,
    name: String(record?.name ?? "").trim() || null,
    avatar_url: String(record?.avatar_url ?? "").trim() || null,
    user1_id: user1Id,
    user2_id: user2Id,
    created_at: record?.created_at ? String(record.created_at) : null,
    last_activity_at:
      String(lastActivityAtOverride ?? record?.created_at ?? "").trim() || null,
  };
}

function removeConversationById(current: ConversationRealtimeRow[], id: string): ConversationRealtimeRow[] {
  return current.filter((item) => item.id !== id);
}

function upsertConversation(current: ConversationRealtimeRow[], nextItem: ConversationRealtimeRow): ConversationRealtimeRow[] {
  const without = current.filter((item) => item.id !== nextItem.id);
  return [nextItem, ...without];
}

function compareConversationsByActivity(left: ConversationRealtimeRow, right: ConversationRealtimeRow): number {
  const leftActivity = String(left.last_activity_at ?? left.created_at ?? "").trim();
  const rightActivity = String(right.last_activity_at ?? right.created_at ?? "").trim();
  if (leftActivity !== rightActivity) {
    return leftActivity < rightActivity ? 1 : -1;
  }
  return left.id.localeCompare(right.id);
}

function normalizeMessageConversationId(record: MessageRecord | null | undefined): string | null {
  const conversationId = String(record?.conversation_id ?? "").trim();
  return conversationId || null;
}

function sanitizeMessagePreview(rawValue: string | null | undefined): string {
  const normalized = String(rawValue ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 120);
}

function normalizeMessageType(rawValue: unknown): ChatMessageType | null {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (
    normalized === "text" ||
    normalized === "image" ||
    normalized === "video" ||
    normalized === "file"
  ) {
    return normalized;
  }
  return null;
}

function normalizeMessageInsertEvent(record: MessageRecord | null | undefined): ConversationMessageInsertEvent | null {
  const messageId = String(record?.id ?? "").trim();
  const conversationId = normalizeMessageConversationId(record);
  const authorId = String(record?.sender_id ?? "").trim();
  if (!messageId || !conversationId || !authorId) {
    return null;
  }

  const createdAtRaw = String(record?.created_at ?? "").trim();
  const createdAt = createdAtRaw || null;
  const messageType = normalizeMessageType(record?.type);
  const attachmentRaw =
    record && typeof record.attachment === "object" && record.attachment !== null
      ? (record.attachment as Record<string, unknown>)
      : null;
  const attachmentMimeType = String(attachmentRaw?.mimeType ?? attachmentRaw?.mime_type ?? "").trim().toLowerCase() || null;
  const attachmentCount = attachmentRaw ? 1 : 0;
  return {
    messageId,
    conversationId,
    authorId,
    contentPreview: sanitizeMessagePreview(record?.content),
    messageType,
    attachmentMimeType,
    attachmentCount,
    createdAt,
  };
}

async function fetchConversations(_currentUserId: string): Promise<ConversationRealtimeRow[]> {
  let rows: ConversationRecord[] = [];
  let shouldUseLegacyColumns = false;

  const conversationsExtendedColumnsSupported = getSchemaCapability("conversations_extended_columns");
  if (conversationsExtendedColumnsSupported !== false) {
    // Optimistically mark as unsupported while probing to avoid concurrent duplicate probes.
    if (conversationsExtendedColumnsSupported === null) {
      setSchemaCapability("conversations_extended_columns", false);
    }
    const primary = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT_COLUMNS)
      .order("created_at", { ascending: false });
    if (primary.error) {
      if (!isConversationSchemaCompatibilityError(primary.error)) {
        throw primary.error;
      }
      setSchemaCapability("conversations_extended_columns", false);
      shouldUseLegacyColumns = true;
    } else {
      setSchemaCapability("conversations_extended_columns", true);
      rows = Array.isArray(primary.data) ? (primary.data as ConversationRecord[]) : [];
    }
  } else {
    shouldUseLegacyColumns = true;
  }

  if (shouldUseLegacyColumns) {
    const legacy = await supabase
      .from("conversations")
      .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
      .order("created_at", { ascending: false });
    if (legacy.error) {
      throw legacy.error;
    }
    rows = Array.isArray(legacy.data) ? (legacy.data as ConversationRecord[]) : [];
  }

  const conversationIds = rows
    .map((row) => String(row.id ?? "").trim())
    .filter((conversationId) => Boolean(conversationId));
  const lastActivityByConversationId = new Map<string, string>();

  if (conversationIds.length > 0) {
    const { data: latestMessages } = await supabase
      .from("messages")
      .select("conversation_id,created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false });

    (Array.isArray(latestMessages) ? latestMessages : []).forEach((row) => {
      const conversationId = String((row as { conversation_id?: string | null }).conversation_id ?? "").trim();
      const createdAt = String((row as { created_at?: string | null }).created_at ?? "").trim();
      if (!conversationId || !createdAt || lastActivityByConversationId.has(conversationId)) {
        return;
      }
      lastActivityByConversationId.set(conversationId, createdAt);
    });
  }

  return rows
    .map((row) => normalizeConversation(row, lastActivityByConversationId.get(String(row.id ?? "").trim()) ?? null))
    .filter((row): row is ConversationRealtimeRow => row !== null)
    .sort(compareConversationsByActivity);
}

export function useConversationsRealtime(
  currentUserId: string | null | undefined,
  options?: UseConversationsRealtimeOptions,
) {
  const queryClient = useQueryClient();
  const normalizedUserId = String(currentUserId ?? "").trim();
  const hasValidUserId = UUID_REGEX.test(normalizedUserId);
  const onMessageInsertRef = useRef<UseConversationsRealtimeOptions["onMessageInsert"]>(
    options?.onMessageInsert ?? null,
  );
  const queryKey = useMemo(
    () => ["conversations", CONVERSATIONS_QUERY_VERSION, normalizedUserId] as const,
    [normalizedUserId],
  );

  const query = useQuery({
    queryKey,
    enabled: hasValidUserId,
    queryFn: () => fetchConversations(normalizedUserId),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const droppedRef = useRef(false);
  const hasSubscribedRef = useRef(false);

  useEffect(() => {
    onMessageInsertRef.current = options?.onMessageInsert ?? null;
  }, [options?.onMessageInsert]);

  useEffect(() => {
    if (!hasValidUserId) {
      return;
    }

    droppedRef.current = false;
    hasSubscribedRef.current = false;

    let isDisposed = false;
    let channel: RealtimeChannel | null = null;
    const invalidateConversationsQuery = (): void => {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    };

    const applyRealtimeChange = (payload: RealtimePostgresChangesPayload<ConversationRecord>): void => {
      const nextConversation = normalizeConversation(payload.new as ConversationRecord | null);
      const oldConversation = normalizeConversation(payload.old as ConversationRecord | null);
      const conversationId = String(nextConversation?.id ?? oldConversation?.id ?? "").trim();
      if (!conversationId) {
        return;
      }

      queryClient.setQueryData<ConversationRealtimeRow[]>(queryKey, (current) => {
        const safeCurrent = Array.isArray(current) ? current : [];
        if (payload.eventType === "DELETE" || !nextConversation) {
          return removeConversationById(safeCurrent, conversationId);
        }

        return upsertConversation(safeCurrent, nextConversation);
      });
    };

    const applyMessageChange = (payload: RealtimePostgresChangesPayload<MessageRecord>): void => {
      const normalizedEvent = normalizeMessageInsertEvent(payload.new as MessageRecord | null);
      const conversationId =
        normalizeMessageConversationId(payload.new as MessageRecord | null) ??
        normalizeMessageConversationId(payload.old as MessageRecord | null);
      if (!conversationId) {
        return;
      }

      let isRelevantConversation = false;
      queryClient.setQueryData<ConversationRealtimeRow[]>(queryKey, (current) => {
        const safeCurrent = Array.isArray(current) ? current : [];
        const existingConversation = safeCurrent.find((item) => item.id === conversationId);
        if (!existingConversation) {
          invalidateConversationsQuery();
          return safeCurrent;
        }
        isRelevantConversation = true;
        return upsertConversation(safeCurrent, {
          ...existingConversation,
          last_activity_at:
            normalizedEvent?.createdAt ??
            existingConversation.last_activity_at ??
            existingConversation.created_at,
        });
      });

      if (!isRelevantConversation) {
        return;
      }

      const onMessageInsert = onMessageInsertRef.current;
      if (!onMessageInsert) {
        return;
      }

      if (!normalizedEvent) {
        return;
      }
      onMessageInsert(normalizedEvent);
    };

    const applyConversationMemberChange = (
      payload: RealtimePostgresChangesPayload<ConversationMemberRecord>,
    ): void => {
      const nextRecord = (payload.new ?? null) as ConversationMemberRecord | null;
      const previousRecord = (payload.old ?? null) as ConversationMemberRecord | null;
      const conversationId = String(
        nextRecord?.conversation_id
        ?? previousRecord?.conversation_id
        ?? "",
      ).trim();
      const affectedUserId = String(
        nextRecord?.user_id
        ?? previousRecord?.user_id
        ?? "",
      ).trim();

      if (affectedUserId === normalizedUserId) {
        invalidateConversationsQuery();
        return;
      }

      if (!conversationId) {
        return;
      }

      let isRelevantConversation = false;
      queryClient.setQueryData<ConversationRealtimeRow[]>(queryKey, (current) => {
        const safeCurrent = Array.isArray(current) ? current : [];
        isRelevantConversation = safeCurrent.some((item) => item.id === conversationId);
        return safeCurrent;
      });

      if (isRelevantConversation) {
        invalidateConversationsQuery();
      }
    };

    const bootstrapTimer = window.setTimeout(() => {
      if (isDisposed) {
        return;
      }

      channel = supabase
        .channel(`realtime:conversations:${normalizedUserId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversations" },
          applyRealtimeChange,
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversation_members" },
          applyConversationMemberChange,
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          applyMessageChange,
        )
        .subscribe((channelStatus) => {
          if (isDisposed) {
            return;
          }

          if (channelStatus === "SUBSCRIBED") {
            if (hasSubscribedRef.current && droppedRef.current) {
              droppedRef.current = false;
              void queryClient.invalidateQueries({ queryKey, exact: true });
            }
            hasSubscribedRef.current = true;
            return;
          }

          if (
            channelStatus === "TIMED_OUT" ||
            channelStatus === "CHANNEL_ERROR" ||
            channelStatus === "CLOSED"
          ) {
            droppedRef.current = true;
          }
        });
    }, 0);

    return () => {
      isDisposed = true;
      window.clearTimeout(bootstrapTimer);
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [hasValidUserId, normalizedUserId, queryClient, queryKey]);

  return query;
}
