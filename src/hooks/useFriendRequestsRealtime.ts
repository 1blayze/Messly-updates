import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "../services/supabase";
import { listFriendRequests, type FriendRequestListRow, type FriendRequestStatusFilter } from "../services/friends/friendRequestsApi";

type FriendRequestStatus = FriendRequestListRow["status"];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FriendRequestRecord {
  id?: string | null;
  requester_id?: string | null;
  addressee_id?: string | null;
  status?: FriendRequestStatus | null;
  created_at?: string | null;
}

function normalizeFriendRequestRecord(record: FriendRequestRecord | null | undefined): FriendRequestListRow | null {
  const id = String(record?.id ?? "").trim();
  const requesterId = String(record?.requester_id ?? "").trim();
  const addresseeId = String(record?.addressee_id ?? "").trim();
  const statusRaw = String(record?.status ?? "").trim().toLowerCase();
  const status: FriendRequestStatus | null =
    statusRaw === "pending" || statusRaw === "accepted" || statusRaw === "rejected"
      ? (statusRaw as FriendRequestStatus)
      : null;

  if (!id || !requesterId || !addresseeId || !status) {
    return null;
  }

  return {
    id,
    requester_id: requesterId,
    addressee_id: addresseeId,
    status,
    created_at: record?.created_at ? String(record.created_at) : null,
  };
}

function involvesCurrentUser(row: FriendRequestListRow, currentUserId: string): boolean {
  return row.requester_id === currentUserId || row.addressee_id === currentUserId;
}

function upsertPendingAtTop(current: FriendRequestListRow[], nextItem: FriendRequestListRow): FriendRequestListRow[] {
  const without = current.filter((item) => item.id !== nextItem.id);
  return [nextItem, ...without];
}

function removeById(current: FriendRequestListRow[], id: string): FriendRequestListRow[] {
  return current.filter((item) => item.id !== id);
}

export function useFriendRequestsRealtime(
  currentUserId: string | null | undefined,
  status: FriendRequestStatusFilter = "pending",
) {
  const queryClient = useQueryClient();
  const normalizedUserId = String(currentUserId ?? "").trim();
  const hasValidUserId = UUID_REGEX.test(normalizedUserId);
  const queryKey = useMemo(
    () => ["friend_requests", normalizedUserId, status] as const,
    [normalizedUserId, status],
  );

  const query = useQuery({
    queryKey,
    enabled: hasValidUserId,
    queryFn: () => listFriendRequests(status),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const droppedRef = useRef(false);
  const hasSubscribedRef = useRef(false);

  useEffect(() => {
    if (!hasValidUserId) {
      return;
    }

    droppedRef.current = false;
    hasSubscribedRef.current = false;

    let isDisposed = false;
    let channel: RealtimeChannel | null = null;

    const applyRealtimeChange = (payload: RealtimePostgresChangesPayload<FriendRequestRecord>): void => {
      const nextRow = normalizeFriendRequestRecord(payload.new as FriendRequestRecord | null);
      const oldRow = normalizeFriendRequestRecord(payload.old as FriendRequestRecord | null);
      const rowId = String(nextRow?.id ?? oldRow?.id ?? "").trim();
      if (!rowId) {
        return;
      }

      queryClient.setQueryData<FriendRequestListRow[]>(queryKey, (current) => {
        const safeCurrent = Array.isArray(current) ? current : [];
        const relevantRow = nextRow ?? oldRow;
        const isRelevant = Boolean(
          relevantRow &&
            involvesCurrentUser(relevantRow, normalizedUserId) &&
            relevantRow.status === status,
        );

        if (payload.eventType === "DELETE" || !isRelevant || !nextRow) {
          return removeById(safeCurrent, rowId);
        }

        if (payload.eventType === "INSERT") {
          return upsertPendingAtTop(safeCurrent, nextRow);
        }

        return upsertPendingAtTop(safeCurrent, nextRow);
      });
    };

    channel = supabase
      .channel(`realtime:friend_requests:${normalizedUserId}:${status}`)
      // NOTE: Postgres Changes does not support OR filters for requester/addressee reliably.
      // We subscribe to table events and filter on client by currentUserId.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friend_requests" },
        applyRealtimeChange,
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

    return () => {
      isDisposed = true;
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [hasValidUserId, normalizedUserId, queryClient, queryKey, status]);

  return query;
}
