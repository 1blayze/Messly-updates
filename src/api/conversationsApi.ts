import { supabase } from "./client";
import { queryProfilesByIds } from "../services/profile/profileReadApi";
import type { ConversationEntity } from "../stores/entities";
import { getSchemaCapability, setSchemaCapability } from "../services/database/schemaCapabilities";

export type ConversationType = "dm";

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
  user1Id: string | null;
  user2Id: string | null;
  createdAt: string | null;
  participantIds: string[];
  participants: ConversationParticipantProfile[];
}

interface ConversationRow {
  id: string;
  type?: string | null;
  user1_id?: string | null;
  user2_id?: string | null;
  created_at: string | null;
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

const CONVERSATION_SELECT_COLUMNS = "id,type,user1_id,user2_id,created_at";
const LEGACY_CONVERSATION_SELECT_COLUMNS = "id,user1_id,user2_id,created_at";

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
    (message.includes("type") || details.includes("type") || hint.includes("type"))
  );
}

function toNullableTrimmedString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
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

function normalizeConversationRow(row: ConversationRow | null | undefined): ConversationRow | null {
  const id = String(row?.id ?? "").trim();
  const user1Id = String(row?.user1_id ?? "").trim() || null;
  const user2Id = String(row?.user2_id ?? "").trim() || null;
  if (!id || !user1Id || !user2Id) {
    return null;
  }
  return {
    id,
    type: "dm",
    user1_id: user1Id,
    user2_id: user2Id,
    created_at: toNullableTrimmedString(row?.created_at),
  };
}

function isConversationForUser(row: ConversationRow | null | undefined, currentUserId: string): boolean {
  const normalizedCurrentUserId = String(currentUserId ?? "").trim();
  if (!normalizedCurrentUserId) {
    return false;
  }
  return row?.user1_id === normalizedCurrentUserId || row?.user2_id === normalizedCurrentUserId;
}

function mapConversationRow(row: ConversationRow): ConversationEntity {
  return {
    id: row.id,
    scopeType: "dm",
    scopeId: row.id,
    participantIds: uniqueParticipantIds([row.user1_id, row.user2_id]),
    name: null,
    avatarUrl: null,
    createdBy: null,
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

  const { data, error } = await queryProfilesByIds(normalizedUserIds);
  if (error) {
    throw error;
  }

  const profilesByUserId = new Map<string, ConversationParticipantProfile>();
  (Array.isArray(data) ? (data as ConversationProfileRow[]) : []).forEach((row) => {
    profilesByUserId.set(row.id, mapConversationProfileRow(row));
  });
  return profilesByUserId;
}

function mapConversationDetails(
  row: ConversationRow,
  profilesByUserId: Map<string, ConversationParticipantProfile>,
): ConversationDetails {
  const participantIds = uniqueParticipantIds([row.user1_id, row.user2_id]);
  return {
    id: row.id,
    type: "dm",
    user1Id: toNullableTrimmedString(row.user1_id),
    user2Id: toNullableTrimmedString(row.user2_id),
    createdAt: toNullableTrimmedString(row.created_at),
    participantIds,
    participants: participantIds
      .map((participantId) => profilesByUserId.get(participantId) ?? null)
      .filter((participant): participant is ConversationParticipantProfile => participant !== null),
  };
}

async function listConversationRowsForUser(currentUserId: string): Promise<ConversationRow[]> {
  const normalizedCurrentUserId = String(currentUserId ?? "").trim();
  if (!normalizedCurrentUserId) {
    return [];
  }

  let rows: ConversationRow[] = [];
  let shouldUseLegacyColumns = false;
  const conversationsExtendedColumnsSupported = getSchemaCapability("conversations_extended_columns");
  const dmFilter = `user1_id.eq.${normalizedCurrentUserId},user2_id.eq.${normalizedCurrentUserId}`;

  if (conversationsExtendedColumnsSupported !== false) {
    if (conversationsExtendedColumnsSupported === null) {
      setSchemaCapability("conversations_extended_columns", false);
    }
    const primary = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT_COLUMNS)
      .eq("type", "dm")
      .or(dmFilter)
      .order("created_at", { ascending: false });
    if (primary.error) {
      if (!isConversationSchemaCompatibilityError(primary.error)) {
        throw primary.error;
      }
      setSchemaCapability("conversations_extended_columns", false);
      shouldUseLegacyColumns = true;
    } else {
      setSchemaCapability("conversations_extended_columns", true);
      rows = (Array.isArray(primary.data) ? primary.data : []) as ConversationRow[];
    }
  } else {
    shouldUseLegacyColumns = true;
  }

  if (shouldUseLegacyColumns) {
    const legacy = await supabase
      .from("conversations")
      .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
      .or(dmFilter)
      .order("created_at", { ascending: false });
    if (legacy.error) {
      throw legacy.error;
    }
    rows = (Array.isArray(legacy.data) ? legacy.data : []) as ConversationRow[];
  }

  return rows
    .map((row) => normalizeConversationRow(row))
    .filter((row): row is ConversationRow => row !== null)
    .filter((row) => isConversationForUser(row, normalizedCurrentUserId));
}

export async function listUserConversations(currentUserId: string): Promise<ConversationEntity[]> {
  const rows = await listConversationRowsForUser(currentUserId);
  return rows.map(mapConversationRow);
}

