import { HttpError } from "./http.ts";
import { getSupabaseAdminClient } from "./supabaseAdmin.ts";
import { assertConversationMembership, resolveUserIdByFirebaseUid } from "./user.ts";

export type CallMode = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";
export type CallSignalType = "offer" | "answer" | "ice" | "bye";
export type CallEndedReason = "no_answer" | "hangup" | "timeout" | "declined" | "error";
export type CallEventKind = "started" | "missed" | "declined" | "ended";

export interface CallParticipantState {
  joinedAt: string | null;
  leftAt: string | null;
}

export interface CallParticipants {
  [uid: string]: CallParticipantState;
}

export interface CallSessionRow {
  id: string;
  conversation_id: string;
  created_by: string;
  mode: CallMode;
  status: CallStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_activity_at: string;
  grace_started_at: string | null;
  ended_reason: CallEndedReason | null;
  participants: unknown;
}

export interface ConversationMemberMap {
  conversationId: string;
  userIds: [string, string];
  firebaseUidByUserId: Map<string, string>;
  userIdByFirebaseUid: Map<string, string>;
}

const CALL_TIMEOUT_MS = 3 * 60_000;
const ALLOWED_CALL_STATUSES = new Set<CallStatus>(["ringing", "active", "ended", "missed", "declined"]);
const ALLOWED_CALL_MODES = new Set<CallMode>(["audio", "video"]);
const ALLOWED_SIGNAL_TYPES = new Set<CallSignalType>(["offer", "answer", "ice", "bye"]);
const ALLOWED_END_REASONS = new Set<CallEndedReason>(["no_answer", "hangup", "timeout", "declined", "error"]);

function toIsoNow(): string {
  return new Date().toISOString();
}

function toFiniteTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeParticipant(raw: unknown): CallParticipantState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      joinedAt: null,
      leftAt: null,
    };
  }

  const casted = raw as { joinedAt?: unknown; leftAt?: unknown };
  const joinedAtRaw = typeof casted.joinedAt === "string" ? casted.joinedAt.trim() : "";
  const leftAtRaw = typeof casted.leftAt === "string" ? casted.leftAt.trim() : "";

  return {
    joinedAt: joinedAtRaw || null,
    leftAt: leftAtRaw || null,
  };
}

export function parseParticipants(raw: unknown): CallParticipants {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const participants: CallParticipants = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const uid = String(key ?? "").trim();
    if (!uid) {
      continue;
    }
    participants[uid] = normalizeParticipant(value);
  }

  return participants;
}

export function markParticipantJoined(current: CallParticipants, uid: string, joinedAt = toIsoNow()): CallParticipants {
  const normalizedUid = String(uid ?? "").trim();
  if (!normalizedUid) {
    return current;
  }

  const next = { ...current };
  const existing = normalizeParticipant(next[normalizedUid]);
  next[normalizedUid] = {
    joinedAt: existing.joinedAt ?? joinedAt,
    leftAt: null,
  };
  return next;
}

export function markParticipantLeft(current: CallParticipants, uid: string, leftAt = toIsoNow()): CallParticipants {
  const normalizedUid = String(uid ?? "").trim();
  if (!normalizedUid) {
    return current;
  }

  const next = { ...current };
  const existing = normalizeParticipant(next[normalizedUid]);
  next[normalizedUid] = {
    joinedAt: existing.joinedAt ?? leftAt,
    leftAt,
  };
  return next;
}

export function hasConnectedParticipant(participants: CallParticipants): boolean {
  for (const participant of Object.values(participants)) {
    if (participant.joinedAt && !participant.leftAt) {
      return true;
    }
  }
  return false;
}

export function countConnectedParticipants(participants: CallParticipants): number {
  let count = 0;
  for (const participant of Object.values(participants)) {
    if (participant.joinedAt && !participant.leftAt) {
      count += 1;
    }
  }
  return count;
}

export function getCallTimeoutMs(): number {
  return CALL_TIMEOUT_MS;
}

export function isTerminalCallStatus(status: CallStatus): boolean {
  return status === "ended" || status === "missed" || status === "declined";
}

export function validateCallMode(modeRaw: unknown): CallMode {
  const mode = String(modeRaw ?? "").trim().toLowerCase() as CallMode;
  if (!ALLOWED_CALL_MODES.has(mode)) {
    throw new HttpError(400, "INVALID_CALL_MODE", "Modo de chamada invalido.");
  }
  return mode;
}

