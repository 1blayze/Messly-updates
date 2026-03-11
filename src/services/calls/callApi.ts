import { authService } from "../auth";
import { EdgeFunctionError, invokeEdgeJson } from "../edge/edgeClient";
import { supabase } from "../supabase";

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
const CALL_RING_TIMEOUT_MS = 3 * 60_000;
const MAX_CALL_SIGNAL_DRAIN = 200;
const CALL_GRACE_STARTED_AT_COLUMN = "grace_started_at";
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const useCallEdgeFunctionsInDev = isFlagEnabled(import.meta.env.VITE_CALLS_USE_EDGE_FUNCTIONS_IN_DEV);
const unavailableCallEdgeFunctions = new Set<string>();
let callSessionGraceStartedAtColumnSupported: boolean | null = null;

type CallSignalTableDefinition = {
  table: "call_signaling" | "call_signals";
  fromColumn: "from_user_id" | "from_uid";
  toColumn: "to_user_id" | "to_uid";
};

const CALL_SIGNAL_TABLE_CANDIDATES: ReadonlyArray<CallSignalTableDefinition> = [
  { table: "call_signaling", fromColumn: "from_user_id", toColumn: "to_user_id" },
  { table: "call_signals", fromColumn: "from_uid", toColumn: "to_uid" },
  { table: "call_signals", fromColumn: "from_user_id", toColumn: "to_user_id" },
  { table: "call_signaling", fromColumn: "from_uid", toColumn: "to_uid" },
];

let resolvedCallSignalTable: CallSignalTableDefinition | null = null;

function isFlagEnabled(rawValue: string | undefined): boolean {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isUuidValue(value: string): boolean {
  return UUID_V4_REGEX.test(String(value ?? "").trim());
}

function normalizeUuidOrThrow(rawValue: string, label: string): string {
  const normalized = String(rawValue ?? "").trim();
  if (!isUuidValue(normalized)) {
    throw new Error(`${label} invalido.`);
  }
  return normalized;
}

function shouldPreferEdgeCallFunctions(): boolean {
  if (!import.meta.env.DEV) {
    return true;
  }
  return useCallEdgeFunctionsInDev;
}

function hasOwnKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function stripUnsupportedCallSessionColumns(patch: Record<string, unknown>): Record<string, unknown> {
  if (callSessionGraceStartedAtColumnSupported !== false || !hasOwnKey(patch, CALL_GRACE_STARTED_AT_COLUMN)) {
    return patch;
  }
  const nextPatch = { ...patch };
  delete nextPatch[CALL_GRACE_STARTED_AT_COLUMN];
  return nextPatch;
}

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
  const conversationId = String(casted.conversationId ?? casted.conversation_id ?? "").trim();
  const createdBy = String(casted.createdBy ?? casted.created_by ?? "").trim();
  const mode = String(casted.mode ?? "").trim().toLowerCase() as CallMode;
  const status = String(casted.status ?? "").trim().toLowerCase() as CallStatus;
  const createdAt = String(casted.createdAt ?? casted.created_at ?? "").trim();
  const lastActivityAt = String(casted.lastActivityAt ?? casted.last_activity_at ?? "").trim();

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
    startedAt: String(casted.startedAt ?? casted.started_at ?? "").trim() || null,
    endedAt: String(casted.endedAt ?? casted.ended_at ?? "").trim() || null,
    lastActivityAt,
    graceStartedAt: String(casted.graceStartedAt ?? casted.grace_started_at ?? "").trim() || null,
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

function isTerminalCallStatus(status: CallStatus): boolean {
  return status === "ended" || status === "missed" || status === "declined";
}

function isFallbackEligibleCallEdgeError(error: unknown): boolean {
  if (!(error instanceof EdgeFunctionError)) {
    return false;
  }

  if (error.code === "EDGE_NETWORK_ERROR") {
    return true;
  }

  if (error.status === 404 || error.status === 0) {
    return true;
  }

  const code = String(error.code ?? "").trim().toUpperCase();
  return (
    code === "HTTP_404" ||
    code === "404" ||
    code === "FUNCTION_NOT_FOUND" ||
    code === "NOT_FOUND"
  );
}

function isEdgeFunctionNotFoundError(error: unknown): boolean {
  if (!(error instanceof EdgeFunctionError)) {
    return false;
  }

  const code = String(error.code ?? "").trim().toUpperCase();
  const message = String(error.message ?? "").trim().toLowerCase();
  return (
    error.status === 404 ||
    code === "HTTP_404" ||
    code === "404" ||
    code === "FUNCTION_NOT_FOUND" ||
    code === "NOT_FOUND" ||
    message.includes("requested function was not found")
    || message.includes("function not found")
    || message.includes("function does not exist")
  );
}

function shouldSkipEdgeFunctionCall(functionName: string): boolean {
  if (!shouldPreferEdgeCallFunctions()) {
    return true;
  }
  return import.meta.env.DEV && unavailableCallEdgeFunctions.has(functionName);
}

function markEdgeFunctionUnavailable(functionName: string, error: unknown): void {
  if (!import.meta.env.DEV) {
    return;
  }
  if (isEdgeFunctionNotFoundError(error)) {
    unavailableCallEdgeFunctions.add(functionName);
  }
}

function isSchemaMismatchSupabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = String((error as { code?: unknown }).code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown }).message ?? "").trim().toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    message.includes("relation") && message.includes("does not exist") ||
    message.includes("column") && message.includes("does not exist")
  );
}

