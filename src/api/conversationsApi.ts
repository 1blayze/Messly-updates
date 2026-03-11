import { supabase } from "./client";
import type { ConversationEntity } from "../stores/entities";

interface ConversationRow {
  id: string;
  user1_id: string;
  user2_id: string;
  created_at: string | null;
}

function mapConversationRow(row: ConversationRow): ConversationEntity {
  return {
    id: row.id,
    scopeType: "dm",
    scopeId: row.id,
    participantIds: [row.user1_id, row.user2_id],
    lastMessageId: null,
    lastMessageAt: row.created_at,
    unreadCount: 0,
    typingUserIds: [],
    updatedAt: row.created_at,
  };
}

export async function listDirectConversations(currentUserId: string): Promise<ConversationEntity[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id,user1_id,user2_id,created_at")
    .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return ((data ?? []) as ConversationRow[]).map(mapConversationRow);
}

export async function ensureDirectConversation(userA: string, userB: string): Promise<ConversationEntity> {
  const [left, right] = [String(userA ?? "").trim(), String(userB ?? "").trim()].sort();
  if (!left || !right || left === right) {
    throw new Error("Participantes invalidos para criar DM.");
  }

  const existing = await supabase
    .from("conversations")
    .select("id,user1_id,user2_id,created_at")
    .eq("user1_id", left)
    .eq("user2_id", right)
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }

  if (existing.data) {
    return mapConversationRow(existing.data as ConversationRow);
  }

  const inserted = await supabase
    .from("conversations")
    .insert({
      user1_id: left,
      user2_id: right,
    })
    .select("id,user1_id,user2_id,created_at")
    .limit(1)
    .maybeSingle();

  if (inserted.error) {
    throw inserted.error;
  }

  if (!inserted.data) {
    throw new Error("Falha ao criar conversa direta.");
  }

  return mapConversationRow(inserted.data as ConversationRow);
}
