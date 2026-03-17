import { z } from "zod";
import { supabase } from "../supabase";
import { authService } from "../auth";

export type FriendRequestStatusFilter = "pending" | "accepted";

const friendRequestRowSchema = z.object({
  id: z.string().uuid(),
  requester_id: z.string().uuid(),
  addressee_id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "rejected"]),
  created_at: z.string().nullable(),
});

export type FriendRequestListRow = z.infer<typeof friendRequestRowSchema>;

export async function listFriendRequests(
  status: FriendRequestStatusFilter = "pending",
  currentUserIdOverride?: string | null | undefined,
): Promise<FriendRequestListRow[]> {
  const authUserId = String(currentUserIdOverride ?? (await authService.getCurrentUserId()) ?? "").trim();
  if (!authUserId) {
    return [];
  }

  const { data, error } = await supabase
    .from("friend_requests")
    .select("id,requester_id,addressee_id,status,created_at")
    .or(`requester_id.eq.${authUserId},addressee_id.eq.${authUserId}`)
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return z.array(friendRequestRowSchema).parse((data ?? []) as unknown[]);
}