function isMissingCallGraceColumnError(error: unknown): boolean {
  if (!isSchemaMismatchSupabaseError(error)) {
    return false;
  }

  const message = String((error as { message?: unknown }).message ?? "").trim().toLowerCase();
  const details = String((error as { details?: unknown }).details ?? "").trim().toLowerCase();
  const hint = String((error as { hint?: unknown }).hint ?? "").trim().toLowerCase();
  return (
    message.includes(CALL_GRACE_STARTED_AT_COLUMN) ||
    details.includes(CALL_GRACE_STARTED_AT_COLUMN) ||
    hint.includes(CALL_GRACE_STARTED_AT_COLUMN)
  );
}

function isTerminalCallStatusRaw(statusRaw: unknown): boolean {
  const status = String(statusRaw ?? "").trim().toLowerCase();
  return status === "ended" || status === "missed" || status === "declined";
}

function isCallSessionConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = String((error as { code?: unknown }).code ?? "").trim();
  const message = String((error as { message?: unknown }).message ?? "").trim().toLowerCase();
  const details = String((error as { details?: unknown }).details ?? "").trim().toLowerCase();

  return (
    code === "23514" ||
    message.includes("check constraint") ||
    details.includes("call_sessions_terminal_fields_chk") ||
    details.includes("terminal_fields")
  );
}

function normalizeLegacyEndedReason(endedReasonRaw: unknown): string | null {
  const reason = String(endedReasonRaw ?? "").trim().toLowerCase();
  if (!reason || reason === "hangup") {
    return null;
  }
  return "hangup";
}

function applyEndedReasonConstraintFallback(
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!isTerminalCallStatusRaw(patch.status)) {
    return null;
  }

  if (hasOwnKey(patch, "ended_reason")) {
    const fallbackReason = normalizeLegacyEndedReason(patch.ended_reason);
    if (!fallbackReason) {
      return null;
    }
    return {
      ...patch,
      ended_reason: fallbackReason,
    };
  }

  return {
    ...patch,
    ended_reason: "hangup",
  };
}

function isRecoverableCallLookupError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (isSchemaMismatchSupabaseError(error)) {
    return true;
  }

  const status = Number((error as { status?: unknown }).status ?? 0);
  const code = String((error as { code?: unknown }).code ?? "").trim().toUpperCase();
  const message = String((error as { message?: unknown }).message ?? "").trim().toLowerCase();
  const details = String((error as { details?: unknown }).details ?? "").trim().toLowerCase();

  return (
    status === 404 ||
    status === 406 ||
    code === "PGRST116" ||
    message.includes("results contain 0 rows") ||
    details.includes("results contain 0 rows")
  );
}

function markParticipantJoinedDirect(
  participants: Record<string, CallParticipantState>,
  uid: string,
  joinedAt: string,
): Record<string, CallParticipantState> {
  const normalizedUid = String(uid ?? "").trim();
  if (!normalizedUid) {
    return participants;
  }

  const current = participants[normalizedUid] ?? { joinedAt: null, leftAt: null };
  return {
    ...participants,
    [normalizedUid]: {
      joinedAt: current.joinedAt ?? joinedAt,
      leftAt: null,
    },
  };
}

function markParticipantLeftDirect(
  participants: Record<string, CallParticipantState>,
  uid: string,
  leftAt: string,
): Record<string, CallParticipantState> {
  const normalizedUid = String(uid ?? "").trim();
  if (!normalizedUid) {
    return participants;
  }

  const current = participants[normalizedUid] ?? { joinedAt: null, leftAt: null };
  return {
    ...participants,
    [normalizedUid]: {
      joinedAt: current.joinedAt ?? leftAt,
      leftAt,
    },
  };
}

