import { z } from "zod";
import { EdgeFunctionError, invokeEdgeGet, invokeEdgeJson } from "../edge/edgeClient";
import { authService } from "../auth";
import { isDirectUsersRestBlocked, supabase } from "../supabase";

export type FriendRequestStatusFilter = "pending" | "accepted";
export type FriendRequestMutationStatus = "accepted" | "rejected";

const friendRequestRowSchema = z.object({
  id: z.string().uuid(),
  requester_id: z.string().uuid(),
  addressee_id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "rejected"]),
  created_at: z.string().nullable(),
});

export type FriendRequestListRow = z.infer<typeof friendRequestRowSchema>;

const friendRequestMutationResponseSchema = z.object({
  request: friendRequestRowSchema.nullable().optional(),
  deleted: z.boolean().optional(),
  deletedCount: z.number().int().nonnegative().optional(),
});

let friendRequestsReadViaEdge = isDirectUsersRestBlocked();
let friendRequestsWriteViaEdge = isDirectUsersRestBlocked();

function shouldFallbackToEdgeFriendRequests(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  if (status === 0 || status === 401 || status === 403) {
    return true;
  }

  if (error instanceof EdgeFunctionError && error.code === "EDGE_NETWORK_ERROR") {
    return true;
  }

  return (
    code === "EDGE_NETWORK_ERROR" ||
    message.includes("failed to fetch") ||
    message.includes("cors") ||
    message.includes("access-control-allow-origin") ||
    message.includes("net::err_failed") ||
    message.includes("load failed")
  );
}

async function listFriendRequestsViaEdge(status: FriendRequestStatusFilter): Promise<FriendRequestListRow[]> {
  const response = await invokeEdgeGet<{ requests?: unknown[] }>("friend-requests", {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
    query: {
      status,
    },
  });

  return z.array(friendRequestRowSchema).parse((response?.requests ?? []) as unknown[]);
}

export async function listFriendRequests(
  status: FriendRequestStatusFilter = "pending",
  currentUserIdOverride?: string | null | undefined,
): Promise<FriendRequestListRow[]> {
  const authUserId = String(currentUserIdOverride ?? (await authService.getCurrentUserId()) ?? "").trim();
  if (!authUserId) {
    return [];
  }

  if (!friendRequestsReadViaEdge) {
    const { data, error } = await supabase
      .from("friend_requests")
      .select("id,requester_id,addressee_id,status,created_at")
      .or(`requester_id.eq.${authUserId},addressee_id.eq.${authUserId}`)
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (!error) {
      return z.array(friendRequestRowSchema).parse((data ?? []) as unknown[]);
    }

    if (!shouldFallbackToEdgeFriendRequests(error)) {
      throw error;
    }

    friendRequestsReadViaEdge = true;
  }

  return listFriendRequestsViaEdge(status);
}

export async function createFriendRequest(addresseeId: string): Promise<FriendRequestListRow> {
  const normalizedAddresseeId = String(addresseeId ?? "").trim();
  if (!normalizedAddresseeId) {
    throw new Error("Addressee id invalido.");
  }

  if (!friendRequestsWriteViaEdge) {
    const { data, error } = await supabase
      .from("friend_requests")
      .insert({
        addressee_id: normalizedAddresseeId,
        status: "pending",
      })
      .select("id,requester_id,addressee_id,status,created_at")
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      return friendRequestRowSchema.parse(data);
    }

    if (!shouldFallbackToEdgeFriendRequests(error)) {
      throw error;
    }

    friendRequestsWriteViaEdge = true;
  }

  const response = await invokeEdgeJson<
    {
      action: "create";
      addresseeId: string;
    },
    unknown
  >("friend-requests", {
    action: "create",
    addresseeId: normalizedAddresseeId,
  }, {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
  });

  const request = friendRequestMutationResponseSchema.parse(response).request ?? null;
  if (!request) {
    throw new Error("Friend request nao retornada pela Edge Function.");
  }
  return request;
}

export async function updateFriendRequestStatus(
  requestId: string,
  status: FriendRequestMutationStatus,
): Promise<FriendRequestListRow | null> {
  const normalizedRequestId = String(requestId ?? "").trim();
  if (!normalizedRequestId) {
    throw new Error("Friend request id invalido.");
  }

  if (!friendRequestsWriteViaEdge) {
    const { data, error } = await supabase
      .from("friend_requests")
      .update({ status })
      .eq("id", normalizedRequestId)
      .select("id,requester_id,addressee_id,status,created_at")
      .limit(1)
      .maybeSingle();

    if (!error) {
      return data ? friendRequestRowSchema.parse(data) : null;
    }

    if (!shouldFallbackToEdgeFriendRequests(error)) {
      throw error;
    }

    friendRequestsWriteViaEdge = true;
  }

  const response = await invokeEdgeJson<
    {
      action: "updateStatus";
      requestId: string;
      status: FriendRequestMutationStatus;
    },
    unknown
  >("friend-requests", {
    action: "updateStatus",
    requestId: normalizedRequestId,
    status,
  }, {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
  });

  return friendRequestMutationResponseSchema.parse(response).request ?? null;
}

export async function acceptFriendRequest(requestId: string): Promise<FriendRequestListRow | null> {
  return updateFriendRequestStatus(requestId, "accepted");
}

export async function rejectFriendRequest(requestId: string): Promise<FriendRequestListRow | null> {
  return updateFriendRequestStatus(requestId, "rejected");
}

export async function deleteFriendRequest(requestId: string): Promise<void> {
  const normalizedRequestId = String(requestId ?? "").trim();
  if (!normalizedRequestId) {
    return;
  }

  if (!friendRequestsWriteViaEdge) {
    const { error } = await supabase.from("friend_requests").delete().eq("id", normalizedRequestId);
    if (!error) {
      return;
    }

    if (!shouldFallbackToEdgeFriendRequests(error)) {
      throw error;
    }

    friendRequestsWriteViaEdge = true;
  }

  await invokeEdgeJson<
    {
      action: "delete";
      requestId: string;
    },
    unknown
  >("friend-requests", {
    action: "delete",
    requestId: normalizedRequestId,
  }, {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
  });
}

export async function deleteFriendRequestsBetweenUsers(otherUserId: string): Promise<number> {
  const normalizedCurrentUserId = String(await authService.getCurrentUserId() ?? "").trim();
  const normalizedOtherUserId = String(otherUserId ?? "").trim();
  if (!normalizedCurrentUserId || !normalizedOtherUserId) {
    return 0;
  }

  if (!friendRequestsWriteViaEdge) {
    const [deleteOutgoingResult, deleteIncomingResult] = await Promise.all([
      supabase
        .from("friend_requests")
        .delete()
        .eq("requester_id", normalizedCurrentUserId)
        .eq("addressee_id", normalizedOtherUserId),
      supabase
        .from("friend_requests")
        .delete()
        .eq("requester_id", normalizedOtherUserId)
        .eq("addressee_id", normalizedCurrentUserId),
    ]);

    if (!deleteOutgoingResult.error && !deleteIncomingResult.error) {
      return 0;
    }

    const firstError = deleteOutgoingResult.error ?? deleteIncomingResult.error;
    if (!shouldFallbackToEdgeFriendRequests(firstError)) {
      throw firstError;
    }

    friendRequestsWriteViaEdge = true;
  }

  const response = await invokeEdgeJson<
    {
      action: "deletePair";
      otherUserId: string;
    },
    unknown
  >("friend-requests", {
    action: "deletePair",
    otherUserId: normalizedOtherUserId,
  }, {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
  });

  return friendRequestMutationResponseSchema.parse(response).deletedCount ?? 0;
}
