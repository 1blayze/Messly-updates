export function hashUserId(userId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveShardIndex(userId: string, shardCount: number): number {
  const safeShardCount = Math.max(1, Math.floor(shardCount));
  return hashUserId(userId) % safeShardCount;
}

export function resolveConversationShard(conversationId: string, shardCount: number): number {
  return resolveShardIndex(String(conversationId ?? ""), shardCount);
}