export function validateSignalType(typeRaw: unknown): CallSignalType {
  const type = String(typeRaw ?? "").trim().toLowerCase() as CallSignalType;
  if (!ALLOWED_SIGNAL_TYPES.has(type)) {
    throw new HttpError(400, "INVALID_SIGNAL_TYPE", "Tipo de sinal invalido.");
  }
  return type;
}

export function validateEndedReason(reasonRaw: unknown): CallEndedReason {
  const reason = String(reasonRaw ?? "").trim().toLowerCase() as CallEndedReason;
  if (!ALLOWED_END_REASONS.has(reason)) {
    throw new HttpError(400, "INVALID_ENDED_REASON", "Motivo de encerramento invalido.");
  }
  return reason;
}

function normalizeCallSessionRow(raw: unknown): CallSessionRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const casted = raw as Record<string, unknown>;
  const id = String(casted.id ?? "").trim();
  const conversationId = String(casted.conversation_id ?? "").trim();
  const createdBy = String(casted.created_by ?? "").trim();
  const createdAt = String(casted.created_at ?? "").trim();
  const lastActivityAt = String(casted.last_activity_at ?? "").trim();
  const statusRaw = String(casted.status ?? "").trim().toLowerCase() as CallStatus;
  const modeRaw = String(casted.mode ?? "").trim().toLowerCase() as CallMode;
  const startedAt = String(casted.started_at ?? "").trim() || null;
  const endedAt = String(casted.ended_at ?? "").trim() || null;
  const graceStartedAt = String(casted.grace_started_at ?? "").trim() || null;
  const endedReasonRaw = String(casted.ended_reason ?? "").trim().toLowerCase();

  if (!id || !conversationId || !createdBy || !createdAt || !lastActivityAt) {
    return null;
  }

  if (!ALLOWED_CALL_STATUSES.has(statusRaw) || !ALLOWED_CALL_MODES.has(modeRaw)) {
    return null;
  }

  const endedReason = endedReasonRaw
    ? (ALLOWED_END_REASONS.has(endedReasonRaw as CallEndedReason) ? (endedReasonRaw as CallEndedReason) : null)
    : null;

  return {
    id,
    conversation_id: conversationId,
    created_by: createdBy,
    mode: modeRaw,
    status: statusRaw,
    created_at: createdAt,
    started_at: startedAt,
    ended_at: endedAt,
    last_activity_at: lastActivityAt,
    grace_started_at: graceStartedAt,
    ended_reason: endedReason,
    participants: casted.participants ?? {},
  };
}

export async function getConversationMembers(conversationId: string): Promise<ConversationMemberMap> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id,user1_id,user2_id")
    .eq("id", conversationId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "CONVERSATION_LOOKUP_FAILED", "Falha ao carregar conversa.");
  }

  const row = data as { id?: string; user1_id?: string; user2_id?: string } | null;
  const conversationIdValue = String(row?.id ?? "").trim();
  const user1Id = String(row?.user1_id ?? "").trim();
  const user2Id = String(row?.user2_id ?? "").trim();
  if (!conversationIdValue || !user1Id || !user2Id) {
    throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversa nao encontrada.");
  }

  const { data: usersData, error: usersError } = await supabase
    .from("users")
    .select("id,firebase_uid")
    .in("id", [user1Id, user2Id]);

  if (usersError) {
    throw new HttpError(500, "CONVERSATION_MEMBERS_LOOKUP_FAILED", "Falha ao carregar membros da conversa.");
  }

  const firebaseUidByUserId = new Map<string, string>();
  const userIdByFirebaseUid = new Map<string, string>();
  const userRows = Array.isArray(usersData) ? usersData : [];
  for (const raw of userRows) {
    const id = String((raw as { id?: unknown }).id ?? "").trim();
    const firebaseUid = String((raw as { firebase_uid?: unknown }).firebase_uid ?? "").trim();
    if (!id || !firebaseUid) {
      continue;
    }
    firebaseUidByUserId.set(id, firebaseUid);
    userIdByFirebaseUid.set(firebaseUid, id);
  }

  if (!firebaseUidByUserId.get(user1Id) || !firebaseUidByUserId.get(user2Id)) {
    throw new HttpError(500, "CONVERSATION_MEMBER_NOT_MAPPED", "Conversa com membro sem firebase_uid.");
  }

  return {
    conversationId: conversationIdValue,
    userIds: [user1Id, user2Id],
    firebaseUidByUserId,
    userIdByFirebaseUid,
  };
}

export async function loadCallSession(callId: string): Promise<CallSessionRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("id", callId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "CALL_LOOKUP_FAILED", "Falha ao carregar sessao de chamada.");
  }

  const normalized = normalizeCallSessionRow(data);
  if (!normalized) {
    throw new HttpError(404, "CALL_NOT_FOUND", "Chamada nao encontrada.");
  }

  return normalized;
}

