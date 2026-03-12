import { randomUUID } from "node:crypto";
import type { SessionClientInfo } from "./sessionManager";
import type { RedisManager } from "../redis/client";
import { gatewayRedisKeys } from "../redis/keys";
import type { GatewayDispatchPayloadMap, GatewaySubscription } from "../protocol/dispatch";
import type { GatewayDispatchEvent } from "../protocol/opcodes";

interface CreateSessionInput {
  userId: string;
  shardId: number;
  subscriptions: GatewaySubscription[];
  connectionId: string;
  instanceId: string;
  ipAddress: string;
  authSessionId: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
}

interface BindSessionInput {
  connectionId: string;
  instanceId: string;
  ipAddress: string;
  authSessionId: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
  subscriptions: GatewaySubscription[];
}

interface MarkDisconnectedInput {
  instanceId?: string;
  connectionId?: string;
}

interface SessionDispatchRecord<TEvent extends GatewayDispatchEvent = GatewayDispatchEvent> {
  seq: number;
  eventId: string;
  event: TEvent;
  payload: GatewayDispatchPayloadMap[TEvent];
  occurredAt: string;
}

export interface StoredGatewaySession {
  sessionId: string;
  resumeToken: string;
  userId: string;
  shardId: number;
  subscriptions: GatewaySubscription[];
  connectionId: string | null;
  instanceId: string | null;
  leaseExpiresAt: string;
  ipAddress: string;
  authSessionId: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
  status: "connected" | "disconnected";
  lastSequence: number;
  lastAckedSequence: number;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  lastDisconnectedAt: string | null;
}

export interface SessionResumeResult {
  session: StoredGatewaySession;
  replay: SessionDispatchRecord[];
}

export interface SessionLeaseResult {
  status: "renewed" | "claimed" | "owned_by_other" | "missing";
  ownerInstanceId: string | null;
  leaseExpiresAt: string | null;
}

const APPEND_DISPATCH_EVENT_SCRIPT = `
if redis.call("HEXISTS", KEYS[1], "sessionId") == 0 then
  return 0
end
local owner = redis.call("HGET", KEYS[1], "instanceId") or ""
if owner == "" or owner ~= ARGV[5] then
  return -1
end
local leaseMs = tonumber(redis.call("HGET", KEYS[1], "leaseExpiresAtMs") or "0")
if leaseMs > 0 and leaseMs <= tonumber(ARGV[6]) then
  return -2
end
local nextSeq = redis.call("HINCRBY", KEYS[1], "lastSequence", 1)
local record = cjson.decode(ARGV[3])
record["seq"] = nextSeq
redis.call("HSET", KEYS[1], "updatedAt", ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
redis.call("RPUSH", KEYS[2], cjson.encode(record))
redis.call("LTRIM", KEYS[2], -tonumber(ARGV[4]), -1)
redis.call("EXPIRE", KEYS[2], ARGV[2])
return nextSeq
`;

const RENEW_OR_CLAIM_LEASE_SCRIPT = `
if redis.call("HEXISTS", KEYS[1], "sessionId") == 0 then
  return {"missing", "", ""}
end
local owner = redis.call("HGET", KEYS[1], "instanceId") or ""
local nowMs = tonumber(ARGV[1])
local instanceId = ARGV[2]
local leaseIso = ARGV[3]
local leaseMs = tonumber(ARGV[4])
local allowClaim = ARGV[5] == "1"
if owner == instanceId then
  redis.call("HSET", KEYS[1], "leaseExpiresAt", leaseIso, "leaseExpiresAtMs", tostring(leaseMs), "updatedAt", ARGV[6])
  redis.call("EXPIRE", KEYS[1], ARGV[7])
  redis.call("EXPIRE", KEYS[2], ARGV[7])
  return {"renewed", owner, leaseIso}
end
local currentLeaseMs = tonumber(redis.call("HGET", KEYS[1], "leaseExpiresAtMs") or "0")
if allowClaim and (owner == "" or currentLeaseMs <= nowMs) then
  redis.call("HSET", KEYS[1], "instanceId", instanceId, "leaseExpiresAt", leaseIso, "leaseExpiresAtMs", tostring(leaseMs), "updatedAt", ARGV[6])
  redis.call("EXPIRE", KEYS[1], ARGV[7])
  redis.call("EXPIRE", KEYS[2], ARGV[7])
  return {"claimed", owner, leaseIso}
end
return {"owned_by_other", owner, redis.call("HGET", KEYS[1], "leaseExpiresAt") or ""}
`;

function safeParseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseLeaseMs(values: Record<string, string>): number {
  const explicitLeaseMs = Number.parseInt(values.leaseExpiresAtMs ?? "0", 10);
  if (Number.isFinite(explicitLeaseMs) && explicitLeaseMs > 0) {
    return explicitLeaseMs;
  }
  const parsedFromIso = Date.parse(values.leaseExpiresAt ?? "");
  if (Number.isFinite(parsedFromIso) && parsedFromIso > 0) {
    return parsedFromIso;
  }
  return Date.now();
}

function toSession(values: Record<string, string>): StoredGatewaySession | null {
  if (!values.sessionId || !values.userId) {
    return null;
  }

  const leaseExpiresAtMs = parseLeaseMs(values);
  return {
    sessionId: values.sessionId,
    resumeToken: values.resumeToken,
    userId: values.userId,
    shardId: Number.parseInt(values.shardId ?? "0", 10) || 0,
    subscriptions: safeParseJson(values.subscriptions, []),
    connectionId: values.connectionId || null,
    instanceId: values.instanceId || null,
    leaseExpiresAt: values.leaseExpiresAt || new Date(leaseExpiresAtMs).toISOString(),
    ipAddress: values.ipAddress ?? "",
    authSessionId: values.authSessionId ?? "",
    userAgent: values.userAgent || null,
    client: safeParseJson(values.client, null),
    status: values.status === "connected" ? "connected" : "disconnected",
    lastSequence: Number.parseInt(values.lastSequence ?? "0", 10) || 0,
    lastAckedSequence: Number.parseInt(values.lastAckedSequence ?? "0", 10) || 0,
    createdAt: values.createdAt ?? new Date().toISOString(),
    updatedAt: values.updatedAt ?? new Date().toISOString(),
    lastHeartbeatAt: values.lastHeartbeatAt ?? new Date().toISOString(),
    lastDisconnectedAt: values.lastDisconnectedAt || null,
  };
}

function parseLeaseResult(raw: unknown): SessionLeaseResult {
  if (!Array.isArray(raw)) {
    return {
      status: "missing",
      ownerInstanceId: null,
      leaseExpiresAt: null,
    };
  }
  const statusRaw = String(raw[0] ?? "").trim();
  const ownerRaw = String(raw[1] ?? "").trim() || null;
  const leaseRaw = String(raw[2] ?? "").trim() || null;
  if (statusRaw === "renewed" || statusRaw === "claimed" || statusRaw === "owned_by_other" || statusRaw === "missing") {
    return {
      status: statusRaw,
      ownerInstanceId: ownerRaw,
      leaseExpiresAt: leaseRaw,
    };
  }
  return {
    status: "missing",
    ownerInstanceId: ownerRaw,
    leaseExpiresAt: leaseRaw,
  };
}

export class RedisSessionStore {
  constructor(
    private readonly redis: RedisManager,
    private readonly resumeTtlSeconds: number,
    private readonly bufferSize: number,
    private readonly leaseDurationMs: number,
  ) {}

  private buildLeaseWindow(nowMs = Date.now()): { leaseExpiresAt: string; leaseExpiresAtMs: number } {
    const leaseExpiresAtMs = nowMs + this.leaseDurationMs;
    return {
      leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
      leaseExpiresAtMs,
    };
  }

  async getAffinity(sessionId: string): Promise<string | null> {
    const affinity = await this.redis.command.get(gatewayRedisKeys.affinity(sessionId));
    return String(affinity ?? "").trim() || null;
  }

  async setAffinity(sessionId: string, instanceId: string): Promise<void> {
    await this.redis.command.set(
      gatewayRedisKeys.affinity(sessionId),
      instanceId,
      "EX",
      this.resumeTtlSeconds,
    );
  }

  async createSession(input: CreateSessionInput): Promise<StoredGatewaySession> {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const leaseWindow = this.buildLeaseWindow();
    const session: StoredGatewaySession = {
      sessionId,
      resumeToken: randomUUID(),
      userId: input.userId,
      shardId: input.shardId,
      subscriptions: input.subscriptions,
      connectionId: input.connectionId,
      instanceId: input.instanceId,
      leaseExpiresAt: leaseWindow.leaseExpiresAt,
      ipAddress: input.ipAddress,
      authSessionId: input.authSessionId,
      userAgent: input.userAgent,
      client: input.client,
      status: "connected",
      lastSequence: 0,
      lastAckedSequence: 0,
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastDisconnectedAt: null,
    };

    await this.writeSession(session, leaseWindow.leaseExpiresAtMs);
    await this.redis.command.sadd(gatewayRedisKeys.userSessions(session.userId), session.sessionId);
    await this.redis.command.expire(gatewayRedisKeys.userSessions(session.userId), this.resumeTtlSeconds);
    await this.setAffinity(session.sessionId, input.instanceId);
    return session;
  }

