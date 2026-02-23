import { z } from "npm:zod@3.25.76";
import { validateFirebaseToken } from "../_shared/auth.ts";
import {
  ensureFirebaseUidInConversation,
  isTerminalCallStatus,
  markParticipantJoined,
  normalizeSignalPayload,
  parseParticipants,
  resolveCallAuthorizationContext,
  updateCallSession,
  validateSignalType,
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

const ROUTE = "call-signal-send";

const payloadSchema = z
  .object({
    callId: z.string().uuid(),
    toUid: z.string().min(6).max(180),
    type: z.enum(["offer", "answer", "ice", "bye"]),
    payload: z.record(z.unknown()),
  })
  .strict();

function parsePayload(raw: unknown): {
  callId: string;
  toUid: string;
  type: "offer" | "answer" | "ice" | "bye";
  payload: Record<string, unknown>;
} {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return {
    callId: parsed.data.callId,
    toUid: String(parsed.data.toUid ?? "").trim(),
    type: validateSignalType(parsed.data.type),
    payload: normalizeSignalPayload(parsed.data.payload),
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
    context.action = "signal-send";

    await enforceRateLimit(`call-signal:${auth.uid}`, 1200, 60_000, ROUTE);
    const payload = parsePayload(await parseJsonBody<unknown>(request));
    const { call, members } = await resolveCallAuthorizationContext(auth.uid, auth.email, payload.callId);

    if (isTerminalCallStatus(call.status)) {
      throw new HttpError(409, "CALL_ALREADY_FINISHED", "Esta chamada ja foi encerrada.");
    }

    ensureFirebaseUidInConversation(members, auth.uid);
    ensureFirebaseUidInConversation(members, payload.toUid);

    if (payload.toUid === auth.uid) {
      throw new HttpError(400, "INVALID_SIGNAL_TARGET", "toUid nao pode ser o proprio usuario.");
    }

    const supabase = getSupabaseAdminClient();
    const nowIso = new Date().toISOString();
    const insert = await supabase
      .from("call_signals")
      .insert({
        call_id: call.id,
        from_uid: auth.uid,
        to_uid: payload.toUid,
        type: payload.type,
        payload: payload.payload,
        created_at: nowIso,
      })
      .select("id,created_at")
      .limit(1)
      .single();

    if (insert.error || !insert.data) {
      throw new HttpError(500, "CALL_SIGNAL_SAVE_FAILED", "Falha ao enviar sinal da chamada.");
    }

    const participants = markParticipantJoined(parseParticipants(call.participants), auth.uid, nowIso);
    await updateCallSession(call.id, {
      participants,
      last_activity_at: nowIso,
      grace_started_at: null,
    });

    logStructured("info", "call_signal_send_success", context, {
      status: 200,
      callId: call.id,
      type: payload.type,
      toUid: payload.toUid,
    });

    return responseJson(request, {
      ok: true,
      signalId: String((insert.data as { id?: unknown }).id ?? ""),
      createdAt: String((insert.data as { created_at?: unknown }).created_at ?? nowIso),
    });
  } catch (error) {
    logStructured("error", "call_signal_send_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
