import { invokeEdgeJson } from "../edge/edgeClient";

export type CallMode = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";
export type CallSignalType = "offer" | "answer" | "ice" | "bye";
export type CallEndedReason = "no_answer" | "hangup" | "timeout" | "declined" | "error";
export type CallEventKind = "started" | "missed" | "declined" | "ended";

export interface CallParticipantState {
  joinedAt: string | null;
  leftAt: string | null;
}

export interface CallSession {
  id: string;
  conversationId: string;
  createdBy: string;
  mode: CallMode;
  status: CallStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string;
  graceStartedAt: string | null;
  endedReason: CallEndedReason | null;
  participants: Record<string, CallParticipantState>;
}

export interface CallSignal {
  id: string;
  callId: string;
  fromUid: string;
  toUid: string;
  type: CallSignalType;
  payload: Record<string, unknown>;
  createdAt: string;
}

const CALL_START_FUNCTION = "call-start";
const CALL_ACCEPT_FUNCTION = "call-accept";
const CALL_DECLINE_FUNCTION = "call-decline";
const CALL_HANGUP_FUNCTION = "call-hangup";
const CALL_KEEPALIVE_FUNCTION = "call-keepalive";
const CALL_SIGNAL_SEND_FUNCTION = "call-signal-send";
const CALL_SIGNAL_DRAIN_FUNCTION = "call-signal-drain";
const CALL_TIMEOUT_CHECK_FUNCTION = "call-timeout-check";

function normalizeCallParticipant(value: unknown): CallParticipantState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      joinedAt: null,
      leftAt: null,
    };
  }
  const casted = value as { joinedAt?: unknown; leftAt?: unknown };
  return {
    joinedAt: typeof casted.joinedAt === "string" && casted.joinedAt.trim() ? casted.joinedAt : null,
    leftAt: typeof casted.leftAt === "string" && casted.leftAt.trim() ? casted.leftAt : null,
  };
}

function normalizeParticipants(value: unknown): Record<string, CallParticipantState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, CallParticipantState> = {};
  for (const [uidRaw, participantRaw] of Object.entries(value as Record<string, unknown>)) {
    const uid = String(uidRaw ?? "").trim();
    if (!uid) {
      continue;
    }
    result[uid] = normalizeCallParticipant(participantRaw);
  }
  return result;
}

function normalizeCallSession(raw: unknown): CallSession {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid call session payload.");
  }

  const casted = raw as Record<string, unknown>;
  const id = String(casted.id ?? "").trim();
  const conversationId = String(casted.conversationId ?? "").trim();
  const createdBy = String(casted.createdBy ?? "").trim();
  const mode = String(casted.mode ?? "").trim().toLowerCase() as CallMode;
  const status = String(casted.status ?? "").trim().toLowerCase() as CallStatus;
  const createdAt = String(casted.createdAt ?? "").trim();
  const lastActivityAt = String(casted.lastActivityAt ?? "").trim();

  if (!id || !conversationId || !createdBy || !createdAt || !lastActivityAt) {
    throw new Error("Invalid call session payload.");
  }

  if (!["audio", "video"].includes(mode)) {
    throw new Error("Invalid call mode.");
  }
  if (!["ringing", "active", "ended", "missed", "declined"].includes(status)) {
    throw new Error("Invalid call status.");
  }

  const endedReasonRaw = String(casted.endedReason ?? "").trim().toLowerCase();
  const endedReason =
    endedReasonRaw && ["no_answer", "hangup", "timeout", "declined", "error"].includes(endedReasonRaw)
      ? (endedReasonRaw as CallEndedReason)
      : null;

  return {
    id,
    conversationId,
    createdBy,
    mode,
    status,
    createdAt,
    startedAt: String(casted.startedAt ?? "").trim() || null,
    endedAt: String(casted.endedAt ?? "").trim() || null,
    lastActivityAt,
    graceStartedAt: String(casted.graceStartedAt ?? "").trim() || null,
    endedReason,
    participants: normalizeParticipants(casted.participants),
  };
}

