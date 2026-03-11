import Dexie, { type Table } from "dexie";
import type {
  ConversationEntity,
  MessageEntity,
  UserPresenceEntity,
  UserProfileEntity,
} from "../stores/entities";

export interface CachedConversationRecord extends ConversationEntity {
  accountId: string;
}

export interface CachedMessageRecord extends MessageEntity {
  accountId: string;
}

export interface CachedProfileRecord extends UserProfileEntity {
  accountId: string;
}

export interface CachedPresenceRecord extends UserPresenceEntity {
  accountId: string;
}

export interface CachedUnreadStateRecord {
  id: string;
  accountId: string;
  conversationId: string;
  unreadCount: number;
  updatedAt: string;
}

class MesslyCacheDb extends Dexie {
  conversations!: Table<CachedConversationRecord, [string, string]>;
  messages!: Table<CachedMessageRecord, [string, string, string]>;
  profiles!: Table<CachedProfileRecord, [string, string]>;
  presenceSnapshots!: Table<CachedPresenceRecord, [string, string]>;
  unreadState!: Table<CachedUnreadStateRecord, string>;

  constructor() {
    super("messly-cache-db");

    this.version(1).stores({
      conversations: "[accountId+id], accountId, updatedAt, lastMessageAt",
      messages: "[accountId+conversationId+id], [accountId+conversationId+createdAt], accountId, conversationId, createdAt",
      profiles: "[accountId+id], accountId, updatedAt",
      presenceSnapshots: "[accountId+userId], accountId, updatedAt",
      unreadState: "id, accountId, conversationId, updatedAt",
    });
  }
}

export const messlyCacheDb = new MesslyCacheDb();