function countConnectedParticipantsDirect(participants: Record<string, CallParticipantState>): number {
  let count = 0;
  for (const participant of Object.values(participants)) {
    if (participant.joinedAt && !participant.leftAt) {
      count += 1;
    }
  }
  return count;
}

async function getCurrentUserIdOrThrow(): Promise<string> {
  const uid = String(await authService.getCurrentUserId() ?? "").trim();
  if (!uid) {
    throw new Error("Sessao invalida ou expirada.");
  }
  return uid;
}

async function getConversationMembersOrThrow(conversationIdRaw: string): Promise<[string, string]> {
  const conversationId = normalizeUuidOrThrow(conversationIdRaw, "Conversa");

  const { data, error } = await supabase
    .from("conversations")
    .select("id,user1_id,user2_id")
    .eq("id", conversationId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const user1Id = String((data as { user1_id?: unknown } | null)?.user1_id ?? "").trim();
  const user2Id = String((data as { user2_id?: unknown } | null)?.user2_id ?? "").trim();
  if (!user1Id || !user2Id) {
    throw new Error("Conversa nao encontrada.");
  }

  return [user1Id, user2Id];
}

async function loadCallSessionOrThrow(callIdRaw: string): Promise<CallSession> {
  const callId = normalizeUuidOrThrow(callIdRaw, "Chamada");

  const session = await getCallSession(callId);
  if (!session) {
    throw new Error("Chamada nao encontrada.");
  }
  return session;
}

async function updateCallSessionDirect(
  callIdRaw: string,
  patch: Record<string, unknown>,
): Promise<CallSession> {
  const callId = normalizeUuidOrThrow(callIdRaw, "Chamada");

  let patchForUpdate = stripUnsupportedCallSessionColumns(patch);
  let usedGraceColumnUpdate = hasOwnKey(patchForUpdate, CALL_GRACE_STARTED_AT_COLUMN);
  let hasTriedLegacyEndedReasonFallback = false;
  if (Object.keys(patchForUpdate).length === 0) {
    const currentSession = await getCallSession(callId);
    if (currentSession) {
      return currentSession;
    }
    throw new Error("Chamada nao encontrada.");
  }

  let { data, error } = await supabase
    .from("call_sessions")
    .update(patchForUpdate)
    .eq("id", callId)
    .select("*")
    .single();

  if ((error || !data) && usedGraceColumnUpdate && isMissingCallGraceColumnError(error)) {
    callSessionGraceStartedAtColumnSupported = false;
    patchForUpdate = { ...patchForUpdate };
    delete patchForUpdate[CALL_GRACE_STARTED_AT_COLUMN];
    usedGraceColumnUpdate = false;

    if (Object.keys(patchForUpdate).length === 0) {
      const currentSession = await getCallSession(callId);
      if (currentSession) {
        return currentSession;
      }
      throw error ?? new Error("Falha ao atualizar chamada.");
    }

    const retryResult = await supabase
      .from("call_sessions")
      .update(patchForUpdate)
      .eq("id", callId)
      .select("*")
      .single();
    data = retryResult.data;
    error = retryResult.error;

    if (error && isCallSessionConstraintViolation(error) && !hasTriedLegacyEndedReasonFallback && isTerminalCallStatusRaw(patch.status)) {
      const constraintFallback = applyEndedReasonConstraintFallback(patchForUpdate);
      if (constraintFallback) {
        const fallbackPatch = stripUnsupportedCallSessionColumns(constraintFallback);
        if (Object.keys(fallbackPatch).length > 0) {
          hasTriedLegacyEndedReasonFallback = true;
          const fallbackRetry = await supabase
            .from("call_sessions")
            .update(fallbackPatch)
            .eq("id", callId)
            .select("*")
            .single();
          data = fallbackRetry.data;
          error = fallbackRetry.error;
        }
      }
    }
  }

  if (error && isCallSessionConstraintViolation(error) && !hasTriedLegacyEndedReasonFallback && isTerminalCallStatusRaw(patchForUpdate.status)) {
    const constraintFallback = applyEndedReasonConstraintFallback(patchForUpdate);
    if (constraintFallback) {
      const fallbackPatch = stripUnsupportedCallSessionColumns(constraintFallback);
      if (Object.keys(fallbackPatch).length > 0) {
        hasTriedLegacyEndedReasonFallback = true;
        const fallbackRetry = await supabase
          .from("call_sessions")
          .update(fallbackPatch)
          .eq("id", callId)
          .select("*")
          .single();
        data = fallbackRetry.data;
        error = fallbackRetry.error;
      }
    }
  }

  if (error || !data) {
    throw error ?? new Error("Falha ao atualizar chamada.");
  }

  if (usedGraceColumnUpdate) {
    callSessionGraceStartedAtColumnSupported = true;
  }

  return normalizeCallSession(data);
}

async function withCallSignalTable<T>(operation: (definition: CallSignalTableDefinition) => Promise<T>): Promise<T> {
  const orderedCandidates = resolvedCallSignalTable
    ? [resolvedCallSignalTable, ...CALL_SIGNAL_TABLE_CANDIDATES.filter((candidate) => candidate !== resolvedCallSignalTable)]
    : [...CALL_SIGNAL_TABLE_CANDIDATES];

  let lastSchemaError: unknown = null;
  for (const candidate of orderedCandidates) {
    try {
      const result = await operation(candidate);
      resolvedCallSignalTable = candidate;
      return result;
    } catch (error) {
      if (!isSchemaMismatchSupabaseError(error)) {
        throw error;
      }
      lastSchemaError = error;
    }
  }

  throw lastSchemaError ?? new Error("Tabela de sinalizacao de chamada indisponivel.");
}

async function clearCallSignalsDirect(callIdRaw: string): Promise<void> {
  const callId = String(callIdRaw ?? "").trim();
  if (!isUuidValue(callId)) {
    return;
  }

  await withCallSignalTable(async (definition) => {
    const { error } = await supabase
      .from(definition.table)
      .delete()
      .eq("call_id", callId);

    if (error) {
      throw error;
    }
  });
}

function parseTimestampMs(value: string | null | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function closeExpiredBlockingCallDirect(call: CallSession): Promise<boolean> {
  const nowMs = Date.now();
  const timeoutCutoffMs = nowMs - CALL_RING_TIMEOUT_MS;
  const nowIso = new Date(nowMs).toISOString();

  if (call.status === "ringing") {
    const createdAtMs = parseTimestampMs(call.createdAt);
    if (createdAtMs == null || createdAtMs > timeoutCutoffMs) {
      return false;
    }

    let participants = call.participants;
    for (const uid of Object.keys(participants)) {
      participants = markParticipantLeftDirect(participants, uid, nowIso);
    }

    await updateCallSessionDirect(call.id, {
      status: "missed",
      ended_at: nowIso,
      ended_reason: "no_answer",
      last_activity_at: nowIso,
      grace_started_at: null,
      participants,
    });
    await clearCallSignalsDirect(call.id).catch(() => undefined);
    return true;
  }

  if (call.status !== "active") {
    return false;
  }

  const hasConnected = countConnectedParticipantsDirect(call.participants) > 0;
  const graceStartedAtMs = parseTimestampMs(call.graceStartedAt);
  const lastActivityAtMs = parseTimestampMs(call.lastActivityAt);
  const inactiveForTooLong = lastActivityAtMs != null && lastActivityAtMs <= timeoutCutoffMs;
  const shouldTimeout =
    inactiveForTooLong ||
    (graceStartedAtMs != null && graceStartedAtMs <= timeoutCutoffMs) ||
    (!hasConnected && lastActivityAtMs != null && lastActivityAtMs <= timeoutCutoffMs);

  if (!shouldTimeout) {
    return false;
  }

  await updateCallSessionDirect(call.id, {
    status: "ended",
    ended_at: nowIso,
    ended_reason: "timeout",
    last_activity_at: nowIso,
    grace_started_at: null,
    participants: call.participants,
  });
  await clearCallSignalsDirect(call.id).catch(() => undefined);
  return true;
}

function canReuseExistingOutgoingRingingCall(call: CallSession, callerUid: string): boolean {
  if (call.status !== "ringing") {
    return false;
  }

  return call.createdBy === callerUid;
}

async function startCallDirect(params: {
  conversationId: string;
  mode: CallMode;
  calleeUid: string;
}): Promise<{ callId: string; status: CallStatus; expiresAt: string; call: CallSession }> {
  const conversationId = normalizeUuidOrThrow(params.conversationId, "Conversa");
  const calleeUid = normalizeUuidOrThrow(params.calleeUid, "Usuario");
  const callerUid = await getCurrentUserIdOrThrow();

  if (calleeUid === callerUid) {
    throw new Error("Nao e possivel iniciar chamada para si mesmo.");
  }

  const members = await getConversationMembersOrThrow(conversationId);
  if (!members.includes(callerUid)) {
    throw new Error("Usuario sem permissao para esta conversa.");
  }
  if (!members.includes(calleeUid)) {
    throw new Error("Destinatario fora da conversa.");
  }

  let activeCall = await getLatestConversationCall(conversationId, ["ringing", "active"]);
  if (activeCall) {
    if (canReuseExistingOutgoingRingingCall(activeCall, callerUid)) {
      const nowIso = new Date().toISOString();
      const participants = markParticipantJoinedDirect(activeCall.participants, callerUid, nowIso);
      const reusedCall = await updateCallSessionDirect(activeCall.id, {
        participants,
        last_activity_at: nowIso,
        grace_started_at: null,
      });
      return {
        callId: reusedCall.id,
        status: reusedCall.status,
        expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
        call: reusedCall,
      };
    }

    const wasExpiredCallClosed = await closeExpiredBlockingCallDirect(activeCall);
    if (wasExpiredCallClosed) {
      activeCall = await getLatestConversationCall(conversationId, ["ringing", "active"]);
      if (!activeCall) {
        // No blocking calls remain, continue to create a fresh session below.
      } else if (canReuseExistingOutgoingRingingCall(activeCall, callerUid)) {
        const nowIso = new Date().toISOString();
        const participants = markParticipantJoinedDirect(activeCall.participants, callerUid, nowIso);
        const reusedCall = await updateCallSessionDirect(activeCall.id, {
          participants,
          last_activity_at: nowIso,
          grace_started_at: null,
        });
        return {
          callId: reusedCall.id,
          status: reusedCall.status,
          expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
          call: reusedCall,
        };
      } else {
        throw new Error("Ja existe uma chamada em andamento nesta conversa.");
      }
    } else {
      throw new Error("Ja existe uma chamada em andamento nesta conversa.");
    }
  }

  const nowIso = new Date().toISOString();
  const participants = {
    [callerUid]: {
      joinedAt: nowIso,
      leftAt: null,
    },
    [calleeUid]: {
      joinedAt: null,
      leftAt: null,
    },
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

async function acceptCallDirect(callId: string): Promise<CallSession> {
  const uid = await getCurrentUserIdOrThrow();
  const call = await loadCallSessionOrThrow(callId);

  if (uid === call.createdBy) {
    throw new Error("Somente quem recebeu a chamada pode aceitar.");
  }
  if (isTerminalCallStatus(call.status)) {
    throw new Error("Esta chamada ja foi encerrada.");
  }
  if (call.status !== "ringing" && call.status !== "active") {
    throw new Error("Esta chamada nao pode ser aceita.");
  }

  const nowIso = new Date().toISOString();
  const participants = markParticipantJoinedDirect(call.participants, uid, nowIso);
  return updateCallSessionDirect(call.id, {
    status: "active",
    started_at: call.startedAt ?? nowIso,
    last_activity_at: nowIso,
    grace_started_at: null,
    participants,
  });
}

async function declineCallDirect(callId: string): Promise<CallSession> {
  const uid = await getCurrentUserIdOrThrow();
  const call = await loadCallSessionOrThrow(callId);

  if (uid === call.createdBy) {
    throw new Error("Somente quem recebeu a chamada pode recusar.");
  }

  if (isTerminalCallStatus(call.status)) {
    return call;
  }
  if (call.status !== "ringing") {
    throw new Error("A chamada nao esta no estado de convite.");
  }

  const nowIso = new Date().toISOString();
  const participants = markParticipantLeftDirect(call.participants, uid, nowIso);
  const updated = await updateCallSessionDirect(call.id, {
    status: "declined",
    ended_at: nowIso,
    ended_reason: "declined",
    last_activity_at: nowIso,
    grace_started_at: null,
    participants,
  });

  await clearCallSignalsDirect(call.id).catch(() => undefined);
  return updated;
}

async function hangupCallDirect(callId: string): Promise<CallSession> {
  const uid = await getCurrentUserIdOrThrow();
  const call = await loadCallSessionOrThrow(callId);

  if (isTerminalCallStatus(call.status)) {
    return call;
  }

  const nowIso = new Date().toISOString();
  const participantsAfterLeave = markParticipantLeftDirect(call.participants, uid, nowIso);

  if (call.status === "ringing") {
    const ended = await updateCallSessionDirect(call.id, {
      status: "ended",
      ended_at: nowIso,
      ended_reason: "hangup",
      grace_started_at: null,
      last_activity_at: nowIso,
      participants: participantsAfterLeave,
    });
    await clearCallSignalsDirect(call.id).catch(() => undefined);
    return ended;
  }

  if (call.status !== "active") {
    throw new Error("A chamada nao esta ativa.");
  }

  const connectedParticipantsCount = countConnectedParticipantsDirect(participantsAfterLeave);
  if (connectedParticipantsCount <= 0) {
    const ended = await updateCallSessionDirect(call.id, {
      status: "ended",
      ended_at: nowIso,
      ended_reason: "hangup",
      grace_started_at: null,
      last_activity_at: nowIso,
      participants: participantsAfterLeave,
    });
    await clearCallSignalsDirect(call.id).catch(() => undefined);
    return ended;
  }

  return updateCallSessionDirect(call.id, {
    participants: participantsAfterLeave,
    last_activity_at: nowIso,
    grace_started_at: connectedParticipantsCount === 1 ? (call.graceStartedAt ?? nowIso) : null,
  });
}

async function keepaliveCallDirect(callId: string): Promise<CallSession> {
  const uid = await getCurrentUserIdOrThrow();
  const call = await loadCallSessionOrThrow(callId);

  if (isTerminalCallStatus(call.status)) {
    throw new Error("Esta chamada ja foi encerrada.");
  }

  const nowIso = new Date().toISOString();
  const participants = markParticipantJoinedDirect(call.participants, uid, nowIso);
  return updateCallSessionDirect(call.id, {
    participants,
    last_activity_at: nowIso,
    grace_started_at: null,
  });
}

async function sendCallSignalDirect(params: {
  callId: string;
  toUid: string;
  type: CallSignalType;
  payload: Record<string, unknown>;
}): Promise<{ signalId: string; createdAt: string }> {
  const uid = await getCurrentUserIdOrThrow();
  const toUid = String(params.toUid ?? "").trim();
  if (!toUid) {
    throw new Error("Destino do sinal invalido.");
  }
  if (toUid === uid) {
    throw new Error("toUid nao pode ser o proprio usuario.");
  }

  const call = await loadCallSessionOrThrow(params.callId);
  if (isTerminalCallStatus(call.status)) {
    throw new Error("Esta chamada ja foi encerrada.");
  }

  const members = await getConversationMembersOrThrow(call.conversationId);
  if (!members.includes(uid) || !members.includes(toUid)) {
    throw new Error("Participante fora da conversa.");
  }

  const nowIso = new Date().toISOString();
  const inserted = await withCallSignalTable(async (definition) => {
    const payload = {
      call_id: call.id,
      [definition.fromColumn]: uid,
      [definition.toColumn]: toUid,
      type: params.type,
      payload: params.payload,
      created_at: nowIso,
    };

    const { data, error } = await supabase
      .from(definition.table)
      .insert(payload)
      .select("id,created_at")
      .single();

    if (error || !data) {
      throw error ?? new Error("Falha ao enviar sinal da chamada.");
    }

    return {
      signalId: String((data as { id?: unknown }).id ?? "").trim(),
      createdAt: String((data as { created_at?: unknown }).created_at ?? nowIso).trim() || nowIso,
    };
  });

  const participants = markParticipantJoinedDirect(call.participants, uid, nowIso);
  await updateCallSessionDirect(call.id, {
    participants,
    last_activity_at: nowIso,
    grace_started_at: null,
  }).catch(() => undefined);

  return inserted;
}

async function drainCallSignalsDirect(params: {
  callId: string;
  since?: string | null;
}): Promise<CallSignal[]> {
  const uid = await getCurrentUserIdOrThrow();
  const call = await loadCallSessionOrThrow(params.callId);

  const signals = await withCallSignalTable(async (definition) => {
    const columns = [
      "id",
      "call_id",
      definition.fromColumn,
      definition.toColumn,
      "type",
      "payload",
      "created_at",
    ].join(",");

    let query = supabase
      .from(definition.table)
      .select(columns)
      .eq("call_id", call.id)
      .eq(definition.toColumn, uid)
      .order("created_at", { ascending: true })
      .limit(MAX_CALL_SIGNAL_DRAIN);

    const since = String(params.since ?? "").trim();
    if (since) {
      query = query.gt("created_at", since);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    return rows
      .map((row) => {
        const rowRecord = row as unknown as Record<string, unknown>;
        return {
          id: String(rowRecord.id ?? "").trim(),
          callId: String(rowRecord.call_id ?? "").trim(),
          fromUid: String(rowRecord[definition.fromColumn] ?? "").trim(),
          toUid: String(rowRecord[definition.toColumn] ?? "").trim(),
          type: String(rowRecord.type ?? "").trim().toLowerCase(),
          payload:
            rowRecord.payload && typeof rowRecord.payload === "object" && !Array.isArray(rowRecord.payload)
              ? (rowRecord.payload as Record<string, unknown>)
              : {},
          createdAt: String(rowRecord.created_at ?? "").trim(),
        };
      })
      .filter((item) => item.id && item.callId && item.fromUid && item.toUid && item.createdAt);
  });

  return signals
    .filter((signal) => signal.type === "offer" || signal.type === "answer" || signal.type === "ice" || signal.type === "bye")
    .map((signal) => normalizeCallSignal(signal));
}

export async function startCall(params: {
  conversationId: string;
  mode: CallMode;
  calleeUid: string;
}): Promise<{ callId: string; status: CallStatus; expiresAt: string; call: CallSession }> {
  if (shouldSkipEdgeFunctionCall(CALL_START_FUNCTION)) {
    return startCallDirect(params);
  }

  try {
    const response = await invokeEdgeJson<
      { conversationId: string; mode: CallMode; calleeUid: string },
      { callId: string; status: CallStatus; expiresAt: string; call: unknown }
    >(CALL_START_FUNCTION, {
      conversationId: params.conversationId,
      mode: params.mode,
      calleeUid: params.calleeUid,
    }, {
      requireAuth: true,
      retries: 1,
      timeoutMs: 20_000,
    });
    const call = normalizeCallSession(response.call);
    const responseCallId = String(response.callId ?? "").trim();
    const callId = isUuidValue(responseCallId) ? responseCallId : normalizeUuidOrThrow(call.id, "Chamada");

    return {
      callId,
      status: response.status,
      expiresAt: String(response.expiresAt ?? "").trim(),
      call,
    };
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_START_FUNCTION, error);
    return startCallDirect(params);
  }
}

export async function acceptCall(callId: string): Promise<CallSession> {
  const normalizedCallId = normalizeUuidOrThrow(callId, "Chamada");
  if (shouldSkipEdgeFunctionCall(CALL_ACCEPT_FUNCTION)) {
    return acceptCallDirect(normalizedCallId);
  }

  try {
    const response = await invokeEdgeJson<{ callId: string }, { call: unknown }>(
      CALL_ACCEPT_FUNCTION,
      { callId: normalizedCallId },
      {
        requireAuth: true,
        retries: 1,
        timeoutMs: 20_000,
      },
    );
    return normalizeCallSession(response.call);
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_ACCEPT_FUNCTION, error);
    return acceptCallDirect(normalizedCallId);
  }
}

export async function declineCall(callId: string): Promise<CallSession> {
  const normalizedCallId = normalizeUuidOrThrow(callId, "Chamada");
  if (shouldSkipEdgeFunctionCall(CALL_DECLINE_FUNCTION)) {
    return declineCallDirect(normalizedCallId);
  }

  try {
    const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
      CALL_DECLINE_FUNCTION,
      { callId: normalizedCallId },
      {
        requireAuth: true,
        retries: 1,
        timeoutMs: 18_000,
      },
    );
    return normalizeCallSession(response.call);
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_DECLINE_FUNCTION, error);
    return declineCallDirect(normalizedCallId);
  }
}

export async function hangupCall(callId: string): Promise<CallSession> {
  const normalizedCallId = normalizeUuidOrThrow(callId, "Chamada");
  if (shouldSkipEdgeFunctionCall(CALL_HANGUP_FUNCTION)) {
    return hangupCallDirect(normalizedCallId);
  }

  try {
    const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
      CALL_HANGUP_FUNCTION,
      { callId: normalizedCallId },
      {
        requireAuth: true,
        retries: 1,
        timeoutMs: 18_000,
      },
    );
    return normalizeCallSession(response.call);
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_HANGUP_FUNCTION, error);
    return hangupCallDirect(normalizedCallId);
  }
}

