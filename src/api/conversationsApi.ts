import { supabase } from "./client";
import type { ConversationEntity } from "../stores/entities";

export type ConversationType = "dm" | "group_dm";

export interface ConversationParticipantProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarKey: string | null;
  avatarHash: string | null;
  firebaseUid: string | null;
  aboutText: string | null;
  bannerColor: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  bannerKey: string | null;
  bannerHash: string | null;
  createdAt: string | null;
}

export interface ConversationDetails {
  id: string;
  type: ConversationType;
  createdBy: string | null;
  name: string | null;
  avatarUrl: string | null;
  user1Id: string | null;
  user2Id: string | null;
  createdAt: string | null;
  participantIds: string[];
  participants: ConversationParticipantProfile[];
}

interface ConversationRow {
  id: string;
  type?: string | null;
  created_by?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  user1_id?: string | null;
  user2_id?: string | null;
  created_at: string | null;
}

interface ConversationMemberRow {
  conversation_id?: string | null;
  user_id?: string | null;
}

interface ConversationProfileRow {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
  firebase_uid?: string | null;
  about?: string | null;
  banner_color?: string | null;
  profile_theme_primary_color?: string | null;
  profile_theme_accent_color?: string | null;
  banner_key?: string | null;
  banner_hash?: string | null;
  created_at?: string | null;
}

const CONVERSATION_SELECT_COLUMNS =
  "id,type,created_by,name,avatar_url,user1_id,user2_id,created_at";
const CONVERSATION_PROFILE_SELECT_COLUMNS =
  "id,username,display_name,avatar_url,avatar_key,avatar_hash,firebase_uid:id,about:bio,banner_color,profile_theme_primary_color,profile_theme_accent_color,banner_key,banner_hash,created_at";

function toNullableTrimmedString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeConversationType(value: unknown): ConversationType {
  return String(value ?? "").trim().toLowerCase() === "group_dm" ? "group_dm" : "dm";
}

function uniqueParticipantIds(ids: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      ids
        .map((value) => String(value ?? "").trim())
        .filter((value) => Boolean(value)),
    ),
  );
}

function mapConversationRow(
  row: ConversationRow,
  participantIds: string[],
): ConversationEntity {
  const normalizedType = normalizeConversationType(row.type);
  return {
    id: row.id,
    scopeType: normalizedType,
    scopeId: row.id,
    participantIds,
    name: toNullableTrimmedString(row.name),
    avatarUrl: toNullableTrimmedString(row.avatar_url),
    createdBy: toNullableTrimmedString(row.created_by),
    lastMessageId: null,
    lastMessageAt: row.created_at,
    unreadCount: 0,
    typingUserIds: [],
    updatedAt: row.created_at,
  };
}

function mapConversationProfileRow(row: ConversationProfileRow): ConversationParticipantProfile {
  return {
    id: row.id,
    username: String(row.username ?? "").trim(),
    displayName: toNullableTrimmedString(row.display_name),
    avatarUrl: toNullableTrimmedString(row.avatar_url),
    avatarKey: toNullableTrimmedString(row.avatar_key),
    avatarHash: toNullableTrimmedString(row.avatar_hash),
    firebaseUid: toNullableTrimmedString(row.firebase_uid),
    aboutText: toNullableTrimmedString(row.about),
    bannerColor: toNullableTrimmedString(row.banner_color),
    themePrimaryColor: toNullableTrimmedString(row.profile_theme_primary_color),
    themeAccentColor: toNullableTrimmedString(row.profile_theme_accent_color),
    bannerKey: toNullableTrimmedString(row.banner_key),
    bannerHash: toNullableTrimmedString(row.banner_hash),
    createdAt: toNullableTrimmedString(row.created_at),
  };
}

async function loadConversationMembers(conversationIds: string[]): Promise<Map<string, string[]>> {
  const normalizedConversationIds = Array.from(
    new Set(
      conversationIds
        .map((conversationId) => String(conversationId ?? "").trim())
        .filter((conversationId) => Boolean(conversationId)),
    ),
  );
  if (normalizedConversationIds.length === 0) {
    return new Map<string, string[]>();
  }

  const { data, error } = await supabase
    .from("conversation_members")
    .select("conversation_id,user_id")
    .in("conversation_id", normalizedConversationIds);

  if (error) {
    throw error;
  }

  const membersByConversationId = new Map<string, string[]>();
  (Array.isArray(data) ? (data as ConversationMemberRow[]) : []).forEach((row) => {
    const conversationId = String(row.conversation_id ?? "").trim();
    const userId = String(row.user_id ?? "").trim();
    if (!conversationId || !userId) {
      return;
    }

    const current = membersByConversationId.get(conversationId);
    if (current) {
      if (!current.includes(userId)) {
        current.push(userId);
      }
      return;
    }

    membersByConversationId.set(conversationId, [userId]);
  });

  return membersByConversationId;
}

