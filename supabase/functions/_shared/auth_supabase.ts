/// <reference path="./edge-runtime.d.ts" />
import { HttpError } from "./http.ts";
import { getSupabaseAdminClient, getSupabaseAnonClient } from "./supabaseAdmin.ts";

export interface SupabaseAuthContext {
  uid: string;
  email: string | null;
  token: string;
}

function parseBearerToken(header: string | null): string {
  if (!header) {
    throw new HttpError(401, "UNAUTHENTICATED", "Token de autorizacao ausente.");
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token) {
    throw new HttpError(401, "UNAUTHENTICATED", "Token de autorizacao invalido.");
  }
  return token;
}

export async function validateSupabaseToken(request: Request): Promise<SupabaseAuthContext> {
  const authorization = request.headers.get("authorization");
  const token = parseBearerToken(authorization);

  const anon = getSupabaseAnonClient();
  const anonResult = await anon.auth.getUser(token);
  if (!anonResult.error && anonResult.data?.user) {
    return {
      uid: anonResult.data.user.id,
      email: anonResult.data.user.email ?? null,
      token,
    };
  }

  const admin = getSupabaseAdminClient();
  const adminResult = await admin.auth.getUser(token);
  if (adminResult.error || !adminResult.data?.user) {
    throw new HttpError(401, "INVALID_TOKEN", "Sessao invalida ou expirada.");
  }

  return {
    uid: adminResult.data.user.id,
    email: adminResult.data.user.email ?? null,
    token,
  };
}
