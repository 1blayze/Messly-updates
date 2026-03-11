/// <reference path="../_shared/edge-runtime.d.ts" />
import { z } from "npm:zod@3.25.76";
import { validateSupabaseToken } from "../_shared/auth.ts";
import { evaluateCorsRequest } from "../_shared/cors.ts";
import {
  createRequestContext,
  HttpError,
  isOptionsRequest,
  logStructured,
  responseJson,
  responseNoContent,
} from "../_shared/http.ts";
import { extractClientIpFromRequest } from "../_shared/loginLocation.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { createSupabaseRlsClient } from "../_shared/supabaseAdmin.ts";
import { resolveUserId } from "../_shared/user.ts";

const ROUTE = "friend-requests";
const MAX_QUERY_BYTES = 1024;
const LOCAL_RATE_WINDOW_MS = 60_000;
const localRateBuckets = new Map<string, { count: number; resetAtMs: number }>();

const querySchema = z
  .object({
    status: z.enum(["pending", "accepted"]).optional(),
  })
  .strict();

interface FriendRequestRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string | null;
}

function toErrorKey(error: HttpError | null): string {
  if (!error) {
    return "internal_error";
  }

  if (error.status === 401 || error.code === "INVALID_TOKEN" || error.code === "UNAUTHENTICATED") {
    return "unauthorized";
  }

  if (error.status === 429) {
    return "rate_limited";
  }

  return String(error.code ?? "internal_error")
    .trim()
    .toLowerCase();
}

function responseFriendRequestsError(request: Request, requestId: string, error: unknown): Response {
  const normalized = error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", "Erro interno.");
  return responseJson(
    request,
    {
      error: toErrorKey(error instanceof HttpError ? error : null),
      message: normalized.message,
      requestId,
    },
    normalized.status,
  );
}

function enforceQueryLimit(request: Request): void {
  const queryBytes = new TextEncoder().encode(new URL(request.url).search).byteLength;
  if (queryBytes > MAX_QUERY_BYTES) {
    throw new HttpError(414, "QUERY_TOO_LARGE", "Query string excede o limite permitido.");
  }
}

function enforceGetMethod(request: Request): void {
  if (request.method.toUpperCase() !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Metodo ${request.method} nao permitido.`);
  }
}

function enforceLocalRateLimit(key: string, limit: number): void {
  const nowMs = Date.now();
  const existing = localRateBuckets.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    localRateBuckets.set(key, {
      count: 1,
      resetAtMs: nowMs + LOCAL_RATE_WINDOW_MS,
    });
    return;
  }

  existing.count += 1;
  localRateBuckets.set(key, existing);
  if (existing.count > limit) {
    const retryAfterMs = Math.max(1, existing.resetAtMs - nowMs);
    throw new HttpError(429, "RATE_LIMITED", "Muitas requisicoes em pouco tempo.", {
      retryAfterMs,
      limit,
      windowMs: LOCAL_RATE_WINDOW_MS,
      backend: "memory",
    });
  }
}

function parseQuery(request: Request): { status: "pending" | "accepted" } {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });

  if (!parsed.success) {
    throw new HttpError(400, "INVALID_QUERY", "Parametros de query invalidos.", {
      issues: parsed.error.issues.map((issue: { path: string[]; code: string; message: string }) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  return {
    status: parsed.data.status ?? "pending",
  };
}

async function hashUid(uidRaw: string): Promise<string> {
  const uid = String(uidRaw ?? "").trim();
  if (!uid) {
    return "unknown";
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid));
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

Deno.serve(async (request: Request) => {
  const context = createRequestContext(ROUTE, request);
  const requestIp = extractClientIpFromRequest(request);

  try {
    const cors = evaluateCorsRequest(request);
    if (isOptionsRequest(request)) {
      return responseNoContent(request);
    }

    if (!cors.isAllowed) {
      throw new HttpError(403, "CORS_FORBIDDEN", "Origin nao permitida.");
    }

    enforceGetMethod(request);
    enforceQueryLimit(request);
    const query = parseQuery(request);

    enforceLocalRateLimit(`friend-requests:ip:${requestIp}`, 180);
    await enforceRateLimit(`friend-requests:ip:${requestIp}`, 240, 60_000, ROUTE, {
      action: "list",
    });

    const auth = await validateSupabaseToken(request, {
      allowAuthorizationFallback: false,
    });

    const uidHash = await hashUid(auth.uid);
    const userId = await resolveUserId(auth.uid);

    enforceLocalRateLimit(`friend-requests:uid:${auth.uid}`, 240);
    await enforceRateLimit(`friend-requests:list:${auth.uid}:${requestIp}`, 120, 60_000, ROUTE, {
      action: "list",
      status: query.status,
    });

    const supabase = createSupabaseRlsClient(auth.token);
    const { data, error } = await supabase
      .from("friend_requests")
      .select("id,requester_id,addressee_id,status,created_at")
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .eq("status", query.status)
      .order("created_at", { ascending: false });

    if (error) {
      throw new HttpError(500, "FRIEND_REQUESTS_LIST_FAILED", "Falha ao listar solicitacoes de amizade.");
    }

    const requests = (data ?? []) as FriendRequestRow[];

    logStructured("info", "friend_requests_list_success", context, {
      status: 200,
      uidHash,
      requestCount: requests.length,
      filterStatus: query.status,
    });

    return responseJson(
      request,
      {
        user: {
          firebase_uid: auth.uid,
          email: auth.email,
        },
        requests,
        serverTime: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    logStructured("error", "friend_requests_list_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseFriendRequestsError(request, context.requestId, error);
  }
});
