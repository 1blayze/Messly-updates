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

const ROUTE = "profiles";
const MAX_QUERY_BYTES = 2048;
const MAX_PROFILE_IDS = 100;
const LOCAL_RATE_WINDOW_MS = 60_000;
const PROFILE_SELECT_COLUMNS =
  "id,username,display_name,email,avatar_url,avatar_key,avatar_hash,banner_url,banner_key,banner_hash,banner_color,profile_theme_primary_color,profile_theme_accent_color,bio,status,last_active,public_id,spotify_connection,friend_requests_allow_all,friend_requests_allow_friends_of_friends,created_at,updated_at";
const localRateBuckets = new Map<string, { count: number; resetAtMs: number }>();

const querySchema = z
  .object({
    id: z.string().uuid().optional(),
    username: z.string().min(1).max(64).optional(),
    ids: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activeModes = [value.id ? 1 : 0, value.username ? 1 : 0, value.ids ? 1 : 0].reduce((sum, part) => sum + part, 0);
    if (activeModes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "Informe exatamente um filtro: id, username ou ids.",
      });
    }
  });

interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  avatar_key: string | null;
  avatar_hash: string | null;
  banner_url: string | null;
  banner_key: string | null;
  banner_hash: string | null;
  banner_color: string | null;
  profile_theme_primary_color: string | null;
  profile_theme_accent_color: string | null;
  bio: string | null;
  status: string | null;
  last_active: string | null;
  public_id: string | null;
  spotify_connection: unknown | null;
  friend_requests_allow_all: boolean | null;
  friend_requests_allow_friends_of_friends: boolean | null;
  created_at: string | null;
  updated_at: string | null;
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

function responseProfilesError(request: Request, requestId: string, error: unknown): Response {
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

function normalizeIdsCsv(idsRaw: string | undefined): string[] {
  if (!idsRaw) {
    return [];
  }

  return Array.from(
    new Set(
      idsRaw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function parseQuery(request: Request): {
  id?: string;
  username?: string;
  ids?: string[];
} {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    id: url.searchParams.get("id") ?? undefined,
    username: url.searchParams.get("username") ?? undefined,
    ids: url.searchParams.get("ids") ?? undefined,
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

  const ids = normalizeIdsCsv(parsed.data.ids);
  if (ids.length > MAX_PROFILE_IDS) {
    throw new HttpError(400, "TOO_MANY_IDS", "Quantidade maxima de ids excedida.");
  }

  ids.forEach((id) => {
    if (!z.string().uuid().safeParse(id).success) {
      throw new HttpError(400, "INVALID_QUERY", "Lista de ids invalida.");
    }
  });

  return {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    ...(parsed.data.username ? { username: parsed.data.username.trim().toLowerCase() } : {}),
    ...(ids.length > 0 ? { ids } : {}),
  };
}

function toApiProfile(row: ProfileRow): Record<string, unknown> {
  return {
    ...row,
    about: row.bio,
    firebase_uid: row.id,
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

    enforceLocalRateLimit(`profiles:ip:${requestIp}`, 240);
    await enforceRateLimit(`profiles:ip:${requestIp}`, 320, 60_000, ROUTE, {
      action: "read",
    });

    const auth = await validateSupabaseToken(request, {
      allowAuthorizationFallback: false,
    });
    const uidHash = await hashUid(auth.uid);
    enforceLocalRateLimit(`profiles:uid:${auth.uid}`, 240);
    await enforceRateLimit(`profiles:uid:${auth.uid}`, 240, 60_000, ROUTE, {
      action: "read",
    });

    const token = String(request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const supabase = createSupabaseRlsClient(token);
    let builder = supabase.from("profiles").select(PROFILE_SELECT_COLUMNS);

    if (query.id) {
      builder = builder.eq("id", query.id).limit(1);
    } else if (query.username) {
      builder = builder.eq("username", query.username).limit(1);
    } else if (query.ids && query.ids.length > 0) {
      builder = builder.in("id", query.ids);
    }

    const { data, error } = await builder;
    if (error) {
      throw new HttpError(500, "PROFILES_LOOKUP_FAILED", "Falha ao consultar perfis.");
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const profiles = rows.map((row) => toApiProfile(row as ProfileRow));

    logStructured("info", "profiles_lookup_success", context, {
      status: 200,
      uidHash,
      count: profiles.length,
      mode: query.id ? "id" : query.username ? "username" : "ids",
    });

    return responseJson(
      request,
      {
        profiles,
        serverTime: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    logStructured("error", "profiles_lookup_failure", context, {
      status: error instanceof HttpError ? error.status : 500,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : String(error ?? "Unknown error"),
    });
    return responseProfilesError(request, context.requestId, error);
  }
});
