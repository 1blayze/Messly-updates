/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import {
  insertCallEventMessage,
  markParticipantJoined,
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

const ROUTE = "call-accept";

const payloadSchema = z
  .object({
    callId: z.string().uuid(),
  })
  .strict();

function parsePayload(raw: unknown): { callId: string } {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload inválido.", {
      issues: parsed.error.issues.map((issue: { path: PropertyKey[]; message: string }) => ({
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

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE);

  try {
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    assertMethod(request, "POST");
    const auth = await validateSupabaseToken(request);
    context.uid = auth.uid;
    context.action = "accept";

    await enforceRateLimit(`call-accept:${auth.uid}`, 20, 60_000, ROUTE);
    const payload = parsePayload(await parseJsonBody<unknown>(request));

    const { call } = await resolveCallAuthorizationContext(auth.uid, auth.email, payload.callId);
    if (auth.uid === call.created_by) {
      throw new HttpError(403, "FORBIDDEN", "Somente quem recebeu a chamada pode aceitar.");
    }
    if (call.status === "ended" || call.status === "declined" || call.status === "missed") {
      throw new HttpError(409, "CALL_ALREADY_FINISHED", "Esta chamada já foi encerrada.");
    }

    if (call.status !== "ringing" && call.status !== "active") {
      throw new HttpError(409, "CALL_NOT_ACCEPTABLE", "Esta chamada não pode ser aceita.");
    }

    const nowIso = new Date().toISOString();
    const participants = markParticipantJoined(parseParticipants(call.participants), auth.uid, nowIso);
    const updated = await updateCallSession(call.id, {
      status: "active",
      started_at: call.started_at ?? nowIso,
      last_activity_at: nowIso,
      grace_started_at: null,
      participants,
    });

    await insertCallEventMessage({
      call: updated,
      kind: "started",
      actorFirebaseUid: auth.uid,
      reason: null,
      durationSec: null,
    });

    logStructured("info", "call_accept_success", context, {
      status: 200,
      callId: updated.id,
      conversationId: updated.conversation_id,
    });

    return responseJson(request, {
      call: serializeCall(updated),
    });
  } catch (error) {
    logStructured("error", "call_accept_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
