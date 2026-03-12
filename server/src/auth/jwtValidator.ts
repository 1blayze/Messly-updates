import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeSupabaseJwtClaims } from "./jwtClaims";
import type { AuthSessionManager } from "../sessions/sessionManager";

export interface AuthenticatedGatewayUser {
  id: string;
  email: string | null;
  authSessionId: string;
}

interface ValidateGatewayJwtOptions {
  requireSession?: boolean;
}

export async function validateGatewayJwt(
  supabase: SupabaseClient,
  token: string,
  sessionManager?: AuthSessionManager,
  options: ValidateGatewayJwtOptions = {},
): Promise<AuthenticatedGatewayUser | null> {
  const requireSession = options.requireSession ?? true;
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken) {
    return null;
  }

  const claims = decodeSupabaseJwtClaims(normalizedToken);
  if (!claims?.userId || !claims.sessionId) {
    return null;
  }

  if (claims.expiresAt && claims.expiresAt * 1000 <= Date.now()) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(normalizedToken);
  if (error || !data.user) {
    return null;
  }

  if (data.user.id !== claims.userId) {
    return null;
  }

  if (requireSession && sessionManager) {
    const isValidSession = await sessionManager.validateAuthSessionId(claims.sessionId, data.user.id);
    if (!isValidSession) {
      return null;
    }
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    authSessionId: claims.sessionId,
  };
}
