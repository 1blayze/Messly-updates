import { randomUUID } from "node:crypto";
import type { GatewaySubscription } from "../protocol/gateway";

export interface GatewaySession {
  sessionId: string;
  userId: string;
  seq: number;
  shardId: number;
  ipAddress: string;
  subscriptions: GatewaySubscription[];
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, GatewaySession>();

  create(userId: string, shardId: number, subscriptions: GatewaySubscription[], ipAddress: string): GatewaySession {
    const now = new Date().toISOString();
    const session: GatewaySession = {
      sessionId: randomUUID(),
      userId,
      seq: 0,
      shardId,
      ipAddress,
      subscriptions: [...subscriptions],
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  resume(
    sessionId: string,
    seq: number,
    ipAddress: string,
    subscriptions?: GatewaySubscription[],
  ): GatewaySession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.seq = seq;
    session.ipAddress = ipAddress;
    session.updatedAt = new Date().toISOString();
    if (subscriptions) {
      session.subscriptions = [...subscriptions];
    }

    return session;
  }

  updateHeartbeat(sessionId: string): GatewaySession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.lastHeartbeatAt = new Date().toISOString();
    session.updatedAt = session.lastHeartbeatAt;
    return session;
  }

  updateSeq(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return 0;
    }
    session.seq += 1;
    session.updatedAt = new Date().toISOString();
    return session.seq;
  }

  setSubscriptions(sessionId: string, subscriptions: GatewaySubscription[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.subscriptions = [...subscriptions];
    session.updatedAt = new Date().toISOString();
  }

  get(sessionId: string): GatewaySession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.updatedAt = new Date().toISOString();
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listByUserId(userId: string): GatewaySession[] {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) {
      return [];
    }

    return [...this.sessions.values()].filter((session) => session.userId === normalizedUserId);
  }
}
