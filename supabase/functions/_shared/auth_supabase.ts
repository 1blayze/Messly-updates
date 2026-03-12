/// <reference path="./edge-runtime.d.ts" />
import { HttpError } from "./http.ts";
import { getSupabaseAdminClient } from "./supabaseAdmin.ts";

export interface SupabaseAuthContext {
  uid: string;
  email: string | null;
  token: string;
}

function isSupabaseAuthTransientError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "").toLowerCase();

  if (status >= 500 || status === 0) {
    return true;
  }

  return (
    code.includes("timeout") ||
    code.includes("fetch") ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
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

  const admin = getSupabaseAdminClient();
  const adminResult = await admin.auth.getUser(token);
  if (adminResult.error || !adminResult.data?.user) {
    if (isSupabaseAuthTransientError(adminResult.error)) {
      throw new HttpError(503, "AUTH_PROVIDER_UNAVAILABLE", "Falha temporaria ao validar a sessao.");
    }
    throw new HttpError(401, "INVALID_TOKEN", "Sessao invalida ou expirada.");
  }

  return {
    uid: adminResult.data.user.id,
    email: adminResult.data.user.email ?? null,
    token,
  };
}
