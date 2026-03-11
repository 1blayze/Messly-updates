import Dexie from "dexie";
import { messlyCacheDb } from "./messlyCacheDb";
import type {
  CachedChatInitialSnapshotRecord,
  CachedConversationRecord,
  CachedMessageRecord,
  CachedPresenceRecord,
  CachedProfileRecord,
} from "./messlyCacheDb";
import type {
  ConversationEntity,
  MessageEntity,
  UserPresenceEntity,
  UserProfileEntity,
} from "../stores/entities";

function withAccount<T extends { accountId: string }>(accountId: string, value: Omit<T, "accountId">): T {
  return {
    ...value,
    accountId,
  } as T;
}

export async function readConversationCache(accountId: string): Promise<Record<string, ConversationEntity>> {
  const rows = await messlyCacheDb.conversations.where("accountId").equals(accountId).toArray();
  return Object.fromEntries(rows.map(({ accountId: _accountId, ...conversation }) => [conversation.id, conversation]));
}

export async function writeConversationCache(
  accountId: string,
  conversations: Record<string, ConversationEntity>,
): Promise<void> {
  const rows = Object.values(conversations).map((conversation) =>
    withAccount<CachedConversationRecord>(accountId, conversation),
  );

  await messlyCacheDb.transaction("rw", messlyCacheDb.conversations, async () => {
    await messlyCacheDb.conversations.where("accountId").equals(accountId).delete();
    if (rows.length) {
      await messlyCacheDb.conversations.bulkPut(rows);
    }
  });
}

export async function readMessageCache(
  accountId: string,
  conversationId: string,
  limit = 100,
): Promise<MessageEntity[]> {
  const rows = await messlyCacheDb.messages
    .where("[accountId+conversationId+createdAt]")
    .between([accountId, conversationId, Dexie.minKey], [accountId, conversationId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray();

  return rows
    .reverse()
    .map(({ accountId: _accountId, ...message }) => message);
}

export async function writeMessageCache(
  accountId: string,
  conversationId: string,
  messages: MessageEntity[],
): Promise<void> {
  const trimmedMessages = messages.slice(-100);
  const rows = trimmedMessages.map((message) => withAccount<CachedMessageRecord>(accountId, message));

  await messlyCacheDb.transaction("rw", messlyCacheDb.messages, async () => {
    const existing = await messlyCacheDb.messages
      .where("[accountId+conversationId+createdAt]")
      .between([accountId, conversationId, Dexie.minKey], [accountId, conversationId, Dexie.maxKey])
      .primaryKeys();

    if (existing.length) {
      await messlyCacheDb.messages.bulkDelete(existing);
    }

    if (rows.length) {
      await messlyCacheDb.messages.bulkPut(rows);
    }
  });
}

export async function readProfileCache(accountId: string): Promise<Record<string, UserProfileEntity>> {
  const rows = await messlyCacheDb.profiles.where("accountId").equals(accountId).toArray();
  return Object.fromEntries(rows.map(({ accountId: _accountId, ...profile }) => [profile.id, profile]));
}

export async function writeProfileCache(accountId: string, profiles: Record<string, UserProfileEntity>): Promise<void> {
  const rows = Object.values(profiles).map((profile) => withAccount<CachedProfileRecord>(accountId, profile));

  await messlyCacheDb.transaction("rw", messlyCacheDb.profiles, async () => {
    await messlyCacheDb.profiles.where("accountId").equals(accountId).delete();
    if (rows.length) {
      await messlyCacheDb.profiles.bulkPut(rows);
    }
  });
}

export async function readPresenceCache(accountId: string): Promise<Record<string, UserPresenceEntity>> {
  const rows = await messlyCacheDb.presenceSnapshots.where("accountId").equals(accountId).toArray();
  return Object.fromEntries(rows.map(({ accountId: _accountId, ...presence }) => [presence.userId, presence]));
}

export async function writePresenceCache(
  accountId: string,
  presences: Record<string, UserPresenceEntity>,
): Promise<void> {
  const rows = Object.values(presences).map((presence) => withAccount<CachedPresenceRecord>(accountId, presence));

  await messlyCacheDb.transaction("rw", messlyCacheDb.presenceSnapshots, async () => {
    await messlyCacheDb.presenceSnapshots.where("accountId").equals(accountId).delete();
    if (rows.length) {
      await messlyCacheDb.presenceSnapshots.bulkPut(rows);
    }
  });
}

export interface ChatInitialSnapshotCacheRecord {
  conversationId: string;
  messages: Array<Record<string, unknown>>;
  nextCursor: { createdAt: string; id: string } | null;
  updatedAtMs: number;
}

export async function readChatInitialSnapshotsCache(
  accountId: string,
  maxEntries = 12,
): Promise<ChatInitialSnapshotCacheRecord[]> {
  const rows = await messlyCacheDb.chatInitialSnapshots.where("accountId").equals(accountId).toArray();
  return rows
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0))
    .slice(0, Math.max(1, Math.trunc(maxEntries)))
    .map(({ accountId: _accountId, ...entry }) => ({
      conversationId: entry.conversationId,
      messages: Array.isArray(entry.messages) ? entry.messages : [],
      nextCursor:
        entry.nextCursor &&
        typeof entry.nextCursor === "object" &&
        typeof entry.nextCursor.createdAt === "string" &&
        typeof entry.nextCursor.id === "string"
          ? { createdAt: entry.nextCursor.createdAt, id: entry.nextCursor.id }
          : null,
      updatedAtMs: Number(entry.updatedAtMs ?? 0) || Date.now(),
    }));
}

export async function writeChatInitialSnapshotCache(
  accountId: string,
  conversationId: string,
  snapshot: {
    messages: Array<Record<string, unknown>>;
    nextCursor: { createdAt: string; id: string } | null;
    updatedAtMs?: number;
  },
): Promise<void> {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId) {
    return;
  }

  const row: CachedChatInitialSnapshotRecord = {
    accountId,
    conversationId: normalizedConversationId,
    messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
    nextCursor:
      snapshot.nextCursor &&
      typeof snapshot.nextCursor.createdAt === "string" &&
      typeof snapshot.nextCursor.id === "string"
        ? {
            createdAt: snapshot.nextCursor.createdAt,
            id: snapshot.nextCursor.id,
          }
        : null,
    updatedAtMs: Number(snapshot.updatedAtMs ?? Date.now()) || Date.now(),
  };

  await messlyCacheDb.chatInitialSnapshots.put(row);
}

export async function trimChatInitialSnapshotsCache(
  accountId: string,
  options: {
    maxEntries?: number;
    minUpdatedAtMs?: number;
  } = {},
): Promise<void> {
  const maxEntries = Math.max(1, Math.trunc(Number(options.maxEntries ?? 12) || 12));
  const minUpdatedAtMs = Number(options.minUpdatedAtMs ?? 0);
  const rows = await messlyCacheDb.chatInitialSnapshots.where("accountId").equals(accountId).toArray();
  if (rows.length === 0) {
    return;
  }

  const sorted = rows.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  const staleRows = sorted.filter((row, index) => {
    if (index >= maxEntries) {
      return true;
    }
    if (Number.isFinite(minUpdatedAtMs) && minUpdatedAtMs > 0) {
      return Number(row.updatedAtMs ?? 0) < minUpdatedAtMs;
    }
    return false;
  });

  if (staleRows.length === 0) {
    return;
  }

  const staleKeys = staleRows.map((row) => [accountId, row.conversationId] as [string, string]);
  await messlyCacheDb.chatInitialSnapshots.bulkDelete(staleKeys);
}
