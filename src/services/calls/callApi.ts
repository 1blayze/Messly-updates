import { authService } from "../auth";
import { supabase } from "../supabase";

export type CallMode = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";
export type CallSignalType = "offer" | "answer" | "ice" | "bye";
export type CallEndedReason = "no_answer" | "hangup" | "timeout" | "declined" | "error";

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

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL_RING_TIMEOUT_MS = 3 * 60_000;

function isUuid(value: string): boolean {
  return UUID_V4_REGEX.test(String(value ?? "").trim());
}

function normalizeCallParticipant(value: unknown): CallParticipantState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { joinedAt: null, leftAt: null };
  }
  const participant = value as { joinedAt?: unknown; leftAt?: unknown };
  return {
    joinedAt: typeof participant.joinedAt === "string" && participant.joinedAt.trim() ? participant.joinedAt : null,
    leftAt: typeof participant.leftAt === "string" && participant.leftAt.trim() ? participant.leftAt : null,
  };
}

function normalizeParticipants(value: unknown): Record<string, CallParticipantState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, CallParticipantState> = {};
  for (const [userIdRaw, participantRaw] of Object.entries(value as Record<string, unknown>)) {
    const userId = String(userIdRaw ?? "").trim();
    if (!userId) {
      continue;
    }
    normalized[userId] = normalizeCallParticipant(participantRaw);
  }
  return normalized;
}

function normalizeCallSession(raw: unknown): CallSession {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("CallSession payload invalido.");
  }
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  const conversationId = String(record.conversationId ?? record.conversation_id ?? "").trim();
  const createdBy = String(record.createdBy ?? record.created_by ?? "").trim();
  const mode = String(record.mode ?? "").trim().toLowerCase() as CallMode;
  const status = String(record.status ?? "").trim().toLowerCase() as CallStatus;
  if (!id || !conversationId || !createdBy || !mode || !status) {
    throw new Error("CallSession payload incompleto.");
  }
  return {
    id,
    conversationId,
    createdBy,
    mode,
    status,
    createdAt: String(record.createdAt ?? record.created_at ?? "").trim() || new Date().toISOString(),
    startedAt: String(record.startedAt ?? record.started_at ?? "").trim() || null,
    endedAt: String(record.endedAt ?? record.ended_at ?? "").trim() || null,
    lastActivityAt: String(record.lastActivityAt ?? record.last_activity_at ?? "").trim() || new Date().toISOString(),
    graceStartedAt: String(record.graceStartedAt ?? record.grace_started_at ?? "").trim() || null,
    endedReason: String(record.endedReason ?? record.ended_reason ?? "").trim().toLowerCase() as CallEndedReason | null,
    participants: normalizeParticipants(record.participants),
  };
}

async function getCurrentUid(): Promise<string> {
  const uid = String(await authService.getCurrentUserId() ?? "").trim();
  if (!uid) {
    throw new Error("Sessao invalida.");
  }
  return uid;
}

function markParticipantJoined(
  participants: Record<string, CallParticipantState>,
  uid: string,
  nowIso: string,
): Record<string, CallParticipantState> {
  const current = participants[uid] ?? { joinedAt: null, leftAt: null };
  return {
    ...participants,
    [uid]: {
      joinedAt: current.joinedAt ?? nowIso,
      leftAt: null,
    },
  };
}

function markParticipantLeft(
  participants: Record<string, CallParticipantState>,
  uid: string,
  nowIso: string,
): Record<string, CallParticipantState> {
  const current = participants[uid] ?? { joinedAt: null, leftAt: null };
  return {
    ...participants,
    [uid]: {
      joinedAt: current.joinedAt ?? nowIso,
      leftAt: nowIso,
    },
  };
}

async function updateCallSession(callId: string, patch: Record<string, unknown>): Promise<CallSession> {
  const { data, error } = await supabase
    .from("call_sessions")
    .update(patch)
    .eq("id", callId)
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Falha ao atualizar chamada.");
  }
  return normalizeCallSession(data);
}

export async function startCall(params: {
  conversationId: string;
  mode: CallMode;
  calleeUid: string;
}): Promise<{ callId: string; status: CallStatus; expiresAt: string; call: CallSession }> {
  const callerUid = await getCurrentUid();
  const conversationId = String(params.conversationId ?? "").trim();
  const calleeUid = String(params.calleeUid ?? "").trim();
  if (!isUuid(conversationId) || !isUuid(calleeUid)) {
    throw new Error("Dados da chamada invalidos.");
  }

  const nowIso = new Date().toISOString();
  const participants = {
    [callerUid]: { joinedAt: nowIso, leftAt: null },
    [calleeUid]: { joinedAt: null, leftAt: null },
  };
  const { data, error } = await supabase
    .from("call_sessions")
    .insert({
      conversation_id: conversationId,
      created_by: callerUid,
      mode: params.mode,
      status: "ringing",
      created_at: nowIso,
      last_activity_at: nowIso,
      participants,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Falha ao iniciar chamada.");
  }
  const call = normalizeCallSession(data);
  return {
    callId: call.id,
    status: call.status,
    expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
    call,
  };
}

export async function acceptCall(callId: string): Promise<CallSession> {
  const session = await getCallSession(callId);
  if (!session) {
    throw new Error("Chamada nao encontrada.");
  }
  const uid = await getCurrentUid();
  const nowIso = new Date().toISOString();
  return updateCallSession(session.id, {
    status: "active",
    started_at: session.startedAt ?? nowIso,
    last_activity_at: nowIso,
    participants: markParticipantJoined(session.participants, uid, nowIso),
  });
}

export async function declineCall(callId: string): Promise<CallSession> {
  const session = await getCallSession(callId);
  if (!session) {
    throw new Error("Chamada nao encontrada.");
  }
  const uid = await getCurrentUid();
  const nowIso = new Date().toISOString();
  return updateCallSession(session.id, {
    status: "declined",
    ended_at: nowIso,
    ended_reason: "declined",
    last_activity_at: nowIso,
    participants: markParticipantLeft(session.participants, uid, nowIso),
  });
}

export async function hangupCall(callId: string): Promise<CallSession> {
  const session = await getCallSession(callId);
  if (!session) {
    throw new Error("Chamada nao encontrada.");
  }
  const uid = await getCurrentUid();
  const nowIso = new Date().toISOString();
  return updateCallSession(session.id, {
    status: "ended",
    ended_at: nowIso,
    ended_reason: "hangup",
    last_activity_at: nowIso,
    participants: markParticipantLeft(session.participants, uid, nowIso),
  });
}

export async function keepaliveCall(callId: string): Promise<CallSession> {
  const session = await getCallSession(callId);
  if (!session) {
    throw new Error("Chamada nao encontrada.");
  }
  const uid = await getCurrentUid();
  const nowIso = new Date().toISOString();
  return updateCallSession(session.id, {
    last_activity_at: nowIso,
    participants: markParticipantJoined(session.participants, uid, nowIso),
  });
}

export async function getCallSession(callId: string): Promise<CallSession | null> {
  const normalizedCallId = String(callId ?? "").trim();
  if (!isUuid(normalizedCallId)) {
    return null;
  }
  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("id", normalizedCallId)
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  return normalizeCallSession(data);
}

export async function getLatestConversationCall(
  conversationId: string,
  statuses: CallStatus[] = ["ringing", "active"],
): Promise<CallSession | null> {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!isUuid(normalizedConversationId)) {
    return null;
  }
  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("conversation_id", normalizedConversationId)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  return normalizeCallSession(data);
}
