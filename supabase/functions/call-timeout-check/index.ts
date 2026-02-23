import {
  computeDurationSeconds,
  getCallTimeoutMs,
  insertCallEventMessage,
  loadCallSession,
  markParticipantLeft,
  parseParticipants,
  updateCallSession,
} from "../_shared/calls.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  responseError,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";

const ROUTE = "call-timeout-check";
const BATCH_LIMIT = 200;

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertCronSecret(request: Request): void {
  const expected = String(Deno.env.get("CALL_TIMEOUT_CRON_SECRET") ?? "").trim();
  if (!expected) {
    return;
  }

  const headerSecret = String(request.headers.get("x-call-timeout-secret") ?? "").trim();
  if (headerSecret && headerSecret === expected) {
    return;
  }

  const authHeader = String(request.headers.get("authorization") ?? "").trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const bearerSecret = String(bearerMatch?.[1] ?? "").trim();
  if (bearerSecret && bearerSecret === expected) {
    return;
  }

  throw new HttpError(401, "UNAUTHORIZED", "Acesso negado ao timeout checker.");
}

async function closeRingingCalls(cutoffIso: string): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("call_sessions")
    .select("id")
    .eq("status", "ringing")
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new HttpError(500, "CALL_TIMEOUT_LIST_FAILED", "Falha ao listar chamadas ringing expiradas.");
  }

  const rows = Array.isArray(data) ? data : [];
  let updatedCount = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const callId = String((row as { id?: unknown }).id ?? "").trim();
    if (!callId) {
      continue;
    }

    const call = await loadCallSession(callId);
    if (call.status !== "ringing") {
      continue;
    }

    const createdAtMs = parseTimestamp(call.created_at);
    if (createdAtMs == null || createdAtMs > Date.now() - getCallTimeoutMs()) {
      continue;
    }

    let participants = parseParticipants(call.participants);
    // Force both participants as left when ringing expired.
    for (const uid of Object.keys(participants)) {
      participants = markParticipantLeft(participants, uid, nowIso);
    }

    const ended = await updateCallSession(call.id, {
      status: "missed",
      ended_at: nowIso,
      ended_reason: "no_answer",
      last_activity_at: nowIso,
      grace_started_at: null,
      participants,
    });

    await insertCallEventMessage({
      call: ended,
      kind: "missed",
      reason: "no_answer",
      durationSec: null,
    });
    await supabase.from("call_signals").delete().eq("call_id", ended.id);
    updatedCount += 1;
  }

  return updatedCount;
}

async function closeTimedOutActiveCalls(cutoffIso: string): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("call_sessions")
    .select("id")
    .eq("status", "active")
    .or(`grace_started_at.lte.${cutoffIso},last_activity_at.lte.${cutoffIso}`)
    .order("last_activity_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    throw new HttpError(500, "CALL_TIMEOUT_LIST_FAILED", "Falha ao listar chamadas ativas expiradas.");
  }

  const rows = Array.isArray(data) ? data : [];
  let updatedCount = 0;
  const nowIso = new Date().toISOString();
  const timeoutCutoffMs = Date.now() - getCallTimeoutMs();

  for (const row of rows) {
    const callId = String((row as { id?: unknown }).id ?? "").trim();
    if (!callId) {
      continue;
    }

    const call = await loadCallSession(callId);
    if (call.status !== "active") {
      continue;
    }

    const participants = parseParticipants(call.participants);
    const hasConnected = Object.values(participants).some((participant) => participant.joinedAt && !participant.leftAt);
    const graceStartedAtMs = parseTimestamp(call.grace_started_at);
    const lastActivityMs = parseTimestamp(call.last_activity_at);

    const shouldTimeout =
      (graceStartedAtMs != null && graceStartedAtMs <= timeoutCutoffMs) ||
      (!hasConnected && lastActivityMs != null && lastActivityMs <= timeoutCutoffMs);

    if (!shouldTimeout) {
      continue;
    }

    const ended = await updateCallSession(call.id, {
      status: "ended",
      ended_at: nowIso,
      ended_reason: "timeout",
      last_activity_at: nowIso,
      grace_started_at: null,
      participants,
    });

    await insertCallEventMessage({
      call: ended,
      kind: "ended",
      reason: "timeout",
      durationSec: computeDurationSeconds(ended.started_at, nowIso),
    });
    await supabase.from("call_signals").delete().eq("call_id", ended.id);
    updatedCount += 1;
  }

  return updatedCount;
}

Deno.serve(async (request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");
    assertCronSecret(request);

    const cutoffIso = new Date(Date.now() - getCallTimeoutMs()).toISOString();
    const missedCount = await closeRingingCalls(cutoffIso);
    const timeoutEndedCount = await closeTimedOutActiveCalls(cutoffIso);

    logStructured("info", "call_timeout_check_success", context, {
      status: 200,
      missedCount,
      timeoutEndedCount,
    });

    return responseJson(request, {
      ok: true,
      missedCount,
      timeoutEndedCount,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    logStructured("error", "call_timeout_check_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
