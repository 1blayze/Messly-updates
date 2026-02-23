import { z } from "npm:zod@3.25.76";
import { validateFirebaseToken } from "../_shared/auth.ts";
import {
  ensureFirebaseUidInConversation,
  getCallTimeoutMs,
  getConversationMembers,
  parseParticipants,
  type CallSessionRow,
  validateCallMode,
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
import { assertConversationMembership, resolveUserIdByFirebaseUid } from "../_shared/user.ts";

const ROUTE = "call-start";

const payloadSchema = z
  .object({
    conversationId: z.string().uuid(),
    mode: z.enum(["audio", "video"]),
    calleeUid: z.string().min(6).max(180),
  })
  .strict();

interface StartCallPayload {
  conversationId: string;
  mode: "audio" | "video";
  calleeUid: string;
}

function parsePayload(raw: unknown): StartCallPayload {
  const result = payloadSchema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload invalido.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return {
    conversationId: result.data.conversationId,
    mode: validateCallMode(result.data.mode),
    calleeUid: String(result.data.calleeUid ?? "").trim(),
  };
}

function normalizeCallSession(raw: unknown): CallSessionRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(500, "CALL_CREATE_FAILED", "Resposta invalida ao criar chamada.");
  }

  const casted = raw as Record<string, unknown>;
  const call = {
    id: String(casted.id ?? "").trim(),
    conversation_id: String(casted.conversation_id ?? "").trim(),
    created_by: String(casted.created_by ?? "").trim(),
    mode: String(casted.mode ?? "").trim().toLowerCase(),
    status: String(casted.status ?? "").trim().toLowerCase(),
    created_at: String(casted.created_at ?? "").trim(),
    started_at: String(casted.started_at ?? "").trim() || null,
    ended_at: String(casted.ended_at ?? "").trim() || null,
    last_activity_at: String(casted.last_activity_at ?? "").trim(),
    grace_started_at: String(casted.grace_started_at ?? "").trim() || null,
    ended_reason: String(casted.ended_reason ?? "").trim().toLowerCase() || null,
    participants: casted.participants ?? {},
  } as CallSessionRow;

  if (!call.id || !call.conversation_id || !call.created_by || !call.created_at || !call.last_activity_at) {
    throw new HttpError(500, "CALL_CREATE_FAILED", "Resposta invalida ao criar chamada.");
  }

  if (!["audio", "video"].includes(call.mode) || !["ringing", "active", "ended", "missed", "declined"].includes(call.status)) {
    throw new HttpError(500, "CALL_CREATE_FAILED", "Resposta invalida ao criar chamada.");
  }

  return call;
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
    context.action = "start";

    await enforceRateLimit(`call-start:${auth.uid}`, 10, 60_000, ROUTE);

    const payload = parsePayload(await parseJsonBody<unknown>(request));
    const callerUserId = await resolveUserIdByFirebaseUid(auth.uid, auth.email);
    await assertConversationMembership(payload.conversationId, callerUserId);

    const members = await getConversationMembers(payload.conversationId);
    ensureFirebaseUidInConversation(members, auth.uid);
    ensureFirebaseUidInConversation(members, payload.calleeUid);

    if (payload.calleeUid === auth.uid) {
      throw new HttpError(400, "INVALID_CALLEE", "Nao e possivel iniciar chamada para si mesmo.");
    }

    const supabase = getSupabaseAdminClient();
    const { data: existingData, error: existingError } = await supabase
      .from("call_sessions")
      .select("id,status,created_at")
      .eq("conversation_id", payload.conversationId)
      .in("status", ["ringing", "active"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw new HttpError(500, "CALL_LOOKUP_FAILED", "Falha ao verificar chamadas em andamento.");
    }

    const existingId = String((existingData as { id?: unknown } | null)?.id ?? "").trim();
    if (existingId) {
      throw new HttpError(409, "CALL_ALREADY_IN_PROGRESS", "Ja existe uma chamada em andamento nesta conversa.", {
        callId: existingId,
      });
    }

    const nowIso = new Date().toISOString();
    const participants = {
      [auth.uid]: {
        joinedAt: nowIso,
        leftAt: null,
      },
      [payload.calleeUid]: {
        joinedAt: null,
        leftAt: null,
      },
    };

    const insert = await supabase
      .from("call_sessions")
      .insert({
        conversation_id: payload.conversationId,
        created_by: auth.uid,
        mode: payload.mode,
        status: "ringing",
        created_at: nowIso,
        last_activity_at: nowIso,
        participants,
      })
      .select("*")
      .limit(1)
      .single();

    if (insert.error || !insert.data) {
      throw new HttpError(500, "CALL_CREATE_FAILED", "Falha ao iniciar chamada.");
    }

    const call = normalizeCallSession(insert.data);
    const expiresAt = new Date(Date.now() + getCallTimeoutMs()).toISOString();

    logStructured("info", "call_start_success", context, {
      status: 200,
      callId: call.id,
      conversationId: payload.conversationId,
      mode: payload.mode,
      calleeUid: payload.calleeUid,
    });

    return responseJson(request, {
      callId: call.id,
      status: call.status,
      expiresAt,
      call: serializeCall(call),
    });
  } catch (error) {
    logStructured("error", "call_start_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