function normalizeCallSignal(raw: unknown): CallSignal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid call signal payload.");
  }

  const casted = raw as Record<string, unknown>;
  const id = String(casted.id ?? "").trim();
  const callId = String(casted.callId ?? "").trim();
  const fromUid = String(casted.fromUid ?? "").trim();
  const toUid = String(casted.toUid ?? "").trim();
  const type = String(casted.type ?? "").trim().toLowerCase() as CallSignalType;
  const createdAt = String(casted.createdAt ?? "").trim();
  if (!id || !callId || !fromUid || !toUid || !createdAt) {
    throw new Error("Invalid call signal payload.");
  }
  if (!["offer", "answer", "ice", "bye"].includes(type)) {
    throw new Error("Invalid call signal type.");
  }

  return {
    id,
    callId,
    fromUid,
    toUid,
    type,
    payload:
      casted.payload && typeof casted.payload === "object" && !Array.isArray(casted.payload)
        ? (casted.payload as Record<string, unknown>)
        : {},
    createdAt,
  };
}

export async function startCall(params: {
  conversationId: string;
  mode: CallMode;
  calleeUid: string;
}): Promise<{ callId: string; status: CallStatus; expiresAt: string; call: CallSession }> {
  const response = await invokeEdgeJson<
    { conversationId: string; mode: CallMode; calleeUid: string },
    { callId: string; status: CallStatus; expiresAt: string; call: unknown }
  >(CALL_START_FUNCTION, {
    conversationId: params.conversationId,
    mode: params.mode,
    calleeUid: params.calleeUid,
  }, {
    retries: 1,
    timeoutMs: 20_000,
  });

  return {
    callId: String(response.callId ?? "").trim(),
    status: response.status,
    expiresAt: String(response.expiresAt ?? "").trim(),
    call: normalizeCallSession(response.call),
  };
}

export async function acceptCall(callId: string): Promise<CallSession> {
  const response = await invokeEdgeJson<{ callId: string }, { call: unknown }>(
    CALL_ACCEPT_FUNCTION,
    { callId },
    {
      retries: 1,
      timeoutMs: 20_000,
    },
  );
  return normalizeCallSession(response.call);
}

export async function declineCall(callId: string): Promise<CallSession> {
  const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
    CALL_DECLINE_FUNCTION,
    { callId },
    {
      retries: 1,
      timeoutMs: 18_000,
    },
  );
  return normalizeCallSession(response.call);
}

export async function hangupCall(callId: string): Promise<CallSession> {
  const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
    CALL_HANGUP_FUNCTION,
    { callId },
    {
      retries: 1,
      timeoutMs: 18_000,
    },
  );
  return normalizeCallSession(response.call);
}

export async function keepaliveCall(callId: string): Promise<CallSession> {
  const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
    CALL_KEEPALIVE_FUNCTION,
    { callId },
    {
      retries: 0,
      timeoutMs: 10_000,
    },
  );
  return normalizeCallSession(response.call);
}

export async function sendCallSignal(params: {
  callId: string;
  toUid: string;
  type: CallSignalType;
  payload: Record<string, unknown>;
}): Promise<{ signalId: string; createdAt: string }> {
  const response = await invokeEdgeJson<
    { callId: string; toUid: string; type: CallSignalType; payload: Record<string, unknown> },
    { ok: boolean; signalId: string; createdAt: string }
  >(CALL_SIGNAL_SEND_FUNCTION, params, {
    retries: 1,
    timeoutMs: 12_000,
  });

  return {
    signalId: String(response.signalId ?? "").trim(),
    createdAt: String(response.createdAt ?? "").trim(),
  };
}

export async function drainCallSignals(params: {
  callId: string;
  since?: string | null;
}): Promise<CallSignal[]> {
  const response = await invokeEdgeJson<
    { callId: string; since?: string | null },
    { callId: string; signals: unknown[] }
  >(CALL_SIGNAL_DRAIN_FUNCTION, {
    callId: params.callId,
    since: params.since ?? null,
  }, {
    retries: 0,
    timeoutMs: 12_000,
  });

  const rows = Array.isArray(response.signals) ? response.signals : [];
  return rows.map(normalizeCallSignal);
}

export async function runCallTimeoutCheck(secret?: string): Promise<{
  missedCount: number;
  timeoutEndedCount: number;
  checkedAt: string;
}> {
  const headers = secret ? { "x-call-timeout-secret": secret } : undefined;
  const response = await invokeEdgeJson<Record<string, never>, {
    ok: boolean;
    missedCount: number;
    timeoutEndedCount: number;
    checkedAt: string;
  }>(CALL_TIMEOUT_CHECK_FUNCTION, {}, {
    retries: 0,
    timeoutMs: 20_000,
    headers,
  });

  return {
    missedCount: Number(response.missedCount ?? 0),
    timeoutEndedCount: Number(response.timeoutEndedCount ?? 0),
    checkedAt: String(response.checkedAt ?? "").trim(),
  };
}