export async function ensureDirectConversation(userA: string, userB: string): Promise<ConversationEntity> {
  const currentUserId = String(userA ?? "").trim();
  const otherUserId = String(userB ?? "").trim();
  const [left, right] = [currentUserId, otherUserId].sort();
  if (!left || !right || left === right) {
    throw new Error("Participantes invalidos para criar DM.");
  }

  let existingRow: ConversationRow | null = null;
  const conversationsExtendedColumnsSupported = getSchemaCapability("conversations_extended_columns");

  if (conversationsExtendedColumnsSupported !== false) {
    if (conversationsExtendedColumnsSupported === null) {
      setSchemaCapability("conversations_extended_columns", false);
    }
    const existingWithType = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT_COLUMNS)
      .eq("type", "dm")
      .eq("user1_id", left)
      .eq("user2_id", right)
      .limit(1)
      .maybeSingle();
    if (existingWithType.error) {
      if (!isConversationSchemaCompatibilityError(existingWithType.error)) {
        throw existingWithType.error;
      }
      setSchemaCapability("conversations_extended_columns", false);
    } else {
      setSchemaCapability("conversations_extended_columns", true);
      existingRow = normalizeConversationRow(existingWithType.data as ConversationRow | null);
    }
  }

  if (!existingRow && getSchemaCapability("conversations_extended_columns") === false) {
    const existingLegacy = await supabase
      .from("conversations")
      .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
      .eq("user1_id", left)
      .eq("user2_id", right)
      .limit(1)
      .maybeSingle();
    if (existingLegacy.error) {
      throw existingLegacy.error;
    }
    existingRow = normalizeConversationRow(existingLegacy.data as ConversationRow | null);
  }

  if (existingRow) {
    return mapConversationRow(existingRow);
  }

  let insertedRow: ConversationRow | null = null;
  let insertError: { code?: string } | null = null;
  const insertWithExtendedColumns = getSchemaCapability("conversations_extended_columns") !== false;

  if (insertWithExtendedColumns) {
    if (getSchemaCapability("conversations_extended_columns") === null) {
      setSchemaCapability("conversations_extended_columns", false);
    }
    const insertedWithType = await supabase
      .from("conversations")
      .insert({
        type: "dm",
        user1_id: left,
        user2_id: right,
      })
      .select(CONVERSATION_SELECT_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (insertedWithType.error) {
      if (!isConversationSchemaCompatibilityError(insertedWithType.error)) {
        insertError = insertedWithType.error;
      } else {
        setSchemaCapability("conversations_extended_columns", false);
      }
    } else {
      setSchemaCapability("conversations_extended_columns", true);
      insertedRow = normalizeConversationRow(insertedWithType.data as ConversationRow | null);
    }
  }

  if (!insertedRow && !insertError && getSchemaCapability("conversations_extended_columns") === false) {
    const insertedLegacy = await supabase
      .from("conversations")
      .insert({
        user1_id: left,
        user2_id: right,
      })
      .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (insertedLegacy.error) {
      insertError = insertedLegacy.error;
    } else {
      insertedRow = normalizeConversationRow(insertedLegacy.data as ConversationRow | null);
    }
  }

  if (insertError) {
    if (String(insertError.code ?? "").trim() === "23505") {
      const retry = await supabase
        .from("conversations")
        .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
        .eq("user1_id", left)
        .eq("user2_id", right)
        .limit(1)
        .maybeSingle();
      if (retry.error) {
        throw retry.error;
      }
      const retryRow = normalizeConversationRow(retry.data as ConversationRow | null);
      if (retryRow) {
        return mapConversationRow(retryRow);
      }
    }
    throw insertError;
  }

  if (!insertedRow) {
    throw new Error("Falha ao criar conversa direta.");
  }

  return mapConversationRow(insertedRow);
}

export async function getConversationDetails(conversationId: string): Promise<ConversationDetails | null> {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return null;
  }

  let row: ConversationRow | null = null;
  const conversationsExtendedColumnsSupported = getSchemaCapability("conversations_extended_columns");

  if (conversationsExtendedColumnsSupported !== false) {
    if (conversationsExtendedColumnsSupported === null) {
      setSchemaCapability("conversations_extended_columns", false);
    }
    const primary = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT_COLUMNS)
      .eq("id", normalizedConversationId)
      .eq("type", "dm")
      .limit(1)
      .maybeSingle();
    if (primary.error) {
      if (!isConversationSchemaCompatibilityError(primary.error)) {
        throw primary.error;
      }
      setSchemaCapability("conversations_extended_columns", false);
    } else {
      setSchemaCapability("conversations_extended_columns", true);
      row = normalizeConversationRow(primary.data as ConversationRow | null);
    }
  }

  if (!row && getSchemaCapability("conversations_extended_columns") === false) {
    const legacy = await supabase
      .from("conversations")
      .select(LEGACY_CONVERSATION_SELECT_COLUMNS)
      .eq("id", normalizedConversationId)
      .limit(1)
      .maybeSingle();
    if (legacy.error) {
      throw legacy.error;
    }
    row = normalizeConversationRow(legacy.data as ConversationRow | null);
  }

  if (!row) {
    return null;
  }

  const participantIds = uniqueParticipantIds([row.user1_id, row.user2_id]);
  const profilesByUserId = await loadConversationProfiles(participantIds);
  return mapConversationDetails(row, profilesByUserId);
}