export async function keepaliveCall(callId: string): Promise<CallSession> {
  const normalizedCallId = normalizeUuidOrThrow(callId, "Chamada");
  if (shouldSkipEdgeFunctionCall(CALL_KEEPALIVE_FUNCTION)) {
    return keepaliveCallDirect(normalizedCallId);
  }

  try {
    const response = await invokeEdgeJson<{ callId: string }, { ok: boolean; call: unknown }>(
      CALL_KEEPALIVE_FUNCTION,
      { callId: normalizedCallId },
      {
        requireAuth: true,
        retries: 0,
        timeoutMs: 10_000,
      },
    );
    return normalizeCallSession(response.call);
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_KEEPALIVE_FUNCTION, error);
    return keepaliveCallDirect(normalizedCallId);
  }
}

export async function sendCallSignal(params: {
  callId: string;
  toUid: string;
  type: CallSignalType;
  payload: Record<string, unknown>;
}): Promise<{ signalId: string; createdAt: string }> {
  const normalizedCallId = normalizeUuidOrThrow(params.callId, "Chamada");
  const normalizedToUid = String(params.toUid ?? "").trim();
  if (!isUuidValue(normalizedToUid)) {
    throw new Error("Usuario de destino invalido.");
  }
  const request = {
    ...params,
    callId: normalizedCallId,
    toUid: normalizedToUid,
  };
  if (shouldSkipEdgeFunctionCall(CALL_SIGNAL_SEND_FUNCTION)) {
    return sendCallSignalDirect(request);
  }

  try {
    const response = await invokeEdgeJson<
      { callId: string; toUid: string; type: CallSignalType; payload: Record<string, unknown> },
      { ok: boolean; signalId: string; createdAt: string }
    >(CALL_SIGNAL_SEND_FUNCTION, request, {
      requireAuth: true,
      retries: 1,
      timeoutMs: 12_000,
    });

    return {
      signalId: String(response.signalId ?? "").trim(),
      createdAt: String(response.createdAt ?? "").trim(),
    };
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_SIGNAL_SEND_FUNCTION, error);
    return sendCallSignalDirect(request);
  }
}

