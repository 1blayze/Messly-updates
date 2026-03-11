import {
  readConversationCache,
  readMessageCache,
  readPresenceCache,
  readProfileCache,
  writeConversationCache,
  writeMessageCache,
  writePresenceCache,
  writeProfileCache,
} from "../cache/repositories";
import type { ConversationEntity, MessageEntity, UserPresenceEntity, UserProfileEntity } from "../stores/entities";

let currentAccountId = "guest";

export function setRealtimeCacheAccountScope(accountId: string | null | undefined): void {
  currentAccountId = String(accountId ?? "").trim() || "guest";
}

export async function readCachedConversations(): Promise<Record<string, ConversationEntity> | null> {
  return readConversationCache(currentAccountId);
}

export async function writeCachedConversations(conversations: Record<string, ConversationEntity>): Promise<void> {
  await writeConversationCache(currentAccountId, conversations);
}

export async function readCachedConversationMessages(conversationId: string): Promise<MessageEntity[] | null> {
  return readMessageCache(currentAccountId, conversationId);
}

export async function writeCachedConversationMessages(conversationId: string, messages: MessageEntity[]): Promise<void> {
  await writeMessageCache(currentAccountId, conversationId, messages);
}

export async function readCachedPresence(): Promise<Record<string, UserPresenceEntity> | null> {
  return readPresenceCache(currentAccountId);
}

export async function writeCachedPresence(presenceByUserId: Record<string, UserPresenceEntity>): Promise<void> {
  await writePresenceCache(currentAccountId, presenceByUserId);
}

export async function readCachedProfiles(): Promise<Record<string, UserProfileEntity> | null> {
  return readProfileCache(currentAccountId);
}

export async function writeCachedProfiles(profilesByUserId: Record<string, UserProfileEntity>): Promise<void> {
  await writeProfileCache(currentAccountId, profilesByUserId);
}
