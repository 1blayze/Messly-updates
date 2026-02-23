import { z } from "npm:zod@3.25.76";
import { validateFirebaseToken } from "../_shared/auth.ts";
import {
  countConnectedParticipants,
  computeDurationSeconds,
  insertCallEventMessage,
  isTerminalCallStatus,
  markParticipantLeft,
  parseParticipants,
  resolveCallAuthorizationContext,
  updateCallSession,
  type CallSessionRow,
} from "../_shared/calls.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  assertMethod,
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  parseJsonBody,
  responseError,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";

const ROUTE = "call-hangup";

const payloadSchema = z
  .object({
    callId: z.string().uuid(),
  })
  .strict();

function parsePayload(raw: unknown): { callId: string } {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function serializeCall(call: CallSessionRow): Record<string, unknown> {
  return {
    id: call.id,
    conversationId: call.conversation_id,
    createdBy: call.created_by,
    mode: call.mode,
    status: call.status,
    createdAt: call.created_at,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    lastActivityAt: call.last_activity_at,
    graceStartedAt: call.grace_started_at,
    endedReason: call.ended_reason,
    participants: parseParticipants(call.participants),
  };
}

Deno.serve(async (request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");
    const auth = await validateFirebaseToken(request);
    context.uid = auth.uid;
    context.action = "hangup";

    await enforceRateLimit(`call-hangup:${auth.uid}`, 40, 60_000, ROUTE);
    const payload = parsePayload(await parseJsonBody<unknown>(request));
    const { call } = await resolveCallAuthorizationContext(auth.uid, auth.email, payload.callId);

    if (isTerminalCallStatus(call.status)) {
      return responseJson(request, { ok: true, call: serializeCall(call) });
    }

    const nowIso = new Date().toISOString();
    const participantsAfterLeave = markParticipantLeft(parseParticipants(call.participants), auth.uid, nowIso);

    // If call is still ringing and the initiator cancels, end immediately as hangup.
    if (call.status === "ringing") {
      const ended = await updateCallSession(call.id, {
        status: "ended",
        ended_at: nowIso,
        ended_reason: "hangup",
        grace_started_at: null,
        last_activity_at: nowIso,
        participants: participantsAfterLeave,
      });

      await insertCallEventMessage({
        call: ended,
        kind: "ended",
        actorFirebaseUid: auth.uid,
        reason: "hangup",
        durationSec: computeDurationSeconds(ended.started_at, nowIso),
      });

      const supabase = getSupabaseAdminClient();
      await supabase.from("call_signals").delete().eq("call_id", ended.id);

      return responseJson(request, {
        ok: true,
        call: serializeCall(ended),
      });
    }

    if (call.status !== "active") {
      throw new HttpError(409, "CALL_NOT_ACTIVE", "A chamada nao esta ativa.");
    }

    const connectedParticipantsCount = countConnectedParticipants(participantsAfterLeave);
    if (connectedParticipantsCount <= 0) {
      const ended = await updateCallSession(call.id, {
        status: "ended",
        ended_at: nowIso,
        ended_reason: "hangup",
        grace_started_at: null,
        last_activity_at: nowIso,
        participants: participantsAfterLeave,
      });

      await insertCallEventMessage({
        call: ended,
        kind: "ended",
        actorFirebaseUid: auth.uid,
        reason: "hangup",
        durationSec: computeDurationSeconds(ended.started_at, nowIso),
      });

      const supabase = getSupabaseAdminClient();
      await supabase.from("call_signals").delete().eq("call_id", ended.id);

      logStructured("info", "call_hangup_success", context, {
        status: 200,
        callId: ended.id,
        conversationId: ended.conversation_id,
        connectedParticipantsCount,
      });

      return responseJson(request, {
        ok: true,
        call: serializeCall(ended),
        waitingRejoin: false,
      });
    }

    const updated = await updateCallSession(call.id, {
      participants: participantsAfterLeave,
      last_activity_at: nowIso,
      // Start grace timer when only one participant remains so cron can end after timeout.
      grace_started_at: connectedParticipantsCount === 1 ? (call.grace_started_at ?? nowIso) : null,
    });

    logStructured("info", "call_hangup_success", context, {
      status: 200,
      callId: updated.id,
      conversationId: updated.conversation_id,
      connectedParticipantsCount,
    });

    return responseJson(request, {
      ok: true,
      call: serializeCall(updated),
      waitingRejoin: connectedParticipantsCount === 1,
    });
  } catch (error) {
    logStructured("error", "call_hangup_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