export async function drainCallSignals(params: {
  callId: string;
  since?: string | null;
}): Promise<CallSignal[]> {
  const normalizedCallId = normalizeUuidOrThrow(params.callId, "Chamada");
  if (shouldSkipEdgeFunctionCall(CALL_SIGNAL_DRAIN_FUNCTION)) {
    return drainCallSignalsDirect({
      ...params,
      callId: normalizedCallId,
    });
  }

  try {
    const response = await invokeEdgeJson<
      { callId: string; since?: string | null },
      { callId: string; signals: unknown[] }
    >(CALL_SIGNAL_DRAIN_FUNCTION, {
      callId: normalizedCallId,
      since: params.since ?? null,
    }, {
      requireAuth: true,
      retries: 0,
      timeoutMs: 12_000,
    });

    const rows = Array.isArray(response.signals) ? response.signals : [];
    return rows.map(normalizeCallSignal);
  } catch (error) {
    if (!isFallbackEligibleCallEdgeError(error)) {
      throw error;
    }
    markEdgeFunctionUnavailable(CALL_SIGNAL_DRAIN_FUNCTION, error);
    return drainCallSignalsDirect({
      ...params,
      callId: normalizedCallId,
    });
  }
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

export async function getCallSession(callId: string): Promise<CallSession | null> {
  const normalizedCallId = String(callId ?? "").trim();
  if (!normalizedCallId) {
    return null;
  }
  if (!isUuidValue(normalizedCallId)) {
    throw new Error("ID da chamada invalido.");
  }

  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("id", normalizedCallId)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isRecoverableCallLookupError(error)) {
      return null;
    }
    throw error;
  }

  return data ? normalizeCallSession(data) : null;
}

export async function getLatestConversationCall(
  conversationId: string,
  statuses: CallStatus[] = ["ringing", "active"],
): Promise<CallSession | null> {
  const normalizedConversationId = String(conversationId ?? "").trim();
  if (!normalizedConversationId || !isUuidValue(normalizedConversationId)) {
    return null;
  }

  const normalizedStatuses = Array.from(
    new Set(
      statuses
        .map((status) => String(status ?? "").trim().toLowerCase())
        .filter((status): status is CallStatus =>
          status === "ringing" || status === "active" || status === "ended" || status === "missed" || status === "declined",
        ),
    ),
  );

  let query = supabase
    .from("call_sessions")
    .select("*")
    .eq("conversation_id", normalizedConversationId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (normalizedStatuses.length > 0) {
    query = query.in("status", normalizedStatuses);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isRecoverableCallLookupError(error)) {
      return null;
    }
    throw error;
  }

  return data ? normalizeCallSession(data) : null;
}
