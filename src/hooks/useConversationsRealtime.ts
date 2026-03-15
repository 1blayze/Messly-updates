import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "../services/supabase";
import type { ChatMessageType } from "../services/chat/chatApi";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConversationRealtimeRow {
  id: string;
  user1_id: string;
  user2_id: string;
  created_at: string | null;
}

interface ConversationRecord {
  id?: string | null;
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

function normalizeConversation(record: ConversationRecord | null | undefined): ConversationRealtimeRow | null {
  const id = String(record?.id ?? "").trim();
  const user1Id = String(record?.user1_id ?? "").trim();
  const user2Id = String(record?.user2_id ?? "").trim();
  if (!id || !user1Id || !user2Id) {
    return null;
  }

  return {
    id,
    user1_id: user1Id,
    user2_id: user2Id,
    created_at: record?.created_at ? String(record.created_at) : null,
  };
}

function isRelevantConversation(row: ConversationRealtimeRow, currentUserId: string): boolean {
  return row.user1_id === currentUserId || row.user2_id === currentUserId;
}

function removeConversationById(current: ConversationRealtimeRow[], id: string): ConversationRealtimeRow[] {
  return current.filter((item) => item.id !== id);
}

function upsertConversation(current: ConversationRealtimeRow[], nextItem: ConversationRealtimeRow): ConversationRealtimeRow[] {
  const without = current.filter((item) => item.id !== nextItem.id);
  return [nextItem, ...without];
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

async function fetchConversations(currentUserId: string): Promise<ConversationRealtimeRow[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id,user1_id,user2_id,created_at")
    .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? (data as ConversationRecord[]) : [];
  return rows
    .map((row) => normalizeConversation(row))
    .filter((row): row is ConversationRealtimeRow => row !== null);
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
    () => ["conversations", normalizedUserId] as const,
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

    const applyRealtimeChange = (payload: RealtimePostgresChangesPayload<ConversationRecord>): void => {
      const nextConversation = normalizeConversation(payload.new as ConversationRecord | null);
      const oldConversation = normalizeConversation(payload.old as ConversationRecord | null);
      const conversationId = String(nextConversation?.id ?? oldConversation?.id ?? "").trim();
      if (!conversationId) {
        return;
      }

      queryClient.setQueryData<ConversationRealtimeRow[]>(queryKey, (current) => {
        const safeCurrent = Array.isArray(current) ? current : [];
        const relevantConversation = nextConversation ?? oldConversation;
        const isRelevant = Boolean(
          relevantConversation && isRelevantConversation(relevantConversation, normalizedUserId),
        );

        if (payload.eventType === "DELETE" || !isRelevant || !nextConversation) {
          return removeConversationById(safeCurrent, conversationId);
        }

        return upsertConversation(safeCurrent, nextConversation);
      });
    };

    const applyMessageChange = (payload: RealtimePostgresChangesPayload<MessageRecord>): void => {
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
          return safeCurrent;
        }
        isRelevantConversation = true;
        return upsertConversation(safeCurrent, existingConversation);
      });

      if (!isRelevantConversation) {
        return;
      }

      const onMessageInsert = onMessageInsertRef.current;
      if (!onMessageInsert) {
        return;
      }

      const normalizedEvent = normalizeMessageInsertEvent(payload.new as MessageRecord | null);
      if (!normalizedEvent) {
        return;
      }
      onMessageInsert(normalizedEvent);
    };

    const bootstrapTimer = window.setTimeout(() => {
      if (isDisposed) {
        return;
      }

      channel = supabase
        .channel(`realtime:conversations:${normalizedUserId}`)
        // NOTE: Postgres Changes does not support OR filters for user1_id/user2_id reliably.
        // We subscribe to table events and filter on client by currentUserId.
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversations" },
          applyRealtimeChange,
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
