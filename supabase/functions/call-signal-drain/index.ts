/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { resolveCallAuthorizationContext, validateSignalType } from "../_shared/calls.ts";
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

const ROUTE = "call-signal-drain";
const MAX_SIGNALS = 200;

const payloadSchema = z
  .object({
    callId: z.string().uuid(),
    since: z.string().datetime().optional().nullable(),
  })
  .strict();

function parsePayload(raw: unknown): { callId: string; since: string | null } {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Payload inválido.", {
      issues: parsed.error.issues.map((issue: { path: PropertyKey[]; message: string }) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return {
    callId: parsed.data.callId,
    since: parsed.data.since ?? null,
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
    context.action = "signal-drain";

    await enforceRateLimit(`call-signal-drain:${auth.uid}`, 300, 60_000, ROUTE);
    const payload = parsePayload(await parseJsonBody<unknown>(request));
    const { call } = await resolveCallAuthorizationContext(auth.uid, auth.email, payload.callId);

    const supabase = getSupabaseAdminClient();
    let query = supabase
      .from("call_signals")
      .select("id,call_id,from_uid,to_uid,type,payload,created_at")
      .eq("call_id", call.id)
      .eq("to_uid", auth.uid)
      .order("created_at", { ascending: true })
      .limit(MAX_SIGNALS);

    if (payload.since) {
      query = query.gt("created_at", payload.since);
    }

    const { data, error } = await query;
    if (error) {
      throw new HttpError(500, "CALL_SIGNAL_LIST_FAILED", "Falha ao carregar sinais de chamada.");
    }

    const rows = Array.isArray(data) ? data : [];
    const signals = rows
      .map((row) => {
        const id = String((row as { id?: unknown }).id ?? "").trim();
        const typeRaw = String((row as { type?: unknown }).type ?? "").trim().toLowerCase();
        if (!id) {
          return null;
        }
        try {
          const type = validateSignalType(typeRaw);
          return {
            id,
            callId: String((row as { call_id?: unknown }).call_id ?? "").trim(),
            fromUid: String((row as { from_uid?: unknown }).from_uid ?? "").trim(),
            toUid: String((row as { to_uid?: unknown }).to_uid ?? "").trim(),
            type,
            payload: (row as { payload?: unknown }).payload ?? {},
            createdAt: String((row as { created_at?: unknown }).created_at ?? "").trim(),
          };
        } catch {
          return null;
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return responseJson(request, {
      callId: call.id,
      signals,
    });
  } catch (error) {
    logStructured("error", "call_signal_drain_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseError(request, context, error);
  }
});