  async getSession(sessionId: string): Promise<StoredGatewaySession | null> {
    const values = await this.redis.command.hgetall(gatewayRedisKeys.session(sessionId));
    return toSession(values);
  }

  async bindSession(sessionId: string, input: BindSessionInput): Promise<StoredGatewaySession | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const leaseWindow = this.buildLeaseWindow();
    const nextSession: StoredGatewaySession = {
      ...session,
      subscriptions: input.subscriptions,
      connectionId: input.connectionId,
      instanceId: input.instanceId,
      leaseExpiresAt: leaseWindow.leaseExpiresAt,
      ipAddress: input.ipAddress,
      authSessionId: input.authSessionId,
      userAgent: input.userAgent,
      client: input.client,
      status: "connected",
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      lastDisconnectedAt: null,
    };
    await this.writeSession(nextSession, leaseWindow.leaseExpiresAtMs);
    await this.setAffinity(nextSession.sessionId, input.instanceId);
    return nextSession;
  }

  async updateSubscriptions(
    sessionId: string,
    subscriptions: GatewaySubscription[],
    instanceId: string,
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || session.instanceId !== instanceId) {
      return false;
    }

    await this.redis.command.hset(gatewayRedisKeys.session(sessionId), {
      subscriptions: JSON.stringify(subscriptions),
      updatedAt: new Date().toISOString(),
    });
    await this.redis.command.expire(gatewayRedisKeys.session(sessionId), this.resumeTtlSeconds);
    await this.redis.command.expire(gatewayRedisKeys.sessionEvents(sessionId), this.resumeTtlSeconds);
    await this.setAffinity(sessionId, instanceId);
    return true;
  }

  async touchHeartbeat(
    sessionId: string,
    lastAckedSequence: number | null,
    instanceId: string,
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || session.instanceId !== instanceId) {
      return false;
    }

    const leaseWindow = this.buildLeaseWindow();
    const payload: Record<string, string> = {
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: leaseWindow.leaseExpiresAt,
      leaseExpiresAtMs: String(leaseWindow.leaseExpiresAtMs),
    };
    if (typeof lastAckedSequence === "number" && Number.isFinite(lastAckedSequence)) {
      payload.lastAckedSequence = String(Math.max(0, Math.floor(lastAckedSequence)));
    }
    await this.redis.command.hset(gatewayRedisKeys.session(sessionId), payload);
    await this.redis.command.expire(gatewayRedisKeys.session(sessionId), this.resumeTtlSeconds);
    await this.redis.command.expire(gatewayRedisKeys.sessionEvents(sessionId), this.resumeTtlSeconds);
    await this.setAffinity(sessionId, instanceId);
    return true;
  }

  async renewOrClaimLease(sessionId: string, instanceId: string, allowClaim: boolean): Promise<SessionLeaseResult> {
    const nowMs = Date.now();
    const leaseWindow = this.buildLeaseWindow(nowMs);
    const resultRaw = await this.redis.command.eval(
      RENEW_OR_CLAIM_LEASE_SCRIPT,
      2,
      gatewayRedisKeys.session(sessionId),
      gatewayRedisKeys.sessionEvents(sessionId),
      String(nowMs),
      instanceId,
      leaseWindow.leaseExpiresAt,
      String(leaseWindow.leaseExpiresAtMs),
      allowClaim ? "1" : "0",
      new Date(nowMs).toISOString(),
      String(this.resumeTtlSeconds),
    );
    const result = parseLeaseResult(resultRaw);
    if (result.status === "renewed" || result.status === "claimed") {
      await this.setAffinity(sessionId, instanceId);
    }
    return result;
  }

  async markDisconnected(sessionId: string, input: MarkDisconnectedInput = {}): Promise<StoredGatewaySession | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (input.instanceId && session.instanceId !== input.instanceId) {
      return null;
    }
    if (input.connectionId && session.connectionId !== input.connectionId) {
      return null;
    }

    const now = new Date().toISOString();
    const leaseExpiresAtMs = parseLeaseMs({
      leaseExpiresAt: session.leaseExpiresAt,
    });
    const nextSession: StoredGatewaySession = {
      ...session,
      connectionId: null,
      status: "disconnected",
      updatedAt: now,
      lastDisconnectedAt: now,
    };
    await this.writeSession(nextSession, leaseExpiresAtMs);
    if (nextSession.instanceId) {
      await this.setAffinity(nextSession.sessionId, nextSession.instanceId);
    }
    return nextSession;
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      await this.redis.command.srem(gatewayRedisKeys.userSessions(session.userId), sessionId);
    }
    await Promise.all([
      this.redis.command.del(gatewayRedisKeys.session(sessionId)),
      this.redis.command.del(gatewayRedisKeys.sessionEvents(sessionId)),
      this.redis.command.del(gatewayRedisKeys.affinity(sessionId)),
    ]);
  }

  async appendDispatchEvent<TEvent extends GatewayDispatchEvent>(input: {
    sessionId: string;
    instanceId: string;
    eventId: string;
    event: TEvent;
    payload: GatewayDispatchPayloadMap[TEvent];
    occurredAt: string;
  }): Promise<SessionDispatchRecord<TEvent> | null> {
    const sessionKey = gatewayRedisKeys.session(input.sessionId);
    const eventsKey = gatewayRedisKeys.sessionEvents(input.sessionId);
    const updatedAt = new Date().toISOString();
    const provisionalRecord = {
      seq: 0,
      eventId: input.eventId,
      event: input.event,
      payload: input.payload,
      occurredAt: input.occurredAt,
    };
    const nextSequenceRaw = await this.redis.command.eval(
      APPEND_DISPATCH_EVENT_SCRIPT,
      2,
      sessionKey,
      eventsKey,
      updatedAt,
      String(this.resumeTtlSeconds),
      JSON.stringify(provisionalRecord),
      String(this.bufferSize),
      input.instanceId,
      String(Date.now()),
    );
    const nextSequence =
      typeof nextSequenceRaw === "number"
        ? nextSequenceRaw
        : Number.parseInt(String(nextSequenceRaw ?? "0"), 10);
    if (!Number.isFinite(nextSequence) || nextSequence <= 0) {
      return null;
    }

    return {
      seq: nextSequence,
      eventId: input.eventId,
      event: input.event,
      payload: input.payload,
      occurredAt: input.occurredAt,
    };
  }

  async resolveResume(sessionId: string, resumeToken: string, sequence: number): Promise<SessionResumeResult | null> {
    const session = await this.getSession(sessionId);
    if (!session || session.resumeToken !== resumeToken) {
      return null;
    }

    if (sequence > session.lastSequence) {
      return null;
    }

    const rawRecords = await this.redis.command.lrange(gatewayRedisKeys.sessionEvents(sessionId), 0, -1);
    const records = rawRecords
      .map((record) => safeParseJson<SessionDispatchRecord | null>(record, null))
      .filter((record): record is SessionDispatchRecord => Boolean(record))
      .sort((left, right) => left.seq - right.seq);

    const firstSequence = records[0]?.seq ?? session.lastSequence;
    if (records.length > 0 && sequence < firstSequence - 1) {
      return null;
    }

    return {
      session,
      replay: records.filter((record) => record.seq > sequence),
    };
  }

  private async writeSession(session: StoredGatewaySession, leaseExpiresAtMs: number): Promise<void> {
    await this.redis.command.hset(gatewayRedisKeys.session(session.sessionId), {
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      userId: session.userId,
      shardId: String(session.shardId),
      subscriptions: JSON.stringify(session.subscriptions),
      connectionId: session.connectionId ?? "",
      instanceId: session.instanceId ?? "",
      leaseExpiresAt: session.leaseExpiresAt,
      leaseExpiresAtMs: String(leaseExpiresAtMs),
      ipAddress: session.ipAddress,
      authSessionId: session.authSessionId,
      userAgent: session.userAgent ?? "",
      client: JSON.stringify(session.client),
      status: session.status,
      lastSequence: String(session.lastSequence),
      lastAckedSequence: String(session.lastAckedSequence),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      lastDisconnectedAt: session.lastDisconnectedAt ?? "",
    });
    await this.redis.command.expire(gatewayRedisKeys.session(session.sessionId), this.resumeTtlSeconds);
    await this.redis.command.expire(gatewayRedisKeys.sessionEvents(session.sessionId), this.resumeTtlSeconds);
  }
}
