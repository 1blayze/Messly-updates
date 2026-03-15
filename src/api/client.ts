import { supabase } from "../services/supabase";
import { authService } from "../services/auth";
import { getGatewaySocketUrl } from "../config/domains";

export async function getSupabaseAccessToken(): Promise<string | null> {
  const currentAccessToken = await authService.getCurrentAccessToken().catch(() => null);
  if (currentAccessToken) {
    return currentAccessToken;
  }
  return authService.getValidatedEdgeAccessToken();
}

export function getGatewayUrl(): string | null {
  return getGatewaySocketUrl();
}

export async function getCurrentUserId(): Promise<string | null> {
  return authService.getCurrentUserId();
}

export { supabase };
