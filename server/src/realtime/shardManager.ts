import { resolveShardIndex } from "../fanout/shardRouter";
import type { GatewayDispatchEvent, GatewaySubscription } from "../protocol/gateway";
import type { DomainDispatchEnvelope } from "../events/eventTypes";
import type { DispatchableSession } from "../subscriptions/subscriptionManager";
import { SubscriptionManager } from "../subscriptions/subscriptionManager";
import { GatewayShard } from "./gatewayShard";

interface ShardRegistry {
  get(sessionId: string): GatewayShard;
}

interface ShardManagerOptions {
  shardCount: number;
  localShardId?: number | null;
  hostAllShards?: boolean;
}

export class GatewayShardManager {
  private readonly shards: Map<number, GatewayShard> = new Map();
  private readonly sessionToShard = new Map<string, number>();
  private readonly localShardId: number | null;
  private readonly hostAllShards: boolean;

  constructor(options: ShardManagerOptions) {
    const safeShardCount = Math.max(1, Math.floor(options.shardCount));
    this.localShardId = Number.isFinite(options.localShardId ?? NaN) ? Number(options.localShardId) : null;
    this.hostAllShards = options.hostAllShards ?? this.localShardId === null;
    for (let shardId = 0; shardId < safeShardCount; shardId += 1) {
      if (!this.hostAllShards && this.localShardId !== shardId) {
        continue;
      }
      this.shards.set(shardId, new GatewayShard(shardId, new SubscriptionManager()));
    }
  }

  ownsShard(shardId: number): boolean {
    return this.shards.has(shardId);
  }

  resolveShardId(userId: string): number {
    const safeShardCount = this.getShardCount();
    return resolveShardIndex(userId, safeShardCount);
  }

  getShardIdForUser(userId: string): number {
    return this.resolveShardId(userId);
  }

  getActiveShardIds(): number[] {
    return [...this.shards.keys()].sort((a, b) => a - b);
  }

  getShardCount(): number {
    if (this.hostAllShards) {
      const maxShardId = Math.max(...this.getActiveShardIds(), 0);
      return Math.max(1, maxShardId + 1);
    }
    return Math.max(1, this.shards.size);
  }

  attachSession(session: DispatchableSession, subscriptions: GatewaySubscription[], shardId: number): boolean {
    const shard = this.shards.get(shardId);
    if (!shard) {
      return false;
    }
    shard.attachSession(session, subscriptions);
    this.sessionToShard.set(session.sessionId, shardId);
    return true;
  }

  detachSession(sessionId: string): void {
    const shardId = this.sessionToShard.get(sessionId);
    if (shardId === undefined) {
      return;
    }
    const shard = this.shards.get(shardId);
    shard?.detachSession(sessionId);
    this.sessionToShard.delete(sessionId);
  }

  isSessionLocal(sessionId: string): boolean {
    return this.sessionToShard.has(sessionId);
  }

  getShardById(shardId: number): GatewayShard | null {
    return this.shards.get(shardId) ?? null;
  }

  fanoutToShard(
    shardId: number,
    subscription: GatewaySubscription,
    event: GatewayDispatchEvent,
    envelope: DomainDispatchEnvelope<unknown>,
  ): boolean {
    const shard = this.shards.get(shardId);
    if (!shard) {
      return false;
    }
    shard.dispatch(subscription, envelope);
    return true;
  }

  fanoutAllShards(
    subscription: GatewaySubscription,
    envelope: DomainDispatchEnvelope<unknown>,
  ): void {
    this.shards.forEach((shard) => {
      shard.dispatch(subscription, envelope);
    });
  }

  fanoutIfLocal(
    subscription: GatewaySubscription,
    envelope: DomainDispatchEnvelope<unknown>,
  ): void {
    const shard = this.findAny();
    if (!shard) {
      return;
    }
    shard.dispatch(subscription, envelope);
  }

  private findAny(): GatewayShard | null {
    const first = this.shards.values().next();
    return first.value ?? null;
  }

  getShardForSession(sessionId: string): GatewayShard | null {
    const shardId = this.sessionToShard.get(sessionId);
    return shardId === undefined ? null : (this.shards.get(shardId) ?? null);
  }

  getActiveConnections(): number {
    let count = 0;
    this.shards.forEach((shard) => {
      count += shard.getConnectionCount();
    });
    return count;
  }

  isUserOnline(userId: string): boolean {
    const anyLocal = this.getAnyOnlineShard();
    return anyLocal?.isUserOnline(userId) ?? false;
  }

  private getAnyOnlineShard(): GatewayShard | null {
    const it = this.shards.values().next();
    return it.value ?? null;
  }
}
