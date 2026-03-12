import { randomUUID } from "node:crypto";
import type { SessionClientInfo } from "./sessionManager";
import type { RedisManager } from "../redis/client";
import { gatewayRedisKeys } from "../redis/keys";
import type { GatewaySubscription, GatewayDispatchPayloadMap } from "../protocol/dispatch";
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

const APPEND_DISPATCH_EVENT_SCRIPT = `
if redis.call("HEXISTS", KEYS[1], "sessionId") == 0 then
  return 0
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

function toSession(values: Record<string, string>): StoredGatewaySession | null {
  if (!values.sessionId || !values.userId) {
    return null;
  }

  return {
    sessionId: values.sessionId,
    resumeToken: values.resumeToken,
    userId: values.userId,
    shardId: Number.parseInt(values.shardId ?? "0", 10) || 0,
    subscriptions: safeParseJson(values.subscriptions, []),
    connectionId: values.connectionId || null,
    instanceId: values.instanceId || null,
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

export class RedisSessionStore {
  constructor(
    private readonly redis: RedisManager,
    private readonly resumeTtlSeconds: number,
    private readonly bufferSize: number,
  ) {}

  private async sessionExists(sessionId: string): Promise<boolean> {
    return (await this.redis.command.hexists(gatewayRedisKeys.session(sessionId), "sessionId")) === 1;
  }

  async createSession(input: CreateSessionInput): Promise<StoredGatewaySession> {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const session: StoredGatewaySession = {
      sessionId,
      resumeToken: randomUUID(),
      userId: input.userId,
      shardId: input.shardId,
      subscriptions: input.subscriptions,
      connectionId: input.connectionId,
      instanceId: input.instanceId,
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

    await this.writeSession(session);
    await this.redis.command.sadd(gatewayRedisKeys.userSessions(session.userId), session.sessionId);
    await this.redis.command.expire(gatewayRedisKeys.userSessions(session.userId), this.resumeTtlSeconds);
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

    const nextSession: StoredGatewaySession = {
      ...session,
      subscriptions: input.subscriptions,
      connectionId: input.connectionId,
      instanceId: input.instanceId,
      ipAddress: input.ipAddress,
      authSessionId: input.authSessionId,
      userAgent: input.userAgent,
      client: input.client,
      status: "connected",
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      lastDisconnectedAt: null,
    };
    await this.writeSession(nextSession);
    return nextSession;
  }

  async updateSubscriptions(sessionId: string, subscriptions: GatewaySubscription[]): Promise<boolean> {
    if (!(await this.sessionExists(sessionId))) {
      return false;
    }

    await this.redis.command.hset(gatewayRedisKeys.session(sessionId), {
      subscriptions: JSON.stringify(subscriptions),
      updatedAt: new Date().toISOString(),
    });
    await this.redis.command.expire(gatewayRedisKeys.session(sessionId), this.resumeTtlSeconds);
    return true;
  }

  async touchHeartbeat(sessionId: string, lastAckedSequence: number | null): Promise<boolean> {
    if (!(await this.sessionExists(sessionId))) {
      return false;
    }

    const payload: Record<string, string> = {
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (typeof lastAckedSequence === "number" && Number.isFinite(lastAckedSequence)) {
      payload.lastAckedSequence = String(Math.max(0, Math.floor(lastAckedSequence)));
    }
    await this.redis.command.hset(gatewayRedisKeys.session(sessionId), payload);
    await this.redis.command.expire(gatewayRedisKeys.session(sessionId), this.resumeTtlSeconds);
    return true;
  }

  async markDisconnected(sessionId: string): Promise<StoredGatewaySession | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const now = new Date().toISOString();
    const nextSession: StoredGatewaySession = {
      ...session,
      connectionId: null,
      instanceId: null,
      status: "disconnected",
      updatedAt: now,
      lastDisconnectedAt: now,
    };
    await this.writeSession(nextSession);
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
    ]);
  }

  async appendDispatchEvent<TEvent extends GatewayDispatchEvent>(input: {
    sessionId: string;
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
    );
    const nextSequence =
      typeof nextSequenceRaw === "number"
        ? nextSequenceRaw
        : Number.parseInt(String(nextSequenceRaw ?? "0"), 10);
    if (!Number.isFinite(nextSequence) || nextSequence <= 0) {
      return null;
    }

    const record: SessionDispatchRecord<TEvent> = {
      seq: nextSequence,
      eventId: input.eventId,
      event: input.event,
      payload: input.payload,
      occurredAt: input.occurredAt,
    };

    return record;
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

  private async writeSession(session: StoredGatewaySession): Promise<void> {
    await this.redis.command.hset(gatewayRedisKeys.session(session.sessionId), {
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      userId: session.userId,
      shardId: String(session.shardId),
      subscriptions: JSON.stringify(session.subscriptions),
      connectionId: session.connectionId ?? "",
      instanceId: session.instanceId ?? "",
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