async function loadConversationProfiles(userIds: string[]): Promise<Map<string, ConversationParticipantProfile>> {
  const normalizedUserIds = Array.from(
    new Set(
      userIds
        .map((userId) => String(userId ?? "").trim())
        .filter((userId) => Boolean(userId)),
    ),
  );
  if (normalizedUserIds.length === 0) {
    return new Map<string, ConversationParticipantProfile>();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(CONVERSATION_PROFILE_SELECT_COLUMNS)
    .in("id", normalizedUserIds);

  if (error) {
    throw error;
  }

  const profilesByUserId = new Map<string, ConversationParticipantProfile>();
  (Array.isArray(data) ? (data as ConversationProfileRow[]) : []).forEach((row) => {
    profilesByUserId.set(row.id, mapConversationProfileRow(row));
  });
  return profilesByUserId;
}

function resolveConversationParticipantIds(
  row: ConversationRow,
  memberIdsByConversationId: Map<string, string[]>,
): string[] {
  const memberIds = memberIdsByConversationId.get(row.id);
  if (Array.isArray(memberIds) && memberIds.length > 0) {
    return memberIds;
  }

  return uniqueParticipantIds([row.user1_id, row.user2_id]);
}

function mapConversationDetails(
  row: ConversationRow,
  participantIds: string[],
  profilesByUserId: Map<string, ConversationParticipantProfile>,
): ConversationDetails {
  return {
    id: row.id,
    type: normalizeConversationType(row.type),
    createdBy: toNullableTrimmedString(row.created_by),
    name: toNullableTrimmedString(row.name),
    avatarUrl: toNullableTrimmedString(row.avatar_url),
    user1Id: toNullableTrimmedString(row.user1_id),
    user2Id: toNullableTrimmedString(row.user2_id),
    createdAt: toNullableTrimmedString(row.created_at),
    participantIds,
    participants: participantIds
      .map((participantId) => profilesByUserId.get(participantId) ?? null)
      .filter((participant): participant is ConversationParticipantProfile => participant !== null),
  };
}

export async function listUserConversations(currentUserId: string): Promise<ConversationEntity[]> {
  const normalizedCurrentUserId = String(currentUserId ?? "").trim();
  if (!normalizedCurrentUserId) {
    return [];
  }

  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const rows = (Array.isArray(data) ? data : []) as ConversationRow[];
  const membersByConversationId = await loadConversationMembers(rows.map((row) => row.id));

  return rows.map((row) => {
    const participantIds = resolveConversationParticipantIds(row, membersByConversationId);
    return mapConversationRow(row, participantIds);
  });
}

export async function ensureDirectConversation(userA: string, userB: string): Promise<ConversationEntity> {
  const currentUserId = String(userA ?? "").trim();
  const otherUserId = String(userB ?? "").trim();
  const [left, right] = [currentUserId, otherUserId].sort();
  if (!left || !right || left === right) {
    throw new Error("Participantes invalidos para criar DM.");
  }

  const existing = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT_COLUMNS)
    .eq("type", "dm")
    .eq("user1_id", left)
    .eq("user2_id", right)
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }

  if (existing.data) {
    return mapConversationRow(existing.data as ConversationRow, [left, right]);
  }

  const inserted = await supabase
    .from("conversations")
    .insert({
      type: "dm",
      created_by: currentUserId,
      user1_id: left,
      user2_id: right,
    })
    .select(CONVERSATION_SELECT_COLUMNS)
    .limit(1)
    .maybeSingle();

  if (inserted.error) {
    if (inserted.error.code === "23505") {
      const retry = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT_COLUMNS)
        .eq("type", "dm")
        .eq("user1_id", left)
        .eq("user2_id", right)
        .limit(1)
        .maybeSingle();

      if (retry.error) {
        throw retry.error;
      }

      if (retry.data) {
        return mapConversationRow(retry.data as ConversationRow, [left, right]);
      }
    }

    throw inserted.error;
  }

  if (!inserted.data) {
    throw new Error("Falha ao criar conversa direta.");
  }

  return mapConversationRow(inserted.data as ConversationRow, [left, right]);
}

export async function getConversationDetails(conversationId: string): Promise<ConversationDetails | null> {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return null;
  }

  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT_COLUMNS)
    .eq("id", normalizedConversationId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = (data as ConversationRow | null) ?? null;
  if (!row) {
    return null;
  }

  const membersByConversationId = await loadConversationMembers([normalizedConversationId]);
  const participantIds = resolveConversationParticipantIds(row, membersByConversationId);
  const profilesByUserId = await loadConversationProfiles(participantIds);
  return mapConversationDetails(row, participantIds, profilesByUserId);
}

export async function createGroupConversation(
  currentUserId: string,
  otherParticipantIds: string[],
  name?: string | null,
): Promise<ConversationDetails> {
  const normalizedCurrentUserId = String(currentUserId ?? "").trim();
  if (!normalizedCurrentUserId) {
    throw new Error("Usuario atual invalido para criar grupo.");
  }

  const normalizedOtherParticipantIds = Array.from(
    new Set(
      otherParticipantIds
        .map((participantId) => String(participantId ?? "").trim())
        .filter((participantId) => Boolean(participantId) && participantId !== normalizedCurrentUserId),
    ),
  );

  if (normalizedOtherParticipantIds.length === 0) {
    throw new Error("Selecione pelo menos uma pessoa para criar o grupo.");
  }

  if (normalizedOtherParticipantIds.length > 9) {
    throw new Error("O grupo privado suporta no maximo 10 pessoas contando com voce.");
  }

  const { data, error } = await supabase.rpc("create_group_dm", {
    p_participant_ids: normalizedOtherParticipantIds,
    p_name: toNullableTrimmedString(name),
  });

  if (error) {
    throw error;
  }

  const createdRow = (Array.isArray(data) ? data[0] : data) as ConversationRow | null;
  const createdConversationId = String(createdRow?.id ?? "").trim();
  if (!createdConversationId) {
    throw new Error("Falha ao criar grupo privado.");
  }

  const details = await getConversationDetails(createdConversationId);
  if (!details) {
    throw new Error("Falha ao carregar o grupo privado criado.");
  }

  return details;
}