export async function resolveCallAuthorizationContext(
  authUid: string,
  authEmail: string | null | undefined,
  callId: string,
): Promise<{
  call: CallSessionRow;
  authUserId: string;
  members: ConversationMemberMap;
}> {
  const authUserId = await resolveUserIdByFirebaseUid(authUid, authEmail);
  const call = await loadCallSession(callId);
  await assertConversationMembership(call.conversation_id, authUserId);

  const members = await getConversationMembers(call.conversation_id);
  if (!members.userIdByFirebaseUid.has(authUid)) {
    throw new HttpError(403, "FORBIDDEN", "Usuario sem permissao para esta chamada.");
  }

  return {
    call,
    authUserId,
    members,
  };
}

export async function updateCallSession(
  callId: string,
  patch: Record<string, unknown>,
): Promise<CallSessionRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("call_sessions")
    .update(patch)
    .eq("id", callId)
    .select("*")
    .limit(1)
    .single();

  if (error || !data) {
    throw new HttpError(500, "CALL_UPDATE_FAILED", "Falha ao atualizar sessao de chamada.");
  }

  const normalized = normalizeCallSessionRow(data);
  if (!normalized) {
    throw new HttpError(500, "CALL_UPDATE_FAILED", "Sessao de chamada retornou dados invalidos.");
  }

  return normalized;
}

export async function resolveSenderUserIdForCallEvent(
  call: Pick<CallSessionRow, "created_by" | "conversation_id">,
  actorFirebaseUid?: string | null,
): Promise<string> {
  const preferredUid = String(actorFirebaseUid ?? "").trim() || String(call.created_by ?? "").trim();
  if (preferredUid) {
    try {
      return await resolveUserIdByFirebaseUid(preferredUid, null);
    } catch {
      // ignore and fallback below
    }
  }

  const members = await getConversationMembers(call.conversation_id);
  return members.userIds[0];
}

export function computeDurationSeconds(startedAt: string | null, endedAtRaw?: string | null): number | null {
  const startTimestamp = toFiniteTimestamp(startedAt);
  if (startTimestamp == null) {
    return null;
  }

  const endedAt = endedAtRaw ?? toIsoNow();
  const endTimestamp = toFiniteTimestamp(endedAt);
  if (endTimestamp == null || endTimestamp < startTimestamp) {
    return null;
  }

  return Math.max(0, Math.round((endTimestamp - startTimestamp) / 1000));
}

export async function insertCallEventMessage(params: {
  call: CallSessionRow;
  kind: CallEventKind;
  actorFirebaseUid?: string | null;
  reason?: CallEndedReason | null;
  durationSec?: number | null;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const senderUserId = await resolveSenderUserIdForCallEvent(params.call, params.actorFirebaseUid);

  const durationSec =
    typeof params.durationSec === "number" && Number.isFinite(params.durationSec) && params.durationSec >= 0
      ? Math.round(params.durationSec)
      : null;

  const payload = {
    kind: params.kind,
    reason: params.reason ?? null,
    durationSec,
    mode: params.call.mode,
  };

  const clientId = `call-event:${params.call.id}:${params.kind}`;
  const { error } = await supabase.from("messages").insert({
    conversation_id: params.call.conversation_id,
    sender_id: senderUserId,
    client_id: clientId,
    content: "",
    type: "call_event",
    call_id: params.call.id,
    payload,
  });

  if (!error) {
    return;
  }

  const code = String((error as { code?: string }).code ?? "").trim();
  const message = String(error.message ?? "").toLowerCase();
  if (code === "23505" || message.includes("duplicate")) {
    return;
  }

  throw new HttpError(500, "CALL_EVENT_SAVE_FAILED", "Falha ao registrar evento da chamada.");
}

export function normalizeSignalPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "INVALID_SIGNAL_PAYLOAD", "Payload de sinal invalido.");
  }
  return payload as Record<string, unknown>;
}

export function ensureFirebaseUidInConversation(members: ConversationMemberMap, firebaseUid: string): void {
  if (!members.userIdByFirebaseUid.has(firebaseUid)) {
    throw new HttpError(403, "FORBIDDEN", "Participante fora da conversa.");
  }
}

export function validateCallStatus(statusRaw: unknown): CallStatus {
  const status = String(statusRaw ?? "").trim().toLowerCase() as CallStatus;
  if (!ALLOWED_CALL_STATUSES.has(status)) {
    throw new HttpError(400, "INVALID_CALL_STATUS", "Status de chamada invalido.");
  }
  return status;
}
