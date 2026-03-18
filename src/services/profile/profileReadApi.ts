import { invokeEdgeGet } from "../edge/edgeClient";
import { isDirectUsersRestBlocked, supabase } from "../supabase";

const PROFILE_READ_SELECT_COLUMNS =
  "id,username,display_name,email,avatar_url,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,status,last_active,public_id,spotify_connection,friend_requests_allow_all,friend_requests_allow_friends_of_friends,created_at,updated_at";
const PROFILE_EDGE_MAX_IDS = 100;

let profileReadsTemporarilyUseEdge = isDirectUsersRestBlocked();

export interface ProfileLookupRow {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  avatar_key: string | null;
  avatar_hash: string | null;
  banner_url: string | null;
  banner_key: string | null;
  banner_hash: string | null;
  banner_color: string | null;
  profile_theme_primary_color: string | null;
  profile_theme_accent_color: string | null;
  bio: string | null;
  about: string | null;
  firebase_uid: string;
  status: string | null;
  last_active: string | null;
  public_id: string | null;
  spotify_connection: unknown | null;
  friend_requests_allow_all: boolean | null;
  friend_requests_allow_friends_of_friends: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ProfileEdgeListResponse {
  profiles?: unknown[];
  serverTime?: string;
}

interface ProfileQueryResponse<TData> {
  data: TData;
  error: Error | null;
}

interface ProfileReadFilter {
  id?: string | null;
  ids?: readonly string[] | null;
  username?: string | null;
}

function toNullableTrimmedString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizeProfileLookupRow(row: unknown): ProfileLookupRow | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const record = row as Record<string, unknown>;
  const id = toNullableTrimmedString(record.id);
  if (!id) {
    return null;
  }

  const bio = toNullableTrimmedString(record.about ?? record.bio);

  return {
    id,
    username: toNullableTrimmedString(record.username),
    display_name: toNullableTrimmedString(record.display_name),
    email: toNullableTrimmedString(record.email),
    avatar_url: toNullableTrimmedString(record.avatar_url),
    avatar_key: toNullableTrimmedString(record.avatar_key),
    avatar_hash: toNullableTrimmedString(record.avatar_hash),
    banner_url: toNullableTrimmedString(record.banner_url),
    banner_key: toNullableTrimmedString(record.banner_key),
    banner_hash: toNullableTrimmedString(record.banner_hash),
    banner_color: toNullableTrimmedString(record.banner_color),
    profile_theme_primary_color: toNullableTrimmedString(record.profile_theme_primary_color),
    profile_theme_accent_color: toNullableTrimmedString(record.profile_theme_accent_color),
    bio,
    about: bio,
    firebase_uid: toNullableTrimmedString(record.firebase_uid) ?? id,
    status: toNullableTrimmedString(record.status),
    last_active: toNullableTrimmedString(record.last_active),
    public_id: toNullableTrimmedString(record.public_id),
    spotify_connection: record.spotify_connection ?? null,
    friend_requests_allow_all: toNullableBoolean(record.friend_requests_allow_all),
    friend_requests_allow_friends_of_friends: toNullableBoolean(record.friend_requests_allow_friends_of_friends),
    created_at: toNullableTrimmedString(record.created_at),
    updated_at: toNullableTrimmedString(record.updated_at),
  };
}

function normalizeProfileList(rows: unknown[]): ProfileLookupRow[] {
  return rows
    .map((row) => normalizeProfileLookupRow(row))
    .filter((row): row is ProfileLookupRow => Boolean(row));
}

function normalizeProfileIds(userIds: readonly string[] | null | undefined): string[] {
  return Array.from(
    new Set(
      (userIds ?? [])
        .map((userId) => String(userId ?? "").trim())
        .filter(Boolean),
    ),
  ).slice(0, PROFILE_EDGE_MAX_IDS);
}

function shouldFallbackToEdgeProfileReads(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim().toLowerCase();

  if (status === 0 || status === 401 || status === 403) {
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

async function readProfilesDirect(filter: ProfileReadFilter): Promise<ProfileLookupRow[]> {
  if (filter.id) {
    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_READ_SELECT_COLUMNS)
      .eq("id", filter.id)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? normalizeProfileList([data]) : [];
  }

  if (filter.username) {
    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_READ_SELECT_COLUMNS)
      .eq("username", filter.username)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? normalizeProfileList([data]) : [];
  }

  const ids = normalizeProfileIds(filter.ids);
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_READ_SELECT_COLUMNS)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return normalizeProfileList(Array.isArray(data) ? data : []);
}

async function readProfilesViaEdge(filter: ProfileReadFilter): Promise<ProfileLookupRow[]> {
  const ids = normalizeProfileIds(filter.ids);
  const response = await invokeEdgeGet<ProfileEdgeListResponse>("profiles", {
    requireAuth: true,
    retries: 0,
    timeoutMs: 12_000,
    query: {
      ...(filter.id ? { id: filter.id } : {}),
      ...(filter.username ? { username: filter.username } : {}),
      ...(ids.length > 0 ? { ids: ids.join(",") } : {}),
    },
  });

  return normalizeProfileList(Array.isArray(response?.profiles) ? response.profiles : []);
}

async function readProfiles(filter: ProfileReadFilter): Promise<ProfileLookupRow[]> {
  if (!profileReadsTemporarilyUseEdge) {
    try {
      return await readProfilesDirect(filter);
    } catch (error) {
      if (!shouldFallbackToEdgeProfileReads(error)) {
        throw error;
      }
      profileReadsTemporarilyUseEdge = true;
    }
  }

  return readProfilesViaEdge(filter);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error ?? "Unknown profile lookup error"));
}

export async function getProfileById(userId: string): Promise<ProfileLookupRow | null> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return null;
  }

  const profiles = await readProfiles({ id: normalizedUserId });
  return profiles[0] ?? null;
}

export async function getProfileByUsername(username: string): Promise<ProfileLookupRow | null> {
  const normalizedUsername = String(username ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (!normalizedUsername) {
    return null;
  }

  const profiles = await readProfiles({ username: normalizedUsername });
  return profiles[0] ?? null;
}

export async function getProfilesByIds(userIds: readonly string[]): Promise<ProfileLookupRow[]> {
  const normalizedUserIds = normalizeProfileIds(userIds);
  if (normalizedUserIds.length === 0) {
    return [];
  }

  return readProfiles({ ids: normalizedUserIds });
}

export async function queryProfileById(userId: string): Promise<ProfileQueryResponse<ProfileLookupRow | null>> {
  try {
    return {
      data: await getProfileById(userId),
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: toError(error),
    };
  }
}

export async function queryProfileByUsername(username: string): Promise<ProfileQueryResponse<ProfileLookupRow | null>> {
  try {
    return {
      data: await getProfileByUsername(username),
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: toError(error),
    };
  }
}

export async function queryProfilesByIds(userIds: readonly string[]): Promise<ProfileQueryResponse<ProfileLookupRow[]>> {
  try {
    return {
      data: await getProfilesByIds(userIds),
      error: null,
    };
  } catch (error) {
    return {
      data: [],
      error: toError(error),
    };
  }
}
